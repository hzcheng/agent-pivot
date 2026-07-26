# Active Session Readable Conversation Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the variable-length, text-hidden Active Session conversation markers with a six-row bounded, internally scrolling outline whose equal strokes and single-line user-input previews are always readable.

**Architecture:** Keep the existing provider adapters, normalized outline protocol, viewer, and interaction lifecycle unchanged. Construct each option from inert DOM spans, let CSS own the 14 px stroke and 28 px full-width row, and make the layout coordinator measure the rail's capped rendered height instead of its unbounded `scrollHeight`.

**Tech Stack:** Browser JavaScript, TypeScript-generated Webview markup, SCSS and generated minified CSS, Node.js `node:test`, Playwright Chromium.

## Global Constraints

- Keep `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001` as the existing P0 behavior owner.
- CI reachability is `.github/workflows/verify.yml` `quality-linux` → `npm run test:ci:linux` → `npm run test:browser:run` for `tests/browser/**/*.test.js` and `npm run test:deterministic:run` for `tests/integration/**/*.test.js`.
- Show at most six 28 px rows, for a normal maximum rail height of exactly 168 px.
- Use one equal 14 px decorative stroke for every entry; user grapheme count must not affect geometry.
- Render the bounded 160-grapheme preview as inert `textContent`, on one line with visual ellipsis.
- Preserve pointer activation, roving keyboard focus, latest/current state, initial latest reveal, live auto-follow, intentional scroll preservation, HTML replacement recovery, and viewer focus restoration.
- Do not change providers, normalized data models, Host/Webview protocol fields, viewer behavior, storage, or session lifecycle.
- Use `apply_patch` for authored file changes; regenerate `media/styles.css` and `media/webviewProjectScripts.js` with the repository build tasks.

---

### Task 1: Capture the readable-row and six-row-cap regressions

**Files:**
- Modify: `tests/browser/activeSessionConversationOutline.test.js:858`
- Modify: `tests/browser/activeSessionConversationOutline.test.js:980`
- Modify: `tests/integration/dashboard/styles.test.js:54`
- Modify: `tests/integration/dashboard/styles.test.js:438`
- Modify: `tests/integration/dashboard/webviewState.test.js:633`

**Interfaces:**
- Consumes: existing `outlineResult`, `summary`, `openConversationPage`, `postHostMessage`, and `waitForPageCondition` browser helpers.
- Produces: CI-owned assertions for `.ai-session-conversation-marker-stroke`, `.ai-session-conversation-marker-preview`, equal full-width 28 px rows, and the 168 px rail cap.

- [ ] **Step 1: Make the marker browser test demand visible, equal geometry**

Rename the focused marker test to:

```js
test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 renders safe readable equal-width rows and posts exact opaque navigation', async t => {
```

Replace the current `markers.evaluateAll` ratio assertion with:

```js
const geometry = await markers.evaluateAll(nodes => nodes.map(node => {
    const stroke = node.querySelector(
        '.ai-session-conversation-marker-stroke'
    );
    const preview = node.querySelector(
        '.ai-session-conversation-marker-preview'
    );
    const previewStyle = preview && getComputedStyle(preview);
    return {
        ratio: node.style.getPropertyValue('--ai-input-ratio'),
        fillsRail: node.offsetWidth === node.parentElement.clientWidth,
        rowHeight: node.getBoundingClientRect().height,
        strokeWidth: stroke && getComputedStyle(stroke).width,
        preview: preview && preview.textContent,
        whiteSpace: previewStyle && previewStyle.whiteSpace,
        overflow: previewStyle && previewStyle.overflow,
        textOverflow: previewStyle && previewStyle.textOverflow,
        tabIndex: node.tabIndex,
        selected: node.getAttribute('aria-selected'),
        role: node.getAttribute('role'),
    };
}));
assert.deepEqual(geometry, [
    {
        ratio: '',
        fillsRail: true,
        rowHeight: 28,
        strokeWidth: '14px',
        preview: 'First input',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        tabIndex: -1,
        selected: 'false',
        role: 'option',
    },
    {
        ratio: '',
        fillsRail: true,
        rowHeight: 28,
        strokeWidth: '14px',
        preview: hostilePreview,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        tabIndex: -1,
        selected: 'false',
        role: 'option',
    },
    {
        ratio: '',
        fillsRail: true,
        rowHeight: 28,
        strokeWidth: '14px',
        preview: 'Latest input',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        tabIndex: 0,
        selected: 'true',
        role: 'option',
    },
]);
```

