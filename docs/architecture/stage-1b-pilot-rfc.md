# Stage 1B — Pilot Deep Dive and Harness v0 RFC

Status: approved at the Stage 1B exit gate (2026-08-17); versioned per
`docs/architecture-harness-refactor-program.md` Section 12 (Stage 1C).

Pilot (approved Stage 1A, D1): the end-to-end operation "create worktree group
and start session, including crash recovery".

## 1. Named end-to-end data flows

Happy path (group creation):

```text
webview open-worktree-group-form
  -> controller.listRepositoryOptions / deriveFormContext      (read-only)
webview preview-worktree-group (300ms debounce, requestId)
  -> controller.preview: plan per member (slug + atomic suffix 1..999)
     -> preflightPlan (real git branch/path probes)
     -> previewSnapshots CAS write (authoritative snapshot, previewId)
webview confirm-worktree-group (bound to previewId; webview never sends argv)
  -> parse + preview-binding validation (zero side effects on failure)
  -> resolveBaseCommit: freeze baseRef to an immutable SHA
  -> consume preview token (single use)
  -> LP-1: manifestStore.createGroup / addPlannedMembers (provisioning rows)
  -> Promise.all per member: provisioning run()
       stage creating -> LP-2: git worktree add (idempotent reconcile)
       checkpoint (completedSteps += worktree)
       stage setting-up -> setup command (no shell, 10min timeout)
       checkpoint (completedSteps += setup)
       LP-3: finalize -> updateMember(ready, worktreeKey)
  -> terminal settlement after ALL members settle
```

Session start on a group worktree adds:

```text
create-ai-session[-quick] (worktreeKey)
  -> admission inside per-group deletion mutex
  -> LP-4: createGenerationClaim BEFORE any terminal/provider side effect
  -> LP-5: coordinator.create(request)
  -> async promotion tick: reconcile claims, then LP-6 promoteGenerationClaim
```

Recovery paths: member retry (frozen plan, never re-planned), member dismiss
(tombstone-first), crash-restart reconciliation (provisioning rows restore as
failed/interrupted; manifest members without live operations demote;
tombstones prune only with positive evidence; deletion journal reconciles
unknown -> stays pending; claims never auto-discard).

## 2. State-authority map

Persisted pilot state lives on four memento keys, owned by three stores; no
direct memento access exists outside the stores (verified by grep):

| State family | Authority store | Key |
| --- | --- | --- |
| groups, retired identities, generation claims, deletion journal | `WorktreeGroupManifestStore` | `agentPivot.worktreeGroups.v1` |
| provisioning operations (live + tombstones) | `WorktreeProvisioningStore` | `agentPivot.worktreeProvisioning.v1` + `...Tombstones.v1` |
| repository base refs | `WorktreeBaseRefStore` | `agentPivot.worktreeBaseRefs.v1` |
| settlement replay (rename/deletion families) | `SettlementReplayCache` | memory only |

## 3. Reader, writer, and bypass inventory (findings P1–P7)

The full method-level reader/writer tables were enumerated during the deep
dive. Material findings:

- **P1 — three independent writers for member state**: finalize
  (`dashboard.ts:1749-1757`), failure settlement
  (`groupCreationController.ts:963`), and reconciliation demotion
  (`groupManifestReconciliation.ts:69`) all write member state, coordinated
  only by a comment convention.
- **P2 — dashboard.ts handlers bypass controllers** and write the store
  directly: `mergeGroups` (`dashboard.ts:2738`), `setPrimaryMember` (`:2820`),
  `removeMember` (`:2076-2083`).
- **P3 — duplicated codecs**: WorktreeKey equality ×4; WorktreeKey→string ×4
  (one encoding has no separator and is theoretically collision-prone);
  `provider::sessionId` join ×5+; `isSafeId` regex ×10; `isSafeString` ×5;
  errorCode regex ×7; two copy-pasted helper pairs.
- **P4 — uneven protocol correlation**: replay cache exists for
  rename/deletion families only; confirm/set-primary/merge/discard-claim have
  none; `merge-worktree-groups` has no requestId at all; no family except
  attention-ack has a timeout.
- **P5 — preview-token consumption contradicts its comment**: the comment
  claims consumption "synchronously, before the first manifest await"
  (`groupCreationController.ts:686-689`), but the delete sits after the
  baseline-resolution awaits (`:673-684`). Concurrent confirms carrying the
  same previewId can both pass the `:606` check. Disposition: approved as an
  immediate standalone bug fix through the charter Section 13.2 workflow,
  outside the migration slices.
- **P6 — dead public write surface**: `addMember`, `deleteGroup`,
  `recordRetiredIdentity`, `removeRetiredIdentity`,
  `resetCorruptRetiredStore`, `nextGenerationCutoff`,
  `baseRefStore.set/delete` have no production callers; the
  `start-isolated-session` message has no producer in the webview.
