# AI Conversation User Prompt Emphasis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make User inputs the dominant full-width Prompt blocks in AI Conversation while rendering Assistant output as quieter full-width reading content.

**Architecture:** Keep the existing semantic message articles and role classes unchanged. Load the production Viewer stylesheet in one focused Chromium contract, drive the visual change entirely through role-specific CSS, and assign the new behavior to the existing conversation-outline main capability.

**Tech Stack:** TypeScript Host renderer, CSS with VS Code theme variables, Node.js `node:test`, Playwright Chromium, JSON behavior contracts.

## Global Constraints

- User prompts remain full width; no chat bubbles and no right alignment.
- Conversation data, Webview protocol, Markdown rendering, and provider adapters do not change.
- No new setting or configurable color is introduced.
- User emphasis uses structure as well as color: perimeter border, four-pixel accent edge, filled surface, and `USER` pill.
- Assistant messages use an open surface, no accent edge, and a bottom separator.
- Dark, light, and forced-color themes retain readable structural distinction.
- Navigation, focus, selection, refresh, sanitization, and scroll behavior remain unchanged.
- The Active Session outline card is out of scope.
- Do not change the extension version, create a tag, or publish a release.

---

### Task 1: Protect the User-versus-Assistant visual hierarchy

**Files:**
- Modify: `tests/browser/conversationViewer.test.js`
- Modify: `media/conversationViewer.css`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: production Host markup from `ConversationViewer.renderDocument()` and `renderMessages()`, including `.conversation-message-user`, `.conversation-message-assistant`, `.conversation-role`, `.conversation-markdown`, `.conversation-selected-interaction`, and `.conversation-message:focus`.
- Produces: automated behavior `CONVERSATION-VIEWER-USER-EMPHASIS-001`, owned by `tests/browser/conversationViewer.test.js` and implemented by `media/conversationViewer.css`.

- [ ] **Step 1: Load the production Viewer stylesheet only for tests that request it**

Add the production CSS and a deterministic VS Code theme fixture beside the
existing `viewerScript` fixture in
`tests/browser/conversationViewer.test.js`:

```js
const viewerCss = fs.readFileSync(
    path.join(__dirname, '../../media/conversationViewer.css'),
    'utf8'
);
const viewerThemeFixtureCss = `
    :root {
        --vscode-editor-foreground: #d4d4d4;
        --vscode-editor-background: #1e1e1e;
        --vscode-font-family: sans-serif;
        --vscode-font-size: 13px;
        --vscode-panel-border: #454545;
        --vscode-button-background: #0e639c;
        --vscode-button-foreground: #ffffff;
        --vscode-button-border: transparent;
        --vscode-input-background: #252b35;
        --vscode-input-border: #405677;
        --vscode-descriptionForeground: #a0a0a0;
        --vscode-focusBorder: #007fd4;
        --vscode-textCodeBlock-background: #181818;
        --vscode-editor-font-family: monospace;
        --vscode-textLink-foreground: #3794ff;
    }
`;
```

Change only the `/conversationViewer.css` route inside
`openHostViewerDocument()` so existing browser tests remain unstyled unless
they opt in:

```js
if (pathname === '/conversationViewer.css') {
    await route.fulfill({
        contentType: 'text/css',
        body: options?.includeStyles
            ? `${viewerThemeFixtureCss}\n${viewerCss}`
            : '',
    });
    return;
}
```

- [ ] **Step 2: Add the failing browser behavior**

Add this test after the existing real-document navigation-control tests:

