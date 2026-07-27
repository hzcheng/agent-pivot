# Open Workspace Identity and View Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep same-path workspaces from different VS Code authorities distinct and keep the Agent Pivot dashboard usable when runtime discovery fails.

**Architecture:** The UI Bridge will pass authoritative URI strings together with the exact VS Code URI identity components and recompute all identities affected by the rewrite. The dashboard runtime boundary will treat visibility-triggered runtime discovery as best-effort, preserving the strict View Provider boundary for unrelated failures.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `node:test`, repository behavior-contract catalog, GitHub Actions `quality-linux`.

## Global Constraints

- Work only on `brand/marketplace-identity`; do not touch the dirty primary `main` checkout.
- Do not restore or mix the discarded `3.0.0` release-preparation changes.
- Use RED-before-production-edit for both regressions.
- Preserve URI identity semantics for decoded authority/path components and literal percent escapes.
- Runtime discovery failures remain structured diagnostics; only their propagation into view preparation changes.
- Advance the capability audit immediately after each implementation commit before running another behavior-catalog gate.
- Do not publish to the VS Code Marketplace.

---

### Task 1: Recompute identities from authoritative UI-host URIs

**Files:**
- Modify: `tests/contract/openProjects/projection.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `extensions/attention-ui-bridge/src/openWorkspacePublication.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: `createWorkspaceUriIdentity(source: WorkspaceUriIdentitySource): string` and `createWorkspaceScopeIdentity(sources: readonly WorkspaceUriIdentitySource[]): string`.
- Produces: `AuthoritativeOpenWorkspaceUri` and `replaceOpenWorkspacePublicationUris(raw, workspaceUri, rootUris)`.

- [ ] **Step 1: Add the failing cross-authority regression**

Add behavior contract `OPEN-OPEN-PROJECT-AUTHORITATIVE-IDENTITY-001` as an automated P0 open-project behavior owned by
`tests/contract/openProjects/projection.test.js`, with evidence in
`extensions/attention-ui-bridge/src/openWorkspacePublication.ts`.

Add this focused test while the production function still accepts URI strings:

```js
test('OPEN-OPEN-PROJECT-AUTHORITATIVE-IDENTITY-001 keeps same-path authorities as distinct workspace cards', () => {
    const source = makeRecord({ uri: 'file:///work/reddb', name: 'reddb' });
    const rewrite = (instanceId, environment, authority) =>
        replaceOpenWorkspacePublicationUris(
            makePublication({ instanceId, workspace: { ...source, environment } }),
            null,
            [`vscode-remote://${authority}/work/reddb`]
        ).workspace;
    const ssh = rewrite(OLDER, 'ssh', 'ssh-remote%2Bhost');
    const container = rewrite(NEWER, 'devContainer', 'dev-container%2Bdevbox');
    const projections = projectOpenWorkspaceNavigationCards(null, makeAggregate([
        makeRegistration(OLDER, 1000, ssh.navigationUri, { workspace: ssh }),
        makeRegistration(NEWER, 2000, container.navigationUri, { workspace: container }),
    ]), SELF);

    assert.notEqual(ssh.navigationIdentity, container.navigationIdentity);
    assert.notEqual(ssh.scopeIdentity, container.scopeIdentity);
    assert.notEqual(ssh.roots[0].id, container.roots[0].id);
    assert.equal(projections.length, 2);
});
```

Import `projectOpenWorkspaceNavigationCards` beside the existing projection imports.

- [ ] **Step 2: Run RED and confirm the identity collision**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/openProjects/projection.test.js
```

Expected: the new test fails because the rewritten SSH and Dev Container records retain identical identities and project to one card.

- [ ] **Step 3: Introduce the authoritative URI snapshot**

In `openWorkspacePublication.ts`, import the workspace identity functions and define:

```ts
export interface AuthoritativeOpenWorkspaceUri extends WorkspaceUriIdentitySource {
    value: string;
}
```

Change the replacement inputs to:

```ts
workspaceUri: AuthoritativeOpenWorkspaceUri | null,
rootUris: readonly AuthoritativeOpenWorkspaceUri[],
```

