# AI Session YOLO Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe-by-default machine setting that applies each provider's approval-bypassing CLI argument whenever Project Steward creates or resumes an AI session process.

**Architecture:** A focused reader accesses `projectSteward` directly and converts the literal setting into provider-neutral `AiSessionLaunchOptions`. Creation and resume controllers carry a single-use launch-spec factory through the coordinator. Direct Terminal or tmux evaluates that factory exactly once at its final provider-dispatch boundary, so no-dispatch branches never read the setting or build a launch, both backends still share `AiSessionLaunchSpec`, and already-live runtimes remain unchanged.

**Tech Stack:** TypeScript, VS Code extension configuration, Node.js 22.12 test runner, POSIX/PowerShell command serialization, npm scripts.

## Global Constraints

- Add `projectSteward.aiSessionYoloMode` as a machine-scoped boolean with default `false`.
- Only the literal boolean value `true` enables YOLO mode; missing or malformed values fail closed to `false`.
- Read the security-sensitive option directly from `vscode.workspace.getConfiguration('projectSteward')`; the legacy `dashboard.*` fallback must never enable it.
- Apply the setting to both New and Resume process launches for Codex, Kimi, and Claude.
- Use `--dangerously-bypass-approvals-and-sandbox` for Codex, `--yolo` for Kimi, and `--dangerously-skip-permissions` for Claude.
- Do not add a per-launch picker, per-session persistence, runtime badge, intermediate permission preset, or live-runtime migration.
- Changing the setting affects every process launched after the change while enabled, without requiring a VS Code reload.
- Keep Direct Terminal and tmux behavior unified through `AiSessionLaunchSpec`.
- Read launch configuration and call a provider builder exactly once on provider dispatch and zero times for focused, blocked, conflict, cancelled, settings, duplicate, unavailable, or collision exits.
- Work only in `.worktree/ai-session-yolo-mode` on `feat/ai-session-yolo-mode`; do not modify the primary checkout.

## File Structure

- Create `src/aiSessions/launchOptions.ts`: own the provider-neutral launch options type and fail-closed VS Code configuration reader.
- Modify `src/aiSessions/commandBuilders.ts`: translate the provider-neutral YOLO value into provider-specific argv.
- Modify `src/aiSessions/types.ts`: expose launch options in provider New and Resume launch-spec contracts.
- Modify `src/aiSessions/providers.ts`: forward launch options through provider-specific wrappers.
- Create `src/aiSessions/runtimeLaunch.ts`: snapshot deferred launch intent, enforce single use, and materialize a common launch spec.
- Modify `src/aiSessions/runtimeTypes.ts`: represent deferred and materialized runtime launch requests.
- Modify `src/aiSessions/creationController.ts`: capture a defensive New launch factory.
- Modify `src/aiSessions/resumeController.ts`: capture a defensive Resume launch factory.
- Modify `src/aiSessions/runtimeCoordinator.ts`: snapshot and route the factory without evaluating it.
- Modify `src/aiSessions/directTerminalRuntimeBackend.ts`: materialize only at direct provider dispatch.
- Modify `src/aiSessions/tmuxRuntimeBackend.ts`: materialize after final target checks and make pending ambiguity identity launch-option-independent.
- Modify `src/aiSessions/tmuxRuntimeBindingStore.ts`: accept new `v3` and legacy pending fingerprints.
- Modify `src/dashboard.ts`: supply the VS Code workspace so the reader accesses `projectSteward` directly.
- Modify `package.json`: declare the public setting contract.
- Modify `README.md`: document risk, scope, and next-launch semantics.
- Modify `tests/contract/aiSessions/runtimePrimitives.test.js`: verify configuration and serialized launch boundaries.
- Modify `tests/unit/aiSessions/commandBuilders.test.js`: verify all six provider/action YOLO argv variants.
- Modify `tests/platform/windows/commandBuilders.test.js`: verify Windows serialization preserves the new flags as CLI syntax.
- Modify `tests/contract/aiSessions/sessionControllers.test.js`: verify New and Resume propagate a launch-options snapshot.
- Modify `scripts/run-ai-session-safety-checks.js`: preserve production-wiring guards and supply safe launch options in controller fixtures.
- Modify `scripts/run-ai-session-tmux-checks.js`: supply safe launch options in tmux controller fixtures and retain backend parity coverage.

