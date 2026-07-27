# Agent Pivot Two-Stage Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the blank Agent Pivot startup interval by registering a boot-capable Webview provider immediately, returning from extension activation while dashboard composition continues, and upgrading the same view to authoritative content when bootstrap completes.

**Architecture:** `AgentPivotViewProvider` owns a generation-scoped `booting | ready | failed` lifecycle and remains the only provider registered for `agentPivot.dashboard`. A small `DashboardBootstrapController` starts one background generation at a time, while `DashboardBootstrapResources` owns all partially constructed disposables until successful adoption. `dashboard.ts` performs only diagnostic/provider/controller setup before returning; the existing runtime restoration and dashboard composition move into one ordered bootstrap function.

**Tech Stack:** TypeScript, VS Code WebviewView API, Node.js test runner, Playwright Chromium, JSON behavior-contract catalog, GitHub Actions `quality-linux`.

**Design reference:** `docs/superpowers/specs/2026-07-27-agent-pivot-two-stage-startup-design.md`

## Global Constraints

- Preserve the existing runtime restoration order: inactive tmux discovery, direct-terminal restore, tmux attach restore, then workspace-session hydration.
- Register exactly one `AgentPivotViewProvider`; do not open an editor, panel, window, or second Webview.
- The boot shell contains no project names, paths, session IDs, prompts, TODOs, provider payloads, or stale authoritative HTML.
- Only the latest non-disposed bootstrap generation may alter provider state or transfer resources.
- Retry is accepted only in `failed`, is single-flight, and uses exactly `{ type: 'retry-agent-pivot-bootstrap', version: 1 }`.
- Failure HTML and dashboard diagnostics use stable categories only. Raw bootstrap errors may go to the private output-channel error logger, but never into HTML or structured diagnostics.
- Keep the existing ready-state rendering, visibility preparation, incremental refresh, view-replacement, and disposal contracts intact.
- Follow TDD for every production change: add the failing test, run it and inspect the expected failure, implement the smallest change, then rerun focused tests.
- Do not change branding, extension identity, persistence schemas, session discovery, or runtime protocols in this work.

## CI Reachability

The new P0 behavior is owned by:

- `tests/integration/dashboard/twoStageStartup.test.js` for controller/provider state and generation safety;
- `tests/contract/aiSessions/runtimeComposition.test.js` through `tests/fixtures/aiSessions/runtimeHostActivationHarness.js` for production activation ordering;
- `tests/browser/dashboardBootShell.test.js` for real DOM, accessibility, motion, Retry, and message behavior.

`npm run test:deterministic:run` reaches unit, contract, and integration owners. `npm run test:browser:run` reaches the Playwright owner. `npm run test:ci:linux` reaches both plus behavior-contract validation, and `.github/workflows/verify.yml` runs that command in the required `quality-linux` job.

---

## Task 1: Lock the P0 behavior and create the privacy-safe boot document

**Files:**

- Create: `src/dashboard/bootContent.ts`
- Create: `tests/integration/dashboard/bootContent.test.js`
- Create: `tests/browser/dashboardBootShell.test.js`
- Modify: `docs/testing/behavior-contracts.json`

- [ ] **Step 1: Add the P0 behavior-catalog entry**

Insert the following adjacent to `WEBVIEW-NONBLOCKING-FIRST-PAINT-001`:

```json
{
  "id": "WEBVIEW-TWO-STAGE-STARTUP-001",
  "domain": "webview",
  "title": "Agent Pivot paints a privacy-safe boot shell before ordered dashboard bootstrap completes",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/integration/dashboard/twoStageStartup.test.js",
    "tests/contract/aiSessions/runtimeComposition.test.js",
    "tests/browser/dashboardBootShell.test.js"
  ],
  "evidence": [
    "src/dashboard/bootContent.ts",
    "src/dashboard/bootstrapController.ts",
    "src/dashboard/viewProvider.ts",
    "src/dashboard.ts"
  ]
}
```

- [ ] **Step 2: Write failing boot-document integration tests**

