# Plan: CSP-safe injection and feeding failures to the agent

## 1. Problem

- **Script**: content.js injects a `<script>` with **inline code** to patch the page’s `console.error`/`warn`. CSP **script-src-elem** blocks inline script execution on many sites.
- **Style**: Mods use `<style>` + `style.textContent`. Strict **style-src-elem** could block these later.
- We do **not** use `unsafe-inline` or weaken security. When anything fails, we must **feed the error back to the AI agent with as much relevant context as possible** so it can reason and adapt.

---

## 2. Principle: Feed all failures to the agent with context

Whenever something fails in the content script or in a path the agent relies on:

- **Return structured error info** to the agent (via tool responses or message payloads), not just a generic “failed”.
- **Include relevant context**: reason (e.g. CSP block, script load error), hostname/URL, what was being attempted (e.g. “console monitoring”, “apply mod type: css”), and a short suggestion when helpful (e.g. “You can still suggest mods; console errors from the page will not be available.”).

So the agent is always aware of what failed and why, and can adjust its next steps (e.g. skip relying on console, suggest a different mod approach).

---

## 3. Console patch: external file + graceful degradation

- **New file**: `page-console-patch.js` — same IIFE as current inline script (patch console, postMessage MOD_CONSOLE). No inline code in the page.
- **Manifest**: Add `web_accessible_resources` for `page-console-patch.js` with `matches: ["<all_urls>"]`.
- **content.js**: Inject with `script.src = chrome.runtime.getURL('page-console-patch.js')` instead of `script.textContent`. Optionally listen for a “ready” postMessage from the patch; use `script.onerror` or a short timeout to detect when the script was blocked or failed to load.

**When the console patch fails (CSP or load error):**

- Set a flag (e.g. `consolePatchFailed`) and store **failure context**: e.g. `{ reason: 'script_blocked_or_load_error', detail: 'CSP script-src-elem likely blocking extension script' }`.
- **getConsoleErrors()** must feed this back to the agent. Return a structure the agent can use, for example:

  - `unavailable: true`
  - `reason`: short enum or string (e.g. `"csp_or_script_blocked"`)
  - `message`: human- and agent-readable text, e.g. *“Console monitoring is not available on this page (Content Security Policy or page restrictions blocked the monitoring script). You can still suggest and apply mods; console errors from the page will not be visible.”*
  - `context`: optional object with `hostname`, `url` (if available in content script), so the agent knows which page this applies to.

So when the agent calls `get_console_errors`, it either gets the usual `recent` + `message` or this failure payload and can avoid relying on console for that tab.

---

## 4. Apply mod and other content-script failures

- **APPLY_MOD**: Already returns `{ ok: false, error: e.message }` on catch. Enrich responses so the agent gets:
  - `error`: clear message (e.g. “Failed to apply CSS mod: …”).
  - **Context**: `modType`, `modId` or `description`, `hostname` (if available). If the failure is due to CSP (e.g. style injection blocked), include that in the error text or a `reason` field so the agent knows it’s a page-policy issue, not a logic bug.
- **Other tools** that the agent calls (e.g. `get_structure`, `get_page_summary`, selector tools): on failure, return an object that includes at least `error` and, where useful, `context` (hostname, selector, tool name) so the agent can tell what failed and where.

This keeps the agent aware of what is failing and with what context, without exposing internals unnecessarily.

---

## 5. Style injection (future-proofing)

- Keep current `<style>` + `style.textContent` for now. If **style-src-elem** blocks later, add a fallback (e.g. blob URL or `<link>` to extension resource) and, on failure, **return a clear error to the agent** (e.g. “Style injection blocked by page policy (CSP); mod not applied”) with context (mod type, hostname). No `unsafe-inline`.

---

## 6. Files to touch

| File | Change |
|------|--------|
| **New: page-console-patch.js** | IIFE that patches console and posts MOD_CONSOLE (optional “ready” message). |
| manifest.json | Add `web_accessible_resources` for `page-console-patch.js`. |
| content.js | (1) Inject script via `script.src`; detect failure (onerror / timeout) and set `consolePatchFailed` + failure context. (2) **getConsoleErrors()**: when patch failed, return agent-facing structure with `unavailable`, `reason`, `message`, `context`. (3) APPLY_MOD and other agent-facing responses: include error + context (modType, hostname, reason where applicable). |
| Optional: comment or designdecision.md | Note that we avoid inline script for CSP and that all failures are surfaced to the agent with context. |

---

## 7. Summary

- **CSP**: Remove inline script by moving the console patch to `page-console-patch.js` and injecting via `src`; no `unsafe-inline`.
- **Failures**: Every relevant failure (console patch, apply mod, style, other tools) is returned to the AI agent with a clear message and as much relevant context as possible so the agent can stay aware of what is failing and adapt its behavior.
