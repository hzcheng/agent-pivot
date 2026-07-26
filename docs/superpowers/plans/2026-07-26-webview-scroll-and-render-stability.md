# Webview Scroll and Render Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Active/History session lists, expanded conversation outlines, Projects lists, and TODO lists visually stable through authoritative background refreshes, without preserving stale authoritative data.

**Architecture:** Add one small Webview-local semantic scroll-anchor utility, then let each domain own its stable keys and identity validation. Reconnect the existing AI-session view-state lifecycle around workspace replacements, keep a matching conversation subscription and its last validated outline alive across DOM replacement, preserve Projects state around necessary panel replacement, and route mounted TODO snapshots through the TODO controller for one authoritative render.

**Tech Stack:** VS Code Webview JavaScript, TypeScript-rendered HTML, Playwright Chromium browser tests, Node `node:test` integration tests, Sass/CSS, Gulp-generated Webview assets, behavior-contract catalog.

## Global Constraints

- Work only in `.worktree/active-session-conversation-outline`; do not modify the primary `main` checkout.
- Follow the approved design in `docs/superpowers/specs/2026-07-26-webview-scroll-and-render-stability-design.md`.
- Write and run CI-reachable failing browser tests before each production behavior change.
- Do not add a generic DOM morph, virtual DOM, index-based identity, watcher-cadence change, Host-persisted scroll state, or Host-persisted draft.
- Keep Host HTML/snapshots authoritative. Local recovery may retain only view state whose stable identity survives in the new authoritative content.
- Use `focus({ preventScroll: true })` for automatic recovery. Keep `scrollIntoView` only for explicit user navigation.
- Use a separate intentional commit for each completed task and run the task's focused tests before committing.
- Regenerate `media/webview*.js` from `src/webview/*.js`; never hand-maintain divergent generated copies.

---

### Task 1: Establish CI-Owned RED Contracts

**Files:**

- Create: `tests/browser/dashboardRefreshStability.test.js`
- Modify: `tests/browser/activeSessionConversationOutline.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Consumes: existing `workspace-updated`, `open-workspaces-updated`,
  `projects-panel-updated`, and `todo-panel-updated` production message
  handlers.
- Produces: the exact RED behavior names and Playwright fixtures used by Tasks
  2–6; no production API.

- [ ] **Step 1: Add behavior ownership before implementation**

Add these P0 automated contracts:

```json
{
  "id": "WEBVIEW-AI-SESSION-LIST-SCROLL-001",
  "domain": "webview",
  "title": "Authoritative workspace refresh preserves semantic Active and History session positions",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/browser/activeSessionConversationOutline.test.js"
  ],
  "evidence": [
    "src/webview/webviewProjectScripts.js"
  ]
}
```

```json
{
  "id": "WEBVIEW-PROJECTS-PANEL-SCROLL-001",
  "domain": "webview",
  "title": "Required Projects panel replacement preserves semantic group-list and Dashboard positions",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/browser/dashboardRefreshStability.test.js"
  ],
  "evidence": [
    "src/webview/webviewDashboardScripts.js"
  ]
}
```

```json
{
  "id": "TODO-AUTHORITATIVE-REFRESH-STATE-001",
  "domain": "todo",
  "title": "Mounted authoritative TODO refresh renders once and preserves surviving local view state",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/browser/dashboardRefreshStability.test.js",
    "tests/integration/dashboard/todoInteraction.test.js",
    "tests/integration/dashboard/webviewState.test.js"
  ],
  "evidence": [
    "src/webview/webviewDashboardScripts.js",
    "src/webview/webviewTodoScripts.js"
  ]
}
```

Keep `ACTIVE-SESSION-CONVERSATION-RESTORE-001` as the owner of durable conversation replacement.

- [ ] **Step 2: Add Active/History list replacement RED scenarios**

Extend the production-markup Playwright fixture so it can render both active and historical sessions and can post both `workspace-updated` and `open-workspaces-updated`.

Add
`WEBVIEW-AI-SESSION-LIST-SCROLL-001 preserves semantic Active and History anchors through both workspace replacement paths`.
The fixture must render eight overflowing Active rows and eight overflowing
History rows. Select Active, place `codex:active-5` at a nonzero visible
offset, focus its primary action, insert a row above it with
`workspace-updated`, and assert the same provider/session/panel identity stays
within 1 px of its previous offset. Then select Sessions, anchor
`codex:history-5`, reorder rows above it with `open-workspaces-updated`, and
make the same offset assertion. Also assert the selected tab and exact focused
identity survive each update. Do not assert `scrollTop` alone.

- [ ] **Step 3: Convert matching conversation replacement expectations to durable-subscription RED**

Update the existing matching replacement tests under `ACTIVE-SESSION-CONVERSATION-RESTORE-001` and `ACTIVE-SESSION-CONVERSATION-RESTORE-002`:

```js
const requestsBefore = (await conversationMessages(page))
    .filter(message => message.type === 'request-ai-session-conversation-outline').length;

