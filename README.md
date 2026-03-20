# Mod — Why does everyone visiting the same site have to see the same thing?

Your web, your way. Personalize how any site should look and work — for you.

Mod lets you personalize any website. Describe what you'd change — hide the clutter, rearrange the layout, redesign the look — and AI makes it happen. Same site, same functionality, tailored to you. Every visit.

A **Chrome extension** that lets you change any site in plain English: describe what you want (or select an element), and the AI suggests CSS or “hide element” mods. Apply & Save once; Mod re-applies on every visit to that site.

**→ Coming back after a while? Read [PROJECT.md](./PROJECT.md) first:** short reminder of what it does, setup, current state, vision, and concerns.

---

## What Mod does

- **Chat with the AI** in a side panel. You type (“hide the cookie banner”, “make the header darker”) or **Select** an element on the page and describe the change.
- **Agent tools** run in the page: page summary, structure, components, framework detection, find elements by text, simulate mod effect. The AI can use up to **5 tool rounds** per message to inspect then suggest.
- **One mod per suggestion:** CSS, hide by selector, or **hide by text** (for dynamic feeds like Instagram/Twitter where class names change). You **Apply & Save**, **Preview**, or **Reject**.
- **Refine in chat:** After saving, say “make it bigger” or “also hide X” — the same mod is updated. **Revert to previous** from the Mod detail view if a refinement breaks something.
- **Conversation goal:** Optional “Set goal” (e.g. “Hide suggested posts on Instagram”); the AI keeps context until you clear it or say “done.”
- **Did this work?** After Apply & Save you get Yes/No; **No** sends a re-investigate message so the agent can suggest a different mod.
- **DevTools:** If you have DevTools open and select an element in the Elements panel, Mod can use that **$0** as context. For `find_elements_containing_text`, when DevTools is open the search runs in the page for accurate minimal-node results.
- **Panic:** **Ctrl+Shift+M** disables all mods for the current site and reloads.

---

## Requirements

- **Chrome 114+** (Manifest V3, Side Panel API). Chrome only; Firefox/Edge not tested.
- **Host permission:** Mod requests `<all_urls>` so it can inject and re-apply mods. It does not send page content off-device except to Claude when you use chat (your API key). A future version may use optional host permissions per site.

---

## Setup

