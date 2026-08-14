'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { getAiSessionsDiv } = require('../../out/webview/webviewAiSessionContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const controlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
    'utf8'
);
const todoGroupScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoGroupScripts.js'),
    'utf8'
);
const todoControlScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoControlScripts.js'),
    'utf8'
);
const projectContextMenuScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectContextMenuScripts.js'),
    'utf8'
);
const projectAiUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiUpdateScripts.js'),
    'utf8'
);
const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);

const alphaMainKey = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/main' };
const alphaLoginKey = {
    repositoryKey: '/alpha/.git',
    canonicalWorktreePath: '/alpha/.worktrees/fix-login',
};
const betaLoginKey = {
    repositoryKey: '/beta/.git',
    canonicalWorktreePath: '/beta/.worktrees/fix-login',
};

function member(overrides) {
    return {
        memberId: 'm-1',
        repositoryKey: '/alpha/.git',
        repositoryLabel: 'alpha',
        branchName: 'agent-pivot/fix-login',
        path: '/alpha/.worktrees/fix-login',
        status: 'ready',
        isPrimary: true,
        worktreeKey: alphaLoginKey,
        ...(overrides || {}),
    };
}

function groupRow(overrides) {
    return {
        kind: 'group',
        groupId: 'g-1',
        displayName: 'fix-login',
        activity: 'active',
        sessions: [],
        members: [member()],
        chips: [{ label: 'a', title: 'alpha' }],
        hasDetachedMembers: false,
        needsPrimarySelection: false,
        canCreateSession: true,
        mergeCandidateGroupIds: [],
        ...(overrides || {}),
    };
}

function liveSession(overrides) {
    return {
        key: 'codex:s-1',
        provider: 'codex',
        sessionId: 's-1',
        name: 'Login investigation',
        executionState: 'running',
        focused: false,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
        worktreeKey: alphaLoginKey,
        ...(overrides || {}),
    };
}

function surface(overrides) {
    return getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'sessions',
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
        worktrees: [],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 2,
        bareWorktreeCount: 0,
        ...(overrides || {}),
    });
}

let browser;
test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

