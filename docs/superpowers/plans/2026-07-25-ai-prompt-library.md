# AI Prompt Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronized global Prompt library under a new Dashboard AI tab and one command that inserts either the selected default Prompt or a picker choice into the terminal captured at command invocation.

**Architecture:** A focused `src/prompts` module owns validation, global-setting persistence, terminal command behavior, Host-side HTML rendering, and correlated Dashboard mutations. The existing Dashboard lazily mounts an AI panel, while `webviewPromptScripts.js` keeps only transient draft/focus/scroll/pending state and accepts persisted state exclusively through Host-rendered authoritative replacements.

**Tech Stack:** TypeScript 4.1, VS Code Extension API `^1.51.0`, plain Webview JavaScript, SCSS/CSS, Node's built-in test runner, existing webpack/gulp/VSIX verification tooling.

## Global Constraints

- Keep `engines.vscode` at `^1.51.0`; add no production dependency.
- Contribute exactly one public command: `projectSteward.insertPromptToActiveTerminal`, titled `Project Steward: Insert Prompt into Active Terminal`.
- Persist only `projectSteward.promptData` at `vscode.ConfigurationTarget.Global`, declare it with configuration scope `application`, and keep it Settings Sync eligible.
- Store plain text only; preserve Prompt body text exactly and never interpolate variables, append Enter, create a terminal, or change the default after a QuickPick choice.
- Keep array order authoritative and allow exactly zero or one `selectedPromptId`.
- Capture the active terminal before any data read or QuickPick and call `sendText(text, false)` on that same terminal.
- Add top-level `AI`; its subtabs are `PROMPTS`, `SKILLS`, `MCP`, and `HOOKS`, with only `PROMPTS` functional and the other panels displaying `Coming Soon`.
- Keep Prompt content out of Dashboard global search and do not expose per-Prompt commands or keybindings.
- Use fresh opaque string request IDs and the full `version + requestId + target + operation` correlation identity for mutations.
- The Host owns persisted state and rendered Prompt HTML. Every recognizable mutation settles exactly once; the Webview clears success pending only after applying the correlated authoritative replacement.
- Apply the repository `resilient-webview-mutation-protocols` skill throughout Host mutation and Webview replacement work.
- Never log Prompt bodies. Diagnostics may include bounded names, IDs, counts, revisions, and error categories.

---

### Task 1: Versioned global Prompt store

**Files:**
- Create: `src/prompts/types.ts`
- Create: `src/prompts/service.ts`
- Create: `tests/unit/prompts/service.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `PromptV1`, `PromptDataV1`, `PromptPanelSnapshot`, `PromptMutationOperation`, `PromptMutationError`.
  - `normalizePromptSetting(value: unknown): PromptReadResult`.
  - `PromptService.getSnapshot(): PromptPanelSnapshot`.
  - `PromptService.createPrompt(expectedRevision, input)`, `updatePrompt(expectedRevision, input)`, `deletePrompt(expectedRevision, promptId)`, `reorderPrompts(expectedRevision, promptIds)`, and `selectDefault(expectedRevision, promptId)`.
  - `PromptService.consumeCurrentSettingsDataLocalWriteEcho(): boolean`.
- Consumes: an injected `readSetting`, `writeGlobalSetting`, `createId`, and bounded diagnostic callback; no Webview or terminal API.

- [ ] **Step 1: Write the failing service tests**

Create `tests/unit/prompts/service.test.js` with a memory-backed setting port and tests named with behavior ID `PERSIST-AI-PROMPT-STORE-001`. The fixture must expose writes so the target and exact persisted value are assertable:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    PromptMutationError,
    PromptService,
    normalizePromptSetting,
} = require('../../../out/prompts/service');

function createFixture(initial) {
    let stored = initial;
    const writes = [];
    const diagnostics = [];
    const ids = ['prompt-a', 'prompt-b', 'prompt-c'];
    const service = new PromptService({
        readSetting: () => stored,
        writeGlobalSetting: async data => {
            writes.push(structuredClone(data));
            stored = structuredClone(data);
        },
        createId: () => ids.shift(),
        logDiagnostic: value => diagnostics.push(value),
    });
    return { service, writes, diagnostics, getStored: () => stored };
}

test('PERSIST-AI-PROMPT-STORE-001 starts with immutable empty V1 data', () => {
    const fixture = createFixture(undefined);
    const snapshot = fixture.service.getSnapshot();
    assert.deepEqual(snapshot, {
        version: 1, revision: 0, selectedPromptId: null, prompts: [],
    });
    assert.throws(() => snapshot.prompts.push({}));
});

test('PERSIST-AI-PROMPT-STORE-001 creates, edits, reorders, selects, and deletes atomically', async () => {
    const fixture = createFixture(undefined);
    await fixture.service.createPrompt(0, { name: 'Review', text: 'Review this diff.' });
    await fixture.service.createPrompt(1, { name: 'Explain', text: 'Explain\ncarefully.' });
    await fixture.service.updatePrompt(2, {
        promptId: 'prompt-a', name: 'Review code', text: 'Review this code.',
    });
    await fixture.service.reorderPrompts(3, ['prompt-b', 'prompt-a']);
    await fixture.service.selectDefault(4, 'prompt-a');
    const result = await fixture.service.deletePrompt(5, 'prompt-a');
    assert.deepEqual(result, {
        version: 1,
        revision: 6,
        selectedPromptId: null,
        prompts: [{ id: 'prompt-b', name: 'Explain', text: 'Explain\ncarefully.' }],
    });
    assert.equal(fixture.writes.length, 6);
});
```

