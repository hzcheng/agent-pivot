# Webview Scroll and Render Stability Design

## Status

Approved approach: preserve local Webview state around authoritative updates for
Open/Active Session, Projects, and TODO surfaces. Do not introduce a generic DOM
morphing framework.

## Problem

Several Dashboard surfaces replace authoritative HTML without preserving all
local view state:

- Active and historical AI session lists lose their inner `scrollTop` when the
  current-workspace group is replaced.
- An expanded Active Session conversation can lose its historical scroll
  position when a second replacement occurs before the first replacement's
  outline request settles.
- A same-session replacement clears the last committed conversation outline
  and exposes an empty `Loading conversation…` state.
- Automatic conversation recovery calls `scrollIntoView`, which can move the
  outer session list even when the user did not request navigation.
- Projects group lists lose their inner scroll positions when the Projects
  panel is replaced.
- TODO authoritative updates replace the whole panel and then mount and render
  the TODO surface again. This destroys inner list scroll, detail, draft, and
  focus state and performs two full renders for one update.

These failures are most visible while an AI session is running because provider
watchers publish current-workspace updates as the session changes.

## Product Invariants

1. Background refresh must not move a user who is reading historical content.
2. When a scrollable list changes above the viewport, the same semantic item
   must remain at the same visible offset whenever that item still exists.
3. A user at the live end of a conversation continues following new input.
4. A user away from the live end does not begin following merely because the
   DOM was replaced or resized.
5. A same-identity refresh keeps the last Host-confirmed content visible until
   newer Host-confirmed content is ready.
6. Empty loading UI is shown only when no committed content exists for the
   requested identity.
7. Automatic state recovery never calls scrolling focus APIs. `scrollIntoView`
   is reserved for explicit user navigation.
8. Persistent data remains Host-authoritative. Restored scroll, focus, open
   detail, and unsaved draft are local Webview state, not committed data.
9. If an authoritative identity disappears, its local state is discarded
   instead of being applied to another item.

## Semantic Scroll Anchors

Pixel-only `scrollTop` is insufficient when rows are inserted, removed, or
reordered above the viewport. Each supported inner list captures:

- the current raw `scrollTop`;
- the stable identity of the first item intersecting the viewport;
- that item's top offset relative to the scroll container;
- whether a domain-specific auto-follow threshold considers the list at its
  live end.

After authoritative content is installed, restoration finds the same stable
identity and adjusts `scrollTop` so the item returns to the captured offset. If
the item no longer exists, restoration falls back to the captured raw
`scrollTop`, clamped to the new scroll range.

Stable identities are domain-specific:

- AI sessions: provider, session ID, panel, and pending creation timestamp when
  applicable;
- conversation entries: interaction ID;
- Projects lists: group ID plus project ID;
- TODO lists: group ID plus TODO ID.

The helper must not infer identity from row index or visible labels.

## Open and Active Session Recovery

Before replacing a current-workspace or open-workspaces subtree, capture one
project-scoped snapshot containing:

- selected Active/Sessions tab;
- Active list semantic anchor;
- Sessions history list semantic anchor;
- semantic focus target;
- provider menu state;
- expanded conversation identity and view state.

Apply the authoritative HTML first. Restore the selected tab before measuring
its list, restore both list anchors, and restore focus with
`focus({ preventScroll: true })`. Apply the outer list anchor again after any
expanded-conversation sizing so nested recovery cannot move the outer list.

The existing `captureAiSessionViewState` and `restoreAiSessionViewState`
capability must be wired into both current-workspace and open-workspaces
replacement paths. Its pixel-only restoration must be upgraded to semantic
anchors.

## Durable Conversation Recovery

The Webview conversation subscription retains the last validated
`ConversationOutline` and the latest rendered local view state. A matching
authoritative workspace replacement rebinds that existing subscription to the
new row and renders the cached outline synchronously. It does not create a new
outline request or replace committed content with Loading.

If the initial request is still pending and no committed outline exists, a
matching replacement keeps the same request and its original durable restore
state. A later replacement must not overwrite that state with the empty hidden
rail's `scrollTop = 0`.

The Host subscription and its correlation envelope remain unchanged across a
same-project, same-provider, same-session, still-focused replacement. A new
request is created only for a user expansion without a live subscription or a
different authoritative identity.

Conversation restoration uses these rules:

