# ARCH-CHANGE-007 — Guard-semantics evolution: exact Architecture Change records

Date: 2026-08-19
Status: approved by repository owner (round-2 review Blocker 3)
Modules: MOD-WORKTREE-LIFECYCLE

## Problem and evidence

Round-2 review Blocker 3: Architecture Change records were reusable
wildcard authorizations. The verification `coversPolicyDelta` never read
`record.modules`, subset semantics let a declared superset authorize more
than the owner reviewed, and records outlived their deltas in the base.

Fixing the record contract changes the verdict semantics of the
anti-self-amendment guard itself (what passes and fails on the same diff),
so the guard-mutation-parity lane's base suites legitimately diverge. This
record is the owner-reviewed authorization for that guard-contract change.

## Old rule → new rule

- Old: declared delta covers the actual delta by subset; modules unused;
  invariant changes declared as bare ids; no file-move precision.
- New: exact per-dimension equality; the record's modules must cover every
  module actually touched; re-partitions that move files declare per-file
  `fileMoves: [{ path, from, to }]`; invariant semantic changes declare
  `invariantChanges: [{ id, fields, before, after }]` with sha256
  fingerprints produced by
  `scripts/architecture/describeArchitectureChange.js`.

## Alternatives considered

- One-shot consumption stamps: unnecessary once deltas are exact —
  re-consuming a record would re-realize the identical delta, which after
  merging no longer occurs as a diff.
- Keeping subset semantics with a consumption window: weaker; a superset
  still authorizes more than the owner reviewed within the window.

## Compatibility and migration

Records ARCH-CHANGE-001–005 predate the machine-summary schema or use the
old shapes; they are non-candidates for future authorization (their changes
already merged). No production code, protocol, or persisted-format change.

## Tests

- Exact-equality dimension matrix, module-scope violation, fingerprint
  mismatch, fileMoves mismatch, and the inverted superset mutation in
  `tests/unit/architecture/architectureChange.test.js`.

## Rollback

Revert the merge commit: the guard returns to subset semantics.

## Machine summary

```arch-change
{
  "id": "ARCH-CHANGE-007",
  "status": "approved",
  "modules": ["MOD-WORKTREE-LIFECYCLE"],
  "delta": {
    "guardSemantics": true
  }
}
```