Tasks 1–4 preserve the original implementation sequence. Task 5 is the
binding post-review correction and supersedes any earlier eager-construction
snippet.

---

### Task 1: Safe Launch Configuration Contract

**Files:**
- Create: `src/aiSessions/launchOptions.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/contract/aiSessions/runtimePrimitives.test.js`

**Interfaces:**
- Consumes: a VS Code-compatible workspace configuration provider with `getConfiguration(section)`.
- Produces: `AiSessionLaunchOptions { yolo: boolean }` and `readAiSessionLaunchOptions(workspace): AiSessionLaunchOptions`, reading only `projectSteward`.

- [ ] **Step 1: Write the failing configuration contract test**

Add the import beside the existing runtime configuration import in
`tests/contract/aiSessions/runtimePrimitives.test.js`:

```js
const launchOptions = require('../../../out/aiSessions/launchOptions');
```

Add this test immediately after
`RUNTIME-RUNTIME-CONFIGURATION-001`:

```js
test('SESSION-AI-SESSION-YOLO-CONFIGURATION-001 reads only literal true and declares a safe machine setting', () => {
    assert.deepEqual(
        launchOptions.readAiSessionLaunchOptions(workspaceConfiguration({})),
        { yolo: false }
    );
    assert.deepEqual(
        launchOptions.readAiSessionLaunchOptions(
            workspaceConfiguration({ aiSessionYoloMode: true })
        ),
        { yolo: true }
    );
    for (const invalid of [false, null, 1, 'true', 'false', {}]) {
        assert.deepEqual(
            launchOptions.readAiSessionLaunchOptions(
                workspaceConfiguration({ aiSessionYoloMode: invalid })
            ),
            { yolo: false }
        );
    }
    assert.deepEqual(
        launchOptions.readAiSessionLaunchOptions(
            workspaceConfiguration({}, { aiSessionYoloMode: true })
        ),
        { yolo: false }
    );

    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties[
        'projectSteward.aiSessionYoloMode'
    ];
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, false);
    assert.equal(setting.scope, 'machine');
    assert.match(setting.description, /bypass/i);
    assert.match(setting.description, /newly created and resumed/i);
});
```

- [ ] **Step 2: Run the targeted contract test to verify it fails**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/runtimePrimitives.test.js
```

Expected: compilation succeeds, then the test process fails with
`Cannot find module '../../../out/aiSessions/launchOptions'`.

- [ ] **Step 3: Add the fail-closed launch-options reader**

Create `src/aiSessions/launchOptions.ts`:

```ts
'use strict';

export interface AiSessionLaunchOptions {
    yolo: boolean;
}

interface ConfigurationReader {
    get<T>(key: string, fallback: T): T;
}

interface WorkspaceConfigurationProvider {
    getConfiguration(section: string): ConfigurationReader;
}