In `tests/integration/dashboard/bootContent.test.js`, load the compiled module and cover both document states:

```js
test('WEBVIEW-TWO-STAGE-STARTUP-001 boot HTML is nonblank, busy, stable, and private', () => {
    const html = getDashboardBootContent(fakeWebview(), {
        kind: 'booting',
        generation: 7,
    });

    assert.match(html, /<main[^>]+aria-busy="true"/);
    assert.match(html, /agent-pivot-boot-shell/);
    assert.equal(html.includes('private-project'), false);
    assert.equal(html.includes('/home/private'), false);
    assert.equal(html.includes('<button'), false);
    assert.equal(html.includes('retry-agent-pivot-bootstrap'), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 failed HTML exposes one safe Retry action', () => {
    const html = getDashboardBootContent(fakeWebview(), {
        kind: 'failed',
        generation: 8,
    });

    assert.match(html, /Agent Pivot could not finish starting/);
    assert.match(html, /<button[^>]+data-action="retry"/);
    assert.equal((html.match(/data-action="retry"/g) || []).length, 1);
    assert.equal(html.includes('/home/private'), false);
    assert.equal(html.includes('private bootstrap error'), false);
});
```

The fake Webview supplies only `cspSource`. Do not pass real dashboard services or data into the renderer.

- [ ] **Step 3: Prove RED**

```bash
npm run test-compile
node --test tests/integration/dashboard/bootContent.test.js
```

Expected: compilation or module loading fails because `src/dashboard/bootContent.ts` does not exist.

- [ ] **Step 4: Implement the boot document contract**

Create this public surface in `src/dashboard/bootContent.ts`:

```ts
export type DashboardBootDocumentState =
    | { kind: 'booting'; generation: number }
    | { kind: 'failed'; generation: number };

export interface DashboardBootWebview {
    readonly cspSource: string;
}

export function getDashboardBootContent(
    webview: DashboardBootWebview,
    state: DashboardBootDocumentState,
): string;
```

Implementation requirements:

- emit a complete HTML document with a restrictive CSP;
- render a fixed tab-row silhouette and card-shaped placeholders using inline boot-only CSS;
- use fixed geometry so the shell does not grow with session count;
- set `aria-busy="true"` only while `booting`;
- include no `button`, link, input, or positive `tabindex` while `booting`;
- suppress shimmer in `@media (prefers-reduced-motion: reduce)`;
- on the first animation frame post:

```ts
{
    type: 'agent-pivot-browser-first-paint',
    version: 1,
    generation: state.generation,
}
```

- in `failed`, render one real Retry button and post exactly:

```ts
{
    type: 'retry-agent-pivot-bootstrap',
    version: 1,
}
```

Do not interpolate an error object, path, project, provider, session, or prompt into either document.

- [ ] **Step 5: Make the integration tests GREEN**

```bash
npm run test-compile
node --test tests/integration/dashboard/bootContent.test.js
```

Expected: both boot-document tests pass.

- [ ] **Step 6: Add the Playwright RED contract against production HTML**

In `tests/browser/dashboardBootShell.test.js`, launch Chromium with the adjacent browser-test helpers, install an `acquireVsCodeApi` spy before `page.setContent`, and assert:

1. booting HTML has a nonzero root and placeholder bounding box;
2. the shell has a stable top tab row and bounded card area;
3. no actionable element is focusable in booting state;
4. the first animation frame posts one current-generation first-paint message;
5. reduced-motion mode reports `animation-name: none`;
6. failed state has one focusable Retry button;
7. two rapid Retry clicks post two browser messages, leaving single-flight filtering to the host lifecycle test.

Initially add the test with the expected selectors before finalizing CSS so it fails on missing geometry or motion rules.

- [ ] **Step 7: Make the browser contract GREEN**

Adjust only `src/dashboard/bootContent.ts` until:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/dashboardBootShell.test.js
```

passes without skips.

- [ ] **Step 8: Commit the boot document**

```bash
git add \
  src/dashboard/bootContent.ts \
  tests/integration/dashboard/bootContent.test.js \
  tests/browser/dashboardBootShell.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: add Agent Pivot startup shell"
