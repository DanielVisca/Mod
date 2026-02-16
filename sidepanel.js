(function() {
  'use strict';

  const SYSTEM_PROMPT = `You are Mod, an AI assistant that helps users modify web pages. You generate CSS modifications that run in a Chrome extension's content script.

CRITICAL RULES:
1. You ONLY output modifications in a specific JSON format (described below).
2. You may ONLY use types: "css" or "dom-hide". Do not use "js-safe" (not supported in this version).
3. CSS modifications are ALWAYS preferred over dom-hide when styling is the goal.
4. For hiding elements, ALWAYS use type "dom-hide" with a selector — the extension will apply display: none !important.
5. For style changes, ALWAYS use type "css" with code targeting the selector. All CSS must use !important on every property to override the page's styles.
6. Keep modifications minimal and surgical.

RESPONSE FORMAT:
You must respond with a JSON block wrapped in \`\`\`json fences:

\`\`\`json
{
  "description": "Brief human-readable description of what this mod does",
  "type": "css" or "dom-hide",
  "selector": "CSS selector for the target (required for dom-hide, optional for css)",
  "code": "The CSS rules (empty string for dom-hide)"
}
\`\`\`

EXAMPLES:

User wants to hide a cookie banner:
\`\`\`json
{
  "description": "Hide cookie consent banner",
  "type": "dom-hide",
  "selector": "#cookie-consent, .cookie-banner, [class*='cookie-consent']",
  "code": ""
}
\`\`\`

User wants to change font size:
\`\`\`json
{
  "description": "Increase article text size to 18px",
  "type": "css",
  "selector": "",
  "code": "article p, .article-body p, .post-content p { font-size: 18px !important; line-height: 1.6 !important; }"
}
\`\`\`

If you need more information about the page to generate a good modification, ask the user. Don't guess.
If the user's request is unclear, ask for clarification.
If a request requires JavaScript (e.g. "add a word counter"), explain that this version supports only CSS and hiding elements, and suggest what IS possible.

You may include a brief explanation outside the JSON block, but ALWAYS include the JSON block if you're providing a modification.`;

  let currentTabId = null;
  let currentHostname = null;
  let apiKey = null;
  let conversationHistory = [];
  let selectedElementContext = null;
  const pendingModsByKey = {};
  let escapeListener = null;

  async function init() {
    const settings = await chrome.storage.local.get('settings');
    apiKey = settings.settings?.apiKey || null;
    const modsEnabled = settings.settings?.modsEnabled !== false;

    if (!apiKey) {
      showView('settings');
      addSystemMessage('Welcome to Mod! Please add your Claude API key to get started.');
    }

    await updateActiveTab();
    chrome.runtime.onMessage.addListener(handleMessage);

    chrome.runtime.sendMessage({
      type: 'POSTHOG_CAPTURE',
      event: 'side_panel_opened',
      properties: { hostname: currentHostname }
    }).catch(() => {});

    document.getElementById('btn-send').addEventListener('click', sendMessage);
    document.getElementById('user-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    document.getElementById('btn-select').addEventListener('click', activateSelector);
    document.getElementById('btn-mods').addEventListener('click', () => showView('mods'));
    document.getElementById('btn-settings').addEventListener('click', () => showView('settings'));
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
    document.getElementById('btn-back-chat').addEventListener('click', () => showView('chat'));
    document.getElementById('btn-back-chat-2').addEventListener('click', () => showView('chat'));

    document.getElementById('mods-enabled-toggle').checked = modsEnabled;
    updateModsToggleLabel();
    document.getElementById('mods-enabled-toggle').addEventListener('change', onModsToggleChange);

    if (apiKey) {
      document.getElementById('api-key-input').value = apiKey;
    }
  }

  function updateModsToggleLabel() {
    const toggle = document.getElementById('mods-enabled-toggle');
    const label = document.getElementById('mods-toggle-label');
    if (toggle && label) label.textContent = toggle.checked ? 'Mods on' : 'Mods off';
  }

  async function onModsToggleChange() {
    const enabled = document.getElementById('mods-enabled-toggle').checked;
    updateModsToggleLabel();
    const settings = await chrome.storage.local.get('settings');
    const current = settings.settings || {};
    await chrome.storage.local.set({ settings: { ...current, modsEnabled: enabled } });
    if (currentTabId) {
      try {
        await chrome.runtime.sendMessage({
          type: 'SEND_TO_CONTENT',
          tabId: currentTabId,
          payload: { type: 'REFRESH_MODS_STATE' }
        });
      } catch (e) {
        console.warn('[Mod] Could not refresh content script (tab may be chrome:// or gone):', e.message);
      }
    }
  }

  async function updateActiveTab() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
    if (response.tabId) {
      currentTabId = response.tabId;
      try {
        const url = new URL(response.url);
        currentHostname = url.hostname;
        document.getElementById('page-hostname').textContent = currentHostname;
        updateModCount();
        const settings = await chrome.storage.local.get('settings');
        const modsEnabled = settings.settings?.modsEnabled !== false;
        const toggle = document.getElementById('mods-enabled-toggle');
        if (toggle) toggle.checked = modsEnabled;
        updateModsToggleLabel();
      } catch (e) {
        currentHostname = null;
        document.getElementById('page-hostname').textContent = 'No page';
      }
    }
  }

  async function updateModCount() {
    if (!currentHostname) return;
    const response = await chrome.runtime.sendMessage({
      type: 'GET_MODS',
      hostname: currentHostname
    });
    const count = response.mods?.length || 0;
    document.getElementById('mod-count').textContent = count > 0 ? `(${count} mods)` : '';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById(`${name}-view`);
    if (el) el.classList.add('active');

    if (name === 'mods') {
      renderModsList();
    }
  }

  function addMessage(role, content, isCode = false) {
    const messagesEl = document.getElementById('messages');
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (isCode) {
      contentEl.innerHTML = `<pre><code>${escapeHtml(content)}</code></pre>`;
    } else if (role === 'assistant' || role === 'system') {
      contentEl.innerHTML = renderMarkdownToHtml(content);
    } else {
      contentEl.innerHTML = escapeHtml(content).replace(/\n/g, '<br>');
    }

    msgEl.appendChild(contentEl);
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSystemMessage(content) {
    addMessage('system', content);
  }

  function addModMessage(mod) {
    const modKey = 'mod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    pendingModsByKey[modKey] = mod;

    const messagesEl = document.getElementById('messages');
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant mod-result';

    msgEl.innerHTML = `
      <div class="mod-description">${escapeHtml(mod.description)}</div>
      <div class="mod-type">${mod.type}</div>
      <div class="mod-actions">
        <button class="btn-apply" data-mod-key="${escapeHtml(modKey)}">Apply & Save</button>
        <button class="btn-preview" data-mod-key="${escapeHtml(modKey)}">Preview</button>
        <button class="btn-reject" data-mod-key="${escapeHtml(modKey)}">Reject</button>
      </div>
    `;

    msgEl.querySelector('.btn-apply').addEventListener('click', async (e) => {
      const key = e.target.dataset.modKey;
      const modData = pendingModsByKey[key];
      if (!modData) return;
      await applyAndSaveMod(modData, msgEl.querySelector('.btn-apply'));
    });

    msgEl.querySelector('.btn-preview').addEventListener('click', async (e) => {
      const key = e.target.dataset.modKey;
      const modData = pendingModsByKey[key];
      if (!modData) return;
      await previewMod(modData, msgEl.querySelector('.btn-preview'));
    });

    msgEl.querySelector('.btn-reject').addEventListener('click', (e) => {
      msgEl.style.opacity = '0.5';
      addSystemMessage('Mod rejected. Tell me what to change.');
    });

    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function applyAndSaveMod(mod, buttonEl) {
    let modToApply = { ...mod };
    for (;;) {
      const applyResult = await chrome.runtime.sendMessage({
        type: 'SEND_TO_CONTENT',
        tabId: currentTabId,
        payload: { type: 'APPLY_MOD', mod: modToApply }
      });

      const result = applyResult?.ok ? applyResult : (applyResult || {});

      if (result.selectorWarn && typeof result.matchCount === 'number') {
        const applyAnyway = confirm(
          `This selector matches ${result.matchCount} elements. Applying may hide or change more than intended. Apply anyway?`
        );
        if (!applyAnyway) return;
        modToApply = { ...mod, forceSelectorWarning: true };
        continue;
      }

      if (!result.ok) {
        addSystemMessage(`Failed to apply: ${result.error || 'Unknown error'}`);
        return;
      }

      break;
    }

    await chrome.runtime.sendMessage({
      type: 'SEND_TO_CONTENT',
      tabId: currentTabId,
      payload: { type: 'REMOVE_MOD', modId: 'preview_temp' }
    });

    if (!currentHostname) {
      addSystemMessage('Cannot save: no hostname (are you on a normal web page?).');
      return;
    }

    const saveResponse = await chrome.runtime.sendMessage({
      type: 'SAVE_MOD',
      hostname: currentHostname,
      mod: mod
    });

    if (!saveResponse?.ok) {
      addSystemMessage(`Save failed: ${saveResponse?.error || 'unknown error'}`);
      return;
    }

    if (buttonEl) {
      buttonEl.textContent = 'Applied!';
      buttonEl.disabled = true;
    }
    updateModCount();
    addSystemMessage(`Mod saved! It will re-apply every time you visit ${currentHostname}. (Storage key: mods:${currentHostname.replace(/^www\./i, '')})`);
  }

  async function previewMod(mod, buttonEl) {
    const previewMod = { ...mod, id: 'preview_temp' };
    const result = await chrome.runtime.sendMessage({
      type: 'SEND_TO_CONTENT',
      tabId: currentTabId,
      payload: { type: 'APPLY_MOD', mod: previewMod }
    });
    if (result?.selectorWarn && typeof result.matchCount === 'number') {
      const ok = confirm(`This selector matches ${result.matchCount} elements. Preview anyway?`);
      if (!ok) return;
      const forceResult = await chrome.runtime.sendMessage({
        type: 'SEND_TO_CONTENT',
        tabId: currentTabId,
        payload: { type: 'APPLY_MOD', mod: { ...previewMod, forceSelectorWarning: true } }
      });
      if (!forceResult?.ok) {
        addSystemMessage(forceResult?.error || 'Preview failed');
        return;
      }
    } else if (!result?.ok) {
      addSystemMessage(result?.error || 'Preview failed');
      return;
    }
    if (buttonEl) {
      buttonEl.textContent = 'Previewing (refresh to undo)';
    }
  }

  function generateTraceId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async function sendMessage() {
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    const hadElementContext = !!selectedElementContext;
    input.value = '';
    addMessage('user', text);

    let contextPrefix = '';

    if (selectedElementContext) {
      contextPrefix = `[USER SELECTED AN ELEMENT]\n` +
        `Selector: ${selectedElementContext.selector}\n` +
        `Tag: ${selectedElementContext.tagName}\n` +
        `Classes: ${selectedElementContext.classes.join(', ')}\n` +
        `Text: "${selectedElementContext.textContent}"\n` +
        `Current styles: ${JSON.stringify(selectedElementContext.styles, null, 2)}\n` +
        `HTML: ${selectedElementContext.html}\n` +
        `Page: ${selectedElementContext.hostname} - ${selectedElementContext.url}\n\n`;
      selectedElementContext = null;
    } else {
      try {
        const pageCtx = await chrome.runtime.sendMessage({
          type: 'SEND_TO_CONTENT',
          tabId: currentTabId,
          payload: { type: 'GET_PAGE_CONTEXT' }
        });
        if (pageCtx?.data) {
          contextPrefix = `[CURRENT PAGE: ${pageCtx.data.hostname}]\n` +
            `Title: ${pageCtx.data.title}\n` +
            `URL: ${pageCtx.data.url}\n` +
            `Page has: ${pageCtx.data.headings.length} headings, ${pageCtx.data.forms} forms, ${pageCtx.data.buttons} buttons\n` +
            `Detected: ${pageCtx.data.modals} modals, ${pageCtx.data.banners} banners\n\n`;
        }
      } catch (e) {}
    }

    const fullMessage = contextPrefix + text;
    conversationHistory.push({ role: 'user', content: fullMessage });

    const traceId = generateTraceId();
    chrome.runtime.sendMessage({
      type: 'POSTHOG_CAPTURE',
      event: 'message_sent',
      properties: { has_element_context: hadElementContext, hostname: currentHostname }
    }).catch(() => {});

    addSystemMessage('Thinking...');

    const response = await chrome.runtime.sendMessage({
      type: 'CALL_AI',
      messages: conversationHistory,
      systemPrompt: SYSTEM_PROMPT,
      apiKey: apiKey,
      traceId: traceId
    });

    const msgs = document.getElementById('messages');
    if (msgs.lastChild) msgs.removeChild(msgs.lastChild);

    if (!response.ok) {
      addSystemMessage(`Error: ${response.error}`);
      conversationHistory.pop();
      return;
    }

    const aiText = response.text;
    conversationHistory.push({ role: 'assistant', content: aiText });

    const jsonMatch = aiText.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const mod = JSON.parse(jsonMatch[1]);
        if (mod.type === 'js-safe') {
          addMessage('assistant', 'This version of Mod supports only CSS and "hide element" mods. I can\'t run JavaScript mods here. Try asking to hide an element or change styles with CSS.');
          return;
        }

        const beforeJson = aiText.substring(0, aiText.indexOf('```json')).trim();
        if (beforeJson) {
          addMessage('assistant', beforeJson);
        }

        addModMessage(mod);
      } catch (e) {
        addMessage('assistant', aiText);
        addSystemMessage('(Could not parse modification. The AI may need another try.)');
      }
    } else {
      addMessage('assistant', aiText);
    }
  }

  function activateSelector() {
    document.getElementById('selecting-indicator').classList.remove('hidden');

    if (escapeListener) {
      document.removeEventListener('keydown', escapeListener);
    }
    escapeListener = function(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        document.removeEventListener('keydown', escapeListener);
        escapeListener = null;
        document.getElementById('selecting-indicator').classList.add('hidden');
        if (currentTabId) {
          chrome.runtime.sendMessage({
            type: 'SEND_TO_CONTENT',
            tabId: currentTabId,
            payload: { type: 'CANCEL_SELECTOR' }
          }).catch(() => {});
        }
      }
    };
    document.addEventListener('keydown', escapeListener);

    chrome.runtime.sendMessage({
      type: 'POSTHOG_CAPTURE',
      event: 'selector_activated',
      properties: { hostname: currentHostname }
    }).catch(() => {});

    chrome.runtime.sendMessage({
      type: 'SEND_TO_CONTENT',
      tabId: currentTabId,
      payload: { type: 'ACTIVATE_SELECTOR' }
    });
  }

  function handleElementSelected(data) {
    if (escapeListener) {
      document.removeEventListener('keydown', escapeListener);
      escapeListener = null;
    }
    document.getElementById('selecting-indicator').classList.add('hidden');
    selectedElementContext = data;

    addSystemMessage(
      `Selected: <${data.tagName}> "${data.textContent.substring(0, 50)}"\n` +
      `What would you like to do with this element?`
    );

    document.getElementById('user-input').focus();
  }

  async function renderModsList() {
    const listEl = document.getElementById('mods-list');
    listEl.innerHTML = '';

    if (!currentHostname) {
      listEl.innerHTML = '<p class="empty">Navigate to a website first.</p>';
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'GET_MODS',
      hostname: currentHostname
    });
    const mods = response.mods || [];

    if (mods.length === 0) {
      listEl.innerHTML = `<p class="empty">No mods saved for ${currentHostname}</p>`;
      return;
    }

    mods.forEach(mod => {
      const modEl = document.createElement('div');
      modEl.className = `mod-item ${mod.enabled ? '' : 'disabled'}`;
      modEl.innerHTML = `
        <div class="mod-item-header">
          <label class="toggle">
            <input type="checkbox" ${mod.enabled ? 'checked' : ''} data-id="${escapeHtml(mod.id)}">
            <span>${escapeHtml(mod.description)}</span>
          </label>
          <button class="btn-delete" data-id="${escapeHtml(mod.id)}" title="Delete">Delete</button>
        </div>
        <div class="mod-item-meta">${escapeHtml(mod.type)} · ${new Date(mod.createdAt).toLocaleDateString()}</div>
      `;

      modEl.querySelector('input[type="checkbox"]').addEventListener('change', async (e) => {
        await chrome.runtime.sendMessage({
          type: 'TOGGLE_MOD',
          hostname: currentHostname,
          modId: e.target.dataset.id,
          enabled: e.target.checked
        });
        addSystemMessage('Refresh the page to see the change.');
      });

      modEl.querySelector('.btn-delete').addEventListener('click', async (e) => {
        await chrome.runtime.sendMessage({
          type: 'DELETE_MOD',
          hostname: currentHostname,
          modId: e.target.dataset.id
        });
        renderModsList();
        updateModCount();
      });

      listEl.appendChild(modEl);
    });
  }

  async function saveSettings() {
    const key = document.getElementById('api-key-input').value.trim();
    apiKey = key;
    const current = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...current, apiKey: key } });
    chrome.runtime.sendMessage({
      type: 'POSTHOG_CAPTURE',
      event: 'settings_saved',
      properties: { field: 'api_key' }
    }).catch(() => {});
    addSystemMessage('API key saved.');
    showView('chat');
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'ELEMENT_SELECTED':
        handleElementSelected(msg.data);
        break;
      case 'SELECTOR_CANCELLED':
        if (escapeListener) {
          document.removeEventListener('keydown', escapeListener);
          escapeListener = null;
        }
        document.getElementById('selecting-indicator').classList.add('hidden');
        break;
      case 'TAB_UPDATED':
        updateActiveTab();
        conversationHistory = [];
        break;
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Renders markdown-like text to safe HTML (escape first, then convert ** * ` ``` newlines).
   */
  function renderMarkdownToHtml(text) {
    if (text == null) return '';
    let s = escapeHtml(text);

    // Code blocks (```...```) - process before inline so we don't touch content inside
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      return '<pre class="md-block"><code>' + code.replace(/^\n|\n$/g, '') + '</code></pre>';
    });

    // Inline code (`...`)
    s = s.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');

    // Bold **...** or __...__
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Italic *...* (after bold; skip _ to avoid clashing with __ in bold)
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    s = s.replace(/\n/g, '<br>');

    return s;
  }

  init();
})();
