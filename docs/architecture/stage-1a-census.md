# Stage 1A — Read-Only Repository Census

Status: approved at the Stage 1A checkpoint (2026-08-17); versioned per
`docs/architecture-harness-refactor-program.md` Section 12 (Stage 1C).

Census HEAD: `afb60eb1` on `agent-pivot/arch-refact`. `origin/main` was
`c784ad49` (9 commits ahead of the merge-base `c783d76e`); every later slice
must rebase onto current `origin/main` before work starts.

This document records facts with evidence. Interpretations and hypotheses are
marked as such. Nothing here authorizes implementation by itself.

## 1. Executive summary and top risks

Repository size (measured): `src/` = 348 files / 114,059 lines; `tests/` = 273
files / 116,703 lines; 433 behavior contracts; 31 `MAIN-*` capabilities; 12
architecture guard validators.

Top risks (interpretation, ranked by evidence strength):

| # | Risk | Evidence |
| --- | --- | --- |
| R1 | Composition-root concentration: `src/dashboard.ts` is 4,063 lines with 165 outbound cross-directory imports, the highest in the repository | dependency matrix (Section 6) |
| R2 | Six pure value-level directory dependency cycles; module boundaries have materially eroded | Section 6 |
| R3 | Worktree lifecycle is the incident hotspot: of the last 50 commits touching `src/worktrees` + `src/aiSessions`, 33 are fixes; 17 of them target group creation/deletion races, 7 target crash recovery | `git log --oneline -50 -- src/worktrees src/aiSessions` |
| R4 | Webview mutation protocols are inconsistent: of 97 main-panel message types, the 15 project-CRUD messages and 15 of 16 skill-panel messages are fire-and-forget (no requestId), while todo/worktree/attention families have full correlation | Section 8 |
| R5 | 37 webview scripts (26.1k lines) have zero static imports; they couple through 29 `window.__agentPivot*` globals and a hand-maintained bundle concatenation order — outside any static graph | Section 6 |
| R6 | Hand-maintained architecture prose is already stale in three places (line counts, contract counts, guard mutation coverage) | Section 3 |

## 2. Evidence and reproducible census commands

```bash
find src -name '*.ts' -o -name '*.js' | xargs wc -l            # 348 files / 114,059 lines
node -e "console.log(require('./docs/testing/behavior-contracts.json').length)"          # 433
node -e "console.log(Object.keys(require('./docs/testing/main-capability-coverage.json').capabilities).length)"  # 31
node scripts/run-architecture-guards.js
node --test tests/unit/tooling/architectureGuards.test.js      # 135 controlled mutations
git log --oneline -50 -- src/worktrees src/aiSessions          # 33 fix / 50
grep -c "require(\|import " src/webview/*.js                   # all zero
```

The dependency matrix, cycle enumeration, and fan-in table were produced by a
one-off Python script that parses `import`/`export from`/`require()` across all
348 files, normalizes relative paths to first-level directories, and enumerates
simple cycles with DFS. Storage, side-effect, and protocol entry points were
collected with ripgrep scans (patterns recorded in the investigation notes).

## 3. Architecture document authority/staleness classification

| Document | Classification | Evidence |
| --- | --- | --- |
| `docs/testing/behavior-contracts.json`, `main-capability-coverage.json`, `conversation-release-journeys.json` | Authoritative, CI-validated | `scripts/check-behavior-contracts.js` enforces schema and path existence |
| `.skills/*` | Guidance layer, content pinned by CI regex | `tests/unit/tooling/repositorySkills.test.js` (10 tests, 9 skills) |
| `docs/architecture-harness-refactor-program.md` | Authoritative process charter (this program); not yet CI-validated | — |
| `docs/architecture-current-state.md` | Stale; regenerate or demote to historical | Three disproven counts: src 69k (actual 114k), `dashboard.ts` 1.9k (actual 4,063), contracts ~325 (actual 433); module table omits `worktrees/` |
| `docs/optimization-plan.md`, the 7 `*-prd.md` files, `worktree-tasks-m3*.md`, `development-history.md` | Historical / explanatory | already declared archived |
| `docs/manual-tests/` (3 files) | Explanatory runbooks | referenced indirectly by manual-status contracts |

## 4. Production source-root and file-kind inventory

