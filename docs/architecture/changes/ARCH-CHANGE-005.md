# ARCH-CHANGE-005 — Correct two stale invariant authorities

Date: 2026-08-18
Status: approved by repository owner (review repair R9)
Modules: MOD-WORKTREE-LIFECYCLE, MOD-SHARED-KERNEL, MOD-AI-SESSION-CONTROL

## Problem and evidence

W1 review Important 3: the invariant catalog only validated that
`authority.path` exists, so two records went stale as the code moved:

1. `ARCH-WORKTREE-IDENTITY-CODEC-001` declares its authority at
   `src/worktrees/types.ts` (`worktreeKeysEqual`), but the codec moved to
   `src/worktreeIdentity.ts` in ARCH-CHANGE-002 — `types.ts` only
   re-exports it. A re-export is not an authority.
2. `ARCH-WORKTREE-CLAIM-ORDER-001` declares its authority at
   `src/aiSessions/creationController.ts`, which the registry classifies
   into MOD-AI-SESSION-CONTROL while the invariant claims
   MOD-WORKTREE-LIFECYCLE — the cross-module participation was never
   declared.

## Old rule → new rule

- Old: authorities point where the code used to live; cross-module
  participation is implicit.
- New: `ARCH-WORKTREE-IDENTITY-CODEC-001.authority` =
  `src/worktreeIdentity.ts / worktreeKeysEqual` with
  `participatingModules: ["MOD-SHARED-KERNEL"]`;
  `ARCH-WORKTREE-CLAIM-ORDER-001` gains
  `participatingModules: ["MOD-AI-SESSION-CONTROL"]`. The accompanying
  guard change makes the catalog validate that the authority symbol is
  defined (not re-exported) in the authority file and that the file's
  module is the invariant's module or an explicitly declared participant.

## Alternatives considered

- Moving the identity invariant into MOD-SHARED-KERNEL: rejected — the
  wave owner stays MOD-WORKTREE-LIFECYCLE; the kernel hosts the authority
  as a declared participant.
- Leaving the records stale until the W1 re-acceptance: rejected — the
  review's acceptance criteria require stale authorities = 0 first.

## Compatibility and migration

Catalog metadata only; no production code, protocol, or persisted-format
change.

## Tests

- New controlled mutations in `tests/unit/architecture/singleWriters.test.js`:
  a re-exported authority symbol fails, an undeclared cross-module
  authority fails, and a declared participating module passes.

## Rollback

Revert the merge commit: the records return to their stale paths and the
validation relaxes.

## Machine summary

```arch-change
{
  "id": "ARCH-CHANGE-005",
  "status": "approved",
  "modules": [
    "MOD-WORKTREE-LIFECYCLE",
    "MOD-SHARED-KERNEL",
    "MOD-AI-SESSION-CONTROL"
  ],
  "delta": {
    "invariantChanges": [
      "ARCH-WORKTREE-IDENTITY-CODEC-001",
      "ARCH-WORKTREE-CLAIM-ORDER-001"
    ]
  }
}
```
