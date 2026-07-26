# AI Conversation Current-Group Navigation and Controls

**Date:** 2026-07-26  
**Status:** Approved for planning

## Problem

Selecting an interaction in an expanded Active Session conversation outline
currently reveals the read-only AI Conversation viewer in
`ViewColumn.Beside`. This changes the user's editor layout by creating or
using a side-by-side editor group.

The viewer's controls also fail in the real VS Code Webview. The browser
fixture injects `window.vscode`, but the production viewer document never
acquires the VS Code Webview API. As a result, Previous, Next, Latest, Close,
and HTTPS link actions cannot post their protocol messages to the extension.

## User Experience

### Opening and reuse

- Selecting an outline interaction opens AI Conversation in the current
  active editor group.
- Opening the viewer must not create or reveal a side-by-side editor group.
- The extension owns at most one AI Conversation panel. Selecting another
  interaction reuses that panel and replaces its authoritative target.
- Revealing an already-created panel keeps it in the current active editor
  group.

### Controls

- Previous selects the immediately preceding user interaction when one
  exists.
- Next selects the immediately following user interaction when one exists.
- Latest selects the newest user interaction.
- Close disposes the AI Conversation panel.
- HTTPS links are opened through the Host's external-link boundary.
- Disabled navigation controls remain inert.

### Focus restoration

- Closing the viewer restores focus to the exact originating conversation
  marker when that marker still exists.
- If the marker no longer exists but the same session card remains, the
  existing conversation-origin fallback may focus that session's header.
- Focus must never transfer to another session.

## Architecture

### Panel placement

`ConversationViewer` continues to own one `WebviewPanel`; no new view type or
sidebar surface is introduced. Both initial panel creation and later reveal
operations target `vscode.ViewColumn.Active` instead of
`vscode.ViewColumn.Beside`.

This preserves the existing viewer lifecycle, bounded page cache, watcher,
navigation, stale-publication rejection, and focus-restoration protocols while
removing the editor split.

### Webview API ownership

The conversation viewer script acquires the VS Code Webview API exactly once
when `acquireVsCodeApi` is available. The acquired object remains private to
the script and is used by its `post` helper.

Browser tests may supply a compatible fallback API before loading the script,
but production correctness must be verified from the complete Host-rendered
document rather than relying only on a fixture-created `window.vscode`.

The script must not call `acquireVsCodeApi` more than once, expose the returned
object in rendered conversation content, or accept page content as executable
code.

### Message protocol

The existing strict version-1 messages remain unchanged:

- `conversation-viewer-previous`
- `conversation-viewer-next`
- `conversation-viewer-latest`
- `conversation-viewer-closed`
- `conversation-viewer-open-link`

Host-side exact-key validation and HTTPS-only link validation remain
authoritative.

## Failure and Lifecycle Behavior

- If the Webview API cannot be acquired, the document remains readable and
  controls fail closed without throwing.
- A stale or malformed Webview message remains ignored.
- Reusing the panel invalidates the previous target generation and retains no
  prior session content.
- Panel disposal releases the watch, message listener, view-state listener,
  pending read, retained pages, and target state before requesting focus
  restoration.
- This change does not alter outline expansion, conversation data adapters,
  page limits, refresh behavior, or provider support.

## Automated Verification

CI-reachable regression coverage must prove:

1. `ConversationViewer.open` creates and reveals its panel in
   `ViewColumn.Active`.
2. Opening a second target reuses the same panel.
3. The complete Host-rendered viewer document acquires one Webview API and
   posts Previous, Next, Latest, Close, and HTTPS-link messages.
4. Disabled controls remain inert and non-HTTPS links remain rejected.
5. Closing restores the existing exact conversation-origin focus behavior.
6. Source and packaged viewer scripts remain byte-identical.

The focused browser and integration owners must be reachable through
`npm run test:ci:linux`, and the main-capability audit must be advanced after
the implementation commit.

## Non-goals

- Rendering the full conversation inside the Project Steward sidebar.
- Opening multiple conversation viewers simultaneously.
- Redesigning viewer styling or navigation labels.
- Adding conversation mutation, editing, or agent controls.
- Changing the conversation outline interaction model.
