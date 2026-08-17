# Architecture Harness and Repository Refactor Program

Status: proposed execution charter v3; implementation is not approved yet

v3 revisions: milestone-based waiver retirement, a declared-manifest edge
policy for import-free webview scripts, an explicit approval gate and
re-partition process for the initial module registry, Stage 2 delivery as a
reviewable PR series with a registry-only first PR, the debt-baseline file
renamed to avoid the performance-baseline name collision, explicit scope
decisions for companion extension source, and a stale-proof PR-declaration
check mechanism.

Baseline: `c783d76e` on `agent-pivot/arch-refact`, observed 2026-08-17

Scope: the entire repository, delivered through short-lived product-flow and
architecture-module slices

Behavior policy: preserve approved observable behavior unless a separately
approved product change says otherwise

## 1. Purpose

This program has three inseparable outcomes:

1. Refactor the repository so state ownership, dependency direction, mutation
   authority, failure recovery, and extension points are explicit and easy to
   test.
2. Make bugs converge quickly: a failure should identify one product
   capability, one architecture module, one operation, and one authority
   without reconstructing intent from several stores and protocols.
3. Build an executable architecture harness that prevents later features, bug
   fixes, and autonomous agent changes from silently weakening those decisions.

This is not a big-bang rewrite and not a file-splitting exercise. The program
first discovers and records architecture truths, then makes those truths
executable, and only then migrates one bounded product flow at a time. Every
migration must preserve approved behavior, improve named architecture and
diagnostic metrics, and leave behind guards that protect the result.

The first execution rounds are read-only investigation. No production code,
tests, contracts, or skills may be changed until the relevant investigation
report is reviewed and approved. Approved findings are then versioned in a
documentation-only change before implementation begins.

## 2. Why This Work Is Needed

Recent Worktree Tasks and AI Session work exposed recurring failure modes:

- One user operation can mutate several stores and external resources without
  a single owner for ordering, rollback, retry, and crash recovery.
- Session identity, generation, worktree identity, and serialized keys are
  represented by raw strings with duplicated codecs and equality rules.
- Webview mutations use several request/response conventions instead of one
  correlation and stale-response policy.
- Important state transitions are enforced in callers rather than at the
  boundary that owns the state.
- Large composition and UI files contain multiple state machines and make
  mutation authority difficult to locate.
- Existing guards protect many historical incidents, but do not yet form a
  closed-world source-ownership, module-boundary, and invariant-governance
  model.
- Commit-level capability traceability does not classify every source file or
  evaluate every dependency edge, so a newly created file can still fall
  outside architecture policy.

These are investigation hypotheses, not pre-approved conclusions. Stage 1
must confirm, reject, or refine each one with repository evidence.

## 3. Current Baseline

The repository already has a substantial quality harness. This program extends
it instead of replacing it.

Existing mechanisms include:

- `docs/testing/behavior-contracts.json` for user-visible behavior ownership.
- `docs/testing/main-capability-coverage.json` for implementation-commit
  traceability across existing `MAIN-*` product capabilities.
- `.ci/coverage-baseline.json` and changed-line coverage enforcement.
- `scripts/run-architecture-guards.js` and
  `tests/unit/tooling/architectureGuards.test.js` for historical architecture
  risks and controlled violation fixtures.
- Unit, contract, integration, browser, platform, tmux smoke, extension-host,
  packaging, performance, and release gates.
- `.github/workflows/verify.yml`, whose Linux quality job runs
  `npm run test:ci:linux`.
- A merge-approval gate whose approval becomes stale after a new commit.
- Repository skills that govern worktrees, regression repair, webview mutation
  protocols, review loops, publishing, and workflow lesson harvesting.

Observed facts at the baseline commit:

- approximately 348 production TypeScript/JavaScript files under `src/`
  (114,059 lines; verified at the Stage 1A census);
- 433 behavior contracts, including 24 architecture-domain entries;
- 31 existing `MAIN-*` product capabilities;
- 12 validators registered in `scripts/run-architecture-guards.js`; all 12
  have explicit negative mutation tests (135 controlled mutations, verified at
  the Stage 1A census).
- architecture documentation with stale hand-maintained counts, demonstrating
  that prose cannot be the only source of structural truth.

Observed concentration points:

| File | Lines | Investigation significance |
| --- | ---: | --- |
| `src/dashboard.ts` | 4,063 | activation, composition, orchestration, and integration touch points |
| `src/worktrees/groupManifestStore.ts` | 2,579 | persistence, validation, recovery, and group lifecycle responsibilities |
| `src/webview/webviewProjectAiSessionControlsScripts.js` | 2,948 | browser-side mutation and UI state machines |
| `src/webview/webviewGroupFormScripts.js` | 1,075 | group form workflow and mutation coordination |
| `src/aiSessions/sessionControllerComposition.ts` | 673 | session capability composition and cross-domain wiring |
| `scripts/run-architecture-guards.js` | 2,228 | many architecture rules concentrated in one imperative runner |

All counts are observations, not lasting truths. Stage 1 must reproduce them
from the current HEAD. Machine-generatable facts should not remain manually
maintained in authoritative documents.

Line count is a navigation signal, not a success metric by itself. Moving a
large block into several smaller files is useful only when each moved block
gains a clear owner and reduces coupling, mutation fanout, bypass count, or test
setup cost.

## 4. Program Goals

In priority order:

1. **Correctness:** product and temporal invariants hold across success,
   failure, retry, cancellation, restart, duplicate delivery, stale messages,
   and partial external side effects.
2. **Locatability:** every mutable fact has one named authority; every
   cross-module command and event has a traceable route; every failure reports
   operation, identity, stage, and recovery context.
3. **Testability:** decision logic is separated from VS Code, filesystem, Git,
   terminal, clock, process, and network effects; those effects are injected
   behind explicit ports where a real boundary exists.
4. **Evolvability:** adding an approved extension requires a bounded number of
   touch points, uses module public APIs, and cannot bypass a state authority.
5. **Durability:** every production file and import edge is covered by
   architecture policy, and later work fails locally and in CI when it crosses
   a boundary or introduces a second logical writer.
6. **Bug convergence:** representative historical and seeded defects require
   fewer files, fewer hypotheses, and less elapsed investigation time to reach
   the responsible authority after migration.
7. **Governability:** an agent cannot legalize its own violation by weakening a
   contract, guard, or baseline inside an ordinary feature or bug-fix change.
8. **Operability:** failure and recovery state is observable enough to diagnose
   without logging prompts, conversation bodies, secrets, or other sensitive
   payloads.

