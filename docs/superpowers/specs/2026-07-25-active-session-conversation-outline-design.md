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

P0, required for the first release:

- add a predictable, single-card expansion interaction to Active Sessions;
- show a provider-neutral outline of real user inputs for Codex, Kimi, and
  Claude;
- open a Project Steward-owned, read-only conversation viewer at the selected
  input;
- preserve correct local UI state across authoritative Webview HTML refreshes;
- keep transcript access bounded, read-only, privacy-conscious, and isolated
  by provider.

P1 is an architectural constraint, not an additional first-release surface:

- leave the expanded content region internally tab-capable so a later
  Subagents design does not require replacing the card interaction.

## Non-Goals

This design does not:

- display or monitor subagents;
- show agent reasoning, tool calls, tool results, system prompts, raw logs, or
  token usage;
- jump the provider's terminal or TUI to an exact historical input;
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

## Core Terms

A **real user input** is a visible root-session input intentionally submitted
by the human through the provider client. It creates one outline marker even
when the provider represents it as a message inside a larger native turn.

It is not:

- a system, developer, hook, queue, compaction, or provider-internal message;
- a tool call, tool result, or synthetic `user` record carrying a tool result;
- subagent or sidechain traffic;
- hidden reasoning, encrypted content, or attachment metadata.

An **interaction** begins at one real user input and includes the visible
assistant text that follows it up to, but not including, the next real user
input. Provider adapters may use native turn boundaries as evidence, but the
normalized outline unit is the interaction. This preserves one marker per
actual user submission, including a qualifying Codex steer message that occurs
inside an existing native Codex turn.

User input length and preview truncation are measured in Unicode grapheme
clusters. Implementations use `Intl.Segmenter` when available and fall back to
Unicode code-point iteration; they never slice UTF-8 bytes or UTF-16 surrogate
pairs.

Visible-text normalization removes C0 controls except tab/newline/carriage
return before whitespace normalization, plus DEL and the U+FFFE/U+FFFF
noncharacters. It preserves valid Unicode scalar content, including CJK,
emoji, and combining sequences.

## Success Measures

Functional and privacy correctness are release gates:

- sanitized provider fixtures must produce 100% of expected real-user markers
  and zero forbidden markers;
- hostile content fixtures must produce zero executable HTML, script, command,
  `javascript:`, or unsafe resource links;
- every Acceptance Criterion must have automated evidence or an explicit
  manual accessibility check.

Performance is measured on the repository's Linux CI runner with a synthetic
10 MiB, 1,000-interaction transcript:

- cold outline construction completes within 1.5 seconds;
- an append of up to 1 MiB updates an existing index within 250 ms;
- a cached adapter outline read completes within 100 ms; this is not a
  Webview-render timing claim;
- Webview payloads and retained memory stay within the concrete limits in
  Privacy, Security, and Bounds.

These are deterministic engineering budgets, not product telemetry. This
feature does not add usage analytics or collect conversation-opening rates.

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

- a label and user-input count;
- a vertical, chronological rail of horizontal input markers;
- a bounded hover or keyboard-focus preview;
- loading, unavailable, empty, and stale states.

Markers run from oldest to newest. Marker width reflects relative
grapheme-cluster count within fixed minimum and maximum visual bounds; it is not
a byte-precise chart. Every marker has a minimum 24 px interactive height so
pointer and keyboard use do not depend on the thin visible stroke.

Hovering or focusing a marker exposes its timestamp and a normalized,
160-character user-input preview. The latest marker has slightly stronger
emphasis. A currently active last interaction may use a low-noise progress treatment,
but must not reuse or compete with the card's primary running animation.

A newly expanded outline scrolls only when necessary to reveal the latest
marker. A single marker or a set that already fits produces no artificial
scroll movement. Subsequent live updates do not force the rail to the bottom
after the user has intentionally scrolled upward. "At the bottom" means within
8 CSS pixels for both this rail and the viewer message list.

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

Opening another input or session updates the existing view instead of creating
one editor tab per selection. The view takes editor focus on explicit marker
activation.

The viewer contains:

- a sticky provider and session-display header, using only a shortened
  identifier when disambiguation is necessary;