Validate paths using `.value`, then build the rewritten record with:

```ts
const roots = workspace.roots.map((root, index) => ({
    ...root,
    id: createWorkspaceUriIdentity(rootUris[index]),
    uri: rootUris[index].value,
}));
const navigationTarget = workspace.kind === 'singleFolder'
    ? rootUris[0]
    : workspaceUri;
const navigationUri = navigationTarget?.value || workspace.navigationUri;
const navigationIdentity = navigationTarget
    ? createWorkspaceUriIdentity(navigationTarget)
    : workspace.navigationIdentity;
const scopeIdentity = createWorkspaceScopeIdentity(rootUris);
```

Return these recomputed identities through the existing protocol validator.

- [ ] **Step 4: Capture exact VS Code URI components in the bridge**

In `extension.ts`, import `AuthoritativeOpenWorkspaceUri` and add:

```ts
function snapshotAuthoritativeUri(uri: vscode.Uri): AuthoritativeOpenWorkspaceUri {
    return {
        value: uri.toString(),
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
    };
}
```

Pass `snapshotAuthoritativeUri(vscode.workspace.workspaceFile)` whenever a workspace file exists, including untitled workspaces, and map every workspace folder through the same helper.

- [ ] **Step 5: Adapt the focused tests without reparsing serialized URIs**

Add a test helper that accepts explicit `value`, `scheme`, `authority`, and `path`. Update existing replacement calls to use it. For remote fixtures, use decoded authorities such as `ssh-remote+host` alongside serialized values containing `%2B`.

Extend the new regression to assert:

```js
assert.equal(
    ssh.navigationIdentity,
    createWorkspaceUriIdentity({
        scheme: 'vscode-remote',
        authority: 'ssh-remote+host',
        path: '/work/reddb',
    })
);
```

- [ ] **Step 6: Correct the legacy safety invariant**

In `run-open-project-safety-checks.js`, introduce the same explicit authoritative URI fixture shape. Replace the assertions that navigation, scope, and root identities remain equal with assertions that they equal the identities derived from the authoritative components and differ when the authority differs.

- [ ] **Step 7: Run GREEN and affected gates**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/openProjects/projection.test.js
node scripts/run-open-project-safety-checks.js
npm run test:behavior-contracts
```

Expected: all pass, and the focused regression produces two cards.

- [ ] **Step 8: Commit Task 1**

```bash
git add docs/testing/behavior-contracts.json \
  extensions/attention-ui-bridge/src/extension.ts \
  extensions/attention-ui-bridge/src/openWorkspacePublication.ts \
  scripts/run-open-project-safety-checks.js \
  tests/contract/openProjects/projection.test.js
git commit -m "fix: preserve authoritative workspace identities"
```

- [ ] **Step 9: Assign and audit Task 1 before the next catalog gate**

Add the Task 1 implementation commit and
`OPEN-OPEN-PROJECT-AUTHORITATIVE-IDENTITY-001` to
`MAIN-WORKSPACE-IDENTITY` and `MAIN-OTHER-WINDOWS`, set `audit.head` to the
Task 1 commit, then run and commit:

```bash
npm run test:behavior-contracts
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit authoritative workspace identity fix"
```

---

### Task 2: Keep the dashboard visible when runtime discovery fails

**Files:**
- Modify: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `src/dashboard/runtimeController.ts`

**Interfaces:**
- Consumes: `AgentPivotViewProvider` and `DashboardRuntimeController`.
- Produces: a non-throwing `handleAiSessionViewVisibilityChanged(visible: boolean): Promise<void>` after diagnostic logging.

- [ ] **Step 1: Add the failing view-resilience integration regression**

Add behavior contract `RUNTIME-DASHBOARD-VISIBILITY-RESILIENCE-001` as an automated P0 runtime behavior owned by
`tests/integration/dashboard/errorRecovery.test.js`, with evidence in
`src/dashboard/runtimeController.ts`.

Import `DashboardRuntimeController` and create a visible fake view. Wire its provider callback to:

```js
const runtime = new DashboardRuntimeController({
    isVisible: () => true,
    refreshProvider: () => undefined,
    logDashboardDiagnostic: () => undefined,
    executeCommand: async () => undefined,
    viewType: 'agentPivot.views.sidebar',
    publishOpenWorkspace: () => undefined,
    getCurrentSavedProject: () => null,
    syncProjectColorToCurrentWindow: async () => undefined,
    postMessage: async () => true,
    logError: () => undefined,
    refreshAiSessionRuntimes: async () => {
        throw new Error('transient runtime refresh');
    },
    logAiSessionRuntimeFailure: (operation, error) => diagnostics.push([
        operation,
        error.message,
    ]),
});
```

Use `renderContent: () => '<main>dashboard ready</main>'` and
`onVisibleChanged: visible => runtime.handleAiSessionViewVisibilityChanged(visible)`.
After `resolveWebviewView`, assert that the dashboard content rendered and the diagnostic is exactly:

```js
[['dashboard-visible', 'transient runtime refresh']]
```

- [ ] **Step 2: Run RED and confirm the generic error page appears**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
```

