# AI Prompt Library Design

## Goal

Add a synchronized global Prompt library to Project Steward and let one
keyboard shortcut insert a reusable Prompt into the VS Code terminal that was
active when the command began.

The Dashboard gains an `AI` top-level tab. Its first subtab, `PROMPTS`, provides
Prompt management. `SKILLS`, `MCP`, and `HOOKS` reserve the intended information
architecture but contain only explicit Coming Soon states in this release.

## Chosen User Experience

### Dashboard navigation

The existing top-level Dashboard navigation becomes:

- `OPEN`
- `PROJECTS`
- `TODO`
- `AI`

The `AI` page contains a compact second tablist:

- `PROMPTS`
- `SKILLS`
- `MCP`
- `HOOKS`

`PROMPTS` is the initial selected subtab. The other three subtabs are
keyboard-accessible and open matching panels whose only content is a consistent
Coming Soon message. They expose no inactive forms or fake actions.

The existing Dashboard global search does not index Prompts in this release.
The group-collapse action is disabled while `AI` is active because AI content
has no collapsible project or TODO groups.

### Prompt management

The Prompt page shows an ordered global list. Each item exposes:

- a drag handle;
- its name;
- a bounded plain-text preview;
- a toggle for making it the default Prompt;
- Edit and Delete actions.

`New Prompt` and Edit use inline forms with a single-line name field and a
multiline plain-text Prompt field. Both fields are required. Prompt names must
be unique after trimming and case folding so the terminal picker cannot show
indistinguishable choices.

Users may drag items to define the exact list order. That order is also the
order used by the terminal picker. Deletion requires confirmation.

Exactly zero or one Prompt may be the default:

- Selecting a non-default Prompt replaces the previous default.
- Selecting the current default again clears the default.
- Deleting the default clears the default in the same persisted mutation.

## Terminal Command

Contribute and register one public command:

`projectSteward.insertPromptToActiveTerminal`

Its title is `Project Steward: Insert Prompt into Active Terminal`. Users bind
one shortcut to this command through the standard VS Code Keyboard Shortcuts
surface.

The command follows this exact sequence:

1. Capture `vscode.window.activeTerminal`.
2. If no terminal exists, show a warning and stop without creating one.
3. Read the latest normalized Prompt data.
4. If a valid default Prompt exists, select it without opening a picker.
5. Otherwise, open a QuickPick containing every valid Prompt in stored order.
6. If the list is empty, show an informational message directing the user to
   `AI > PROMPTS` and stop.
7. If the user cancels the picker, stop without side effects.
8. Send the selected Prompt through `terminal.sendText(prompt.text, false)`.
9. Reveal the captured terminal with `terminal.show()`.

QuickPick selection is single-use and never changes the stored default. Each
item shows the Prompt name as its label and a bounded first-line content
preview as its description or detail. QuickPick's native filtering supplies
search.

The explicit `false` prevents Project Steward from appending an execution
newline. Literal line breaks already present in the Prompt remain part of the
text sent to the pseudoterminal; the receiving shell or AI application owns how
it interprets those embedded characters. Project Steward does not synthesize
Enter, bracketed-paste control sequences, shell escaping, or provider-specific
input behavior.

If the captured terminal is disposed or rejects input while the picker is
open, the command reports a stable warning and does not retry against a
different terminal.

## Persistent Data

Declare one user setting eligible for VS Code Settings Sync:

`projectSteward.promptData`

The extension writes it with `vscode.ConfigurationTarget.Global`. It is not
machine-scoped and is not stored in workspace settings.

```ts
interface PromptDataV1 {
    version: 1;
    revision: number;
    selectedPromptId: string | null;
    prompts: PromptV1[];
}

interface PromptV1 {
    id: string;
    name: string;
    text: string;
}
```

The default value is:

```json
{
  "version": 1,
  "revision": 0,
  "selectedPromptId": null,
  "prompts": []
}
```

The array position is authoritative order. IDs are opaque, stable,
extension-generated values. Renaming or reordering a Prompt does not change its
ID. `selectedPromptId` is either `null` or the ID of one member of `prompts`.

Normalization trims names, preserves Prompt body text, rejects blank bodies,
and drops no valid records silently. Duplicate IDs, duplicate normalized names,
or an invalid revision make V1 data invalid and require controlled recovery. A
`selectedPromptId` that no longer names a valid Prompt is recoverable: reads
treat it as `null`, emit a bounded diagnostic, and leave persistence unchanged
until the next explicit user mutation. Prompt text is ordinary synchronized
settings data, not a secret store; the setting description tells users not to
place credentials or other secrets in it.