export function readAiSessionLaunchOptions(
    workspace: WorkspaceConfigurationProvider
): AiSessionLaunchOptions {
    const configuration = workspace.getConfiguration('projectSteward');
    return {
        yolo: configuration.get<unknown>('aiSessionYoloMode', false) === true,
    };
}
```

- [ ] **Step 4: Declare and document the public setting**

Add this property after `projectSteward.aiSessionTerminalMode` in
`package.json`:

```json
"projectSteward.aiSessionYoloMode": {
    "type": "boolean",
    "default": false,
    "scope": "machine",
    "description": "Bypass provider approval and sandbox protections for newly created and resumed AI session processes. This is dangerous and does not change already running sessions."
},
```

Add this bullet under `AI runtime options (all machine-scoped)` in
`README.md`:

```markdown
- `projectSteward.aiSessionYoloMode`: `false` by default. When `true`, newly created and resumed Codex, Kimi, and Claude processes bypass their normal approval protections. This is dangerous, affects every process launched after the change while enabled, and never changes an already live runtime.
```

Extend the nearby JSON example:

```json
{
  "projectSteward.aiSessionTerminalMode": "tmux",
  "projectSteward.aiSessionTmuxLayout": "project",
  "projectSteward.aiSessionTmuxPath": "/usr/bin/tmux",
  "projectSteward.aiSessionYoloMode": false
}
```

- [ ] **Step 5: Run the targeted configuration contract**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/runtimePrimitives.test.js
```

Expected: all tests in `runtimePrimitives.test.js` pass, including
`SESSION-AI-SESSION-YOLO-CONFIGURATION-001`.

- [ ] **Step 6: Commit the configuration contract**

```bash
git add src/aiSessions/launchOptions.ts package.json README.md tests/contract/aiSessions/runtimePrimitives.test.js
git diff --cached --check
git commit -m "feat: add AI session yolo setting"
```

### Task 2: Provider-Specific YOLO Launch Arguments

**Files:**
- Modify: `src/aiSessions/commandBuilders.ts`
- Test: `tests/unit/aiSessions/commandBuilders.test.js`
- Test: `tests/contract/aiSessions/runtimePrimitives.test.js`
- Test: `tests/platform/windows/commandBuilders.test.js`

**Interfaces:**
- Consumes: `AiSessionLaunchOptions` from `src/aiSessions/launchOptions.ts`.
- Produces: all six `build{Codex,Kimi,Claude}{NewSession,Resume}LaunchSpec` functions accept an optional final `launchOptions` argument and preserve safe defaults when it is omitted.

- [ ] **Step 1: Write failing argv tests for all providers and actions**

Add this focused test to
`tests/unit/aiSessions/commandBuilders.test.js`:

```js
test('SESSION-AI-SESSION-YOLO-LAUNCH-001 adds the exact provider flag to New and Resume argv', () => {
    const yolo = { yolo: true };
    assert.deepEqual(
        commands.buildCodexNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, title]
    );
    assert.deepEqual(
        commands.buildCodexResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['resume', '--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, sessionId]
    );
    assert.deepEqual(
        commands.buildKimiNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--work-dir', cwd, '--yolo', '--prompt', title]
    );
    assert.deepEqual(
        commands.buildKimiResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['--work-dir', cwd, '--yolo', '--resume', sessionId]
    );
    assert.deepEqual(
        commands.buildClaudeNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--dangerously-skip-permissions', '--name', title]
    );
    assert.deepEqual(
        commands.buildClaudeResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['--dangerously-skip-permissions', '--resume', sessionId]
    );
});
```

Add these assertions inside `RUNTIME-LAUNCH-SPEC-001` in
`tests/contract/aiSessions/runtimePrimitives.test.js` after the existing
safe Claude assertions:

```js
const yoloSpecs = [
    commandBuilders.buildCodexNewSessionLaunchSpec(
        directoryScope('/work/codex'), null, null, { yolo: true }
    ),
    commandBuilders.buildKimiResumeLaunchSpec(
        'kimi-session', directoryScope('/work/kimi'), null, { yolo: true }
    ),
    commandBuilders.buildClaudeNewSessionLaunchSpec(
        directoryScope('/work/claude'), null, null, { yolo: true }
    ),
];
for (const spec of yoloSpecs) {
    const direct = launchSpec.serializeDirectLaunchCommand(spec, 'linux');
    const tmux = launchSpec.serializeTmuxLaunchCommand(spec);
    assert.match(direct, /--(?:dangerously-bypass-approvals-and-sandbox|yolo|dangerously-skip-permissions)/);
    assert.match(tmux, /--(?:dangerously-bypass-approvals-and-sandbox|yolo|dangerously-skip-permissions)/);
}
```