```js
test('CONVERSATION-VIEWER-USER-EMPHASIS-001 makes User a full-width Prompt block and keeps Assistant quiet', async t => {
    const interactionId = 'input-emphasis';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        interactionIds: [interactionId],
        interactionId,
        pageOverrides: {
            messages: [{
                id: `${interactionId}:user`,
                interactionId,
                role: 'user',
                markdown: 'Diagnose the loading failure.',
            }, {
                id: `${interactionId}:assistant`,
                interactionId,
                role: 'assistant',
                markdown: 'I will inspect the refresh lifecycle.',
            }],
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const user = page.locator('.conversation-message-user');
    const assistant = page.locator('.conversation-message-assistant');
    const styles = await user.evaluate((element) => {
        const assistantElement = document.querySelector(
            '.conversation-message-assistant'
        );
        const role = element.querySelector('.conversation-role');
        const userStyle = getComputedStyle(element);
        const assistantStyle = getComputedStyle(assistantElement);
        const roleStyle = getComputedStyle(role);
        return {
            userBackground: userStyle.backgroundColor,
            userBorderTop: Number.parseFloat(userStyle.borderTopWidth),
            userBorderLeft: Number.parseFloat(userStyle.borderLeftWidth),
            userRadius: Number.parseFloat(userStyle.borderTopLeftRadius),
            userRoleDisplay: roleStyle.display,
            userRoleBackground: roleStyle.backgroundColor,
            userRoleRadius: Number.parseFloat(roleStyle.borderTopLeftRadius),
            assistantBackground: assistantStyle.backgroundColor,
            assistantBorderLeft: Number.parseFloat(
                assistantStyle.borderLeftWidth
            ),
            assistantBorderBottom: Number.parseFloat(
                assistantStyle.borderBottomWidth
            ),
            userWidth: Math.round(element.getBoundingClientRect().width),
            assistantWidth: Math.round(
                assistantElement.getBoundingClientRect().width
            ),
        };
    });

    assert.notEqual(
        styles.userBackground,
        'rgba(0, 0, 0, 0)',
        'User prompt must have its own filled surface'
    );
    assert.equal(styles.userBorderTop, 1);
    assert.equal(styles.userBorderLeft, 4);
    assert.ok(styles.userRadius >= 4);
    assert.equal(styles.userRoleDisplay, 'inline-flex');
    assert.notEqual(styles.userRoleBackground, 'rgba(0, 0, 0, 0)');
    assert.ok(styles.userRoleRadius >= 100);
    assert.equal(styles.assistantBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(styles.assistantBorderLeft, 0);
    assert.equal(styles.assistantBorderBottom, 1);
    assert.equal(styles.userWidth, styles.assistantWidth);

    await user.evaluate(element => {
        element.classList.add('conversation-selected-interaction');
        element.tabIndex = -1;
        element.focus();
    });
    const indicators = await user.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            boxShadow: style.boxShadow,
            outlineWidth: Number.parseFloat(style.outlineWidth),
        };
    });
    assert.notEqual(indicators.boxShadow, 'none');
    assert.equal(indicators.outlineWidth, 1);

    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(
        await user.evaluate(element =>
            Number.parseFloat(getComputedStyle(element).borderLeftWidth)
        ),
        4
    );
    assert.equal(
        await assistant.evaluate(element =>
            Number.parseFloat(getComputedStyle(element).borderBottomWidth)
        ),
        1
    );
});
```

- [ ] **Step 3: Register the new behavior contract**

Insert this entry next to the existing conversation-viewer behavior in
`docs/testing/behavior-contracts.json`:

```json
{
  "id": "CONVERSATION-VIEWER-USER-EMPHASIS-001",
  "domain": "webview",
  "title": "AI Conversation presents User prompts as dominant full-width blocks",
  "priority": "P1",
  "status": "automated",
  "owners": [
    "tests/browser/conversationViewer.test.js"
  ],
  "evidence": [
    "media/conversationViewer.css",
    "src/aiSessions/conversation/viewer.ts"
  ]
}
```

- [ ] **Step 4: Compile and run the focused test to verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 \
  --test-name-pattern='CONVERSATION-VIEWER-USER-EMPHASIS-001' \
  tests/browser/conversationViewer.test.js