An unknown positive version is read-only. The AI page explains that a newer
Project Steward version is required, and the command sends nothing from an
unsupported data version.

### Revisions and concurrent windows

Every Webview mutation carries the revision of the snapshot from which it was
created. `PromptService` serializes local mutations, re-reads configuration
before writing, rejects a request whose expected revision is stale, and
increments the revision exactly once for each accepted mutation.

Configuration-change events refresh the Prompt panel and ensure subsequent
terminal commands read the latest value. A stale mutation returns the current
authoritative snapshot instead of overwriting it. The Webview retains an
unsaved form draft after conflict but requires the user to cancel or reopen the
editor against the refreshed item before another save.

VS Code settings provide no cross-extension-host compare-and-swap primitive.
Revision checks cover stale panels and all mutations observed before a write;
two writes that begin at exactly the same revision in separate extension hosts
may still resolve according to VS Code's last persisted user setting. All
instances then converge through configuration-change events. Distributed
conflict-free merging is outside this first release.

## Component Boundaries

### Prompt model and service

A dedicated `prompts` module owns:

- V1 types and normalization;
- immutable snapshots;
- create, update, delete, reorder, and select-default mutations;
- case-insensitive name uniqueness;
- revision validation and local mutation serialization;
- user-level configuration reads and writes;
- future-version read-only results.

The service does not import Webview DOM logic or terminal APIs. Mutation
methods return authoritative normalized snapshots so the host and Webview do
not maintain competing persisted models.

Reorder accepts an exact permutation of the current Prompt IDs. Missing,
duplicate, or unknown IDs reject the whole mutation.

### Prompt Dashboard controller

A dedicated controller validates versioned Webview messages, invokes
`PromptService`, maps model and persistence errors to stable result codes, and
publishes authoritative Prompt snapshots.

It owns delete confirmation and configuration-change refresh coordination.
Ordinary Prompt mutations update the AI panel without replacing unrelated
OPEN, PROJECTS, or TODO panels.

### Prompt command controller

A separate controller owns QuickPick projection and the terminal insertion
sequence. Its dependencies are injected so command behavior can be tested
without importing the live VS Code module.

It reads a fresh service snapshot per invocation. A missing or invalid default
ID safely follows the no-default picker path when the rest of the stored data
is supported and valid.

### Dashboard Webview

AI rendering and Prompt interaction live in focused Webview content and script
modules instead of expanding the general project interaction module.

The modules own:

- top-level AI panel mounting;
- AI subtab selection and keyboard navigation;
- inline create and edit drafts;
- default toggle state;
- Prompt drag-and-drop;
- pending request state;
- result announcements and error display;
- Coming Soon panels.

The host remains authoritative for persistence. The Webview may optimistically
retain local focus and drafts, but it does not treat DOM order or form state as
persisted until the host acknowledges the mutation.

## Message Contract

Prompt mutations use a versioned envelope:

```ts
interface PromptCommandMessage {
    type: 'prompt-command';
    version: 1;
    requestId: number;
    expectedRevision: number;
    action: 'create' | 'update' | 'delete' | 'reorder' | 'select-default';
    payload: unknown;
}
```

The host responds with:

```ts
interface PromptCommandResultMessage {
    type: 'prompt-command-result';
    version: 1;
    requestId: number;
    success: boolean;
    snapshot: PromptPanelSnapshot;
    errorCode?: 'invalid' | 'not-found' | 'conflict' | 'storage'
        | 'unsupported-version' | 'cancelled';
}
```

`PromptPanelSnapshot` contains only normalized Prompt fields required by the
page plus a read-only reason when applicable. Invalid message envelopes are
ignored without mutation. Every recognized request produces at most one result
message.

## Error Handling

- No active terminal: warn and stop.
- No configured Prompts: offer a direct action to open `AI > PROMPTS`; send
  nothing.
- QuickPick cancellation: no message beyond normal picker dismissal and no
  terminal effect.
- Invalid default ID in otherwise recoverable V1 data: use the picker and
  expose the invalid selection in Dashboard diagnostics.
- Unsupported data version: keep Prompt management read-only and insert
  nothing.
- Invalid create or edit fields: retain the inline draft and show field-level
  feedback.
- Missing mutation target: return the current snapshot and announce that the
  Prompt changed elsewhere.
- Stale revision: reject the write, refresh authoritative list state, retain
  the draft, and require reopening before save.
- Settings write failure: retain the draft and previous authoritative
  snapshot; do not announce success.
- Terminal input failure: warn once and do not select another terminal.

Diagnostics must not log complete Prompt bodies because they can contain
private user context. IDs, counts, revisions, error categories, and bounded
names are sufficient.

## Accessibility and Responsive Behavior