Expected: the new test fails because the runtime controller rethrows and the provider renders its error content instead of `<main>dashboard ready</main>`.

- [ ] **Step 3: Make only the runtime refresh boundary non-fatal**

In `DashboardRuntimeController.handleAiSessionViewVisibilityChanged`, retain the existing catch and diagnostic call, but remove `throw error`:

```ts
try {
    await this.runAsync(() => this.options.refreshAiSessionRuntimes('dashboard-visible', true));
} catch (error) {
    this.options.logAiSessionRuntimeFailure?.('dashboard-visible', error);
}
```

Do not change `AgentPivotViewProvider.prepareVisibility`; unrelated visibility lifecycle failures must still render the safe error page.

- [ ] **Step 4: Run GREEN and affected gates**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
node --test --test-concurrency=1 tests/contract/dashboardBoundaries.test.js
node scripts/run-dashboard-webview-checks.js
npm run test:behavior-contracts
```

Expected: all pass; the new integration test renders the dashboard despite the rejected refresh.

- [ ] **Step 5: Commit Task 2**

```bash
git add docs/testing/behavior-contracts.json \
  src/dashboard/runtimeController.ts \
  tests/integration/dashboard/errorRecovery.test.js
git commit -m "fix: keep dashboard visible after runtime refresh failure"
```

---

### Task 3: Restore capability-audit currency and verify the release branch

**Files:**
- Modify: `docs/testing/main-capability-coverage.json`
- Test: all files changed in Tasks 1 and 2

**Interfaces:**
- Consumes: the exact Task 2 commit hash and the Task 1 audit completed in Task 1 Step 9.
- Produces: a current capability audit assigning the view-resilience implementation commit to a CI-reachable capability.

- [ ] **Step 1: Assign the implementation commits**

Confirm Task 1 remains assigned to `MAIN-OTHER-WINDOWS` and
`MAIN-WORKSPACE-IDENTITY`. Add the Task 2 commit hash and behavior to
`MAIN-DASHBOARD-WEBVIEW-RECOVERY`. Set `audit.head` to the Task 2 implementation
commit. Keep the design and plan commits as genuine documentation-only commits.

- [ ] **Step 2: Verify audit currency**

Run:

```bash
npm run test:behavior-contracts
```

Expected: the capability coverage and currency checks pass with no unassigned implementation commit.

- [ ] **Step 3: Commit the audit update**

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit workspace identity and view resilience fixes"
```

- [ ] **Step 4: Run affected and platform gates**

Run:

```bash
npm run test:open-projects
npm run test:deterministic
npm run test:safety
npm run test:dashboard
AGENT_PIVOT_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
```

Expected: every command exits zero.

- [ ] **Step 5: Run the full Linux CI equivalent**

Run:

```bash
npm run test:ci:linux
git diff --check
git status -sb
```

Expected: CI exits zero, `git diff --check` is silent, and the branch is clean.

- [ ] **Step 6: Review before restoring release preparation**

Review the complete range from `e825ddd` to `HEAD`, fix every Critical or Important finding, rerun the relevant verification, and only then recreate the `3.0.0` release-preparation changes.