Add explicit tests for trimmed/case-folded duplicate names, blank names, whitespace-only bodies, body preservation, duplicate IDs, duplicate stored names, invalid and non-integer revisions, exact reorder permutations, missing mutation targets, stale `expectedRevision`, serialized local mutations, failed writes, stale selected IDs, local write-echo consumption, and unsupported positive versions. Assert diagnostics never contain body text.

- [ ] **Step 2: Run the focused test and confirm the intended failure**

Run:

```bash
npm run test-compile
node --test tests/unit/prompts/service.test.js
```

Expected: compilation or module loading fails because `src/prompts/service.ts` does not exist.

- [ ] **Step 3: Add the manifest setting and model contracts**

In `package.json`, add `projectSteward.promptData` with `scope: "application"`, the exact V1 default, a closed object schema, and a warning that synchronized settings are not secret storage:

```json
"projectSteward.promptData": {
    "type": "object",
    "scope": "application",
    "markdownDescription": "Stores the global synchronized Prompt library. Prompt text is ordinary Settings Sync data; do not store credentials or other secrets.",
    "default": {
        "version": 1,
        "revision": 0,
        "selectedPromptId": null,
        "prompts": []
    },
    "additionalProperties": false,
    "required": ["version", "revision", "selectedPromptId", "prompts"],
    "properties": {
        "version": { "type": "number", "enum": [1] },
        "revision": { "type": "number", "minimum": 0 },
        "selectedPromptId": { "type": ["string", "null"] },
        "prompts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["id", "name", "text"],
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "name": { "type": "string", "minLength": 1 },
                    "text": { "type": "string", "minLength": 1 }
                }
            }
        }
    }
}
```

Define the public contracts in `src/prompts/types.ts`:

```ts
export interface PromptV1 {
    readonly id: string;
    readonly name: string;
    readonly text: string;
}

export interface PromptDataV1 {
    readonly version: 1;
    readonly revision: number;
    readonly selectedPromptId: string | null;
    readonly prompts: readonly PromptV1[];
}

export type PromptMutationOperation =
    | 'create' | 'update' | 'delete' | 'reorder' | 'select-default';

export type PromptMutationErrorCode =
    | 'invalid' | 'not-found' | 'conflict' | 'storage'
    | 'unsupported-version' | 'cancelled';

export interface PromptPanelSnapshot extends PromptDataV1 {
    readonly readOnlyReason?: 'invalid-data' | 'unsupported-version';
}

export type PromptReadResult =
    | { readonly status: 'ready'; readonly snapshot: PromptPanelSnapshot }
    | { readonly status: 'read-only'; readonly snapshot: PromptPanelSnapshot };
```

- [ ] **Step 4: Implement strict normalization and serialized mutations**

Implement `src/prompts/service.ts` so it deep-freezes cloned snapshots, trims names, preserves `text`, rejects invalid records as a read-only snapshot, recovers only a stale `selectedPromptId`, re-reads before each queued write, compares `expectedRevision`, increments once, writes the whole V1 record, and marks one local write echo only after a successful write.

Use these exact dependency and method signatures:

```ts
export interface PromptServiceOptions {
    readSetting: () => unknown;
    writeGlobalSetting: (data: PromptDataV1) => Promise<void>;
    createId: () => string;
    logDiagnostic?: (event: {
        category: string;
        revision?: number;
        promptId?: string;
        promptName?: string;
    }) => void;
}

export class PromptMutationError extends Error {
    constructor(
        readonly code: PromptMutationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'PromptMutationError';
        Object.setPrototypeOf(this, PromptMutationError.prototype);
    }
}

export class PromptService {
    getSnapshot(): PromptPanelSnapshot;
    createPrompt(
        expectedRevision: number,
        input: { name: string; text: string },
    ): Promise<PromptPanelSnapshot>;
    updatePrompt(
        expectedRevision: number,
        input: { promptId: string; name: string; text: string },
    ): Promise<PromptPanelSnapshot>;
    deletePrompt(
        expectedRevision: number,
        promptId: string,
    ): Promise<PromptPanelSnapshot>;
    reorderPrompts(
        expectedRevision: number,
        promptIds: readonly string[],
    ): Promise<PromptPanelSnapshot>;
    selectDefault(
        expectedRevision: number,
        promptId: string | null,
    ): Promise<PromptPanelSnapshot>;
    consumeCurrentSettingsDataLocalWriteEcho(): boolean;
}
```

For `selectDefault`, receiving the currently selected ID must persist `null`; receiving another existing ID must replace the selection. Wrap unexpected write errors as `PromptMutationError('storage', ...)` and re-read after failure.