Retain the assertions for `data-latest`, `data-current`, `title`,
`aria-label`, hostile style injection, keyboard navigation, exact outbound
message fields, and 160-grapheme truncation.

- [ ] **Step 2: Make the scroll browser test demand shrink-wrap and a six-row cap**

Rename the scroll test to:

```js
test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 caps the readable rail and preserves bounded scrolling', async t => {
```

Add these assertions to the existing short-outline section:

```js
const shortRailGeometry = await spaciousRow
    .locator('[data-ai-session-conversation-rail]')
    .evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    }));
assert.deepEqual(shortRailGeometry, {
    clientHeight: 84,
    scrollHeight: 84,
});
```

Before opening the constrained page, send an 18-entry outline to the spacious
page and require the stable cap:

```js
const spaciousLongOutline = Array.from({ length: 18 }, (_, index) =>
    summary(`spacious-${index}`, index + 1, `Spacious input ${index}`)
);
await postHostMessage(
    spaciousPage,
    outlineResult({ sourceRevision: 'spacious-r2', interactions: spaciousLongOutline })
);
await waitForPageCondition(spaciousPage, () => {
    const node = document.querySelector('[data-ai-session-conversation-rail]');
    return node && node.scrollHeight > node.clientHeight;
});
assert.deepEqual(
    await spaciousRow.locator('[data-ai-session-conversation-rail]')
        .evaluate(node => ({
            clientHeight: node.clientHeight,
            overflows: node.scrollHeight > node.clientHeight,
        })),
    { clientHeight: 168, overflows: true }
);
```

Retain the constrained-window, keyboard reveal, at-end auto-follow,
historical scroll, invalid-threshold, and replacement-recovery assertions.

- [ ] **Step 3: Strengthen source-level style and safe-DOM contracts**

Change `validateConversationOutlineStyles` to require the final authored SCSS:

```js
function validateConversationOutlineStyles(source) {
    const rail = extractBlock(source, '.ai-session-conversation-rail');
    for (const value of [
        '--steward-ai-session-conversation-rail-height,\n                168px',
        'overflow-x: hidden;',
        'overflow-y: auto;',
    ]) {
        assert.ok(rail.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 rail missing ${value}`);
    }
    const marker = extractBlock(source, '.ai-session-conversation-marker');
    for (const value of [
        'grid-template-columns: 14px minmax(0, 1fr);',
        'width: 100%;',
        'height: 28px;',
    ]) {
        assert.ok(marker.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 marker missing ${value}`);
    }
    assert.equal(marker.includes('--ai-input-ratio'), false,
        'WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 marker width must not encode input length');
    const preview = extractBlock(
        source,
        '.ai-session-conversation-marker-preview'
    );
    for (const value of [
        'min-width: 0;',
        'overflow: hidden;',
        'text-overflow: ellipsis;',
        'white-space: nowrap;',
    ]) {
        assert.ok(preview.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 preview missing ${value}`);
    }
    const panel = extractBlock(source, '.ai-session-conversation-panel');
    assert.ok(panel.includes('overflow: hidden;'),
        'WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 expanded content must stay inside its card');
}
```

Update the generated-controller test to require safe span construction and to
reject the removed ratio calculation:

```js
assert.match(
    projectSource,
    /previewNode\.className = 'ai-session-conversation-marker-preview'/
);
assert.match(projectSource, /previewNode\.textContent = preview/);
assert.match(
    projectSource,
    /stroke\.setAttribute\('aria-hidden', 'true'\)/
);
assert.doesNotMatch(projectSource, /--ai-input-ratio|var longest/);
```

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/styles.test.js tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 --test-name-pattern='WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001' tests/browser/activeSessionConversationOutline.test.js
```

