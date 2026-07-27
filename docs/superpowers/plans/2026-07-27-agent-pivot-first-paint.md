# Agent Pivot Nonblocking First-Paint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the cached Agent Pivot dashboard immediately when its Webview becomes visible, then refresh runtime-derived AI-session state incrementally without replacing the healthy document.

**Architecture:** `AgentPivotViewProvider` owns the fatal first-render boundary and starts visibility preparation only after assigning the cached HTML. After preparation settles, the provider verifies that the same visible view generation still owns the result before invoking a separate completion callback. `DashboardRuntimeController` continues to refresh runtime state and isolate runtime failures; `dashboard.ts` maps the generation-safe completion callback to the existing incremental AI-session refresh and never introduces a second full-document render.

**Tech Stack:** TypeScript, VS Code WebviewView API, Node.js test runner, JSON behavior-contract catalog, GitHub Actions `quality-linux`.

**Design reference:** `docs/superpowers/specs/2026-07-27-agent-pivot-first-paint-design.md`

## CI reachability

The new P0 behavior is owned by `tests/integration/dashboard/errorRecovery.test.js`. The focused integration and contract tests are included by `test:deterministic:run`; `test:ci:linux` runs that deterministic suite plus the behavior-catalog checks; `.github/workflows/verify.yml` runs `npm run test:ci:linux` in the required `quality-linux` job.

---

## Task 1: Lock the first-paint behavior with a failing provider contract

**Files:**

- Modify: `tests/integration/dashboard/errorRecovery.test.js:225-455`
- Modify: `docs/testing/behavior-contracts.json:1870-1920`

- [ ] **Step 1: Replace the old blocking-order expectation with the P0 first-paint contract**

Add a test named:

```js
test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 renders cached HTML before visible preparation settles', async () => {
    const visibilityGate = deferred();
    const order = [];
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => {
            order.push('render');
            return '<main>cached dashboard</main>';
        },
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async visible => {
            order.push(`visible:${visible}:start`);
            await visibilityGate.promise;
            order.push(`visible:${visible}:end`);
        },
        onDisposed: () => undefined,
        logError: () => undefined,
    });

    let resolved = false;
    const resolution = provider.resolveWebviewView(view, {}, {}).then(() => {
        resolved = true;
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(view.webview.html, '<main>cached dashboard</main>');
    assert.deepEqual(order, ['render', 'visible:true:start']);
    assert.equal(resolved, true);

    visibilityGate.resolve();
    await resolution;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['render', 'visible:true:start', 'visible:true:end']);
});
```

Keep the assertion that `resolveWebviewView` itself is not held open by enrichment. Use the existing local `deferred()` helper and the adjacent fake-view conventions instead of adding timers.

- [ ] **Step 2: Add a focused background-failure preservation test**

Add or rewrite the adjacent provider ordering test so that:

1. `renderContent` returns `<main>healthy cached dashboard</main>`;
2. `onVisibleChanged(true)` rejects after a deferred gate;
3. the cached HTML is present before rejection;
4. after the gate rejects and one event-loop turn settles, the HTML is still the healthy dashboard;
5. `logError` receives `Failed to prepare Agent Pivot view.` with the sanitized `Unexpected Agent Pivot view failure.` error.

Do not expect the fatal error page for a post-render enrichment failure. Retain the existing separate render-failure test proving a thrown `renderContent` still produces the sanitized fatal page.

- [ ] **Step 3: Register the P0 behavior**

Add this entry near the existing Webview recovery contracts:

```json
{
  "id": "WEBVIEW-NONBLOCKING-FIRST-PAINT-001",
  "domain": "webview",
  "title": "Visible Agent Pivot views paint cached HTML before background runtime enrichment settles",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/integration/dashboard/errorRecovery.test.js"
  ],
  "evidence": [
    "src/dashboard/viewProvider.ts",
    "src/dashboard/runtimeController.ts"
  ]
}
```