- Both Dashboard tablists use `role="tab"`, `aria-selected`,
  `aria-controls`, roving `tabindex`, arrow navigation, Home, and End.
- Coming Soon tabs and panels remain navigable and clearly labeled; they are
  not presented as disabled controls that silently do nothing.
- Inline form fields have persistent labels and associated error messages.
- The default toggle exposes `aria-pressed` and a text label rather than
  relying on color.
- Prompt actions are separate keyboard targets. Only the drag handle starts a
  pointer drag.
- Status, success, conflict, and error messages use the existing polite live
  announcement surface.
- Names and previews truncate without hiding the full editable values.
- The layout remains usable in approximately 240–600 px sidebars and in dark,
  light, high-contrast, and reduced-motion configurations.

## Testing

### Model and service

- Default empty V1 data and immutable snapshot behavior.
- Create, update, confirmed delete, exact reorder, and revision increments.
- Set, replace, and clear the default Prompt.
- Deleting the default clears `selectedPromptId` atomically.
- Blank fields, duplicate normalized names, duplicate IDs, invalid revisions,
  invalid permutations, missing targets, and malformed V1 data.
- Stale expected revisions, serialized local mutations, configuration write
  failures, and external configuration refresh.
- Unsupported future versions remain read-only.
- Writes target global user configuration and the manifest setting remains
  Settings Sync eligible.

### Terminal command

- A valid default inserts directly without opening QuickPick.
- No default opens QuickPick in stored order.
- Picker selection does not change the default.
- Picker cancellation sends nothing.
- An empty list sends nothing and offers the AI Prompt page.
- An invalid default ID falls back to QuickPick.
- Missing active terminal warns without creating one.
- The terminal captured before QuickPick receives the selected Prompt.
- A closed or failed captured terminal does not redirect input.
- Insertion calls `sendText(text, false)` and then reveals the terminal.
- Multiline text is forwarded unchanged without an extra execution newline.

### Dashboard and Webview

- The Dashboard renders OPEN, PROJECTS, TODO, and AI tab shells and preserves
  existing tab state.
- Mouse and keyboard navigation select the AI top-level tab and all four AI
  subtabs with correct ARIA relationships.
- Prompt create, edit, delete confirmation, reorder, and default-toggle
  messages use the V1 contract.
- Acknowledged snapshots update only the Prompt surface.
- Conflict and storage failures retain drafts without false success.
- Prompt dragging posts an exact ID permutation.
- Empty, populated, read-only, narrow-width, and theme-variable states render
  correctly.
- Skills, MCP, and Hooks contain only their Coming Soon panels.
- The existing global search catalog remains unchanged.

### Repository gates

- Add stable behavior IDs and owners to the behavior catalog for the Prompt
  store, terminal command, and AI Webview.
- Run focused model, controller, command, and Webview tests during
  implementation.
- Run deterministic unit, contract, integration, and browser suites.
- Run behavior-contract, Dashboard, architecture, lint, coverage, packaging,
  and Extension Host gates before release handoff.

## Non-goals

- Prompt variables, placeholders, parameters, conditions, or interpolation.
- Automatically submitting the inserted Prompt.
- Automatically creating a terminal.
- Per-Prompt commands or per-Prompt keyboard shortcuts.
- Workspace-, project-, provider-, or session-scoped Prompt libraries.
- Rich text, Markdown rendering, attachments, or secret storage.
- Recency-based or alphabetical sorting.
- Prompt integration in the Dashboard global search.
- Implementing Agent Skills, MCP, or Hooks configuration.
- Conflict-free merging of simultaneous writes from separate extension hosts.

## Acceptance Criteria

- The Dashboard exposes an `AI` top-level tab with `PROMPTS`, `SKILLS`, `MCP`,
  and `HOOKS`; only Prompt management is functional.
- Users can create, edit, confirm-delete, reorder, select, replace, and clear a
  global default Prompt from the sidebar.
- Prompt data is written only to global user settings, remains eligible for
  Settings Sync, and survives restart and window changes.
- One stable command can be assigned one keyboard shortcut.
- With a valid default Prompt, the command inserts it directly into the
  terminal captured at invocation.
- Without a default, the command opens an ordered searchable picker and inserts
  only the one-time selection.
- Project Steward never appends Enter, automatically creates a terminal, or
  changes the stored default because of a picker choice.
- Missing terminals, empty lists, cancellations, unsupported data, stale
  pages, settings failures, and disposed terminals create no unintended input
  or persisted mutation.
- Existing OPEN, PROJECTS, TODO, AI-session, terminal-runtime, global-search,
  and settings behavior continues to pass its regression gates.
