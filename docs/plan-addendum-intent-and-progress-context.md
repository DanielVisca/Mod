# Plan addendum: Intent context + progress-toward-intent context

## Goal

Ensure the agent always has **both**:

1. **Intent context** — What the user wants (the target).
2. **Current state of building toward that intent** — Where we are in the process of achieving it, so we never lose track of the goal.

This keeps the agent aligned with the user’s intent and aware of what’s already been tried and what step we’re on.

---

## Three-context structure in the user message

Structure the first user message each turn with **three** clearly separated blocks:

### 1. Intent context (what we’re working toward)

- **`<user_message>`** — The user’s raw request (e.g. “Hide suggested posts”).
- **`<conversation_goal>`** — Optional persisted goal for this site (e.g. “Clean up Instagram feed”).
- **`<user_feedback>`** — If the user said the last mod didn’t work (e.g. “That hid everything” or “Still not working”).

**Purpose:** Single source of truth for “what we are trying to achieve.” The agent should treat this as immutable for the turn.

### 2. World state (current state of the page and site)

- **`<page_context>`** — URL, hostname, title, framework, landmarks, structure (from GET_PAGE_CONTEXT / get_page_overview).
- **`<existing_mods>`** — Mods already saved on this site.
- **`<last_applied_mod>`** — Last applied mod (for refinements).
- **`<devtools_element>`** — Optional $0 from DevTools.

**Purpose:** What the page and site look like *right now* — the world the agent is acting on.

### 3. Progress toward intent (building state)

- **`<progress_toward_goal>`** or **`<current_build_state>`** — Explicit “where we are” in satisfying the intent, e.g.:
  - **Goal this turn:** One-line restatement of the intent (e.g. “Hide elements containing ‘Suggested for you’ without breaking the feed”).
  - **Steps taken this turn:** Tools run and their outcomes (e.g. “find_elements(‘Suggested for you’) → 12 minimal nodes; suggestedHideAncestorLevel 2”).
  - **Last proposal (if any):** Type, selector/params, and **verify result** (e.g. “proposed dom-hide-contains-text; verify_mod → 0 matches”).
  - **Retry state:** e.g. “Attempt 2 of 3 (previous attempt: 0 matches).”
  - **What we’ve learned:** Short bullets (e.g. “Container is main; text is present; first try used wrong hideAncestorLevel”).

**Purpose:** So the agent always sees “We want X. So far we did Y. Verify said Z. We’re on attempt N. So next we should …” and stays on track.

---

## Example combined user message (one turn)

```xml
<intent>
  <conversation_goal>Clean up Instagram feed</conversation_goal>
  <user_message>Hide the "Suggested for you" section</user_message>
  <user_feedback>None</user_feedback>
</intent>

<world_state>
  <page_context>
    <url>https://www.instagram.com/</url>
    <hostname>instagram.com</hostname>
    <framework>React</framework>
    <landmarks>main=main, header=header</landmarks>
  </page_context>
  <existing_mods>mod_1: Hide sponsored (dom-hide-contains-text)</existing_mods>
  <last_applied_mod>None</last_applied_mod>
</world_state>

<progress_toward_goal>
  <goal_this_turn>Hide elements containing "Suggested for you" and their card ancestor.</goal_this_turn>
  <steps_taken>
    - get_page_overview: React, main present.
    - find_elements(text="Suggested for you", container=main): 8 minimal nodes, suggestedHideAncestorLevel 2.
    - propose_mod: dom-hide-contains-text, text="Suggested for you", hideAncestorLevel 2.
    - verify_mod: 0 visible matches (selector may be wrong or content not in DOM yet).
  </steps_taken>
  <retry>Attempt 2 of 3</retry>
  <learned>Text exists in find_elements; verify saw 0 — try same params with containerSelector or re-run find_elements after scroll.</learned>
</progress_toward_goal>
```

On the **first** message of a turn, `<progress_toward_goal>` can be minimal (e.g. only “Goal this turn” and empty steps). After each tool round or verify→retry, append to or replace the progress block so the next agent call always sees the updated “building state.”

---

## Implementation notes

- **Where to build progress:** In [sidepanel.js](sidepanel.js), when building the message that starts a new agent turn (or continues after verify_mod), maintain a **progress** object: `{ goalThisTurn, stepsTaken[], lastProposal, lastVerifyResult, retryAttempt, learned[] }`. After each tool round, append tool names and outcomes to `stepsTaken`. After propose_mod + verify_mod, set `lastProposal`, `lastVerifyResult`, and optionally `learned`. When triggering a retry, increment `retryAttempt` and set `learned` from the verify result.
- **System prompt:** Add one line to the static system prompt: “You will receive intent (what the user wants), world state (page and mods), and progress toward the goal (steps taken, last proposal, verify result, retry count). Use progress to stay aligned with the intent and to avoid repeating failed approaches.”
- **Synthetic messages after verify:** When we inject “[VERIFY_RESULT] 0 elements matched…”, also inject or update the `<progress_toward_goal>` block in the *next* user message so the agent sees the full “building state” in one place.

This addendum should be merged into **Section 1 (Static system prompt and two-context user message)** of the main plan, expanding “two-context” to “three-context” (intent, world state, progress toward intent) and adding the progress block to the structured user message and the sidepanel progress state.