- [ ] **Step 5: Run focused and manifest contract tests**

Run:

```bash
npm run test:unit -- --test-name-pattern=PERSIST-AI-PROMPT-STORE-001
npm run test:contract -- --test-name-pattern=dashboard
npm run lint:ci
```

Expected: all selected tests and lint pass; the manifest remains compatible with the current engine floor.

- [ ] **Step 6: Commit the store**

```bash
git add package.json src/prompts/types.ts src/prompts/service.ts tests/unit/prompts/service.test.js
git commit -m "feat: add synchronized prompt store"
```

---

### Task 2: Active-terminal Prompt insertion command

**Files:**
- Create: `src/prompts/terminalCommandController.ts`
- Create: `tests/contract/prompts/terminalCommandController.test.js`
- Modify: `src/dashboard/commandRegistration.ts`
- Modify: `src/dashboard.ts`
- Modify: `package.json`
- Modify: `tests/contract/dashboardBoundaries.test.js`
- Modify: `tests/unit/tooling/extensionHostSuite.test.js`

**Interfaces:**
- Consumes: `PromptService.getSnapshot()`.
- Produces: `PromptTerminalCommandController.insertPromptToActiveTerminal(): Promise<void>`.
- Adds `DashboardCommandHandlers.insertPromptToActiveTerminal`.

- [ ] **Step 1: Write failing terminal sequence tests**

Create a dependency-injected fixture in `tests/contract/prompts/terminalCommandController.test.js` and cover behavior ID `SESSION-AI-PROMPT-TERMINAL-INSERTION-001`:

```js
test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 inserts the default without a picker', async () => {
    const terminal = { sent: [], shown: 0, sendText(text, addNewLine) {
        this.sent.push([text, addNewLine]);
    }, show() { this.shown += 1; } };
    const fixture = createFixture({
        terminal,
        snapshot: {
            version: 1, revision: 2, selectedPromptId: 'prompt-a',
            prompts: [{ id: 'prompt-a', name: 'Review', text: 'Review\nthis.' }],
        },
    });
    await fixture.controller.insertPromptToActiveTerminal();
    assert.deepEqual(terminal.sent, [['Review\nthis.', false]]);
    assert.equal(terminal.shown, 1);
    assert.equal(fixture.quickPickCalls.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 retains the terminal captured before the picker', async () => {
    const original = createTerminal();
    const replacement = createTerminal();
    const fixture = createFixture({ terminal: original, selectedPromptId: null });
    fixture.onQuickPick = items => {
        fixture.activeTerminal = replacement;
        return items[1];
    };
    await fixture.controller.insertPromptToActiveTerminal();
    assert.equal(original.sent.length, 1);
    assert.equal(replacement.sent.length, 0);
});
```

Also test ordered picker items with bounded first-line previews, picker cancellation, empty library plus `Open AI Prompts`, stale default fallback, unsupported/read-only data, no active terminal, `sendText` rejection/disposal, multiline preservation, and no service mutation.

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npm run test-compile
node --test tests/contract/prompts/terminalCommandController.test.js
```

Expected: FAIL because `PromptTerminalCommandController` is not implemented.

- [ ] **Step 3: Implement the command controller**

Use these exact ports in `src/prompts/terminalCommandController.ts`:

```ts
export interface PromptTerminalLike {
    sendText(text: string, addNewLine?: boolean): void | PromiseLike<void>;
    show?(): void;
}

export interface PromptQuickPickItem {
    label: string;
    description: string;
    promptId: string;
}

export interface PromptTerminalCommandControllerOptions {
    service: Pick<PromptService, 'getSnapshot'>;
    getActiveTerminal: () => PromptTerminalLike | null | undefined;
    showQuickPick: (
        items: readonly PromptQuickPickItem[],
        options: { placeHolder: string; matchOnDescription: boolean },
    ) => PromiseLike<PromptQuickPickItem | undefined>;
    showWarningMessage: (message: string) => unknown;
    showInformationMessage: (
        message: string,
        action: 'Open AI Prompts',
    ) => PromiseLike<string | undefined>;
    openAiPrompts: () => unknown;
}
```

`insertPromptToActiveTerminal()` must capture the terminal first, read a fresh snapshot, choose a valid default or QuickPick result by opaque ID, then call `await Promise.resolve(terminal.sendText(text, false))` followed by `terminal.show?.()`. Catch insertion failure once and show `The selected terminal is no longer available.` without consulting a replacement terminal.

- [ ] **Step 4: Register and contribute the public command**

Add this command contribution:

```json
{
    "command": "projectSteward.insertPromptToActiveTerminal",
    "title": "Project Steward: Insert Prompt into Active Terminal"
}
```

Add `insertPromptToActiveTerminal` to `DashboardCommandHandlers`, register it in `DashboardCommandRegistration.register()`, and create the controller in `src/dashboard.ts`. Implement `openAiPrompts` now as an async callback that calls `showSteward()` and then posts:

```ts
await provider.postMessage({
    type: 'select-dashboard-tab',
    version: 1,
    tab: 'ai',
    aiSubtab: 'prompts',
});
```

Task 4 adds the Webview receiver; posting this forward-compatible intent is harmless before then and keeps Task 2 independently compilable. Do not contribute a default keybinding.

- [ ] **Step 5: Verify command boundaries**

Update `tests/contract/dashboardBoundaries.test.js` to assert the command is contributed and registered exactly once, and update `tests/unit/tooling/extensionHostSuite.test.js` fixtures with a no-op handler.

Run:

```bash
npm run test:contract -- --test-name-pattern="Prompt|command registration|dashboard boundaries"
npm run test:unit -- --test-name-pattern="extension host"
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the terminal command**