```

---

## Task 2: Add generation-safe boot lifecycle to the existing provider

**Files:**

- Modify: `src/dashboard/viewProvider.ts`
- Create: `tests/integration/dashboard/twoStageStartup.test.js`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`

- [ ] **Step 1: Add focused failing lifecycle tests**

Create `tests/integration/dashboard/twoStageStartup.test.js` with a reusable fake visible view that records assigned HTML, posted messages, received-message callbacks, visibility callbacks, and disposal callbacks.

Add tests named:

- `WEBVIEW-TWO-STAGE-STARTUP-001 resolves the current view with boot HTML before ready callbacks exist`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 adopts ready callbacks once and prepares the same visible view`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 ignores stale completion and stale first-paint acknowledgements`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 routes only exact failed-state Retry messages`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 never replaces a healthy ready dashboard with failure HTML`.

The tests must prove:

- `resolveWebviewView` assigns boot HTML immediately;
- `completeBootstrap(1, readyOptions)` replaces that same view exactly once;
- ready adoption calls `onVisibleChanged(true)` and then `onVisiblePrepared`;
- a repeated generation `1` completion is rejected;
- generation `1` cannot complete after `beginBootstrap(2)`;
- current first-paint is reported once, while stale generations are ignored;
- malformed Retry, Retry in `booting`, and Retry in `ready` do nothing;
- failed generation accepts the exact protocol once per host flight;
- `failBootstrap` after `ready` returns `false` and retains healthy HTML.

- [ ] **Step 2: Prove RED**

```bash
npm run test-compile
node --test tests/integration/dashboard/twoStageStartup.test.js
```

Expected: tests fail because the provider constructor and boot lifecycle methods do not exist.

- [ ] **Step 3: Introduce an explicit provider configuration**

In `src/dashboard/viewProvider.ts`, retain the existing `AgentPivotViewProviderOptions` unchanged for ready callbacks and add:

```ts
export interface AgentPivotViewProviderBootOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderBootContent: (webview: vscode.Webview, generation: number) => string;
    renderBootError: (webview: vscode.Webview, generation: number) => string;
    onBootShellAssigned: (generation: number) => void;
    onRetry: () => void;
    onFirstPaint: (generation: number) => void;
    logError: (message: string, error: unknown) => void;
}

export type AgentPivotViewProviderConfiguration =
    | { mode: 'ready'; options: AgentPivotViewProviderOptions }
    | {
        mode: 'boot';
        options: AgentPivotViewProviderBootOptions;
    };
```

Change construction to:

```ts
constructor(configuration: AgentPivotViewProviderConfiguration)
```

and expose:

```ts
beginBootstrap(generation: number): boolean;
completeBootstrap(
    generation: number,
    options: AgentPivotViewProviderOptions,
): boolean;
failBootstrap(generation: number): boolean;
```

State invariants:

- boot-mode construction starts at generation `0`; `beginBootstrap(1)` is the first renderable bootstrap state;
- generation numbers must strictly increase at `beginBootstrap`;
- `completeBootstrap` and `failBootstrap` accept only the current booting generation;
- `ready` is terminal for that provider instance;
- `refresh()` renders boot, safe failure, or ready content according to state;
- ready-state message, visibility, disposal, refresh, `postMessage`, and generation behavior remain identical to the current implementation;
- boot messages use exact key/type/version validation;
- browser first-paint accepts only the current boot generation;
- `onBootShellAssigned(generation)` fires once after the current generation's boot HTML is assigned;
- changing provider state never awaits dashboard preparation before assigning HTML.

- [ ] **Step 4: Update existing ready-provider tests mechanically**

In `tests/integration/dashboard/errorRecovery.test.js`, wrap each existing options object as:

```js
new AgentPivotViewProvider({
    mode: 'ready',
    options: {
        // unchanged existing callbacks
    },
});
```

Do not weaken or remove any existing first-paint, superseded-view, visibility-epoch, message-error, or disposal assertions.