| Root | Files | Lines | Kind | Build relationship |
| --- | ---: | ---: | --- | --- |
| `src/aiSessions/` | 149 (.ts) | 46,762 | production | main tsconfig |
| `src/webview/` | 44 (7 ts + 37 js) | 26,119 | production (js mirrored byte-for-byte to `media/`) | main tsconfig + gulp copy |
| `src/worktrees/` | 33 | 10,773 | production | main tsconfig |
| `src/services/` | 12 | 5,359 | production (incl. vendored `ntc.ts`, 1,690 lines, exempt) | main tsconfig |
| `src/skills/` | 16 | 4,519 | production | main tsconfig |
| `src/dashboard/` + 4 root files | 29 | 8,078 | production (`dashboard.ts` 4,063) | main tsconfig |
| `src/workspaces/`, `openWorkspaces/`, `projects/`, `todos/`, `prompts/` | 85 | 12,637 | production | main tsconfig |
| `extensions/attention-ui-bridge/` | 16 | 2,717 | production (separate shipped artifact) | own tsconfig/webpack; includes 7 main-src files + `shared/` back into its compile |
| `shared/attention-bridge/` | 3 | 189 | production (shared by two compile units) | included by consumers |
| `spikes/` | 17 | 2,932 | non-production experiments | excluded from main tsconfig |
| `scripts/` | 52 | 44,731 | harness/tooling | executed by node directly |
| `media/` | 52 | ~51k | generated (37 mirrors + bundle + 5 vendor) | gulp/webpack |

Approved scope decisions (D3): `extensions/attention-ui-bridge` and
`shared/attention-bridge` are in scope as their own architecture module;
`spikes/` is declared out of scope (non-production); `media/` is generated
output and excluded from classification.

## 5. Candidate architecture modules and ambiguous ownership areas

Approved initial coarse registry (D2; 13 ownership groups, 15 module IDs —
todo and prompts were presented as one row but are recorded as two modules):

| Module ID | Source root(s) | Candidate `MAIN-*` mapping |
| --- | --- | --- |
| MOD-AI-SESSION-RUNTIME | `src/aiSessions/{tmux*,runtime*,terminalService*,directTerminal*}` | MAIN-RUNTIME-OWNERSHIP, MAIN-TMUX-* |
| MOD-AI-SESSION-CONTROL | `src/aiSessions/{sessionControllerComposition,*Controller}` | MAIN-AI-SESSION-QUICK-CREATE, MAIN-AI-SESSION-QUICK-SWITCH |
| MOD-AI-SESSION-CONVERSATION | `src/aiSessions/conversation/` | MAIN-AI-SESSION-CONVERSATION-OUTLINE |
| MOD-AI-SESSION-ATTENTION | `src/aiSessions/attention*` | MAIN-WORKSPACE-ATTENTION, MAIN-ATTENTION-LIFECYCLE-HARDENING |
| MOD-AI-SESSION-NOTIFY | `src/aiSessions/{notify,notifyIntegration,notifyConfiguration*}` | MAIN-SESSION-STOP-NOTIFICATION |
| MOD-AI-SESSION-PROVIDER | provider session services moved from `src/services/` | session-domain contract evidence |
| MOD-WORKTREE-LIFECYCLE | `src/worktrees/` | MAIN-WORKTREE-CHANGES-PANEL + runtime/session share |
| MOD-WORKSPACE-IDENTITY | `src/workspaces/` | MAIN-WORKSPACE-IDENTITY, MAIN-WORKSPACE-SCOPE, MAIN-WORKSPACE-HYDRATION |
| MOD-OPEN-WORKSPACE | `src/openWorkspaces/` | MAIN-OPEN-WORKSPACE-PROTOCOL, MAIN-OTHER-WINDOWS |
| MOD-PROJECT-CATALOG | `src/projects/` + legacy project/color/file services from `src/services/` | MAIN-PROJECT-CATALOG-CONSISTENCY, MAIN-WORKSPACE-SAVE |
| MOD-SKILL-MANAGEMENT | `src/skills/` | MAIN-AI-SKILL-MANAGEMENT |
| MOD-TODO | `src/todos/` | MAIN-TODO-CONTINUOUS-EXPERIENCE |
| MOD-PROMPT-LIBRARY | `src/prompts/` | MAIN-AI-PROMPT-LIBRARY |
| MOD-DASHBOARD-SHELL | `src/dashboard/`, `src/webview/`, root files | MAIN-WORKSPACE-WEBVIEW, MAIN-DASHBOARD-WEBVIEW-RECOVERY |
| MOD-ATTENTION-BRIDGE-EXT | `extensions/attention-ui-bridge/`, `shared/attention-bridge/` | shared with MAIN-OPEN-WORKSPACE-PROTOCOL |

Ambiguous areas (interpretation):

1. `src/services/` is semantically misplaced: the three provider session
   services hold 12 value-level imports into `aiSessions`. Approved decision
   D4: fold them into MOD-AI-SESSION-PROVIDER; legacy project/color/file
   services join MOD-PROJECT-CATALOG; vendored `ntc.ts` stays exempt.
2. Root `src/models.ts` / `src/constants.ts` are type/constant hubs
   (fan-in 108 / 27) — recorded as a shared-kernel role inside
   MOD-DASHBOARD-SHELL for the coarse registry; type-only hubs may earn a
   neutral kernel module during re-partition.