```bash
git add package.json src/prompts/terminalCommandController.ts src/dashboard/commandRegistration.ts src/dashboard.ts tests/contract/prompts/terminalCommandController.test.js tests/contract/dashboardBoundaries.test.js tests/unit/tooling/extensionHostSuite.test.js
git commit -m "feat: insert prompts into active terminal"
```

---

### Task 3: Host-authoritative Prompt rendering and mutations

**Files:**
- Create: `src/prompts/webviewContent.ts`
- Create: `src/prompts/dashboardController.ts`
- Create: `tests/contract/prompts/dashboardController.test.js`
- Create: `tests/integration/dashboard/promptContent.test.js`

**Interfaces:**
- Consumes: the Task 1 `PromptService` mutation API.
- Produces:
  - `getAiPanelContent(snapshot: PromptPanelSnapshot): string`.
  - `getPromptSurfaceContent(snapshot: PromptPanelSnapshot): string`.
  - `PromptDashboardController.handle(value: unknown): Promise<PromptCommandResultMessage | undefined>`.
  - `PromptDashboardController.getPanelContent(requestId: string): PromptPanelContentMessage`.
  - `PromptDashboardController.getRefreshContent(): PromptPanelRefreshMessage`.

- [ ] **Step 1: Write failing Host protocol and renderer tests**

In `tests/contract/prompts/dashboardController.test.js`, use the exact envelope:

```js
function command(operation, payload, overrides = {}) {
    return {
        type: 'prompt-command',
        version: 1,
        requestId: 'prompt-request-1',
        target: 'global-prompt-library',
        expectedRevision: 0,
        operation,
        payload,
        ...overrides,
    };
}

test('WEBVIEW-AI-PROMPT-MUTATION-001 echoes the full correlation identity and authoritative HTML', async () => {
    const fixture = createController();
    const result = await fixture.controller.handle(
        command('create', { name: 'Review', text: 'Review this.' })
    );
    assert.deepEqual({
        version: result.version,
        requestId: result.requestId,
        target: result.target,
        operation: result.operation,
        success: result.success,
    }, {
        version: 1,
        requestId: 'prompt-request-1',
        target: 'global-prompt-library',
        operation: 'create',
        success: true,
    });
    assert.match(result.html, /data-prompt-id="prompt-a"/);
    assert.equal(result.snapshot.revision, 1);
});
```

Test every operation, exact payload fields, unknown fields, bounded request IDs, wrong target, unknown operation, stale revision, missing target, confirmation cancel, confirmation throw, mutation throw, renderer throw fallback, unsupported version, and exactly one result for every recognizable envelope. Assert completely unrecognizable messages return `undefined`.

In `tests/integration/dashboard/promptContent.test.js`, verify escaping of names/bodies/IDs, bounded previews, empty and read-only states, all four accessible subtabs, required labels, `aria-pressed`, drag handles, and no Prompt body in Coming Soon panels.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
npm run test-compile
node --test tests/contract/prompts/dashboardController.test.js tests/integration/dashboard/promptContent.test.js
```

Expected: FAIL because the Host controller and renderer do not exist.

- [ ] **Step 3: Implement Host-rendered AI and Prompt surfaces**

In `src/prompts/webviewContent.ts`, escape all setting-originated content and render this stable structure:

```html
<div class="ai-panel" data-ai-panel>
  <div class="ai-tablist" role="tablist" aria-label="AI configuration">
    <button role="tab" id="ai-tab-prompts" aria-controls="ai-panel-prompts">PROMPTS</button>
    <button role="tab" id="ai-tab-skills" aria-controls="ai-panel-skills">SKILLS</button>
    <button role="tab" id="ai-tab-mcp" aria-controls="ai-panel-mcp">MCP</button>
    <button role="tab" id="ai-tab-hooks" aria-controls="ai-panel-hooks">HOOKS</button>
  </div>
  <section role="tabpanel" id="ai-panel-prompts"><div data-prompt-surface></div></section>
  <section role="tabpanel" id="ai-panel-skills">Coming Soon</section>
  <section role="tabpanel" id="ai-panel-mcp">Coming Soon</section>
  <section role="tabpanel" id="ai-panel-hooks">Coming Soon</section>
</div>
```

The real output must provide roving `tabindex`, correct selected/hidden states, a New Prompt button, inline form shell, ordered list, default toggle, edit/delete buttons, one draggable handle per item, polite live region, and `data-prompt-revision`.

- [ ] **Step 4: Implement strict correlated mutation handling**

Define these message contracts:

```ts
export interface PromptCommandMessage {
    readonly type: 'prompt-command';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly expectedRevision: number;
    readonly operation: PromptMutationOperation;
    readonly payload: unknown;
}

