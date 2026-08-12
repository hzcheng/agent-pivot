---
name: developing-provider-conversation-adapters
description: Use when adding or changing AI provider (Kimi/Claude/Codex) session or conversation parsing in this repository, including subagent or transcript support, status inference, or onboarding a new provider.
---

# Developing Provider Conversation Adapters

## Overview

Provider session formats are undocumented and version-drifting. Self-authored
fixtures embed the same layout guess as the code under test, so both can be
wrong together while every contract test passes.

**Core rule:** before committing adapter changes, run the compiled adapter
against real on-disk provider data and compare the output with ground truth.
Green self-authored fixtures alone are not evidence.

## Workflow

1. **Probe real data first** — never derive the format from assumptions,
   docs, or a sibling provider's layout:
   - census record shapes: `type` distribution, field presence per record
     kind, single-record size bounds
   - for a framed protocol, record the sanitized full response byte size and
     duration of a valid large live response, verify it remains below a
     bounded transport cap, and never infer response size from source-file size
   - find lifecycle markers (start / finish / interrupt) and cross-file
     links (toolUseId, promptId, sidechain flags)
   - detect continuation records (distinct promptIds, injected user turns)
2. **Mirror the real layout in fixtures** — fixtures derive paths the same
   way production code does and match the observed directory tree exactly.
   A fixture that invents a simpler layout is a self-consistent trap.
3. **Verify against real data before commit** — point a throwaway script at
   the compiled `out/` adapter with `resolveSource` returning a real session,
   run the new read path, and eyeball the results against the files on disk.
4. **Preserve the Codex adapter boundary** — its full relative-import graph,
   including type-only imports, is architecture-guarded. Inject filesystem or
   rollout telemetry readers through `composition.ts`; keep the adapter option
   as a local structural type. After changing this import graph, run
   `npm run test:architecture-guards` before the full gate.
5. Then the standard gates: focused owner tests,
   `npm run test:behavior-contracts`, `npm run test:ci:linux`.

## Current On-Disk Layouts (re-probe before relying)

| Provider | Session source | Subagents |
|---|---|---|
| Kimi | `<kimiHome>/sessions/<workdirHash>/<sessionUuid>/wire.jsonl` | `<sessionDir>/subagents/<id>/{meta.json,wire.jsonl}`; meta carries explicit `status` + `created_at`. The Shell tool is **stateless per command** — every invocation runs with `cwd = session.work_dir` (kimi_cli/tools/shell source), so relative `cd` targets resolve against the session workdir, not the previous command |
| Claude | `<claudeHome>/projects/<slug>/<sessionId>.jsonl` | `<slug>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}`, flat across spawnDepths; meta has `agentType`/`description`/`spawnDepth`/`toolUseId` but **no status** — infer from the transcript tail plus mtime; SendMessage resumes arrive as `origin.kind === 'coordinator'` user records |
| Codex | rollout JSONL under `<codexHome>/sessions/YYYY/MM/DD/`; conversation content is app-server-only (`thread/read`); incremental reloads of large cached root threads page the tail via `thread/turns/list` (experimentalApi-gated, version-allowlisted, full-read fallback — surface probed in `spikes/codex-paginated-read/`) | Independent rollout files per thread; `session_meta.payload.source.subagent.thread_spawn` carries `parent_thread_id`/`depth`/`agent_nickname`/`agent_path`; discovery scans first lines by parent id; `thread/read` accepts subagent thread ids (verified 0.146); no userMessage in subagent threads — seed the dispatch interaction from metadata; status = last `event_msg` is `task_complete` → finished, else mtime freshness |

Codex app-server 0.147+ answers `initialize` without `serverInfo`: the
server version rides in the `userAgent` product token
(`<originator>/<major.minor.patch> …`). Version-gated protocol features
must parse it from there — stub handshakes that keep the old `serverInfo`
shape pass every test while the real server leaves the gate permanently
off.

Subagent transcripts reuse the provider's main record envelope; Claude
subagent files consist entirely of `isSidechain: true` records, so any
main-conversation sidechain filter must be relaxed for subagent sources.

## Status Inference Without An On-Disk Status

When the format records no status (Claude and Codex today), derive it from
the transcript tail:

- last lifecycle signal means finished — Claude: last record is an
  assistant message without tool_use; Codex: last `event_msg` is
  `task_complete`
