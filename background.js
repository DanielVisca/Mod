function log(...args) {
  console.log('[Mod BG]', ...args);
}

// =========================================
// PostHog Analytics (manual capture API)
// =========================================

const POSTHOG_API_KEY = 'phc_FUsE1bjb63XoU6DK41bAmn8WIbfYaB4od52kJiUDesL';
const POSTHOG_ENDPOINT = 'https://us.i.posthog.com/i/v0/e/';

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function getDistinctId() {
  const key = 'posthog_distinct_id';
  const result = await chrome.storage.local.get(key);
  let id = result[key];
  let isFirstRun = false;
  if (!id) {
    id = generateId();
    await chrome.storage.local.set({ [key]: id });
    isFirstRun = true;
  }
  return { distinctId: id, isFirstRun };
}

async function posthogCapture(event, properties = {}) {
  try {
    const { distinctId } = await getDistinctId();
    const payload = {
      api_key: POSTHOG_API_KEY,
      event,
      distinct_id: distinctId,
      properties,
      timestamp: new Date().toISOString()
    };
    const res = await fetch(POSTHOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      log('PostHog capture failed', event, res.status, await res.text());
    }
  } catch (e) {
    log('PostHog capture error', event, e.message);
  }
}

// Use same key for www and non-www (e.g. www.example.com and example.com share mods)
function canonicalHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return hostname;
  return hostname.replace(/^www\./i, '');
}

// Badge: show number of active mods for the current tab's hostname
async function updateBadgeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith('http')) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const key = `mods:${canonicalHostname(hostname)}`;
    const result = await chrome.storage.local.get(key);
    const mods = result[key] || [];
    const activeCount = mods.filter(m => m.enabled && m.type !== 'js-safe').length;
    await chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
  } catch (e) {
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

// On load: capture extension_installed once per install; refresh badge for current tab
getDistinctId().then(({ isFirstRun }) => {
  if (isFirstRun) {
    const manifest = chrome.runtime.getManifest();
    posthogCapture('extension_installed', { extension_version: manifest.version });
  }
  updateBadgeForActiveTab();
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Allow side panel to open on all sites
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Track active tab for side panel context
let activeTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  updateBadgeForActiveTab();
  broadcastToSidePanel({ type: 'TAB_UPDATED', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === activeTabId) {
    updateBadgeForActiveTab();
    broadcastToSidePanel({ type: 'TAB_UPDATED', tabId });
  }
});

// =========================================
// Message routing
// =========================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        sendResponse({ tabId: tab?.id, url: tab?.url, title: tab?.title });
      });
      return true;

    case 'SEND_TO_CONTENT':
      sendToContentScript(msg.tabId, msg.payload).then(response => {
        sendResponse(response);
      }).catch(e => {
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'CALL_AI':
      callClaudeAPI(msg.messages, msg.systemPrompt, msg.apiKey, msg.traceId).then(response => {
        sendResponse(response);
      }).catch(e => {
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'SAVE_MOD':
      saveMod(canonicalHostname(msg.hostname), msg.mod).then((mod) => {
        posthogCapture('mod_saved', {
          hostname: canonicalHostname(msg.hostname),
          mod_type: mod.type,
          mod_description: mod.description
        });
        updateBadgeForActiveTab();
        sendResponse({ ok: true });
      }).catch(e => {
        log('SAVE_MOD failed', e);
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'GET_MODS': {
      const key = `mods:${canonicalHostname(msg.hostname)}`;
      chrome.storage.local.get(key).then(result => {
        const mods = result[key] || [];
        log('GET_MODS', { hostname: msg.hostname, key, count: mods.length });
        sendResponse({ mods });
      });
      return true;
    }

    case 'DELETE_MOD':
      deleteMod(canonicalHostname(msg.hostname), msg.modId).then(() => {
        posthogCapture('mod_deleted', { hostname: canonicalHostname(msg.hostname) });
        updateBadgeForActiveTab();
        sendResponse({ ok: true });
      });
      return true;

    case 'TOGGLE_MOD':
      toggleMod(canonicalHostname(msg.hostname), msg.modId, msg.enabled).then(() => {
        posthogCapture('mod_toggled', {
          hostname: canonicalHostname(msg.hostname),
          enabled: msg.enabled
        });
        updateBadgeForActiveTab();
        sendResponse({ ok: true });
      });
      return true;

    case 'DISABLE_ALL_MODS_FOR_HOST':
      disableAllModsForHost(canonicalHostname(msg.hostname)).then((count) => {
        posthogCapture('mods_disabled_all', { hostname: canonicalHostname(msg.hostname), mod_count: count });
        updateBadgeForActiveTab();
        sendResponse({ ok: true });
      }).catch(e => {
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'POSTHOG_CAPTURE':
      posthogCapture(msg.event, msg.properties || {}).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;

    case 'ELEMENT_SELECTED':
      posthogCapture('element_selected', {
        hostname: msg.data?.hostname,
        tag: msg.data?.tagName,
        has_selector: !!msg.data?.selector
      });
      broadcastToSidePanel(msg);
      sendResponse({ ok: true });
      break;

    case 'SELECTOR_CANCELLED':
      posthogCapture('selector_cancelled', {});
      broadcastToSidePanel(msg);
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true;
});

// =========================================
// Content script communication
// =========================================

async function sendToContentScript(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });
        } catch (_) { /* chrome:// pages etc */ }
      } else {
        throw new Error(`Content script not reachable on tab ${tabId}`);
      }
    }
  }
}

function broadcastToSidePanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// =========================================
// Claude API Integration
// =========================================

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

async function callClaudeAPI(messages, systemPrompt, apiKey, traceId) {
  if (!apiKey) {
    return { ok: false, error: 'No API key set. Open Settings to add your Claude API key.' };
  }

  const startTime = Date.now();
  const tid = traceId || generateId();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: messages
      })
    });

    const latencySec = (Date.now() - startTime) / 1000;

    if (!response.ok) {
      const errBody = await response.text();
      posthogCapture('$ai_generation', {
        $ai_trace_id: tid,
        $ai_model: CLAUDE_MODEL,
        $ai_provider: 'anthropic',
        $ai_input: messages,
        $ai_latency: latencySec,
        $ai_http_status: response.status,
        $ai_is_error: true,
        $ai_error: errBody.substring(0, 500)
      });
      if (response.status === 401) {
        return { ok: false, error: 'Invalid API key. Check your key in Settings.' };
      }
      if (response.status === 429) {
        return { ok: false, error: 'Rate limited. Wait a moment and try again.' };
      }
      return { ok: false, error: `API error ${response.status}: ${errBody.substring(0, 200)}` };
    }

    const data = await response.json();
    const text = data.content.map(c => c.text || '').join('');
    const usage = data.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;

    posthogCapture('$ai_generation', {
      $ai_trace_id: tid,
      $ai_model: CLAUDE_MODEL,
      $ai_provider: 'anthropic',
      $ai_input: messages,
      $ai_input_tokens: inputTokens,
      $ai_output_choices: [{ role: 'assistant', content: text }],
      $ai_output_tokens: outputTokens,
      $ai_latency: latencySec,
      $ai_stream: false,
      $ai_http_status: 200
    });

    return { ok: true, text };
  } catch (e) {
    const latencySec = (Date.now() - startTime) / 1000;
    posthogCapture('$ai_generation', {
      $ai_trace_id: tid,
      $ai_model: CLAUDE_MODEL,
      $ai_provider: 'anthropic',
      $ai_input: messages,
      $ai_latency: latencySec,
      $ai_is_error: true,
      $ai_error: e.message
    });
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

// =========================================
// Storage management
// =========================================

async function saveMod(hostname, mod) {
  const key = `mods:${hostname}`;
  const result = await chrome.storage.local.get(key);
  const mods = result[key] || [];

  mod.id = mod.id || `mod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  mod.enabled = true;
  mod.createdAt = new Date().toISOString();

  mods.push(mod);
  await chrome.storage.local.set({ [key]: mods });
  log('Saved mod', { hostname, key, modId: mod.id, type: mod.type, description: mod.description, totalModsForHost: mods.length });

  // Verify write
  const verify = await chrome.storage.local.get(key);
  const stored = verify[key] || [];
  if (stored.length !== mods.length) {
    log('SAVE VERIFY FAILED', { key, expected: mods.length, got: stored.length });
  } else {
    log('Save verified', { key, count: stored.length });
  }
  return mod;
}

async function deleteMod(hostname, modId) {
  const key = `mods:${hostname}`;
  const result = await chrome.storage.local.get(key);
  let mods = result[key] || [];
  mods = mods.filter(m => m.id !== modId);
  await chrome.storage.local.set({ [key]: mods });
  log('Deleted mod', { hostname, key, modId, remaining: mods.length });
}

async function toggleMod(hostname, modId, enabled) {
  const key = `mods:${hostname}`;
  const result = await chrome.storage.local.get(key);
  const mods = result[key] || [];
  const mod = mods.find(m => m.id === modId);
  if (mod) {
    mod.enabled = enabled;
    await chrome.storage.local.set({ [key]: mods });
    log('Toggled mod', { hostname, key, modId, enabled });
  }
}

async function disableAllModsForHost(hostname) {
  const key = `mods:${hostname}`;
  const result = await chrome.storage.local.get(key);
  const mods = result[key] || [];
  for (const mod of mods) {
    mod.enabled = false;
  }
  await chrome.storage.local.set({ [key]: mods });
  log('Disabled all mods for host', { hostname, key, count: mods.length });
  return mods.length;
}
