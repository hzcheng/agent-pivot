# Active Session Conversation Outline Design

## Problem

Project Steward can show active AI sessions and track their lifecycle as
`starting`, `running`, or `stopped`. An Active Session card cannot currently be
expanded, so it does not provide a compact overview of the interaction that is
already happening in that session.

The desired experience is similar to the conversation outline in the Codex
app:

- every Active Session card starts collapsed;
- a focused card can expand to show one horizontal marker per real user input;
- selecting a marker opens a readable transcript at that input;
- Codex, Kimi, and Claude behave consistently;
- the outline contains only user requests, not agent reasoning, tools, logs, or
  provider-internal events.

The feature must fit the narrow VS Code sidebar without hiding the expanded
card or allowing multiple cards to consume the available height at once.

## Goals

- Add a predictable, single-card expansion interaction to Active Sessions.
- Show a provider-neutral outline of real user inputs for Codex, Kimi, and
  Claude.
- Open a Project Steward-owned, read-only conversation viewer at the selected
  input.
- Preserve correct local UI state across authoritative Webview HTML refreshes.
- Keep transcript access bounded, read-only, privacy-conscious, and isolated
  by provider.
- Leave an extensible content region for future tabs such as Subagents without
  exposing unfinished controls now.

## Non-Goals

This design does not:

- display or monitor subagents;
- show agent reasoning, tool calls, tool results, system prompts, raw logs, or
  token usage;
- jump the provider's terminal or TUI to an exact historical turn;
- add input or mutation controls to the transcript viewer;
- change session discovery, lifecycle classification, terminal ownership, or
  terminal focus behavior;
- modify provider transcript files;
- promise compatibility with unknown future provider formats without an
  adapter update.

## Options Considered

### Provider-native adapters

Codex is read through its structured app-server protocol, while Kimi and
Claude are read through their provider-owned local session formats. All three
normalize into one Project Steward model.

This is selected. It uses the strongest available contract for each provider,
keeps format failures isolated, and avoids making Codex JSONL an application
dependency.

### Parse every provider's local transcript files

This would produce the smallest initial infrastructure and a similar
incremental-reading path for all providers. It is rejected because Codex
transcript files are storage artifacts rather than the intended rich-client
interface. Depending on their internal shape would create unnecessary
compatibility and privacy risk.

### Inject a capture bridge into each launched CLI

Project Steward could wrap every provider process and record user/assistant
events itself. This is rejected for the first release because it is invasive,
cannot reconstruct existing sessions, adds another sensitive transcript, and
couples history availability to sessions launched after the feature ships.

## Product Interaction

### Card click model

All Active Session cards are collapsed when the Webview is first opened or
fully reloaded.

Clicking a non-focused Active Session card performs the existing session switch
or terminal focus action only. It does not also expand the card. This preserves
a simple first-click/second-click model:

1. first click selects the session;
2. a later click on the already focused card expands it;
3. another click on the focused expanded card collapses it.

Only one Active Session card may be expanded. Switching focus collapses the
previously expanded card. If the expanded session disappears or is no longer
focused after a Host refresh, its expansion is discarded.

Clicking an action within a card or selecting a conversation marker does not
bubble into the card toggle. `Enter` and `Space` provide the same activation
behavior as pointer clicks.

The focused card displays a chevron and accurate `aria-expanded` state.
Non-focused cards do not present an expand affordance because their first
activation has a different purpose.

### Expanded content

The expanded region is structurally tab-capable, but the first release renders
only `Conversation`. It does not show a disabled or empty `Subagents` tab.

The Conversation region contains:

- a label and user-turn count;
- a vertical, chronological rail of horizontal input markers;
- a bounded hover or keyboard-focus preview;
- loading, unavailable, empty, and stale states.

Markers run from oldest to newest. Marker width reflects relative user-input
length within fixed minimum and maximum visual bounds; it is not a byte-precise
chart. Every marker has a minimum 24 px interactive height so pointer and
keyboard use do not depend on the thin visible stroke.

Hovering or focusing a marker exposes its timestamp and a normalized,
160-character user-input preview. The latest marker has slightly stronger
emphasis. A currently active last turn may use a low-noise progress treatment,
but must not reuse or compete with the card's primary running animation.

A newly expanded outline initially reveals the latest marker. Subsequent live
updates do not force the rail to the bottom after the user has intentionally
scrolled upward.

Keyboard navigation within the rail supports:

- `ArrowUp` and `ArrowDown` for adjacent inputs;
- `Home` and `End` for first and latest input;
- `Enter` to open the selected input;
- `Escape` to collapse the card and return focus to its header.

### Dynamic sidebar layout

The Active Sessions list currently has a bounded height. Expanding a card must
increase the list's effective height by that row's measured expansion delta,
not by a fixed guessed value:

`expanded row height - collapsed row height`

Because only one row can expand, only one delta is applied. After layout, the
list scrolls just enough to reveal the expanded card without unnecessarily
moving the user's surrounding context.

When the sidebar or viewport cannot provide the desired expanded height:

- the card header and Conversation header remain visible;
- the marker rail becomes the bounded internal scroll region;
- following cards remain reachable in the outer Active Sessions list;
- resize observation recalculates the available height.

Collapsing the card removes the expansion delta and restores a sensible outer
list position.

## Conversation Viewer

Selecting a marker opens a single reusable editor-area `vscode.WebviewPanel`
named `AI Conversation`. Project Steward owns this view because provider
terminals and TUIs do not expose a dependable public API for exact
historical-turn navigation.

Opening another turn or session updates the existing view instead of creating
one editor tab per selection. The view takes editor focus on explicit marker
activation.

The viewer contains:

- a sticky provider and session-display header, using only a shortened
  identifier when disambiguation is necessary;
- the selected position, such as `Turn 4 of 12`;
- Previous, Next, and Latest navigation;
- the full session in chronological order, loaded in bounded pages;
- a stable anchor and temporary highlight on the selected user input.

It displays only visible user text and visible assistant text. Markdown,
lists, and code blocks remain readable, but raw HTML, scripts, command links,
and unsafe resource links are not executed. The Webview uses a restrictive
content security policy and nonce-scoped scripts.

An attachment-only user input is represented by a neutral label such as
`[Attachment]`; local paths and raw attachment metadata are not exposed.

Stopped sessions remain readable while their history exists. If a source is
deleted after content has been loaded, the viewer retains the in-memory
snapshot and labels it unavailable or stale rather than replacing it with an
empty view.

### Live update behavior

The Host watches the selected session's source for change signals and requests
fresh normalized data from the adapter.

- When the viewer is at the latest turn and already at the bottom, new visible
  response content auto-follows.
- When the user is reading older content or has scrolled upward, the scroll
  position remains stable and a `New response content` affordance appears.
- A transient refresh failure retains the last successful snapshot with a
  stale indicator.

## Architecture

Conversation history is a separate read-only capability layered beside the
existing lifecycle and terminal controllers:

```text
Active Session card
    -> Webview conversation request
    -> ConversationCoordinator
        -> CodexConversationAdapter
        -> KimiConversationAdapter
        -> ClaudeConversationAdapter
    -> normalized Conversation data
    -> outline or AI Conversation viewer
```

The existing Active Session view model remains responsible for provider,
session identity, focused state, and lifecycle. Transcript parsing does not
become part of hydration or every dashboard refresh.

Outline data is loaded lazily only after a focused card expands. Full
conversation pages are loaded only after the user selects a marker or navigates
the open viewer.

### Provider adapter contract

Each provider implements the same logical contract:

```ts
interface ConversationProviderAdapter {
    readOutline(sessionId: string): Promise<ConversationOutline>;
    readPage(request: ConversationPageRequest): Promise<ConversationPage>;
    watch(
        sessionId: string,
        onChange: (revisionHint?: string) => void
    ): vscode.Disposable;
}
```

`readOutline` returns only the fields needed by the sidebar:

- stable turn identity;
- timestamp when available;
- normalized user-input character length;
- normalized user-input preview, capped at 160 characters;
- whether the turn may still be receiving a response.

`readPage` returns bounded visible messages around or after a selected turn,
plus navigation cursors. The viewer requests additional pages as needed; the
Host does not send an unbounded transcript through one Webview message.

Every result carries provider, session ID, source revision, and request ID so
callers can reject mismatched or stale data.

### Normalized model

The provider-specific adapters normalize into a model equivalent to:

```ts
interface ConversationOutline {
    provider: AiSessionProvider;
    sessionId: string;
    sourceRevision: string;
    turns: ConversationTurnSummary[];
}

interface ConversationTurnSummary {
    id: string;
    timestamp?: number;
    userPreview: string;
    userCharacterCount: number;
    responseState: "complete" | "inProgress" | "unknown";
}

interface ConversationMessage {
    id: string;
    turnId: string;
    role: "user" | "assistant";
    timestamp?: number;
    markdown: string;
}
```

