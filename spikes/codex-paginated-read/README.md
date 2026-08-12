# Spike: Codex app-server paginated history reads (0.147.0)

Read-only probe assessing whether `thread/turns/list` / `thread/items/list`
can replace full `thread/read` reloads for large Codex sessions
(Phase 2 of the conversation-loading incrementalization work).

Scripts (run with `node`, require a real `codex` 0.147.0 on this machine):

- `probe.js` — gating, pagination semantics, shape identity, timing, live turn.
- `probe-followup.js` — 175MB-session scaling + 62-turn shape identity.
- `probe-diff.js` / `probe-diff2.js` — item-level diff of the two mismatched turns.

## Protocol surface (verified against openai/codex @ rust-v0.147.0 source)

- `thread/turns/list` exists and works; params
  `{threadId, cursor?, limit?, sortDirection? = desc, itemsView? = summary}`,
  response `{data: Turn[], nextCursor?, backwardsCursor?}`.
  `itemsView: "full"` embeds complete `ThreadItem`s per turn, so
  `thread/items/list` is not needed for incremental reads.
- `thread/items/list` is **not implemented** in 0.147.0
  (`method_not_found("thread/items/list is not supported yet")`).
- Both methods are **`#[experimental]`-gated**: the client must send
  `capabilities.experimentalApi: true` in `initialize`, otherwise the server
  rejects with `-32600 "thread/turns/list requires experimentalApi capability"`
  (clean, detectable; verified in probe phase A).
- `backwardsCursor` + `sortDirection: "asc"` re-includes the anchor turn —
  documented and verified mechanism to catch updates to the newest
  (e.g. in-flight) turn.
- `thread/resume` has experimental `initialTurnsPage` / `turnsBackwardsCursor`
  for cold-start paging (not probed).
- Errors: before the first user message, `thread/turns/list` fails with
  `-32600 "... is not materialized yet ..."` (verified in phase F).

## Server-side cost model (the decisive finding)

`thread/turns/list` has two backends, chosen by the session's
`history_mode` (set at session creation by the writing codex):

| Session kind | Backend | Cost per call | Measured |
|---|---|---|---|
| `Paginated` (written by current codex, indexed in `~/.codex/thread_history_1.sqlite` with rollout byte offsets) | sqlite projection, true O(page) seeks | **flat, independent of history size** | **21.8ms / 7.1ms on the 175MB session** |
| `Legacy` (pre-index rollouts) | full rollout replay **on every call** | O(history), ~10ms/MB | ~600ms flat on the 60MB session (limit 1 = limit 25 = 601–668ms) |

Only `019fe66d…` (175MB, written 2026-08-09) has rows in
`thread_history_1.sqlite`; the July sessions do not. Actively-streaming
sessions going forward are exactly the paginated kind.

## Measured timings (this machine, real sessions)

| Operation | 60MB / 503 turns (legacy) | 175MB / 211 turns (paginated) |
|---|---|---|
| `thread/read` full | 1050–1203ms (6.1MB response) | **37960ms (51.4MB response)** |
| `turns/list` tail page, 1 turn, full items | ~601–612ms (4KB) | **21.8ms (1.6KB)** |
| `turns/list` 25 turns, summary | ~590ms (29KB) | — |

Adapter-level context: the full pipeline (RPC + parse + normalize +
fingerprint) for a ~50MB session was ~3.1s; with a tail-page read the
post-RPC work drops to ~0 (KBs), so a refresh becomes ~25ms for paginated
sessions — **~3 orders of magnitude, and it makes live-following a 175MB
session feasible at all** (today each refresh costs ~38s of RPC alone).
For legacy sessions the gain is only ~1.7–2× (server still replays), but
the stat-signature cache from PR #227 already covers the unchanged case.

## Shape identity (turns/list full vs thread/read)

- Small session (1 turn) and medium session (62 turns): item type sequences,
  turn ids, statuses all match; **deep-equal except 2 items**, both of which
  are **`thread/read` replay corruption**: multibyte UTF-8 split across
  streamed chunks surfaces as U+FFFD runs in `thread/read` output, while the
  `turns/list` paths return the correct text (e.g. `新` → `��`).
  So `turns/list` is equal-or-more-correct, not merely equal.
- Pagination integrity verified: no overlap across `nextCursor` pages,
  total turn count via paging (503) matches, `backwardsCursor` re-includes
  the anchor turn.

## Live turn (phase E, fresh thread via `thread/start` + `turn/start`)

- Notification stream works over stdio: `turn/started`, `item/started`,
  `item/agentMessage/delta`, `item/completed`, `turn/completed`,
  `thread/status/changed`, `thread/tokenUsage/updated`.
- `thread/turns/list` (desc, limit 1, full) shows the **in-flight turn**
  immediately; polling observed items growing 0 → 1 → 2 and status
  `inProgress → completed`. (Server merges the live `ThreadState` snapshot
  for threads loaded in-process; for threads owned by another process the
  paginated path reads the WAL sqlite projection.)

## Feasibility verdict for Phase 2

1. **Viable and transformative for paginated sessions** (all sessions written
   by codex ≥ the projection-DB era): tail-page reads are flat ~7–25ms
   regardless of history size. Design: stat-signature gate (PR #227) → on
   change, fetch tail page via `backwardsCursor` (re-reads the in-flight
   turn); if the anchor turn id unexpectedly changed (compaction/rollback),
   fall back to a full re-read. Per-turn fingerprints compose into the
   existing opaque revision string.
2. **Requires opting into `experimentalApi`** — a deliberate deviation from
   the repo's current policy. Mitigations: detect `-32600` and any shape
   anomaly → fall back to `thread/read` + stat cache; gate by the server
   version reported at `initialize`.
3. **Cold path can additionally page** (`summary` view ≈ outline data,
   `initialTurnsPage` on resume), but that multiplies the experimental
   surface — keep as a separate decision.
4. `thread/items/list` cannot be relied on (unimplemented in 0.147.0).