Add this test to `tests/platform/windows/commandBuilders.test.js`, reusing
that file's `directoryScope` and `decodePowerShellPayload` helpers. Add this
import beside the command-builder import:

```js
const { serializeDirectLaunchCommand } = require('../../../out/aiSessions/launchSpec');
```

Then add:

```js
test('SESSION-AI-SESSION-YOLO-LAUNCH-001 serializes provider flags as Windows CLI syntax', () => {
    const yolo = { yolo: true };
    const specs = [
        commands.buildCodexNewSessionLaunchSpec(directoryScope(cwd), null, null, yolo),
        commands.buildKimiNewSessionLaunchSpec(directoryScope(cwd), null, null, yolo),
        commands.buildClaudeNewSessionLaunchSpec(directoryScope(cwd), null, null, yolo),
    ];
    const payloads = specs.map(spec =>
        decodePowerShellPayload(serializeDirectLaunchCommand(spec, 'win32'))
    );
    assert.match(payloads[0], /codex --dangerously-bypass-approvals-and-sandbox/);
    assert.match(payloads[1], /kimi .*--yolo/);
    assert.match(payloads[2], /claude --dangerously-skip-permissions/);
});
```

- [ ] **Step 2: Run focused tests to verify the new assertions fail**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/commandBuilders.test.js
node --test tests/contract/aiSessions/runtimePrimitives.test.js
node --test tests/platform/windows/commandBuilders.test.js
```

Expected: the new YOLO tests fail because the fourth launch-spec argument is
ignored and no provider-specific flag is present.

- [ ] **Step 3: Extend the pure launch-spec builders**

Import the type in `src/aiSessions/commandBuilders.ts`:

```ts
import type { AiSessionLaunchOptions } from './launchOptions';
```

Add a safe default and helper:

```ts
const SAFE_LAUNCH_OPTIONS: AiSessionLaunchOptions = Object.freeze({ yolo: false });

function yoloArg(options: AiSessionLaunchOptions, argument: string): string[] {
    return options?.yolo === true ? [argument] : [];
}
```

Change the six launch-spec signatures to accept:

```ts
launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS
```

Build the provider argv exactly as follows:

```ts
// Codex Resume
args: [
    'resume',
    ...yoloArg(launchOptions, '--dangerously-bypass-approvals-and-sandbox'),
    ...(scope?.primaryCwd ? ['--cd', scope.primaryCwd] : []),
    ...buildRepeatedAdditionalDirectoryArgs(scope),
    sessionId,
],

// Codex New
args: [
    ...yoloArg(launchOptions, '--dangerously-bypass-approvals-and-sandbox'),
    ...(scope?.primaryCwd ? ['--cd', scope.primaryCwd] : []),
    ...buildRepeatedAdditionalDirectoryArgs(scope),
    ...(prompt ? [prompt] : []),
],

// Kimi Resume
args: [
    ...(scope?.primaryCwd ? ['--work-dir', scope.primaryCwd] : []),
    ...buildRepeatedAdditionalDirectoryArgs(scope),
    ...yoloArg(launchOptions, '--yolo'),
    '--resume', sessionId,
],

// Kimi New
args: [
    ...(scope?.primaryCwd ? ['--work-dir', scope.primaryCwd] : []),
    ...buildRepeatedAdditionalDirectoryArgs(scope),
    ...yoloArg(launchOptions, '--yolo'),
    ...(prompt ? ['--prompt', prompt] : []),
],

// Claude Resume
args: [
    ...buildClaudeAdditionalDirectoryArgs(scope),
    ...yoloArg(launchOptions, '--dangerously-skip-permissions'),
    '--resume', sessionId,
],