Expected: the integration tests fail because the source still uses
`--ai-input-ratio`, has no preview span contract, and has no 168 px default;
the browser tests fail because rows are 24 px, strokes vary, text is hidden,
and a spacious long outline expands beyond 168 px.

- [ ] **Step 5: Commit the proven regression tests**

```bash
git add tests/browser/activeSessionConversationOutline.test.js \
    tests/integration/dashboard/styles.test.js \
    tests/integration/dashboard/webviewState.test.js
git commit -m "test: capture readable conversation outline regression"
```

### Task 2: Render readable rows and measure only bounded height

**Files:**
- Modify: `src/webview/webviewProjectScripts.js:634`
- Modify: `src/webview/webviewProjectScripts.js:928`
- Modify: `media/styles.scss:3394`
- Generate: `media/webviewProjectScripts.js`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: the unchanged normalized `outline.interactions[]` fields `id`, `timestamp`, `userPreview`, `responseState`, and the existing `truncateConversationPreview`.
- Produces: inert `.ai-session-conversation-marker-stroke` and `.ai-session-conversation-marker-preview` children and a layout delta based on the rail's capped rendered height.

- [ ] **Step 1: Replace ratio rendering with inert row children**

Delete the complete `longest` declaration and the per-row `ratio` declaration.
Replace `marker.textContent = preview` with:

```js
var stroke = document.createElement('span');
var previewNode = document.createElement('span');
stroke.className = 'ai-session-conversation-marker-stroke';
stroke.setAttribute('aria-hidden', 'true');
previewNode.className = 'ai-session-conversation-marker-preview';
previewNode.textContent = preview;
marker.appendChild(stroke);
marker.appendChild(previewNode);
```

Delete the complete `marker.style.setProperty('--ai-input-ratio', ...)` call.
Do not alter the label, accessible name, latest/current attributes, event
listeners, or `rail.appendChild(marker)` statements around this replacement.

- [ ] **Step 2: Give the rail and rows their final geometry**

Set the rail's default maximum and replace the marker block with these authored
SCSS rules:

```scss
.ai-session-conversation-rail {
    display: grid;
    align-content: start;
    gap: 0;
    min-height: 0;
    height: var(
        --steward-ai-session-conversation-rail-height,
        auto
    );
    max-height: var(
        --steward-ai-session-conversation-rail-height,
        168px
    );
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.ai-session-conversation-marker {
    position: relative;
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    min-height: 28px;
    padding: 0 6px 0 0;
    border: 0;
    outline: none;
    overflow: hidden;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    font: inherit;
    font-size: 11px;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;

    &:hover .ai-session-conversation-marker-stroke,
    &:focus-visible .ai-session-conversation-marker-stroke,
    &[aria-selected="true"] .ai-session-conversation-marker-stroke {
        opacity: .78;
    }

    &:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -2px;
    }

    &[data-latest] {
        color: var(--vscode-foreground);

        .ai-session-conversation-marker-stroke {
            height: 3px;
            opacity: .9;
        }
    }

    &[data-current]::after {
        content: "";
        position: absolute;
        top: 50%;
        right: 1px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--steward-ai-accent, var(--vscode-focusBorder));
        opacity: .65;
        transform: translateY(-50%);
    }
}

.ai-session-conversation-marker-stroke {
    width: 14px;
    height: 2px;
    border-radius: 999px;
    background: var(--steward-ai-accent, var(--vscode-focusBorder));
    opacity: .48;
}

.ai-session-conversation-marker-preview {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

The block above replaces the old marker block and its `::before` stroke in
full; it retains the 4 px current-state dot without allowing state changes to
move layout.

- [ ] **Step 3: Stop unbounded scroll height from entering list measurement**

After `rail` is selected, measure the capped rail box instead of its full
scrollable content:

```js
var visiblePanelContent = Array.from(panel.children).filter(child =>
    child !== conversationHeader
    && !child.hidden
    && (typeof getComputedStyle !== 'function'
        || getComputedStyle(child).display !== 'none')
);
var naturalContentHeight = visiblePanelContent.reduce((total, child) =>
    total + (child === rail
        ? child.getBoundingClientRect().height || 0
        : Math.max(
            child.scrollHeight || 0,
            child.getBoundingClientRect().height || 0
        )), 0);