- the selected position, such as `Input 4 of 12`;
- Previous, Next, and Latest navigation;
- the full available session window in chronological order, loaded in bounded
  pages, with an explicit partial-history notice only when a documented source
  limit is reached;
- a stable anchor and temporary highlight on the selected user input.

The display name is the primary identity. If two visible sessions from the same
provider share that name, the header appends the first eight lowercase
characters of the validated session ID. The count is the total interaction
count returned by the current outline, not merely the loaded page count. It
updates when a live session gains another input. A deliberately capped outline
uses `Input X of 2,000+`.

It displays only visible user text and visible assistant text. Markdown,
lists, and code blocks remain readable, but raw HTML, scripts, command links,
and unsafe resource links are not executed. The Webview uses a restrictive
content security policy and nonce-scoped scripts.

One attachment is represented as `[Attachment]` and multiple adjacent
attachments as `[N Attachments]`. In mixed input, neutral attachment labels
remain in provider source order beside the visible text. Local paths and raw
attachment metadata are not exposed.

Stopped sessions remain readable while their history exists. If a source is
deleted after content has been loaded, the viewer retains the in-memory
snapshot and labels it unavailable or stale rather than replacing it with an
empty view.

### Live update behavior

The Host watches the selected session's source for change signals and requests
fresh normalized data from the adapter.

- When the viewer is at the latest interaction and already at the bottom, new visible
  response content auto-follows.
- When the user is reading older content or has scrolled upward, the scroll
  position remains stable and a `New response content` affordance appears.
- Activating that affordance scrolls to and focuses the first newly appended
  visible message, then clears the pending indicator; it does not skip directly
  past new content to the bottom.
- A transient refresh failure retains the last successful snapshot with a
  stale indicator.

Closing the viewer returns focus to the originating marker when the same
session is still focused and expanded. Otherwise focus falls back to the
session card header, then the Active Sessions heading if that card no longer
exists.

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

`ConversationCoordinator` is extension-host scoped. It owns one lazily created
adapter instance per provider, selects adapters from the existing provider
registry, validates authoritative workspace/session identity, correlates
requests, applies public revision tokens, and reference-counts subscriptions.
Adapters and the Codex child process are disposed with extension deactivation.
Per-session subscriptions are disposed immediately when the card closes, the
viewer changes session or closes, the Webview is destroyed, or the session
leaves scope.

Multiple VS Code windows have separate extension hosts and therefore separate
coordinators. Each host has at most one Codex app-server child and one shared
provider change poller. Kimi and Claude access is read-only, so no cross-window
writer lock is needed; bounded polling prevents each expanded card from
creating another filesystem watcher.

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

`watch` is an invalidation signal, not a data transport. It is shared within
the adapter, coalesces changes for 250 ms, and never triggers more than one
refresh per session per second. The first release reuses the existing
provider-service three-second change polling, so ordinary event frequency is
lower than that ceiling. Every callback is tagged internally with its
subscription generation; a callback from a disposed or replaced generation is
a no-op.

`readOutline` returns only the fields needed by the sidebar:

- stable interaction identity;
- timestamp when available;
- normalized user-input grapheme count;
- normalized user-input preview, capped at 160 characters;
- whether the interaction may still be receiving a response.

`readPage` returns bounded visible messages around or after a selected
interaction, plus navigation cursors. The viewer requests additional pages as
needed; the Host does not send an unbounded transcript through one Webview
message.

The request contract is:

`requestId` is a positive safe integer scoped to the current Webview document;
zero, negative, fractional, and unsafe values fail closed.

```ts
interface ConversationRequestEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload: T;
}

interface ConversationResponseEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload?: T;
    error?: ConversationPublicError;
}

interface ConversationPublicError {
    code:
        | "unavailable"
        | "staleRevision"
        | "unsupportedVersion"
        | "tooLarge"
        | "timeout";
    retryAfterMs?: number;
}

interface ConversationPageRequest {
    provider: AiSessionProvider;
    sessionId: string;
    anchorInteractionId: string;
    direction: "around" | "before" | "after";
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
}

interface ConversationPage {
    provider: AiSessionProvider;
    sessionId: string;
    sourceRevision: string;
    anchorInteractionId: string;
    messages: ConversationMessage[];
    previousCursor?: string;
    nextCursor?: string;
    isStart: boolean;
    isEnd: boolean;
}
```