await postWorkspaceUpdate(page, replacementSessions);

assert.equal(
    await restored.locator('[data-interaction-id="restore-6"]').isVisible(),
    true,
    'the last validated outline must remain visible synchronously'
);
assert.equal(
    (await conversationMessages(page))
        .filter(message => message.type === 'request-ai-session-conversation-outline').length,
    requestsBefore,
    'a same-identity replacement must retain the existing subscription'
);
assert.equal(
    await restored.locator('.ai-session-conversation-loading').isVisible(),
    false
);
```

Also add
`ACTIVE-SESSION-CONVERSATION-RESTORE-001 keeps one pending envelope and its durable restore state through two replacements`.
Expand one focused row, retain request 1/generation 1, install a nonzero
interaction anchor, post two matching workspace replacements before the first
result, and assert the outbound request list still contains only the original
envelope. Deliver request 1/generation 1 and assert that interaction identity
and offset are restored instead of Loading's zero offset.

Add
`ACTIVE-SESSION-CONVERSATION-RESTORE-001 preserves history while live-end readers follow and automatic recovery leaves the outer list anchored`.
For the historical branch, anchor an interaction away from the end, replace
the workspace, publish a larger outline, and assert the same interaction and
offset survive. For the live branch, scroll to the end, replace, publish a
larger outline, and assert the rail remains at its maximum scroll position.
For both branches, assert the outer Active row remains within 1 px of its
captured list offset.

Keep the mismatch test expecting one exact newer correlated cancel and no restored expansion.

- [ ] **Step 4: Add Projects and TODO production-browser RED scenarios**

Create `tests/browser/dashboardRefreshStability.test.js` with one shared Chromium lifecycle and bounded `waitForFunction` helper. Load production CSS plus:

```js
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const dashboardScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardScripts.js'),
    'utf8'
);
const todoScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoScripts.js'),
    'utf8'
);
```

Use compiled `getProjectsPanelContent`, `getTodoPanelContent`, and
`buildTodoViewModel` to create authoritative production markup. Task 1 loads
the existing Dashboard and TODO scripts only; Task 2 adds the new scroll-state
script to this fixture when that production file exists.

Add
`WEBVIEW-PROJECTS-PANEL-SCROLL-001 preserves a project anchor, focus, and window position through required replacement and header fitting`.
Mount one overflowing production Projects group, anchor `project-e` at a
nonzero group-list offset, focus its `open` action, apply a required
`projects-panel-updated` that inserts and reorders projects above it, flush the
header-fit animation frame, and assert the same project remains within 1 px,
the exact action owns focus, and `window.scrollY` is unchanged.

Add
`TODO-AUTHORITATIVE-REFRESH-STATE-001 renders one mounted refresh and preserves surviving anchors, detail, draft, compose, focus, and window position`.
Mount six production TODO cards in a three-visible-row group. Open `todo-c`,
enter edit mode, type a unique unsaved title, open the same group's composer
and type a unique compose title, focus a named edit field, anchor `todo-e`,
and dispatch a valid `todo-panel-updated` snapshot that inserts a sibling
above the anchor. Assert the mounted `.todo-panel` node is the same object,
`onRendered` increments exactly once, and the anchor, detail, both draft
values, focus, and `window.scrollY` survive.

Add
`TODO-AUTHORITATIVE-REFRESH-STATE-001 discards local state only when its authoritative identity disappears`.
Remove the selected TODO and compose group in a valid refresh. Assert
`selectedTodoId`, detail draft, `composeGroupId`, compose draft, and removed
focus are cleared, while a second surviving group's semantic scroll anchor
stays within 1 px.

- [ ] **Step 5: Prove the tests are RED and CI-reachable**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js tests/browser/dashboardRefreshStability.test.js
node --test --test-concurrency=1 tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/webviewState.test.js
npm run test:behavior-contracts
```