3. The 37 webview JS scripts are presentation role inside
   MOD-DASHBOARD-SHELL, governed by the declared-manifest edge policy
   (charter v3), not by the module graph.

## 6. Dependency graph summary, cycles, deep-import candidates, edge forms

Facts:

- Unresolved local edges: 0. Unusual edge forms: 4 dynamic `require()` calls
  (`src/aiSessions/conversation/markdown.ts:3,14`,
  `src/aiSessions/notifyIntegration/commands.ts:170`, `src/todos/service.ts:78`),
  10 type-position inline `import('...')` references, 1 `__dirname`-based media
  lookup (`src/aiSessions/conversation/composition.ts:1480`). Imports from
  `src/` to outside `src/`: 0.
- Directory-level simple cycles: 516 counting type-only edges; 14 pure value
  cycles — 6 binary + 8 ternary, all passing through `aiSessions`:

| Pure value cycle | Constituent edges (file:line) |
| --- | --- |
| aiSessions ↔ workspaces | `src/aiSessions/attentionEventCapability.ts:6`; reverse `src/workspaces/activeSessionPresentation.ts:5` |
| workspaces ↔ worktrees | `src/workspaces/sessionHydration.ts:41,43`; reverse `src/worktrees/groupCreationController.ts:4` |
| aiSessions ↔ dashboard | `src/aiSessions/dashboardController.ts:9`; reverse `src/dashboard/messageHandlers.ts` (2 value edges) |
| aiSessions ↔ webview | `src/aiSessions/conversation/conversationTelemetryController.ts:5`; reverse `src/webview/webviewAiSessionContent.ts:20` |
| aiSessions ↔ projects | `src/aiSessions/terminalCwd.ts:5`; reverse `src/projects/projectMessageHandlers.ts:4` |
| skills ↔ webview | `src/skills/dashboardController.ts:15`; reverse `src/webview/webviewSkillContent.ts:6-8` |
| ternary ×8 | e.g. aiSessions→worktrees→workspaces→aiSessions |

- Deep-import candidates (interpretation): no declared public entrypoints exist
  today, so every cross-directory import is effectively deep. The 165 outbound
  edges of `dashboard.ts` are the largest convergence target once entrypoints
  exist.
- Fan-in hubs: `src/models.ts` (108), `src/aiSessions/types.ts` (59),
  `src/aiSessions/runtimeTypes.ts` (36), `src/worktrees/types.ts` (36),
  `src/workspaces/types.ts` (28). Eight of the top ten are pure type/constant
  hubs, so a shared-types sinking strategy has a bounded blast radius.
- Webview scripts: 37 files, zero static edges; main panel loads one bundle
  whose order is hand-maintained in
  `scripts/build-dashboard-webview-bundle.js:9-32` (26 scripts); the
  conversation viewer loads 12 scripts in fixed order
  (`src/aiSessions/conversation/viewerDocument.ts:567-604`); shared state via
  29 `window.__agentPivot*` globals.

## 7. `MAIN-*` ↔ source mapping analysis

Facts: the 31 capabilities have no source-area field (keys are exactly
id/title/requirement/commits/behaviors/prGates/scheduledJobs/
realEnvironmentRequired). The only capability→source link is `behaviors[]` →
contract `evidence[]` (233 references). Domain → top `src/` directories by
evidence count:

| Domain (entries) | Top src evidence locations |
| --- | --- |
| webview (101) | aiSessions (135), webview (102), dashboard (16) |
| session (72) | aiSessions (71), worktrees (16), workspaces (15) |
| persistence (45) | worktrees (35), aiSessions (20), skills (17) |
| attention (41), runtime (41) | aiSessions-dominant |
| open-project (39) | openWorkspaces (23) |
| release (7), error (2) | zero src evidence — harness-only capabilities |
| architecture (24) | mostly scripts/ (14 of 53 evidence refs land in src) |

Interpretations: the capability↔module mapping must be built in Stage 2; the
table above is its empirical starting point. Product flows routinely cross
modules (session spans aiSessions/worktrees/workspaces), confirming the
orthogonal capability/module model.

## 8. State, persistence, protocol, composition, and external-effect entry points

Facts (file:line evidence in the investigation notes):

- 40+ memento write points across 12 stores; SecretStorage serves only notify
  sink credentials (`src/aiSessions/notifyIntegration/commands.ts:127`) and has
  no delete path; `ExtensionContext.storageUri` is unused (all persistence via
  `globalStoragePath`, 13 injection sites concentrated in `dashboard.ts`).
