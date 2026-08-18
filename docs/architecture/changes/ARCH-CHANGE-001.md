# ARCH-CHANGE-001 — Route the worktree-group merge write through the module handler

Date: 2026-08-18
Status: approved by repository owner (pilot slice S3)
Module: MOD-WORKTREE-LIFECYCLE

## Problem and evidence

Stage 1B finding P2: the composition root (`src/dashboard.ts`) called
`worktreeGroupManifestStore.mergeGroups` directly from the
`merge-worktree-groups` message handler — a bypass around the module's
handler pattern (rename/deletion already route through
`src/worktrees/group*Handler.ts`).

## Old rule → new rule

- Old: `ARCH-WORKTREE-MANIFEST-STRUCTURE-001` writers included
  `src/dashboard.ts` as the caller of `mergeGroups`.
- New: the merge write lives in `src/worktrees/groupMergeHandler.ts`;
  `src/dashboard.ts` only wires it. The structural writer set changes from
  seven files to eight because `src/dashboard.ts` remains a writer for the
  generation-claim family (its composition closures are the ports).
  Logical writers did not grow: the merge authority moved from the
  composition root into the owning module.

## Alternatives considered

- Removing `src/dashboard.ts` from the set entirely: not possible yet — the
  generation-claim admission closures still write there (a later pilot
  slice addresses the claim family).
- Keeping the merge call in the composition root: rejected; that is the
  bypass being removed.

## Compatibility and migration

No protocol or persisted-format change. Behavior identical; the handler body
moved verbatim. The settlement semantics are unchanged.

## Tests

- New `tests/unit/worktrees/groupMergeHandler.test.js` covers the seam
  (drop-on-malformed, candidate re-derivation, double revision binding,
  stale-revision fail-closed, warning copy).
- `tests/unit/architecture/singleWriters.test.js` proves the writer set is
  coherent.

## Rollback

Revert the merge commit; the former inline handler is restored and the
writer-set entry returns to `src/dashboard.ts`.