Expected: the new browser behaviors fail because list scroll resets, matching conversation replacements issue another request/show Loading, Projects scroll resets, and TODO replaces/remounts twice. `test:behavior-contracts` must pass, proving every new owner is on the required catalog path.

- [ ] **Step 6: Commit the RED contracts**

```bash
git add tests/browser/activeSessionConversationOutline.test.js tests/browser/dashboardRefreshStability.test.js docs/testing/behavior-contracts.json
git commit -m "test: cover webview refresh stability"
```

---

### Task 2: Add the Shared Semantic Scroll-Anchor Utility

**Files:**

- Create: `src/webview/webviewScrollStateScripts.js`
- Create through generation: `media/webviewScrollStateScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `.vscodeignore`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-performance-architecture-baseline-checks.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Test: `tests/browser/dashboardRefreshStability.test.js`

**Interfaces:**

- Consumes: a real scroll container, a descendant item selector, and a
  domain-owned `getKey(Element): string`.
- Produces:
  `window.__projectStewardScrollState.capture(container, options): ScrollAnchor | null`
  and
  `window.__projectStewardScrollState.restore(container, anchor, options): boolean`,
  where `ScrollAnchor` is
  `{ scrollTop: number, itemKey: string | null, itemOffset: number, atEnd: boolean }`.

- [ ] **Step 1: Implement the narrow utility API**

Expose only this Webview-local namespace:

```js
(function () {
    'use strict';

    function capture(container, options) {
        if (!container || !options || typeof options.getKey !== 'function') return null;
        var selector = options.itemSelector;
        var items = selector && container.querySelectorAll
            ? Array.from(container.querySelectorAll(selector))
            : [];
        var containerRect = container.getBoundingClientRect();
        var anchorItem = items.find(function (item) {
            var rect = item.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }) || null;
        var key = anchorItem ? options.getKey(anchorItem) : null;
        var endThreshold = Number(options.endThreshold);
        var atEnd = Number.isFinite(endThreshold)
            && endThreshold >= 0
            && container.scrollHeight - container.clientHeight - container.scrollTop <= endThreshold;
        return {
            scrollTop: Math.max(0, Number(container.scrollTop) || 0),
            itemKey: typeof key === 'string' && key ? key : null,
            itemOffset: anchorItem
                ? anchorItem.getBoundingClientRect().top - containerRect.top
                : 0,
            atEnd: atEnd,
        };
    }

    function restore(container, anchor, options) {
        if (!container || !anchor || !options || typeof options.getKey !== 'function') return false;
        if (options.followEnd && anchor.atEnd) {
            container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            return true;
        }
        var items = options.itemSelector && container.querySelectorAll
            ? Array.from(container.querySelectorAll(options.itemSelector))
            : [];
        var item = anchor.itemKey
            ? items.find(function (candidate) {
                return options.getKey(candidate) === anchor.itemKey;
            })
            : null;
        if (item) {
            var containerTop = container.getBoundingClientRect().top;
            container.scrollTop += item.getBoundingClientRect().top
                - containerTop
                - anchor.itemOffset;
            return true;
        }
        var maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.min(
            Math.max(0, Number(anchor.scrollTop) || 0),
            maxScrollTop
        );
        return true;
    }

    window.__projectStewardScrollState = Object.freeze({
        capture: capture,
        restore: restore,
    });
})();
```

Do not accept row indices or label-derived keys.

- [ ] **Step 2: Load the utility before every domain script**

In `getStewardContent`, resolve `webviewScrollStateScripts.js` and emit it before `webviewProjectScripts.js`.

Add the new generated asset to:

- `.vscodeignore` allowlist;
- release package inventory and byte-for-byte source/media parity checks;
- performance architecture Webview script inventory;
- Dashboard Webview asset assertions.

- [ ] **Step 3: Generate the media copy**

Run:

```bash
npx gulp copyWebviewAssets
cmp src/webview/webviewScrollStateScripts.js media/webviewScrollStateScripts.js
```

Expected: `cmp` exits 0.

- [ ] **Step 4: Run the focused utility/browser checks**

```bash
node --test --test-concurrency=1 tests/browser/dashboardRefreshStability.test.js
npm run test:dashboard
npm run test:architecture-baseline
npm run test:release-packaging
```

Expected: common-anchor tests pass; domain RED tests may still fail until Tasks 3–5. Packaging and architecture checks pass with the new asset.

- [ ] **Step 5: Commit**

```bash
git add src/webview/webviewScrollStateScripts.js media/webviewScrollStateScripts.js src/webview/webviewContent.ts .vscodeignore scripts/run-dashboard-webview-checks.js scripts/run-performance-architecture-baseline-checks.js scripts/run-release-packaging-checks.js
git commit -m "feat: add semantic webview scroll anchors"
```

---

### Task 3: Restore Active/History Lists Around Workspace Replacement

**Files:**

- Modify: `src/webview/webviewProjectScripts.js`
- Generate: `media/webviewProjectScripts.js`
- Modify: `tests/browser/activeSessionConversationOutline.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**

