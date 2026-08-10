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
| Codex | rollout JSONL under `<codexHome>/sessions/YYYY/MM/DD/`; conversation content is app-server-only (`thread/read`) | Independent rollout files per thread; `session_meta.payload.source.subagent.thread_spawn` carries `parent_thread_id`/`depth`/`agent_nickname`/`agent_path`; discovery scans first lines by parent id; `thread/read` accepts subagent thread ids (verified 0.146); no userMessage in subagent threads — seed the dispatch interaction from metadata; status = last `event_msg` is `task_complete` → finished, else mtime freshness |

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