- [ ] **Step 5: Prove GREEN for lifecycle and regression contracts**

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/integration/dashboard/errorRecovery.test.js
```

Expected: all new lifecycle tests and all prior provider recovery tests pass.

- [ ] **Step 6: Commit the provider lifecycle**

```bash
git add \
  src/dashboard/viewProvider.ts \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/integration/dashboard/errorRecovery.test.js
git commit -m "feat: add dashboard bootstrap lifecycle"
```

---

## Task 3: Implement single-flight bootstrap and partial-resource ownership

**Files:**

- Create: `src/dashboard/bootstrapController.ts`
- Create: `src/dashboard/bootstrapResources.ts`
- Create: `tests/unit/dashboard/bootstrapController.test.js`
- Create: `tests/unit/dashboard/bootstrapResources.test.js`

- [ ] **Step 1: Write failing resource-ownership tests**

Cover:

- disposables are released in reverse construction order;
- each disposable is released at most once;
- a failed generation can dispose its partial scope;
- `transferTo(targetSubscriptions)` moves ownership exactly once;
- after transfer, disposing the scope does not dispose transferred resources;
- ownership or transfer after disposal throws a stable programmer error.

The intended interface is:

```ts
export interface DashboardBootstrapDisposable {
    dispose(): unknown;
}

export class DashboardBootstrapResources {
    own<T extends DashboardBootstrapDisposable>(disposable: T): T;
    transferTo(target: DashboardBootstrapDisposable[]): void;
    dispose(): void;
}
```

- [ ] **Step 2: Write failing controller tests**

Use deferred bootstrap promises and fake provider callbacks. Add tests named:

- `WEBVIEW-TWO-STAGE-STARTUP-001 activation owner starts without awaiting bootstrap`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 transfers only the latest successful generation`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 failure is safe and Retry is single-flight`;
- `WEBVIEW-TWO-STAGE-STARTUP-001 disposal rejects late completion and releases its result`.

Use this production surface:

```ts
export interface DashboardBootstrapResult {
    readonly options: AgentPivotViewProviderOptions;
    readonly resources: DashboardBootstrapResources;
}

export interface DashboardBootstrapControllerOptions {
    run: (generation: number) => Promise<DashboardBootstrapResult>;
    begin: (generation: number) => boolean;
    complete: (
        generation: number,
        options: AgentPivotViewProviderOptions,
    ) => boolean;
    fail: (generation: number) => boolean;
    transfer: (resources: DashboardBootstrapResources) => void;
    logDiagnostic: (event: Record<string, unknown>) => void;
    nowMs?: () => number;
}

export class DashboardBootstrapController {
    constructor(options: DashboardBootstrapControllerOptions);
    start(): void;
    retry(): void;
    dispose(): void;
}
```

The controller itself must never surface or serialize the rejected error. It emits:

```ts
{ event: 'agent-pivot-bootstrap-ready', generation, durationMs }
{ event: 'agent-pivot-bootstrap-failed', generation, category: 'dashboard-bootstrap' }
```

- [ ] **Step 3: Prove RED**

```bash
npm run test-compile
node --test \
  tests/unit/dashboard/bootstrapResources.test.js \
  tests/unit/dashboard/bootstrapController.test.js
```

Expected: compilation or module loading fails because both production modules are absent.

- [ ] **Step 4: Implement resources, then controller**

Implement `DashboardBootstrapResources` first and make its test green. Then implement `DashboardBootstrapController` with:

- state `idle | booting | ready | failed | disposed`;
- monotonically increasing generation beginning at `1`;
- `start()` only from `idle`;
- `retry()` only from `failed`;
- no second `run` while `booting`;
- late/superseded results disposed instead of transferred;
- successful adoption before transfer;
- failed adoption disposes the result;
- failure invokes `fail(generation)` and emits only the stable category;
- `dispose()` invalidates the generation and disposes any result not yet transferred.

Attach an explicit rejection handler inside `start()` so the background promise never becomes an unhandled rejection.

- [ ] **Step 5: Prove GREEN**

```bash
npm run test-compile
node --test \
  tests/unit/dashboard/bootstrapResources.test.js \
  tests/unit/dashboard/bootstrapController.test.js