- **P7 — uneven schema versioning**: baseRefStore has no record version;
  provisioningStore enforces `version === 1` but has no migration and no
  wrong-version test case.

## 4. State machines and invalid-transition behavior

Five state machines were mapped with legal-transition tables (provisioning
row: queued/creating/setting-up/failed; manifest member:
planned/provisioning/ready/failed/deleting — note `planned` currently has no
writer; generation claim: pending/promoted, fail-closed on illegal
transitions; deletion journal: pending/deleted/failed with unknown staying
pending; settlement replay cache: known/evicted-tombstone/unknown with
fail-closed expiry). Invalid transitions are silently ignored at the
provisioning-row level but throw at the claim level — an inconsistency the
migration should make deliberate.

## 5. P0/P1 invariant catalog (draft)

Machine-readable draft: `docs/architecture/drafts/pilot-invariants.draft.json`.
Headline invariants:

- INV-1 (P0): a preview token is consumed exactly once, before any await
  after validation (authority: WorktreeGroupCreationController).
- INV-2 (P0): member state transitions have one logical writer family routed
  through the lifecycle coordinator.
- INV-3 (P0): a generation claim is durable before any terminal/provider side
  effect; claim removal requires proven-not-started or explicit user discard.
- INV-4 (P0): dismissal is tombstone-first; no live row/context/manifest
  removal before the tombstone is durable.
- INV-5 (P1): baseline is frozen to a commit SHA before `git worktree add`.
- INV-6 (P1): cross-store write order and crash windows have deterministic
  restart reconciliation (listed per LP in Section 6).
- INV-7 (P1): every pilot mutation message carries a correlation envelope and
  a documented exactly-once mechanism (replay cache or single-use token).

## 6. Ordering, linearization, retry, compensation, crash ambiguity

Seven linearization points were mapped with before/after failure semantics
(LP-1 manifest commit; LP-2 `git worktree add`; LP-3 member-ready write; LP-4
claim write; LP-5 runtime create; LP-6 claim promote; plus tombstone-first
dismiss). Ordering is guaranteed by per-store promise queues, the linear
provisioning run function, per-operation mutation mutexes, and the per-group
deletion admission mutex. Compensation is never physical rollback; it is
tombstones, claim removal (proven-not-started only), and in-memory releases.
Crash-ambiguity windows are all handled fail-closed; two known residues:
orphan worktrees when the crash lands before the first persist (requires
manual cleanup), and the deliberate permanent ambiguity of "runtime promoted,
claim not promoted" (never auto-discard).

## 7. Protocol analysis

Per-family correlation/idempotency/timeout/stale-response/compatibility table
was enumerated (16 families). All protocol parsers enforce `version === 1`
plus exact key sets; unknown versions are dropped. Gaps are P4 above.

## 8. Persisted schema and identity-codec inventory

Recorded per store: fields, version fields, migration logic locations,
quarantine behavior, capacity limits (groups 256, buckets 512, members 64,
retired 256, claims 1024, aggregate ≤1MB; provisioning live 32, tombstones
1024). Identity codec inventory covers groupId/memberId/operationId/
retirementId/claimId/pendingId/requestId/previewId/memberOperationId/
WorktreeKey/composite session identity/workspace navigationIdentity, with
construction, parsing, and equality sites (P3 lists the duplicates).

## 9. Duplicate business-knowledge inventory

Fourteen duplicate families recorded with locations and occurrence counts
(P3 plus confirm/preview encode-decode duplication, tombstone retention rule
×2, tombstone-needed predicate ×2, survivor rule ×3, affectedSessions
dedup ×3, errorCode→copy tables ×4).

## 10. Test blind spots and failure matrix

The failure matrix has automated coverage in all 11 categories (35 test files
mapped per category). Three reservations to close in Stage 3 (S0):

1. Group creation has no real-git end-to-end test (all injected fakes; real
   git covers only the single-worktree provisioner and journaled deletion).
2. The `confirm-worktree-group` handler chain in `dashboard.ts`
   (parse → accepted → controller → terminal settlement) has no test — the
   composition seam is unlocked. Same for retry/dismiss member handlers.
3. The confirm family's missing replay cache is itself unlocked (token
   single-use is covered only at controller level).

Minor gap: provisioningStore has no wrong-version record test case.

## 11. Current bug-convergence scorecard

Baseline measured on H1–H5 (facts in `stage-1a-census.md` Section 11):
search surface 3–7 files; fix touch surface 3–26 files; H2/H5 exhibit
zero-keyword-hit fix files (wiring-absence class); regression tests shipped in
the same commit in all five cases. Targets to propose when the pilot
finishes: migrated module converges seeded faults to one module and one named
authority; search surface and incorrect-hypothesis counts materially improve;
no scorecard dimension regresses.

