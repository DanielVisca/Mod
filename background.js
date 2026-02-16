function log(...args) {
  console.log('[Mod BG]', ...args);
}

// Use same key for www and non-www (e.g. www.example.com and example.com share mods)
function canonicalHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return hostname;
  return hostname.replace(/^www\./i, '');
}

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
  broadcastToSidePanel({ type: 'TAB_UPDATED', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === activeTabId) {
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
      callClaudeAPI(msg.messages, msg.systemPrompt, msg.apiKey).then(response => {
        sendResponse(response);
      }).catch(e => {
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'SAVE_MOD':
      saveMod(canonicalHostname(msg.hostname), msg.mod).then(() => {
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
        sendResponse({ ok: true });
      });
      return true;

    case 'TOGGLE_MOD':
      toggleMod(canonicalHostname(msg.hostname), msg.modId, msg.enabled).then(() => {
        sendResponse({ ok: true });
      });
      return true;

    case 'DISABLE_ALL_MODS_FOR_HOST':
      disableAllModsForHost(canonicalHostname(msg.hostname)).then(() => {
        sendResponse({ ok: true });
      }).catch(e => {
        sendResponse({ ok: false, error: e.message });
      });
      return true;

    case 'ELEMENT_SELECTED':
    case 'SELECTOR_CANCELLED':
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

async function callClaudeAPI(messages, systemPrompt, apiKey) {
  if (!apiKey) {
    return { ok: false, error: 'No API key set. Open Settings to add your Claude API key.' };
  }

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: messages
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
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
    return { ok: true, text };
  } catch (e) {
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
}