The Host clamps `limit` to 1–20 interactions, defaulting to 20, and additionally
applies the byte limits below. Cursors and revisions are opaque
coordinator-issued tokens, not encoded paths or byte offsets.

A cursor is valid only for the exact public revision that issued it. Revision
mismatch returns `staleRevision`; the viewer refreshes its outline, keeps the
closest stable interaction ID when it still exists, and never applies the stale
page.

Every normalized result carries provider, session ID, and source revision; its
protocol envelope carries request ID and subscription generation so callers can
reject mismatched or stale data.

`sourceRevision` is meaningful only inside an exact
`provider + sessionId + coordinator instance` scope. The coordinator maintains
the provider's real file signature or app-server observation privately and
exposes a non-sensitive monotonic token such as `r17`. It never orders or
compares revisions across providers. The Webview uses equality only after
provider, session, and request ID already match.

### Normalized model

The provider-specific adapters normalize into a model equivalent to:

```ts
interface ConversationOutline {
    provider: AiSessionProvider;
    sessionId: string;
    sourceRevision: string;
    interactions: ConversationInteractionSummary[];
}

interface ConversationInteractionSummary {
    id: string;
    providerTurnId?: string;
    timestamp?: number;
    userPreview: string;
    userGraphemeCount: number;
    responseState: "complete" | "inProgress" | "interrupted" | "unknown";
}

interface ConversationMessage {
    id: string;
    interactionId: string;
    role: "user" | "assistant";
    timestamp?: number;
    markdown: string;
}
```

`ConversationInteractionSummary.id` identifies the qualifying user input, not
necessarily a provider-native turn. Identities must remain stable when a source
is appended:

- Codex uses the structured `userMessage` item identity returned by app-server
  and retains the native turn ID separately;
- Claude derives identity from the qualifying message UUID;
- Kimi derives identity from session ID plus the original turn-begin byte
  offset and timestamp, not from message text.

The normalized model deliberately has no representation for reasoning, tools,
system messages, or logs. Exclusion happens inside the provider adapter before
data crosses the coordinator boundary.

When the authoritative lifecycle changes to `stopped`, an `inProgress`
interaction is reclassified as `interrupted` unless the provider supplies a
later completion record. The marker stops animating and the viewer labels the
response as interrupted without inventing completion text.

## Provider Data Sources

### Codex

The Codex adapter uses a lazily started local `codex app-server` child process
and its structured thread API. It reads the known session with
`thread/read(includeTurns: true)` and extracts user-message and visible
agent-message items.

Project Steward always starts its own child with the default
JSONL-over-stdio transport. It does not discover or connect to an app-server
used by a TUI, and it does not open a TCP port or Unix socket. The child
stdin/stdout pipes are owned by the extension host, which removes listener
conflicts and local network impersonation from this design.

The process is shared by Codex conversation requests in that extension host and
terminated when the extension is disposed. Requests are correlated and
time-bounded. On the first explicit Codex outline request, the adapter performs
the required `initialize`/`initialized` handshake without experimental
capabilities, records only a sanitized CLI major/minor version, and validates
the stable `thread/read` response fields before advertising the capability.
Schema generation is a development compatibility check, not a runtime write.

Project Steward does not parse Codex transcript JSONL as a fallback. Those
files are useful storage artifacts but are not treated as a stable public
interface. If app-server is absent, incompatible, or returns an unsupported
shape, the Codex outline reports a provider-specific unavailable state without
affecting Kimi or Claude.

The separately running Codex TUI does not share in-memory app-server state.
The Codex session service's existing change poller is therefore used only as an
invalidation signal; the structured `thread/read` response remains the content
authority.

### Kimi

The Kimi adapter reads the active session's
`~/.kimi/sessions/<workdir-hash>/<session-id>/wire.jsonl`.