1. Open **Chrome** → `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select this repo folder.
4. Click the Mod icon to open the side panel. Go to **Settings** and add your **Claude API key** (stored locally; used only for `api.anthropic.com`).

No build step. No npm. Clone and load.

---

## Usage

1. Open a **website** (http/https), then open Mod from the toolbar.
2. **Option A — Select:** Click **Select**, click an element on the page, then describe the change in chat.
3. **Option B — Describe:** Type what you want (“hide the cookie banner”, “hide Sponsored posts”). The AI uses page context and tools to suggest a mod.
4. When the AI returns a mod: **Apply & Save** (persist for this site), **Preview** (try without saving), or **Reject**.
5. After saving, you can **refine** in chat (“make it bigger”) or open **Mods** → select a mod → **Revert to previous** if the last refinement broke something.
6. **Mods** tab: list, toggle, delete, **Share** (copy link). Others paste the link under **Import a shared mod** and click **Add to this site**.
7. **Mods on / off** toggle: turn off to see the page without mods; turn back on to re-apply (no refresh).
8. **Panic:** Ctrl+Shift+M if a mod breaks the page.

---

## What Mod can do (feature set)

| Feature | Description |
|--------|-------------|
| **CSS mods** | Injected CSS with `!important` (colors, fonts, spacing, etc.). |
| **Hide by selector** | `display: none !important` on elements matching a CSS selector. |
| **Hide by text** | For dynamic feeds (Instagram, Twitter, etc.): find nodes containing text (e.g. “Sponsored”, “Ad”) and hide an ancestor (the post/card). Type `dom-hide-contains-text`; uses `find_elements_containing_text` and optional `simulate_mod_effect`. |
| **Agent tools** | `get_page_summary`, `get_structure`, `search_components`, `detect_framework`, `get_component_summary`, `get_element_info`, `find_elements_containing_text`, `simulate_mod_effect`. |
| **Revert** | In Mod detail, **Revert to previous** restores the version before the last refinement (snapshots stored on each update). |
| **Goal** | Set a conversation goal; cleared when you say “done”/“that’s good” or click Clear goal. |
| **DevTools $0** | When DevTools is open for the tab, the selected element is sent as context; `find_elements_containing_text` runs in-page when DevTools is connected. |

**Not supported:** JavaScript mods (MV3 limits). CSS and hide-only.

---

## Mods and site changes

Mods are stored **per hostname** and applied by selectors. Site redesigns or changed class names can make a mod stop matching or match too much. There’s no auto-fix; add a new mod or refine. If a selector matches many elements, Mod may ask for confirmation before applying.

---

## File layout

| File | Role |
|------|------|
| `manifest.json` | Permissions, side panel, devtools page, content script, icons. |
| `background.js` | Service worker: message routing, Claude API, storage (mods, settings, last applied, revert), PostHog. |
| `content.js` | Injected in tabs: apply saved mods, element selector, page context & agent tools, apply/remove mods, panic. |
| `sidepanel.html` / `sidepanel.js` / `sidepanel.css` | Side panel: chat, mod list, settings, goal, “Did this work?”, agent loop. |
| `devtools.html` / `devtools.js` | DevTools page: `find_elements_containing_text` in page, $0 context. |
| `icons/` | Extension icons (16, 48, 128 px). |

---

## Storage

- **Mods:** `chrome.storage.local` → `mods:{hostname}` (array of mods; each can have `revisions` with snapshots for revert).
- **Settings:** `settings` → `{ apiKey, modsEnabled }`.
- **Last applied mod:** `lastAppliedMod_{hostname}` (for refinements).
- **Conversation goal:** `conversationGoal_{hostname}`.

---

## PostHog analytics

Events are sent to PostHog (see `background.js` → `POSTHOG_API_KEY`). If the key is empty, capture is skipped.

**Common properties:** Every event includes `extension_version`, `product: mod`, and `hostname` when the side panel knows the active site.

**Panel & navigation:** `side_panel_opened` (initial view, API key presence), `view_changed` (chat | mods | settings), `active_tab_changed` (browser tab / navigation context), `mods_globally_toggled` (master Mods on/off).

**Chat & agent:** `message_sent` (length, goal, refinement, element context, failure hints), `conversation_turn_completed` (trace id, end reason, AI rounds, distinct tools used, whether a mod card was offered), `agent_tool_executed` (per tool, success, phase, round), `agent_tools_batch` / `agent_tools_used` (batch summary), `$ai_generation` (model, tokens, latency, errors — includes message payloads).

**Mod proposal funnel:** `mod_card_shown`, `mod_verify_attempt`, `mod_verify_finished`, `mod_previewed` / `mod_preview_failed`, `mod_rejected`, `apply_and_save`, `apply_failed`, `apply_cancelled_wide_selector`, `did_this_work_yes` / `did_this_work_no`.

**Mods list & share:** `mod_saved` (incl. `save_source`: apply/import/refinement), `mod_deleted`, `mod_toggled` (incl. `source`, e.g. `mods_list`), `mod_reverted`, `mods_disabled_all`, `mod_shared`, `mod_imported` (`source: import_paste`).

**Other:** `goal_set` / `goal_cleared`, `refinement_started` / `refinement_auto_applied`, `selector_activated`, `element_selected`, `selector_cancelled`, `settings_saved`, `mod_preview_stopped`, `extension_installed`.

---

## Developer notes

- **Content script logs:** DevTools on the **web page** → Console → filter by `[Mod]`.
- **Background logs:** `chrome://extensions` → Mod → **Service worker** → console, prefix `[Mod BG]`.
- **Disable analytics:** Clear or omit `POSTHOG_API_KEY` in `background.js`.

---

## License

Use and modify as you like. No warranty.
