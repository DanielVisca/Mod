(function() {
  'use strict';

  if (!chrome.devtools || !chrome.devtools.inspectedWindow) return;

  const tabId = chrome.devtools.inspectedWindow.tabId;
  const port = chrome.runtime.connect({ name: 'mod-devtools' });

  port.postMessage({ type: 'DEVTOOLS_PANEL_READY', tabId });

  window.addEventListener('unload', function() {
    port.postMessage({ type: 'DEVTOOLS_PANEL_UNLOAD', tabId });
  });

  port.onMessage.addListener(function(msg) {
    if (msg.type === 'GET_SELECTED_ELEMENT' && msg.requestId) {
      const evalCode = [
        '(function() {',
        '  if (typeof $0 === "undefined" || !$0 || !$0.tagName) return null;',
        '  var el = $0;',
        '  function getSel(e) {',
        '    if (!e || !e.tagName) return "";',
        '    if (e.id && /^[a-zA-Z][\\w-]*$/.test(e.id)) return "#" + e.id;',
        '    var tag = e.tagName.toLowerCase();',
        '    if (e.className && typeof e.className === "string") {',
        '      var c = e.className.trim().split(/\\s+/).filter(function(x){ return /^[a-zA-Z][\\w-]*$/.test(x); }).slice(0,2);',
        '      if (c.length) return tag + "." + c.join(".");',
        '    }',
        '    return tag;',
        '  }',
        '  return {',
        '    tagName: el.tagName,',
        '    textContent: (el.textContent || "").slice(0, 100),',
        '    selector: getSel(el)',
        '  };',
        '})()'
      ].join('\n');
      chrome.devtools.inspectedWindow.eval(evalCode, function(result, err) {
        if (err && err.isException) {
          port.postMessage({ type: 'SELECTED_ELEMENT_RESULT', requestId: msg.requestId, result: null });
          return;
        }
        port.postMessage({ type: 'SELECTED_ELEMENT_RESULT', requestId: msg.requestId, result: result });
      });
      return;
    }
    if (msg.type !== 'RUN_AGENT_TOOL_IN_PAGE' || msg.tool !== 'find_elements_containing_text') return;
    const params = msg.params || {};
    const text = params.text;
    const containerSelector = params.containerSelector;
    if (!text || typeof text !== 'string') {
      port.postMessage({ type: 'AGENT_TOOL_RESULT', requestId: msg.requestId, result: { error: 'text required' } });
      return;
    }
    const search = String(text).trim().toLowerCase();
    if (!search) {
      port.postMessage({ type: 'AGENT_TOOL_RESULT', requestId: msg.requestId, result: { error: 'text required' } });
      return;
    }

    const paramsJson = JSON.stringify({ search, containerSelector: containerSelector || '' });

    const evalCode = [
      '(function() {',
      '  try {',
      '    var params = ' + paramsJson + ';',
      '    var search = params.search;',
      '    var containerSelector = params.containerSelector;',
      '    var root = containerSelector ? document.querySelector(containerSelector) : document.body;',
      '    if (!root) return { error: containerSelector ? "Container selector did not match" : "No body" };',
      '    var MAX = 30;',
      '    var results = [];',
      '    function getSelector(el) {',
      '      if (!el || !el.tagName) return null;',
      '      if (el.id && /^[a-zA-Z][\\w-]*$/.test(el.id)) return "#" + el.id;',
      '      var tag = el.tagName.toLowerCase();',
      '      if (el.className && typeof el.className === "string") {',
      '        var classes = el.className.trim().split(/\\s+/).filter(function(c) { return /^[a-zA-Z][\\w-]*$/.test(c); }).slice(0, 2);',
      '        if (classes.length) return tag + "." + classes.join(".");',
      '      }',
      '      return tag;',
      '    }',
      '    function getParentElement(el) {',
      '      var p = el.parentNode;',
      '      if (!p) return null;',
      '      if (p.nodeType === 1) return p;',
      '      if (p.constructor && p.constructor.name === "ShadowRoot") return p.host;',
      '      return null;',
      '    }',
      '    function walk(el) {',
      '      if (results.length >= MAX) return;',
      '      if (el.nodeType !== 1) return;',
      '      var raw = el.textContent || "";',
      '      if (raw.toLowerCase().indexOf(search) === -1) {',
      '        for (var i = 0; i < el.children.length; i++) walk(el.children[i]);',
      '        if (el.shadowRoot) walk(el.shadowRoot);',
      '        return;',
      '      }',
      '      for (var i = 0; i < el.children.length; i++) {',
      '        var c = el.children[i];',
      '        if (c.nodeType === 1 && (c.textContent || "").toLowerCase().indexOf(search) !== -1) {',
      '          for (var j = 0; j < el.children.length; j++) walk(el.children[j]);',
      '          if (el.shadowRoot) walk(el.shadowRoot);',
      '          return;',
      '        }',
      '      }',
      '      var sel = getSelector(el);',
      '      var ancestor = el;',
      '      var level = 0;',
      '      var ancestors = [];',
      '      while (ancestor && ancestor !== root) {',
      '        ancestors.push({ level: level, selector: getSelector(ancestor), tag: ancestor.tagName.toLowerCase() });',
      '        ancestor = getParentElement(ancestor);',
      '        level++;',
      '      }',
      '      results.push({',
      '        selector: sel,',
      '        tag: el.tagName.toLowerCase(),',
      '        textSnippet: raw.trim().substring(0, 80),',
      '        ancestorLevels: ancestors.slice(0, 6),',
      '        suggestedHideAncestorLevel: Math.min(2, Math.max(0, level - 1))',
      '      });',
      '      for (var i = 0; i < el.children.length; i++) walk(el.children[i]);',
      '      if (el.shadowRoot) walk(el.shadowRoot);',
      '    }',
      '    walk(root);',
      '    return { matchCount: results.length, results: results };',
      '  } catch (e) {',
      '    return { error: e.message || String(e) };',
      '  }',
      '})()'
    ].join('\n');

    chrome.devtools.inspectedWindow.eval(evalCode, function(result, err) {
      if (err && err.isException) {
        port.postMessage({ type: 'AGENT_TOOL_RESULT', requestId: msg.requestId, result: { error: err.value || 'Eval error' } });
        return;
      }
      if (typeof result === 'object' && result !== null) {
        port.postMessage({ type: 'AGENT_TOOL_RESULT', requestId: msg.requestId, result: result });
      } else {
        port.postMessage({ type: 'AGENT_TOOL_RESULT', requestId: msg.requestId, result: { error: 'Invalid result from page' } });
      }
    });
  });
})();