## 12. Target module boundary, public APIs, roles, dependency matrix

```text
MOD-WORKTREE-LIFECYCLE
  presentation:   webviewGroupFormScripts.js + worktree rows of the controls script
  application:    groupCreationController, isolatedSessionController,
                  provisioningController, deletionController (+ handlers)
  domain:         manifest aggregate logic, member/claim/journal state machines,
                  identity codecs, provisioning plan generation
  infrastructure: gitWorktreeProvisioner, worktreeSetupRunner, the three stores
  composition:    new src/worktrees/index.ts as the only public entrypoint
mayDependOn: [MOD-WORKSPACE-IDENTITY]
```

`dashboard.ts` wiring must go through the entrypoint (removes P2). Dead APIs
(P6) are removed or internalized during migration, each removal listed in the
slice plan.

## 13. Harness v0 schemas and validation rules

Canonical files (charter Section 8.1, v3 naming):

```text
docs/testing/architecture-modules.json      module registry (closed world)
docs/testing/architecture-invariants.json   invariant catalog
docs/testing/architecture-waivers.json      waiver ledger
docs/testing/architecture-program.json      progress ledger
.ci/architecture-debt-baseline.json         generated violation fingerprints
scripts/architecture/*.js                   10 checkers + loader + graph
tests/architecture/*.test.js                schema + guard mutation tests
```

Schema essentials: module records use structured
include/exclude/overrides/publicEntrypoints/mayDependOn/roles; every
production file matches exactly one module and one role. Invariant records
carry structured authority/writers/linearizationPoint/enforcement — free-form
rule strings are rejected. Waiver records carry an enumerated `fingerprints`
set and a milestone `retiresWith` (calendar `expiresAt` is advisory only and
never fails CI). Ledger transitions
`legacy -> inventoried -> characterized -> guarded -> migrating -> strict`
are validated; `strict` is unreachable while any waiver, baseline entry,
unclassified file, illegal edge, unowned state family, or missing P0/P1 owner
exists.

## 14. Guard design

Closed-world classification, public-entrypoint enforcement, module-cycle
detection with shortest-cycle reporting, single-writer checks for declared
state families, bypass checks, protocol-correlation checks, ratchets, and
traceability (module ↔ `MAIN-*`). Fail-closed on unknown file kinds, roots,
or edge forms. The webview declared-manifest policy adds a manifest listing
bundle membership, load order, and permitted cross-script globals; undeclared
references fail. Every guard ships with positive fixtures and one controlled
negative mutation per claimed violation dimension (100% kill rate required).

## 15. CI commands, budgets, impact reporting

Fast lane (pre-commit): schema validation, changed-file classification,
focused guards. Full lane (in `test:ci:linux`): complete graph, all guard
mutations, baselines, cross-catalog traceability. Runtime budgets are measured
and pinned during Stage 2 (proposal: fast lane seconds-scale; full lane within
the existing Linux gate budget). `reportArchitectureDiff.js` generates the
policy diff consumed by the merge-approval-gate declaration comparison.

## 16. Ordered migration slices

Stage 2 ships first as a PR series (never one kernel PR):

1. registry-only PR: `architecture-modules.json` (approved coarse registry) +
   loader + schema validation + file classification check; adds the approved
   `MAIN-ARCHITECTURE-HARNESS` capability.
2. dependency graph + public-entrypoint/cycle guards + rule-by-rule baseline
   with matching waivers.
3. single-writer/bypass checks for pilot state families.
4. ratchets + architecture diff report + anti-self-amendment classification.
5. webview declared-manifest policy.

Pilot migration after Stage 3 safety net (S0: close the three matrix
reservations):

- S1 consolidate identity codecs into the domain layer, per usage context
  (persisted encodings stay stable — see Section 17).
- S2 route the three member-state writers through one coordinator (P1).
- S3 route dashboard.ts handler writes through the module entrypoint; remove
  dead APIs (P2, P6).
- S4 uniform correlation envelopes for pilot message families (P4).
- S5 remove baseline entries/waivers for the module; enable strict mode.

Every slice: behavior-preserving, ≤12 production files / ≤1,200 lines, pure
moves separated from logic changes.

## 17. Trade-offs and rejected alternatives

- **Rejected: unify all WorktreeKey string encodings into one format.**
  Encodings are persisted (tombstone hashes, member-path claims); unification
  breaks existing data. Chosen: one module owns all codecs with explicit
  per-context contracts (S1).
- **Rejected: fix P5 inside a migration slice.** A behavior-affecting bug fix
  must stay independently reviewable through the charter Section 13.2
  workflow (RED test first), not ride along with structural moves.
- **Rejected: provisional registry without approval.** The coarse registry is
  an approved architecture decision (Stage 1A checkpoint), because the
  closed-world gate makes it load-bearing from day one; re-partition is a
  governed first-class operation (charter Section 8.9).