async function openSurfacePage(html, width) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div class="project workspace-card" data-id="project-a" data-current-workspace>
            ${html}
        </div>
    </body></html>`);
    await page.addStyleTag({ content: styles });
    await page.addStyleTag({ content: `
        :root {
            --vscode-font-family: sans-serif;
            --vscode-foreground: #ddd;
            --vscode-descriptionForeground: #aaa;
            --vscode-sideBar-background: #181818;
            --vscode-panel-border: #555;
            --vscode-input-background: #222;
            --vscode-editorWarning-foreground: #cc9900;
        }
        html, body { margin: 0; }
        .project { box-sizing: border-box; padding: 4px; }
    ` });
    await page.addScriptTag({ content: viewStateScript });
    return page;
}

test('WORKTREE-GROUPS-UI-001 renders the anchor row with labeled real branches and no management menu', async t => {
    const page = await openSurfacePage(surface({
        worktreeAnchor: {
            entries: [
                { repositoryLabel: 'alpha', branch: 'main' },
                { repositoryLabel: 'beta', branch: '1.0' },
            ],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'active',
        },
        activeAiSessions: [liveSession({ worktreeKey: alphaMainKey, sessionId: 's-main' })],
    }), 320);
    t.after(() => page.close());

    const anchor = page.locator('.ai-session-worktree-anchor');
    assert.equal(await anchor.count(), 1);
    const header = anchor.locator('.ai-session-worktree-header');
    const text = await header.textContent();
    assert.ok(text.includes('Current'));
    assert.ok(!text.includes('alpha: main'),
        'branch details stay off the compact row');
    const tooltip = await header.getAttribute('data-tooltip');
    assert.deepEqual(tooltip.split('\n'), ['alpha: main', 'beta: 1.0'],
        'the hover tooltip lists one repository per line');
    assert.equal(await anchor.locator('.ai-session-worktree-more').count(), 0,
        'the anchor is not a managed worktree: no actions menu');
    const quick = anchor.locator('[data-action="create-ai-session-quick"]');
    assert.equal(await quick.count(), 1,
        'session creation stays discoverable on the anchor row');
    assert.equal(
        await anchor.locator('.codex-session-row[data-session-id="s-main"]').count(), 1,
        'main-checkout sessions collect under the anchor');
});

test('WORKTREE-GROUPS-UI-001 anchor quick-create launches a plain main-checkout session', async t => {
    const page = await openSurfacePage(surface({
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
    }), 320);
    t.after(() => page.close());

    await page.evaluate(() => {
        window.__postedMessages = [];
        window.vscode = {
            postMessage: message => window.__postedMessages.push(message),
            getState: () => undefined,
            setState: () => undefined,
        };
    });
    await page.addScriptTag({ content: controlsScript });
    await page.evaluate(() => {
        window.__controls = initProjectAiSessionControls({});
        window.__controls.onTriggerAiSessionAction(
            document.querySelector(
            '.ai-session-worktree-anchor [data-action="create-ai-session-quick"]'
            ),
            'project-a'
        );
    });
    const messages = await page.evaluate(() => window.__postedMessages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'create-ai-session-quick');
    assert.equal(messages[0].worktreeKey, undefined,
        'no worktree key: the session starts in the main checkout, like Chats +');
});

test('WORKTREE-GROUPS-UI-001 renders group rows with chips, sessions, and a member summary', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow({
            members: [
                member(),
                member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                    isPrimary: false,
                }),
            ],
            chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        })],
        activeAiSessions: [liveSession()],
    }), 320);
    t.after(() => page.close());

    const row = page.locator('.ai-session-worktree-task-group');
    assert.equal(await row.count(), 1);
    assert.deepEqual(await row.locator('.ai-session-repo-chip').allTextContents(), ['a', 'b']);
    assert.equal(await row.locator('.codex-session-row[data-session-id="s-1"]').count(), 1,
        'sessions aggregate across group members');
    const summary = await row.locator('.ai-session-worktree-member-summary').textContent();
    assert.ok(summary.includes('2 worktrees'));
    assert.ok(summary.includes('alpha, beta'));
    const quick = row.locator('[data-action="create-ai-session-quick"]');
    assert.equal(await quick.count(), 1);
    assert.equal(
        await row.getAttribute('data-worktree-path'),
        '/alpha/.worktrees/fix-login',
        'quick create targets the primary member worktree');
    assert.equal(await row.locator('[data-action="merge-worktree-groups"]').count(), 0,
        'no merge affordance without a same-slug candidate');
});

test('WORKTREE-GROUPS-UI-001 shows the merge affordance and stable discriminator when needed', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [
            groupRow({ mergeCandidateGroupIds: ['g-2'], discriminator: 'agent-pivot/fix-login' }),
            groupRow({
                groupId: 'g-2', mergeCandidateGroupIds: ['g-1'],
                discriminator: 'agent-pivot/fix-login',
                members: [member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                })],
                chips: [{ label: 'b', title: 'beta' }],
            }),
        ],
    }), 320);
    t.after(() => page.close());

    const merges = page.locator('[data-action="merge-worktree-groups"]');
    assert.equal(await merges.count(), 2);
    assert.equal(await merges.first().getAttribute('data-group-id'), 'g-1');
    const names = await page.locator('.ai-session-worktree-task-group .ai-session-worktree-title')
        .allTextContents();
    assert.deepEqual(names, ['fix-login', 'fix-login']);
    assert.equal(
        await page.locator('.ai-session-worktree-discriminator').count(), 2,
        'colliding display names carry a stable branch discriminator');
});

test('WORKTREE-GROUPS-UI-001 flags legacy-scope sessions until restart', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow()],
        activeAiSessions: [liveSession({ legacyScope: true })],
    }), 320);
    t.after(() => page.close());

    const badge = page.locator(
        '[data-ai-session-surface-panel="worktree"]'
        + ' .codex-session-row[data-session-id="s-1"] .ai-session-legacy-scope');
    assert.equal(await badge.count(), 1);
    assert.match(await badge.textContent(), /legacy scope/i);
});

test('WORKTREE-GROUPS-UI-001 stays usable at the 170px minimum sidebar width', async t => {
    const page = await openSurfacePage(surface({
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
        worktreeGroups: [groupRow({
            mergeCandidateGroupIds: ['g-2'],
            members: [
                member(),
                member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                    isPrimary: false,
                }),
            ],
            chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        })],
        activeAiSessions: [liveSession()],
    }), 170);
    t.after(() => page.close());

    await page.evaluate(() => {
        selectAiSessionSurfaceDom(document.querySelector('.project'), 'worktree');
    });
    assert.equal(await page.locator('.ai-session-worktree-anchor').count(), 1);
    assert.equal(await page.locator('.ai-session-worktree-task-group').count(), 1);
    const layout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1,
        `no horizontal overflow at 170px (document ${layout.documentWidth}px)`);
});

test('WORKTREE-GROUPS-UI-001 anchor and group sessions never duplicate into the Unmanaged section', async t => {
    const unmanagedKey = {
        repositoryKey: '/beta/.git',
        canonicalWorktreePath: '/beta/manual-topic',
    };
    const page = await openSurfacePage(surface({
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'active',
        },
        worktreeGroups: [groupRow()],
        worktrees: [{
            kind: 'ready',
            git: {
                key: unmanagedKey,
                branchRef: 'refs/heads/manual-topic',
                head: 'b'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
            activity: 'active',
            sessions: [],
            authority: { canResume: true, canRemove: true },
        }],
        activeAiSessions: [
            liveSession({ worktreeKey: alphaMainKey, sessionId: 's-main', key: 'codex:s-main' }),
            liveSession(),
            liveSession({
                worktreeKey: unmanagedKey, sessionId: 's-manual', key: 'codex:s-manual',
            }),
        ],
    }), 320);
    t.after(() => page.close());

    const panel = page.locator('[data-ai-session-surface-panel="worktree"]');
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-main"]').count(), 1);
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-1"]').count(), 1);
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-manual"]').count(), 1);
    const unmanagedSection = panel.locator('.ai-session-worktree-unmanaged');
    assert.equal(await unmanagedSection.count(), 0,
        'no session is left over for the Unmanaged section');
});

test('WORKTREE-GROUPS-UI-001 collapse state is keyed independently for anchor and groups', async t => {
    const page = await openSurfacePage(surface({
        selectedSurface: 'worktree',
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
        worktreeGroups: [groupRow({
            // A group without a ready primary has no worktree key attributes,
            // which previously collided with the anchor's empty key.
            canCreateSession: false,
            members: [{
                memberId: 'm-failed', repositoryKey: '/alpha/.git', repositoryLabel: 'alpha',
                branchName: 'agent-pivot/fix-login', path: '/alpha/.worktrees/fix-login',
                status: 'failed', isPrimary: false, errorCode: 'interrupted',
            }],
        })],
    }), 320);
    t.after(() => page.close());

    const keys = await page.evaluate(() => ({
        anchor: getAiSessionWorktreeGroupKey(document.querySelector('.ai-session-worktree-anchor')),
        group: getAiSessionWorktreeGroupKey(document.querySelector('.ai-session-worktree-task-group')),
    }));
    assert.notEqual(keys.anchor, keys.group,
        'the anchor and a keyless group must not share a collapse key');

    await page.evaluate(() => {
        setAiSessionWorktreeExpanded(
            document.querySelector('.ai-session-worktree-anchor .ai-session-worktree-header'),
            false);
    });
    const state = await page.evaluate(() => ({
        anchorCollapsed: document.querySelector('.ai-session-worktree-anchor')
            .hasAttribute('data-worktree-collapsed'),
        groupCollapsed: document.querySelector('.ai-session-worktree-task-group')
            .hasAttribute('data-worktree-collapsed'),
    }));
    assert.equal(state.anchorCollapsed, true);
    assert.equal(state.groupCollapsed, false,
        'collapsing the anchor must not collapse an unrelated group');
});

test('WORKTREE-GROUPS-UI-001 an unavailable primary disables creation and offers an explicit replacement', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow({
            canCreateSession: false,
            needsPrimarySelection: true,
            members: [
                member({
                    status: 'missing', isPrimary: true,
                    path: '/alpha/.worktrees/gone',
                    worktreeKey: undefined,
                }),
                member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                    isPrimary: false,
                }),
            ],
            chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        })],
    }), 320);
    t.after(() => page.close());

    const row = page.locator('.ai-session-worktree-task-group');
    assert.equal(await row.locator('[data-action="create-ai-session-quick"]').count(), 0,
        'quick create must not silently use a non-primary member');
    assert.equal(await row.locator('.ai-session-worktree-more').count(), 0,
        'the actions menu is disabled while the primary is unavailable');
    const picker = row.locator('.ai-session-worktree-primary-picker');
    assert.equal(await picker.count(), 1);
    assert.match(await picker.textContent(), /primary/i);
    const choice = picker.locator('[data-action="set-group-primary"]');
    assert.equal(await choice.count(), 1);
    assert.equal(await choice.getAttribute('data-member-id'), 'm-2',
        'only ready members are offered as replacements');
});

test('WORKTREE-GROUPS-UI-001 set-primary settlements drive the button pending state', async t => {
    // The button disables itself as a transient pending state and only the
    // Host's terminal settlement (or an authoritative re-render) releases
    // it — a fire-and-forget refresh alone must never strand the button.
    const primaryPickerGroup = groupRow({
        canCreateSession: false,
        needsPrimarySelection: true,
        members: [
            member({
                status: 'missing', isPrimary: true,
                path: '/alpha/.worktrees/gone',
                worktreeKey: undefined,
            }),
            member({
                memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                isPrimary: false,
            }),
        ],
        chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
    });
    const sessionHtml = () => surface({
        selectedSurface: 'worktree',
        worktreeGroups: [primaryPickerGroup],
    });
    const groupHtml = () =>
        `<div class="open-current-workspace-group current-card-expanded"><div class="group-list">`
        + `<div class="project workspace-card" data-id="project-a" data-current-workspace`
        + ` data-codex-expanded data-workspace-scope-identity="scope:current">${sessionHtml()}</div>`
        + `</div></div>`;
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div id="dashboard-tab-open"><div class="sticky-groups-wrapper">${groupHtml()}</div></div>
    </body></html>`);
    await page.addStyleTag({ content: styles });
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState() {},
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: todoGroupScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: todoControlScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: controlsScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });

    const choice = page.locator('[data-action="set-group-primary"][data-member-id="m-2"]');
    assert.equal(await choice.count(), 1);
    // The minimal fixture lacks the full layout CSS, so dispatch the click
    // directly: it still travels the real delegated handler chain.
    await choice.evaluate(button => button.click());
    assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'set-worktree-group-primary',
        version: 1,
        requestId: 'set-primary-1',
        projectId: 'project-a',
        groupId: 'g-1',
        memberId: 'm-2',
    });
    assert.equal(await choice.isDisabled(), true,
        'the clicked button enters its transient pending state');

    const postSettlement = status => page.evaluate(statusValue => {
        const request = window.__postedMessages
            .filter(message => message.type === 'set-worktree-group-primary').at(-1);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-primary-settlement',
                version: 1,
                requestId: request.requestId,
                groupId: request.groupId,
                memberId: request.memberId,
                ...(statusValue === 'failed' ? { errorCode: 'set-primary-failed' } : {}),
                status: statusValue,
            },
        }));
    }, status);
    await postSettlement('accepted');
    assert.equal(await choice.isDisabled(), true,
        'the accepted settlement keeps the pending state');
    await postSettlement('failed');
    assert.equal(await choice.isDisabled(), false,
        'a terminal failed settlement re-enables the button even without a refresh');

    await choice.evaluate(button => button.click());
    assert.equal(await choice.isDisabled(), true);
    await postSettlement('settled');
    assert.equal(await choice.isDisabled(), false,
        'a terminal settled settlement releases the pending state');

    // The authoritative refresh path still applies: a re-render replaces
    // the row wholesale, so no pending state survives it either.
    await choice.evaluate(button => button.click());
    assert.equal(await choice.isDisabled(), true);
    const applied = await page.evaluate(replacementHtml =>
        applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: 1,
            html: replacementHtml,
        }), groupHtml());
    assert.equal(applied, true, 'the failure refresh applies');
    const rerendered = page.locator('[data-action="set-group-primary"][data-member-id="m-2"]');
    assert.equal(await rerendered.count(), 1);
    assert.equal(await rerendered.isDisabled(), false,
        'the authoritative refresh replaces the pending row');
});

