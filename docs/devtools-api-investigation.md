# DevTools API investigation: what we use and what would help the agent

## What we already use

| API / feature | Where | Purpose |
|---------------|--------|---------|
| **devtools_page** | manifest.json | Loads devtools.html (and devtools.js) when user opens DevTools for any tab. |
| **chrome.devtools.inspectedWindow.tabId** | devtools.js | Sent to background so we know which tab the DevTools panel is attached to. |
| **chrome.devtools.inspectedWindow.eval()** | devtools.js | Runs code in the **page context** (main frame). We use it for: (1) **$0** – read the currently selected element in the Elements panel (tagName, textContent slice, simple selector); (2) **find_elements_containing_text** – when DevTools is open, we delegate this tool to eval so the search runs in the real page DOM (including shadow DOM, accurate minimal nodes). |
| **Background ↔ DevTools port** | background.js, devtools.js | `mod-devtools` port: panel registers by tabId; background sends GET_SELECTED_ELEMENT and RUN_AGENT_TOOL_IN_PAGE (find_elements) and gets results back. |
| **$0 in world_state** | sidepanel.js | When building the user message, we call GET_DEVTOOLS_SELECTED_ELEMENT; if DevTools is open we get tagName, textContent, selector and inject `<devtools_element .../>` so the agent knows what the user has selected. |

So today: **inspectedWindow.eval** (with $0 and find_elements in page) and **tabId + port** for routing. We do **not** yet use: devtools.panels (custom panels/sidebars), devtools.network, or inspectedWindow.getResources / resource content.

---

## Chrome DevTools extension APIs (summary)

All require `"devtools_page"` in the manifest (we have it).

### 1. chrome.devtools.inspectedWindow

- **tabId** – Tab being inspected (we use this).
- **eval(expression, options?, callback?)** – Run JS in the inspected page. Can use **$0** and full page JS state. Options: `frameURL`, `contextSecurityOrigin`, `useContentScriptContext` (run in our content script context). We use this for $0 and find_elements.
- **reload(reloadOptions?)** – Reload the page. Options: `ignoreCache`, `injectedScript` (run before any frame script on load), `userAgent` override.
- **getResources(callback)** – List of resources (documents, stylesheets, scripts, images, etc.) in the page. Each resource has **url**, **getContent(callback)**, **setContent(content, commit, callback?)**.
- **onResourceAdded** – New resource added to the page.
- **onResourceContentCommitted** – Resource content was changed (e.g. user saved in DevTools).

### 2. chrome.devtools.network

- **getHAR(callback)** – Full HAR log of requests **shown in the Network panel**. If DevTools was opened after load, some requests may be missing; reload to capture all.
- **onRequestFinished.addListener(callback)** – Each finished request; request has HAR-like data and **getContent()** for response body.
- **onNavigated.addListener(callback)** – Inspected window navigated to a new URL.

### 3. chrome.devtools.panels

- **create(title, iconPath, pagePath, callback?)** – Add a custom panel (tab) to DevTools (e.g. “Mod” panel).
- **panels.elements** – Elements panel object.
  - **createSidebarPane(title, callback?)** – Add a sidebar to the Elements panel (e.g. “Mod” sidebar). Pane can **setPage(path)**, **setExpression(expression, rootTitle?, callback?)**, **setObject(jsonObject, rootTitle?)**, **setHeight(height)**.
  - **onSelectionChanged** – Fired when the user selects another element in the Elements panel ($0 changed).
- **panels.sources** – Sources panel; **createSidebarPane**, **onSelectionChanged**.
- **setOpenResourceHandler(callback?)** – Called when user clicks a resource link in DevTools (resource + line).
- **openResource(url, lineNumber, columnNumber?, callback?)** – Open a resource in DevTools at a given line.
- **themeName** – `"default"` or `"dark"`.
- **setThemeChangeHandler(callback?)** – When DevTools theme changes.

---

## What would be “super useful” for the agent

### High value

1. **Elements panel selection change (panels.elements.onSelectionChanged)**  
   - **Idea:** When the user selects a different node in the Elements panel, we could push that to the side panel (e.g. refresh GET_DEVTOOLS_SELECTED_ELEMENT or auto-include in the next message). Right now we only read $0 when we build the message; we don’t react to selection changes.  
   - **Use for agent:** Fresher “current selection” context without the user having to send a new message. Optional: show a small “Selected in DevTools: &lt;tag&gt; …” in the side panel so the user and agent both see what $0 is.

