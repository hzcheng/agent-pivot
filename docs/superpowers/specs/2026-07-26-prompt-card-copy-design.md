# Prompt Card Copy Design

## Goal

Let a user start a new Prompt from an existing card so that only the small
differences need to be edited. Copying must not persist anything until the user
explicitly saves the new Prompt.

## User Experience

- Each Prompt card adds a Copy action to the existing hover/focus toolbar.
- The action order is Insert, Copy, Default, Edit, Delete.
- Clicking Copy opens the existing New Prompt form.
- The form is prefilled with the source Prompt's complete text.
- The proposed name is `<original name> copy`.
- If that name already exists, the suffix increases to `copy 2`, `copy 3`, and
  so on until the name is unique.
- The name comparison follows the Prompt library's existing
  locale-independent, case-insensitive uniqueness rule.
- No Prompt is created until the user presses Save.
- The copied Prompt is not automatically made the default Prompt.

The Copy control follows the same visibility and accessibility behavior as the
other management actions: it is hidden until pointer hover or keyboard focus,
and remains visible on devices that do not support hover.

## Architecture

Copy is a Webview-only draft action. It does not introduce a Host mutation or a
new persistence operation.

The rendered card exposes its Prompt ID through the Copy button. The Webview
controller resolves that ID against the current authoritative Prompt snapshot,
derives a unique proposed name, and opens the singleton create form with the
copied values. Saving continues through the existing correlated `create`
mutation and revision guard.

This keeps persistence, validation, conflict recovery, announcements, and
authoritative HTML replacement on the existing create path.

## Draft and Focus Behavior

- Opening Copy uses the existing singleton form-switching behavior, so only one
  create or edit form is open at a time.
- If another local draft is open, the same reset-and-switch behavior currently
  used by New Prompt and Edit applies.
- The copied name and text become the tracked create draft, so an unrelated
  authoritative refresh does not erase them.
- Focus moves into the copied create form using the existing create-form focus
  behavior.
- Cancel discards the local copy draft without changing synchronized storage.

## Layout

The fifth toolbar action remains 24px and cannot shrink. Card title space is
reserved only while the toolbar is visible. At narrow sidebar widths, the title
may truncate, but the card must not overflow horizontally and all five actions
must remain reachable.

## Error Handling

- A missing or stale Prompt ID produces no draft and announces that the Prompt
  is no longer available.
- Copy itself cannot produce a storage error because it does not persist.
- Save failures, revision conflicts, duplicate-name validation, and recovery
  remain handled by the existing create mutation protocol.
- Prompt text is never included in logs or accessibility announcements.

## Testing

Automated coverage will verify:

- Copy is rendered in the correct toolbar position with an accessible label.
- Copy opens a create form containing the exact source text.
- The proposed name advances through existing case-insensitive `copy` names.
- Copy does not post a Host mutation until Save is submitted.
- Singleton draft switching, cancellation, and authoritative refresh behavior
  remain correct.
- Keyboard focus, no-hover behavior, and 240px sidebar layout keep all five
  actions usable without horizontal overflow.
- Generated Webview assets remain byte-identical to their sources.

## Out of Scope

- Persisting a duplicate immediately.
- Copying the source card's default selection.
- Adding a new Host command or storage schema.
- Bulk copying multiple Prompts.
