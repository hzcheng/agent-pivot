# Nested Container Provider Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let NEW launch any registered AI provider without a blocking Extension Host `PATH` preflight, so nested Remote SSH and Dev Container windows defer executable resolution to the actual Terminal or tmux runtime.

**Architecture:** Move provider-choice presentation into a pure `providers.ts` mapper that depends only on provider identity and label. Wire `dashboard.ts` to show those unconditional choices once, remove the obsolete filesystem availability helper, and retain all existing creation-controller and runtime behavior.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `node:test`, JSON behavior contracts, repository safety scripts.

## Global Constraints

- Apply the behavior equally to Codex, Kimi, and Claude.
- Do not add provider-specific paths, login-shell probes, remote-container branches, or fallback directories.
- Do not change command builders, Terminal launch serialization, tmux discovery, workspace-root selection, pending-session state, or DevBox configuration.
- A genuinely missing provider executable must be reported by the actual Terminal or tmux runtime.
- Follow RED before production edits.
- Keep the main checkout untouched; work only in `.worktrees/fix-nested-container-provider-preflight`.

---

### Task 1: Establish CI-Owned RED Coverage

**Files:**
- Modify: `tests/unit/aiSessions/sessionBoundaries.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: existing `out/aiSessions/providers` exports and provider definitions.
- Produces: behavior contract `SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001` with a failing expectation for `buildAiSessionProviderPicks(providers)`.

The required PR-check path is:

```text
quality-linux
  -> npm run test:ci:linux
    -> npm run test:deterministic:run
      -> node --test 'tests/unit/**/*.test.js'
        -> tests/unit/aiSessions/sessionBoundaries.test.js
```

- [ ] **Step 1: Replace the obsolete availability import with the provider module**

Change the test import to:

```js
const aiSessionProviders = require('../../../out/aiSessions/providers');
```

- [ ] **Step 2: Replace the old PATH-scanning test with the desired picker behavior**

Use the existing behavior ID literally:

```js
test('SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001 keeps every registered provider selectable without reading command paths', () => {
    const providers = [
        {
            id: 'codex',
            label: 'Codex',
            get commandName() {
                assert.fail('provider choices must not inspect commandName');
            },
        },
        {
            id: 'kimi',
            label: 'Kimi',
            get commandName() {
                assert.fail('provider choices must not inspect commandName');
            },
        },
        {
            id: 'claude',
            label: 'Claude',
            get commandName() {
                assert.fail('provider choices must not inspect commandName');
            },
        },
    ];

    assert.deepEqual(aiSessionProviders.buildAiSessionProviderPicks(providers), [
        {
            label: 'Codex',
            description: 'Open a new Codex session',
            providerId: 'codex',
        },
        {
            label: 'Kimi',
            description: 'Open a new Kimi session',
            providerId: 'kimi',
        },
        {
            label: 'Claude',
            description: 'Open a new Claude session',
            providerId: 'claude',
        },
    ]);
});
```

- [ ] **Step 3: Retitle and repoint the behavior contract**

Keep the stable ID and replace its catalog entry with:

```json
{
  "id": "SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001",
  "domain": "session",
  "title": "New AI sessions keep every registered provider selectable until runtime launch",
  "priority": "P1",
  "status": "automated",
  "owners": [
    "tests/unit/aiSessions/sessionBoundaries.test.js"
  ],
  "evidence": [
    "src/aiSessions/providers.ts",
    "src/dashboard.ts"
  ]
}
```

- [ ] **Step 4: Compile unchanged production code**

Run:

```bash
npm run test-compile
```

Expected: PASS. This confirms the baseline implementation still builds.

- [ ] **Step 5: Run the focused owner and verify RED**

Run:

```bash
node --test tests/unit/aiSessions/sessionBoundaries.test.js
```

Expected: FAIL only at `SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001` because `aiSessionProviders.buildAiSessionProviderPicks` is not a function. This is the missing behavior; do not edit production code until this failure is observed.

- [ ] **Step 6: Verify the catalog edit itself is structurally valid**

Run:

```bash
npm run test:behavior-contracts
```

Expected: PASS. The behavior remains owned by a CI-reachable unit test even though that owner is intentionally RED.

---

### Task 2: Remove the Blocking Provider Preflight

**Files:**
- Modify: `src/aiSessions/providers.ts`
- Modify: `src/dashboard.ts`
- Delete: `src/aiSessions/providerAvailability.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Consumes: `AiSessionProviderDefinition.id`, `AiSessionProviderDefinition.label`, and `getRegisteredAiSessionProviders()`.
- Produces: `buildAiSessionProviderPicks(providers): AiSessionProviderPick[]`.
- Preserves: `AiSessionCreationControllerOptions.pickProvider(): Thenable<AiSessionProviderId | undefined>`.

