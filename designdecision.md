# Design decisions

## CSP-safe console injection (no inline script)

We avoid inline script for console monitoring so the extension is not blocked by strict Content Security Policy (script-src-elem) on sites. The console patch lives in an external file `page-console-patch.js` and is injected with `script.src = chrome.runtime.getURL('page-console-patch.js')`. If the page CSP still blocks that script, we detect failure (script.onerror or timeout) and return a structured failure from `getConsoleErrors()` so the AI agent is aware and can still suggest mods. We do not use `unsafe-inline` or weaken CSP. Style injection still uses `<style>` + `style.textContent`; a fallback (e.g. blob URL or extension-hosted stylesheet) is reserved for future style-src-elem issues if they appear.

## Failures fed back to the agent with context

When console monitoring or apply-mod (or other agent-facing operations) fail, we return structured error info to the agent: `error`/`message`, and `context` (hostname, modType, selector, etc.) so the agent can reason about what failed and adapt (e.g. avoid relying on console on that page, or suggest a different mod).

## Per-mod enable/disable without full page reload

When the user toggles a mod in the Mods list, we persist via `TOGGLE_MOD` then ask the active tab’s content script to handle `REFRESH_MODS_STATE`, which re-reads storage and reapplies. We do **not** call `location.reload()` so the update feels instant and doesn’t reset SPA state. Reapply is implemented as **strip then apply**: `removeAllModStyles()` removes injected `<style data-mod-id>`, observers, and text-hide markers, then enabled mods are applied in order—so turning a mod **off** actually removes its effect, not only stacking new styles for mods that stay on.

## Share → clipboard feedback (toast)

“Copied” confirmations use a **fixed bottom toast** (`#sidepanel-toast`) so they appear in the same place regardless of scroll or whether the user clicked Share at the top of the mod list. That matches common OS/app patterns (snackbar). Import validation and “mod added” still use `#import-mod-feedback` next to the import controls where the message is contextually anchored.

## PostHog / product analytics

All `posthogCapture` events are merged with `extension_version` and `product: 'mod'` in the service worker so funnels stay comparable across releases. Side panel code uses `captureAnalytics()` so `hostname` is attached consistently when available. Agent tools are logged per execution (`agent_tool_executed`) and per batch (`agent_tools_batch`); conversation turns end with `conversation_turn_completed` (outcome + tools + whether a mod card was shown). `mod_saved` includes `save_source` (`apply_and_save_chat`, `import_paste`, `refinement_auto_apply`, etc.) to separate create/update paths from imports.
