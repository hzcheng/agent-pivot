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
- Keep a compact "insert into active terminal" icon button visible on every
  card.
- Show the drag handle, default toggle, Edit, and Delete as compact icon
  actions only while the card is hovered or contains keyboard focus.
- Keep keyboard access equivalent to pointer access. Hidden actions become
  visible with `:focus-within`, retain accessible names and tooltips, and do
  not disappear while one of them owns focus.
- Mark the selected default Prompt with a small persistent visual state rather
  than a wide "Default" or "Make default" text button.

The insert button remains visible because it is the card's primary action.
The other actions are management operations and can remain visually quiet.

## Alternatives Considered

1. Put all management actions in a three-dot overflow menu. This is visually
   clean but adds an extra click to common Edit and Delete operations.
2. Open a detail view by clicking the whole card. This makes the card less
   predictable, conflicts with drag/reorder behavior, and makes accidental
   expansion more likely.

The chosen hover/focus toolbar follows existing Todo and project-card patterns
without adding another menu or detail state.

## Terminal Insertion

The webview sends a versioned, non-mutating request containing the clicked
Prompt ID. The extension host resolves that ID against the current
authoritative Prompt snapshot immediately before sending text.

The direct card action does not use the selected default Prompt and does not
open the Prompt Quick Pick. It inserts exactly the clicked Prompt into the
active terminal with `addNewLine` set to `false`, then reveals the terminal.
If the Prompt is stale, Prompt storage is unavailable, or the active terminal
is missing or disappears, the host reports a safe user-facing warning and
does not send other Prompt text.

The existing command-palette behavior remains unchanged: it uses the default
Prompt when one is selected and otherwise opens the Quick Pick.

## Rendering and Styling

Prompt bodies remain HTML-escaped. The card preview is bounded in both source
length and rendered lines so long or multiline Prompts cannot change card
width or dominate the list. The action toolbar is positioned within the card
without reserving a wide text-button column. Narrow-sidebar rules preserve the
visible insert action and allow the content area to shrink with ellipsis or
line clamping.

Existing create, edit, delete, reorder, default-selection, synchronized
storage, and refresh behavior remains unchanged.

## Verification

Automated coverage will verify:

- equal full-width compact card markup and bounded previews;
- icon-only actions with accessible labels, tooltips, hover and keyboard-focus
  visibility;
- persistent selected-default styling;
- a visible direct-insert action for each Prompt;
- exact Prompt-ID routing from webview to extension host;
- insertion into the active terminal without a newline or Quick Pick;
- safe handling of missing Prompts, unavailable storage, and stale terminals;
- no regressions in existing Prompt mutations, drag ordering, and command
  palette insertion.

The final implementation will run focused Prompt and Dashboard tests, lint,
generated-asset parity checks, and the repository's full Linux CI suite.
