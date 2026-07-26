# AI Conversation Current-Group Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse one AI Conversation viewer in the current editor group and make every viewer control communicate through the real VS Code Webview API.

**Architecture:** Keep the existing Host-owned `ConversationViewer`, strict version-1 protocol, bounded page cache, watcher, and focus restoration. Change panel placement from `ViewColumn.Beside` to `ViewColumn.Active`, and let the browser script acquire one private VS Code API with a fixture-only compatible fallback.

**Tech Stack:** TypeScript, VS Code Webview API, browser JavaScript, Node test runner, Playwright Chromium, Gulp-generated Webview assets.

## Global Constraints

- Work only in `.worktree/active-session-conversation-outline`; do not modify the protected `main` checkout or the user's `.vscode/settings.json`.
- Use the existing behavior ID `WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001`.
- No production edit is allowed before a CI-reachable assertion-only RED.
- `quality-linux` reaches `npm run test:ci:linux`, which reaches both `test:deterministic:run` and `test:browser:run`.
- Acquire the VS Code Webview API at most once per viewer document.
- Keep the acquired API private to `conversationViewerScripts.js`; conversation content must never receive it.
- Retain the exact version-1 navigation and HTTPS-link message envelopes.
- Do not change adapters, page bounds, outline expansion, styling, labels, or provider support.
- Keep `src/webview/conversationViewerScripts.js` and `media/conversationViewerScripts.js` byte-identical.
- After every implementation or automated-owner commit, advance `docs/testing/main-capability-coverage.json` in a separate audit commit before completion.

---

## File Map

- `src/aiSessions/conversation/viewer.ts` — owns the single Host Webview panel, active target generation, panel placement, reads, navigation, disposal, and rendered document.
- `src/webview/conversationViewerScripts.js` — owns viewer DOM controls, one Webview API reference, strict outgoing messages, sanitization, and page application.
- `media/conversationViewerScripts.js` — generated release copy of the browser script.
- `tests/integration/dashboard/conversationViewer.test.js` — deterministic Host panel lifecycle, placement, reuse, protocol, and disposal owner.
- `tests/browser/conversationViewer.test.js` — Chromium owner for the complete rendered document, API acquisition, buttons, links, sanitization, scroll, and focus.
- `docs/testing/main-capability-coverage.json` — assigns the implementation commit to the existing conversation capability and keeps CI audit currency.

### Task 1: Current-group viewer and production Webview controls

**Files:**
- Modify: `tests/integration/dashboard/conversationViewer.test.js`
- Modify: `tests/browser/conversationViewer.test.js`
- Modify: `src/aiSessions/conversation/viewer.ts`
- Modify: `src/webview/conversationViewerScripts.js`
- Regenerate: `media/conversationViewerScripts.js`

**Interfaces:**
- Consumes: `ConversationViewer.open(target): Promise<void>`, `vscode.ViewColumn.Active`, `acquireVsCodeApi(): { postMessage(message): void }`, and the existing version-1 viewer messages.
- Produces: one reused panel created and revealed in `ViewColumn.Active`; a private `vscodeApi` reference used by `post(message)`.

- [ ] **Step 1: Add an integration RED for active-group placement and reuse**

Extend the fake VS Code boundary and panel:

```js
const fakeVscode = {
    ViewColumn: { Active: 1, Beside: 2 },
    Uri: { parse: value => fakeUri(value) },
};

// In fakePanel:
revealColumns: [],
reveal(column) {
    panel.revealCount += 1;
    panel.revealColumns.push(column);
},
```

Add the focused owner:

```js
test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 opens and reuses one viewer in the active editor group', async () => {
    const { viewer, panel } = createViewer();

    await viewer.open(target('session-a', 'input-1'));
    await viewer.open(target('session-b', 'input-1'));

    assert.equal(panel.createCount, 1);
    assert.equal(panel.createArguments[2], fakeVscode.ViewColumn.Active);
    assert.deepEqual(panel.revealColumns, [
        fakeVscode.ViewColumn.Active,
        fakeVscode.ViewColumn.Active,
    ]);
});
```

- [ ] **Step 2: Add a browser RED using the complete Host-rendered document**

Build a Host document with `ConversationViewer`, route its two external scripts
to the production DOMPurify and viewer sources, and inject the API as VS Code
would before navigation:

```js
async function renderHostViewerDocument() {
    const ConversationViewer = loadHostConversationViewer();
    const listeners = { message: new Set(), dispose: new Set(), view: new Set() };
    const panel = {
        visible: true,
        title: '',
        webview: {
            html: '',
            cspSource: 'https://viewer.test',
            onDidReceiveMessage(listener) {
                listeners.message.add(listener);
                return { dispose: () => listeners.message.delete(listener) };
            },
            postMessage() {
                return Promise.resolve(true);
            },
            asWebviewUri(uri) {
                return fakeHostUri(
                    `https://viewer.test/${path.basename(uri.fsPath)}`
                );
            },
        },
        reveal() {},
        onDidDispose(listener) {
            listeners.dispose.add(listener);
            return { dispose: () => listeners.dispose.delete(listener) };
        },
        onDidChangeViewState(listener) {
            listeners.view.add(listener);
            return { dispose: () => listeners.view.delete(listener) };
        },
        dispose() {
            Array.from(listeners.dispose).forEach(listener => listener());
        },
    };
    const viewer = new ConversationViewer({
        createPanel: () => panel,
        readOutline: async () => ({
            provider: 'codex',
            sessionId: 'session-host-document',
            sourceRevision: 'r1',
            interactions: ['input-1', 'input-2', 'input-3'].map(id => ({
                id,
                userPreview: id,
                userGraphemeCount: id.length,
                responseState: 'complete',
            })),
            totalInteractions: 3,
            partial: false,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId: 'session-host-document',
            sourceRevision: 'r1',
            anchorInteractionId: 'input-2',
            messages: [{
                id: 'input-2:user',
                interactionId: 'input-2',
                role: 'user',
                markdown: '[safe](https://example.test/safe)',
            }],
            interactionStates: [{
                interactionId: 'input-2',
                responseState: 'complete',
            }],
            previousCursor: 'before-input-2',
            nextCursor: 'after-input-2',
            isStart: false,
            isEnd: false,
        }),
        watch: () => ({ dispose() {} }),
        restoreFocus: () => {},
        openExternal: async () => true,
        mediaUri: fileName =>
            fakeHostUri(`file:///extension/media/${fileName}`),
    });
    await viewer.open({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        interactionId: 'input-2',
        expectedRevision: 'r1',
        displayName: 'Host document',
        duplicateDisplayName: false,
    });
    return panel.webview.html;
}

async function openHostViewerDocument(t) {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
    t.after(() => page.close());
    const html = await renderHostViewerDocument();
    await page.route('https://viewer.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/purify.min.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: purifyScript,
            });
            return;
        }
        if (pathname === '/conversationViewerScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: viewerScript,
            });
            return;
        }
        if (pathname === '/conversationViewer.css') {
            await route.fulfill({ contentType: 'text/css', body: '' });
            return;
        }
        await route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.addInitScript(() => {
        window.__acquireCount = 0;
        window.__postedMessages = [];
        window.acquireVsCodeApi = () => {
            window.__acquireCount += 1;
            return {
                postMessage(message) {
                    window.__postedMessages.push(message);
                },
            };
        };
    });
    await page.goto('https://viewer.test/');
    return { page };
}
```

Add the focused owner:

```js
test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 acquires one real document API and posts every control action', async t => {
    const { page } = await openHostViewerDocument(t);

    assert.equal(await page.evaluate(() => window.__acquireCount), 1);
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Latest' }).click();
    await page.locator('a[href="https://example.test/safe"]').click();
    await page.getByRole('button', { name: 'Close' }).click();

    assert.deepEqual(await postedMessages(page), [
        { type: 'conversation-viewer-previous', version: 1 },
        { type: 'conversation-viewer-next', version: 1 },
        { type: 'conversation-viewer-latest', version: 1 },
        {
            type: 'conversation-viewer-open-link',
            version: 1,
            href: 'https://example.test/safe',
        },
        { type: 'conversation-viewer-closed', version: 1 },
    ]);
});
```

The helper must serve the unchanged Host-rendered HTML rather than reconstructing
the viewer DOM. It may replace only fake resource URI origins so Chromium can
load the two production scripts.

- [ ] **Step 3: Prove both regressions are CI-reachable RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  --test-name-pattern='WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 (opens and reuses one viewer|acquires one real document API)' \
  tests/integration/dashboard/conversationViewer.test.js \
  tests/browser/conversationViewer.test.js
```

Expected:

- The placement assertion fails because creation/reveal uses
  `ViewColumn.Beside`.
- The complete-document button assertion fails because
  `conversationViewerScripts.js` never calls `acquireVsCodeApi`.
- There are no compile, fixture, browser-launch, timeout, or unrelated
  failures.

- [ ] **Step 4: Implement active-group placement**

In `ConversationViewer.open` and `ConversationViewer.ensurePanel`, use the
active editor group:

```ts
panel.reveal(vscode.ViewColumn.Active);
```

```ts
const panel = this.options.createPanel(
    'projectSteward.aiConversation',
    'AI Conversation',
    vscode.ViewColumn.Active,
    {
        enableScripts: true,
        localResourceRoots: [this.options.mediaUri('')],
    }
);
```

Do not create another panel type or change `replaceTarget`.

- [ ] **Step 5: Acquire one private Webview API and fail closed**

Near the start of `conversationViewerScripts.js`, before listener
installation, add:

```js
var vscodeApi = null;
try {
    if (typeof acquireVsCodeApi === 'function') {
        vscodeApi = acquireVsCodeApi();
    } else if (window.vscode
        && typeof window.vscode.postMessage === 'function') {
        vscodeApi = window.vscode;
    }
} catch (_error) {
    vscodeApi = null;
}
```

Replace the current global lookup:

```js
function post(message) {
    if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
        vscodeApi.postMessage(message);
    }
}
```

Do not call `acquireVsCodeApi` from an event listener or page update.

