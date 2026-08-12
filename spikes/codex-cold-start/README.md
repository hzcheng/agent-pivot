# Spike: Codex app-server cold-start pagination (0.147.0)

Read-only probe assessing whether `thread/turns/list` can replace the cold-start
full `thread/read` for large Codex sessions (Phase 3 of the
conversation-loading incrementalization work, after PR #227 stat-signature
cache and PR #228 incremental paginated reload).

Scripts (run with `node`, require a real `codex` 0.147.0 on this machine):

- `probe.js` — summary-vs-full shapes, big-session walks, thread/read pain,
  `thread/resume` bootstrap surface.
- `probe2.js` — cursor portability across limit/itemsView, summary text
  fidelity.
- `probe3.js` — per-turn summary-vs-full projection divergence census
  (finds the summary agentMessage unreliable).

## The pain (re-confirmed)

| Session | Backend | `thread/read` cold start |
|---|---|---|
| 183MB / 213 turns (`019fe66d…`) | paginated (sqlite projection) | **40.6s / 52.4MB** — exceeds the 10s client timeout, so the session cannot be opened at all |
| 60MB / 503 turns (`019f1c4a…`) | legacy (replay per call) | ~1.05s (tolerable today) |

`thread/read` always transfers the whole history in one JSONL frame regardless
of backend, so the paginated backend does NOT rescue cold start on its own.

## Walk timings (183MB paginated session, this machine)

| Operation | Time | Bytes |
|---|---|---|
| tail page, 25 turns, summary | 31ms | 59KB |
| **full summary walk, asc limit 100 (all 213 turns)** | **111ms / 3 pages** | **331KB** |
| full-items walk, asc limit 25 (all 213 turns) | 5.5s / 9 pages | 52.4MB |
| seek: recorded page cursor → limit 4 full | 23.8ms | 474KB |

Legacy 60MB session: summary walk 3.7s (6 pages × ~600ms replay — every page
replays the whole rollout), tail 25-turn full page 573ms. Cold-start paging is
therefore only attractive on the paginated backend; legacy stays on the plain
`thread/read` path (its cost is identical to what the reload path already pays,
and legacy sessions are a shrinking, pre-0.147 population).

## Summary view shape (verified)

- Per turn the summary view returns exactly 2 items: the `userMessage`
  (`{type,id,content,clientId}`) and the **final** `agentMessage`
  (`{type,id,text,phase,memoryCitation}`). Turns without a user message simply
  omit it. Turn-level fields (`id, status, error, startedAt, completedAt,
  durationMs`) are present in both views.
- **User-side text fidelity: verbatim.** Summary userMessage text ===
  full userMessage text — every outline input (userPreview, timestamp,
  responseState) is present. The **final agentMessage is NOT reliable**:
  the summary omits it for interrupted turns, and 1 of 213 completed
  turns diverged in text (probe3 on the 183MB session: 9/218 turns
  agent-side mismatches, all interrupted + one completed; user side and
  turn-level fields identical everywhere). Consequence: skeletons and
  summary fingerprints must derive only from turn fields + first
  userMessage; content changes are still caught by the stat epoch and by
  full-chunk fingerprints for materialized turns.
- One turn in a `turn/start`-created thread had no userMessage at all (in
  both views) — do not assume every turn has one. Multi-userMessage turns
  exist (3 steering messages in one turn of the 183MB session); the
  summary collapses them to the first.

## Cursor portability (the linchpin for on-demand materialization)

- A `nextCursor` recorded during a `limit:100` summary walk can be reused with
  a **different limit and itemsView**: re-requesting with `limit:4,
  itemsView:"full"` seeks to the exact same turn boundary and returns items
  **byte-identical** to the full walk (`itemsIdenticalToFullWalk: true`).
- So a cold start can record one cursor per summary page boundary and later
  materialize any window of turns with a single ~25ms seek.

## `thread/resume` bootstrap surface (verified shape, not adopted)

- `thread/resume {threadId, excludeTurns:true, initialTurnsPage:{limit,
  sortDirection, itemsView}}` returns `thread.turns: []` plus
  `initialTurnsPage: TurnsPage` and (when older history exists)
  `turnsBackwardsCursor` — an opaque head cursor for desc hydration.
  140ms / 2.4KB on the small session.
- Not needed for the adapter: driving `thread/turns/list` directly gives the
  same bootstrap with fewer experimental params and identical page semantics.

## Feasibility verdict for Phase 3

1. **Windowed cold start is viable and transformative for paginated
   sessions**: skeleton interactions for all turns from one summary walk
   (~111ms for 213 turns) + full items only for the initial viewer window
   (~25ms per 4-turn seek; one viewer page ≈ 20 turns) replaces a 40.6s
   `thread/read` with **well under 1s** of RPC.
2. On-demand materialization (`readPage` on a skeleton anchor) is one cursor
   seek away and returns full-view-identical items — no fidelity loss.
3. Gate on the same version allowlist + slow-page legacy detector as PR #228;
   legacy/slow → keep today's full `thread/read` cold start.
4. Revision stability across materialization: materializing a skeleton must
   NOT change the conversation revision (otherwise every scroll-up looks like
   a concurrent edit and invalidates retained pages). Compose the revision
   from per-turn summary-level fingerprints (turn id, status, timestamps,
   error, user text, final agent text) — computable identically from raw turns
   on both the windowed and the full-read paths.