Turn identities must remain stable when a source is appended:

- Codex uses the structured turn identity returned by app-server;
- Claude derives identity from the qualifying message UUID;
- Kimi derives identity from session ID plus the original turn-begin byte
  offset and timestamp, not from message text.

The normalized model deliberately has no representation for reasoning, tools,
system messages, or logs. Exclusion happens inside the provider adapter before
data crosses the coordinator boundary.

## Provider Data Sources

### Codex

The Codex adapter uses a lazily started local `codex app-server` child process
and its structured thread API. It reads the known session with
`thread/read(includeTurns: true)` and extracts user-message and visible
agent-message items.

The app-server process is shared by Codex conversation requests and terminated
when the extension is disposed. Requests are correlated and time-bounded. The
adapter validates that the installed Codex exposes the required protocol before
advertising the capability.

Project Steward does not parse Codex transcript JSONL as a fallback. Those
files are useful storage artifacts but are not treated as a stable public
interface. If app-server is absent, incompatible, or returns an unsupported
shape, the Codex outline reports a provider-specific unavailable state without
affecting Kimi or Claude.

The separately running Codex TUI does not share in-memory app-server state.
Existing transcript-file change observation is therefore used only as an
invalidation signal; the structured `thread/read` response remains the content
authority.

### Kimi

The Kimi adapter reads the active session's
`~/.kimi/sessions/<workdir-hash>/<session-id>/wire.jsonl`.

It starts a turn only from a valid `TurnBegin` and extracts the visible
`payload.user_input`, which may be a string or an array of typed text parts.
Visible assistant text comes from qualifying content parts within that turn.
The adapter excludes:

- thinking or encrypted content;
- tool calls and tool results;
- subagent events;
- provider-internal records.

`TurnEnd` or an interruption boundary closes the current normalized turn.

### Claude

The Claude adapter reads the provider's top-level session JSONL selected by the
existing Claude session service.

A real user input must have the qualifying top-level user-message shape and
visible text content. Records that look like user messages but carry
`sourceToolAssistantUUID`, `toolUseResult`, or `tool_result` content are tool
results and are excluded.

Visible assistant text comes from qualifying assistant text blocks. The adapter
also excludes:

- assistant tool-use blocks;
- sidechain events;
- internal queue and attachment records;
- system and provider-internal events.

### Incremental indexing

Kimi and Claude adapters keep bounded in-memory indexes keyed by provider,
session ID, canonical source path, and a file signature. An append reads only
the new suffix when the previous byte offset remains valid.

A smaller file, replaced inode or equivalent identity, changed canonical path,
or invalid continuation resets the index and performs a bounded rebuild.
Malformed individual lines are skipped and counted; they do not invalidate
otherwise readable turns.

No normalized transcript is persisted by Project Steward. Cache entries are
released after inactivity, session removal, or extension disposal.

## Host/Webview Protocol

Conversation reads use versioned, correlated messages. A typical outline flow
is:

1. the focused card expands locally;
2. the Webview sends provider, session key, and a new request ID;
3. the Host resolves the session from its authoritative current workspace
   snapshot;
4. the coordinator calls the matching adapter;
5. the Host returns a correlated outline result;
6. the Webview renders only if that exact session remains focused and expanded
   and the request is still current.

Marker activation follows the same validation before the Host loads a page and
opens or updates the editor viewer at the requested turn.

The Host does not trust provider names, labels, transcript paths, or turn
content copied from the DOM. It accepts only a supported provider/session key,
resolves the source itself, and verifies that the requested turn belongs to the
result returned for that session.

Closing a card, switching focus, changing workspaces, or issuing a newer
request cancels work when practical and always invalidates the older request
ID. A late result becomes a no-op.

### Webview state across refreshes

Expansion is ephemeral Webview state, not a persisted user preference. Before
authoritative workspace HTML replacement, the Webview captures:

- expanded provider/session key;
- active internal tab identifier;
- marker rail scroll position;
- focused marker ID when applicable.

After replacement it restores that state only when the same session still
exists and remains focused. Otherwise all cards remain collapsed. A full
Webview reload intentionally starts closed.

Restoration never reuses old transcript HTML. It starts a fresh correlated
outline request and displays a fresh bounded loading skeleton.

## Failure Handling