- [ ] **Step 4: Compile and prove RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
```

Expected: compilation succeeds; the new `WEBVIEW-NONBLOCKING-FIRST-PAINT-001` test fails because `webview.html` remains empty while `onVisibleChanged(true)` is unresolved. The legacy blocking-order test must no longer be the asserted product behavior.

- [ ] **Step 5: Commit the failing contract**

```bash
git add tests/integration/dashboard/errorRecovery.test.js docs/testing/behavior-contracts.json
git commit -m "test: require nonblocking Agent Pivot first paint"
```

---

## Task 2: Render before starting visibility enrichment

**Files:**

- Modify: `src/dashboard/viewProvider.ts:29-123`
- Modify: `tests/integration/dashboard/errorRecovery.test.js:225-455`

- [ ] **Step 1: Make initial visibility preparation nonblocking**

In `resolveWebviewView`, start preparation without awaiting it after listeners are installed:

```ts
void this.prepareVisibility(webviewView, isCurrent);
```

`prepareVisibility` catches all preparation and completion errors, so this fire-and-forget call must not create an unhandled rejection. Keep `releaseBarrier` awaited before assigning the new view so ownership transfer remains serialized.

- [ ] **Step 2: Move the cached render before the asynchronous callback**

Structure `prepareVisibility` as two boundaries:

```ts
private async prepareVisibility(
    webviewView: vscode.WebviewView,
    isCurrent: () => boolean
): Promise<void> {
    if (!isCurrent()) {
        return;
    }
    if (webviewView.visible) {
        this.refresh();
    }
    try {
        await this.options.onVisibleChanged(webviewView.visible);
    } catch (_error) {
        if (!isCurrent()) {
            return;
        }
        this.options.logError(
            'Failed to prepare Agent Pivot view.',
            sanitizedViewFailure()
        );
    }
}
```

Important invariants:

- `refresh()` remains the fatal render boundary and still installs sanitized error HTML if `renderContent` throws.
- A later `onVisibleChanged` failure logs only; it never replaces already assigned HTML.
- Hidden views call `onVisibleChanged(false)` but do not render.
- Do not call `refresh()` after the await.
- Retain the `isCurrent()` check in the catch so a superseded view cannot log or mutate current state.

- [ ] **Step 3: Preserve stale-generation coverage**

Adjust `SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-OWNERSHIP-001` for the new nonblocking resolver by awaiting one `setImmediate` immediately after each `resolveWebviewView` call before asserting render history. Preserve these assertions:

- replacing view A with view B renders B immediately;
- completing A's delayed preparation does not render or mutate B;
- stale A visibility and disposal callbacks are ignored;
- current B posting and disposal still work.

- [ ] **Step 4: Prove GREEN for the provider**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
```

Expected: all tests pass, including immediate first paint, preserved healthy HTML after preparation failure, fatal initial-render sanitization, and stale-generation ownership.

- [ ] **Step 5: Commit the provider change**

```bash
git add src/dashboard/viewProvider.ts tests/integration/dashboard/errorRecovery.test.js
git commit -m "fix: render Agent Pivot before runtime enrichment"
```

---

## Task 3: Deliver refreshed runtime state through the generation-safe incremental protocol

**Files:**

- Modify: `tests/contract/dashboardBoundaries.test.js:105-235`
- Modify: `tests/integration/dashboard/errorRecovery.test.js:294-350`
- Modify: `src/dashboard.ts:1515-1580`

- [ ] **Step 1: Preserve the runtime-controller visibility contract**

Keep the visibility section of
`RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 publishes exact batch, terminal, mutation, color, and visibility effects`
unchanged: hidden visibility performs no runtime discovery, while visible
visibility requests `['dashboard-visible', true]`. This keeps runtime discovery
and its failure diagnostics inside `DashboardRuntimeController`.

Extend `RUNTIME-DASHBOARD-VISIBILITY-RESILIENCE-001` by passing this provider callback:

```js
onVisiblePrepared: async () => {
    incrementalRefreshes.push('dashboard-visible');
},
```

Assert that a rejected runtime refresh still records:

```js
[['dashboard-visible', 'transient runtime refresh']]
```

and then requests exactly:

```js
['dashboard-visible']
```

while the provider's cached dashboard remains rendered and provider-level fatal logs remain empty.

- [ ] **Step 2: Add a successful ordering assertion**

Add a focused integration case using a deferred runtime refresh:

1. the provider paints `<main>cached dashboard</main>`;
2. the runtime callback starts and waits;
3. `onVisiblePrepared` has not run;
4. resolving runtime discovery invokes `onVisiblePrepared` once;
5. replacing or disposing the view before resolving the gate invokes it zero times.

Implement this as a separate
`WEBVIEW-NONBLOCKING-FIRST-PAINT-001 ignores prepared completion from a superseded view`
test. Use the existing `makeView` pattern from the ownership test, a
`visibilityGate`, and a `prepared` array. Resolve view A, wait one
`setImmediate`, resolve view B, wait one `setImmediate`, clear the entries
produced by B, resolve A's gate, wait one `setImmediate`, then assert
`prepared` remains empty.

In `tests/contract/dashboardBoundaries.test.js`, add a composition guard:

```js
test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 composes prepared visibility with incremental session refresh', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard.ts'),
        'utf8'
    );
    assert.match(
        dashboardSource,
        /onVisiblePrepared:\s*\(\)\s*=>\s*[\r\n\s]*aiSessionDashboardController\.refreshNow\('dashboard-visible'\)/
    );
});
```

- [ ] **Step 3: Prove RED for incremental delivery**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/dashboardBoundaries.test.js tests/integration/dashboard/errorRecovery.test.js
```

Expected: the new incremental-update assertions fail because the provider does not yet invoke the supplied `onVisiblePrepared` callback.

- [ ] **Step 4: Add the generation-safe completion boundary**

Add this optional callback to `AgentPivotViewProviderOptions`:

```ts
onVisiblePrepared?: () => void | Thenable<void> | Promise<void>;
```

After `onVisibleChanged` settles, invoke it only after ownership and visibility
are rechecked:

```ts
await this.options.onVisibleChanged(webviewView.visible);
if (!isCurrent() || !webviewView.visible) {
    return;
}
await this.options.onVisiblePrepared?.();
```

Keep this inside the background preparation `try` block. A completion failure
must produce the sanitized `Failed to prepare Agent Pivot view.` diagnostic
without replacing the healthy cached HTML.

- [ ] **Step 5: Wire the existing AI-session controller, not a full provider refresh**

In the `AgentPivotViewProvider` construction in `src/dashboard.ts`, add:

```ts
onVisiblePrepared: () =>
    aiSessionDashboardController.refreshNow('dashboard-visible'),
```

Do not call `provider.refresh()` and do not call `refreshStewardViews()` here. `AiSessionDashboardController.refreshNow` already owns the existing incremental message and visibility guard.

- [ ] **Step 6: Prove GREEN for generation-safe sequencing**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/dashboardBoundaries.test.js tests/integration/dashboard/errorRecovery.test.js
```

Expected: both files pass. Runtime refresh precedes incremental delivery, runtime failure still allows incremental delivery, superseded generations do not deliver stale completion work, and the provider retains healthy cached HTML.

- [ ] **Step 7: Commit the runtime integration**

```bash
git add src/dashboard/viewProvider.ts src/dashboard.ts tests/contract/dashboardBoundaries.test.js tests/integration/dashboard/errorRecovery.test.js
git commit -m "fix: refresh visible sessions incrementally"
```

---

## Task 4: Verify the behavior contract and regression surface

**Files:**

- Modify: `docs/testing/main-capability-coverage.json`
- Review: `docs/testing/behavior-contracts.json`
- Review: `docs/superpowers/specs/2026-07-27-agent-pivot-first-paint-design.md`

