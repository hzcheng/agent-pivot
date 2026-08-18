# ARCH-CHANGE-002 — Re-partition: MOD-SHARED-KERNEL lands at the module-graph bottom

Date: 2026-08-18
Status: approved by repository owner (pilot slice S5)
Modules: MOD-SHARED-KERNEL (new), MOD-DASHBOARD-SHELL, MOD-WORKSPACE-IDENTITY, MOD-WORKTREE-LIFECYCLE

## Problem and evidence

The coarse registry recorded a value-level 2-cycle
`MOD-WORKSPACE-IDENTITY ↔ MOD-WORKTREE-LIFECYCLE` (waiver ARCH-WAIVER-003,
retirement milestone PILOT-STRICT): worktrees imported the workspace path
assignment utilities while workspaces imported worktree codecs and retired
records. A first attempt to host the shared utilities in
MOD-DASHBOARD-SHELL made it worse (the shell is the composition top, so it
created two new cycles) — evidence that a shared kernel belongs at the
bottom, not inside the composition module.

## Old rule → new rule

- New module MOD-SHARED-KERNEL owns `src/models.ts`, `src/constants.ts`,
  `src/sessionAssignment.ts`, `src/worktreeSessionAssignment.ts`, and
  `src/worktreeIdentity.ts` (the WorktreeKey type and its canonical codecs,
  moved from `src/worktrees/types.ts`; the types module re-exports them so
  existing consumers keep their import paths). The kernel has no value-level
  outbound dependencies.
- MOD-DASHBOARD-SHELL releases the kernel files.
- `src/workspaces/sessionAssignment.ts` and
  `src/workspaces/worktreeSessionAssignment.ts` moved to `src/` and joined
  the kernel.

## Measured outcome

- The `WORKSPACE-IDENTITY ↔ WORKTREE-LIFECYCLE` pair dissolved;
  ARCH-WAIVER-003 is retired.
- The 13-module cyclic cluster shrank to 12 and no longer contains
  MOD-WORKTREE-LIFECYCLE; ARCH-WAIVER-004 tracks the new fingerprint.
- Four more 2-cycles dissolved (CONTROL↔SHELL, RUNTIME↔SHELL,
  RUNTIME↔WORKSPACE, SHELL↔PROJECT-CATALOG) as return edges moved onto the
  kernel.

## Alternatives considered

- Hosting the utilities in MOD-DASHBOARD-SHELL: rejected with evidence (it
  created new cycles — the composition top cannot host a kernel).
- Splitting `worktrees/types.ts` consumers onto direct kernel imports:
  deferred; the re-export keeps the slice mechanical.

## Compatibility and migration

No protocol or persisted-format change; pure moves plus path updates. The
worktree identity codecs keep byte-identical outputs (pinned by
`tests/unit/worktrees/worktreeKeyCodecs.test.js`).

## Tests

- Closed-world classification: 371 files, 16 modules, exact-once.
- Boundary checks pass; cycle baseline regenerated; waiver ledger bijection
  holds.
- Full worktrees/dashboard suites green.

## Rollback

Revert the merge commit: the files move back and the registry returns to the
15-module coarse registry with the previous baseline.
