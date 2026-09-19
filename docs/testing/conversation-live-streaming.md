# Live conversation output

The conversation viewer preserves the existing terminal/tmux launch, input,
approval, and reconnect workflow. It does not generate turns itself.

## Sources and limits

- Codex: on Unix hosts, attach to the existing local shared app-server socket
  under `CODEX_HOME/app-server-control/app-server-control.sock`. Check
  `thread/loaded/list` before joining with `thread/resume`, without configuration
  overrides. Consume item start/completion, agent-message deltas, and turn
  lifecycle notifications. Never launch a daemon, send a turn, or answer approval
  requests. Unsupported/missing daemons fall back to durable history.
- Kimi/Claude: watch the visible transcript at 150 ms intervals, independently of
  the slower all-session discovery poll. This exposes content as soon as the CLI
  persists it; it cannot reconstruct tokens absent from that CLI's transcript.
- Publication coalesces bursts, waits for the preceding publication to settle,
  and uses a 100 ms completion floor for live updates. Ordinary discovery keeps
  its existing slower throttle.

The Codex feed retains at most two recent turns per subscription, eight watched
sessions, a 4 Mi-character tail, and a 64 MiB incoming WebSocket frame. Budget
failures disable the live connection for that subscription instead of repeatedly
pulling an oversized history. Disconnects clear the transient overlay and trigger
an authoritative history refresh. Missing transports retry while watched;
unsubscribing releases sockets and timers. Turn/item completion replaces partial
text rather than appending it again.

Joining in the middle of an already-started item may miss its prefix: no suffix
is shown without its item start. The completed item restores the complete text.
Windows currently uses the durable-history fallback.

## Real protocol evidence (2026-09-19)

Host: reddev-container, Codex CLI 0.155.0, shared app-server 0.154.0.
The Unix socket requires a WebSocket HTTP upgrade; it is not raw JSONL.
The existing private stdio app-server only supplies persisted history and cannot
receive another client's token deltas.

A disposable test conversation, with read-only sandbox and no tools, exercised
separate producer and observer connections. The observer received agent-message
deltas while the original client remained attached. Mid-generation `thread/read`
contained the user item but no partial agent text. An initial two-turn page on
resume was 2060 bytes but omitted even the in-progress user item; the live feed
therefore uses the bounded full resume response to seed the current turn.

The compiled feed plus production conversation adapter were then run against a
real test turn. They observed 317 notifications, produced 272 pre-completion
snapshots containing assistant text, and converged to exactly 691 characters
(the expected sequence of integers 1 through 200). The test thread was archived.
A second probe attached while idle, then began the next turn through the original
client. It observed 198 in-progress snapshots and retained the preceding two-character
reply plus all 291 characters of the new reply. This covers the normal workflow
of leaving the conversation viewer open before submitting another prompt.
No existing user thread was prompted, interrupted, or reconfigured by the probe.

Contract coverage includes live-to-final reconciliation, unloaded-thread fallback,
disconnect, response/delta ordering in a single receive batch, oversized-tail
circuit breaking, replacement-subscription disposal, transcript append/disposal,
and coalesced publication with an in-flight refresh.

## Verification

- Focused adapter/coordinator/transport tests and the 230-test local conversation
  browser suite passed.
- The full Linux CI command exited successfully: 1501 unit, 1384 contract,
  509 integration, and 545 browser tests passed, followed by architecture,
  behavior, performance, release packaging, and coverage checks. Changed-line
  coverage: 92.20% (319/346).
- Known pre-existing harness limitation: `run-ai-session-safety-checks.js` exits
  zero without its final success banner in the terminal-binding fixture, as
  already reproduced on the clean base during the preceding switching work.
  The aggregate exit code is therefore not evidence that every assertion in
  that individual script executed. Runtime binding/persistence was not changed
  here; the focused conversation tests above completed with explicit totals.
