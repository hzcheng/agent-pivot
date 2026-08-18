# ARCH-CHANGE-003 — Role semantics: exact partition with a remainder role

Date: 2026-08-18
Status: approved by repository owner (review repair R1)
Module: all (registry-wide semantics)

## Problem and evidence

W1 review Blocker 1: the closed-world loader used first-match-wins for
roles — 106 production files matched multiple roles while red line 1 claims
exactly one per file. The registry note even documented "the first matching
role wins", contradicting the red line.

## Old rule → new rule

- Old: roles evaluated in order, first match wins; overlaps silently
  tolerated.
- New: roles form an exact partition. Specific role globs must be disjoint
  (an overlap fails with file, module, both roles, and the matching
  patterns). A role with `include: ["**"]` is the remainder role — last
  position only — and catches the module's unclaimed files. Empty role
  include lists are rejected.
- `MOD-SHARED-KERNEL` keeps a single explicit domain role (no remainder).

## Alternatives considered

- Per-role exclude lists: equivalent power but harder to read and easier to
  game; the remainder marker is one declared mechanism with an obvious
  position rule.
- Keeping first-match: rejected; it is the defect being removed.

## Compatibility and migration

No production source or persisted data changed. The registry's role lists
were rewritten to the partition semantics; classification results are
unchanged except that overlaps now fail instead of silently first-matching.
`ntc.ts` left a double assignment (domain+infrastructure) and sits in
infrastructure; the shell's empty domain role was removed.

## Tests

- New controlled mutations in `tests/unit/architecture/closedWorld.test.js`:
  role overlap fails with both roles and patterns, misplaced remainder role
  fails, remainder catches only unclaimed files.
- `tests/unit/architecture/programLedger.test.js`: strict fails while the
  classification has any error.

## Rollback

Revert the merge commit: the loader returns to first-match and the registry
to the coarse role lists.