```

Expected: all ownership, single-flight, failure, supersession, and disposal tests pass.

- [ ] **Step 6: Commit the bootstrap owner**

```bash
git add \
  src/dashboard/bootstrapController.ts \
  src/dashboard/bootstrapResources.ts \
  tests/unit/dashboard/bootstrapController.test.js \
  tests/unit/dashboard/bootstrapResources.test.js
git commit -m "feat: own background dashboard bootstrap"
```

---

## Task 4: Split production activation without changing runtime restoration order

**Files:**

- Modify: `src/dashboard.ts`
- Modify: `tests/fixtures/aiSessions/runtimeHostActivationHarness.js`
- Modify: `tests/contract/aiSessions/runtimeComposition.test.js`
- Modify: `tests/contract/dashboardBoundaries.test.js`

- [ ] **Step 1: Extend the runtime harness before changing production**

Change `createVscode()` in `tests/fixtures/aiSessions/runtimeHostActivationHarness.js` to capture:

- the provider passed to `registerWebviewViewProvider`;
- the fake resolved Webview's assigned HTML history;
- the boot Webview message callback;
- an activation-order event immediately after `await dashboard.activate(context)`;
- a deferred gate inside `restorePersistedTerminals` for a new `pending` mode.

Add bounded helpers that wait by observable state, not arbitrary sleep:

```js
async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${label}`);
}
```

Return fields sufficient to assert:

```js
{
    activationReturnedBeforeDirectRestoreSettled,
    providerRegistrations,
    bootHtmlAssigned,
    readyHtmlAssignments,
    bootstrapState,
    events,
    failure,
}
```

For `direct-failure`, the public activation failure remains `null`; the observable result becomes `bootstrapState: 'failed'`.

- [ ] **Step 2: Write the failing production activation contracts**

Update `tests/contract/aiSessions/runtimeComposition.test.js`:

```js
test('WEBVIEW-TWO-STAGE-STARTUP-001 production activation returns while ordered bootstrap is pending', () => {
    const result = runProductionActivation('pending');
    assert.equal(result.failure, null);
    assert.equal(result.providerRegistrations, 1);
    assert.equal(result.activationReturnedBeforeDirectRestoreSettled, true);
    assert.equal(result.bootHtmlAssigned, true);
});
```

Retain the success ordering assertion:

```js
[
    'inactive-restored',
    'direct-restored',
    'tmux-restored',
    'hydration-constructed',
]
```

Rewrite only the public-boundary portion of the direct failure test:

```js
assert.equal(result.failure, null);
assert.equal(result.bootstrapState, 'failed');
assert.deepEqual(result.events.filter(isRestoreEvent), [
    'inactive-restored',
    'direct-failed',
]);
assert.equal(result.events.includes('tmux-restored'), false);
assert.equal(result.events.includes('hydration-constructed'), false);
```

In `tests/contract/dashboardBoundaries.test.js`, add a source/production boundary assertion that:

- `registerWebviewViewProvider` appears before starting background bootstrap;
- public activation does not await `dashboardStartupController.startUp()`;
- there remains exactly one production provider registration.