- [ ] **Step 1: Add the pure provider-choice model**

Add to `src/aiSessions/providers.ts`:

```ts
export interface AiSessionProviderPick {
    label: string;
    description: string;
    providerId: AiSessionProviderId;
}

export function buildAiSessionProviderPicks(
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'label'>[]
): AiSessionProviderPick[] {
    return providers.map(provider => ({
        label: provider.label,
        description: `Open a new ${provider.label} session`,
        providerId: provider.id,
    }));
}
```

- [ ] **Step 2: Wire the dashboard picker to the pure model**

Extend the existing `./aiSessions/providers` import with
`buildAiSessionProviderPicks`.

Replace the looping `pickAiSessionProvider` body with:

```ts
const pickAiSessionProvider = async (): Promise<AiSessionProviderId | undefined> => {
    const quickPickOptions: vscode.QuickPickOptions = {
        placeHolder: 'Select an AI provider',
        ignoreFocusOut: true,
    };
    (quickPickOptions as vscode.QuickPickOptions & { title?: string }).title = 'Select an AI provider';
    const selected = await vscode.window.showQuickPick(
        buildAiSessionProviderPicks(getRegisteredAiSessionProviders()),
        quickPickOptions
    );
    return selected?.providerId;
};
```

Remove the `isCommandAvailableOnPath` import. Do not remove `existsSync`,
because `resolveAiProviderExecutable` still uses it for bounded provider
capability probing after a provider has been chosen.

- [ ] **Step 3: Delete the obsolete availability module**

Delete:

```text
src/aiSessions/providerAvailability.ts
```

Confirm no import or require remains:

```bash
rg -n "providerAvailability|isCommandAvailableOnPath|was not found on PATH" src tests scripts
```

Expected: no matches after Step 4 updates the safety script.

- [ ] **Step 4: Replace obsolete safety-script coverage**

Remove:

```js
const providerAvailability = require('../out/aiSessions/providerAvailability');
```

Delete `runAiSessionProviderAvailabilityChecks()` and its invocation from
`scripts/run-ai-session-safety-checks.js`.

In `runHostRuntimeCompositionChecks()` in
`scripts/run-ai-session-tmux-checks.js`, add:

```js
assert.ok(dashboardSource.includes(
    'buildAiSessionProviderPicks(getRegisteredAiSessionProviders())'
));
assert.ok(!dashboardSource.includes('isCommandAvailableOnPath'));
assert.ok(!dashboardSource.includes('was not found on PATH'));
```

These compatibility checks supplement the behavior owner by proving that the
production dashboard uses the unconditional model.

