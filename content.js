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
  // Console monitoring (page errors for agent)
  // =========================================
  const CONSOLE_BUFFER_MAX = 20;
  const consoleErrorBuffer = [];

  function capturePageConsole() {
    if (window.__MOD_CONSOLE_PATCH_INJECTED) return;
    const script = document.createElement('script');
    script.textContent = [
      '(function() {',
      '  var o = window.console;',
      '  if (!o || o.__MOD_PATCHED) return;',
      '  var orig = { error: o.error, warn: o.warn };',
      '  function send(level, args) {',
      '    try {',
      '      var str = args.map(function(a) { try { return typeof a === "string" ? a : JSON.stringify(a); } catch(e) { return String(a); } }).join(" ");',
      '      window.postMessage({ type: "MOD_CONSOLE", level: level, args: str, timestamp: Date.now() }, "*");',
      '    } catch(e) {}',
      '  }',
      '  o.error = function() { orig.error.apply(o, arguments); send("error", Array.prototype.slice.call(arguments)); };',
      '  o.warn = function() { orig.warn.apply(o, arguments); send("warn", Array.prototype.slice.call(arguments)); };',
      '  o.__MOD_PATCHED = true;',
      '  window.__MOD_CONSOLE_PATCH_INJECTED = true;',
      '})();'
    ].join('\n');
    (document.documentElement || document.head).appendChild(script);
    script.remove();
  }

  window.addEventListener('message', function(ev) {
    if (ev.source !== window || !ev.data || ev.data.type !== 'MOD_CONSOLE') return;
    consoleErrorBuffer.push({
      level: ev.data.level || 'error',
      args: ev.data.args != null ? String(ev.data.args) : '',
      timestamp: ev.data.timestamp || Date.now()
    });
    if (consoleErrorBuffer.length > CONSOLE_BUFFER_MAX) consoleErrorBuffer.shift();
  });

  capturePageConsole();

  function getConsoleErrors() {
    return {
      recent: consoleErrorBuffer.slice(-10),
      message: consoleErrorBuffer.length === 0
        ? 'No console errors or warnings captured from the page.'
        : 'Last ' + Math.min(10, consoleErrorBuffer.length) + ' console error(s)/warning(s) from the page. If these appeared after your mod, consider narrowing the selector or reverting.'
    };
  }

  // =========================================
  // PART 1: Apply saved mods on page load
  // =========================================

  const domHideContainsTextObservers = {};
  const domHideContainsTextDebounce = {};

  function runDomHideContainsTextInSubtree(mod, root) {
    const text = (mod.params && mod.params.text) ? String(mod.params.text).trim() : '';
    const level = typeof (mod.params && mod.params.hideAncestorLevel) === 'number' ? mod.params.hideAncestorLevel : 0;
    const modId = mod.id;
    if (!text || !root) return;
    const search = text.toLowerCase();
    function walk(el) {
      if (el.nodeType !== 1) return;
      const raw = el.textContent || '';
      if (!raw.toLowerCase().includes(search)) {
        for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
        return;
      }
      for (let i = 0; i < el.children.length; i++) {
        const c = el.children[i];
        if (c.nodeType === 1 && (c.textContent || '').toLowerCase().includes(search)) {
          for (let j = 0; j < el.children.length; j++) walk(el.children[j]);
          return;
        }
      }
      let ancestor = el;
      for (let i = 0; i < level && ancestor; i++) ancestor = ancestor.parentElement;
      if (ancestor && !ancestor.dataset.modHiddenBy) {
        ancestor.style.setProperty('display', 'none', 'important');
        ancestor.dataset.modHiddenBy = modId;
      }
      for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
    }
    walk(root);
  }

  function runDomHideContainsText(mod) {
    const containerSelector = mod.params && mod.params.containerSelector;
    const root = containerSelector ? document.querySelector(containerSelector) : document.body;
    if (!root) return;
    runDomHideContainsTextInSubtree(mod, root);
  }

  function removeDomHideContainsText(modId) {
    const obs = domHideContainsTextObservers[modId];
    if (obs) {
      obs.disconnect();
      delete domHideContainsTextObservers[modId];
    }
    const tid = domHideContainsTextDebounce[modId];
    if (tid) {
      clearTimeout(tid);
      delete domHideContainsTextDebounce[modId];
    }
    document.querySelectorAll(`[data-mod-hidden-by="${modId}"]`).forEach(el => {
      el.style.removeProperty('display');
      delete el.dataset.modHiddenBy;
    });
  }

  function removeAllModStyles() {
    const styles = document.querySelectorAll('style[data-mod-id]');
    styles.forEach(s => s.remove());
    Object.keys(domHideContainsTextObservers).forEach(modId => removeDomHideContainsText(modId));
    log('Removed all mod style tags and dom-hide-contains-text', { count: styles.length });
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
    } else if (mod.type === 'dom-hide-contains-text' && mod.params && typeof mod.params.text === 'string') {
      removeDomHideContainsText(mod.id);
      runDomHideContainsText(mod);
      const containerSelector = mod.params.containerSelector;
      const root = containerSelector ? document.querySelector(containerSelector) : document.body;
      if (root) {
        const observer = new MutationObserver(mutations => {
          const added = [];
          for (const m of mutations) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) added.push(n);
            }
          }
          if (added.length === 0) return;
          if (domHideContainsTextDebounce[mod.id]) clearTimeout(domHideContainsTextDebounce[mod.id]);
          domHideContainsTextDebounce[mod.id] = setTimeout(() => {
            delete domHideContainsTextDebounce[mod.id];
            for (const el of added) {
              runDomHideContainsTextInSubtree(mod, el);
            }
          }, 150);
        });
        observer.observe(root, { childList: true, subtree: true });
        domHideContainsTextObservers[mod.id] = observer;
      }
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

  function countMinimalTextMatches(text, containerSelector, hideAncestorLevel) {
    const search = (text || '').trim().toLowerCase();
    if (!search) return 0;
    const root = containerSelector ? document.querySelector(containerSelector) : document.body;
    if (!root) return 0;
    const level = typeof hideAncestorLevel === 'number' ? hideAncestorLevel : 0;
    let count = 0;
    function walk(el) {
      if (el.nodeType !== 1) return;
      const raw = el.textContent || '';
      if (!raw.toLowerCase().includes(search)) {
        for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
        return;
      }
      for (let i = 0; i < el.children.length; i++) {
        const c = el.children[i];
        if (c.nodeType === 1 && (c.textContent || '').toLowerCase().includes(search)) {
          for (let j = 0; j < el.children.length; j++) walk(el.children[j]);
          return;
        }
      }
      count++;
      for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
    }
    walk(root);
    return count;
  }

  function agentToolSimulateModEffect(params) {
    const type = params?.type;
    if (type === 'dom-hide') {
      const selector = params?.selector;
      if (!selector) return { error: 'selector required for dom-hide' };
      const count = getSelectorMatchCount(selector);
      return { count, message: `Would hide ${count} element(s) matching the selector.` };
    }
    if (type === 'dom-hide-contains-text') {
      const p = params?.params || params;
      const text = p?.text;
      if (!text || typeof text !== 'string') return { error: 'params.text required for dom-hide-contains-text' };
      const containerSelector = p?.containerSelector;
      const hideAncestorLevel = typeof p?.hideAncestorLevel === 'number' ? p.hideAncestorLevel : 0;
      const minimalMatchCount = countMinimalTextMatches(text, containerSelector, hideAncestorLevel);
      return {
        minimalMatchCount,
        message: minimalMatchCount === 0
          ? 'No minimal text matches found — the page may have changed or the text is not present.'
          : `Would hide ${minimalMatchCount} element(s) (ancestors of minimal text matches).`
      };
    }
    return { error: 'type must be dom-hide or dom-hide-contains-text' };
  }

  function countVisibleSelectorMatches(selector) {
    try {
      const nodes = document.querySelectorAll(selector);
      let visible = 0;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.nodeType !== 1) continue;
        try {
          const cs = window.getComputedStyle(el);
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null) visible++;
        } catch (_) {}
      }
      return { total: nodes.length, visible };
    } catch (_) {
      return { total: 0, visible: 0 };
    }
  }

  function agentToolVerifyMod(params) {
    const mod = params?.mod || params;
    if (!mod || !mod.type) return { error: 'verify_mod requires a mod object (type, selector or params)' };
    const type = mod.type;
    let matchCount = 0;
    let visibleCount = 0;
    if (type === 'dom-hide') {
      const selector = mod.selector;
      if (!selector) return { error: 'dom-hide mod requires selector' };
      const c = countVisibleSelectorMatches(selector);
      matchCount = c.total;
      visibleCount = c.visible;
    } else if (type === 'dom-hide-contains-text' && mod.params && typeof mod.params.text === 'string') {
      const p = mod.params;
      const containerSelector = p.containerSelector;
      const hideAncestorLevel = typeof p.hideAncestorLevel === 'number' ? p.hideAncestorLevel : 0;
      matchCount = countMinimalTextMatches(p.text, containerSelector, hideAncestorLevel);
      visibleCount = matchCount;
    } else if (type === 'css') {
      return { matchCount: 0, visibleCount: 0, message: 'CSS mods have no selector match count; verify visually.' };
    } else {
      return { error: 'Unsupported mod type for verify_mod' };
    }
    const tempMod = { ...mod, id: 'verify_temp' };
    applyMod(tempMod);
    const afterVisible = type === 'dom-hide' ? countVisibleSelectorMatches(mod.selector).visible : 0;
    removeModById('verify_temp');
    const message = matchCount === 0
      ? '0 elements matched. Selector or text may be wrong or content not in DOM yet.'
      : `${matchCount} element(s) matched, ${visibleCount} visible; after apply: ${matchCount - afterVisible} hidden.`;
    return { matchCount, visibleCount, message };
  }

  function removeModById(modId) {
    if (domHideContainsTextObservers[modId]) {
      domHideContainsTextObservers[modId].disconnect();
      delete domHideContainsTextObservers[modId];
    }
    const tid = domHideContainsTextDebounce[modId];
    if (tid) {
      clearTimeout(tid);
      delete domHideContainsTextDebounce[modId];
    }
    document.querySelectorAll(`[data-mod-hidden-by="${modId}"]`).forEach(el => {
      el.style.removeProperty('display');
      delete el.dataset.modHiddenBy;
    });
    const styleEl = document.querySelector(`style[data-mod-id="${modId}"]`);
    if (styleEl) styleEl.remove();
  }

  function getSelector(el) {
    if (!el || !el.tagName) return null;
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(c => /^[a-zA-Z][\w-]*$/.test(c)).slice(0, 2);
      if (classes.length) return tag + '.' + classes.join('.');
    }
    return tag;
  }

  function extractPageContext() {
    const landmarks = [];
    const addLandmark = (selector, name) => {
      const el = document.querySelector(selector);
      if (el) {
        const sel = getSelector(el);
        if (sel) landmarks.push({ name, selector: sel });
      }
    };
    addLandmark('header, [role="banner"]', 'header');
    addLandmark('main, [role="main"], #main, .main, #content, .content', 'main');
    addLandmark('nav, [role="navigation"]', 'nav');
    addLandmark('footer, [role="contentinfo"]', 'footer');
    addLandmark('aside, [role="complementary"]', 'aside');

    const structure = [];
    const body = document.body;
    if (body) {
      const children = Array.from(body.children).slice(0, 8);
      for (const child of children) {
        const sel = getSelector(child);
        if (sel) structure.push(sel);
      }
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 12).map(h => ({
      level: h.tagName,
      text: h.textContent.trim().substring(0, 80),
      selector: getSelector(h)
    }));

    return {
      url: window.location.href,
      hostname: window.location.hostname,
      title: document.title,
      headings,
      forms: document.querySelectorAll('form').length,
      buttons: document.querySelectorAll('button, [role="button"]').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      modals: document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]').length,
      banners: document.querySelectorAll('[class*="banner"], [class*="cookie"], [class*="consent"], [class*="notification"]').length,
      landmarks,
      structure,
    };
  }

  // =========================================
  // Agent tools (for truly agentic loop)
  // =========================================

  function agentToolGetPageOverview(params) {
    const summary = agentToolGetPageSummary();
    const component = agentToolGetComponentSummary();
    const framework = agentToolDetectFramework();
    return {
      ...summary,
      sections: component.sections,
      framework: (framework.frameworks && framework.frameworks[0]) || 'Unknown',
      rootId: framework.rootId
    };
  }

  function agentToolGetPageSummary() {
    const metaDesc = document.querySelector('meta[name="description"]');
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogType = document.querySelector('meta[property="og:type"]');
    const h1 = document.querySelector('h1');
    const lang = document.documentElement.lang || null;
    const viewport = document.querySelector('meta[name="viewport"]');
    const purposeParts = [document.title];
    if (h1) purposeParts.push(h1.textContent.trim());
    if (metaDesc && metaDesc.getAttribute('content')) purposeParts.push(metaDesc.getAttribute('content'));
    const purpose = purposeParts.join(' ').substring(0, 200);
    return {
      title: document.title,
      url: window.location.href,
      description: metaDesc ? metaDesc.getAttribute('content') : null,
      ogTitle: ogTitle ? ogTitle.getAttribute('content') : null,
      ogType: ogType ? ogType.getAttribute('content') : null,
      h1: h1 ? h1.textContent.trim().substring(0, 120) : null,
      lang,
      viewport: viewport ? viewport.getAttribute('content') : null,
      purpose,
    };
  }

  function agentToolGetStructure(selector) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { error: 'Selector did not match any element' };
    const MAX_DEPTH = 4;
    const MAX_CHILDREN = 12;
    function outline(el, depth) {
      if (depth > MAX_DEPTH) return null;
      const sel = getSelector(el);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const label = [sel || tag, role ? `role=${role}` : ''].filter(Boolean).join(' ');
      const children = Array.from(el.children).slice(0, MAX_CHILDREN).map(c => outline(c, depth + 1)).filter(Boolean);
      return { tag, selector: sel, role, label, children: children.length ? children : undefined };
    }
    return { structure: outline(root, 0) };
  }

  function agentToolSearchComponents(query) {
    if (!query || typeof query !== 'string') return { error: 'query required' };
    const q = query.trim().toLowerCase();
    const results = [];
    const MAX = 20;
    try {
      const nodes = document.querySelectorAll(query);
      if (nodes.length > 0) {
        const len = Math.min(nodes.length, MAX);
        for (let i = 0; i < len; i++) {
          const el = nodes[i];
          results.push({
            selector: getSelector(el),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            text: el.textContent.trim().substring(0, 60),
            matchCount: nodes.length,
          });
        }
        return { bySelector: true, matchCount: nodes.length, results };
      }
    } catch (_) {}
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (results.length >= MAX) break;
      const text = el.textContent.trim();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
      if (text.includes(q) || role.includes(q) || cls.includes(q)) {
        results.push({
          selector: getSelector(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          text: text.substring(0, 80),
        });
      }
    }
    return { bySelector: false, results };
  }

  function agentToolDetectFramework() {
    const hints = [];
    if (typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' || (window.React && window.React.createElement)) hints.push('React');
    if (window.__VUE__ || (window.Vue && window.Vue.version)) hints.push('Vue');
    if (window.ng || (window.getAngularVersion && typeof window.getAngularVersion === 'function')) hints.push('Angular');
    if (window.__NEXT_DATA__ || document.getElementById('__NEXT_DATA__')) hints.push('Next.js');
    if (document.querySelector('[data-svelte-hydratable]') || window.__svelte) hints.push('Svelte');
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    for (const s of scripts) {
      const src = (s.getAttribute('src') || '').toLowerCase();
      if (src.includes('react') && !hints.includes('React')) hints.push('React (from script)');
      if (src.includes('vue') && !hints.includes('Vue')) hints.push('Vue (from script)');
      if (src.includes('angular') && !hints.includes('Angular')) hints.push('Angular (from script)');
      if (src.includes('next') && !hints.includes('Next.js')) hints.push('Next.js (from script)');
    }
    const root = document.body ? document.body.firstElementChild : null;
    const rootId = root && root.id ? root.id : null;
    if (rootId === '__next') hints.push('Next.js (root id)');
    if (rootId === 'root' || rootId === 'app') hints.push('Common SPA root');
    return { frameworks: hints.length ? hints : ['Unknown'], rootId };
  }

  function agentToolGetComponentSummary() {
    const sections = [];
    const landmarks = [
      { name: 'header', el: document.querySelector('header, [role="banner"]') },
      { name: 'main', el: document.querySelector('main, [role="main"], #main, .main') },
      { name: 'nav', el: document.querySelector('nav, [role="navigation"]') },
      { name: 'footer', el: document.querySelector('footer, [role="contentinfo"]') },
      { name: 'aside', el: document.querySelector('aside, [role="complementary"]') },
    ];
    for (const { name, el } of landmarks) {
      if (el) {
        const sel = getSelector(el);
        const h = el.querySelector('h1, h2, h3');
        sections.push({
          name,
          selector: sel,
          heading: h ? h.textContent.trim().substring(0, 50) : null,
          childCount: el.children.length,
        });
      }
    }
    const regions = document.querySelectorAll('[role="region"], section');
    for (let i = 0; i < Math.min(regions.length, 8); i++) {
      const el = regions[i];
      const ariaLabel = el.getAttribute('aria-label');
      const h = el.querySelector('h1, h2, h3, h4');
      sections.push({
        name: ariaLabel || (h ? h.textContent.trim().substring(0, 30) : 'region'),
        selector: getSelector(el),
        childCount: el.children.length,
      });
    }
    return { sections };
  }

  function agentToolGetElementInfo(selector) {
    if (!selector) return { error: 'selector required' };
    const el = document.querySelector(selector);
    if (!el) return { error: 'No element matched selector' };
    let display, visibility;
    try {
      const cs = window.getComputedStyle(el);
      display = cs.display;
      visibility = cs.visibility;
    } catch (_) {}
    const text = el.textContent.trim().substring(0, 150);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 10) : []),
      role: el.getAttribute('role'),
      display,
      visibility,
      childCount: el.children.length,
      textSnippet: text,
      selector: getSelector(el),
    };
  }

  function agentToolFindElements(params) {
    if (!params || typeof params !== 'object') return { error: 'find_elements requires params' };
    if (params.text != null && typeof params.text === 'string') {
      return agentToolFindElementsContainingText(params.text, params.containerSelector);
    }
    if (params.selector != null && typeof params.selector === 'string') {
      try {
        const nodes = document.querySelectorAll(params.selector);
        const MAX = 20;
        const results = [];
        for (let i = 0; i < Math.min(nodes.length, MAX); i++) {
          const el = nodes[i];
          if (el.nodeType !== 1) continue;
          results.push({
            selector: getSelector(el),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            textSnippet: (el.textContent || '').trim().substring(0, 80)
          });
        }
        return { bySelector: true, matchCount: nodes.length, results };
      } catch (e) {
        return { error: 'Invalid selector', matchCount: 0, results: [] };
      }
    }
    if (params.query != null && typeof params.query === 'string') {
      return agentToolSearchComponents(params.query);
    }
    return { error: 'find_elements requires one of: text, selector, query' };
  }

  function agentToolInspectElement(params) {
    const selector = params?.selector;
    if (!selector) return { error: 'inspect_element requires selector' };
    const info = agentToolGetElementInfo(selector);
    if (info.error) return info;
    const structure = agentToolGetStructure(selector);
    return { ...info, structure: structure.structure };
  }

  function agentToolCheckSelector(params) {
    const type = params?.type;
    if (type === 'dom-hide') {
      const selector = params?.selector;
      if (!selector) return { error: 'check_selector dom-hide requires selector' };
      const c = countVisibleSelectorMatches(selector);
      return {
        matchCount: c.total,
        visibleCount: c.visible,
        message: `${c.total} match(es), ${c.visible} visible.`
      };
    }
    if (type === 'dom-hide-contains-text') {
      const p = params?.params || params;
      const text = p?.text;
      if (!text || typeof text !== 'string') return { error: 'check_selector dom-hide-contains-text requires params.text' };
      const containerSelector = p?.containerSelector;
      const hideAncestorLevel = typeof p?.hideAncestorLevel === 'number' ? p.hideAncestorLevel : 0;
      const count = countMinimalTextMatches(text, containerSelector, hideAncestorLevel);
      return {
        matchCount: count,
        visibleCount: count,
        message: count === 0 ? 'No minimal text matches.' : `${count} minimal text match(es).`
      };
    }
    return { error: 'check_selector requires type dom-hide or dom-hide-contains-text and selector or params' };
  }

  function agentToolFindElementsContainingText(text, containerSelector) {
    if (!text || typeof text !== 'string') return { error: 'text required' };
    const search = text.trim().toLowerCase();
    if (!search) return { error: 'text required' };
    const root = containerSelector ? document.querySelector(containerSelector) : document.body;
    if (!root) return { error: containerSelector ? 'Container selector did not match' : 'No body' };
    const MAX = 30;
    const results = [];
    function walk(el) {
      if (results.length >= MAX) return;
      if (el.nodeType !== 1) return;
      const raw = el.textContent || '';
      if (!raw.toLowerCase().includes(search)) {
        for (const child of el.children) walk(child);
        return;
      }
      for (const child of el.children) {
        if (child.nodeType === 1 && (child.textContent || '').toLowerCase().includes(search)) {
          for (const c of el.children) walk(c);
          return;
        }
      }
      const sel = getSelector(el);
      let ancestor = el;
      let level = 0;
      const ancestors = [];
      while (ancestor && ancestor !== root) {
        ancestors.push({ level, selector: getSelector(ancestor), tag: ancestor.tagName.toLowerCase() });
        ancestor = ancestor.parentElement;
        level++;
      }
      results.push({
        selector: sel,
        tag: el.tagName.toLowerCase(),
        textSnippet: raw.trim().substring(0, 80),
        ancestorLevels: ancestors.slice(0, 6),
        suggestedHideAncestorLevel: Math.min(2, Math.max(0, level - 1)),
      });
      for (const child of el.children) walk(child);
    }
    walk(root);
    return { matchCount: results.length, results };
  }

  function runAgentTool(tool, params) {
    const p = params || {};
    switch (tool) {
      case 'get_page_overview':
        return agentToolGetPageOverview(p);
      case 'find_elements':
        return agentToolFindElements(p);
      case 'inspect_element':
        return agentToolInspectElement(p);
      case 'check_selector':
        return agentToolCheckSelector(p);
      case 'propose_mod':
        return { error: 'propose_mod is handled in the side panel' };
      case 'verify_mod':
        return agentToolVerifyMod(p?.mod || p);
      case 'get_site_knowledge':
        return { error: 'get_site_knowledge is handled in the side panel' };
      case 'get_console_errors':
        return getConsoleErrors();
      case 'web_search':
        return { message: 'Web search is not configured. Use get_site_knowledge and page tools instead.' };
      case 'get_page_summary':
        return agentToolGetPageSummary();
      case 'get_structure':
        return agentToolGetStructure(p.selector);
      case 'search_components':
        return agentToolSearchComponents(p.query);
      case 'detect_framework':
        return agentToolDetectFramework();
      case 'get_component_summary':
        return agentToolGetComponentSummary();
      case 'get_element_info':
        return agentToolGetElementInfo(p.selector);
      case 'find_elements_containing_text':
        return agentToolFindElementsContainingText(p.text, p.containerSelector);
      case 'simulate_mod_effect':
        return agentToolSimulateModEffect(p);
      default:
        return { error: 'Unknown tool: ' + tool };
    }
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

      case 'AGENT_TOOL':
        try {
          const result = runAgentTool(msg.tool, msg.params || {});
          if (msg.tool === 'detect_framework' && result && !result.error && Array.isArray(result.frameworks) && result.frameworks.length > 0) {
            chrome.runtime.sendMessage({
              type: 'UPDATE_SITE_KNOWLEDGE',
              hostname: storageHostname,
              framework: result.frameworks[0]
            }).catch(() => {});
          }
          sendResponse({ ok: true, result });
        } catch (e) {
          logError('AGENT_TOOL failed', msg.tool, e.message);
          sendResponse({ ok: false, error: e.message });
        }
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

      case 'REMOVE_MOD': {
        const hadTextMod = !!domHideContainsTextObservers[msg.modId];
        if (hadTextMod) {
          removeDomHideContainsText(msg.modId);
          log('Removed dom-hide-contains-text mod', { modId: msg.modId });
        }
        const styleEl = document.querySelector(`style[data-mod-id="${msg.modId}"]`);
        if (styleEl) {
          styleEl.remove();
          log('Removed mod style from DOM', { modId: msg.modId });
        } else if (!hadTextMod) {
          log('REMOVE_MOD: no style found for id', msg.modId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PING':
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
    return true;
  });

})();