- Consumes: `window.__projectStewardScrollState` from Task 2 and the existing
  AI-session row attributes.
- Produces: semantic `activeAnchor` and `historyAnchor` fields in
  `captureAiSessionViewState(projectDiv)`, plus project-scoped capture/restore
  around both authoritative workspace replacement paths.

- [ ] **Step 1: Upgrade AI-session view state to semantic anchors**

Add domain key/capture helpers:

```js
function getAiSessionScrollItemKey(row) {
    var panel = row.closest('[data-ai-session-panel]');
    return JSON.stringify([
        panel ? panel.getAttribute('data-ai-session-panel') || '' : '',
        row.getAttribute('data-session-provider') || '',
        row.getAttribute('data-session-id') || '',
        row.getAttribute('data-pending-created-at') || '',
    ]);
}

function captureAiSessionListAnchor(list) {
    return window.__projectStewardScrollState.capture(list, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
}

function restoreAiSessionListAnchor(list, anchor) {
    return window.__projectStewardScrollState.restore(list, anchor, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
}
```

Change `captureAiSessionViewState` to retain `activeAnchor` and `historyAnchor` instead of pixel-only fields. Keep backward-compatible raw-number handling only as long as the existing integration fixture needs migration in the same commit, then update that fixture to assert semantic fallback.

Restore tab visibility before measuring each list. Restore focus with:

```js
focusTarget.focus({ preventScroll: true });
```

If the exact focused row no longer exists, do not focus the first unrelated row; fall back only to the selected tab.
Apply the same `preventScroll` option inside
`restoreAiSessionProviderMenuState`; provider-menu recovery must not move the
outer list.

- [ ] **Step 2: Capture/restore project-scoped state in both replacement paths**

Create:

```js
function captureCurrentWorkspaceAiSessionStates(root) {
    var states = new Map();
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]')
        .forEach(function (projectDiv) {
            states.set(projectDiv.getAttribute('data-id'), {
                view: captureAiSessionViewState(projectDiv),
                providerMenu: captureAiSessionProviderMenuState(projectDiv),
                conversation: captureExpandedConversationState(projectDiv),
            });
        });
    return states;
}
```

Use this snapshot before:

- `currentGroup.replaceWith(replacement)` in `applyWorkspaceUpdate`;
- `wrapper.innerHTML = message.html` in `applyOpenWorkspacesUpdate`;
- the rollback replacement in the invalid open-workspaces branch.