// Claude New
args: [
    ...buildClaudeAdditionalDirectoryArgs(scope),
    ...yoloArg(launchOptions, '--dangerously-skip-permissions'),
    ...(title ? ['--name', title] : []),
],
```

Do not change the existing command wrapper signatures in this task. They omit
the optional launch-options argument and therefore continue to serialize the
safe default exactly as before.

- [ ] **Step 4: Run provider and serializer tests**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/commandBuilders.test.js
node --test tests/contract/aiSessions/runtimePrimitives.test.js
node --test tests/platform/windows/commandBuilders.test.js
```

Expected: all three commands pass; existing non-YOLO exact argv and command
strings remain unchanged.

- [ ] **Step 5: Commit provider launch behavior**

```bash
git add src/aiSessions/commandBuilders.ts tests/unit/aiSessions/commandBuilders.test.js tests/contract/aiSessions/runtimePrimitives.test.js tests/platform/windows/commandBuilders.test.js
git diff --cached --check
git commit -m "feat: add provider yolo launch arguments"
```

### Task 3: Controller Propagation and Production Wiring

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/providers.ts`
- Modify: `src/aiSessions/creationController.ts`
- Modify: `src/aiSessions/resumeController.ts`
- Modify: `src/dashboard.ts`
- Test: `tests/contract/aiSessions/sessionControllers.test.js`
- Test: `scripts/run-ai-session-safety-checks.js`
- Test: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Consumes: `readAiSessionLaunchOptions(vscode.workspace)` and the optional fourth builder argument introduced in Task 2.
- Produces: both controller option types require `getLaunchOptions: () => AiSessionLaunchOptions`; controllers close over it in a single-use factory, and provider launch-spec contracts require an explicit `AiSessionLaunchOptions` value.

- [ ] **Step 1: Write failing controller propagation assertions**

In the creation-controller test in
`tests/contract/aiSessions/sessionControllers.test.js`, declare:

```js
const receivedLaunchOptions = [];
```

Change its provider builder and add the reader:

```js
getLaunchOptions: () => ({ yolo: true }),
getProvider: () => ({
    label: 'Codex',
    terminalNamePrefix: 'Codex',
    buildNewSessionLaunchSpec: (_scope, _title, _markerPath, launchOptions) => {
        receivedLaunchOptions.push(launchOptions);
        return { executable: 'codex', args: ['--new'], cwd: '/work' };
    },
}),
```

After the request assertions, add:

```js
assert.deepEqual(receivedLaunchOptions, [{ yolo: true }]);
```

In the resume-controller test, declare another
`receivedLaunchOptions` array and use:

```js
getLaunchOptions: () => ({ yolo: true }),
getProvider: () => ({
    label: 'Codex',
    terminalEnvKey: 'CODEX',
    buildResumeLaunchSpec: (_id, _scope, _markerPath, launchOptions) => {
        receivedLaunchOptions.push(launchOptions);
        return { executable: 'codex', args: ['resume', 's'], cwd: '/work' };
    },
}),
```

After the resume request assertions, add:

```js
assert.deepEqual(receivedLaunchOptions, [{ yolo: true }]);
```

For a stub that returns `started`, invoke `request.createLaunchSpec()` once to
model the backend's final dispatch. Stubs returning `focused`, `blocked`,
`conflict`, `cancelled`, or `settings` must not invoke it.

- [ ] **Step 2: Run the focused controller contract to verify it fails**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/sessionControllers.test.js
```

Expected: both new assertions fail because the provider builders receive
`undefined` as their fourth argument.

- [ ] **Step 3: Extend provider and controller contracts**

Import `AiSessionLaunchOptions` into `src/aiSessions/types.ts`,
`src/aiSessions/creationController.ts`, and
`src/aiSessions/resumeController.ts`:

```ts
import type { AiSessionLaunchOptions } from './launchOptions';
```

Add this required controller option to both common option interfaces:

```ts
getLaunchOptions: () => AiSessionLaunchOptions;
```

