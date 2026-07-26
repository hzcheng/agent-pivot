# Prompt Card Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover/focus Copy action that opens a uniquely named, unsaved create draft containing an existing Prompt's exact text.

**Architecture:** Keep copying entirely inside the Prompt Webview controller. The rendered action supplies a Prompt ID; the controller resolves it from the authoritative snapshot, derives a unique name, and reuses the existing singleton create form and correlated create mutation.

**Tech Stack:** TypeScript-rendered HTML, vanilla JavaScript Webview controller, SCSS/CSS, Node test runner, Chromium browser tests, Gulp-generated Webview assets.

## Global Constraints

- Copy does not persist until the user presses Save.
- Names use `<original name> copy`, then `copy 2`, `copy 3`, and so on.
- Name collision checks are locale-independent and case-insensitive.
- Copy never inherits the source Prompt's default selection.
- All five 24px toolbar actions remain reachable at a 240px sidebar width.
- Prompt text must not enter logs or accessibility announcements.
- No Host command, persistence schema, version bump, or dependency is added.

---

### Task 1: Render the Copy action and preserve compact layout

**Files:**
- Modify: `src/webview/webviewIcons.ts`
- Modify: `src/prompts/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `media/styles.css`
- Test: `tests/integration/dashboard/promptContent.test.js`
- Test: `tests/integration/dashboard/styles.test.js`
- Test: `tests/browser/promptLayout.test.js`

**Interfaces:**
- Consumes: `PromptV1.id`, `PromptV1.name`, and the existing `.prompt-management-actions` toolbar.
- Produces: a `data-action="prompt-copy"` button with `data-prompt-id`, an accessible Copy label, and `Icons.copy`.

- [ ] **Step 1: Write failing rendering and responsive tests**

Require the toolbar action order to be:

```js
[
    'prompt-insert-terminal',
    'prompt-copy',
    'prompt-select-default',
    'prompt-edit',
    'prompt-delete',
]
```

Extend `promptContent.test.js` to require one Copy action per Prompt and the
escaped label `Copy <name>`. Extend `styles.test.js` to require `132px`
title padding while the toolbar is shown. Extend `promptLayout.test.js` to
assert all five actions are reachable and the card has no horizontal overflow
at 240, 280, 320, and 420px. Add a touch-capable Chromium context and assert
the no-hover toolbar remains visible and all five actions are reachable.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/styles.test.js \
  tests/browser/promptLayout.test.js
```

Expected: failures report the missing `prompt-copy` action and the old four-action padding.

- [ ] **Step 3: Add the icon, action, and layout reservation**

Add a code-native overlapping-sheets icon to `src/webview/webviewIcons.ts`:

```ts
export const copy = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="8" width="11" height="11" rx="1.5"></rect>
    <path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-9A1.5 1.5 0 0 0 4 6.5v9A1.5 1.5 0 0 0 5.5 17H8"></path>
</svg>
`;
```

Render Copy immediately after Insert:

```ts
<button type="button" class="prompt-copy-button steward-icon-button"
    data-action="prompt-copy" data-prompt-id="${promptId}"
    title="${escapeHtml(`Copy ${prompt.name}`)}"
    aria-label="${escapeHtml(`Copy ${prompt.name}`)}">${Icons.copy}</button>
```

Preserve the outlined icon after the shared SVG fill rule:

```scss
.prompt-copy-button svg {
    fill: none;
    stroke: currentColor;
}
```

Change both hover/focus and `@media (hover: none)` title reservations from
`108px` to `132px`, then regenerate CSS:

```bash
npx gulp --production
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command again, followed by:

```bash
git diff --check
```

Expected: all selected tests pass and no whitespace errors are reported.

- [ ] **Step 5: Commit the independently testable toolbar change**

```bash
git add \
  src/webview/webviewIcons.ts \
  src/prompts/webviewContent.ts \
  media/styles.scss media/styles.css \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/styles.test.js \
  tests/browser/promptLayout.test.js
git commit -m "feat: add Prompt card copy action"
```

### Task 2: Open a unique unsaved copy draft

**Files:**
- Modify: `src/webview/webviewPromptScripts.js`
- Modify: `media/webviewPromptScripts.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`
- Test: `tests/integration/dashboard/promptInteraction.test.js`
- Test: `tests/browser/promptLayout.test.js`

**Interfaces:**
- Consumes: `state.snapshot.prompts`, `resetOpenDraft()`, `applyDraft()`, and the existing create form.
- Produces: `nextCopyName(sourceName: string): string` and `showCopyForm(promptId: string): boolean`; no Host message is posted until the existing create form submits.

