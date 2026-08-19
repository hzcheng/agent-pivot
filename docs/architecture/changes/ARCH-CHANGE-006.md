# ARCH-CHANGE-006 — W1 strict regression: repair the trust chain first

Date: 2026-08-18
Status: approved by repository owner (W1 review round 2)
Modules: MOD-WORKTREE-LIFECYCLE

## Problem and evidence

The second W1 review (round 2, after repairs R1–R10) found the remaining
defects concentrated in the harness's own trust chain:

- Blocker 1: the merge-approval gate executes PR-head code with
  `statuses: write` (a `pull_request` workflow runs the PR's own workflow
  file and gate script), so a PR can approve itself; and a guard turned
  constant-true with text-count-preserving test edits passes the harness
  delta checks.
- Blocker 2: owner approval is bound to the committer timestamp, which the
  committer controls — a backdated head commit makes a stale approval look
  fresh.
- Blocker 3: Architecture Change records are reusable wildcard
  authorizations — `modules` is never consulted during matching,
  `rePartition: true` covers any module's re-partition forever, and
  `invariantChanges` authorizes unbounded future semantic edits.

The strict target contract landed in R9/R10, but the review verdict is that
the strict claim must not stand while the final trust chain is bypassable.

## Old rule → new rule

- Old: MOD-WORKTREE-LIFECYCLE is `strict`.
- New: MOD-WORKTREE-LIFECYCLE returns to `migrating` until the round-2
  repairs (T1 approval SHA binding, T2 trusted evaluator, T3 record
  precision + one-shot consumption, T4 writer facade narrowing, T5
  declaration completeness, T6 webview alias closure, T7 ledger transition
  graph) land and the strict re-acceptance reruns.

## Alternatives considered

- Keeping strict while repairing: rejected — the strict label is the
  program's strongest claim and must not coexist with a known-open trust
  chain.
- Fixing the trust chain without the regression: rejected — the ledger
  would assert a property the harness cannot currently prove.

## Compatibility and migration

No production code, protocol, or persisted-format change. The regression is
a ledger state move; the repair series restores strict through the normal
forward transition once the trust chain holds.

## Tests

- The regression itself exercises the R9 ledger-regression detection: this
  PR fails the anti-self-amendment gate without this record in base.
- Each T-slice ships its own controlled mutations.

## Rollback

Revert the merge commit: the module returns to strict. (The trust-chain
defects would remain open; that is a statement of fact, not a fix.)

## Machine summary

```arch-change
{
  "id": "ARCH-CHANGE-006",
  "status": "approved",
  "modules": ["MOD-WORKTREE-LIFECYCLE"],
  "delta": {
    "ledgerRegressions": ["MOD-WORKTREE-LIFECYCLE: strict -> migrating"]
  }
}
```
