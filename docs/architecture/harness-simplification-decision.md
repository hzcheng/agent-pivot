# Harness Simplification Decision

Date: 2026-08-19
Status: accepted
Author: repository owner

## Context

The architecture harness (v0, rounds 1-2) grew to ~3,500 lines of guard
scripts, six JSON policy files, a machine-authorization Architecture Change
record system, guard-mutation parity, a Change Impact Declaration schema,
and a program ledger with state-machine validation.

135 architecture tests pass, including 91 controlled mutations, but several
known trust-boundary and scanner bypasses remain. The passing suite proves
the implemented cases, not completeness. Known gaps include:

- parity permanent exemption (guardSemantics records);
- invariant enforcement gaps (shared-store writer union);
- Webview alias bypasses (globalThis/alias/destructuring).

The final review identified three systemic problems that cannot be fixed
by adding more checks:

1. **The trust root is not small enough.** Parity, Architecture Change
   records, CID, ledger, and capability audit form a complex meta-system.
   The parity runner, guardSemantics exemptions, and record consumption
   logic each create new bypass surfaces.

2. **Scanners infer what code structure should express.** The single-writer
   AST scanner attempts to understand barrels, aliases, structural typing,
   destructuring, and store provisioning. The webview global scanner
   attempts to model producer/consumer/bundle relationships. New syntax
   forms will always produce new bypasses.

3. **Auxiliary information became mandatory contracts.** CID, program
   ledger, and Architecture Change documents were meant to help owner
   review but now carry authorization, state-machine, and exact-match
   responsibilities. The schema is complex, AI can generate formally
   correct but low-value content, and the harness's own maintenance cost
   grows with each round.

## Decision

The current implementation is retained as a transitional state. No further
patches will be applied to the existing harness. Instead, a six-PR
simplification replaces the complex system with a minimal trusted kernel
and code-structure enforcement.

### What stays

| Mechanism | Rationale |
|---|---|
| exactly-one module/role classification | Core invariant; all files must be owned |
| module dependency / public entrypoint / cycle | Core invariant; boundaries must be declared |
| baseline, waiver, writer, public surface ratchet | Core invariant; debt cannot grow silently |
| owner approval binding full HEAD SHA | Core invariant; PR head must be approved |
| trusted default-branch evaluator | Core invariant; PR code must not evaluate itself |

### What is replaced

| Mechanism | Replacement |
|---|---|
| Architecture Change machine authorization | ADR documents only; no consumption by future PRs |
| guardSemantics exemption | Removed; replaced by architecture approval |
| guard mutation parity | Removed; replaced by trusted kernel |
| CID JSON gate | Downgraded to auto-generated report |
| program ledger | Reduced to state graph + strict acceptance |
| single-writer AST scanner | Eventually replaced by narrow facades |
| capability audit | Retained as regression tracking only; no authorization role |

### Architecture Change records: transitional vs. final

- **PR #294–#295**: Old mechanisms remain as transitional enforcement. No
  new records may be created or consumed during this window.
- **After PR #296 merges**: Records become historical ADRs. Machine
  authorization is deleted. The ledger's regression-detection language
  references "Architecture Change record" only as a transitional concept;
  the trusted kernel replaces it.

### New approval model

Two distinct owner approvals, both binding the full HEAD SHA:

- `approve <full-head-sha>` — standard merge approval
- `approve-architecture <full-head-sha>` — architecture change approval

Standard approval cannot substitute for architecture approval. Both expire
when HEAD moves (synchronize events).

#### What architecture approval authorizes

Architecture approval authorizes explicit changes to **canonical policy**
(the files under `docs/testing/architecture-*.json`). It does not authorize
illegal code.

**Non-waivable** (even with architecture approval):

- Policy schema must be valid
- Every file must have exactly one module and one role
- Dependency graph must be resolvable
- Code must satisfy the head policy (the policy after the change, not before)
- Approval must bind the exact HEAD SHA

**Waivable** with `approve-architecture <sha>`:

- Explicit `mayDependOn` additions
- Public entrypoint changes
- Writer set changes
- Baseline additions (new cycle debt)
- Waiver additions
- Changes to the trusted kernel / harness itself

### Protected paths

Paths that require `approve-architecture` to modify (transitional list;
the canonical list lives in the default-branch trusted kernel, not here):

