# Live conversation output

## Codex terminal ownership

On Unix hosts, new and resumed Codex terminals launched by Agent Pivot use a
terminal-owned companion app-server and the original Codex TUI connected through
`--remote unix://`. The packaged `dist/codexTerminal.js` runner owns the server
for the lifetime of that terminal, independently of the extension host. Existing
running terminals must be closed and reopened once to use this launch path.
Reloading the extension alone cannot migrate an already-running ordinary CLI.

The TUI remains responsible for prompts, approvals, and turns. A private local
WebSocket relay observes successful non-ephemeral `thread/start`, `thread/resume`,
and `thread/fork` replies to identify the terminal's selected root. Ephemeral
naming helpers and the conversation viewer's separate observer connection cannot
rebind the terminal. Every root selection preserves and verifies the Agent Pivot
working directory and all runtime workspace roots. Initial explicit resume
permission choices travel in the resume request because the remote TUI rejects
those command-line flags.

Private run metadata links the selection to the wrapper PID and process start
identity. Pending terminal matching waits for this exact selection; tmux discovery
also requires the wrapper to belong to the pane process tree. Per-session socket
records let the conversation feed follow this companion instead of an unrelated
shared daemon. Normal exit, SIGHUP, SIGTERM, startup cancellation, and companion
failure clean up owned records and sockets. A hard kill of the wrapper is not a
guaranteed companion cleanup path; stale PID records are rejected by readers.

`codex app-server` rejects `--profile` outright, and a remote-mode TUI never
sends the profile's `model_provider` to the server — so a `-p` launch flattens
its profile-v2 file (`<CODEX_HOME>/<name>.config.toml`) into top-priority `-c`
overrides on the companion. Values pass through verbatim; the TUI keeps its
original `-p` flags for its own local config and ships the profile's model and
reasoning settings in `thread/start`. A legacy `[profiles.<name>]` table in the
base config.toml is selected on the companion through `-c profile="<name>"`.
Profiles using constructs a flat `-c` list cannot express (arrays of tables,
quoted key segments) still fall back to ordinary CLI behavior with the explicit
notice, as do unsupported CLIs and Windows. The managed path was verified with
Codex 0.155.0 on reddev-container; capability probing requires Unix remote
transport, and mismatched workspace-root responses stop the launch rather than
silently continuing in another scope. The launch's own directory scope is
applied after profile overrides, so a profile can never widen the requested
workspace roots.

## Conversation sources and limits

- Codex joins loaded threads through the managed socket, or an existing shared
  app-server socket when no managed run exists. It consumes item and turn events
  plus assistant text deltas. The viewer never sends a turn or answers approvals.
  An ordinary standalone CLI is not loaded in that shared daemon, so creating a
  new ordinary terminal alone does not enable streaming.
- The live overlay replaces durable tail-turn content by turn id, but pins every
  emitted interaction id per (session, turn, position): an interrupted turn's
  in-memory view carries synthetic per-turn item ids (`item-1`, …) while the
  rollout replay exposes the real server ids. Without pinning, the first live
  overlay after opening a chat with an interrupted tail turn flips the
  interaction id, the viewer's anchored selection vanishes from every later
  outline, and its refresh gate fails closed — live deltas keep arriving but
  never render. Pins prefer the id already emitted (durable base first) and
  re-apply to durable reloads after a turn leaves the live tail window.
- Kimi and Claude watch the visible transcript every 150 ms independently of
  slower session discovery. They expose text when the CLI persists it; they
  cannot reconstruct tokens absent from the transcript.
- Publication coalesces bursts and waits for in-flight refreshes, with a 100 ms
  completion floor for live updates. Ordinary discovery keeps its slower throttle.

The Codex feed retains at most two recent turns per subscription, eight watched
sessions, a 4 Mi-character tail, and a 64 MiB incoming WebSocket frame. Budget
failures disable the connection for that subscription. Disconnects clear the
transient overlay and refresh authoritative history. Missing transports retry
while watched; unsubscribing releases sockets and timers. Completed items replace
partial text without appending duplicates. If attachment misses an item's start,
a suffix is not displayed as a complete message; item completion restores it.
A resume snapshot taken mid-turn omits the already-started agentMessage item
entirely, while later deltas carry its real id — the feed synthesizes the item
from the method-scoped delta, and retains the last in-flight text per (session,
turn) across detach/reattach so a session switch away and back no longer drops
everything already streamed. Seeded-but-never-confirmed items are dropped when
the turn completes, and the retained record is discarded with it.

## Real remote evidence (2026-09-19)

The two reported failing chats were ordinary CLI sessions absent from the shared
server's loaded-thread list. The installed extension was current, so stale bytes
were not the cause. A shared-server producer test demonstrated only its transport,
not the user's terminal workflow. Native TUI recording and targeted diagnostic
logs did not contain the required text deltas and were not enabled in user config.

Isolated probes on reddev-container used the actual Codex 0.155.0 TUI, compiled
managed runner, production live feed, conversation adapter, and process-tree root
observer. All prompts requested integers 1 through 300 without tools, under
read-only sandbox and `never` approval policy. No user chat was interrupted,
prompted, or reconfigured.

| Actual terminal launch | Pre-completion snapshots | Final assistant characters |
| --- | ---: | ---: |
| New | 300 | 1091 |
| Resume the same probe thread | 284 | 2182 across both turns |
| New with an additional workspace root | 297 | 1091 |
| `/new` inside a running multi-root TUI | 193 | 1091 |

Each probe verified the requested effective directory, full root scope, root
identity, and cleanup after terminating its own wrapper. Final text matched the
expected sequence exactly. These results establish provider-to-adapter streaming;
the browser contract separately verifies successive visible assistant updates
before completion and a single final response.

## Managed-path failure investigation (2026-09-20)

The first shipped managed path stalled on real chats whose tail turn had been
interrupted: refreshes republished unchanged content while deltas arrived.
Sanitized diagnostics added for this investigation (feed connect/loaded/ready/
first-delta/close, live-merge failures, viewer refresh-gate failures) located
the drop at the viewer's selection gate. Direct companion probes then showed the
interrupted turn's in-memory items use synthetic `item-N` ids while the rollout
replay uses server ids, flipping the overlay's interaction id. Pinning (above)
fixed it: with an interrupted tail turn present, a real injected turn streamed
95 growing refreshes with zero gate failures in the production extension.

Fixtures for this path must model both item-id dialects for interrupted turns;
the contract test derives both shapes from the same turn.

## Automated verification

Contract fixtures exercise actual wrapper child processes and WebSocket sockets:
new/resume/multi-root launch, `/new`/resume/fork root transitions, helper isolation,
exact pending matching, partial-to-final reconciliation, unsupported/profile
fallback, startup failure, cancellation during listen, and invalid root responses.
Metadata tests cover private files, stale process identities, and pane ownership.
Feed tests cover ordering, disconnect, unloaded threads, bounded tails, and
subscription replacement. Browser tests cover incremental display without final
response duplication.

The complete Linux CI command includes behavior, deterministic tests, browser,
performance, architecture, safety, release packaging, and coverage gates.
Known baseline limitation: `run-ai-session-safety-checks.js` exits zero without
its final success banner in the terminal-binding fixture, reproduced on clean
`origin/main`. Its exit code alone does not prove every assertion executed;
focused binding and launcher tests have explicit completed totals.
