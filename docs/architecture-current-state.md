# Agent Pivot: Current Architecture State

> **Stale.** This document is classified as historical by the Stage 1A census
> (2026-08-17). Its hand-maintained counts are disproven (src is ~114k lines,
> not 69k; `dashboard.ts` is 4,063 lines, not 1.9k). Authoritative census data
> lives in `docs/architecture/stage-1a-census.md`. The module map and backlog
> below are kept for historical reference only.
>
> Historical note: last reconciled against `main` at 1.0.3 (2026-08, PR #129).
> Update this file when module ownership moves, when a work line completes, or
> when the backlog changes. The historical plan it supersedes is
> `docs/optimization-plan.md` (archived, with an epilogue mapping plan items to
> landed PRs).

## Module Map

`src/` totals ~69k lines of TypeScript/JavaScript. Ownership by directory:

| Area | Size | Owns |
| --- | --- | --- |
| `aiSessions/` | 122 files, ~31.4k lines | AI session runtime: tmux backend/discovery/binding store (`tmuxRuntimeBackend.ts`, `tmuxRuntimeDiscovery.ts`, `tmuxRuntimeBindingStore.ts` + `tmuxBindingRecords.ts`), runtime capabilities (`*Capability.ts`, factory + injected options, the #92 pattern), conversation viewer (`conversation/`), attention pipeline (`attention*.ts`), notifications (`notify/`), lifecycle readers |
| `webview/` | 39 files, ~15k lines | Sidebar webview content (`webviewContent.ts` + `webviewAiSessionContent.ts`) and behavior scripts (`webview*Scripts.js`, mirrored byte-for-byte into `media/`, guarded by WEBVIEW-ASSET-IDENTITY-001) |
| `services/` | 11 files, ~4.9k lines | Provider session services (codex/kimi/claude), legacy project services; `ntc.ts` is vendored and coverage-exempt |
| `skills/` | 16 files, ~4.4k lines | Skills management: central store, scope actions, discovery (hash-cached), panel controller (hidden-scan gated) |
| `projects/` | 21 files, ~2.7k lines | Project CRUD, favorites, path utilities, remote resolution |
| `dashboard/` | 19 files, ~2.3k lines | View provider, message routing, startup/diagnostics |
| `todos/` | 7 files, ~2.2k lines | TODO store, service, panel capability |
| `openWorkspaces/` | 9 files, ~2k lines | Open-workspace bridge client/protocol |
| `workspaces/` | 14 files, ~1.5k lines | Workspace hydration and session scoping |
| `prompts/` | 5 files, ~1.4k lines | Prompt library service and webview content |
| `dashboard.ts` (root) | 1.9k lines | Activation entry + composition root (coverage-exempt; integration-tested via the dashboard harness) |

## Quality And Delivery System

- **Deterministic suites**: unit / contract / integration (`node --test`) + browser (pinned Chromium) + platform (windows/macOS/remote) + extension-host smoke (weekly macOS; advisory PR job on Linux/xvfb when the command surface changes).
- **Behavior contracts**: `docs/testing/behavior-contracts.json` (~325 entries) pin user-visible behavior to owner test files; `main-capability-coverage.json` audits every implementation commit to a capability; both are CI-enforced.
- **Coverage gates**: ratchet baseline (`.ci/coverage-baseline.json`) + changed-line ≥80% with a hard failure for changed files missing from the report; `UNINSTRUMENTED_BY_DESIGN` lists the structurally exempt paths.
- **CI**: `verify.yml` (quality-linux / platform-windows / tmux-smoke-linux, all required), weekly `scheduled-verification.yml`, `release-vsix.yml`.
- **Merge approval gate**: merges mechanically require an owner approval comment newer than the latest commit (`merge-approval` required status, gate workflow + post-merge audit). See `ARCH-PR-MERGE-APPROVAL-GATE-001`.
- **Agent workflow skills**: `.skills/` (symlinked into `.kimi/`, `.codex/`, `.claude/`) documents worktrees, PR publishing, local installs, webview mutation protocols, review loops; skill content is pinned by `tests/unit/tooling/repositorySkills.test.js`.

## Completed Work Lines

### Refactor line (#92–#106): split oversized modules, zero behavior change

- #92 established the capability-extraction pattern in the tmux runtime (factory + explicit options, owner keeps composition root).
- Webview scripts: dashboard 1234→494 lines across #101/#104 (validation, search, three panel factories), todo renderer extracted (#102), prompt protocol extracted (#103); every pair byte-identical to `media/`.
- TypeScript: AI session rendering out of `webviewContent.ts` 1556→1013 (#105); tmux binding record schema out of the binding store 1731→889 (#106, validators covered by direct contract tests).

### Performance line (#110, #125)

- #110: skills scan chain — content-hash cache behind mtime+size manifests (steady-state rescan ~45ms → ~5ms on a 30-skill/30MB fixture) and hidden-sidebar scan deferral with lazy rescan on read.
- #125: focused tmux runtime monitor backs off 1s→4s while quiet (the 1s beat, notification latency, and the idle-zero-I/O property are pinned by contract tests).

### Test/CI line (#124, #129)

- #124: one byte-identity loop guards all `src/webview`↔`media/` script pairs; legacy services (`fileService`/`colorService`/`projectWindowColorService`) instrumented, vendored `ntc.ts` exempted.
- #129: Windows gate widened 5→9 suites; advisory extension-host smoke on PRs (Linux/xvfb, path-filtered); skills central/scope/migrate/fix services lifted from 8–33% to 61–75% statement coverage.

### Process line (#126, #128)

- Merge approval moved from convention to mechanism: skill rule + pinned harness test (#126), then the required `merge-approval` status check and the post-merge audit on main pushes (#128).

## Remaining Backlog (prioritized)

| Item | Risk | Notes |
| --- | --- | --- |
| `tmuxRuntimeBackend.ts` (1.6k) capability extraction | Medium | AttachTerminalManager (~500 lines) and CreationOrchestrator are the mapped candidates; two-step split, keep orchestration glue in the backend |
| `tmuxRuntimeDiscovery.enumerate()` (224-line function) split | Medium | Stage functions share 8 accumulators — pass one accumulators object; no source-text assertions pin the file |
| Provider session polling → event-driven with low-frequency fallback | Medium | Cross-platform `fs.watch` semantics differ; keep polling fallback |
| `dashboard.ts` coverage measurement (measure-only first) | Medium | Coordinate with the ongoing dashboard.ts slicing work |
| behavior-contracts P0 strengthening (ID in a test title + ≥1 assert in the block) | Low-Med | Owner check is currently string-contains |
| Extension-host PR job → required check | Low | After it proves stable as advisory |
| `conversation/viewer.ts` (1.5k and growing) | High — deferred | Active feature area; do not restructure while it is being built |
| Full-HTML rebuild on sidebar becoming visible; `activationEvents` narrowing | Deferred | Both touch the dashboard.ts hot zone |

## Conventions For Contributors (human or agent)

1. Work in `.worktree/<topic>` off `origin/main`; `npm ci` inside the worktree; never push to `main` directly.
2. Every PR: English title/body, `## Skill harvest` section, capability audit commit (`scripts/regenerate-capability-audit.js`), full local gate suite green.
3. Merges require the owner approval comment (the `merge-approval` status must be green); agents never self-approve.
4. Webview scripts keep `src/webview` and `media/` byte-identical; TS-side webview code has no mirror.
5. New behavior ships with a behavior-contract owner test; changed-line coverage must stay ≥80%.