The adapter does not reproduce this path or hash algorithm. A new read-only
source-resolution method on the existing `KimiSessionService` returns the exact
canonical `wire.jsonl` already associated with the hydrated session ID. That
service already honors `KIMI_SHARE_DIR`, reads configured work directories,
uses Kimi's current MD5 workdir mapping, and can locate a known session by
scanning existing hash directories. If a future Kimi layout is no longer
resolved by that service, conversation history is unavailable until the
provider service is updated; no guessed path fallback is used.

In Remote SSH, WSL, and Dev Container use, the extension code and
`os.homedir()` run on the active extension host. Consequently `~`, configured
provider homes, source validation, and file reads all refer to the same remote
environment in which the provider CLI runs.

It starts a turn only from a valid `TurnBegin` and extracts the visible
`payload.user_input`, which may be a string or an array of typed text parts.
Visible assistant text comes from qualifying content parts within that turn.
The adapter excludes:

- thinking or encrypted content;
- tool calls and tool results;
- subagent events;
- provider-internal records.

`TurnEnd` or an interruption boundary closes the current normalized turn.

A minimal sanitized shape used by contract fixtures is:

```jsonl
{"timestamp":1784073611,"message":{"type":"TurnBegin","payload":{"user_input":[{"type":"text","text":"Explain this change"}]}}}
{"timestamp":1784073612,"message":{"type":"ContentPart","payload":{"type":"text","text":"Visible response"}}}
{"timestamp":1784073613,"message":{"type":"TurnEnd","payload":{}}}
```

The fixture documents only fields Project Steward consumes; it is not treated
as a provider-owned public schema. Numeric Kimi timestamps below
`10_000_000_000` are epoch seconds and normalize to milliseconds, matching the
lifecycle reader; millisecond inputs remain unchanged.

### Claude

The Claude adapter reads the provider's top-level session JSONL selected by the
existing Claude session service.

As with Kimi, the adapter obtains the source through a new read-only resolver on
`ClaudeSessionService`, not by searching independently. Resolution uses the
hydrated session ID and workspace roots. If multiple canonical files contain
the same valid session ID, the service chooses the sole file whose parsed cwd
matches the active workspace. Zero matches or continued ambiguity fails closed
as unavailable.

A real user input must have the qualifying top-level user-message shape and
visible text content. Records that look like user messages but carry
`sourceToolAssistantUUID`, `toolUseResult`, or `tool_result` content are tool
results and are excluded.

The canonical user interrupt sentinel, `[Request interrupted by user]`, may be
string content or a text item in a content array. It creates no outline marker
or viewer message; it marks the current open interaction `interrupted`, matching
Claude lifecycle semantics.

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

On POSIX, the signature includes canonical path, device, inode, birth time,
size, and high-resolution modification time. Where stable device/inode data is
unavailable, including Windows filesystems, the fallback adds bounded first and
last chunk hashes to canonical path, size, and modification time. Platform
fixture tests verify both paths.

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
opens or updates the editor viewer at the requested interaction.

The Host does not trust provider names, labels, transcript paths, or interaction
content copied from the DOM. It accepts only a supported provider/session key,
resolves the source itself, and verifies that the requested interaction belongs to the
result returned for that session.

Closing a card, switching focus, changing workspaces, or issuing a newer
request synchronously disposes the session subscription and increments its
generation before changing the UI. Abortable reads receive an abort signal.
Filesystem work already inside an unabortable system call may finish, but its
generation and request ID can no longer publish data. A late result is
therefore a no-op.

Destroying the sidebar Webview disposes all card subscriptions and invalidates
all Webview-bound outline requests. Closing the editor viewer independently
disposes its page/live-update subscription and clears its snapshot. Shared
adapter instances remain available until extension deactivation, but retain no
viewer content after disposal.

### Webview state across refreshes

Expansion is ephemeral Webview state, not a persisted user preference.
Immediately before the synchronous `innerHTML` assignment in the authoritative
workspace update function, the Webview captures:

- expanded provider/session key;
- active internal tab identifier;
- marker rail scroll position;
- focused marker ID when applicable.

After replacement it restores that state only when the same session still
exists and remains focused. Otherwise all cards remain collapsed. A full
Webview reload intentionally starts closed.

