# Plan: Cursor-style agent — vibe, debug, test, and user as final arbiter

Mod is for **everyone**, not just developers. Use cases range from hiding posts and decluttering (YouTube, Instagram) to styling (e.g. retro Google Calendar) to moving or rearranging UI (search bar, panels). The agent should feel like Cursor’s: **iterate confidently**, **test and debug** when something doesn’t work, and **use the user’s eyes** as the final check. This plan describes how to get there.

**Mod as project:** A mod is something you create and **refine until it’s done**—a finished, usable thing that “just works” so you don’t need to edit it unless you want to. We’re not aiming to suggest a huge number of mods; we’re aiming to get one (or a few) to a state that’s good enough. When the user’s request could mean either “add a new mod” or “change the existing mod,” the agent should **ask or clarify**: e.g. “Would you like this as a new mod, or should I edit the existing one?”

---

## 1. How Cursor behaves (and what we want to mirror)

- **Vibe / iterate:** Try an edit, see what happens, adjust. Not “one shot and hope.”
- **Debug & hypothesize:** When something fails, the agent has tools to investigate (linter, tests, browser). It forms a hypothesis and tests it.
- **Test before handoff:** Lint and tests run automatically; the agent sees pass/fail and iterates until green (or hits a cap). The user gets a result that’s already been machine-verified where possible.
- **User has real eyes:** For frontend, Cursor can use a browser tool to screenshot or interact, but the **user** is still the authority on “does this look right?” So the agent can **ask** the user what they see and use that to continue or debug.

Mod’s equivalent:

- **Vibe / iterate:** Propose a mod (CSS, hide, etc.) → get machine feedback (did it match? how many?) and optionally user feedback (“I see it” / “I don’t” / “it hid too much”) → adjust and try again.
- **Debug & hypothesize:** When a mod doesn’t work or the user says “that’s wrong,” the agent uses tools (find_elements, inspect_element, get_structure, check_selector, verify_mod, console/network) to form a hypothesis (e.g. “wrong ancestor level,” “selector too broad”) and proposes a new mod to test.
- **Test before handoff:** For hide-type mods, run an automatic verify step (match count, visibility). Only show the mod card when verification passes or after a capped number of retries. For CSS, we have fewer machine signals (parse, maybe console errors); user preview and confirmation stay central.
- **User as final arbiter:** The agent should **proactively ask** the user when it matters: “Can you see the change applied? (Try toggling Preview off and on to compare.)” or “What do you see now—did the right things disappear?” If the user confirms, the agent can move on or refine. If they deny or add details (“it hid everything” / “the search bar didn’t move”), the agent treats that as a failure signal and **investigates** (tools + hypothesis) then proposes again. So the loop is: propose → machine verify (where possible) → show to user → **ask user** → use answer to continue or debug.

---

## 2. Goals (non-developer friendly)

- **Mod as project — refine until it just works:** Prefer getting the current mod to a finished, usable state over suggesting many new mods. The ideal outcome is “I don’t need to edit this anymore unless I want to.”
- **Easier to see what’s working and what isn’t:** The UI should make it obvious when a mod is “verified” by the machine (e.g. “This will hide 3 elements”) vs “needs your eyes” (e.g. “Preview and tell me if it looks right”). Avoid jargon; use plain language (“Applied”, “Preview on”, “Checking…”, “Does this look right?”).
- **Agent reliably gets to a working end state:** The agent should (1) understand the ask, (2) propose edits (or refinements to the existing mod), (3) see if they work (machine verify + optional user check), (4) monitor and investigate when they don’t, and (5) iterate until the user confirms or we hit a reasonable cap. So: **understand → propose → verify → ask user when needed → if deny/detail, investigate and repeat.**
- **User is the only one with real eyes:** The agent must be able to **ask** the user what they see and whether the change applied, and to **use** that answer. Prompts and flows should encourage: “Preview is on—do you see the change? If not, describe what you see.” and “If something looks wrong (e.g. too much hidden), tell me and I’ll narrow it down.”
- **New mod vs edit existing:** When the user’s request could be satisfied either by a **new mod** or by **editing the existing mod**, the agent should ask or clarify (e.g. “Would you like this as a new mod, or should I edit the existing one?”) so we don’t end up with a pile of mods when the user really wanted one refined mod.

---

## 3. Concrete behaviour changes

### 3.1 Machine verification (like Cursor’s lint)