export interface PromptCommandResultMessage {
    readonly type: 'prompt-command-result';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly operation: PromptMutationOperation;
    readonly success: boolean;
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
    readonly errorCode?: PromptMutationErrorCode;
}

export interface PromptPanelContentMessage {
    readonly type: 'ai-panel-content';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
}

export interface PromptPanelRefreshMessage {
    readonly type: 'prompt-panel-updated';
    readonly version: 1;
    readonly target: 'global-prompt-library';
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
}
```

The controller validates the top-level allowed keys and operation-specific payload keys, resolves all IDs through the current Host snapshot, asks for delete confirmation before mutation, maps all expected and unexpected failures, then re-reads and renders actual authoritative state. A renderer exception must return `success: false`, `errorCode: 'storage'`, and a constant escaped recovery panel so a recognized request still settles exactly once.

- [ ] **Step 5: Run Host tests**

Run:

```bash
npm run test:contract -- --test-name-pattern=WEBVIEW-AI-PROMPT-MUTATION-001
npm run test:integration -- --test-name-pattern="AI Prompt content"
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the Host protocol**

```bash
git add src/prompts/webviewContent.ts src/prompts/dashboardController.ts tests/contract/prompts/dashboardController.test.js tests/integration/dashboard/promptContent.test.js
git commit -m "feat: add authoritative prompt mutations"
```

---

### Task 4: Lazy AI Dashboard panel and configuration refresh

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/lifecycleController.ts`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/integration/dashboard/messageRouter.test.js`
- Modify: `tests/contract/dashboardBoundaries.test.js`

**Interfaces:**
- Consumes: `PromptDashboardController.getPanelContent()`, `getRefreshContent()`, and `handle()`.
- Produces Dashboard messages:
  - `request-ai-panel` `{ version: 1, requestId: string, target: 'global-prompt-library' }`.
  - `ai-panel-content` with correlated request identity, snapshot, and Host HTML.
  - `prompt-panel-updated` with snapshot and Host-rendered Prompt-surface HTML.

- [ ] **Step 1: Add failing AI shell and routing tests**

Extend `tests/integration/dashboard/webviewState.test.js` to assert:

```js
assert.match(html, /data-dashboard-tab="ai"/);
assert.match(html, /id="dashboard-panel-ai"/);
assert.match(html, /webviewPromptScripts\.js/);
const aiRequest = harness.messages.find(message => message.type === 'request-ai-panel');
assert.equal(aiRequest.type, 'request-ai-panel');
assert.equal(aiRequest.version, 1);
assert.equal(typeof aiRequest.requestId, 'string');
assert.ok(aiRequest.requestId.length > 0);
assert.equal(aiRequest.target, 'global-prompt-library');
```

Cover mouse and Arrow/Home/End navigation, sessionStorage restoration of `ai`, one lazy request per load, retry after timeout, group-collapse disabling while AI is active, global search leaving the catalog unchanged, and externally posted `prompt-panel-updated`.

Extend lifecycle tests in `tests/contract/dashboardBoundaries.test.js` so an external `projectSteward.promptData` change calls `refreshPrompts('configuration-changed')` without a whole Dashboard refresh, while a consumed local write echo does neither.