- [ ] **Step 3: Prove RED**

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/contract/dashboardBoundaries.test.js
```

Expected: pending activation blocks, failure still rejects the public activation promise, or the view has no boot HTML.

- [ ] **Step 4: Extract ordered dashboard composition**

In `src/dashboard.ts`, keep the exported boundary small:

```ts
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // diagnostics, boot provider, provider registration, bootstrap controller
    // controller.start(); no await of the bootstrap flight
}
```

Move the current body after diagnostic creation into:

```ts
async function initializeDashboard(
    context: vscode.ExtensionContext,
    provider: AgentPivotViewProvider,
    resources: DashboardBootstrapResources,
    diagnostics: DashboardDiagnostics,
): Promise<AgentPivotViewProviderOptions>;
```

Rules for this extraction:

- leave `await initializePromptMementoStore`, inactive tmux restore, direct restore, tmux attach restore, hydration construction, and `dashboardStartupController.startUp()` in their current semantic order;
- replace every bootstrap-owned `context.subscriptions.push(disposable)` with `resources.own(disposable)`;
- remove the old late provider construction and provider registration;
- build and return the ready `AgentPivotViewProviderOptions` where the old provider was configured;
- do not start timers, monitors, listeners, bridges, or command registrations outside the bootstrap resource scope;
- if `initializeDashboard` throws, dispose its partial `resources` before rethrowing;
- set `activeAiSessionAttentionBridgeClient` only for the live generation, and clear it during scope disposal only when it still references that generation's client.

- [ ] **Step 5: Compose the fast activation boundary**

The public function must:

1. create and own the output channel;
2. create `DashboardDiagnostics`;
3. emit `{ event: 'agent-pivot-activation-entered' }`;
4. construct `AgentPivotViewProvider` in `boot` mode, initially at generation `0`;
5. render both boot states with `getDashboardBootContent`;
6. emit `agent-pivot-boot-shell-assigned` only when current boot HTML is assigned;
7. accept current first-paint through `agent-pivot-browser-first-paint`;
8. register the one provider before starting background work;
9. construct and own `DashboardBootstrapController`;
10. wire provider Retry to `controller.retry()`;
11. call `controller.start()`, which begins generation `1`, and return without awaiting it.

Use a closure for the controller because provider boot callbacks are created first:

```ts
let bootstrapController: DashboardBootstrapController | undefined;
// provider onRetry: () => bootstrapController?.retry()
// then construct controller, push it, call start()
```

Transfer successful resources with:

```ts
transfer: resources => resources.transferTo(context.subscriptions)
```

Structured diagnostics must contain only event, generation, stable category, and duration fields.

- [ ] **Step 6: Preserve private error logging without leaking it**

Wrap each bootstrap generation so that:

```ts
try {
    const options = await initializeDashboard(...);
    return { options, resources };
} catch (error) {
    resources.dispose();
    dashboardDiagnostics.logError(
        'Failed to initialize Agent Pivot dashboard.',
        error,
    );
    throw error;
}
```

The controller ignores the raw rejection value and transitions the provider with `failBootstrap(generation)`. Verify that failed HTML contains none of the raw error message.

- [ ] **Step 7: Make production contracts GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/contract/dashboardBoundaries.test.js \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/integration/dashboard/errorRecovery.test.js
```

Expected:

- activation returns while the pending restore gate remains unresolved;
- boot HTML is already assigned;
- one provider is registered;
- success preserves the existing restore/hydration order;
- direct failure stops later restoration and hydration;
- failure becomes safe provider state instead of an activation rejection;
- existing provider recovery tests remain green.

- [ ] **Step 8: Audit resource ownership before committing**

```bash
rg -n "context\\.subscriptions\\.push|resources\\.own|setInterval|\\.start\\(\\)" src/dashboard.ts
rg -n "new AgentPivotViewProvider|registerWebviewViewProvider" src/dashboard.ts
```

Confirm:

- only the output channel, provider registration, bootstrap controller, and other true activation-boundary owners are pushed directly before bootstrap success;
- bootstrap timers, monitors, listeners, bridges, commands, and controllers are scope-owned;
- exactly one provider is constructed and registered.

- [ ] **Step 9: Commit the activation split**

```bash
git add \
  src/dashboard.ts \
  tests/fixtures/aiSessions/runtimeHostActivationHarness.js \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/contract/dashboardBoundaries.test.js
git commit -m "perf: return before dashboard bootstrap"
```

---

## Task 5: Complete diagnostic, Retry, and browser-transition coverage

**Files:**

- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/viewProvider.ts`
- Modify: `tests/fixtures/aiSessions/runtimeHostActivationHarness.js`
- Modify: `tests/contract/aiSessions/runtimeComposition.test.js`
- Modify: `tests/integration/dashboard/twoStageStartup.test.js`
- Modify: `tests/browser/dashboardBootShell.test.js`

- [ ] **Step 1: Add a failing exact-diagnostics test**

Capture output-channel dashboard diagnostics in
`tests/fixtures/aiSessions/runtimeHostActivationHarness.js` and assert the
production sequence in `tests/contract/aiSessions/runtimeComposition.test.js`.
For generation `1`, prove this order:

```js
[
    'agent-pivot-activation-entered',
    'agent-pivot-boot-shell-assigned',
    'agent-pivot-browser-first-paint',
    'agent-pivot-bootstrap-ready',
]
```

In `tests/integration/dashboard/twoStageStartup.test.js`, separately prove
that `onBootShellAssigned(1)` precedes `onFirstPaint(1)` and that each callback
fires once. For failure, prove the production structured diagnostic is:

```js
{
    event: 'agent-pivot-bootstrap-failed',
    generation: 1,
    category: 'dashboard-bootstrap',
}
```

Assert JSON serialization contains none of seeded path, project, prompt, session, provider-payload, or raw-error canaries.

- [ ] **Step 2: Add stale acknowledgement and Retry flight tests**

Cover:

- generation `1` first-paint after generation `2` begins produces no diagnostic;
- duplicate first-paint from the current generation is logged once;
- two exact Retry messages while generation `2` is pending start only one `run(2)`;
- a Retry message in `ready` does not rerender or run bootstrap;
- disposal during Retry prevents its late ready HTML assignment and disposes the result.

- [ ] **Step 3: Add browser transition ownership**

Extend `tests/browser/dashboardBootShell.test.js` with one same-page host simulation:

1. mount production boot HTML;
2. observe nonblank shell and first-paint message;
3. replace `document.documentElement.innerHTML` through the same Webview document assignment abstraction used by the fake provider;
4. verify one authoritative marker becomes visible;
5. assert no `window.open` call, second page, dialog, or popup occurs.

This is a product-markup/layout test; lifecycle exact-once ownership remains in the provider integration test.

- [ ] **Step 4: Implement bounded diagnostic acknowledgement**

Keep a per-generation first-paint acknowledgement flag in the provider boot state. Call `onFirstPaint(generation)` only once for the exact current message. In `dashboard.ts`, emit:

```ts
{
    event: 'agent-pivot-browser-first-paint',
    generation,
    durationMs,
}
```

using the activation/controller monotonic start time. Do not log wall-clock paths or view payloads.

- [ ] **Step 5: Prove GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/browser/dashboardBootShell.test.js
```

Expected: diagnostic order, privacy canaries, stale acknowledgement, single-flight Retry, disposal, reduced motion, and same-view transition all pass.

- [ ] **Step 6: Commit diagnostics and transition coverage**

```bash
git add \
  src/dashboard.ts \
  src/dashboard/viewProvider.ts \
  tests/fixtures/aiSessions/runtimeHostActivationHarness.js \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/browser/dashboardBootShell.test.js
git commit -m "test: cover dashboard startup transition"
```

---

## Task 6: Verify, audit capability coverage, package, and install for real timing

**Files:**

- Modify: `docs/testing/main-capability-coverage.json`
- Create: `docs/superpowers/reports/2026-07-27-agent-pivot-two-stage-startup-verification.md`
- Review: `docs/testing/behavior-contracts.json`
- Review: `docs/superpowers/specs/2026-07-27-agent-pivot-two-stage-startup-design.md`

- [ ] **Step 1: Run focused affected suites**

```bash
npm run test:behavior-contracts
npm run test-compile
node --test \
  tests/unit/dashboard/bootstrapResources.test.js \
  tests/unit/dashboard/bootstrapController.test.js
node --test --test-concurrency=1 \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/contract/dashboardBoundaries.test.js \
  tests/integration/dashboard/bootContent.test.js \
  tests/integration/dashboard/twoStageStartup.test.js \
  tests/integration/dashboard/errorRecovery.test.js
node --test --test-concurrency=1 tests/browser/dashboardBootShell.test.js
```

Expected: all focused tests and catalog validation pass.

- [ ] **Step 2: Run deterministic and browser regression suites**