## 5. Non-Goals and Slice Ceiling

This program does not authorize:

- user-visible behavior changes;
- protocol or persisted-format breaks without an explicit migration;
- dependency additions or upgrades;
- framework replacement or whole-repository rewrite;
- speculative abstractions without a current caller, side-effect seam,
  invariant, or recorded duplication;
- mandatory interface or directory layers for simple pure code;
- unrelated cleanup or formatting;
- performance regressions;
- replacing useful behavior tests with source-text guards;
- installing a large collection of external skills before the repository's
  own needs and evaluation cases are known;
- a long-lived refactor branch that accumulates months of unrelated work.

One implementation slice should normally cover:

- one bounded product flow;
- one state-authority or invariant family;
- at most 12 production files or 1,200 non-generated changed production lines.

The file and line limits are review triggers, not targets to game. Exceeding
either requires a new plan and approval. Pure moves, generated outputs, mirrored
webview assets, tests, contracts, and audit records are counted and reported
separately. They do not justify mixing another semantic concern into the slice.

Harness and tooling changes (guard scripts, policy schemas, check runners) are
not production lines, but they follow the same reviewability rule: one harness
concern per PR, small enough to review line by line.

## 6. Architecture Vocabulary

- **Product Capability:** an existing user-facing `MAIN-*` capability used by
  behavior coverage and implementation-commit audit. A product flow may cross
  several architecture modules.
- **Architecture Module:** a source-ownership and dependency boundary with one
  purpose, a public API, owned state, and explicit allowed dependencies. Every
  production source file belongs to exactly one architecture module.
- **Role:** the responsibility of a source file inside its module:
  `presentation`, `application`, `domain`, `infrastructure`, or `composition`.
  Roles describe responsibilities and do not require five physical directories.
- **Invariant:** a condition that must remain true, including across time and
  failures. It is stronger than a validation rule on one object.
- **Authority:** the only component permitted to decide a fact or a state
  transition.
- **Single writer:** one logical production authority permitted to persist or
  transition a state family. Several physical adapters are allowed only when
  their ownership partitions are explicit and mechanically disjoint.
- **Linearization point:** the moment an operation becomes externally
  committed and retries must observe the same result.
- **Port:** an interface through which application/domain logic requests a
  genuine side effect without importing its concrete infrastructure.
- **Public entrypoint:** the only path through which another architecture module
  may import a module's behavior or types.
- **Deep import:** a cross-module import that bypasses the declared public
  entrypoint.
- **Bypass:** a call, import, write, protocol message, or raw codec that reaches
  protected state without going through its authority.
- **Architecture contract:** a versioned, machine-checkable record connecting
  an invariant to its authority, enforcement, tests, and evidence.
- **Waiver:** a precise, temporary exception for a known violation, with an
  owner, rationale, tracking reference, and a retirement milestone. A waiver
  is debt data, not an architecture API.
- **Ratchet:** a rule that allows legacy debt to stay equal or shrink, but never
  grow or change identity invisibly.
- **Strict mode:** the state in which an architecture module has no legacy
  baseline entries and every source file, dependency edge, writer, and relevant
  invariant is covered by enforcement.

Product capabilities and architecture modules are deliberately orthogonal.
Every implementation commit remains assigned to exactly one `MAIN-*` product
capability, while every production source file is assigned to exactly one
architecture module. A validated mapping connects the two models.

## 7. Architecture Red Lines

Stage 1 must turn these candidate principles into concrete, path-aware
contracts. A principle is not enforceable until its scope, owner, and detection
mechanism are explicit.

1. Architecture policy is closed-world: every production source file has one
   module and one role; unclassified and multiply classified files fail CI.
2. Cross-module imports use declared public entrypoints. Every resolved local
   dependency edge is either allowed or rejected; an unmatched edge never
   silently passes.
3. Presentation may issue commands and render results; it may not own domain
   truth or directly write persistence.
4. Application coordinators own multi-step use cases, ordering, idempotency,
   compensation, and operation-level error context.
5. Domain code owns identity, legal transitions, invariants, and pure decisions.
   It does not import VS Code, webview, process, filesystem, Git, terminal, or
   concrete stores.
6. Infrastructure implements domain/application ports and may not hide product
   transition decisions inside adapters.
7. Composition roots may wire modules but may not accumulate business rules.
   Their branching, construction fanout, and non-wiring statements are
   measured and ratcheted.
8. Each mutable state family has exactly one logical production writer.
9. Cross-store and external-side-effect workflows have one coordinator owner,
   a named linearization point, and explicit before/after-commit failure rules.
10. Persisted records are versioned, decoded in one place, and either backward
    compatible or migrated explicitly with old-version fixtures.
11. Domain identities use one canonical codec and equality policy; raw string
    construction outside that owner is a bypass.
12. Webview mutations use a declared correlation envelope with request
    identity, operation identity where needed, version, success/failure result,
    and stale-response handling.
13. Retries are idempotent or rejected deterministically; crash recovery does
    not guess between indistinguishable states.
14. Legal state transitions are enforced at the state-owning boundary, not by
    every caller remembering preconditions.
15. Events describe facts that occurred; commands express requested intent.
    Neither is used as an untyped escape hatch.
16. A new interface, port, or coordinator requires a real side-effect seam,
    current duplication, testability need, or invariant owner. Generic layering
    alone is not sufficient justification.
17. An ordinary feature or bug-fix change cannot relax an architecture
    contract, enlarge a baseline, add a writer, or broaden an allowed edge.
18. Architecture changes are approved separately before product work consumes
    them; an agent cannot approve its own architecture change.
19. Diagnostics identify capability, module, operation/request, entity,
    state/stage, error code, and recoverability where applicable, while
    redacting sensitive content.
20. Temporary waivers are exact, owned, bound to a retirement milestone, and
    mechanically ratcheted. Wildcards and permanent allowlists are forbidden.

The expected role direction inside a module is:

```text
presentation -> application/coordinator -> domain
                         |                  ^
                         v                  |
                 infrastructure -----------+
                    implements ports
```

This diagram describes responsibilities, not mandatory folders or one
interface per arrow. Cross-module dependencies are governed separately by each
module's declared public entrypoints and `mayDependOn` set. Stage 1 must map
these roles onto real code and record justified deviations before enforcement.

## 8. Harness Model

The harness has four layers. Later layers must not duplicate the truth owned by
earlier ones.

