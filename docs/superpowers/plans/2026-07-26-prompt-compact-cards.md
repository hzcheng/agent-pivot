# Compact AI Prompt Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace wide Prompt management controls with compact, accessible cards and let each card insert its exact Prompt into the active terminal.

**Architecture:** Keep Prompt persistence and mutation protocols unchanged. Extend `PromptTerminalCommandController` with an exact-key, request-correlated by-ID insertion entry point; route it through the Dashboard host and acknowledge it independently in the Prompt webview. Render icon-only card actions using existing shared icons and apply Todo-style hover/focus behavior with explicit narrow, touch, forced-color, and reduced-motion fallbacks.

**Tech Stack:** TypeScript extension host, plain JavaScript VS Code webview controller, server-rendered HTML, SCSS, Node test runner, Playwright Chromium.

## Global Constraints

- Work only on `feat/prompt-compact-cards` in `.worktree/prompt-compact-cards`, based on `origin/main`.
- Preserve the existing `prompt-command` mutation protocol and command-palette default/Quick Pick behavior.
- Direct insertion sends `sendText(prompt.text, false)` and reveals only the terminal captured when the host handles the request.
- Direct insertion resolves the Prompt ID from the current host snapshot and does not carry `expectedRevision`.
- Card previews remain first-line, whitespace-normalized, HTML-escaped, and bounded to 160 source characters plus at most two rendered lines.
- At 240, 280, and 320 pixel widths, cards must not overflow and the insert action must remain visible.
- Hidden management actions must remain keyboard reachable; do not use `display: none`, `visibility: hidden`, or DOM removal.
- Do not change Prompt persistence shape, the extension version, command IDs, or Marketplace identifiers.

---

### Task 1: Host-owned direct terminal insertion

**Files:**
- Modify: `src/prompts/terminalCommandController.ts`
- Modify: `src/dashboard.ts`
- Modify: `tests/contract/prompts/terminalCommandController.test.js`
- Modify: `tests/integration/dashboard/messageRouter.test.js`

**Interfaces:**
- Consumes: `PromptService.getSnapshot()`, `getActiveTerminal()`, `isTerminalAvailable()`, and existing warning callbacks.
- Produces: `PromptTerminalCommandController.handleInsertRequest(value: unknown): Promise<PromptTerminalInsertResult | undefined>`.
- Produces request type: `{ type: 'prompt-insert-terminal'; version: 1; requestId: string; target: 'global-prompt-library'; promptId: string }`.
- Produces result type: `{ type: 'prompt-insert-terminal-result'; version: 1; requestId: string; target: 'global-prompt-library'; success: boolean; errorCode: PromptTerminalInsertErrorCode | null }`.

- [ ] **Step 1: Add failing contract tests for exact by-ID insertion**

Add tests that call `handleInsertRequest()` with a valid request and assert:

```js
assert.deepEqual(await fixture.controller.handleInsertRequest({
    type: 'prompt-insert-terminal',
    version: 1,
    requestId: 'insert-1',
    target: 'global-prompt-library',
    promptId: 'prompt-b',
}), {
    type: 'prompt-insert-terminal-result',
    version: 1,
    requestId: 'insert-1',
    target: 'global-prompt-library',
    success: true,
    errorCode: null,
});
assert.deepEqual(fixture.activeTerminal.sent, [['Run the focused tests.', false]]);
assert.equal(fixture.activeTerminal.shown, 1);
assert.equal(fixture.quickPickCalls.length, 0);
```

Also cover invalid extra/missing keys, empty or oversized IDs, duplicate
`requestId`, missing active terminal, read-only or throwing Prompt storage,
missing Prompt ID, closed terminal, and rejected `sendText`.

- [ ] **Step 2: Run the focused host test and confirm failure**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/prompts/terminalCommandController.test.js
```

Expected: FAIL because `handleInsertRequest` does not exist.

- [ ] **Step 3: Implement validation, duplicate suppression, and by-ID insertion**

Add these public protocol types and error codes:

```ts
export type PromptTerminalInsertErrorCode =
    | 'no-active-terminal'
    | 'prompt-unavailable'
    | 'prompt-not-found'
    | 'terminal-unavailable';