Restoration never reuses old transcript HTML. It starts a fresh correlated
outline request and displays a fresh bounded loading skeleton.

Expansion class, dynamic height, chevron, and `aria-expanded` are applied by one
synchronous state function before the browser can paint. Restoration likewise
uses that function, preventing a visual/ARIA split state. A forced full reload
that cannot run the capture function deliberately closes the card, matching the
documented initial state.

Every loading skeleton belongs to a provider/session/generation triple. Stop,
refresh, collapse, and session removal either replace it with the matching
result or remove it synchronously; no unowned loading state survives an
authoritative update.

## Failure Handling

- A session that has stopped but still has history remains readable.
- A missing or archived source produces an unavailable outline; an already open
  viewer retains its last successful in-memory snapshot.
- A malformed JSONL line is skipped. A malformed provider structure is isolated
  to that adapter and surfaced as an unavailable state.
- File truncation, rotation, or replacement resets the incremental index.
- App-server process failure rejects its in-flight Codex requests. A later
  explicit request may restart it at most twice in a rolling 60-second window,
  with one- and four-second delays. During a permitted retry the card shows
  `Reconnecting to Codex…`; after the budget is exhausted it shows
  `Codex conversation history unavailable` with Retry disabled until the
  60-second window expires. There is no JSONL fallback.
- Rapid expand/collapse and session switching cannot commit stale responses.
- Empty valid history displays `No user inputs yet`, distinct from loading or
  failure.
- A missing stable `thread/read` method shows
  `Update Codex to view conversation history`. A handshake or response-schema
  mismatch shows `Installed Codex protocol is not supported` and directs the
  user to compare Codex and Project Steward versions. Both states include a
  Retry action and record only the sanitized installed major/minor version.
- Unsupported provider versions fail closed and do not trigger parsing of an
  undocumented alternate source.
- A cold JSONL scan has a five-second deadline and observes abort signals
  between chunks. A deadline produces a clearly labeled partial outline when
  complete interactions are available, otherwise unavailable; collapsing the
  card remains an immediate cancellation from the UI's perspective.

## Privacy, Security, and Bounds

- All source access is read-only and constrained to paths resolved by the
  existing provider session services. The Host resolves the configured
  provider home and candidate with `realpath`, requires the canonical file to
  remain beneath the canonical provider home, opens a file handle read-only,
  and verifies its identity with `fstat` before parsing. This is an
  application-layer constraint inside the extension host, not an OS sandbox.
- User and assistant text is escaped before it reaches generated HTML.
- Rendering uses repository-locked `markdown-it` with `html` and `linkify`
  disabled, followed by a repository-locked DOMPurify allowlist. The URL policy
  separately allows only intended `https:` links and blocks `javascript:`,
  `data:`, `file:`, `command:`, and unknown schemes. No renderer is loaded from
  a CDN; exact dependency versions are pinned in `package-lock.json`.
- Outline previews are capped at 160 grapheme clusters and escaped after
  truncation.
- One outline contains at most the most recent 2,000 interactions. A larger
  source displays `2,000+` and an explicit older-history omission.
- JSONL parsing considers at most the latest 64 MiB, reads 256 KiB chunks, yields
  to the extension-host event loop after each 4 MiB, and rejects an individual
  physical line larger than 1 MiB.
- One visible user or assistant message is capped at 64,000 grapheme clusters
  with a visible truncation marker.
- One page contains at most 20 interactions and 512 KiB of serialized Webview
  payload. The viewer retains at most 100 interactions or 4 MiB, whichever is
  reached first, evicting the farthest page while preserving the selected
  anchor.
- One Codex app-server response is capped at 64 MiB and every request has a
  ten-second deadline.
- Each provider retains at most eight inactive session indexes for ten minutes.
  There is one shared provider poller per extension host and one ref-counted
  logical subscription per viewed session.
- Oversized content is visibly truncated with an option to load another
  bounded page where appropriate; it is never silently interpreted as markup.
- Logs may include provider, bounded counts, duration, and an error category.
  They do not include user text, assistant text, absolute transcript paths, or
  a full session ID.