var naturalRailHeight = rail && visiblePanelContent.includes(rail)
    ? rail.getBoundingClientRect().height || 0
    : 0;
```

Retain the 72 px constrained-viewport lower budget and
`Math.min(naturalRailHeight, railHeight)` custom-property assignment. With the
custom property removed before measurement, CSS supplies 84 px for three rows
and 168 px for six or more rows.

- [ ] **Step 4: Regenerate browser assets**

Run:

```bash
npx gulp buildStyles
npx gulp copyWebviewAssets
```

Expected: `media/styles.css` is the minified form of the authored SCSS and
`media/webviewProjectScripts.js` is byte-identical to its source file.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 tests/integration/dashboard/styles.test.js tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 --test-name-pattern='WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001' tests/browser/activeSessionConversationOutline.test.js
```

Expected: all selected integration and browser tests pass, including existing
navigation and scroll-preservation assertions.

- [ ] **Step 6: Commit the minimal production fix**

```bash
git add src/webview/webviewProjectScripts.js media/webviewProjectScripts.js \
    media/styles.scss media/styles.css
git commit -m "fix: render readable bounded conversation outline"
```

### Task 3: Restore audit currency and run release gates

**Files:**
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the exact Task 1 and Task 2 commit SHAs and the existing `MAIN-AI-SESSION-CONVERSATION-OUTLINE` capability.
- Produces: a current capability audit whose `head` is the production-fix commit and whose commit list includes both new implementation-evidence commits.

- [ ] **Step 1: Collect exact implementation and intervening documentation SHAs**

Run:

```bash
git log --reverse --format='%H%x09%s' 87c7cbdf3b4a9d535eb9ce8afa497256e3a13fc1..HEAD
```

Expected: the output includes the documentation verification, audit refresh,
readable-outline design, this plan, Task 1 regression-test commit, and Task 2
production-fix commit in chronological order.

- [ ] **Step 2: Update the capability audit with those exact values**

In `docs/testing/main-capability-coverage.json`:

- append the exact Task 1 and Task 2 SHAs to
  `MAIN-AI-SESSION-CONVERSATION-OUTLINE.commits`;
- set `audit.head` to the exact Task 2 SHA;
- append each genuine documentation-only SHA between the previous audit head
  and Task 1 to `audit.ignoredDocumentationCommits`;
- leave every other capability, behavior, gate, and scheduled job unchanged.

Run:

```bash
npm run test:behavior-contracts
```

Expected: 40 tests pass, followed by `Behavior contract catalog checks passed.`
and `Main capability regression coverage checks passed.`

- [ ] **Step 3: Run affected layered suites**

Run:

```bash
npm run test:integration
npm run test:browser
npm run test:dashboard
git diff --check
```

Expected: every command exits 0; generated asset checks report no source drift.

- [ ] **Step 4: Commit the refreshed audit**

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit readable conversation outline regression"
```

- [ ] **Step 5: Run the full branch release gate**

Run:

```bash
npm run test:ci:linux
git status -sb
```

Expected: Linux CI exits 0 with no test failures, and the feature worktree is
clean and ahead of `origin/main`.

- [ ] **Step 6: Review the final change set**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
    tests/browser/activeSessionConversationOutline.test.js \
    tests/integration/dashboard/styles.test.js \
    tests/integration/dashboard/webviewState.test.js \
    src/webview/webviewProjectScripts.js \
    media/styles.scss \
    docs/testing/main-capability-coverage.json
```

Verify that no provider, protocol, viewer, storage, or session-lifecycle file
changed and that the final diff matches the approved design.
