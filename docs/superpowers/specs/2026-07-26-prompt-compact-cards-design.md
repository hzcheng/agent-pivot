# Compact AI Prompt Cards Design

## Goal

Make the AI Prompt library easy to scan in a narrow Dashboard sidebar. Prompt
cards must have a consistent width, must not expose the full Prompt body in
their default state, and must provide a fast path for inserting one specific
Prompt into the active terminal.

## Chosen Interaction

Use the same compact-card language as Todo items:

- Render the Prompt list as a single full-width column so every card has the
  same width.
- Keep each card collapsed by default. Show the Prompt name and a bounded
  plain-text preview only; the existing Edit form is the only place inside the
  library that shows the complete Prompt text.
- Keep the drag handle visible at low emphasis, matching Todo items, so
  reordering remains discoverable. Show Insert, the default toggle, Edit, and
  Delete in one compact toolbar, in that order, only while the card is hovered
  or contains keyboard focus.
- Keep keyboard access equivalent to pointer access. Hidden actions become
  visible with `:focus-within`, retain accessible names and tooltips, and do
  not disappear while one of them owns focus. The toolbar uses opacity and
  pointer-event changes rather than `display`, `visibility`, or DOM removal,
  so its controls remain reachable by Tab.
- Mark the selected default Prompt with a small persistent visual state rather
  than a wide "Default" or "Make default" text button.

The insert button follows the same reveal behavior as the management actions,
so the collapsed card has no persistent right-side action column.

## Alternatives Considered

1. Keep Insert as a separate right-side hover action. This preserves its
   primary-action distinction but leaves two competing hover regions.
2. Put all management actions in a three-dot overflow menu. This is visually
   clean but adds an extra click to common Edit and Delete operations.
3. Open a detail view by clicking the whole card. This makes the card less
   predictable, conflicts with drag/reorder behavior, and makes accidental
   expansion more likely.

The chosen hover/focus toolbar follows existing Todo and project-card patterns
without adding another menu or detail state.

## Terminal Insertion Protocol

The webview sends a distinct non-mutating request with these exact fields:

```text
{
  type: "prompt-insert-terminal",
  version: 1,
  requestId: <non-empty string, at most 128 characters>,
  target: "global-prompt-library",
  promptId: <non-empty string>
}
```

It does not reuse `prompt-command`, `expectedRevision`, mutation correlation
keys, or mutation authority sequences. The host exact-key validates the
envelope and ignores duplicate request IDs so a repeated webview message
cannot insert the same Prompt twice.

The host replies once with an exact-key acknowledgement:

```text
{
  type: "prompt-insert-terminal-result",
  version: 1,
  requestId,
  target: "global-prompt-library",
  success: <boolean>,
  errorCode: null | "no-active-terminal" | "prompt-unavailable"
    | "prompt-not-found" | "terminal-unavailable"
}
```

The acknowledgement clears the clicked button's pending state and updates the
Prompt status live region. The host also uses the existing safe VS Code
warning for a failed insertion. A direct insert marks only its clicked button
`aria-disabled` while awaiting acknowledgement, suppresses repeat activation,
and keeps keyboard focus stable. An in-progress Prompt mutation keeps the
existing global mutation lock and therefore natively disables insert buttons
too; an insert acknowledgement must not release that mutation lock.

The extension host resolves the requested ID against the current
authoritative Prompt snapshot immediately before sending text. Insert requests
intentionally carry no revision: if another window edits the Prompt between
render and click, the current host-owned text is inserted. If that ID has been
deleted, the request fails with `prompt-not-found`; stale webview text is never
sent.

The direct card action does not use the selected default Prompt and does not
open the Prompt Quick Pick. It inserts exactly the clicked Prompt into the
active terminal with `addNewLine` set to `false`, then reveals the terminal.
When handling the message, the host captures `vscode.window.activeTerminal`.
If it is absent, if Prompt storage is unavailable, or if that captured
terminal disappears before `sendText`, the host reports a safe user-facing
warning and does not send other Prompt text. The by-ID entry point reuses the
existing terminal availability check and warning behavior without invoking
the default/Quick Pick branch.

The existing command-palette behavior remains unchanged: it uses the default
Prompt when one is selected and otherwise opens the Quick Pick.

## Rendering and Styling

Prompt bodies remain HTML-escaped. The card preview is bounded in both source
length and rendered lines so long or multiline Prompts cannot change card
width or dominate the list. The existing 160-character, whitespace-normalized
first-line preview remains the source bound; CSS clamps it to at most two
rendered lines.

Insert is the first button in the hover/focus toolbar, followed by the default
toggle, Edit, and Delete. The default toggle retains `aria-pressed`; activating
an unselected star sends that Prompt ID, and activating the selected star
sends `null` to clear `selectedPromptId`. A selected card also has a small
persistent, non-interactive star/default state so the current default is
visible without keeping the management toolbar open.

The management toolbar floats inside the card and does not reserve a wide
text-button column. Only the low-emphasis drag handle reserves a compact icon
width in the collapsed state. At sidebar widths down to 240 pixels, the
content shrinks, the preview remains clamped, the revealed four-action toolbar
stays within the card, and no horizontal overflow is introduced.

For devices without hover, the management toolbar remains visible at reduced
emphasis. Forced-colors mode supplies visible borders/state, and reduced-motion
mode removes toolbar transitions.

Existing create, edit, delete, reorder, default-selection, synchronized
storage, and refresh behavior remains unchanged.

## Verification

Automated coverage will verify:

- equal full-width compact card markup and bounded previews;
- icon-only actions with accessible labels, tooltips, hover and keyboard-focus
  visibility;
- a persistent selected-default marker plus an `aria-pressed` icon toggle that
  can both set and clear `selectedPromptId`;
- a direct-insert action as the first control in the hover/focus toolbar for
  each Prompt;
- direct-insert controls disabled by a mutation lock, plus per-button pending
  behavior that cannot release an unrelated mutation lock;
- exact Prompt-ID routing from webview to extension host;
- insertion into the active terminal without a newline or Quick Pick;
- request/result exact-key validation and duplicate-request suppression;
- safe handling of missing Prompts, unavailable storage, and stale terminals;
- 240, 280, and 320 pixel sidebar layouts without horizontal overflow;
- hover-less, forced-colors, and reduced-motion fallbacks;
- no regressions in existing Prompt mutations, drag ordering, and command
  palette insertion.

The final implementation will run focused Prompt and Dashboard tests, lint,
generated-asset parity checks, and the repository's full Linux CI suite.