- Public `sourceRevision` and cursor tokens contain only coordinator-local
  opaque identifiers. Provider file paths, byte offsets, hashes, and native
  revision values never cross into the Webview protocol.
- The in-memory viewer snapshot is replaced on session change and cleared on
  panel disposal, extension deactivation, or explicit Reload. A stale snapshot
  is never retained after its viewer closes.
- Project Steward does not mutate provider files or persist a second full copy
  of the transcript.

## Testing

### Provider adapter tests

Sanitized fixtures for all three providers establish:

1. only real user inputs create outline markers;
2. multiple qualifying user messages inside one native provider turn still
   create separate interactions;
3. visible assistant text is grouped with the correct user interaction;
4. reasoning, system messages, tools, tool results, logs, subagents, and
   sidechains are excluded;
5. single, multiple, and mixed-content attachments do not reveal local paths;
6. stable interaction IDs survive appended content;
7. malformed lines are skipped;
8. truncation and replacement rebuild the incremental index;
9. unsupported structured data fails within one provider only;
10. repeated streaming snapshots or deltas do not duplicate visible content;
11. grapheme-safe preview and length rules handle CJK, emoji, and combining
    marks;
12. oversized lines, messages, files, app-server responses, and pages enforce
    their documented limits.

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
- a deliberately throwing adapter and a malformed-response adapter do not
  affect successful requests through either other provider;
- watch invalidations are coalesced, rate-limited, generation-scoped, and
  ignored after disposal;
- file append refreshes an outline within the existing provider polling
  interval, while a disposed watch triggers no callback;
- Webview and viewer disposal clear subscriptions, pending publications,
  and snapshots; extension deactivation additionally clears adapters and the
  app-server process;
- app-server handshake mismatch, request timeout, restart backoff, restart
  budget, and final unavailable state are deterministic.

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
- state restoration after authoritative HTML replacement when the session
  remains active, becomes stopped, gains an interaction, or changes provider
  identity;
- safe collapse when the focused session disappears.

### Viewer tests

Tests cover:

- reuse of one `AI Conversation` editor view;
- exact anchoring and highlighting of the selected interaction;
- Previous, Next, and Latest navigation;
- dynamic `Input X of Y` counts and the `2,000+` partial-outline form;
- bounded page loading;
- Markdown and code rendering with unsafe HTML and links disabled;
- hostile `<script>`, event-handler, `javascript:`, `data:`, `file:`, and
  `command:` fixtures remain inert after both rendering and sanitization;
- exclusion of private and internal provider content;
- retained stale content after a read failure;
- auto-follow only at the latest bottom position;
- stable historical scroll with a new-content affordance that focuses the first
  new message;
- focus restoration to marker, card, or panel heading after viewer disposal.

### Performance and platform tests

The synthetic 10 MiB/1,000-interaction fixture enforces the cold, incremental,
cached-render, payload, and memory budgets under Success Measures. Additional
fixtures exercise a 64 MiB scan boundary, more than 2,000 interactions,
repeated poll invalidations, index reset, and cancellation during rebuild.

Deterministic parser tests run with POSIX and Windows path/signature fixtures.
Windows CI exercises the fallback signature and provider-home resolution.
Scheduled macOS verification exercises native device/inode behavior. Remote
SSH, WSL, and Dev Container tests use an extension-host home distinct from the
UI-side home and prove that only the extension-host provider source is read.

### Security tests

Tests inject unsupported providers, malformed and traversal-shaped session IDs,
ambiguous Claude sources, symlinks that escape the provider home, replaced
files between resolution and open, opaque-token forgeries, oversized physical
lines, and hostile Markdown. Each request must fail closed without echoing
private content or absolute paths into the UI or captured logs.

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
- Codex uses a private stdio child with bounded restart behavior; Kimi and
  Claude obtain canonical sources from their existing provider services in the
  active extension-host environment.
- The documented source, page, message, memory, timeout, polling, cache, and
  performance limits have automated boundary evidence.
- Viewer disposal clears sensitive snapshots and restores keyboard focus
  predictably.
- Existing Active Session focus, terminal behavior, lifecycle tracking,
  History, and provider isolation do not regress.