export interface PromptTerminalInsertResult {
    readonly type: 'prompt-insert-terminal-result';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly success: boolean;
    readonly errorCode: PromptTerminalInsertErrorCode | null;
}
```

Implement exact-key validation and claim a valid correlation key before any
terminal send. Add a private by-ID flow that:

```ts
const terminal = this.options.getActiveTerminal();
if (!terminal) return 'no-active-terminal';
const snapshot = this.options.service.getSnapshot();
if (snapshot.readOnlyReason) return 'prompt-unavailable';
const prompt = snapshot.prompts.find(candidate => candidate.id === promptId);
if (!prompt) return 'prompt-not-found';
if (!this.options.isTerminalAvailable(terminal)) return 'terminal-unavailable';
await Promise.resolve(terminal.sendText(prompt.text, false));
terminal.show?.();
return null;
```

Catch snapshot failures as `prompt-unavailable` and terminal send/show failures
as `terminal-unavailable`. Emit only safe warnings and never include Prompt
text in errors or logs.

- [ ] **Step 4: Route the request and return its acknowledgement**

Add a Dashboard handler:

```ts
'prompt-insert-terminal': async e => {
    const result = await promptTerminalCommandController.handleInsertRequest(e);
    if (result !== undefined) {
        await provider.postMessage(result);
    }
},
```

Extend `messageRouter.test.js` to prove `prompt-insert-terminal` reaches its
registered handler exactly once.

- [ ] **Step 5: Run host and router tests**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/contract/prompts/terminalCommandController.test.js \
  tests/integration/dashboard/messageRouter.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the host slice**

```bash
git add src/prompts/terminalCommandController.ts src/dashboard.ts \
  tests/contract/prompts/terminalCommandController.test.js \
  tests/integration/dashboard/messageRouter.test.js
git commit -m "feat: insert a Prompt card into the active terminal"
```

---

### Task 2: Webview request and acknowledgement lifecycle

**Files:**
- Modify: `src/webview/webviewPromptScripts.js`
- Modify: `tests/integration/dashboard/promptInteraction.test.js`

**Interfaces:**
- Consumes: the Task 1 request/result protocol.
- Produces: click action `data-action="prompt-insert-terminal"`.
- Produces: `applyInsertResult(message)` and pending insert state keyed by the exact request correlation.

- [ ] **Step 1: Add failing webview lifecycle tests**

Extend the Prompt interaction harness with an insert button and assert a click
posts:

```js
assert.deepEqual(normalizeRealmValue(harness.messages[0]), {
    type: 'prompt-insert-terminal',
    version: 1,
    requestId: harness.messages[0].requestId,
    target: 'global-prompt-library',
    promptId: 'prompt-a',
});
```

Assert the clicked insert button becomes disabled, a different card remains
enabled, malformed/unmatched/duplicate results are ignored, and the matching
result clears only that pending button. Add a mutation-overlap test proving an
insert acknowledgement cannot unlock controls held by `setMutationLock(true)`.

- [ ] **Step 2: Run the interaction test and confirm failure**

Run:

```bash
node --test --test-concurrency=1 tests/integration/dashboard/promptInteraction.test.js
```

Expected: FAIL because the insert action and result handler are absent.

- [ ] **Step 3: Implement independent insert pending state**

Add exact result validation, a bounded settled-key set, and a pending insert
map. Dispatch this message on the insert action:

```js
{
    type: 'prompt-insert-terminal',
    version: PROMPT_VERSION,
    requestId: freshRequestId(),
    target: PROMPT_TARGET,
    promptId: promptId,
}
```

Disable only the clicked insert button while pending. On a valid matching
result, clear its pending state and announce either
`Prompt inserted into the active terminal.` or a bounded safe error message.
When mutation pending state is non-empty, leave every control disabled even
after the insert result settles.

- [ ] **Step 4: Wire click and window-message handling**

Add:

```js
} else if (action === 'prompt-insert-terminal') {
    dispatchInsert(promptId, actionTarget);
}
```

Route `prompt-insert-terminal-result` to `applyInsertResult()` without passing
it through `applyCommandResult()` or authoritative HTML replacement.

- [ ] **Step 5: Run Prompt interaction tests**

Run:

```bash
node --test --test-concurrency=1 tests/integration/dashboard/promptInteraction.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the webview protocol slice**

```bash
git add src/webview/webviewPromptScripts.js \
  tests/integration/dashboard/promptInteraction.test.js
git commit -m "feat: acknowledge Prompt card terminal insertion"
```

---

### Task 3: Compact card rendering and responsive actions

**Files:**
- Modify: `src/prompts/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `tests/integration/dashboard/promptContent.test.js`
- Modify: `tests/integration/dashboard/styles.test.js`
- Modify: `tests/browser/promptLayout.test.js`

**Interfaces:**
- Consumes: `webviewIcons.drag`, `terminalLine`, `star`, `starFilled`, `edit`, and `remove`.
- Produces: compact drag handle, persistent default marker, visible terminal insert button, and floating management toolbar.

- [ ] **Step 1: Add failing markup and style contract tests**

Require icon-only buttons with `title`, `aria-label`, and exact actions:

```js
assert.match(html, /data-action="prompt-insert-terminal"[^>]*title="Insert into active terminal"/);
assert.match(html, /class="[^"]*prompt-management-actions[^"]*"/);
assert.match(html, /data-prompt-default="true"/);
assert.doesNotMatch(html, />Make default<|>Default<|>Edit<|>Delete</);
```

Add SCSS assertions for:

```scss
.prompt-management-actions { opacity: 0; pointer-events: none; }
.prompt-item:hover .prompt-management-actions,
.prompt-item:focus-within .prompt-management-actions { opacity: 1; pointer-events: auto; }
.prompt-preview { -webkit-line-clamp: 2; }
```

Also require `@media (hover: none)`, `forced-colors`, and reduced-motion rules.

- [ ] **Step 2: Run content and style tests and confirm failure**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/styles.test.js
```

