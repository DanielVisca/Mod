# Mod — Project reminder (for future you)

**Read this first when you come back.** One-page reminder of what this is, where you left it, and where it’s going.

---

## What this is

**Mod** is a Chrome extension: an AI-powered side panel that **modifies any website** and **remembers** the changes. You describe what you want in chat (or select an element); the AI suggests CSS or “hide element” mods; you Apply & Save. Mods re-apply on every visit to that site.

**One-line pitch:** “Hide that banner / change that style forever, in plain English.”

---

## Setup (when you clone or come back)

1. **Chrome 114+**, Manifest V3.
2. **Load unpacked:** `chrome://extensions` → Developer mode → Load unpacked → select this folder.
3. **API key:** Open Mod → Settings → paste your **Claude API key** (stored locally, only used for Anthropic). PostHog in `background.js` is optional (empty key = no analytics).

No build step. No npm. Just the extension folder.

---

## Where things are at (current state)

- **Core:** Chat → AI suggests mod (CSS, dom-hide, dom-hide-contains-text) → Apply & Save / Preview / Reject. Mods stored per hostname, re-applied on load.
- **Agent:** Up to **5 tool rounds** per message. Tools: page summary, structure, components, framework detection, find_elements_containing_text, simulate_mod_effect. Tool chain enforced (e.g. must run find_elements before dom-hide-contains-text).
- **UX:** “Did this work?” after Apply & Save (Yes/No → No sends re-investigate). **Conversation goal** (set/clear). **Revert to previous** version from Mod detail (snapshots stored on each refinement).
- **Context:** Page context, landmarks, optional **DevTools $0** (selected element in Elements panel when DevTools open), last applied mod, existing mods.
- **DevTools:** `devtools.js` + `devtools.html` — when DevTools is open for the tab, find_elements_containing_text runs in the page via `inspectedWindow.eval` for accurate minimal-node search; also provides $0 for context.
- **Panic:** Ctrl+Shift+M disables all mods for current site and reloads.
- **Analytics:** PostHog capture for install, panel open, message_sent, apply_and_save, mod_saved/deleted/toggled/reverted, agent_tools_used, view_changed, goal_set/cleared, mod_rejected, did_this_work_no, mod_previewed, mod_shared, refinement_started, $ai_generation.

---

## Vision (where you want to take it)

- **Optional host permissions** — Request access per site on first use instead of “all sites” to reduce the scary permission.
- **Smarter agent** — More tool rounds if needed; optional “max refinement rounds” and “consider different strategy” after N “Did this work? → No” in a row.
- **Better observability** — Run-in-page (read-only) or more canned queries so the agent can inspect the page even more like a human.
- **Distribution** — Chrome Web Store listing; maybe a simple landing page.

---

## Concerns / known limitations

- **No JavaScript mods** — Only CSS and hide-element; MV3 content script limits. Don’t promise “run any script.”
- **Sites change** — Selectors/classes break after redesigns; mods can over-match or under-match. No auto-healing; user re-mods or refines.
- **Broad permission** — “Read and change all your data on all websites” is required for inject; optional host permissions would improve trust.
- **PostHog key in repo** — If you open-source, use a placeholder or env; don’t ship a real project key.
- **Revert only for “refinements”** — Snapshots start with the update that stores them; mods never refined after the change have no “previous version” until next refine.

---

## Repo layout (quick ref)

| Path | Purpose |
|------|--------|
| `manifest.json` | Extension config, permissions, side panel, devtools_page |
| `background.js` | Service worker: routing, Claude API, storage, PostHog |
| `content.js` | Tab: apply mods, selector, page context, agent tools, panic |
| `sidepanel.html/js/css` | Side panel UI, chat, mod list, settings |
| `devtools.html`, `devtools.js` | DevTools page: find_elements in page, $0 for context |
| `icons/` | 16, 48, 128 px icons |

Storage: `mods:{hostname}`, `settings`, `lastAppliedMod_{hostname}`, `conversationGoal_{hostname}`. Revisions hold snapshots for revert.

---

*Last updated when pushing to GitHub. See README.md for full docs.*