- [ ] **Step 2: Run the tests and confirm failure**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/webviewState.test.js tests/integration/dashboard/messageRouter.test.js tests/contract/dashboardBoundaries.test.js
```

Expected: the new `ai` tab and message routes are absent.

- [ ] **Step 3: Add the AI top-level shell and lazy loader**

In `src/webview/webviewContent.ts`, add the fourth top-level tab and empty `dashboard-panel-ai`, plus `webviewPromptScripts.js` after `webviewDashboardScripts.js`.

In `src/webview/webviewDashboardScripts.js`:

```js
function normalizeDashboardTab(value) {
    return value === 'projects' || value === 'todo' || value === 'ai' ? value : 'open';
}
```

Extend tab state with `aiState`, a fresh string request ID generator, timeout/retry handling, `ensureAiPanel()`, and a correlated `ai-panel-content` handler. Mount `window.__projectStewardPrompts` only after authoritative AI HTML is installed. Preserve the existing OPEN/PROJECTS/TODO scroll and search behavior.

- [ ] **Step 4: Wire the Prompt service and Host controller into activation**

In `src/dashboard.ts`, instantiate `PromptService` with:

```ts
const promptService = new PromptService({
    readSetting: () => getStewardConfiguration().get('promptData'),
    writeGlobalSetting: data => getStewardConfiguration()
        .update('promptData', data, vscode.ConfigurationTarget.Global),
    createId: () => randomBytes(16).toString('hex'),
    logDiagnostic: event => logDiagnostic({ event: 'prompt-store', ...event }),
});
```

Instantiate `PromptDashboardController` with VS Code delete confirmation and Host renderers. Add `request-ai-panel` and `prompt-command` router handlers; post the controller's returned result once and only once. Implement the Task 2 `openAiPrompts` intent through a Dashboard message that activates `AI > PROMPTS`.

- [ ] **Step 5: Add incremental configuration refresh**

Extend `DashboardLifecycleControllerOptions` with:

```ts
consumePromptDataWriteEcho?: () => boolean;
refreshPrompts?: (reason: string) => void;
```

Handle `projectSteward.promptData` separately from full-Dashboard configuration. A local echo returns after the mutation result has provided authoritative state; an external change calls `refreshPrompts('configuration-changed')`. In `src/dashboard.ts`, bind that callback to a fresh `prompt-panel-updated` message rendered from the current setting.

- [ ] **Step 6: Run Dashboard integration tests**

Run:

```bash
npm run test:integration -- --test-name-pattern="AI|message router|webview state"
npm run test:contract -- --test-name-pattern="Dashboard lifecycle|dashboard boundaries"
```

Expected: all selected tests pass, including existing tab regressions.

- [ ] **Step 7: Commit Dashboard integration**

```bash
git add src/webview/webviewContent.ts src/webview/webviewDashboardScripts.js src/dashboard.ts src/dashboard/lifecycleController.ts tests/integration/dashboard/webviewState.test.js tests/integration/dashboard/messageRouter.test.js tests/contract/dashboardBoundaries.test.js
git commit -m "feat: add AI dashboard panel"
```

---

### Task 5: Resilient Prompt Webview interaction

**Files:**
- Create: `src/webview/webviewPromptScripts.js`
- Create: `tests/integration/dashboard/promptInteraction.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**
- Consumes the Host markup and messages from Tasks 3 and 4.
- Produces `window.__projectStewardPrompts` with `mount(root)`, `applyCommandResult(message)`, `applyRefresh(message)`, and `getState()` for deterministic tests.

- [ ] **Step 1: Write failing mutation lifecycle tests**

Build a VM/DOM harness following `tests/integration/dashboard/todoInteraction.test.js`. Assert behavior IDs `WEBVIEW-AI-PROMPT-INTERACTION-001` and `WEBVIEW-AI-PROMPT-MUTATION-001` for:

```js
test('WEBVIEW-AI-PROMPT-MUTATION-001 keeps pending until matching authoritative HTML is applied', () => {
    const harness = createPromptHarness();
    harness.controller.dispatch('create', { name: 'Review', text: 'Review this.' });
    const pending = harness.controller.getState().pending;
    assert.equal(pending.size, 1);
    assert.equal(harness.root.innerHTML, harness.initialHtml);

    const request = harness.messages[0];
    harness.controller.applyCommandResult({
        type: 'prompt-command-result',
        version: 1,
        requestId: request.requestId,
        target: request.target,
        operation: request.operation,
        success: true,
        snapshot: snapshotAt(1),
        html: '<div data-prompt-surface data-prompt-revision="1">saved</div>',
    });

    assert.match(harness.root.innerHTML, />saved</);
    assert.equal(harness.controller.getState().pending.size, 0);
});
```

Also cover create/edit form validation, default set/replace/clear, delete, exact reorder, one dispatch per action, locks for affected controls, failure draft retention, conflict lockout until reopen, stale/duplicate/out-of-order/wrong-target settlements, unrelated pending preservation, external refresh during pending, semantic focus restoration, scroll restoration, AI subtab ARIA keyboard navigation, and polite announcements.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/promptInteraction.test.js
```

Expected: FAIL because `webviewPromptScripts.js` is absent.

- [ ] **Step 3: Implement local transient state and correlated dispatch**

Create `src/webview/webviewPromptScripts.js` as an IIFE following the existing Webview module pattern. Use:

```js
var state = {
    snapshot: null,
    pending: new Map(),
    settled: new Set(),
    draft: null,
    blockedDraft: false,
    activeSubtab: 'prompts',
};