After authoritative HTML:

1. restore persisted tabs;
2. restore each project's selected tab and Active/History anchors;
3. restore provider menu;
4. restore/rebind conversation;
5. restore Active/History anchors once more after conversation sizing;
6. restore semantic focus with `preventScroll`.

Discard snapshots whose project ID no longer exists.

- [ ] **Step 3: Verify GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js
```

Expected: the new Active/History anchor test passes. Conversation durable-subscription tests may remain RED until Task 4; all unrelated tests pass.

- [ ] **Step 4: Generate and commit**

```bash
npx gulp copyWebviewAssets
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git add src/webview/webviewProjectScripts.js media/webviewProjectScripts.js tests/browser/activeSessionConversationOutline.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "fix: preserve AI session list position"
```

---

### Task 4: Rebind Durable Conversation State Without Loading Flicker

**Files:**

- Modify: `src/webview/webviewProjectScripts.js`
- Generate: `media/webviewProjectScripts.js`
- Modify: `tests/browser/activeSessionConversationOutline.test.js`

**Interfaces:**

- Consumes: the project-scoped replacement snapshot from Task 3 and semantic
  anchor API from Task 2.
- Produces: `cachedOutline: ConversationOutline | null` on the live
  conversation subscription,
  `rebindActiveAiSessionConversation(row, capturedState): boolean`, and
  `applyActiveAiSessionConversationState(row, expanded, reveal): boolean`.

- [ ] **Step 1: Retain the last validated outline in the live subscription**

Initialize these fields in `requestActiveAiSessionConversation`:

```js
cachedOutline: null,
restoreState: restoreState || null,
```

On a correlated validated payload:

```js
state.cachedOutline = message.payload;
return renderActiveAiSessionConversationOutline(row, state, state.cachedOutline);
```

Do not create a second subscription envelope for a matching authoritative DOM replacement.

- [ ] **Step 2: Capture semantic conversation state**

Replace `railScrollTop`-only capture with:

```js
function getConversationMarkerKey(marker) {
    return marker.getAttribute('data-interaction-id') || '';
}

function captureConversationRailState(rail) {
    return window.__projectStewardScrollState.capture(rail, {
        itemSelector: '[data-ai-session-conversation-marker][data-interaction-id]',
        getKey: getConversationMarkerKey,
        endThreshold: getConversationAutoScrollThreshold(rail),
    });
}
```

The durable state must contain:

```js
{
    provider,
    sessionId,
    expanded: true,
    railAnchor,
    focusedInteractionId
}
```

If the current replacement DOM is Loading and the live subscription already owns a non-null restore state, do not overwrite it with an empty `scrollTop = 0` capture.

- [ ] **Step 3: Separate user reveal from automatic recovery**

Change the signature to
`applyActiveAiSessionConversationState(row, expanded, reveal)`. Preserve the
complete current collapse/measurement/observer body, but guard its existing
`row.scrollIntoView({ block: 'nearest' })` call with
`expanded && reveal && typeof row.scrollIntoView === 'function'`. Pass `true`
only from `toggleActiveAiSessionConversation`; pass `false` from replacement
recovery and Host-origin focus recovery.

- [ ] **Step 4: Rebind the matching subscription**

Implement:

```js
function rebindActiveAiSessionConversation(row, capturedState) {
    var target = getActiveAiSessionConversationTarget(row);
    var subscription = activeAiSessionConversationSubscription;
    if (!target || !subscription
        || getActiveAiSessionConversationKey(target)
            !== getActiveAiSessionConversationKey(subscription)) {
        return false;
    }
    if (!applyActiveAiSessionConversationState(row, true, false)) return false;
    subscription.expanded = true;
    if (capturedState && (!subscription.restoreState
        || subscription.cachedOutline)) {
        subscription.restoreState = capturedState;
    }
    if (subscription.cachedOutline) {
        renderActiveAiSessionConversationOutline(
            row,
            subscription,
            subscription.cachedOutline
        );
    } else {
        prepareActiveAiSessionConversationLoading(row);
        syncActiveAiSessionConversationListHeight(row);
    }
    return true;
}
```

For a mismatch or missing focused row, call the existing exact correlated cancellation once. Never rebind state to a navigation-only card or a different project/provider/session.

- [ ] **Step 5: Restore conversation anchors after each validated render**

In `renderActiveAiSessionConversationOutline`:

- capture the current semantic anchor before clearing markers;
- choose the explicit durable restore anchor first;
- otherwise follow the live end only when the captured anchor says `atEnd`;
- otherwise restore the interaction key and visible offset;
- if a focused interaction disappeared, retain position without focusing a different marker;
- focus surviving markers with `preventScroll`;
- never call automatic `scrollIntoView`.

- [ ] **Step 6: Verify GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
npm run test:conversation-performance
```

