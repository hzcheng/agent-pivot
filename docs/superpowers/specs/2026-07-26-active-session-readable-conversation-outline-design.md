# Active Session Readable Conversation Outline Design

## Status and relationship to the original design

This is a focused visual and layout correction to
`2026-07-25-active-session-conversation-outline-design.md`.

It supersedes two parts of the original expanded-content design:

- marker width no longer represents user-input length;
- the outline no longer grows to its full natural height when the viewport has
  room.

Conversation sources, privacy boundaries, Host/Webview protocols, viewer
behavior, focus recovery, and the one-expanded-card rule remain unchanged.

## Problem

The current outline is technically navigable but visually ambiguous:

- a long session makes the expanded Active Session card excessively tall;
- variable-length strokes resemble a chart without communicating useful
  information;
- preview text is present in the DOM but intentionally hidden, leaving most of
  the card width blank;
- discovering an input requires hover or keyboard focus instead of supporting
  quick visual scanning.

The outline should read like a compact table of contents for the human's
requests, not like a length visualization.

## Product decision

Each conversation entry is one full-width, single-line row:

```text
—  Ask Codex to rebase main and preserve local changes…
—  The card expands too far when the session is long…
—  Show the beginning of each user request on the right…
```

The left marker is always the same 14 px length. The normalized user-input
preview is always visible in the remaining width and truncates with an
ellipsis. The entire row is the existing interactive target.

The outline shows at most six 28 px rows before it scrolls internally. Six rows
therefore occupy 168 px. With fewer than six entries, the rail shrinks to the
content instead of leaving an empty fixed-height box.

## Layout and sizing

### Row anatomy

Each marker button contains two presentation children:

- a fixed-width 14 px stroke;
- a preview span using `minmax(0, 1fr)`.

The button uses the full available card width and a 28 px row height. The
preview is one line with `overflow: hidden`, `text-overflow: ellipsis`, and
`white-space: nowrap`. A fixed gap separates the stroke and text.

Input grapheme count is no longer rendered as a CSS ratio. The renderer removes
the longest-input calculation and `--ai-input-ratio` assignment. The normalized
160-grapheme preview remains the content bound; it is inserted with
`textContent`, never HTML.

The existing timestamp plus complete bounded preview remains available through
the row's `title` and accessible name.

### Rail height

In a normal sidebar:

`rail height = min(number of rendered rows × 28 px, 168 px)`

The rail owns vertical scrolling whenever its content exceeds that height.
Horizontal scrolling is never introduced.

In an unusually short viewport, the existing layout coordinator may reduce the
rail below 168 px to preserve the card header, Conversation header, and access
to the surrounding Active Sessions list. It keeps the current 72 px lower
budget where possible. The outer list grows only by the bounded panel delta; it
must not expand based on the rail's full `scrollHeight`.

This gives the common case a stable six-row viewport while retaining the
original small-window safety behavior.

## Visual states

All strokes have identical geometry. State is communicated only through color,
opacity, and text emphasis:

- ordinary entries use the current subdued accent treatment;
- hover, keyboard focus, and selection strengthen the row without changing
  its dimensions;
- the latest entry uses stronger stroke opacity and slightly stronger preview
  text;
- an in-progress latest interaction may retain the existing low-noise state
  treatment, but it must not change stroke length or cause layout movement.

The focus ring surrounds the full row so the text and stroke read as one
control.

## Interaction behavior

Existing behavior is preserved:

- clicking anywhere on a row opens the reusable conversation viewer at that
  user input;
- `ArrowUp`, `ArrowDown`, `Home`, `End`, and `Enter` keep their current
  semantics;
- keyboard navigation scrolls only enough to reveal the destination row;
- initial expansion reveals the latest input only when the list overflows;
- a live update follows the latest input only when the reader was already at
  the end;
- intentional upward scrolling is preserved across live refreshes;
- `Escape`, collapse, card switching, authoritative HTML replacement, and
  viewer focus restoration retain their current contracts.

The scroll bar belongs to the conversation rail, so reading a long outline does
not move the whole dashboard or make following Active Session cards
unreachable.

## Empty, loading, partial, and unavailable states

These states retain their existing copy and lifecycle. The six-row cap applies
only when actual conversation rows are visible. A loading or unavailable state
does not reserve 168 px unnecessarily.

The partial-history notice stays outside the scrolling rows and remains visible
with the Conversation header. It does not count as one of the six entries.

## Accessibility and safety

- The rail remains a `listbox`; each full-width row remains an `option`.
- Roving `tabindex` and `aria-selected` behavior is unchanged.
- The accessible label continues to combine timestamp and bounded preview.
- Visual ellipsis does not truncate the accessible label.
- Hostile preview content remains inert because all visible and accessible text
  is assigned through DOM text properties.
- The fixed stroke is decorative and is not announced separately.

## Implementation boundaries

Expected production changes are limited to:

- `src/webview/webviewProjectScripts.js` for row DOM construction and bounded
  layout measurement;
- `media/styles.scss` and generated `media/styles.css` for the fixed row,
  preview, and rail styling.

No provider adapter, conversation model, extension-host protocol, viewer,
storage, or session-lifecycle change is required.

## Verification

Implementation follows a red-green-refactor cycle.

Automated checks must prove:

- three inputs render three visible single-line previews;
- hostile preview text remains inert;
- all rows and strokes have equal geometry regardless of grapheme count;
- one through six entries shrink-wrap without an internal scrollbar;
- seven or more entries cap at 168 px and scroll internally;
- a spacious viewport does not expand the rail to its full `scrollHeight`;
- a constrained viewport keeps the bounded layout and reachable headers;
- latest/current/selected states do not change row dimensions;
- existing pointer navigation, keyboard navigation, auto-follow, scroll
  preservation, HTML replacement recovery, and viewer focus restoration still
  pass.

The full Linux CI suite remains the release gate after the focused browser,
integration, style, and Webview-state tests pass.