function correlationKey(message) {
    return [
        message.version,
        message.requestId,
        message.target,
        message.operation,
    ].join(':');
}
```

Generate a fresh ID from `crypto.randomUUID()` when available and a time/random fallback otherwise. Dispatch `{ type, version, requestId, target, expectedRevision, operation, payload }`, store the exact pending identity and local draft/focus data, and lock the mutation surface without changing the authoritative list/default/order. Permit at most one in-flight Prompt mutation; rapid later input is ignored with an accessible pending announcement instead of overwriting the request identity. Keep at most 100 settled correlation keys so duplicate detection remains bounded.

- [ ] **Step 4: Implement authoritative replacement and recovery**

`applyCommandResult` must:

1. Validate type, version, target, operation, request ID, snapshot, and HTML.
2. Find the exact pending key and reject settled, duplicate, wrong-target, stale-revision, or unrelated results.
3. Capture semantic focus (`data-prompt-id` plus action), Prompt-list scroll, current draft, and subtab.
4. Replace only `[data-prompt-surface]` with Host HTML.
5. Validate that the installed surface revision equals `snapshot.revision`.
6. On success, clear matching pending only after steps 4–5; on failure, clear only the matching pending and restore its draft.
7. Restore scroll and focus only if the semantic target still exists.
8. Announce a bounded success or mapped error through the polite live region.

`applyRefresh` may install a snapshot whose revision is not older than the current authoritative revision, but it must not settle any mutation. If a mutation is pending, retain only the newest refresh and apply it after that request settles; this prevents an unrelated external replacement from making the correlated result stale and leaving the UI pending. Keep popup, draft, focus, and scroll data entirely local.

- [ ] **Step 5: Implement forms, default toggle, deletion, and drag reorder**

Use event delegation on the Prompt root. New/Edit submit exact plain strings; client validation catches blank fields for immediate field feedback, while Host validation remains authoritative. Default buttons post the clicked ID, with the Host deciding set/replace/clear. Delete posts only the ID and lets the Host confirmation settle cancellation. Drop posts every current `data-prompt-id` exactly once in DOM order; keyboard users retain separate Edit/Delete/default controls and drag starts only from the handle.

- [ ] **Step 6: Run interaction and regression tests**

Run:

```bash
npm run test:integration -- --test-name-pattern="Prompt|webview state"
npm run test:dashboard
```

Expected: Prompt interaction tests and existing Dashboard script checks pass.

- [ ] **Step 7: Commit Webview behavior**

```bash
git add src/webview/webviewPromptScripts.js tests/integration/dashboard/promptInteraction.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "feat: manage prompts in AI dashboard"
```

---

### Task 6: Responsive visuals, generated assets, and release packaging

**Files:**
- Create: `tests/browser/promptLayout.test.js`
- Modify: `media/styles.scss`
- Modify generated: `media/styles.css`
- Create generated: `media/webviewPromptScripts.js`
- Modify: `.vscodeignore`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `scripts/run-performance-architecture-baseline-checks.js`
- Modify: `tests/integration/dashboard/styles.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**
- Consumes Task 3 markup and Task 5 script selectors.
- Produces source/generated asset parity and VSIX inclusion for `webviewPromptScripts.js`.

- [ ] **Step 1: Write failing layout and asset-parity tests**

In `tests/browser/promptLayout.test.js`, mount the AI Prompt HTML and scripts in the repository's existing browser harness. At widths 240, 320, and 600 px, assert no horizontal overflow, visible New/Edit/Delete/default controls, wrapped preview/body text, usable textarea, and restored focused action after an authoritative replacement.

Extend `tests/integration/dashboard/styles.test.js` to require:

```js
for (const selector of [
    '.ai-subtabs',
    '.prompt-command-bar',
    '.prompt-list',
    '.prompt-item',
    '.prompt-form',
    '.prompt-live-region',
]) {
    assert.doesNotThrow(() => extractBlock(styles, selector));
}
```

Extend generated-asset tests so `src/webview/webviewPromptScripts.js` exactly equals `media/webviewPromptScripts.js`.

- [ ] **Step 2: Run tests and confirm missing styles/assets**

Run:

```bash
npm run test-compile
node --test tests/browser/promptLayout.test.js tests/integration/dashboard/styles.test.js tests/integration/dashboard/webviewState.test.js
```

Expected: FAIL for absent Prompt styles and generated asset.

- [ ] **Step 3: Add compact VS Code-native Prompt styling**

Add SCSS using existing `steward-*` primitives and VS Code variables. The AI subtab row must wrap safely, Prompt cards must use `min-width: 0`, names/previews must wrap with `overflow-wrap: anywhere`, actions must remain reachable, the textarea must resize vertically, focus-visible controls must use `--vscode-focusBorder`, high-contrast colors must come from VS Code variables, and `prefers-reduced-motion: reduce` must disable Prompt drag/transition animation.

At `max-width: 320px`, stack form actions and allow the item action group to wrap beneath its text. Do not use fixed card widths or horizontal scrolling.

- [ ] **Step 4: Generate and register assets**

Run:

```bash
npx gulp buildStyles copyWebviewAssets
```

Add `!media/webviewPromptScripts.js` to `.vscodeignore`. Extend Dashboard checks, architecture asset lists, release VSIX exact-entry lists, byte-parity checks, and ignore-rule assertions with the new generated script.

- [ ] **Step 5: Run browser, Dashboard, and packaging gates**

Run:

```bash
npm run test:browser
npm run test:dashboard
npm run test:architecture-baseline
npm run test:release-packaging
```

Expected: all gates pass and the packaged VSIX contains byte-identical `media/webviewPromptScripts.js` and compiled `media/styles.css`.

- [ ] **Step 6: Commit visuals and packaging**

```bash
git add media/styles.scss media/styles.css media/webviewPromptScripts.js .vscodeignore scripts/run-dashboard-webview-checks.js scripts/run-release-packaging-checks.js scripts/run-performance-architecture-baseline-checks.js tests/browser/promptLayout.test.js tests/integration/dashboard/styles.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "feat: polish and package AI prompts"
```

---

### Task 7: User documentation and regression coverage audit

**Files:**
- Modify: `README.md`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes all implementation commits and automated owners from Tasks 1–6.
- Produces catalogued regression contracts and an auditable main capability.

