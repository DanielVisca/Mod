# Design decisions

## CSP-safe console injection (no inline script)

We avoid inline script for console monitoring so the extension is not blocked by strict Content Security Policy (script-src-elem) on sites. The console patch lives in an external file `page-console-patch.js` and is injected with `script.src = chrome.runtime.getURL('page-console-patch.js')`. If the page CSP still blocks that script, we detect failure (script.onerror or timeout) and return a structured failure from `getConsoleErrors()` so the AI agent is aware and can still suggest mods. We do not use `unsafe-inline` or weaken CSP. Style injection still uses `<style>` + `style.textContent`; a fallback (e.g. blob URL or extension-hosted stylesheet) is reserved for future style-src-elem issues if they appear.

## Failures fed back to the agent with context

When console monitoring or apply-mod (or other agent-facing operations) fail, we return structured error info to the agent: `error`/`message`, and `context` (hostname, modType, selector, etc.) so the agent can reason about what failed and adapt (e.g. avoid relying on console on that page, or suggest a different mod).