```

Expected: FAIL at `User prompt must have its own filled surface`, or at the
next role-hierarchy assertion, because the current User and Assistant both use
the generic quote-card presentation.

- [ ] **Step 5: Replace the generic message-card styling with role-specific styling**

In `media/conversationViewer.css`, keep the shared margin and focus/selection
rules, then define the two roles with these exact declarations. Preserve the
file's existing minified style when applying the change.

```css
.conversation-message{margin:.75rem 0}
.conversation-message:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.conversation-selected-interaction{box-shadow:0 0 0 1px var(--vscode-focusBorder)}
.conversation-message-user{margin:1rem 0 1.25rem;padding:.875rem 1rem 1rem;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-left:4px solid var(--vscode-button-background);border-radius:4px;background:var(--vscode-input-background,var(--vscode-textBlockQuote-background))}
.conversation-message-assistant{margin:.75rem 0 1rem;padding:.75rem .25rem 1rem;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent}
.conversation-role{display:block;margin-bottom:.5rem;color:var(--vscode-descriptionForeground);font-weight:600}
.conversation-message-user .conversation-role{display:inline-flex;align-items:center;min-height:1.25rem;padding:.1rem .45rem;border-radius:999px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
```

Add this forced-colors rule before `.new-response`:

```css
@media (forced-colors:active){.conversation-message-user{border-color:CanvasText;border-left-color:Highlight}.conversation-message-user .conversation-role{border:1px solid CanvasText;color:HighlightText;background:Highlight}.conversation-message-assistant{border-bottom-color:CanvasText}}
```

- [ ] **Step 6: Run the focused test to verify GREEN**

Run:

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='CONVERSATION-VIEWER-USER-EMPHASIS-001' \
  tests/browser/conversationViewer.test.js
```

Expected: PASS with one matching test and all non-matching tests skipped.

- [ ] **Step 7: Run the complete Viewer browser file and behavior catalog**

Run:

```bash
node --test --test-concurrency=1 tests/browser/conversationViewer.test.js
npm run test:behavior-contracts
git diff --check
```

Expected: all Viewer browser tests pass, all behavior-catalog checks pass, and
`git diff --check` produces no output.

- [ ] **Step 8: Review and commit the independently testable visual behavior**

Inspect:

```bash
git status -sb
git diff --stat
git diff -- \
  media/conversationViewer.css \
  tests/browser/conversationViewer.test.js \
  docs/testing/behavior-contracts.json
```

Critical/Important findings block the commit. When the diff is limited to the
three intended files:

```bash
git add \
  media/conversationViewer.css \
  tests/browser/conversationViewer.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: emphasize User prompts in AI Conversation"
```

---

### Task 2: Assign capability ownership and verify the complete branch

**Files:**
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Consumes: the implementation commit from Task 1 and behavior `CONVERSATION-VIEWER-USER-EMPHASIS-001`.
- Produces: an auditable assignment under `MAIN-AI-SESSION-CONVERSATION-OUTLINE`, with `test:ci:linux` as its reachable PR gate.

- [ ] **Step 1: Capture the exact implementation commit**

Run:

```bash
implementation_sha="$(git rev-parse HEAD)"
printf '%s\n' "$implementation_sha"
```

Expected: one full 40-character SHA for
`feat: emphasize User prompts in AI Conversation`.

- [ ] **Step 2: Update the main capability manifest with that exact SHA**

In `docs/testing/main-capability-coverage.json`:

1. set `audit.head` to the exact SHA printed in Step 1;
2. append that SHA to `MAIN-AI-SESSION-CONVERSATION-OUTLINE.commits`;
3. append `"CONVERSATION-VIEWER-USER-EMPHASIS-001"` to that capability's
   `behaviors`.

Do not assign the design or plan documentation commits as implementation
commits; documentation-only commits after `audit.head` are permitted by the
currency contract.

- [ ] **Step 3: Verify and commit the audit update**

Run:

```bash
npm run test:behavior-contracts
git diff --check
git diff -- docs/testing/main-capability-coverage.json
```

Expected: 40 catalog/tooling tests pass, behavior and capability checks pass,
and the diff contains only the exact audit head, commit assignment, and
behavior assignment.

Commit:

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit conversation User emphasis"
```

- [ ] **Step 4: Perform final merge-base review**

Run:

```bash
git status -sb
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Review replacement lifecycle, full-width geometry, focus/selection indicators,
theme-token fallbacks, forced-colors structure, and the absence of protocol or
Host-markup changes. Critical/Important findings must be fixed with a focused
test before continuing.

- [ ] **Step 5: Run fresh branch-level verification**

Run:

```bash
npm run test:ci:linux
```

Expected: exit code 0; compilation, branding, behavior contracts, lint,
deterministic tests, remote conversation-source tests, conversation
performance, browser tests, safety checks, Dashboard checks, architecture
guards, release packaging, and coverage baselines all pass.

- [ ] **Step 6: Confirm the repository state**

Run:

```bash
git status -sb
git log --oneline -3
```

Expected: a clean `design/conversation-user-emphasis` worktree with the design
commit, plan commit, implementation commit, and audit commit ahead of
`origin/main`.

---

### Task 3: Package and install the test build

**Files:**
- Generated, ignored artifact: `artifacts/agent-pivot-1.0.0.vsix`
- Generated, ignored artifact: `artifacts/agent-pivot-attention-ui-bridge-1.0.0.vsix`

**Interfaces:**
- Consumes: the fully verified branch from Task 2.
- Produces: a byte-verified local installation of `hzcheng.agent-pivot@1.0.0` for user acceptance testing. The UI Bridge remains unchanged.

- [ ] **Step 1: Apply the repository local-installation procedure**

Read and follow
`.codex/skills/installing-vscode-extensions-locally/SKILL.md`. Discover the
active VS Code host, validate or classify `VSCODE_IPC_HOOK_CLI`, and identify
the active Server commit, server-data directory, extension directory, and
socket-independent extension-management entry point. Do not select the first
`code` binary on `PATH`.

- [ ] **Step 2: Package the current source state**

Run:

```bash
npm run package:release
```

Expected:

```text
artifacts/agent-pivot-1.0.0.vsix
artifacts/agent-pivot-attention-ui-bridge-1.0.0.vsix
```

The UI Bridge is packaged by the repository release script but must not be
reinstalled because this change affects only the workspace extension's Viewer
CSS.

- [ ] **Step 3: Install only the main VSIX into the discovered workspace host**

Use the exact socket-independent entry point, server-data directory, extension
directory, and absolute VSIX path discovered in Step 1. Force-install
`artifacts/agent-pivot-1.0.0.vsix`, then list extensions with the same entry
point and directory.

Expected: `hzcheng.agent-pivot@1.0.0` is listed in the active workspace host.

- [ ] **Step 4: Verify installed bytes**

Compare the packaged and installed `dist/dashboard.js` and
`media/conversationViewer.css` with SHA-256. Normalize the installed
`package.json` only by removing VS Code's generated `__metadata`, then compare
its semantic digest with the packaged manifest.

Expected: both executable/style file hash pairs match, and normalized manifests
are equivalent.

- [ ] **Step 5: Hand off acceptance testing**

Report the main and Bridge artifact paths, the installed extension ID/version,
host evidence, IPC classification, representative hashes, and verification
commands. Ask the user to run `Developer: Reload Window` and inspect adjacent
User and Assistant messages in AI Conversation.