Expected: one matching subscription/request survives replacements, committed outline content never flashes Loading, pending durable state is not overwritten, historical/live-end behavior passes, mismatch cancellation remains exact, and conversation performance checks remain green.

- [ ] **Step 7: Generate and commit**

```bash
npx gulp copyWebviewAssets
git add src/webview/webviewProjectScripts.js media/webviewProjectScripts.js tests/browser/activeSessionConversationOutline.test.js
git commit -m "fix: retain conversation state across refresh"
```

---

### Task 5: Preserve Projects State Through Necessary Replacement

**Files:**

- Modify: `src/webview/webviewDashboardScripts.js`
- Generate: `media/webviewDashboardScripts.js`
- Modify: `tests/browser/dashboardRefreshStability.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**

- Consumes: `window.__projectStewardScrollState` from Task 2, production
  `.group[data-group-id]`, `.group-list`, and `.project[data-id]` markup.
- Produces: one local Projects replacement snapshot with `windowScrollY`,
  semantic focus, and per-group `ScrollAnchor` values; no public Host API.

- [ ] **Step 1: Add Projects domain keys and panel state**

Implement:

```js
function getProjectScrollItemKey(project) {
    var group = project.closest('.group[data-group-id]');
    return JSON.stringify([
        group ? group.getAttribute('data-group-id') || '' : '',
        project.getAttribute('data-id') || '',
    ]);
}

function captureProjectsPanelState() {
    return {
        windowScrollY: window.scrollY,
        focus: getProjectsFocusTarget(),
        groups: Array.from(panels.projects.querySelectorAll(
            '.group[data-group-id]'
        )).map(function (group) {
            var list = group.querySelector('.group-list');
            return {
                groupId: group.getAttribute('data-group-id') || '',
                anchor: list ? window.__projectStewardScrollState.capture(list, {
                    itemSelector: '.project[data-id]',
                    getKey: getProjectScrollItemKey,
                }) : null,
            };
        }),
    };
}
```

Restore only an exact surviving group/project identity. Update `restoreProjectsFocus` to use `focus({ preventScroll: true })`.

- [ ] **Step 2: Restore twice around mount/header fitting**

In `replaceProjectsPanelHtml`:

1. capture panel state;
2. replace HTML once;
3. run `onProjectsMounted`;
4. restore group anchors, focus, and window scroll synchronously;
5. schedule one `requestAnimationFrame`;
6. restore group anchors and window scroll again after Fitty can change header geometry.

Keep the existing `preserve-order`/consistent fast path unchanged and free of replacement.

Use a generation counter so an older animation-frame callback cannot restore stale state after a newer Projects update.

- [ ] **Step 3: Verify GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/dashboardRefreshStability.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js
```

Expected: the Projects test passes through a real required replacement and simulated header-fit frame; existing lazy-load/search/tab behavior remains green.

- [ ] **Step 4: Generate and commit**

```bash
npx gulp copyWebviewAssets
git add src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js tests/browser/dashboardRefreshStability.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "fix: stabilize Projects panel refresh"
```

---

### Task 6: Route Mounted TODO Refresh Through One Controller Render

**Files:**

- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Generate: `media/webviewTodoScripts.js`
- Generate: `media/webviewDashboardScripts.js`
- Modify: `tests/browser/dashboardRefreshStability.test.js`
- Modify: `tests/integration/dashboard/todoInteraction.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**

- Consumes: valid `TodoPanelSnapshot` values already present on
  `todo-panel-updated` messages and `window.__projectStewardScrollState` from
  Task 2.
- Produces: `todos.applyRefresh(snapshotValue): boolean` and the
  `initDashboard` callback
  `onTodoRefresh(panel, message): boolean`.

- [ ] **Step 1: Track compose draft as local controller state**

Add:

```js
composeDraft: null,
```

Use the draft in `renderCompose`, update it from compose-form `input` events, and clear it only on explicit cancel/successful submit or when its authoritative group disappears.

The shape is:

```js
{
    title: '',
    notes: '',
    priority: 'medium',
    groupId: null
}
```

Keep detail-edit `state.draft` separate from compose draft.

- [ ] **Step 2: Add TODO semantic state capture/restore**

Capture:

```js
{
    windowScrollY,
    selectedTodoId,
    draft,
    composeGroupId,
    composeDraft,
    focus: {
        todoId,
        groupId,
        action,
        formKind,
        fieldName
    },
    groups: [{ groupId, anchor }]
}
```

TODO row keys must be:

```js
function getTodoScrollItemKey(item) {
    var group = item.closest('.todo-group[data-todo-group-id]');
    return JSON.stringify([
        group ? group.getAttribute('data-todo-group-id') || '' : '',
        item.getAttribute('data-todo-id') || '',
    ]);
}
```

Restore exact surviving identities only, with `focus({ preventScroll: true })` and a clamped raw scroll fallback when an anchor item was removed.

- [ ] **Step 3: Implement one authoritative controller refresh**

Expose:

```js
function applyRefresh(snapshotValue) {
    if (!root || !isSnapshot(snapshotValue)) return false;
    var local = captureTodoRefreshState();
    state.snapshot = clone(snapshotValue);
    Array.from(state.pending.entries())
        .sort(function (left, right) { return left[0] - right[0]; })
        .forEach(function (entry) {
            optimisticMutation(entry[1].action, entry[1].payload);
        });
    reconcileTodoRefreshState(local);
    render();
    restoreTodoRefreshState(local);
    scheduleTodoRefreshStateRecheck(local);
    return true;
}
```

`reconcileTodoRefreshState` must:

- retain selected detail/draft only if the TODO still exists and is rendered in a non-collapsed surviving group;
- retain group composer/draft only if the group still exists;
- discard local state for removed identities;
- never apply a removed target's state to the next row or group.

`render()` must run once for this refresh. A generation token must prevent an older scheduled recheck from restoring stale state after a newer refresh.

Add `applyRefresh` to `window.__projectStewardTodo`.

- [ ] **Step 4: Route valid mounted updates without replacing the panel root**

Add an `onTodoRefresh` option to `initDashboard`.

In `applyTodoPanelUpdatedMessage`:

```js
var refreshed = todoState === 'mounted'
    && message.snapshot
    && typeof options.onTodoRefresh === 'function'
    && options.onTodoRefresh(panels.todo, message) === true;
if (!refreshed) {
    panels.todo.innerHTML = message.html;
    todoState = 'mounted';
    if (typeof options.onTodoMounted === 'function') {
        options.onTodoMounted(panels.todo, message);
    }
}
```

In `getStewardContent`:

```js
onTodoRefresh: (_panel, message) => todos.applyRefresh(message.snapshot),
```

Always update the validated search catalog and pending search reveal state. Preserve the current full-panel fallback for missing/malformed/unsupported snapshots.

- [ ] **Step 5: Update integration assertions**

Assert:

- a valid mounted snapshot calls `onTodoRefresh` once and not `onTodoMounted`;
- the existing `.todo-panel` node is unchanged;
- `onRendered` increments once;
- local detail/drafts/anchors/focus survive only exact identities;
- unsupported HTML-only update still uses one fallback mount;
- pending TODO search reveal continues resolving after either refresh path.

- [ ] **Step 6: Verify GREEN**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/dashboardRefreshStability.test.js tests/browser/todoLayout.test.js
node --test --test-concurrency=1 tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/webviewState.test.js
npm run test:dashboard
```