- [ ] **Step 6: Generate the release asset and verify focused GREEN**

Run:

```bash
npx gulp copyWebviewAssets
cmp -s src/webview/conversationViewerScripts.js \
  media/conversationViewerScripts.js
npm run test-compile
node --test --test-concurrency=1 \
  tests/integration/dashboard/conversationViewer.test.js \
  tests/browser/conversationViewer.test.js
git diff --check
```

Expected:

- Integration and browser suites report zero failures.
- The complete Host document acquires exactly one API.
- All navigation, Close, and HTTPS-link messages retain their exact envelopes.
- Source/media comparison and `git diff --check` exit `0`.

- [ ] **Step 7: Run affected compatibility checks**

Run:

```bash
npm run test:conversation-performance
npm run test:safety:run
npm run test:dashboard
npm run test:behavior-contracts
```

Expected: every command exits `0`; the existing viewer behavior remains
catalog-owned by both integration and browser tests.

- [ ] **Step 8: Commit the intentional implementation**

```bash
git add \
  src/aiSessions/conversation/viewer.ts \
  src/webview/conversationViewerScripts.js \
  media/conversationViewerScripts.js \
  tests/integration/dashboard/conversationViewer.test.js \
  tests/browser/conversationViewer.test.js
git commit -m "fix: activate AI Conversation controls"
```

Record the full implementation SHA for Task 2.

### Task 2: Audit, review, full verification, and installation

**Files:**
- Modify: `docs/testing/main-capability-coverage.json`
- Verify: `artifacts/project-steward-2.1.7.vsix`

**Interfaces:**
- Consumes: Task 1 implementation SHA and existing capability `MAIN-AI-SESSION-CONVERSATION-OUTLINE`.
- Produces: current capability audit, approved branch diff, CI-green release VSIX, and verified Dev Container installation.

- [ ] **Step 1: Advance the capability audit**

Update:

```bash
implementation_sha=$(git rev-parse HEAD)
design_sha=afc02235cf89a24e3ffb0a0c89efc3d2d8dab0ec
plan_sha=$(git log -1 --format=%H -- \
  docs/superpowers/plans/2026-07-26-conversation-viewer-current-group-controls.md)
```

Set `audit.head` to the resolved `implementation_sha`. Retain every existing
`ignoredDocumentationCommits` entry and append the resolved `design_sha` and
`plan_sha`. Append the Task 1 implementation SHA exactly once to
`MAIN-AI-SESSION-CONVERSATION-OUTLINE.commits`. Retain
`WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001` and `test:ci:linux`.

Run:

```bash
npm run test:behavior-contracts
git diff --check
```

Expected: 40/40 Node behavior tests pass; catalog and main-capability checks
pass.

- [ ] **Step 2: Commit the audit separately**

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: advance Conversation viewer coverage audit"
git status -sb
```

Expected: the worktree is clean.

- [ ] **Step 3: Request a read-only implementation review**

Review the implementation-base-to-audit-HEAD diff. Require explicit checks for:

- `ViewColumn.Active` on creation and every reveal;
- exactly one reused panel;
- exactly one `acquireVsCodeApi` call per document;
- fixture fallback cannot mask the complete Host-document test;
- strict message validation, HTTPS-only links, disposal, and focus restoration;
- source/media identity and capability audit currency.

Critical and Important findings block completion. Fix them with a new
assertion-only RED, a focused implementation commit, and a separate audit
commit; then re-review.

- [ ] **Step 4: Run fresh branch-level verification**

Run:

```bash
npm run test:ci:linux
git diff --check
git status -sb
```

Expected: `test:ci:linux` exits `0`, coverage baseline passes, diff check is
clean, and the worktree has no changes.

- [ ] **Step 5: Package and install to the active VS Code Server**

Use the repository's local-install workflow when the active IPC socket is
reachable. If it is stale, discover the active Server process, commit, data
directory, extensions directory, and matching socket-independent
`code-server`; then install explicitly:

```bash
env -u VSCODE_IPC_HOOK_CLI \
  /home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server \
  --user-data-dir /home/hzcheng/.vscode-server/data \
  --extensions-dir /home/hzcheng/.vscode-server/extensions \
  --install-extension artifacts/project-steward-2.1.7.vsix \
  --force
```

Before using these concrete paths, re-prove that the active Server process
still reports commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`,
`--server-data-dir /home/hzcheng/.vscode-server`, and extension profile
`/home/hzcheng/.vscode-server/extensions/extensions.json`. If any identity
changed, stop and rediscover the matching paths instead of using this command.

Use the same entry point and explicit directories to list
`hzcheng.project-steward@2.1.7`. Compare SHA-256 for the VSIX manifest,
`dist/dashboard.js`, `media/conversationViewerScripts.js`, and the installed
copies. Report the UI-only bridge as packaged but not installed if its local
UI host is unreachable.

- [ ] **Step 6: Hand off for testing**

Report:

- implementation and audit SHAs;
- review result;
- fresh CI result;
- installed extension ID/version and active host identity;
- representative matching hashes;
- any UI-only bridge limitation;
- that **Developer: Reload Window** is required before testing.
