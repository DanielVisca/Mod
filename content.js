(function() {
  'use strict';

  if (window.__MOD_CONTENT_SCRIPT_LOADED) return;
  window.__MOD_CONTENT_SCRIPT_LOADED = true;

  const hostname = window.location.hostname;
  const SELECTOR_WARN_THRESHOLD = 10;

  function canonicalHostname(h) {
    if (!h || typeof h !== 'string') return h;
    return h.replace(/^www\./i, '');
  }
  const storageHostname = canonicalHostname(hostname);

  // Developer logging: all messages prefixed with [Mod] so you can filter in DevTools
  function log(...args) {
    console.log('[Mod]', ...args);
  }
  function logWarn(...args) {
    console.warn('[Mod]', ...args);
  }
  function logError(...args) {
    console.error('[Mod]', ...args);
  }

  log('Content script loaded', { hostname, storageHostname, url: window.location.href });

  // =========================================
  // PART 1: Apply saved mods on page load
  // =========================================

  function removeAllModStyles() {
    const styles = document.querySelectorAll('style[data-mod-id]');
    styles.forEach(s => s.remove());
    log('Removed all mod style tags', { count: styles.length });
  }

  async function applySavedMods() {
    const storageKey = `mods:${storageHostname}`;
    try {
      const result = await chrome.storage.local.get(['settings', storageKey]);
      const modsEnabled = result.settings?.modsEnabled !== false;
      if (!modsEnabled) {
        log('Mods are OFF (preview without changes) — skipping apply, removing any existing mod styles');
        removeAllModStyles();
        return;
      }

      const mods = result[storageKey] || [];
      const toApply = mods.filter(m => m.enabled && m.type !== 'js-safe');

      log('Applying saved mods', { hostname, storageKey, rawModCount: mods.length, toApply: toApply.length });
      if (mods.length === 0) {
        log('No mods in storage for this host — key was', storageKey);
      }

      let applied = 0;
      for (const mod of mods) {
        if (!mod.enabled) continue;
        if (mod.type === 'js-safe') continue;
        try {
          applyMod(mod);
          applied++;
          log('  Applied', { id: mod.id, type: mod.type, description: mod.description });
        } catch (e) {
          logWarn('  Failed to apply', { id: mod.id, description: mod.description, error: e.message });
        }
      }

      log('Done applying mods', { hostname, applied, total: toApply.length });
    } catch (e) {
      logError('Failed to load/apply mods from storage', e);
    }
  }

  function applyMod(mod) {
    if (mod.type === 'css') {
      const style = document.createElement('style');
      style.dataset.modId = mod.id;
      style.textContent = mod.code;
      document.head.appendChild(style);
    } else if (mod.type === 'dom-hide') {
      const style = document.createElement('style');
      style.dataset.modId = mod.id;
      style.textContent = `${mod.selector} { display: none !important; }`;
      document.head.appendChild(style);
    }
  }

  applySavedMods();

  let reapplyTimeout;
  const observer = new MutationObserver(() => {
    clearTimeout(reapplyTimeout);
    reapplyTimeout = setTimeout(() => {
      const existingMods = document.querySelectorAll('style[data-mod-id]');
      if (existingMods.length === 0) {
        log('MutationObserver: no mod styles left (e.g. SPA replaced head), re-applying');
        applySavedMods();
      }
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // =========================================
  // PART 2: Element Selector
  // =========================================

  let selectorActive = false;
  let highlightOverlay = null;
  let selectedElement = null;

  function activateSelector() {
    if (selectorActive) return;
    selectorActive = true;
    log('Element selector activated — click an element on the page (Esc to cancel)');

    highlightOverlay = document.createElement('div');
    highlightOverlay.id = '__mod-highlight-overlay';
    Object.assign(highlightOverlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      border: '2px solid #FF6B35',
      backgroundColor: 'rgba(255, 107, 53, 0.1)',
      borderRadius: '3px',
      zIndex: '2147483647',
      transition: 'all 0.05s ease-out',
      display: 'none'
    });
    document.body.appendChild(highlightOverlay);

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleEscape, true);
    document.body.style.cursor = 'crosshair';
  }

  function deactivateSelector() {
    selectorActive = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleEscape, true);
    document.body.style.cursor = '';

    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
  }

  function handleMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === highlightOverlay || el.id === '__mod-highlight-overlay') return;

    const rect = el.getBoundingClientRect();
    Object.assign(highlightOverlay.style, {
      display: 'block',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px'
    });

    selectedElement = el;
  }

  function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (!selectedElement) return;

    const context = extractElementContext(selectedElement);
    deactivateSelector();

    chrome.runtime.sendMessage({
      type: 'ELEMENT_SELECTED',
      data: context
    });
  }

  function handleEscape(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      deactivateSelector();
      chrome.runtime.sendMessage({ type: 'SELECTOR_CANCELLED' });
    }
  }

  function cancelSelector() {
    if (!selectorActive) return;
    deactivateSelector();
    chrome.runtime.sendMessage({ type: 'SELECTOR_CANCELLED' });
  }

  // =========================================
  // PART 3: Panic button (Ctrl+Shift+M)
  // =========================================

  document.addEventListener('keydown', function(e) {
    if (e.key === 'm' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      log('Panic: Ctrl+Shift+M — disabling all mods for this host and reloading');
      chrome.runtime.sendMessage({
        type: 'DISABLE_ALL_MODS_FOR_HOST',
        hostname: hostname
      }).then(() => {
        window.location.reload();
      });
    }
  }, true);

  // =========================================
  // PART 4: DOM Context Extraction
  // =========================================

  function generateSelector(el) {
    if (el.id && !el.id.match(/^(:|[0-9])/)) {
      if (!el.id.match(/[a-f0-9]{8,}|[A-Z][a-z]+[A-Z]|_\d{4,}|rc-|:r/)) {
        return `#${CSS.escape(el.id)}`;
      }
    }

    const stableAttrs = ['data-testid', 'data-cy', 'data-qa', 'name', 'role', 'aria-label', 'type', 'href', 'for'];
    for (const attr of stableAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const selector = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }

    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      const stableClasses = Array.from(current.classList)
        .filter(c => !c.match(/^(css-|sc-|_|[a-z]{1,2}[A-Z]|[a-f0-9]{5,}|svelte-|jsx-|emotion-|styled-)/))
        .slice(0, 2);

      if (stableClasses.length > 0) {
        selector += '.' + stableClasses.map(c => CSS.escape(c)).join('.');
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);

      const fullSelector = path.join(' > ');
      try {
        if (document.querySelectorAll(fullSelector).length === 1) {
          return fullSelector;
        }
      } catch (_) {}

      current = parent;
    }

    return path.join(' > ');
  }

  function extractElementContext(el) {
    const selector = generateSelector(el);
    const rect = el.getBoundingClientRect();

    const outerHTML = el.outerHTML;
    const truncatedHTML = outerHTML.length > 2000
      ? outerHTML.substring(0, 2000) + '... [truncated]'
      : outerHTML;

    const parent = el.parentElement;
    const parentTag = parent ? parent.tagName.toLowerCase() : null;
    const parentClasses = parent ? Array.from(parent.classList).slice(0, 3) : [];

    const computed = window.getComputedStyle(el);
    const styles = {
      display: computed.display,
      position: computed.position,
      fontSize: computed.fontSize,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      padding: computed.padding,
      margin: computed.margin,
      visibility: computed.visibility,
      opacity: computed.opacity
    };

    const textContent = el.textContent?.trim().substring(0, 200) || '';

    return {
      selector,
      tagName: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      id: el.id || null,
      html: truncatedHTML,
      textContent,
      styles,
      parentTag,
      parentClasses,
      rect: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left)
      },
      url: window.location.href,
      hostname: window.location.hostname,
      pageTitle: document.title
    };
  }

  function getSelectorMatchCount(selector) {
    if (!selector || !selector.trim()) return 0;
    try {
      return document.querySelectorAll(selector).length;
    } catch (_) {
      return 0;
    }
  }

  function extractPageContext() {
    return {
      url: window.location.href,
      hostname: window.location.hostname,
      title: document.title,
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 10).map(h => ({
        level: h.tagName,
        text: h.textContent.trim().substring(0, 80)
      })),
      forms: document.querySelectorAll('form').length,
      buttons: document.querySelectorAll('button, [role="button"]').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      modals: document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]').length,
      banners: document.querySelectorAll('[class*="banner"], [class*="cookie"], [class*="consent"], [class*="notification"]').length,
    };
  }

  // =========================================
  // PART 5: Message handling
  // =========================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    log('Message received', msg.type, msg.type === 'APPLY_MOD' && msg.mod ? { description: msg.mod.description, type: msg.mod.type } : {});

    switch (msg.type) {
      case 'ACTIVATE_SELECTOR':
        activateSelector();
        sendResponse({ ok: true });
        break;

      case 'CANCEL_SELECTOR':
        cancelSelector();
        sendResponse({ ok: true });
        break;

      case 'GET_PAGE_CONTEXT':
        sendResponse({ data: extractPageContext() });
        break;

      case 'REFRESH_MODS_STATE':
        log('REFRESH_MODS_STATE — re-reading settings and applying or removing mods');
        applySavedMods();
        sendResponse({ ok: true });
        break;

      case 'APPLY_MOD':
        try {
          const mod = msg.mod;
          log('Apply mod request', { id: mod.id, type: mod.type, description: mod.description });
          if (mod.type === 'js-safe') {
            sendResponse({ ok: false, error: 'JS mods are not supported in this version. Use CSS or "Hide element" instead.' });
            break;
          }
          const selector = (mod.type === 'dom-hide' && mod.selector) ? mod.selector : null;
          const forceSelectorWarning = !!mod.forceSelectorWarning;
          if (selector && !forceSelectorWarning) {
            const count = getSelectorMatchCount(selector);
            if (count > SELECTOR_WARN_THRESHOLD) {
              logWarn('Selector matches too many elements', { selector, count, threshold: SELECTOR_WARN_THRESHOLD });
              sendResponse({ ok: false, matchCount: count, selectorWarn: true });
              break;
            }
          }
          applyMod(mod);
          log('Mod applied in page', { id: mod.id, type: mod.type });
          sendResponse({ ok: true });
        } catch (e) {
          logError('Apply mod failed', e.message);
          sendResponse({ ok: false, error: e.message });
        }
        break;

      case 'GET_SELECTOR_MATCH_COUNT':
        try {
          const count = getSelectorMatchCount(msg.selector);
          sendResponse({ ok: true, count });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;

      case 'REMOVE_MOD':
        const styleEl = document.querySelector(`style[data-mod-id="${msg.modId}"]`);
        if (styleEl) {
          styleEl.remove();
          log('Removed mod style from DOM', { modId: msg.modId });
        } else {
          log('REMOVE_MOD: no style found for id', msg.modId);
        }
        sendResponse({ ok: true });
        break;

      case 'PING':
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
    return true;
  });

})();