| Layer | Role | Examples |
| --- | --- | --- |
| Guidance | tells contributors and agents how to work | `AGENTS.md`, project skills, PR checklist |
| Contracts | canonical architecture decisions | module registry, invariant catalog, architecture-change records |
| Evidence | proves behavior and failure semantics | characterization, model, contract, integration, browser, compatibility, fault-injection tests |
| Enforcement | blocks architectural regression | closed-world graph checks, single-writer and bypass checks, ratchets, CI and owner approval |

Skills are guidance, not enforcement. Canonical truth belongs in versioned
repository contracts; tests and guards interpret those contracts; CI blocks a
violation; the repository owner approves semantic changes. A skill links to
canonical files and commands rather than copying their contents.

### 8.1 Proposed Canonical Files

The exact names are subject to Stage 1 approval. A preferred starting layout is:

```text
docs/testing/
  architecture-modules.json
  architecture-invariants.json
  architecture-waivers.json
  architecture-program.json
docs/architecture/changes/
  ARCH-CHANGE-<sequence>.md
.ci/
  architecture-debt-baseline.json
scripts/architecture/
  loadArchitecturePolicy.js
  buildDependencyGraph.js
  checkClosedWorld.js
  checkModuleBoundaries.js
  checkSingleWriters.js
  checkBypasses.js
  checkProtocolContracts.js
  checkRatchets.js
  checkTraceability.js
  reportArchitectureDiff.js
tests/architecture/
  policySchema.test.js
  closedWorld.test.js
  moduleBoundaries.test.js
  singleWriters.test.js
  bypasses.test.js
  protocols.test.js
  guardMutationTests.test.js
```

The debt-baseline file is deliberately named to stay distinct from the
existing performance-oriented `test:architecture-baseline` lane and
`.ci/conversation-performance.json`.

`scripts/run-architecture-guards.js` remains the stable public runner while
implementation is incrementally extracted behind it. Existing guard IDs and
behavior-contract ownership remain stable until an approved migration maps
them into the new catalogs.

`architecture-program.json` is the machine-readable progress ledger. It does
not redefine module or invariant truth; it references canonical IDs and records
migration state and evidence.

### 8.2 Architecture Module Record

The following record illustrates the target schema; it is not ready to commit
until Stage 1 confirms the module ID and every referenced path and product
capability exists:

```json
{
  "id": "MOD-WORKTREE-LIFECYCLE",
  "title": "Worktree lifecycle",
  "purpose": "Own worktree group and member lifecycle decisions.",
  "source": {
    "include": [
      "src/worktrees/application/**/*.ts",
      "src/worktrees/domain/**/*.ts",
      "src/worktrees/infrastructure/**/*.ts",
      "src/worktrees/index.ts"
    ],
    "exclude": [],
    "overrides": []
  },
  "publicEntrypoints": ["src/worktrees/index.ts"],
  "mayDependOn": ["MOD-WORKSPACE-IDENTITY"],
  "roles": [
    {
      "role": "application",
      "include": ["src/worktrees/application/**/*.ts"]
    },
    {
      "role": "domain",
      "include": ["src/worktrees/domain/**/*.ts"]
    },
    {
      "role": "infrastructure",
      "include": ["src/worktrees/infrastructure/**/*.ts"]
    },
    {
      "role": "composition",
      "include": ["src/worktrees/index.ts"]
    }
  ],
  "productCapabilities": ["MAIN-WORKTREE-LIFECYCLE"]
}
```

The actual repository structure may require file overrides during migration,
but overrides must be exact paths with owners and retirement states. Broad
catch-all overrides are forbidden. The validator must prove that every
production file is matched exactly once and assigned exactly one role.

### 8.3 Architecture Invariant Record

The following invariant likewise illustrates the target schema rather than a
pre-approved repository fact:

```json
{
  "id": "ARCH-WORKTREE-SESSION-LIFECYCLE-001",
  "module": "MOD-WORKTREE-LIFECYCLE",
  "productCapabilities": ["MAIN-WORKTREE-LIFECYCLE"],
  "priority": "P0",
  "kind": "recovery",
  "statement": "A worktree session lifecycle operation has one coordinator and one linearization point.",
  "authority": {
    "path": "src/worktrees/worktreeSessionLifecycleCoordinator.ts",
    "symbol": "WorktreeSessionLifecycleCoordinator"
  },
  "writers": [
    {
      "path": "src/worktrees/worktreeSessionLifecycleCoordinator.ts",
      "symbol": "WorktreeSessionLifecycleCoordinator"
    }
  ],
  "linearizationPoint": "The versioned manifest commit succeeds.",
  "enforcement": ["module-boundary", "single-writer", "behavior", "fault-matrix"],
  "behaviorOwners": ["tests/contract/worktrees/worktreeSessionLifecycle.test.js"],
  "guardOwners": ["tests/architecture/singleWriters.test.js"],
  "evidence": ["src/worktrees/worktreeSessionLifecycleCoordinator.ts"]
}
```

Dependency rules and forbidden APIs must use structured fields rather than
free-form strings such as `presentation -> infrastructure`. Every referenced
module, product capability, behavior ID, path, symbol where statically
available, owner, and evidence file must resolve and be cross-validated.

Legacy violations do not live inside invariant records. They belong only in
the generated baseline and waiver ledger, which makes debt changes independently
reviewable.

### 8.4 Waiver Record

A waiver must be precise and temporary:

```json
{
  "id": "ARCH-WAIVER-001",
  "contract": "ARCH-WORKTREE-SESSION-LIFECYCLE-001",
  "fingerprints": ["<deterministic violation fingerprint>"],
  "owner": "repository-owner",
  "reason": "Exact legacy paths pending migration wave W3.",
  "tracking": "ARCH-CHANGE-003",
  "createdAt": "2026-08-17",
  "retiresWith": "WAVE-W3",
  "expiresAt": null
}
```

A waiver is invalid and fails CI when it is unowned, wildcarded, duplicated,
unmatched to an active baseline fingerprint, or lists a fingerprint that is no
longer present (unused debt). Retirement is milestone-based: when the wave or
architecture change named in `retiresWith` completes in the program ledger
while any covered fingerprint persists, CI fails. Debt burn-down tracks
migration state, not wall-clock time, so a bare calendar date never turns CI
red without a code change; an optional `expiresAt` may raise a review warning
but never fails on its own. Moving a violation to another path produces a new
fingerprint and therefore cannot pass as unchanged debt.