test('WORKTREE-GROUPS-UI-001 authoritative updates preserve the worktree list scroll position', async t => {
    const sessionHtml = surface({
        selectedSurface: 'worktree',
        worktreeGroups: [groupRow({
            members: [
                member(),
                member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                    isPrimary: false,
                }),
            ],
            chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        })],
        activeAiSessions: [liveSession()],
    });
    const groupHtml = `<div class="open-current-workspace-group current-card-expanded"><div class="group-list">`
        + `<div class="project workspace-card" data-id="project-a" data-current-workspace`
        + ` data-codex-expanded data-workspace-scope-identity="scope:current">${sessionHtml}</div>`
        + `</div></div>`;
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div id="dashboard-tab-open"><div class="sticky-groups-wrapper">${groupHtml}</div></div>
    </body></html>`);
    await page.addStyleTag({ content: styles });
    await page.addStyleTag({ content: `
        :root {
            --vscode-font-family: sans-serif;
            --vscode-foreground: #ddd;
            --vscode-descriptionForeground: #aaa;
            --vscode-panel-border: #555;
        }
        html, body { margin: 0; }
        .project { box-sizing: border-box; padding: 4px; }
        .ai-session-worktree-list { max-height: 40px; overflow-y: auto; }
    ` });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });

    const before = await page.evaluate(() => {
        const list = document.querySelector('.ai-session-worktree-list');
        list.scrollTop = 60;
        return list.scrollTop;
    });
    assert.ok(before > 0, 'the worktree list is scrollable in this fixture');

    const applied = await page.evaluate(replacementHtml =>
        applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: 1,
            html: replacementHtml,
        }), groupHtml);
    assert.equal(applied, true, 'the authoritative replacement applies');

    const after = await page.evaluate(() =>
        document.querySelector('.ai-session-worktree-list').scrollTop);
    assert.equal(after, before,
        'a refresh must not snap the worktree panel back to the top');
});