2. **devtools.network when DevTools is open**  
   - **Idea:** We already have **get_recent_network_errors** via **webRequest** (4xx/5xx in last 30s). When DevTools is open we could **additionally** use **devtools.network.getHAR()** or **onRequestFinished** to give the agent: full list of requests, status codes, timing, and optionally response bodies (getContent) for failed or XHR/fetch.  
   - **Use for agent:** Richer “what failed or slowed after my mod?” context (e.g. which API call returned 500, or which script failed to load). Downside: only available when DevTools is open; HAR can be large. So: optional tool like **get_network_har** (when DevTools open) or merge 4xx/5xx from HAR into **get_recent_network_errors** when available.

3. **More page-context tools via inspectedWindow.eval**  
   - **Idea:** Any tool that needs **real page JS state** or **shadow DOM / full DOM** we can run via the DevTools port with **inspectedWindow.eval** (like we do for find_elements_containing_text).  
   - **Use for agent:** e.g. “get_computed_styles(selector)”, “get bounding rect”, or “list all stylesheets/links in the page” could be evaled in page when DevTools is open for accuracy. We already do this for find_elements; extending the pattern to 1–2 more tools could help.

### Medium value (optional / polish)

4. **Custom Elements sidebar (createSidebarPane)**  
   - **Idea:** Add a “Mod” sidebar in the Elements panel that shows, for the selected node ($0): e.g. “Suggested hide level”, “Matches selector X”, or “Mods affecting this element”.  
   - **Use for agent:** More for the **user** (visual feedback); the agent could benefit indirectly if we surface “mods affecting $0” or “suggested ancestor level for $0” there and optionally include that in context.

5. **inspectedWindow.getResources()**  
   - **Idea:** List documents, stylesheets, scripts. We could offer a tool like **get_page_resources** (when DevTools open) returning URLs and maybe content for CSS/HTML.  
   - **Use for agent:** Understand “what stylesheets/scripts are on the page” without scraping the DOM. Useful for “why isn’t my CSS applying?” or “what’s loading.” Caveat: only when DevTools is open; and we don’t want to pull huge response bodies by default.

6. **Reload with options (inspectedWindow.reload)**  
   - **Idea:** Agent (or user) could request “reload and bypass cache” or “reload with this script injected before any page script.”  
   - **Use for agent:** Rare; mostly for debugging (“reload without cache to see if mod still works”). Could be a niche tool or a side-panel button rather than an agent tool.

### Lower priority

7. **Custom DevTools panel (panels.create)**  
   - Full “Mod” tab in DevTools: could duplicate or mirror side-panel flows (e.g. “Mods for this page”, “Apply/Preview”). Not strictly necessary for the agent if the main UX is the side panel; only if we want Mod to live inside DevTools as well.

8. **Sources panel sidebar**  
   - Similar to Elements sidebar but for Sources. Less directly relevant to “modify UI” unless we add “edit and persist CSS/JS” flows later.

---

## Making DevTools more “accessible/usable by AI” (optional)

- **Expose “DevTools open?” and “$0” in every agent turn:** We already send `<devtools_element>` when we have it. We could add a short line in world_state: “DevTools attached: yes/no; $0: [summary or none]” so the agent always knows whether page-context tools (find_elements via eval, future get_network_har) are available.
- **Tool availability in system prompt:** e.g. “When DevTools is open for the current tab, find_elements_containing_text runs in the page context for accurate minimal nodes and shadow DOM; when DevTools is closed, it runs in the content script (still works but may differ on complex pages).”
- **Optional tools gated on DevTools:** e.g. “get_network_har: Returns HAR for the current page (only when DevTools is open). Use to see failed or slow requests after a mod.” Implement by having the background check devtoolsPortByTabId[tabId]; if present, send a message to DevTools to call getHAR and return a summarized list (e.g. url, status, method, time) or full HAR for the agent.
- **Elements.onSelectionChanged:** Subscribe in devtools.js and push $0 updates to the background/side panel (e.g. “selected element changed”) so the side panel can refresh and include the latest $0 in the next message without extra user action.

---

## Recommendation (short)

- **Already in good shape:** inspectedWindow.eval for $0 and find_elements in page; port-based routing; $0 in world_state.
- **Highest-impact additions for the agent:**  
  1. **Elements.onSelectionChanged** – keep $0 context in sync when the user changes selection.  
  2. **devtools.network** – when DevTools is open, optionally augment **get_recent_network_errors** with HAR-based 4xx/5xx (and optionally a small “get_network_summary” tool).  
  3. **Document in the system prompt** that when DevTools is open, find_elements runs in page context and $0 is available.
- **Optional:** getResources-based **get_page_resources** (URLs + optional CSS/HTML content), and a small “Mod” Elements sidebar for user/agent feedback on $0 (e.g. suggested hide level, which mods affect it).

This keeps the extension non-malicious, uses only standard DevTools extension APIs, and makes the agent more aware of DevTools state and network/page resources when available.