- at live end: render the new outline and follow the latest entry;
- reading history: restore the interaction anchor and offset;
- focused interaction still exists: restore focus with `preventScroll`;
- focused interaction removed: preserve the historical position without
  focusing an unrelated entry;
- identity removed or no longer focused: collapse locally and send the exact
  correlated cancellation.

Automatic restore does not call `row.scrollIntoView`. Direct user expansion
may still reveal the selected row.

## Projects Panel Recovery

When a Projects update genuinely requires panel replacement, capture:

- the Dashboard window scroll position;
- each group list's semantic project anchor;
- current semantic project/action focus.

After replacement and mount hooks run, restore group anchors and focus with
`preventScroll`, then restore the Dashboard window position. Recheck anchors
once in the next animation frame so asynchronous header fitting cannot shift
the user's viewport.

Updates already classified as `preserve-order` and structurally unchanged
continue skipping replacement.

## TODO Panel Recovery

Mounted TODO refreshes with a valid snapshot must be routed to the existing TODO
controller rather than replacing `panels.todo.innerHTML` and then mounting a
second full render.

The TODO controller applies the new authoritative snapshot while preserving:

- each group list's semantic TODO anchor;
- selected detail when the TODO still exists and remains visible;
- compose state and unsaved edit draft when their authoritative target still
  exists;
- semantic focus and Dashboard window scroll.

The controller renders once, restores anchors after expanded-height
measurement, and restores focus with `preventScroll`.

If the selected TODO or compose group was removed authoritatively, the
corresponding local detail, draft, or compose state is discarded. Unsupported
or malformed snapshot updates retain the existing fallback full-panel error
path and do not restore stale state onto an unrelated surface.

Existing narrow TODO patches for completion, group collapse, and item updates
remain preferred. The new refresh path is for authoritative updates that
cannot use those patches.

## Other Surfaces

The Prompt library already captures list scroll, window scroll, semantic focus,
draft, and active subtab around authoritative replacement. No behavior change
is required.

The standalone Conversation Viewer already distinguishes live-end following
from historical scroll preservation. No behavior change is required.

Dashboard search results intentionally rebuild for each query and are outside
this restoration scope. A complete Webview reload also remains outside the
scope because no live DOM survives it.

## Failure Handling

- Missing scroll container: skip that local restoration only.
- Missing anchor identity: clamp and restore the raw scroll position.
- Removed authoritative project, group, session, or TODO: discard the matching
  local state.
- Malformed or stale authoritative update: preserve the current committed DOM
  and follow the existing refresh/error protocol.
- Failed cached conversation render: keep the correlated subscription state,
  show the bounded unavailable state, and never apply it to another identity.

No local restoration failure may trigger a mutation, persistence write, or
cross-project state transfer.

## Test and CI Ownership

All new user-visible behaviors are owned by production-markup browser tests.
Those tests run through:

`tests/browser/**/*.test.js` → `npm run test:browser:run` →
`npm run test:ci:linux` → required `quality-linux`.

Required RED scenarios:

1. Active and historical session lists retain their semantic top row and
   offset through current-workspace and open-workspaces replacement, including
   insertion or reordering above the viewport.
2. A same-session conversation remains rendered through replacement and does
   not issue another outline request.
3. Two replacements before an initial outline response retain the original
   nonzero restore state rather than capturing zero from Loading.
4. A historical conversation anchor survives live updates while a live-end
   reader follows new input.
5. Automatic conversation recovery does not move the outer session list.
6. Projects group lists retain their semantic project anchors through required
   panel replacement and header fitting.
7. TODO authoritative refresh preserves group anchors, selected detail,
   unsaved draft, and focus when their identities survive, and removes them
   when the identities disappear.
8. TODO mounted refresh performs one surface render and does not replace the
   entire mounted panel.

`ACTIVE-SESSION-CONVERSATION-RESTORE-001` continues owning conversation
replacement behavior. Add dedicated automated behavior contracts for AI
session list scrolling, Projects panel scrolling, and TODO refresh-local-state
preservation.

## Non-Goals

- A general virtual DOM, DOM morphing library, or keyed diff framework.
- Persisting scroll or draft state to the Host.
- Changing AI provider scan or watcher cadence.
- Changing conversation source, viewer, or security protocols.
- Preserving state across a complete Webview reload.
- Redesigning Projects, TODO, or Active Session visual layout.
