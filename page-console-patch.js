(function() {
  'use strict';
  var o = window.console;
  if (!o || o.__MOD_PATCHED) return;
  var orig = { error: o.error, warn: o.warn };
  function send(level, args) {
    try {
      var str = args.map(function(a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch(e) { return String(a); } }).join(' ');
      window.postMessage({ type: 'MOD_CONSOLE', level: level, args: str, timestamp: Date.now() }, '*');
    } catch(e) {}
  }
  o.error = function() { orig.error.apply(o, arguments); send('error', Array.prototype.slice.call(arguments)); };
  o.warn = function() { orig.warn.apply(o, arguments); send('warn', Array.prototype.slice.call(arguments)); };
  o.__MOD_PATCHED = true;
  window.__MOD_CONSOLE_PATCH_INJECTED = true;
  try {
    window.postMessage({ type: 'MOD_CONSOLE_READY' }, '*');
  } catch(e) {}
})();