- [ ] **Step 1: Map the new P0 contract to the existing recovery capability**

Add `WEBVIEW-NONBLOCKING-FIRST-PAINT-001` to the `behaviors` array of
`MAIN-DASHBOARD-WEBVIEW-RECOVERY`.

Add the actual implementation and test commit hashes from Tasks 1-3 to that capability's `commits` array. Advance `audit.head` to the last non-audit implementation commit. Account for the design and implementation-plan documentation commits using the repository's existing documentation-audit convention; use actual hashes from:

```bash
git log --format='%H %s' origin/main..HEAD
```

Do not invent or abbreviate hashes in the JSON audit fields.

- [ ] **Step 2: Run catalog and focused affected suites**

```bash
npm run test:behavior-contracts
npm run test-compile
node --test --test-concurrency=1 tests/contract/dashboardBoundaries.test.js tests/integration/dashboard/errorRecovery.test.js
```

Expected: catalog integrity and main-capability coverage pass; both focused suites pass.

- [ ] **Step 3: Run the deterministic regression suite**

```bash
npm run test:deterministic
```

Expected: all unit, contract, and integration tests pass.

- [ ] **Step 4: Run the full Linux PR gate**

```bash
npm run test:ci:linux
```

Expected: branding, lint, behavior contracts, deterministic tests, remote conversation sources, performance, browser, safety, dashboard, architecture, release packaging, production build, and coverage gates all pass.

- [ ] **Step 5: Inspect the final diff for forbidden behavior**

Run:

```bash
git diff origin/main...HEAD -- src/dashboard/viewProvider.ts src/dashboard/runtimeController.ts src/dashboard.ts tests/integration/dashboard/errorRecovery.test.js tests/contract/dashboardBoundaries.test.js docs/testing/behavior-contracts.json docs/testing/main-capability-coverage.json
rg -n "refreshProvider|provider\\.refresh|refreshStewardViews" src/dashboard/runtimeController.ts src/dashboard.ts
git status --short
```

Confirm:

- cached HTML assignment occurs before visibility enrichment;
- visibility enrichment never assigns fatal HTML;
- background completion uses `AiSessionDashboardController.refreshNow`;
- no background completion path performs a full Webview document replacement;
- the worktree contains no unrelated or untracked changes.

- [ ] **Step 6: Commit the coverage audit**

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit nonblocking dashboard first paint"
```

- [ ] **Step 7: Re-run the audit after the audit commit**

```bash
npm run test:behavior-contracts
git status --short
```

Expected: both catalog checks pass and the worktree is clean. If the audit commit changes the set of unaudited documentation commits, follow the repository's existing audit convention and amend only the audit metadata, then rerun the same check.

---

## Task 5: Manual remote-host acceptance check

**Files:**

- No source changes expected.

- [ ] **Step 1: Build and install using the repository's local-extension workflow**

Use the `installing-vscode-extensions-locally` skill. Build a fresh Agent Pivot VSIX from this exact commit and install it in the same remote/UI extension-host topology where `reddb` reproduced the delay. Reinstall the UI Bridge only if the packaging output or skill verification shows its artifact changed.

- [ ] **Step 2: Verify first paint and state stability**

With the Agent Pivot view initially closed:

1. reload the `reddb` window;
2. open Agent Pivot;
3. confirm project/session cards and controls appear immediately from cached state;
4. allow runtime/tmux state to settle;
5. confirm session badges update without a blank view, fatal error page, scroll reset, collapsed/expanded reset, or focus loss;
6. hide and reopen the view and repeat;
7. inspect Agent Pivot diagnostics for runtime enrichment failures without provider fatal-render failures.

- [ ] **Step 3: Record evidence**

Record the tested VSIX path, extension version, host topology, first-paint observation, incremental-update observation, and relevant diagnostic timestamps in the handoff. Do not claim the separate Extension Host out-of-memory issue is fixed by this change.