- [ ] **Step 1: Add user documentation**

Document:

- `AI > PROMPTS` creation, edit, delete, manual ordering, and zero-or-one default behavior.
- Keyboard shortcut setup for `Project Steward: Insert Prompt into Active Terminal`.
- Direct insertion with a default versus one-time QuickPick with no default.
- No automatic Enter and no automatic terminal creation.
- Global Settings Sync storage and the warning not to store secrets.
- `SKILLS`, `MCP`, and `HOOKS` as Coming Soon.

- [ ] **Step 2: Register exact automated behavior contracts**

Add these P0 automated entries to `docs/testing/behavior-contracts.json`, using the repository's existing JSON shape and allowed `domain` values:

```json
{
  "id": "PERSIST-AI-PROMPT-STORE-001",
  "domain": "persistence",
  "title": "Global Prompt data remains versioned, ordered, synchronized, and revision guarded",
  "priority": "P0",
  "status": "automated",
  "owners": ["tests/unit/prompts/service.test.js"],
  "evidence": ["src/prompts/types.ts", "src/prompts/service.ts", "package.json"]
},
{
  "id": "SESSION-AI-PROMPT-TERMINAL-INSERTION-001",
  "domain": "session",
  "title": "Prompt insertion targets the terminal captured at invocation without appending Enter",
  "priority": "P0",
  "status": "automated",
  "owners": ["tests/contract/prompts/terminalCommandController.test.js"],
  "evidence": ["src/prompts/terminalCommandController.ts", "src/dashboard/commandRegistration.ts", "package.json"]
},
{
  "id": "WEBVIEW-AI-PROMPT-INTERACTION-001",
  "domain": "webview",
  "title": "AI Prompt management remains accessible and responsive",
  "priority": "P0",
  "status": "automated",
  "owners": ["tests/integration/dashboard/promptInteraction.test.js", "tests/browser/promptLayout.test.js"],
  "evidence": ["src/prompts/webviewContent.ts", "src/webview/webviewPromptScripts.js", "media/styles.scss"]
},
{
  "id": "WEBVIEW-AI-PROMPT-MUTATION-001",
  "domain": "webview",
  "title": "Prompt mutations settle by full correlation identity after authoritative replacement",
  "priority": "P0",
  "status": "automated",
  "owners": ["tests/contract/prompts/dashboardController.test.js", "tests/integration/dashboard/promptInteraction.test.js"],
  "evidence": ["src/prompts/dashboardController.ts", "src/webview/webviewPromptScripts.js"]
}
```

Before editing, run this validation so a future catalog-schema change fails visibly instead of producing invalid documentation:

```bash
node -e "const {loadBehaviorCatalog}=require('./scripts/lib/behaviorCatalog'); const values=[...new Set(loadBehaviorCatalog('./docs/testing/behavior-contracts.json').map(item=>item.domain))]; for (const required of ['persistence','session','webview']) if (!values.includes(required)) throw new Error('missing domain '+required)"
```

Expected: exit 0 with no output.

- [ ] **Step 3: Audit implementation commits into one main capability**

Run:

```bash
git log --format='%H %s' main..HEAD
```

In `docs/testing/main-capability-coverage.json`:

- advance `audit.head` to the current implementation head before this audit commit;
- add the rebased design, protocol-hardening, and implementation-plan commits to `audit.ignoredDocumentationCommits`;
- add one `MAIN-AI-PROMPT-LIBRARY` capability;
- assign every non-documentation Task 1–6 commit exactly once to that capability;
- reference the four behavior IDs above;
- set `prGates` to `test:deterministic:run`, `test:browser:run`, and `test:dashboard:run`;
- set `scheduledJobs` to `[]` and `realEnvironmentRequired` to `false`.

Run:

```bash
npm run test:behavior-contracts
```

Expected:

```text
Behavior contract catalog checks passed.
Main capability regression coverage checks passed.
```

- [ ] **Step 4: Run the complete deterministic and release verification**

Run:

```bash
npm run test:ci:linux
```

Expected: compilation, behavior contracts, lint, unit, contract, integration, browser, safety, Dashboard, architecture, release notes, packaging, webpack, and coverage checks all exit 0.

- [ ] **Step 5: Perform the repository review/fix loop**

Use the `review-fix-commit-loop` skill. Review the complete `main..HEAD` diff against the design spec, with special attention to correlation settlement, stale results, terminal capture timing, setting scope, secret-safe diagnostics, accessibility, generated assets, and VSIX contents. Apply any findings with focused tests, rerun the affected gates, and make intentional follow-up commits.

- [ ] **Step 6: Commit documentation and the final audit**

After the review fixes are committed, refresh the capability commit list and `audit.head`, then run `npm run test:behavior-contracts` again.

```bash
git add README.md docs/testing/behavior-contracts.json docs/testing/main-capability-coverage.json
git commit -m "docs: cover AI prompt library"
```

- [ ] **Step 7: Verify the clean final state**

Run:

```bash
git status --short
npm run test:ci:linux
```

Expected: `git status --short` prints nothing and the full Linux CI command exits 0.