Expected: mounted TODO refresh preserves local state with one controller render and no panel replacement; removal and fallback cases pass; existing incremental TODO behavior remains green.

- [ ] **Step 7: Generate and commit**

```bash
npx gulp copyWebviewAssets
git add src/webview/webviewTodoScripts.js src/webview/webviewDashboardScripts.js src/webview/webviewContent.ts media/webviewTodoScripts.js media/webviewDashboardScripts.js tests/browser/dashboardRefreshStability.test.js tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "fix: stabilize authoritative TODO refresh"
```

---

### Task 7: Full Verification, Review, Package, and Local Install

**Files:**

- Verify all changed files
- Update only if required by review: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Consumes: all completed Tasks 1–6 and repository verification/package
  scripts.
- Produces: a clean, reviewed, CI-green branch and a locally installed VSIX
  for user acceptance.

- [ ] **Step 1: Regenerate all Webview assets and prove parity**

```bash
npx gulp copyWebviewAssets
cmp src/webview/webviewScrollStateScripts.js media/webviewScrollStateScripts.js
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
cmp src/webview/webviewTodoScripts.js media/webviewTodoScripts.js
```

Expected: every `cmp` exits 0.

- [ ] **Step 2: Run focused regressions**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js tests/browser/dashboardRefreshStability.test.js tests/browser/todoLayout.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js tests/integration/dashboard/todoInteraction.test.js
npm run test:behavior-contracts
npm run test:conversation-performance
npm run test:dashboard
npm run test:architecture-baseline
npm run test:architecture-guards
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the required Linux CI path**

```bash
npm run test:ci:linux
```

Expected: exit 0, including browser tests, behavior contracts, safety checks, packaging, and coverage baseline.

- [ ] **Step 4: Review the diff for scope and stale artifacts**

```bash
git diff --check main...HEAD
git status --short
git diff --stat main...HEAD
git log --oneline --decorate main..HEAD
```

Confirm:

- no generic DOM diff or watcher cadence changes;
- no local state is persisted to Host or VS Code state;
- no index/label-based anchors;
- no automatic recovery `scrollIntoView`;
- source/media pairs match;
- no unrelated user files are included.

- [ ] **Step 5: Perform the repository review/fix loop**

Use the `requesting-code-review`, `receiving-code-review`, and `review-fix-commit-loop` skills. Resolve actionable P0/P1 findings with new tests and intentional follow-up commits, then rerun the focused and CI verification appropriate to each change.

- [ ] **Step 6: Package and install for user acceptance**

Use `installing-vscode-extensions-locally` and run the repository's local install flow:

```bash
npm run install-local
```

Report the installed extension version/VSIX path and ask the user to verify:

1. a working session no longer sends Active/History lists to the top;
2. expanded conversation content does not flash Loading during background refresh;
3. historical conversation position remains stable while the live end follows;
4. Projects group scroll remains stable during project updates;
5. TODO detail/drafts/group scroll remain stable during cross-window or configuration refresh.

- [ ] **Step 7: Final completion commit if generation/review changed files**

```bash
git add -A
git commit -m "chore: finalize webview refresh stability"
```

Skip this commit when the worktree is already clean; never create an empty commit.

---

## Plan Self-Review Checklist

- Every approved design surface is mapped: Active list, History list, conversation, Projects, TODO.
- Every new user-visible behavior has a production-markup browser owner on `test:browser:run`, which is included in `test:ci:linux`.
- Matching conversation replacement retains the existing Host correlation envelope; mismatch still cancels exactly.
- Semantic anchors use domain IDs and visible offsets, with raw clamped fallback.
- TODO authoritative refresh uses one mounted controller render and retains the HTML fallback.
- Prompt, standalone Conversation Viewer, search results, full Webview reload, watcher cadence, and protocols remain out of scope.
- All new runtime files are included in source/media parity, packaging, architecture, and `.vscodeignore` checks.
- Every named production API is defined in this plan or already exists in the
  mapped source files.