- [ ] **Step 1: Write failing copy-draft interaction tests**

Add a test that clicks `prompt-copy` for a Prompt named `Review` with exact text
`Review this diff.\nKeep details.` and asserts:

```js
assert.equal(harness.messages.length, 0);
assert.equal(createForm.hidden, false);
assert.equal(createForm.fields.name.value, 'Review copy');
assert.equal(createForm.fields.text.value, 'Review this diff.\nKeep details.');
assert.deepEqual(harness.controller.getState().draft, {
    kind: 'create',
    promptId: null,
    name: 'Review copy',
    text: 'Review this diff.\nKeep details.',
});
```

Add collision fixtures named `review COPY`, `Review copy 2`, and
`REVIEW COPY 3`; assert the proposed name is `Review copy 4`. Assert a stale
Prompt ID posts no message and announces `That Prompt is no longer available.`
Add a refresh assertion proving the copied create draft is reapplied after a
new authoritative surface is installed. Submit the copied form and assert the
outgoing message is the existing `create` operation with only `name` and
`text`, while the authoritative `selectedPromptId` remains unchanged.

- [ ] **Step 2: Run the interaction test and verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/promptInteraction.test.js \
  tests/browser/promptLayout.test.js
```

Expected: failures report that `prompt-copy` has no click behavior and no copied draft is opened.

- [ ] **Step 3: Implement unique draft creation**

Add helpers to `src/webview/webviewPromptScripts.js`:

```js
function nextCopyName(sourceName) {
    var names = new Set(state.snapshot.prompts.map(function (prompt) {
        return prompt.name.toLowerCase();
    }));
    var base = sourceName + ' copy';
    if (!names.has(base.toLowerCase())) return base;
    var suffix = 2;
    while (names.has((base + ' ' + suffix).toLowerCase())) suffix += 1;
    return base + ' ' + suffix;
}

function showCopyForm(promptId) {
    var prompt = state.snapshot && state.snapshot.prompts.find(function (candidate) {
        return candidate.id === promptId;
    });
    var surface = getSurface();
    var form = surface && surface.querySelector('[data-prompt-form="create"]');
    if (!prompt || !form) {
        announce('That Prompt is no longer available.');
        return false;
    }
    resetOpenDraft();
    state.draft = {
        kind: 'create',
        promptId: null,
        name: nextCopyName(prompt.name),
        text: prompt.text,
    };
    applyDraft(state.draft);
    var name = form.querySelector('[name="name"]');
    if (name && typeof name.focus === 'function') name.focus();
    return true;
}
```

Handle Copy before Edit in `onClick`:

```js
} else if (action === 'prompt-copy') {
    showCopyForm(promptId);
} else if (action === 'prompt-edit') {
```

Regenerate the committed Webview asset:

```bash
npx gulp --production
cmp src/webview/webviewPromptScripts.js media/webviewPromptScripts.js
```

- [ ] **Step 4: Run focused and generated-asset checks**

Run:

```bash
npm run test-compile
npx gulp --production
node --test --test-concurrency=1 \
  tests/integration/dashboard/promptContent.test.js \
  tests/integration/dashboard/promptInteraction.test.js \
  tests/integration/dashboard/styles.test.js \
  tests/browser/promptLayout.test.js
cmp src/webview/webviewPromptScripts.js media/webviewPromptScripts.js
git diff --check
```

Expected: all selected tests pass, generated scripts match, and no whitespace
errors are reported.

- [ ] **Step 5: Update behavior ownership and capability audit**

Extend the Prompt interaction behavior requirement in
`docs/testing/behavior-contracts.json` to include opening a unique unsaved copy
draft. Assign both implementation commits to `MAIN-AI-PROMPT-LIBRARY`, move
the audit head to the latest implementation commit, and list the design and
plan commits as documentation-only commits in
`docs/testing/main-capability-coverage.json`.

Run:

```bash
npm run test:behavior-contracts
```

Expected: behavior catalog and main capability coverage checks pass.

- [ ] **Step 6: Commit behavior and audit changes**

```bash
git add \
  src/webview/webviewPromptScripts.js \
  media/webviewPromptScripts.js \
  tests/integration/dashboard/promptInteraction.test.js \
  tests/browser/promptLayout.test.js \
  docs/testing/behavior-contracts.json \
  docs/testing/main-capability-coverage.json
git commit -m "feat: open copied Prompt as a new draft"
```

- [ ] **Step 7: Run branch verification**

Run:

```bash
npm run test:ci:linux
git status -sb
```

Expected: Linux CI passes and the feature worktree is clean.