The baseline and waiver ledger have different jobs but a strict relationship:
the baseline is the mechanically generated set of exact violation fingerprints;
the waiver ledger provides reviewable ownership and retirement metadata. Every
active baseline fingerprint is covered by exactly one active waiver, and every
fingerprint a waiver lists is an active baseline fingerprint. Neither file may
contain a fingerprint absent from the other. Because initial rule-by-rule
capture can produce hundreds of fingerprints, waiver skeletons are generated by
repository scripts from the baseline — owners fill in reason, tracking, and
retirement milestone — and one waiver record may cover an explicitly enumerated
set of fingerprints produced by the same rule in the same owning scope (no
wildcards); each fingerprint still appears individually in the baseline.

### 8.5 Program Ledger

Each architecture module moves through:

```text
legacy -> inventoried -> characterized -> guarded -> migrating -> strict
```

The ledger records the approved target, current state, invariant IDs, behavior
owners, baseline fingerprints, architecture-change records, migration PRs or
commits, verification evidence, and next action. State transitions are
validated; an agent cannot mark a module `strict` while it still has a waiver,
baseline entry, unclassified file, illegal edge, unowned state family, or
missing P0/P1 owner.

### 8.6 Closed-World Enforcement

The closed-world guard must:

- enumerate every in-scope production source file; Stage 1A must record an
  explicit in-scope or out-of-scope decision, with rationale, for the companion
  extension source (`extensions/attention-ui-bridge`, `shared/attention-bridge`)
  — separate compile units with their own tsconfigs — and for `spikes/`;
- require exactly one architecture module and exactly one role per file;
- resolve all static local imports, re-exports, and type-only imports;
- govern import-free browser-side webview script families through a declared
  manifest (bundle membership, load order, and permitted cross-script symbols):
  at the baseline commit all 37 `src/webview/*.js` files contain zero static
  `import`/`require` edges, so the module graph alone cannot police them, and
  an undeclared cross-file reference fails validation;
- reject unclassified, multiply classified, unresolved-local, forbidden, and
  cross-module deep-import edges;
- require every new public entrypoint and allowed module dependency to be
  declared;
- map every architecture module to at least one existing or approved new
  `MAIN-*` product capability;
- detect cycles at the module level and report the shortest explanatory cycle;
- print the source, target, module, role, governing contract, and remediation.

The guard must fail closed: a file type, source root, import form, or edge it
does not understand is an error until policy is extended deliberately.

### 8.7 Guard Trust Hierarchy and Quality

Choose the strongest practical enforcement mechanism in this order:

1. type system, module exports, inaccessible constructors, and capability
   tokens that make a violation impossible;
2. complete dependency graph and public-entrypoint enforcement;
3. AST-based semantic checks;
4. runtime contract, model, compatibility, and fault-injection tests;
5. exact source-text or call-count checks only when the stronger mechanisms
   cannot express the risk.

Every executable guard must:

- state what violations it can and cannot detect;
- accept representative valid fixtures, including equivalent syntax;
- reject one controlled mutation for every claimed violation dimension;
- emit the contract ID, source, forbidden target or operation, risk, and
  remediation direction;
- behave deterministically across supported platforms where applicable;
- avoid formatting-sensitive assertions when a graph, AST, exported registry,
  or runtime test can express the rule;
- have one clear owner test;
- run through `npm run test:architecture-guards` and the Linux CI gate;
- meet an approved local and CI runtime budget.

The controlled guard mutation kill rate must be 100%. A guard without a
negative mutation test is incomplete because it may be green while checking
nothing useful. Stage 1 inventories every existing guard and classifies its
coverage, false-positive risk, false-negative risk, and migration plan.

### 8.8 Progressive Enforcement

The program uses two enforcement modes:

- **Legacy module:** record only violations produced by an implemented,
  reviewed rule in `.ci/architecture-debt-baseline.json`. A change may keep or
  remove the exact fingerprints but may not add, move, generalize, or replace
  them. Every fingerprint is covered by exactly one active waiver with
  ownership and a retirement milestone.
- **Strict module:** remove all baseline entries and waivers for the module.
  New violations and exceptions are zero-tolerance.

Baseline capture is rule-by-rule, not one bulk snapshot of everything a first
scanner happens to report. Candidate violations are reviewed before recording
so the baseline cannot canonize false positives or obsolete architecture.

Ordinary feature and bug-fix PRs must have a zero-or-negative architecture debt
delta. They may not enlarge the baseline, add a waiver, relax an invariant,
broaden `mayDependOn`, add a writer, or weaken a guard.

### 8.9 Anti-Self-Amendment Gate

A genuine architecture relaxation or boundary change requires a dedicated
Architecture Change PR that lands before product work consumes it. The change
contains:

- one `ARCH-CHANGE-*` record with problem evidence, old and new rules,
  alternatives, compatibility impact, migration, tests, and rollback;
- a machine-generated diff of modules, public entrypoints, allowed edges,
  authorities, writers, invariants, waivers, and baseline fingerprints;
- controlled mutations proving the changed guard still detects its stated
  risks;
- explicit repository-owner approval newer than the final commit.

CI classifies a PR as product-only, tightening architecture, or relaxing
architecture. A product-only PR that changes protected architecture policy
fails. A product PR cannot bundle and consume a relaxation. Tightening may
travel with the migration that removes the final bypass when the diff only
reduces debt and keeps the commit independently reviewable.

CI recognizes a fourth classification: **registry re-partition** — splitting,
merging, or renaming architecture modules, or re-assigning files between them,
without broadening any allowed edge, writer set, or waiver. Re-partitioning the
deliberately coarse initial registry is an expected first-class operation, not
a design failure. It still requires an Architecture Change record and owner
approval, but its evidence burden is the machine-generated registry diff plus
proof that no edge, writer, or waiver was broadened.

Baseline and waiver files are generated or updated only through repository
scripts with exact reasons and references. Manual broadening fails validation.

### 8.10 Change Impact Declaration

Every implementation PR declares in its checked PR body:

- one main `MAIN-*` product capability per implementation commit;
- architecture modules touched;
- invariant and behavior IDs touched;
- whether state authority, writer set, protocol, persistence, identity, or
  recovery semantics changed;
- architecture-policy delta classification;
- baseline and waiver delta, normally zero;
- focused and environment verification performed.

CI compares the declaration with the actual diff and generated architecture
impact report. Because editing a PR body does not retrigger workflows, this
comparison runs in the merge-approval gate (or via an on-demand recheck
command) against the current head commit rather than as a push-triggered
check; a declaration is stale until regenerated for the head being approved.
New files must already be classified. Cross-module changes must
name the coordinator or public API that owns the interaction. The declaration
does not replace enforcement; it makes semantic intent visible to the owner
before approval.

## 9. Invariant Discovery Method

Invariant discovery is performed from repository evidence, not generated from
pattern names. For each product flow and architecture module:

1. Start from user journeys, behavior contracts, recent bugs, PRDs, recovery
   code, persisted schemas, cross-process protocols, and operational logs.
2. Identify the facts that must remain true before and after each operation.
3. Identify temporal rules: what must hold during retry, crash, cancellation,
   duplicate delivery, stale response, concurrency, and restart.
4. Name the authority and all current readers, logical writers, and physical
   adapters.
5. Locate the linearization point and ambiguous partial states.
6. Enumerate every externally visible side effect and failure point before and
   after linearization.
7. Record current enforcement, bypasses, test blind spots, and diagnostic gaps.
8. Classify the invariant as product, state-machine, identity, persistence,
   protocol, concurrency, recovery, dependency, performance, or security.
9. Assign P0/P1/P2 and choose the strongest practical enforcement mechanism.
10. Test the candidate invariant against historical counterexamples: it should
    explain a real risk without banning valid equivalent implementations.

The output is not merely a prose list. Each P0/P1 invariant eventually maps to
a stable contract ID, one architecture module, affected product capabilities,
an authority, at least one behavioral owner, and an executable architecture
guard where structure is part of the rule.

### 9.1 Incident-to-Invariant Feedback Loop

Every escaped bug is classified after the immediate fix:

- missing or weak behavior test;
- missing or incorrect invariant;
- authority or single-writer bypass;
- guard false negative;
- test double drift;
- protocol or persistence compatibility gap;
- observability gap;
- invalid architecture decision;
- ordinary local implementation defect under a sound architecture.

When architecture allowed the bug, the same repair line adds or strengthens
the relevant invariant, evidence, or guard. The skill-harvest review records
whether contributor guidance also failed. Repeated incidents of the same class
block declaring the affected module strict until the systemic gap is addressed.

## 10. Behavior Preservation and Test Architecture

“Preserve behavior” does not mean fossilize every accidental quirk. Before a
characterization test becomes a lasting contract, classify the observed
behavior as:

- **required compatibility:** public behavior, protocol, persisted data, or
  relied-on integration semantics that must remain;
- **intended current behavior:** explicitly accepted and protected;
- **known defect:** reproduced and retained only until a separately approved
  bug fix changes it;
- **unspecified observation:** useful during migration but not promoted to a
  permanent product promise.

Existing black-box behavioral assertions remain unchanged during a pure
architecture migration. White-box structural tests may move with an approved
boundary change when their behavioral intent is preserved and every affected
owner is listed. Interface changes require an affected-call-site inventory and
approval before implementation.

Use the cheapest test layer that can prove each rule:

- pure unit tests for identities, codecs, transitions, policies, and decisions;
- model/property tests for state machines and legal transition spaces;
- shared conformance suites for real adapters and fakes implementing the same
  port, preventing test-double drift;
- contract tests for module public APIs, messages, protocols, and storage
  adapters;
- old-version golden fixtures for persisted schemas and protocol compatibility;
- deterministic orchestration and fault-injection tests for multi-step use
  cases;
- integration tests for composition, real serialization, and cross-module
  wiring;
- browser, platform, tmux, remote, and extension-host tests only for behavior
  that requires those environments.

Do not mock the authority whose semantics the test claims to prove. Test data
builders and protocol fixtures should consume canonical codecs and validators
instead of reimplementing schemas in tests.

### 10.1 Failure Matrix

Every P0 cross-store or external-side-effect workflow has a reviewed matrix
covering, where applicable:

- validation rejection before effects;
- failure immediately before and after every effect;
- failure immediately before and after linearization;
- duplicate command delivery;
- concurrent conflicting operation;
- cancellation at each cancellable stage;
- retry before and after restart;
- stale webview response or replaced document;
- partially written or older-version persisted state;
- compensation failure;
- final diagnostic and user-visible recovery state.

The matrix names which cases are unit, model, contract, integration, scheduled,
or manual. A fake-only scenario is not marked equivalent to a real-environment
scenario unless the shared conformance suite proves the relevant semantics.

## 11. Bug Convergence Scorecard

Stage 1 establishes a baseline from a fixed set of historical incidents and
seeded faults. Use the same eval cases before and after migration so the program
measures improvement rather than relying on subjective confidence.

For each eval case record:

- elapsed time to a reproducible failing focused test or guard;
- elapsed time to the correct authority and root-cause hypothesis;
- production files inspected before localization;
- incorrect hypotheses or unrelated modules investigated;
- whether the failure identified product capability, module, operation/request,
  entity identity/generation, state/stage, error code, and recoverability;
- whether reproduction is deterministic;
- whether the final fix touched only the authority and expected adapters;
- whether the incident class had escaped previously.

Stage 1 proposes numeric targets after measuring the baseline. At minimum, a
migrated module cannot enter strict mode unless representative seeded failures:

- converge to one architecture module and one named authority;
- have a deterministic focused reproduction or a justified real-environment
  owner;
- meet the approved elapsed-time and search-surface targets, regress no agreed
  scorecard dimension, and materially improve at least one of inspected files
  or incorrect hypotheses;
- produce enough redacted context to distinguish retryable, terminal, stale,
  and compatibility failures.

Raw mean time to repair is not used alone because environment and issue size
vary. The scorecard combines time, search surface, diagnostic completeness,
reproducibility, and recurrence.

## 12. Delivery Stages and Approval Gates

### Stage 0 — Charter Approval

Confirm the concrete incidents in Section 2, the program scope, non-goals,
slice ceiling, terminology, and behavior-preservation policy.

Exit gate: this charter is accepted as the process for investigation. Approval
to investigate is not approval to implement its candidate architecture.

### Stage 1A — Read-Only Repository Census

Do not edit files. Recheck current HEAD and produce a repository-wide census:

1. authoritative, generated, stale, and historical architecture documents;
2. production source roots, file kinds, and proposed architecture-module
   ownership candidates, with an explicit in-scope or out-of-scope decision
   (and rationale) for `spikes/`, `extensions/`, and `shared/`;
3. complete local import/re-export/type-import graph and module cycles;
4. existing `MAIN-*` product capabilities and their relation to source areas;
5. mutable state, persistence, protocol, composition, and external-side-effect
   entry points;
6. existing behavior, coverage, architecture, performance, platform, and
   approval harnesses;
7. existing guard inventory with claimed risk, enforcement technique,
   positive/negative mutation coverage, and known blind spots;
8. risk-ranked product flows and architecture modules;
9. recommended pilot boundary, fixed bug-convergence eval cases, and scope
   estimate.

Every assertion cites repository-relative source, test, contract, or workflow
evidence. Separate facts, interpretations, hypotheses, and decisions.