- **Single entry point (Option B from original plan):** Reuse existing `verify_mod` in the content script; no new message type. Unify in the sidepanel: **any time** we are about to call `addModMessage(mod)`—whether the mod came from a `propose_mod` tool round or from parsing the first `\`\`\`json` block—we first run the verify loop. Only after the loop exits (pass or cap) do we add the final assistant message and the mod card. So both paths (tool round with proposed mod, or agent output with json block only) go through the same “propose → verify before show” flow.
- **When:** Every time we have a candidate **dom-hide** or **dom-hide-contains-text** mod, run verify (apply temp, measure match count and visibility, remove temp) before showing the card. **CSS** mods: skip the internal retry loop and show the card as today; optional: run CSS parse in content script and show a warning on the card if invalid.
- **Pass/fail and signals:**
  - **Pass rule:** `verification_passed = (matchCount > 0 && visibleCount > 0)` for dom-hide and dom-hide-contains-text. For CSS we don’t have match counts; skip internal retry (v1).
  - **Fail cases that trigger retry:**  
    - `matchCount === 0` or `visibleCount === 0` → `reason: 'zero_matches'`, message e.g. “0 elements matched; re-investigate and propose again.”  
    - `matchCount > VERIFY_TOO_MANY_THRESHOLD` (e.g. 30) → `reason: 'too_many_matches'`, message e.g. “Too many elements matched; narrow the selector or text.”
  - **Return shape (content script):** Extend verify response with `verification_passed` (boolean), optional `reason` (`'zero_matches' | 'too_many_matches'`), and a short `message` so the agent gets a clear signal.
- **Internal retry (invisible to user):** If verification fails, do **not** add any assistant or user messages for that retry round to the **visible** chat. Only append to `conversationHistory` (e.g. a synthetic user message like `[VERIFY_FAILED] 0 elements matched. Re-investigate (e.g. run find_elements again) and propose a new mod.`). Re-invoke the agent; when the next response arrives, get the new candidate mod (from propose_mod or first json block) and run the verify loop again. Cap at 3 attempts. When we eventually **pass** or **hit the cap**, add only the **final** assistant message (the one that contained the mod we’re showing) and the mod card. So the user only ever sees: [their message] [final assistant reply] [mod card] (and optionally one system message if we hit the cap: “Verification didn’t pass after 3 attempts; you can still try Apply & Save.”).
- **Edge case — refinement:** If the candidate mod is an update to an existing mod (same mod id as last applied), still run verify and the loop for consistency.
- **Result:** The user tends to see a mod that’s already been machine-checked for “does it target something?” Machine verification handles 0 matches / too many **internally**; we do **not** ask the user “Did this work?” for those failures—they’re handled by the retry loop. “Did this work?” / asking the user is for **after** we show the card: “does it look right to you?” (user as final arbiter for visual outcome).

### 3.2 User as final arbiter — ask and use the answer

- **After showing a mod (or after Apply & Save):** The agent should often **ask** the user something like: “Preview is on—can you see the change? If not, tell me what you see.” or “After saving, do the right elements stay hidden / does the style look right? If something’s off, describe it and I’ll adjust.”
- **System prompt:** Instruct the agent to (1) use machine verification where it exists, (2) when handing off to the user (preview or after save), **ask** the user to confirm what they see or to describe what’s wrong, and (3) if the user says it didn’t work or gives details (“that hid everything,” “the search bar didn’t move”), **treat that as a failure**: run tools (find_elements, inspect_element, check_selector, etc.), form a hypothesis, and propose a new or refined mod. So the agent doesn’t just say “hope that worked”—it **asks** and **iterates on the answer**.
- **Conversation flow:** User says “hide suggested posts” → agent proposes mod → we run verify (internal loop if needed) → we show mod card and assistant message → assistant message includes a short “Can you see the change with Preview? Tell me if it looks right or what’s wrong.” → User says “yes” / “no” / “it hid too much” → agent continues (done or investigate + new mod).

### 3.3 Intuitive “what’s working / what isn’t”

- **Mod card and preview:** Keep and reinforce “Changes made” and “View actual code” so the user can see what the mod does. Preview on/off should be obvious (e.g. “Preview on” vs “Preview” and a clear “Stop preview” when active).
- **Verification state:** Where we have machine verification, show a simple, non-jargony line on or near the card when relevant, e.g. “This will hide 3 elements” (verified) or “We couldn’t check how many elements this matches; try Preview to see” (e.g. after cap or for CSS). Avoid “matchCount” or “visibleCount” in the UI; use plain language.
- **Agent messages:** Encourage the agent to summarize in one line what it did and what the user should see (e.g. “I hid every post that contains ‘Suggested for you’. You should see those posts disappear. Can you confirm with Preview?”). So the user knows what “working” looks like and what to report back.

### 3.4 Reliable understand → propose → verify → ask → investigate

- **Understand:** Good intent and world-state context (existing mods, last applied mod, page context, optional DevTools $0). Optional conversation goal so the agent knows the high-level ask.
- **Propose:** One mod per turn; use find_elements (or equivalent) before dom-hide-contains-text so the proposal is grounded. Prefer **refining the existing mod** when the user’s follow-up clearly applies to it (e.g. “make it bigger,” “also hide X”).
- **Verify:** Automatic verify for hide-type mods before showing the card; internal retry with clear failure reasons (0 matches, too many).
- **Ask:** After showing a mod (or after save), agent asks the user what they see or if the change applied and how to see it (e.g. “Toggle Preview off and on to compare.”).
- **Investigate:** If the user denies or gives details, the agent runs tools again (find_elements, inspect_element, check_selector, get_console_errors, etc.), forms a hypothesis (“selector too broad,” “wrong ancestor level”), and proposes again. This is the “debug” loop, driven by user feedback.

