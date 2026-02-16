# Mod — AI that sees and modifies any website, persistently

A Chrome extension that lets you point at elements or describe changes in chat. The AI generates CSS or “hide element” modifications; they run immediately and re-apply on every future visit.

**One-sentence test:** Install Mod, click that annoying banner on a site, tell it to hide it forever, and it’s gone on every page load.

---

## Requirements

- **Chrome 114 or later** (Manifest V3; Side Panel API).
- **Chrome only.** Firefox uses a different sidebar model; Edge may work but is not tested.
- **Host permission:** The extension requests access to all sites (`<all_urls>`). Chrome will show “Read and change all your data on all websites.” Mod needs this to inject and re-apply your modifications. It does not send page data anywhere except when you explicitly ask the AI to analyze an element (to Claude via your API key). A future version may use **optional host permissions** and request access per site on first use.

---

## Installation (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`Tinker`).
4. Ensure no errors are shown. Click the extension icon to open the side panel.
5. In **Settings**, add your Claude API key. Your key is stored locally and only used for requests to `api.anthropic.com`.

---

## Usage

1. Open any website, then open Mod from the toolbar (side panel).
2. **Select an element:** Click **Select**, then click an element on the page. Describe what you want (e.g. “hide this forever”, “make this text bigger”).
3. **Or describe without selecting:** Type what you want (e.g. “hide the cookie banner”) and send. The AI uses lightweight page context (headings, buttons, banners) to suggest a mod.
4. When the AI returns a modification, use **Apply & Save** to apply it and persist it for this site, or **Preview** to try it without saving. Refresh the page to see saved mods re-apply.
5. Use **Mods** to see, toggle, or delete saved mods for the current site.
6. **Panic button:** If a mod breaks the page, press **Ctrl+Shift+M** to disable all mods for the current site and reload.

7. **Preview with/without mods:** Use the **Mods on / Mods off** toggle in the side panel. When **Mods off**, the page is shown without any saved mods (no refresh). Toggle back to **Mods on** to re-apply. Helps verify that mods are applied correctly.

---

## What Mod can do (MVP)

- **CSS mods** — Change styles (colors, fonts, spacing, etc.) via injected CSS with `!important`.
- **Hide elements** — Hide elements by selector (e.g. banners, sidebars). Uses `display: none !important`.

**Not supported in this version:**

- **JavaScript mods** — Running custom JS in the page is not supported (Chrome MV3 content script restrictions). Use CSS or “hide element” instead.

---

## Mods and site changes

Mods are stored **per hostname** and applied by **CSS selectors**. If a site changes its layout or class names (common on React/Vue/Angular and after redesigns), a mod may **stop matching** and no longer apply. There is no automatic fix; you can add a new mod or re-select the element in a future version. Mods may also match more than intended (e.g. many elements); if a selector matches more than 10 elements, Mod will ask you to confirm before applying.

---

## Optional host permissions (future)

To reduce the broad “access all sites” warning, a future version can use **optional host permissions**: request access only when the user first uses Mod on a given site. This adds some UX and implementation complexity and is out of scope for the current MVP.

---

## PostHog analytics

The extension sends events to PostHog via the [Capture API](https://posthog.com/docs/api/capture) for product and LLM analytics.

- **Distinct ID:** A UUID is generated on first run and stored in `chrome.storage.local` under `posthog_distinct_id` (one per install).
- **API key:** Set in `background.js` as `POSTHOG_API_KEY`. To disable analytics, remove or comment out the `posthogCapture` calls, or set the key to an empty string and add a guard at the start of `posthogCapture`.
- **Events captured:**
  - `extension_installed` — once per install (version).
  - `side_panel_opened` — when the side panel loads (hostname).
  - `message_sent` — when the user sends a chat message (has_element_context, hostname).
  - `$ai_generation` — each Claude call: model, provider, input/output messages, token counts, latency, errors (per [PostHog LLM docs](https://posthog.com/docs/llm-analytics/manual-capture)).
  - `selector_activated` — user clicked Select (hostname).
  - `element_selected` — user selected an element (hostname, tag).
  - `selector_cancelled` — user cancelled with Escape.
  - `mod_saved` — mod saved for a host (hostname, mod_type, mod_description).
  - `mod_deleted` — mod deleted (hostname).
  - `mod_toggled` — mod enabled/disabled (hostname, enabled).
  - `mods_disabled_all` — panic used (hostname, mod_count).
  - `settings_saved` — API key saved (field only, no value).

---

## Developer logging

- **Page (content script):** Open DevTools on the **web page** (F12 or right‑click → Inspect → Console). All Mod actions are logged with the `[Mod]` prefix so you can filter by “Mod”. You’ll see: content script load, how many mods are applied and for which hostname, each mod applied/failed, REFRESH_MODS_STATE (toggle), APPLY_MOD / REMOVE_MOD, selector warnings, and panic (Ctrl+Shift+M).
- **Background:** In `chrome://extensions`, click “Service worker” under the Mod extension to open the background console. Logs are prefixed with `[Mod BG]` (e.g. when a mod is saved, or all mods disabled for a host).

Use these logs to confirm mods are loading, when they’re applied, and where something fails.

---

## File layout

- `manifest.json` — Permissions, content script, side panel, background worker.
- `background.js` — Service worker: message routing, Claude API, storage (save/delete/toggle mods, disable all for host).
- `content.js` — Runs in each tab: apply saved mods on load, element selector, context extraction, apply/remove mods, panic shortcut (Ctrl+Shift+M), selector match-count check.
- `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — Side panel UI: chat, mod list, settings, Apply/Preview using mod keys (no raw JSON in attributes).
- `icons/` — Extension icons (16, 48, 128 px).

---

## Storage

- **Mods:** `chrome.storage.local` under keys `mods:{hostname}`, value: array of `{ id, type, description, selector, code, enabled, createdAt }`. Types: `css`, `dom-hide`.
- **Settings:** key `settings`, value `{ apiKey }`.

---

## License

Use and modify as you like. No warranty.