Checkpoint: the user approves or changes the pilot, the eval set, and the
initial coarse module registry (candidate module list with source-root
ownership). Do not write implementation code or Harness v0 yet.

### Stage 1B — Read-Only Pilot Deep Dive and Harness RFC

Deeply investigate the approved pilot rather than pretending to deep-audit the
entire repository in one context window. Produce:

1. named end-to-end data flows;
2. source and state-authority map;
3. reader, writer, and bypass inventory;
4. state machines, legal transitions, and invalid-transition behavior;
5. P0/P1 invariant catalog;
6. cross-store and external-effect ordering, linearization, retry,
   compensation, and crash ambiguity;
7. protocol correlation, idempotency, timeout, stale-response, and compatibility
   analysis;
8. persisted schema and identity-codec inventory;
9. duplicate business-knowledge inventory with locations and occurrence count;
10. test blind spots and failure matrix;
11. current bug-convergence scorecard results;
12. target module boundary, public APIs, roles, and allowed dependency matrix;
13. normalized Harness v0 schemas and validation rules;
14. closed-world, mutation, ratchet, and anti-self-amendment guard design,
    including the declared-manifest edge policy for import-free webview script
    families;
15. CI commands, runtime budgets, and impact reporting;
16. ordered migration slices with verification and rollback points;
17. trade-offs with at least one rejected alternative.

Exit gate: the user approves the findings, target module model, Harness v0,
pilot boundaries, failure matrix, metrics, and first implementation slice. No
implementation begins before this gate.

### Stage 1C — Version Approved Findings

After approval, turn the accepted census and pilot RFC into repository
documents and machine-readable drafts in a documentation-only change. Do not
silently add new conclusions during transcription. Any material difference
returns to the user for approval.

Exit gate: versioned findings match the approved report and are independently
reviewable.

### Stage 2 — Harness Kernel

Establish a green baseline after `npm ci`, then implement only the enforcement
foundation.

Two prerequisites land before the numbered work: (a) the approved initial
module registry as its own registry-only PR — deliberately coarse and
directory-aligned, with later re-partitioning governed by Section 8.9; and
(b) one existing or newly approved `MAIN-*` product capability (for example
`MAIN-ARCHITECTURE-HARNESS`) to own harness implementation commits.

1. Add strict schemas and cross-file validation for module, invariant, waiver,
   program-ledger, and architecture-change records.
2. Build the complete production-file and dependency-graph enumerator.
3. Add closed-world classification, public-entrypoint, unresolved-edge, and
   cycle guards.
4. Extract reusable guard modules behind the existing runner without changing
   existing guard IDs.
5. Add positive and controlled negative mutation tests for each new guard
   dimension.
6. Add rule-by-rule baseline generation with stable fingerprints and no
   wildcard support.
7. Add architecture impact and policy-diff reports.
8. Add local focused and full CI commands with measured runtime budgets.
9. Wire the full gate into `test:ci:linux` without weakening an existing gate.
10. Add the Architecture Change classification and anti-self-amendment gate.

Stage 2 ships as an ordered series of small, independently reviewable PRs
(policy schemas and dependency graph; closed-world and boundary guards;
baseline, waivers, and ratchets; impact reports and the anti-self-amendment
gate), never as one kernel PR.

Exit gate: current behavior is green; every production file has exactly one
module and role; every local edge is resolved and evaluated; only illegal edges
and other implemented-rule violations appear as reviewed exact baseline entries
with matching waivers; Harness v0 kills all controlled violations; and no
production structure has changed.

Harness v0 should merge into `main` before the pilot production refactor so
concurrent feature work receives the new protection.

### Stage 3 — Pilot Safety Net

1. Add or strengthen characterization tests for the approved pilot behavior.
2. Classify each observed quirk as required, intended, defect, or unspecified.
3. Add state-machine model/property tests where transitions are non-trivial.
4. Add old-version persistence/protocol fixtures.
5. Add adapter/fake conformance tests where a fake participates in the pilot.
6. Complete the P0 failure matrix and prove each test fails under a controlled
   behavior mutation where practical.
7. Run the full relevant suite once to establish a fresh green baseline.

Exit gate: every behavior and failure semantic the production migration will
touch is locked by an appropriate test or has a justified real-environment
owner. No production structure has changed.

### Stage 4 — Pilot Production Migration

The recommended candidate remains **Worktree Group × AI Session lifecycle**
because it exercises state machines, multiple stores, Git/terminal effects,
provider data, crash recovery, webview mutation, and generation identity. Stage
1A must confirm or replace it.

If the candidate exceeds the slice ceiling, select one end-to-end operation
such as create, adopt, derive, merge, delete, or resume/recover and define its
exact product-flow and authority boundary.

Migration order:

1. Consolidate canonical identities and codecs only where the inventory proves
   duplication or inconsistent semantics.
2. Establish one coordinator and explicit ports at real side-effect seams.
3. Move one decision family at a time to its authority.
4. Keep pure moves/renames separate from logic changes.
5. Route existing callers through module public entrypoints.
6. Remove deep imports, second writers, and other bypasses.
7. Remove exact baseline entries and waivers for the migrated scope.
8. Enable strict guards for the architecture module.
9. Rerun the failure matrix, bug-convergence eval, and extension-point dry run.

Each implementation commit addresses one concern and remains compilable and
testable. Do not combine broad mechanical moves with semantic changes.

Exit gate: approved behavior is unchanged, P0/P1 invariants have owners,
bypasses and baseline entries are zero within the strict module, controlled
mutations are killed, and agreed convergence and architecture metrics improve.

### Stage 5 — Architecture Module Waves

Each remaining module receives a bounded read-only deep dive and repeats:

```text
investigate -> approve -> characterize -> contract -> guard
    -> migrate -> remove debt -> strict mode
```

Prefer vertical product flows for implementation planning, but attach source
ownership and strict-mode status to architecture modules. A vertical flow makes
behavior, persistence, UI protocol, and side effects reviewable together while
the module registry prevents cross-capability source ambiguity.

After Harness v0 is stable and before the first production migration, create a
minimal `.skills/developing-with-architecture-guardrails/` skill using
`skill-creator`. After two or three migrations, harvest lessons and strengthen
the skill from evidence. The skill links to canonical contracts and commands;
it does not duplicate them.

Exit gate per wave: the touched module is strict, the ledger transition is
valid, and the short-lived migration PR is merged before the next dependent
slice begins.

### Stage 6 — Program Acceptance

The repository-wide program is complete only when:

- every production source file belongs to exactly one architecture module and
  one role;