Expected: FAIL on missing compact card markup and selectors.

- [ ] **Step 3: Render shared SVG icons and accessible card states**

Import `* as Icons from '../webview/webviewIcons'`. Render:

```ts
<button class="prompt-drag-handle steward-icon-button" ...>${Icons.drag}</button>
<span class="prompt-default-marker" aria-hidden="true">${Icons.starFilled}</span>
<button class="prompt-insert-button steward-icon-button"
  data-action="prompt-insert-terminal" ...>${Icons.terminalLine}</button>
<div class="prompt-management-actions">
  <button class="prompt-default-button steward-icon-button"
    aria-pressed="${selected ? 'true' : 'false'}">...</button>
  <button class="steward-icon-button" data-action="prompt-edit">...</button>
  <button class="steward-icon-button danger" data-action="prompt-delete">...</button>
</div>
```

Set `data-prompt-default="true"` only on the selected card. Preserve edit form
markup and every existing `data-prompt-id`/drag attribute.

- [ ] **Step 4: Implement compact responsive SCSS**

Use a single-row grid with compact left/right columns, a two-line preview
clamp, and an absolutely positioned menu-background management toolbar.
Keep the drag handle at low opacity and the insert action visible. Replace the
old `max-width: 320px` action-wrap rule so widths down to 240 pixels stay in
one row. Add hover-less visibility, forced-color borders, and reduced-motion
transition removal.

- [ ] **Step 5: Update browser assertions for 240–420 pixel widths**

Replace tests that expect names/previews and actions to wrap into tall blocks.
At `[240, 280, 320, 420]`, assert:

```js
assert.ok(card.width <= width);
assert.ok(insert.right <= width && insert.left >= 0);
assert.ok(preview.height <= preview.lineHeight * 2.1);
assert.equal(await page.locator('.prompt-management-actions').evaluate(
    element => getComputedStyle(element).opacity
), '0');
```

Then hover and keyboard-focus the card and assert the management toolbar is
visible and every action remains reachable.

- [ ] **Step 6: Run focused content, style, and browser tests**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/styles.test.js
node --test --test-concurrency=1 tests/browser/promptLayout.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the visual slice**

```bash
git add src/prompts/webviewContent.ts media/styles.scss \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/styles.test.js \
  tests/browser/promptLayout.test.js
git commit -m "feat: compact the AI Prompt card layout"
```

---

### Task 4: Generated assets, behavior catalog, and full verification

**Files:**
- Modify: `media/webviewPromptScripts.js`
- Modify: `media/styles.css`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: all Task 1–3 production commits and tests.
- Produces: byte-identical generated webview JavaScript, compiled CSS, current capability audit, and a fully verified branch.

- [ ] **Step 1: Generate checked-in webview assets**

Run the repository production asset build:

```bash
npm run vscode:prepublish
```

Verify:

```bash
cmp src/webview/webviewPromptScripts.js media/webviewPromptScripts.js
git diff --check
```

Expected: `cmp` and `git diff --check` exit 0.

- [ ] **Step 2: Update behavior evidence**

Extend `SESSION-AI-PROMPT-TERMINAL-INSERTION-001` to describe both command and
explicit card-ID insertion, and add `src/dashboard.ts` plus
`tests/integration/dashboard/messageRouter.test.js` as evidence/owners where
appropriate. Keep `WEBVIEW-AI-PROMPT-INTERACTION-001` as the card layout and
pending-ack contract.

- [ ] **Step 3: Commit generated assets and behavior catalog**

```bash
git add media/webviewPromptScripts.js media/styles.css \
  docs/testing/behavior-contracts.json
git commit -m "test: cover compact Prompt card insertion"
```

- [ ] **Step 4: Audit feature commits under the existing main capability**

Add the Task 1–3 and behavior-catalog commit SHAs to
`MAIN-AI-PROMPT-LIBRARY`, set `audit.head` to the newest audited commit, and
record the two design-only commits in `ignoredDocumentationCommits`.

Run:

```bash
npm run test:behavior-contracts
```

Expected: behavior catalog and main-capability audit PASS.

- [ ] **Step 5: Commit the capability audit**

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit compact Prompt card behavior"
```

- [ ] **Step 6: Run fresh full verification**

Run:

```bash
npm run test:ci:linux
npm run test:ci:windows
npm run test:tmux:smoke
git diff --check origin/main...HEAD
git status -sb
```

Expected: every suite exits 0, diff check is clean, and only intentional
committed branch changes remain.