- A session that has stopped but still has history remains readable.
- A missing or archived source produces an unavailable outline; an already open
  viewer retains its last successful in-memory snapshot.
- A malformed JSONL line is skipped. A malformed provider structure is isolated
  to that adapter and surfaced as an unavailable state.
- File truncation, rotation, or replacement resets the incremental index.
- App-server process failure rejects its in-flight Codex requests, then permits
  a bounded restart on a later explicit request.
- Rapid expand/collapse and session switching cannot commit stale responses.
- Empty valid history displays `No user inputs yet`, distinct from loading or
  failure.
- Unsupported provider versions fail closed and do not trigger parsing of an
  undocumented alternate source.

## Privacy, Security, and Bounds

- All source access is read-only and constrained to paths resolved by the
  existing provider session services.
- User and assistant text is escaped before it reaches generated HTML.
- Rendering uses a safe Markdown pipeline with raw HTML and unsafe links
  disabled.
- Outline previews are capped at 160 characters.
- Page size, message size, total loaded viewer content, line length, parser
  work, watcher count, and cache lifetime receive explicit implementation
  limits.
- Oversized content is visibly truncated with an option to load another
  bounded page where appropriate; it is never silently interpreted as markup.
- Logs may include provider, bounded counts, duration, and an error category.
  They do not include user text, assistant text, absolute transcript paths, or
  a full session ID.
- Project Steward does not mutate provider files or persist a second full copy
  of the transcript.

## Testing

### Provider adapter tests

Sanitized fixtures for all three providers establish:

1. only real user inputs create outline markers;
2. visible assistant text is grouped with the correct user turn;
3. reasoning, system messages, tools, tool results, logs, subagents, and
   sidechains are excluded;
4. attachment-only inputs do not reveal local paths;
5. stable turn IDs survive appended content;
6. malformed lines are skipped;
7. truncation and replacement rebuild the incremental index;
8. unsupported structured data fails within one provider only;
9. repeated streaming snapshots or deltas do not duplicate visible content;
10. output and page-size limits are enforced.

The Codex contract uses a controlled app-server protocol fixture in ordinary
CI. A separate opt-in or scheduled compatibility check may exercise an
installed Codex binary without making local CLI availability a deterministic
test requirement.

### Coordinator and protocol tests

Tests establish that:

- the Host resolves session and provider identities authoritatively;
- request IDs correlate responses;
- older results are ignored after close, switch, refresh, or a newer request;
- stopped sessions remain eligible for history reads;
- missing sources retain an existing viewer snapshot;
- adapter errors do not cross provider boundaries;
- watches and app-server processes are disposed.

### Webview interaction tests

Browser tests cover:

- first click focuses without expanding;
- clicking the focused card toggles expansion;
- only one card remains expanded;
- changing focus collapses the previous card;
- nested actions and markers do not toggle the card;
- keyboard activation and marker navigation;
- focus return on collapse;
- dynamic list height in spacious and constrained sidebars;
- full visibility of the expanded card;
- independent inner and outer scrolling;
- state restoration after authoritative HTML replacement;
- safe collapse when the focused session disappears.

### Viewer tests

Tests cover:

- reuse of one `AI Conversation` editor view;
- exact anchoring and highlighting of the selected turn;
- Previous, Next, and Latest navigation;
- bounded page loading;
- Markdown and code rendering with unsafe HTML and links disabled;
- exclusion of private and internal provider content;
- retained stale content after a read failure;
- auto-follow only at the latest bottom position;
- stable historical scroll with a new-content affordance.

## Acceptance Criteria

- Every Active Session card starts collapsed.
- A non-focused card's first click switches to that session without expanding
  it.
- A focused card toggles open and closed, and no second card can remain open.
- The expanded card is fully usable at normal sidebar sizes and degrades to a
  bounded internal scroll region in a short viewport without being obscured.
- Codex, Kimi, and Claude outlines contain one marker per real user request and
  no markers for tools or provider-internal events.
- Marker selection opens the reusable read-only viewer at the exact user input
  and displays the corresponding visible AI interaction.
- The outline and viewer never expose reasoning, system prompts, tool traffic,
  raw logs, or local attachment paths.
- Incremental Host refresh preserves valid local expansion state, while session
  focus changes and full reloads close it safely.
- Rapid interaction cannot render stale data into the wrong card or viewer.
- Existing Active Session focus, terminal behavior, lifecycle tracking,
  History, and provider isolation do not regress.