- every local dependency edge is classified and legal;
- every module has explicit public entrypoints and CI-enforced dependencies;
- module dependency cycles are zero unless an approved architecture contract
  proves a deliberate indivisible module, in which case the registry is
  corrected rather than waiving the cycle;
- every mutable state family has one logical authority, with mechanically
  disjoint partitions where multiple physical writers exist;
- every P0/P1 invariant has an authority, behavior owner, failure semantics,
  and suitable enforcement;
- every architecture module is in strict mode;
- the legacy architecture debt baseline and temporary waiver ledger are empty;
- illegal dependency, unclassified file, multi-writer, bypass, ambiguous crash
  state, and uncontrolled protocol-family counts are zero;
- persisted schemas and external protocols have compatibility fixtures;
- guard mutation suites achieve 100% controlled mutation kill rate;
- bug-convergence evals meet approved targets and produce redacted diagnostic
  context;
- full verification is green, coverage is at or above baseline, and hot-path
  budgets have not regressed;
- agreed extension-point dry runs meet their touch-point budgets;
- the program ledger, `AGENTS.md`, architecture documentation, and project
  skills agree with executable contracts;
- stale hand-maintained architecture facts have been generated, validated, or
  explicitly marked historical.

A known waiver, legacy baseline entry, or module not in strict mode prevents
declaring the whole-repository program complete. A deliberate allowed
relationship is encoded as normal architecture policy, not left as an
exception.

## 13. Workflows During and After the Program

Ongoing product work does not wait for the entire refactor, but it must respect
the enforcement state of every module it touches.

### 13.1 New Feature

1. Select the main `MAIN-*` product capability for each implementation commit.
2. Declare touched architecture modules and behavior/invariant IDs.
3. Identify state, authority, protocol, persistence, identity, recovery, and
   diagnostic impact before implementation.
4. Add or update behavior tests and failure cases.
5. If the feature requires a new module, public boundary, allowed dependency,
   or writer, stop and land an approved Architecture Change first. A new
   invariant that only tightens existing policy may accompany the product work
   with a controlled guard mutation.
6. Classify every new file and use module public entrypoints.
7. Implement through the authority; do not add a baseline entry or waiver.
8. Run focused, behavior, architecture, coverage, and relevant environment
   gates.

### 13.2 Bug Fix

1. Select or add a stable behavior ID.
2. Add a RED regression test and confirm it fails for the expected reason.
3. Classify the incident using the feedback loop in Section 9.1.
4. When architecture allowed the bug, add or strengthen the invariant,
   authority, diagnostic, guard, failure matrix, or conformance suite.
5. Add a controlled guard mutation when a structural blind spot existed.
6. Fix through the existing authority; do not expand the baseline.
7. Rerun the focused test, relevant suite, behavior contracts, architecture
   guards, and platform/environment gates.
8. Record the convergence evidence and recurrence classification.

### 13.3 Architecture Change

A genuine architecture relaxation follows the dedicated process in Section
8.9 and lands before its consumer. Tightening a rule still requires evidence
and mutations, but may land with the migration that removes the final bypass.

### 13.4 Architecture Documentation

Each architecture document is classified as:

- authoritative and CI-validated;
- generated from canonical contracts;
- explanatory but non-authoritative;
- historical and immutable.

Authoritative observations carry an `observedAtCommit` or are generated at
verification time. Hand-maintained counts that cannot be validated are removed.

## 14. Skills Strategy

External skills are not a prerequisite for Stage 1. The primary process skill
is `refactoring-architecture`; repository execution also uses the matching
project skills for worktrees, review loops, regression repair, webview mutation
protocols, publishing, and lesson harvesting when their descriptions apply.

After Harness v0 stabilizes and before production migration, create a minimal
project skill that requires agents to:

- read the module and invariant contracts for changed paths;
- produce a change impact declaration;
- use public entrypoints and authorities;
- run focused architecture guards before the full gate;
- stop for approval when a contract relaxation would be required;
- perform skill harvest after the final implementation commit.

Avoid evaluating the entire skill market. Use a small champion/challenger
process:

1. Define fixed repository tasks and scoring criteria.
2. Run a no-external-skill baseline.
3. Compare at most two candidates for one missing capability.
4. Inspect source, permissions, dependencies, and update risk before install.
5. Keep one champion per capability and pin its version.
6. Classify skills as Required, Approved, Experimental, or Reference-only.
7. Promote a skill only when it materially improves invariant recall,
   evidence quality, false-positive rate, convergence score, or execution cost.

Potential evaluation candidates, not installation requirements:

- an audit-context-building skill for candidate invariant and flow discovery;
- a property-based-testing skill for translating understood invariants into
  generative state and transition tests.

No public skill is a source of architectural truth. Repository contracts,
tests, CI, and owner approval remain authoritative.

## 15. Metrics and Ratchets

Stage 1 establishes reproducible collection commands and approved targets for:

- classified production file ratio, ultimately 100%;
- classified local dependency edge ratio, ultimately 100%;
- illegal and unresolved dependency edges;
- module cycles and deep imports;
- mutable state families with multiple logical writers;
- bypass count by invariant;
- P0/P1 invariants lacking authority, behavior owner, failure semantics, or
  enforcement;
- cross-store workflows with ambiguous crash states;
- duplicated identity codecs and business rules;
- uncorrelated or unversioned mutation message families;
- composition-root branching, construction fanout, and non-wiring statements;
- maximum mutation fanout for representative operations;
- files and modules changed to add a representative extension;
- controlled guard mutation kill rate, ultimately 100%;
- exact architecture debt baseline and waiver counts, ultimately zero;
- architecture guard local and CI runtime;
- bug-convergence time, files inspected, incorrect hypotheses, diagnostic
  completeness, deterministic reproduction, and recurrence;
- relevant coverage and performance budgets.

File size and complexity are supporting diagnostics, not primary success
metrics. Every extracted module needs a stated ownership reason and must reduce
coupling, writer count, bypass count, mutation fanout, or test setup cost.

No metric is improved by excluding files, weakening scope, renaming violations,
or moving debt to an unclassified path. Closed-world validation and stable
fingerprints make those changes fail.

## 16. Delivery Topology and Program Control

The program is delivered through short-lived PRs based on the latest
`origin/main`:

1. charter and approved investigation artifacts;
2. Harness kernel, as an ordered PR series (Section 12, Stage 2);
3. pilot safety net;
4. one or more bounded pilot migration slices;
5. pilot strict-mode completion;
6. subsequent module safety-net and migration slices.