- Schema versioning is uneven: groupManifestStore (v1→v2 migration +
  quarantine), tmuxBindingRecords (v2→v3), terminalBinding/tmuxAttachBinding
  (v2→v3) are versioned; baseRefStore has no record version; profile/alias
  stores have none; prompt/todo/project data have dual backends
  (globalState↔settings) with migration paths.
- Process spawns: 11 spawn/execFile sites (tmux, git, `codex app-server`,
  probes). Provider sessions themselves are never spawned — they start via
  `terminal.sendText` (`src/aiSessions/terminalService.ts:159`).
- Protocol: 97 main-panel message types + 23 conversation-viewer types;
  correlation coverage is uneven (R4).
- Composition roots: `dashboard.ts::initializeDashboard` (3,470-line function,
  segment map recorded), `sessionControllerComposition.ts` (5 controllers),
  `conversation/composition.ts` (factory-injected, structurally sound).
- Single outbound network egress: `src/aiSessions/notify/httpClient.ts:87,117`
  (verified: no other fetch/WebSocket/net.connect in `src/`).

## 9. Existing harness and guard trust/mutation inventory

Baseline correction (fact): the charter Section 3 statement "only a subset of
the 12 guards has an explicit negative mutation test" is outdated — all 12
guards have negative mutation tests (135 controlled mutations in
`tests/unit/tooling/architectureGuards.test.js`).

| Asset | State |
| --- | --- |
| 12 ARCH guards | technique mix: 6 pure-AST, 4 AST+text, 1 graph analysis, 1 JSON+AST; mutation coverage 12/12 |
| CI gates | required: quality-linux, platform-windows, tmux-smoke-linux, merge-approval (status); advisory: extension-host-linux |
| merge-approval | owner comment + timestamp bound to head + fail-closed + L3 post-merge audit |
| coverage | ratchet baseline (lines 77 / statements 77) + changed-line ≥80% + hard failure for missing files; 9 UNINSTRUMENTED_BY_DESIGN entries |
| behavior contracts | 433 entries: 424 automated, 8 manual, 1 scheduled |
| orphan script | `scripts/run-workspace-navigation-spike-checks.js` is in no lane or workflow (referenced only by historical docs) — register as historical or remove in Stage 2 |

Trust-level gap (interpretation): existing guards sit at trust hierarchy levels
3–5 (AST/text); the charter's target levels 1–2 (structurally unbypassable +
complete dependency graph) are exactly Stage 2's added value.

## 10. Risk-ranked product flows and approved pilot boundary

Fix-density evidence (fact): of the last 50 commits in `src/worktrees` +
`src/aiSessions`, 33 are fixes — 17 in group creation/deletion races, 7 in
crash recovery/generation claims.

Risk ranking (interpretation):

1. Worktree group creation × session provisioning (highest: fix density +
   multiple stores + Git/process effects + crash recovery + webview protocol)
2. AI session runtime lifecycle (tmux/direct ownership and recovery)
3. Fire-and-forget webview mutation families (30+ messages)
4. Conversation viewer (high, but an active feature area — remains deferred)
5. Notify egress pipeline (security-sensitive but small)

Approved pilot (D1): the single end-to-end operation "create worktree group and
start session, including crash recovery" — covering
`groupCreationController`, `isolatedSessionController`,
`gitWorktreeProvisioner`, `provisioningStore`, `groupManifestStore` (creation
paths), settlement replay, and the associated webview message families.

## 11. Fixed bug-convergence eval cases

Approved eval set (D5). Historical cases:

- H1 `68119d2c`/`a17dfdb7` — tombstone-first write ordering
- H2 `31a03df0`/`522e2cc1` — generation-claim reconciliation across crashes
- H3 `bad30d77`/`2e2cfa32` — preview token single-use and confirm binding
- H4 `d66a8c14` — batch deletion admission race
- H5 `5f1aee35` — claim-conflict quarantine

Seeded faults (to finalize in Stage 1B/3): S1 swap provisioning-store write
order (tombstone after live write); S2 drop a requestId echo in a worktree-group
response; S3 add a manifest-bucket write outside the coordinator.

Measured baseline (fact): fix touch surface 3–26 files; keyword search surface
3–7 files; H2/H5 fixes touched files with zero keyword hits at the parent
commit — wiring-absence defects are the expensive class. All five fixes shipped
regression tests in the same commit.

## 12. Stage 1B scope estimate and open decisions

Stage 1B scope (approved): deep dive on ~20 files (worktree creation chain,
dashboard.ts handler segments, group form scripts, 10 contract test files);
deliverables per charter Section 12 Stage 1B items 1–17.

Decisions recorded at the checkpoint: D1 pilot boundary (approved as above),
D2 coarse registry (approved, Section 5), D3 scope (approved, Section 4),
D4 services/ disposition (approved, Section 5), D5 eval set (approved,
Section 11), D6 charter baseline corrections (applied in this transcription).