Add `launchOptions: AiSessionLaunchOptions` as the fourth parameter of
`AiSessionProviderDefinition.buildResumeLaunchSpec`,
`AiSessionProviderDefinition.buildNewSessionLaunchSpec`,
`AiSessionCreationProvider.buildNewSessionLaunchSpec`, and
`AiSessionResumeProvider.buildResumeLaunchSpec`.

In `AiSessionCreationController.createRuntimeSession`, capture a single-use
factory over a defensive scope snapshot:

```ts
launchMarkerPath: markerPath,
createLaunchSpec: createSingleUseLaunchSpecFactory(() =>
    sessionProvider.buildNewSessionLaunchSpec(
        launchScope,
        fields.title,
        markerPath,
        options.getLaunchOptions()
    )),
```

In `AiSessionResumeController.resumeRuntime`, do the same:

```ts
launchMarkerPath: markerPath,
createLaunchSpec: createSingleUseLaunchSpecFactory(() =>
    sessionProvider.buildResumeLaunchSpec(
        session.id,
        launchScope,
        markerPath,
        options.getLaunchOptions()
    )),
```

Require `getLaunchOptions` in both `validateControllerOptions` functions:

```ts
|| typeof options.getLaunchOptions !== 'function'
```

- [ ] **Step 4: Forward options through provider definitions**

Update the Codex and Kimi New wrappers in `src/aiSessions/providers.ts`:

```ts
buildNewSessionLaunchSpec: (scope, _title, markerPath, launchOptions) =>
    buildCodexNewSessionLaunchSpec(scope, null, markerPath, launchOptions),
```

```ts
buildNewSessionLaunchSpec: (scope, _title, markerPath, launchOptions) =>
    buildKimiNewSessionLaunchSpec(scope, null, markerPath, launchOptions),
```

The direct Codex/Kimi/Claude Resume functions and Claude New function already
accept the compatible optional fourth argument from Task 2 and can remain
direct references.

- [ ] **Step 5: Wire current configuration into production**

Import the reader in `src/dashboard.ts`:

```ts
import { readAiSessionLaunchOptions } from './aiSessions/launchOptions';
```

Add this dependency to both `AiSessionCreationController` and
`AiSessionResumeController` construction:

```ts
getLaunchOptions: () =>
    readAiSessionLaunchOptions(vscode.workspace),
```

Do not add `projectSteward.aiSessionYoloMode` to the runtime-configuration
change handler. The reader is evaluated on each launch, so toggling the setting
requires neither backend rebuild nor dashboard refresh.

- [ ] **Step 6: Update all controller fixtures with a safe reader**

Use these searches to enumerate every fixture:

```bash
rg -n "new (AiSessionCreationController|CreationController)" tests scripts
rg -n "new (AiSessionResumeController|ResumeController)" tests scripts
```

For every creation or resume controller fixture in
`scripts/run-ai-session-safety-checks.js` and
`scripts/run-ai-session-tmux-checks.js` that does not explicitly test YOLO
propagation, add:

```js
getLaunchOptions: () => ({ yolo: false }),
```

Keep the two focused contract fixtures from Step 1 at `{ yolo: true }`.

Extend the production wiring assertions near the existing constructor checks
in `scripts/run-ai-session-safety-checks.js`:

```js
assert.ok(dashboard.includes(
    "import { readAiSessionLaunchOptions } from './aiSessions/launchOptions';"
));
assert.strictEqual(
    (dashboard.match(/getLaunchOptions: \(\) =>/g) || []).length,
    2
);
assert.ok(dashboard.includes('readAiSessionLaunchOptions(vscode.workspace)'));
assert.ok(!dashboard.includes(
    'readAiSessionLaunchOptions(getStewardConfiguration())'
));
```