- `scripts/architecture/**`
- `tests/unit/architecture/**`
- `tests/unit/architecture-parity/**`
- `.github/workflows/**`
- `scripts/run-architecture-guards.js`
- `scripts/run-guard-mutation-parity.js`
- `scripts/run-merge-approval-gate.js`
- `scripts/lib/mergeApprovals.js`
- `scripts/lib/ciContracts.js`
- `scripts/lib/changeImpactContext.js`
- `tests/unit/tooling/mergeApprovalGate.test.js`
- `.ci/architecture-debt-baseline.json`
- `docs/testing/architecture-*.json`
- `package.json` (CI/guard wiring sections)

### Minimal trusted kernel (PR #295)

The trusted kernel runs on the default branch. It reads PR HEAD as data
only. The following constraints are mandatory:

**Execution model**:
- The workflow, evaluator, and all dependencies come from the default branch
- No PR HEAD npm scripts are executed
- No `require`/`import` of PR HEAD JS/TS
- No PR HEAD executable configuration is read as commands
- PR HEAD is materialized in an isolated directory
- The evaluator may only parse HEAD files (JSON, source text)

**Decision logic**:
- Without `approve-architecture`: protected-path changes fail immediately
- With `approve-architecture`: parse and validate the HEAD policy, then
  use it to check HEAD source against the (possibly changed) policy
- On `synchronize`: old approval is invalidated automatically
- Before PR #296 begins: the new status check must be configured as a
  required branch check

**Controlled counter-examples** (each must be killed by the kernel):

1. Unclassified new file
2. File in two modules or two roles
3. Illegal cross-module import
4. Deep import past declared entrypoints
5. New cycle without baseline addition
6. Baseline growth without waiver
7. Waiver addition without architecture approval
8. Writer set growth without architecture approval
9. Protected guard change without architecture approval
10. Standard approval used for architecture change
11. Stale approval after new commit (synchronize)

### Implementation plan

| PR | Scope | Hard exit condition |
|---|---|---|
| #294 | Fix ADR, freeze migrations | Decisions unambiguous; W1 stays migrating |
| #295 | Minimal trusted kernel | Default-branch evaluator; all trust-boundary mutations killed; required status enabled |
| #296 | Delete machine authorization, parity, guardSemantics | Trusted kernel has taken over; old records cannot authorize |
| #297 | CID/ledger downgrade, read-only impact report | No AI JSON authorization; ledger handles state + strict only |
| #298 | W1 narrow writer facade | Unauthorized calls fail at compile/dependency layer; complex method scanner not needed |
| #299 | W1 strict re-acceptance | No new design; fixed acceptance checklist only |

### Webview globals: moved out of W1 critical path

Webview scripts belong to MOD-DASHBOARD-SHELL, not MOD-WORKTREE-LIFECYCLE.
Converging them involves dozens of scripts, bundle ordering, and runtime
protocol — a bounded slice of its own.

- The existing webview guard stays as transitional/advisory
- Webview module bundling moves to MOD-DASHBOARD-SHELL's independent Stage 5 wave
- W1 strict is not blocked on webview global contract unless a specific W1
  invariant directly depends on it

## Consequences

- W1 (MOD-WORKTREE-LIFECYCLE) stays at `migrating` until PR #299
- All Stage 5 module migrations are paused
- Architecture Change records (ARCH-CHANGE-001 through 007) become
  historical ADRs after PR #296; no future PR may consume them
- The harness shrinks from ~3,500 lines of guard logic to a kernel small
  enough to fully reason about
- Each new mechanism must satisfy: one concrete bypass mutation, one
  canonical truth, executable by default-branch code, not dependent on
  AI-authored text, explainable as one clear red line, and preferentially
  solved through code structure

## Alternatives considered

- **Continue patching**: rejected. Each round adds more checks and more
  bypass surfaces. The marginal cost of the next check exceeds the marginal
  security gain.
- **Delete everything and start over**: rejected. The current tests are
  green, W1 is correctly at `migrating`, and the transitional harness
  catches real problems. Deleting it would regress below the current
  protection level.
- **Full rewrite in one PR**: rejected. Too large to review; six serial
  PRs let the owner verify each simplification step.