```bash
npm run test:deterministic
npm run test:browser
```

Expected: all unit, contract, integration, and browser tests pass without skips introduced by this change.

- [ ] **Step 3: Run the full Linux PR gate**

```bash
npm run test:ci:linux
```

Expected: branding, lint, behavior contracts, deterministic tests, remote conversation sources, performance, browser, safety, dashboard, architecture, packaging, production build, and coverage all pass.

- [ ] **Step 4: Perform mutation checks against the new P0 owner**

Temporarily mutate one invariant at a time, run the named owner, confirm RED, and restore the mutation immediately:

1. await the bootstrap flight in public activation;
2. allow a stale generation to complete;
3. accept Retry while booting;
4. remove reduced-motion suppression;
5. interpolate the raw bootstrap error into failed HTML.

Expected owners:

- activation await: `runtimeComposition.test.js`;
- stale generation and Retry: `twoStageStartup.test.js`;
- reduced motion: `dashboardBootShell.test.js`;
- privacy leak: `bootContent.test.js`.

Do not commit mutations.

- [ ] **Step 5: Update main capability coverage with real hashes**

Add `WEBVIEW-TWO-STAGE-STARTUP-001` to `MAIN-DASHBOARD-WEBVIEW-RECOVERY`.

Add actual implementation/test commit hashes from Tasks 1-5 to that capability's `commits`. Advance `audit.head` to the last non-audit implementation commit. Account for design and implementation-plan documentation commits using the repository's existing documentation-audit convention.

Use:

```bash
git log --format='%H %s' origin/main..HEAD
```

Do not invent or abbreviate hashes in audit fields.

- [ ] **Step 6: Write the verification report**

Create `docs/superpowers/reports/2026-07-27-agent-pivot-two-stage-startup-verification.md` containing:

- the pre-fix real Dev Container timestamps from the approved design;
- CI reachability from `quality-linux` to each new owner;
- focused/full command results;
- mutation-check results;
- VSIX path and extension version;
- post-install diagnostic timestamps for activation entered, shell assigned, browser first paint, and bootstrap ready;
- an explicit note that CI proves ordering/state, while the installed trace evaluates perceived timing.

- [ ] **Step 7: Commit the audit and report**

```bash
git add \
  docs/testing/main-capability-coverage.json \
  docs/superpowers/reports/2026-07-27-agent-pivot-two-stage-startup-verification.md
git commit -m "docs: verify two-stage dashboard startup"
```

- [ ] **Step 8: Re-run audit gates after the audit commit**

```bash
npm run test:behavior-contracts
git status --short
```

Expected: behavior and capability audit pass; worktree is clean.

- [ ] **Step 9: Package and inspect the VSIX**

Use the repository's `installing-vscode-extensions-locally` skill at execution time. Build the production bundle and package without publishing:

```bash
npm run vscode:prepublish
npx @vscode/vsce package --no-dependencies
```

Inspect the generated VSIX name and contents. Do not publish or change the version in this task.

- [ ] **Step 10: Install in the active Dev Container extension host**

Install the generated VSIX into the same extension-host environment used for the previous timing trace, reload the window, open Agent Pivot, and collect the new output-channel diagnostics.

Success criteria:

- the boot shell is visible instead of a blank document;
- only one Agent Pivot view exists;
- the authoritative dashboard replaces it in place;
- all dashboard actions still work after ready;
- Retry works when a controlled fixture failure is used;
- `agent-pivot-browser-first-paint` occurs substantially before the former full-dashboard first-content point;
- no raw/private data appears in boot or failure diagnostics.

- [ ] **Step 11: Final diff and cleanliness review**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
rg -n \
  "retry-agent-pivot-bootstrap|agent-pivot-(activation-entered|boot-shell-assigned|bootstrap-ready|browser-first-paint|bootstrap-failed)" \
  src tests docs/testing
git status --short --branch
```

Confirm there are no unrelated changes, no duplicate provider registration, no background unhandled rejection, and no direct push of bootstrap-owned disposables before successful transfer.