- [ ] **Step 7: Run controller, provider-contract, safety, and tmux checks**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/sessionControllers.test.js
node --test tests/contract/aiSessions/providers.test.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
```

Expected: all commands pass; safety checks confirm exactly two production
launch-options readers, and tmux fixtures retain the same safe default.

- [ ] **Step 8: Commit controller and production wiring**

```bash
git add src/aiSessions/types.ts src/aiSessions/providers.ts src/aiSessions/creationController.ts src/aiSessions/resumeController.ts src/dashboard.ts tests/contract/aiSessions/sessionControllers.test.js scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js
git diff --cached --check
git commit -m "feat: apply yolo mode to AI session launches"
```

### Task 4: Full Regression Verification

**Files:**
- Verify only; no source file should change.

**Interfaces:**
- Consumes: the three implementation commits from Tasks 1–3.
- Produces: evidence that deterministic, safety, Windows, lint, architecture, and packaging checks still pass.

- [ ] **Step 1: Run deterministic tests**

```bash
npm run test:deterministic
```

Expected: unit, contract, and integration suites pass.

- [ ] **Step 2: Run AI runtime and workspace safety checks**

```bash
npm run test:safety
```

Expected: workspace parity, AI session tmux, AI session safety, and open-project
safety checks pass.

- [ ] **Step 3: Run Windows command-builder coverage**

```bash
npm run test:ci:windows
```

Expected: Windows project and AI session command tests pass.

- [ ] **Step 4: Run static quality and production build checks**

```bash
npm run lint:ci
npm run test:architecture-guards
npm run vscode:prepublish
```

Expected: lint baseline, architecture guards, webpack, and production asset
generation pass.

- [ ] **Step 5: Inspect the final branch**

```bash
git diff --check origin/main...HEAD
git status -sb
git log --oneline --decorate origin/main..HEAD
```

Expected: no whitespace errors; the worktree is clean; the post-review fixes
and documentation are contained in one focused review-fix commit after the
previous implementation history.

### Task 5: Binding Post-Review Lazy-Dispatch Fix

**Files:**
- Modify the configuration reader and dashboard wiring.
- Add deferred launch request types and `runtimeLaunch.ts`.
- Modify both controllers, the coordinator, and both runtime backends.
- Modify tmux pending ambiguity fingerprint validation and recovery.
- Extend focused contracts, safety checks, tmux checks, README, design, and this plan.

**Interfaces:**
- Controllers produce `launchMarkerPath` plus a single-use
  `createLaunchSpec()` factory.
- The coordinator and backends preserve that factory without reading a legacy
  concrete `launch` property.
- Only the final direct/tmux provider-dispatch boundary materializes
  `AiSessionLaunchSpec`.
- New pending ambiguity records use a stable, launch-option-independent `v3`
  fingerprint; matching legacy hashes remain recoverable.

- [ ] **Step 1: Record focused RED evidence**

Add regressions for direct configuration reads, malformed truthy options,
controller/coordinator/backend no-dispatch branches, fallback-time setting
changes, stable pending fingerprints, and legacy ambiguity recovery. Run
`npm run test-compile` followed by each focused command and retain the failing
totals in the final review report.

- [ ] **Step 2: Implement the final lazy boundary**

Carry the single-use factory through immutable request snapshots. Materialize
it once immediately before Direct Terminal sends the provider launch or tmux
calls `create-session`/`create-window`, after every availability, ownership,
lifecycle, duplicate, conflict, fallback, lock, and target check.

- [ ] **Step 3: Run focused GREEN verification**

Run the configuration/options, builder unit/contract/Windows,
creation/resume-controller, coordinator-all-branches, and backend-boundary
tests after `npm run test-compile`.

- [ ] **Step 4: Run required regression verification**

```bash
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
npm run test:deterministic
```

- [ ] **Step 5: Self-review and create one post-review commit**

Inspect the complete diff, run `git diff --check`, write
`.superpowers/sdd/final-review-fix-report.md`, stage all post-review code,
tests, and documentation together, and create one focused review-fix commit.