- [ ] **Step 5: Compile and verify focused GREEN**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/sessionBoundaries.test.js
```

Expected: both commands PASS; the focused behavior produces three enabled
choices without touching `commandName`.

- [ ] **Step 6: Verify the affected gates**

Run:

```bash
npm run test:behavior-contracts
npm run test:unit
npm run test:safety:run
```

Expected: all commands PASS.

- [ ] **Step 7: Review the focused diff**

Run:

```bash
git diff --check
git diff --stat
git diff -- src/aiSessions/providers.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js tests/unit/aiSessions/sessionBoundaries.test.js docs/testing/behavior-contracts.json
```

Expected: only the unconditional picker, old helper removal, and its direct
coverage change.

- [ ] **Step 8: Commit the implementation intentionally**

Run:

```bash
git add src/aiSessions/providers.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js tests/unit/aiSessions/sessionBoundaries.test.js docs/testing/behavior-contracts.json
git add -u src/aiSessions/providerAvailability.ts
git commit -m "fix: defer AI provider resolution to runtime"
```

Expected: one implementation commit containing the observed RED owner and the
minimal GREEN fix.

---

### Task 3: Audit the Implementation Commit

**Files:**
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the exact Task 2 implementation commit hash.
- Produces: a current main-capability audit assigning that commit to `MAIN-RUNTIME-SESSION-RECOVERY`.

- [ ] **Step 1: Capture the exact implementation commit**

Run:

```bash
git rev-parse HEAD
```

Expected: the 40-character hash of `fix: defer AI provider resolution to runtime`.

- [ ] **Step 2: Advance audit currency with the exact captured hash**

Use `apply_patch` to:

1. set `audit.head` to the captured hash;
2. append the same hash to `MAIN-RUNTIME-SESSION-RECOVERY.commits`;
3. append `SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001` to
   `MAIN-RUNTIME-SESSION-RECOVERY.behaviors`.

Do not add the design commit to `ignoredDocumentationCommits`; documentation-only
commits after the old audit head are permitted automatically.

- [ ] **Step 3: Validate the audit**

Run:

```bash
npm run test:behavior-contracts
node --test tests/unit/tooling/mainCapabilityCoverage.test.js
git diff --check
```

Expected: all commands PASS with no unaudited implementation commit.

- [ ] **Step 4: Commit the audit**

Run:

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit runtime provider launch coverage"
```

Expected: one audit commit after the implementation commit.

---

### Task 4: Review, Fix, and Prove the Branch

**Files:**
- Review: every path changed since `origin/main`
- Modify: only files required by actionable review findings
- Modify after any implementation follow-up: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the complete implementation and audit commits.
- Produces: a reviewed, freshly verified branch ready for local packaging.

- [ ] **Step 1: Invoke the repository review loop**

Use `review-fix-commit-loop` and `requesting-code-review`. Review specifically:

- whether any picker path can still mark a registered provider unavailable;
- whether `commandName` remains available for actual runtime and capability use;
- whether cancellation still returns `undefined`;
- whether Kimi, Codex, and Claude receive identical treatment;
- whether deletion of `providerAvailability.ts` leaves generated output or stale imports.

- [ ] **Step 2: Apply only actionable fixes**

For every accepted finding:

1. add or adjust a failing test first;
2. observe the focused RED;
3. use `apply_patch` for the minimal fix;
4. rerun focused GREEN;
5. commit the fix separately.

If a follow-up commit changes production, tests, safety scripts, skills, or
behavior ownership, advance `docs/testing/main-capability-coverage.json` again:
set `audit.head` to the latest implementation commit, append that hash to
`MAIN-RUNTIME-SESSION-RECOVERY.commits`, validate, and commit the audit update.

- [ ] **Step 3: Run the Linux CI equivalent**

Invoke `verification-before-completion`, then run:

```bash
npm run test:ci:linux
```

Expected: PASS with behavior contracts, lint, deterministic suites, browser
suite, safety checks, architecture guards, production bundle, release
packaging, and coverage ratchets all green.

- [ ] **Step 4: Run the tmux environment gate**

Run:

```bash
AGENT_PIVOT_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
```

Expected: PASS. Provider selection changes must not disturb tmux launch.

- [ ] **Step 5: Inspect final branch state**

Run:

```bash
git status -sb
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: clean branch, intentional commits only, and no main-checkout changes.

- [ ] **Step 6: Package and install for the nested DevBox manual check**

Use `installing-vscode-extensions-locally` to build, package, install, and
reload the Agent Pivot VSIX in the innermost DevBox Extension Host.

In the DevBox container window:

1. click CURRENT WORKSPACE → NEW;
2. select Kimi;
3. confirm no `Unavailable — kimi was not found on PATH` message appears;
4. confirm a Kimi runtime is created and the actual Terminal/tmux command starts.

Record the installed VSIX identity and the observed result before claiming the
regression fixed.