### 3.5 New mod vs edit existing

- **When to clarify:** If the user’s message could reasonably mean “add a new, separate mod” or “change the mod we’ve been working on,” the agent should **ask** before acting: e.g. “Would you like this as a new mod, or should I edit the existing one?”
- **System prompt:** Instruct the agent to (1) prefer editing the existing mod when the request clearly extends or refines it, (2) when it’s ambiguous (e.g. “hide the sidebar too” could be same mod or new mod), ask the user, and (3) avoid suggesting many separate mods when one refined mod would achieve the same goal.
- **Outcome:** Fewer, more “finished” mods; the user stays in control of whether something is one mod or multiple.

---

## 4. What we don’t change (for this plan)

- **One mod per turn** in the UI (one card per proposal). We add “new vs edit existing” clarification so the agent doesn’t pile up mods when the user wants one refined mod.
- **Preview / Apply & Save / Reject** and the existing mod card UX; we add clearer copy and optional “verified” / “couldn’t verify” hints.
- **Wide use cases:** Hiding, styling, decluttering, moving—all in scope; the agent and prompts stay general, with “hide posts” and “restyle Calendar” as examples, not the only cases.

---

## 5. Files to touch

- **Verify pass/fail and reason — [content.js](content.js):** Extend verify_mod (or its response shape) to include `verification_passed`, optional `reason` (`'zero_matches'` or `'too_many_matches'`), and enforce a too-many threshold (e.g. 30).
- **Internal loop and entry points — [sidepanel.js](sidepanel.js):** Extract “get candidate mod from this response” (from propose_mod tool or first json block). Before any `addModMessage`, for dom-hide/dom-hide-contains-text: run verify loop (verify → if fail, push synthetic message to conversationHistory, re-invoke agent, get new response, get new candidate, repeat; cap 3). Only add final assistant message and mod card when loop exits. Do not add intermediate agent/user messages to the visible UI. Wire the loop to **both** entry points (propose_mod in tools and json block).
- **CSS mods — [sidepanel.js](sidepanel.js):** For css mods, skip the verify loop and show the card as today. Optional: call content to parse CSS and show a warning on the card if invalid.
- **Prompt and cap message — [sidepanel.js](sidepanel.js):** Add 2–3 sentences: verification is automatic; on failure the agent receives VERIFY_FAILED and should re-propose; user sees the card only after pass or 3 attempts. Add system message when cap hit: “Verification didn’t pass after 3 attempts; you can still try Apply & Save.” Also add: mod-as-project (refine until it just works); when “new mod” vs “edit existing” is ambiguous, ask the user; prefer refining the existing mod over creating many new mods.

---

## 6. Implementation order

1. **content.js:** Add `verification_passed` (and optional `reason`) to the verify_mod return value; add too-many threshold (e.g. 30) and set `reason` to `'too_many_matches'` when matchCount > threshold.
2. **sidepanel.js:** Implement the verify-before-show loop: a helper that takes a candidate mod, runs verify (via existing SEND_TO_CONTENT + verify_mod), returns pass/fail and reason; a loop that on fail pushes synthetic user message to conversationHistory and re-invokes the agent (without adding to visible UI), max 3 times; only then add the final assistant message and `addModMessage`.
3. **sidepanel.js:** Wire the loop to both entry points (propose_mod in tools and json block); ensure we don’t add tool-result messages or assistant messages for retry rounds to the visible chat.
4. **sidepanel.js:** System prompt update and cap message (“Verification didn’t pass after 3 attempts…”).
5. **Prompt: ask user and use answer; new mod vs edit:** In the same system prompt, add that when handing off to the user (preview or after save), the agent should ask what they see or if the change applied; if the user denies or gives details, investigate with tools and propose again. Add mod-as-project and new-mod-vs-edit: prefer refining the existing mod; when ambiguous, ask “Would you like this as a new mod or to edit the existing one?”
6. **UI copy:** Add short, non-jargony verification hints where relevant (“This will hide N elements” / “We couldn’t check; try Preview”).
7. **Optional:** CSS parse in content script and warning on card for invalid CSS. After Apply & Save, surface “Did this work?” or “What do you see?” so the agent gets explicit feedback.

---

## 7. Summary

- **Mod as project:** A mod is something you create and refine until it “just works”—usable without more editing unless you want to. Prefer finishing one mod over suggesting many; when it’s ambiguous, the agent asks: “New mod or edit the existing one?”
- **Cursor-like:** Vibe (iterate), debug (investigate when something fails), test (machine verify before handoff where possible). User has real eyes, so the agent **asks** what they see and **uses** the answer to continue or debug.
- **For everyone:** Plain language, intuitive “what’s working / what isn’t,” and a clear path: propose → verify (machine) → show → ask user → if no/detail, investigate and propose again.
- **End state:** The agent reliably reaches a working result by combining machine verification (for hide-type mods) and user confirmation (for all mods), by treating user feedback as the signal to investigate and iterate, and by clarifying new-mod vs edit-existing so we don’t end up with a pile of mods when one refined mod would do.