Harness v0 merges early so concurrent work is protected. Each implementation
slice uses a new feature worktree after `git fetch origin main` and `npm ci`.
Do not keep the entire program on `agent-pivot/arch-refact` after the charter
and initial investigation work is handed off.

The program ledger is updated only with evidence from merged or reviewed
changes. Before starting a dependent slice, rebase the plan against current
`origin/main`, rerun the focused architecture census, and stop if concurrent
work invalidated the approved boundary or metric baseline.

One concern per implementation commit remains mandatory. Pure moves and renames
are separate from semantic changes. Every commit compiles and passes focused
tests so review, blame, and bisect remain useful.

## 17. Verification and Commit Discipline

Before verification in a worktree, run `npm ci`; do not rely on dependencies
from the primary checkout.

The Harness RFC must define two architecture lanes:

- a fast local lane for schemas, changed-file classification, dependency
  impact, and focused guards;
- a full lane for the complete source graph, all guard mutations, baselines,
  and cross-catalog traceability.

Both lanes have measured runtime budgets. The fast lane should be cheap enough
to run before every implementation commit; the full lane remains in Linux CI.

Minimum before every implementation commit:

```bash
npm run test-compile
<focused tests for the touched capability and module>
<focused architecture fast-lane command approved by Harness v0>
npm run test:architecture-guards
git diff --check
```

Also run, as applicable:

```bash
npm run test:behavior-contracts
npm run test:dashboard
npm run test:safety
npm run test:coverage:ci
npm run test:browser
npm run test:tmux:smoke
npm run test:ci:windows
npm run test:extension-host
```

Before final handoff of a slice, run a fresh:

```bash
npm run test:ci:linux
git diff --check
```

Every non-documentation implementation commit is assigned to exactly one
existing or approved new `MAIN-*` product capability. After implementation
commits, use a separate documentation-only audit commit via
`scripts/regenerate-capability-audit.js`, record the mandatory skill-harvest
decision, and rerun `npm run test:behavior-contracts` before push.

Commit messages, PR title, and PR body are English. Never push directly to
`main`; every `gh` command targets `hzcheng/agent-pivot` explicitly. No agent
self-approves an Architecture Change or merge.

## 18. Risks and Chosen Trade-offs

### Rejected: Big-Bang Layer Rewrite

It creates a long interval with two competing architectures, weakens
behavioral comparison, makes review and bisect ineffective, and exceeds the
repository's ability to prove failure compatibility.

### Rejected: One Exhaustive Whole-Repository Audit in One Chat

It encourages shallow inventories, loses evidence to context limits, and
creates a stale monolithic report before implementation begins. A global census
followed by bounded module deep dives preserves whole-repository coverage
without pretending every invariant was understood at once.

### Rejected: Harness-Only Freeze Before Any Pilot

A complete abstract rule system designed without one real migration is likely
to encode imagined boundaries and false positives. The kernel establishes
closed-world protection; the pilot validates and refines rule semantics while
core anti-bypass guarantees remain stable.

### Rejected: Refactor First, Add Guards Later

Without an initial safety net, moves can change behavior unnoticed and the
target structure can erode before it is encoded. Characterization and guard
work precede every production migration.

### Rejected: Generic Clean-Architecture Directories Everywhere

Mandatory layers create interfaces and indirection without ownership value.
This program uses capability-first modules and responsibility roles, introducing
ports only at real seams.

### Chosen: Progressive Strictness with Empty Final Baseline

Exact fingerprints prevent new debt immediately while allowing useful work to
continue. Every module then becomes exception-free, and the program cannot
finish until legacy debt is zero.

### Chosen: Vertical Product Flows, Module-Owned Strictness

Vertical flows make behavior and failure semantics reviewable end to end.
Architecture modules provide stable source ownership and dependency policy.
The explicit product-capability-to-module mapping connects delivery and
structure without forcing them to be the same partition.

## 19. First Handoff Deliverable

The next executing chat performs only Stage 1A and returns:

1. Executive summary and top repository risks.
2. Evidence and reproducible census commands.
3. Architecture-document authority/staleness classification.
4. Production source-root and file-kind inventory.
5. Candidate architecture modules and ambiguous ownership areas.
6. Complete dependency graph summary, cycles, deep-import candidates, and
   unresolved edge forms.
7. Mapping analysis between existing `MAIN-*` product capabilities and source
   ownership candidates.
8. State, persistence, protocol, composition, and external-effect entry points.
9. Existing Harness and guard trust/mutation inventory.
10. Risk-ranked product flows and recommended pilot boundary.
11. Fixed historical and seeded bug-convergence eval cases.
12. Stage 1B scope estimate, evidence plan, open decisions, and explicit
    approval request.

The report must not claim that a file-size count proves an architecture defect,
must not propose an abstraction without a current pain, duplicate, invariant,
side-effect seam, or caller, and must not begin the pilot deep dive before the
pilot checkpoint is approved.

## 20. Handoff Prompt for the Next Chat

Copy the following request into the executing chat:

```markdown
Work in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/arch-refact`
on branch `agent-pivot/arch-refact`.

Read `AGENTS.md`, then read
`docs/architecture-harness-refactor-program.md` completely. Load
`refactoring-architecture` and every matching repository skill before acting.
The earlier investigation context is available in local chat rollout
`019ffe7d-064a-7ac3-abeb-b2a30e40722c` if additional history is needed.

Execute only Stage 1A: the read-only repository census. Do not edit any file,
install external skills, change dependencies, commit, push, or open a PR.
Recheck the branch, HEAD, worktree status, source counts, behavior catalogs,
capability audit, guard registry, and current workflows instead of trusting
stale observations in the program document.

Produce all 12 sections required by “First Handoff Deliverable.” Cite
repository-relative files and line numbers for material findings. Clearly
separate facts, interpretations, hypotheses, and decisions that require user
approval. Pay particular attention to the difference between existing
`MAIN-*` product capabilities and candidate architecture modules, complete
source/edge classification, existing guard false-negative risk, and fixed
bug-convergence eval cases.

Stop after the Stage 1A report and ask for approval of the pilot and Stage 1B
scope. Do not perform the pilot deep dive, design final Harness v0, or make any
implementation change until that checkpoint is approved.
```

Prompts for later slices must additionally require `git fetch origin main`, a
fresh short-lived worktree per slice, and revalidation of the approved boundary
and metric baseline against current `origin/main` (Section 16). The chat
rollout reference in the prompt is optional history; this document and the
versioned findings remain the authoritative handoff.

## 21. Immediate Decision

The only decision needed to start is approval to run Stage 1A as specified. No
external skill installation and no production-code change are needed before
that census.