- anything else → running only while the file mtime is fresh (5 minutes);
  a crashed CLI leaves a stale mid-turn transcript behind → failed

Read bounded head/tail windows (a single record can exceed 200KB); never
scan whole transcripts in the listing path.

## Codex App-Server Pagination Facts (0.147, probe-verified)

From `spikes/codex-paginated-read` and `spikes/codex-cold-start`:

- `thread/turns/list` summary view carries the **first** userMessage
  per turn (projection schema: `thread_turns.first_user_item_id`),
  **verbatim** — plus a final agentMessage that is UNRELIABLE: omitted
  for interrupted turns and divergent in ~1/218 real turns. Never derive
  fingerprints from the summary agent text. Multi-userMessage turns exist
  in real data (mid-turn steering messages) and collapse to their first
  message in summary view — never assume one user message per turn.
- Page cursors are **portable across `limit` and `itemsView`**: a cursor
  recorded on a `limit:100` summary walk seeks the same turn boundary
  with `limit:4, itemsView:"full"` and returns items byte-identical to
  the full walk.
- Item ids are NOT reliably turn-scoped while a session is live: a
  response-spanning item (e.g. a reasoning block) can be projected into
  different turns by fetches taken at different times (observed on a real
  183MB session). Treat cross-turn id collisions between separately
  fetched pages as a mixed-epoch signal (invalidate + re-read), never as
  a protocol violation — circuit-breaking on a transient kills the
  accelerator.
- Version gates need the **completed handshake**: `serverInfo.version` /
  `userAgent` parsing only has a value after `initialize` returns, which
  the first `request()` triggers. Any feature gate evaluated before the
  first request is circular — expose an async `ensureReady()` that
  attaches to the shared in-flight handshake.
- Handshake cost contaminates first-page latency (~300ms vs ~20ms steady
  state). Backend verdicts (paginated vs legacy replay) must exclude it
  and tolerate single-page jitter (e.g. verdict only after two
  consecutive slow pages).
- The extension-host viewer skips refreshes whose revision, interaction
  ids, and responseStates are all unchanged. Adapter revisions must
  therefore move on **any** provider content change — including
  summary-invisible tool output — or the webview never re-reads the page.

## Incremental Cache Concurrency

Kimi and Claude adapters keep a per-session incremental index
(`nextOffset` + parsed interactions) and commit it **in place**. Warmup,
telemetry polls, watch refreshes, and authoritative clicks all call
`load()` concurrently, so an unguarded check-then-act across the
continuation hash await lets a racing load flip `continuing`, re-read a
file suffix as if it were the whole file, and write the truncated index
back with an end-of-file offset — the session then reports empty
forever while every later click refreshes the poisoned entry's TTL.
Serialize `load()` per session id (a trailing promise chain that
survives rejections) so every read observes a fully committed entry.
Regression-test with staggered concurrent waves (0..N `setImmediate`
ticks apart) of mixed `readOutline`/`readSnapshot`/`readTelemetry` after
each append, then compare against a cold-read truth adapter — the flip
window is only a few event-loop ticks wide, so unserialized code fails
within the first waves while the serialized fix is deterministically
green. Record `lastReadContinuation` on the entry and expose
`getCacheDiagnostics` so an empty follow is diagnosable from the local
log without raw identifiers.

## Page-Budget Convergence and Endpoint-Less Turns

Per-field caps (64k-grapheme messages, 4k tool details) do NOT bound an
interaction's aggregate size: 100+ tool calls or merged thinking runs sum
past `maxPageBytes`, and `buildConversationPage` used to have no
in-interaction lever — it threw `tooLarge` and the whole conversation
reported unavailable. Converge inside the interaction instead: keep the
user message and the latest assistant/plan/question endpoints, truncate
only allowlisted content fields (`markdown`/`text`/`detail`/`question`/
`label`/`description`/`otherLabel` — never tool names, diff paths, plan
file paths, or outcomes), insert an explicit omission notice, and
backfill the tail greedily. Two calibration lessons from real incident
data: (1) size synthetic oversized fixtures empirically — per-field caps
shrink naive fixtures below the page budget (130 capped 4KB tool details
≈ 504KB < 510KB; 160 needed), so measure the built block before trusting
a RED; (2) real sessions contain complete turns with NO
assistant/plan/question message at all (orchestrator turns whose content
lives in provider events the adapter skips) — endpoint preservation must
fall back to the turn's last message or those turns render as a bare
omission.
