'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewModules() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            ...require('../../out/webview/webviewContent'),
            ...require('../../out/webview/webviewAiSessionContent'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { getAiSessionsDiv, getAiSessionCreateDropdown, getAiSessionWorktreeMenu } = loadWebviewModules();

const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
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
const aiSessionControlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
    'utf8'
);
const groupFormScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewGroupFormScripts.js'),
    'utf8'
);
const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);
// The full stylesheet gates card visibility behind the dashboard tab chrome;
// the caption behavior is self-contained in its own compiled rules.
const captionStyleRules = (dashboardStyles.match(/[^{}]*ai-session-create-[a-z]+[^{}]*\{[^}]*\}/g) || [])
    .join('\n');

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function getSessionSurface(id, activeProvider, extras = {}) {
    return {
        id,
        activeAiSessionProvider: activeProvider,
        selectedAiSessionProviders: [activeProvider],
        activeAiSessionTab: 'chats',
        codexSessions: [{ id: `${id}-codex`, name: 'Codex history', provider: 'codex' }],
        kimiSessions: [{ id: `${id}-kimi`, name: 'Kimi history', provider: 'kimi' }],
        claudeSessions: [{ id: `${id}-claude`, name: 'Claude history', provider: 'claude' }],
        activeAiSessions: [],
        ...extras,
    };
}

async function openQuickCreatePage(t, options = {}) {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    t.after(() => page.close());
    const firstSurface = getSessionSurface('project-a', 'codex', {
        ...(options.profile ? { quickCreateProfile: options.profile } : {}),
        ...(options.codexProfiles ? { codexProfiles: options.codexProfiles } : {}),
        ...(options.provider ? { quickCreateProvider: options.provider } : {}),
        ...(options.codexSessions ? { codexSessions: options.codexSessions } : {}),
        ...(options.activeAiSessions ? { activeAiSessions: options.activeAiSessions } : {}),
        ...(options.worktrees ? {
            worktrees: options.worktrees,
            worktreeSnapshotRevision: 1,
            worktreeRepositoryCount: 1,
            bareWorktreeCount: 0,
        } : {}),
        ...(options.worktreeGroups ? { worktreeGroups: options.worktreeGroups } : {}),
        ...(options.anchor ? { worktreeAnchor: options.anchor } : {}),
        ...(options.chatsViewMode ? {
            windowViewState: { tab: 'chats', chatsViewMode: options.chatsViewMode },
        } : {}),
    });
    const firstPanel = getAiSessionsDiv(firstSurface);
    const secondPanel = getAiSessionsDiv(getSessionSurface('project-b', 'kimi'));

    await page.setContent(`<!doctype html>
        <html>
            <head>${options.withStyles ? `<style>${captionStyleRules}</style>` : ''}</head>
            <body class="steward-sidebar">
                <div class="steward-sticky-header">
                    <div class="filter-wrapper">
                        <button type="button" class="toggle-all-groups-button" data-action="toggle-all-groups"
                            title="Collapse all worktrees" aria-label="Collapse all worktrees"></button>
                    </div>
                </div>
                <div class="sticky-groups-wrapper">
                    <div class="open-session-surface" data-open-session-surface data-id="project-a"
                        data-current-workspace data-workspace-scope-identity="scope-project-a"
                        data-workspace-navigation-identity="navigation-project-a">${firstPanel}</div>
                    <div class="project workspace-card" data-id="project-b"
                        data-workspace-navigation-identity="navigation-project-b">${secondPanel}</div>
                </div>
                <button type="button" id="outside">Outside</button>
                ${getAiSessionCreateDropdown(firstSurface)}
                ${getAiSessionWorktreeMenu()}
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState: () => undefined,
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: groupFormScript });
    await page.addScriptTag({ content: aiSessionControlsScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

function postedMessages(page) {
    return page.evaluate(() => window.__postedMessages);
}

async function postAuthoritativeWorktreeRemoval(page, sequence) {
    const html = `<div class="open-session-surface" data-open-session-surface data-id="project-a"
        data-current-workspace data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a">
        ${getAiSessionsDiv(getSessionSurface('project-a', 'codex'))}
    </div>`;
    await page.evaluate(({ html, sequence }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'ai-sessions-updated', version: 3,
            sequence, projectionRevision: sequence,
            generatedAt: '2026-08-13T00:00:00.000Z',
            currentWorkspaceCount: 1, html,
            searchCatalog: {
                version: 3, sessions: [], worktrees: [], openWorkspaces: [],
                savedProjects: [], todos: [],
            },
            presentation: {
                type: 'ai-session-presentation-state', version: 1,
                projectionRevision: sequence,
                workspaceScopeIdentity: 'scope-project-a',
                workspaceNavigationIdentity: 'navigation-project-a',
                attentionCount: 0, activeAttentionCount: 0, runningSessionCount: 0,
                runningCardAnimation: 'current', runningIconAnimation: 'current',
                revealFocused: false, focusedTarget: null,
                attentionSessions: [], sessions: [],
            },
        } }));
    }, { html, sequence });
}

test('AI-SESSION-QUICK-CREATE-001 the quick button posts a quick-create for the card provider', async t => {
    const page = await openQuickCreatePage(t);
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const quickButton = project.locator('[data-action="create-ai-session-quick"]');

    assert.equal(await quickButton.getAttribute('data-provider'), 'codex');
    assert.equal(await quickButton.getAttribute('aria-label'), 'Create chat in Current with Codex');

    await quickButton.click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'codex',
        currentWorktreeAnchor: true,
    }]);

    const kimiQuickButton = page.locator('.project[data-id="project-b"] [data-action="create-ai-session-quick"]');
    assert.equal(await kimiQuickButton.getAttribute('aria-label'), 'Create chat in Current with Kimi');
    await kimiQuickButton.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
        currentWorktreeAnchor: true,
    });
});

test('WORKTREE-PROVISIONING-UI-001 a failed row shows a readable reason and can be dismissed', async t => {
    const page = await openQuickCreatePage(t, {
        worktrees: [{
            kind: 'provisioning', operationId: 'operation-failed', repositoryKey: '/repo/.git',
            taskName: 'test',
            proposedPath: '/repo/.worktrees/test',
            stage: 'failed', completedSteps: [], retryable: false, cancellable: false,
            errorCode: 'repository-has-no-commits',
        }],
    });
    const row = page.locator('.ai-session-provisioning-row');
    assert.match(await row.locator('.ai-session-provisioning-error').textContent(),
        /no commits yet/, 'the row explains the failure in plain language');
    const dismiss = row.locator('[data-action="dismiss-isolated-session"]');
    assert.equal(await dismiss.isVisible(), true,
        'a failed row always offers a way out');
    await dismiss.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'dismiss-isolated-session', version: 1,
        requestId: 'isolated-1', projectId: 'project-a', operationId: 'operation-failed',
    });
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 the anchor menu opens the inline group creation form', async t => {
    const page = await openQuickCreatePage(t, {
        anchor: {
            entries: [{ repositoryLabel: 'repo', branch: 'main' }],
            worktreeKeys: [
                { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo' },
                { repositoryKey: '/repo2/.git', canonicalWorktreePath: '/repo2' },
            ],
            sessions: [],
            activity: 'idle',
        },
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    assert.equal(await project.locator('[data-action="create-isolated-session"]').count(), 0,
        'the standalone new-worktree button is gone');

    await project.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const newWorktreeItem = menu.locator('[data-action="worktree-new"]');
    assert.equal(await newWorktreeItem.isVisible(), true,
        'multi-root anchors offer the plain new-worktree entry');
    await newWorktreeItem.evaluate(item => item.click());
    const messages = await postedMessages(page);
    assert.deepEqual(messages[0], {
        type: 'select-ai-session-view-tab', version: 1,
        projectId: 'project-a', tab: 'chats',
    }, 'opening the form selects the CHATS tree tab for authoritative re-renders');
    assert.equal(
        await project.locator('.codex-sessions').getAttribute('data-selected-ai-session-tab'),
        'chats'
    );
    assert.deepEqual(messages[1], {
        type: 'open-worktree-group-form', version: 1,
        projectId: 'project-a',
    }, 'M2 replaces the QuickPick/InputBox sequence with the inline form');
    // Only one form instance: invoking the entry again is a no-op.
    await project.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    assert.equal((await postedMessages(page))
        .filter(message => message.type === 'open-worktree-group-form').length, 1);

    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'worktree-group-form-state', version: 1,
            projectId: 'project-a',
            repositories: [{
                repositoryKey: '/repo/.git', label: 'repo',
                defaultBaseRef: 'refs/heads/main', localBranches: ['main'],
                defaultChecked: true, setupCommand: [],
            }],
        } }));
    });
    assert.equal(await project.locator('[data-worktree-group-form]').count(), 1,
        'the form renders inline at the top of the Worktree panel');
});

test('WORKTREE-MANAGED-CLEANUP-001 removal stays discoverable for busy managed worktrees', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/.worktrees/busy',
    };
    const page = await openQuickCreatePage(t, { worktrees: [{
        kind: 'ready',
        git: {
            key, branchRef: 'refs/heads/agent-pivot/busy', head: 'a'.repeat(40),
            isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        },
        activity: 'attention', sessions: [], authority: { canResume: true, canRemove: true },
    }] });
    await page.locator('[data-open-session-surface][data-id="project-a"] .ai-session-worktree-group[data-worktree-path="/repo/.worktrees/busy"] .ai-session-worktree-more').click();
    const removeItem = page.locator('#aiSessionWorktreeMenu [data-action="worktree-remove"]');
    assert.equal(await removeItem.isVisible(), true,
        'the menu always offers removal for usable worktrees; the host explains any refusal');
});

test('WORKTREE-MANAGED-CLEANUP-PROTOCOL-001 managed removal stays correlated through confirmation', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/.agent-pivot/worktrees/cleanup',
    };
    const page = await openQuickCreatePage(t, { worktrees: [{
        kind: 'ready',
        git: {
            key, branchRef: 'refs/heads/agent-pivot/cleanup', head: 'a'.repeat(40),
            isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        },
        activity: 'idle', sessions: [], authority: { canResume: true, canRemove: true },
    }] });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const button = project.locator('.ai-session-worktree-group[data-worktree-path="/repo/.agent-pivot/worktrees/cleanup"] .ai-session-worktree-more');
    const menu = page.locator('#aiSessionWorktreeMenu');
    const removeItem = menu.locator('[data-action="worktree-remove"]');
    await button.click();
    assert.equal(await removeItem.isVisible(), true,
        'a removable worktree offers removal inside its unified menu');
    await removeItem.click();
    assert.deepEqual((await postedMessages(page))[0], {
        type: 'remove-managed-worktree', version: 1,
        requestId: 'worktree-remove-1', projectId: 'project-a',
        repositoryKey: key.repositoryKey, worktreePath: key.canonicalWorktreePath,
    });
    assert.equal(await button.isDisabled(), true);

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: 'worktree-remove-1', status: 'accepted',
    } })));
    assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: 'worktree-remove-1', status: 'rejected', errorCode: 'worktree-dirty',
    } })));
    assert.equal(await button.isDisabled(), false);
    assert.match(await project.locator('[data-ai-session-live-region]').textContent(),
        /uncommitted changes/);

    await button.click();
    await removeItem.click();
    const retry = (await postedMessages(page)).at(-1);
    assert.equal(retry.requestId, 'worktree-remove-2');
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId, status: 'accepted',
    } })), retry.requestId);
    await postAuthoritativeWorktreeRemoval(page, 2);
    assert.equal(await page.locator('.ai-session-worktree-group[data-worktree-path="/repo/.agent-pivot/worktrees/cleanup"] .ai-session-worktree-more').count(), 0,
        'authoritative HTML removes the row before success settles pending');
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId, status: 'succeeded',
    } })), retry.requestId);
    assert.match(await page.locator('[data-open-session-surface][data-id="project-a"] '
        + '[data-ai-session-live-region]').textContent(), /local branch kept/);
});

test('WORKTREE-SESSION-CREATE-TARGET-001 a worktree quick button posts its exact target and remembered provider', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        provider: 'kimi',
        worktrees: [{
            kind: 'ready',
            git: {
                key,
                branchRef: 'refs/heads/feature/auth',
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            },
            activity: 'idle',
            sessions: [],
            authority: { canResume: true },
        }],
    });
    const button = page.locator(
        '[data-open-session-surface][data-id="project-a"] .ai-session-worktree-group[data-worktree-path="/repo-feature"] .ai-session-worktree-quick-create'
    );
    await button.click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'kimi',
        worktreeKey: key,
    }]);
});

test('WORKTREE-SESSION-CREATE-TARGET-001 the preset menu offers every provider for the worktree', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        provider: 'kimi',
        worktrees: [{
            kind: 'ready',
            git: {
                key,
                branchRef: 'refs/heads/feature/auth',
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            },
            activity: 'idle',
            sessions: [],
            authority: { canResume: true },
        }],
    });
    await page.locator('[data-open-session-surface][data-id="project-a"] .ai-session-worktree-group[data-worktree-path="/repo-feature"] [data-action="open-ai-session-preset-menu"]').click();
    const menu = page.locator('#aiSessionCreateDropdown');
    await menu.locator('[data-action="create-ai-session-preset"][data-provider="claude"]').click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'claude',
        worktreeKey: key,
    }]);
});

test('AI-SESSION-QUICK-CREATE-001 list view keeps inline create targets', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        provider: 'kimi',
        chatsViewMode: 'list',
        worktrees: [{
            kind: 'ready',
            git: {
                key, branchRef: 'refs/heads/feature/auth', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
            activity: 'idle', sessions: [], authority: { canResume: true },
        }],
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const collapseAll = page.locator('[data-action="toggle-all-groups"]');
    await page.evaluate(() => window.__agentPivotSyncCollapseButton());
    assert.equal(await project.locator('.ai-session-list-launch-rail').count(), 1);
    assert.equal(await collapseAll.isDisabled(), true,
        'the global collapse control is unavailable when CHATS is displayed as a flat list');
    assert.equal(await collapseAll.getAttribute('aria-label'), 'No worktrees to collapse');
    await project.locator('.ai-session-list-launch-target[data-worktree-path="/repo-feature"] '
        + '[data-action="create-ai-session-quick"]').click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick', projectId: 'project-a', provider: 'kimi', worktreeKey: key,
    }]);
});

test('WORKTREE-GROUPING-UI-001 disabled global collapse control looks inactive', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 120 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><head><style>${dashboardStyles}</style></head>
        <body><div class="filter-wrapper"><button type="button" class="toggle-all-groups-button"
            data-action="toggle-all-groups" disabled>Collapse all worktrees</button></div></body></html>`);
    const disabledPresentation = await page.locator('[data-action="toggle-all-groups"]').evaluate(button => ({
        cursor: getComputedStyle(button).cursor,
        opacity: Number(getComputedStyle(button).opacity),
    }));
    assert.equal(disabledPresentation.cursor, 'default');
    assert.ok(disabledPresentation.opacity <= 0.55,
        'a disabled global collapse control does not look clickable');
});

test('WORKTREE-GROUPING-UI-001 waits for authoritative Tree DOM before enabling global collapse', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        chatsViewMode: 'list',
        worktrees: [{
            kind: 'ready',
            git: {
                key, branchRef: 'refs/heads/feature/auth', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
            activity: 'idle', sessions: [], authority: { canResume: true },
        }],
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const collapseAll = page.locator('[data-action="toggle-all-groups"]');

    await project.locator('[data-action="toggle-chats-view-menu"]').click();
    await project.locator('[data-action="select-chats-view-mode"][data-view-mode="tree"]').click();

    assert.equal(await project.locator('.codex-sessions').getAttribute('data-chats-view-mode'), 'tree',
        'the optimistic preference changes immediately');
    assert.equal(await collapseAll.isDisabled(), true,
        'the stale List launch rail is not treated as a collapsible Tree');
    assert.equal(await collapseAll.getAttribute('aria-label'), 'No worktrees to collapse');
    assert.equal((await postedMessages(page)).some(message =>
        message.type === 'set-ai-session-collapsed-worktree-groups'
    ), false, 'no collapsed state is written before the authoritative Tree replacement');
});

test('AI-SESSION-QUICK-CREATE-001 list view does not duplicate a managed group primary', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const readyWorktree = {
        kind: 'ready',
        git: {
            key, branchRef: 'refs/heads/feature/auth', head: 'a'.repeat(40),
            isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        },
        activity: 'idle', sessions: [], authority: { canResume: true },
    };
    const page = await openQuickCreatePage(t, {
        chatsViewMode: 'list', worktrees: [readyWorktree],
        worktreeGroups: [{
            kind: 'group', groupId: 'feature-auth', displayName: 'feature-auth', revision: 1,
            activity: 'idle', sessions: [], chips: [], hasDetachedMembers: false,
            needsPrimarySelection: false, canCreateSession: true, mergeCandidateGroupIds: [],
            members: [{
                memberId: 'feature-auth-primary', repositoryKey: key.repositoryKey,
                repositoryLabel: 'repo', branchName: 'feature/auth', path: key.canonicalWorktreePath,
                status: 'ready', isPrimary: true, worktreeKey: key,
            }],
        }],
    });
    assert.equal(await page.locator('[data-open-session-surface][data-id="project-a"] '
        + '.ai-session-list-launch-target[data-worktree-path="/repo-feature"]').count(), 1,
    'the managed group is the sole creation target for its primary worktree');
});

test('AI-SESSION-QUICK-CREATE-001 the worktree actions menu contains management only', async t => {
    const page = await openQuickCreatePage(t);
    const menu = page.locator('#aiSessionWorktreeMenu');
    assert.equal(await menu.locator('[data-action="worktree-quick-create"]').count(), 0);
    assert.equal(await menu.locator('[data-action="worktree-provider-create"]').count(), 0);
    assert.equal(await menu.locator('[data-action="worktree-create-with-options"]').count(), 0);
});

test('WORKTREE-GROUPING-UI-001 collapsing a worktree really hides every session it contains', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        activeAiSessions: [
            {
                key: 'codex:feature-session', provider: 'codex', sessionId: 'feature-session',
                name: 'Feature session', executionState: 'running', backend: 'vscode',
                attached: true, worktreeKey: key,
            },
            {
                key: 'codex:other-session', provider: 'codex', sessionId: 'other-session',
                name: 'Other session', executionState: 'stopped', backend: 'vscode',
                attached: false, worktreeKey: key,
            },
        ],
        worktrees: [{
            kind: 'ready',
            git: {
                key,
                branchRef: 'refs/heads/feature/auth',
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            },
            activity: 'attention',
            sessions: [],
            authority: { canResume: true },
        }],
    });
    const group = page.locator('[data-open-session-surface][data-id="project-a"] .ai-session-worktree-group[data-worktree-path="/repo-feature"]');
    const rows = group.locator('.codex-session-row');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.first().isVisible(), true);

    await group.locator('.ai-session-worktree-header').click();
    assert.equal(await rows.count(), 2, 'collapsing keeps the rows in the DOM');
    assert.equal(await rows.first().isVisible(), false,
        'a collapsed worktree must visually hide every session row');
    assert.equal(await rows.nth(1).isVisible(), false);

    await group.locator('.ai-session-worktree-header').click();
    assert.equal(await rows.first().isVisible(), true,
        'expanding restores every session row');
});

test('WORKTREE-ISOLATED-SESSION-001 a worktree row icon seeds the creation form from that branch', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        worktrees: [{
            kind: 'ready',
            git: {
                key,
                branchRef: 'refs/heads/feature/auth',
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            },
            activity: 'idle',
            sessions: [],
            authority: { canResume: true },
        }],
    });
    const button = page.locator(
        '[data-open-session-surface][data-id="project-a"] .ai-session-worktree-group[data-worktree-path="/repo-feature"] .ai-session-worktree-more'
    );
    assert.equal(await button.locator('svg').count(), 1,
        'the row actions affordance is an icon, not an English label');
    await button.click();
    const branchItem = page.locator('#aiSessionWorktreeMenu [data-action="worktree-branch-create"]');
    assert.equal(await branchItem.textContent(), 'New worktree from feature/auth');
    await branchItem.click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'open-worktree-group-form',
        version: 1,
        projectId: 'project-a',
        seedRepositoryKey: key.repositoryKey,
        seedWorktreePath: key.canonicalWorktreePath,
    }], 'branch-from-here is absorbed by the form with a seed (PRD §6.1)');
});

test('WORKTREE-GROUPING-UI-001 revealing a switched session follows it into its worktree group', async t => {
    const key = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    };
    const page = await openQuickCreatePage(t, {
        activeAiSessions: [{
            key: 'codex:feature-session', provider: 'codex', sessionId: 'feature-session',
            name: 'Feature session', executionState: 'running', backend: 'vscode',
            attached: true, worktreeKey: key,
        }],
        worktrees: [{
            kind: 'ready',
            git: {
                key,
                branchRef: 'refs/heads/feature/auth',
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            },
            activity: 'active',
            sessions: [],
            authority: { canResume: true },
        }],
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    // Start with the worktree group collapsed.
    await page.evaluate(() => {
        const projectDiv = document.querySelector('[data-open-session-surface][data-id="project-a"]');
        setAiSessionWorktreeGroupExpanded(
            projectDiv,
            projectDiv.querySelector('.ai-session-worktree-group'),
            false
        );
    });

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'reveal-ai-session-requested', version: 1,
        projectId: 'project-a', provider: 'codex', sessionId: 'feature-session',
    } })));

    assert.equal(
        await project.locator('.codex-sessions').getAttribute('data-selected-ai-session-tab'),
        'chats',
        'the view follows a worktree session into the CHATS tree'
    );
    assert.equal(
        await project.locator('.ai-session-worktree-group .codex-session-row').first().isVisible(),
        true,
        'the group expands so the session row is visible'
    );
    assert.deepEqual((await postedMessages(page)).find(message => message.type === 'select-ai-session-view-tab'), {
        type: 'select-ai-session-view-tab',
        version: 1,
        projectId: 'project-a',
        tab: 'chats',
    }, 'the follow persists the tab for authoritative re-renders');
});

test('WORKTREE-GROUPING-UI-001 revealing a plain session lands on Chats active', async t => {
    const page = await openQuickCreatePage(t, {
        activeAiSessions: [{
            key: 'codex:plain-session', provider: 'codex', sessionId: 'plain-session',
            name: 'Plain session', executionState: 'running', backend: 'vscode',
            attached: true,
        }],
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'reveal-ai-session-requested', version: 1,
        projectId: 'project-a', provider: 'codex', sessionId: 'plain-session',
    } })));

    assert.equal(
        await project.locator('.codex-sessions').getAttribute('data-selected-ai-session-tab'),
        'chats'
    );
    assert.equal(
        await project.locator('[data-ai-session-tab="chats"]').getAttribute('aria-selected'),
        'true'
    );
    assert.equal(
        await project.locator('[data-ai-session-panel="chats"] .codex-session-row[data-session-id="plain-session"]').count(),
        1,
        'the plain session renders in the CHATS tree'
    );
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'reveal-ai-session-requested', version: 1,
        projectId: 'project-a', provider: 'codex', sessionId: 'plain-session', forged: true,
    } })));
    assert.equal(
        await project.locator('.codex-sessions').getAttribute('data-selected-ai-session-tab'),
        'chats',
        'malformed reveal requests are ignored'
    );
});

test('WORKTREE-GROUPING-UI-001 the global collapse control toggles every worktree group at once', async t => {
    const firstKey = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-feature' };
    const secondKey = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-backend' };
    const worktree = (key, branchRef) => ({
        kind: 'ready',
        git: {
            key, branchRef, head: 'a'.repeat(40),
            isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        },
        activity: 'active',
        sessions: [],
        authority: { canResume: true },
    });
    const page = await openQuickCreatePage(t, {
        activeAiSessions: [
            {
                key: 'codex:feature-session', provider: 'codex', sessionId: 'feature-session',
                name: 'Feature session', executionState: 'running', backend: 'vscode',
                attached: true, worktreeKey: firstKey,
            },
            {
                key: 'codex:backend-session', provider: 'codex', sessionId: 'backend-session',
                name: 'Backend session', executionState: 'running', backend: 'vscode',
                attached: true, worktreeKey: secondKey,
            },
        ],
        worktrees: [
            worktree(firstKey, 'refs/heads/feature/auth'),
            worktree(secondKey, 'refs/heads/feature/backend'),
        ],
    });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const toggleAll = page.locator('[data-action="toggle-all-groups"]');
    const rows = project.locator('.ai-session-worktree-group .codex-session-row');

    await page.evaluate(() => window.__agentPivotSyncCollapseButton());
    assert.equal(await toggleAll.count(), 1, 'the sidebar header owns the global collapse control');
    assert.equal(await project.locator(
        '[data-ai-session-panel="chats"] [data-action="toggle-all-ai-session-worktrees"]'
    ).count(), 0, 'the CHATS tree no longer renders a duplicate local control');
    assert.equal(await toggleAll.getAttribute('aria-label'), 'Collapse all worktrees');
    assert.equal(await rows.first().isVisible(), true);

    await toggleAll.click();
    assert.equal(await rows.first().isVisible(), false, 'collapse-all hides every group');
    assert.equal(await toggleAll.getAttribute('aria-label'), 'Expand all worktrees');

    await toggleAll.click();
    assert.equal(await rows.first().isVisible(), true, 'expand-all restores every group');
    assert.equal(await toggleAll.getAttribute('aria-label'), 'Collapse all worktrees');

    // A mixed state collapses everything first, matching group-toggle intuition.
    await page.evaluate(() => {
        const projectDiv = document.querySelector('[data-open-session-surface][data-id="project-a"]');
        setAiSessionWorktreeGroupExpanded(
            projectDiv,
            projectDiv.querySelectorAll('.ai-session-worktree-group')[0],
            false
        );
    });
    await toggleAll.click();
    assert.equal(await rows.first().isVisible(), false,
        'one expanded group left means collapse-all still collapses the rest');

    await project.locator('[data-ai-session-tab="all"]').click();
    assert.equal(await toggleAll.isDisabled(), true,
        'ALL has no worktree hierarchy, so the global collapse control is disabled');
    assert.equal(await toggleAll.getAttribute('aria-label'), 'No worktrees to collapse');

    await project.locator('[data-ai-session-tab="chats"]').click();
    assert.equal(await toggleAll.isDisabled(), false,
        'returning to the CHATS tree restores the global worktree control');
    assert.equal(await toggleAll.getAttribute('aria-label'), 'Expand all worktrees');
});

test('WORKTREE-GROUPING-UI-001 selecting a CHATS/ALL tab reports it for authoritative re-renders', async t => {
    const page = await openQuickCreatePage(t);
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');

    await project.locator('[data-ai-session-tab="all"]').click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'select-ai-session-view-tab',
        version: 1,
        projectId: 'project-a',
        tab: 'all',
    }]);
    assert.equal(
        await project.locator('[data-ai-session-tab="all"]').getAttribute('aria-selected'),
        'true'
    );

    await project.locator('[data-ai-session-tab="chats"]').click();
    assert.deepEqual((await postedMessages(page)).find(
        message => message.type === 'select-ai-session-view-tab' && message.tab === 'chats'
    ), {
        type: 'select-ai-session-view-tab',
        version: 1,
        projectId: 'project-a',
        tab: 'chats',
    });
});

test('AI-SESSION-QUICK-CREATE-001 a row preset trigger opens the create menu without posting', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);

    await page.locator('[data-open-session-surface][data-id="project-a"] [data-action="open-ai-session-preset-menu"]').click();

    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);
    assert.equal(await dropdown.getAttribute('data-dropdown-project-id'), 'project-a');
    assert.deepEqual(await postedMessages(page), [], 'opening the menu must not create a session');
    const box = await dropdown.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'the open dropdown is laid out');
});

test('AI-SESSION-QUICK-CREATE-001 dropdown provider items quick-create for the originating project', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('.project[data-id="project-b"] [data-action="open-ai-session-preset-menu"]').click();
    await dropdown.locator('[data-action="create-ai-session-preset"][data-provider="claude"]').click();

    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'claude',
        currentWorktreeAnchor: true,
    }], 'the menu item targets the project whose arrow opened the menu, not its own provider');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'choosing an item closes the dropdown');
});

test('AI-SESSION-QUICK-CREATE-001 the preset menu sends the selected Codex profile', async t => {
    const page = await openQuickCreatePage(t, { codexProfiles: ['deepseek', 'research'] });
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('[data-open-session-surface][data-id="project-a"] [data-action="open-ai-session-preset-menu"]').click();
    await dropdown.locator('[data-action="create-ai-session-preset"][data-provider="codex"][data-profile="deepseek"]').click();

    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'codex',
        codexProfile: 'deepseek',
        currentWorktreeAnchor: true,
    }]);
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);
});

test('AI-SESSION-QUICK-CREATE-001 the plain Codex preset explicitly selects base configuration', async t => {
    const page = await openQuickCreatePage(t, { codexProfiles: ['deepseek'] });
    await page.locator('[data-open-session-surface][data-id="project-a"] '
        + '[data-action="open-ai-session-preset-menu"]').click();
    await page.locator('#aiSessionCreateDropdown [data-action="create-ai-session-preset"]'
        + '[data-provider="codex"][data-codex-profile-base="true"]').click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick', projectId: 'project-a', provider: 'codex',
        codexProfileBase: true, currentWorktreeAnchor: true,
    }]);
});

test('AI-SESSION-QUICK-CREATE-001 switching row triggers rebinds the shared preset menu', async t => {
    const first = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-first' };
    const second = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-second' };
    const row = (key, branchRef) => ({
        kind: 'ready', git: {
            key, branchRef, head: 'a'.repeat(40), isMain: false, isBare: false,
            health: 'normal', headKind: 'branch',
        }, activity: 'idle', sessions: [], authority: { canResume: true },
    });
    const page = await openQuickCreatePage(t, { worktrees: [
        row(first, 'refs/heads/first'), row(second, 'refs/heads/second'),
    ] });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    await project.locator('[data-worktree-path="/repo-first"] [data-action="open-ai-session-preset-menu"]').click();
    await project.locator('[data-worktree-path="/repo-second"] [data-action="open-ai-session-preset-menu"]').click();
    assert.equal(await page.locator('#aiSessionCreateDropdown').evaluate(menu => menu.classList.contains('visible')), true);
    await page.locator('#aiSessionCreateDropdown [data-provider="kimi"]').click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick', projectId: 'project-a', provider: 'kimi', worktreeKey: second,
    }]);
});

test('AI-SESSION-QUICK-CREATE-001 preset menu reads profiles from the latest surface replacement', async t => {
    const page = await openQuickCreatePage(t, { codexProfiles: ['removed-profile'] });
    const replacement = getAiSessionsDiv(getSessionSurface('project-a', 'codex', {
        codexProfiles: ['new-profile'],
    }));
    await page.evaluate(html => {
        document.querySelector('[data-open-session-surface][data-id="project-a"]')
            .innerHTML = html;
    }, replacement);

    await page.locator('[data-open-session-surface][data-id="project-a"] '
        + '[data-action="open-ai-session-preset-menu"]').click();
    const menu = page.locator('#aiSessionCreateDropdown');
    assert.equal(await menu.locator('[data-profile="new-profile"]').count(), 1);
    assert.equal(await menu.locator('[data-profile="removed-profile"]').count(), 0);
});

test('AI-SESSION-QUICK-CREATE-001 outside clicks close the dropdown without posting', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('[data-open-session-surface][data-id="project-a"] [data-action="open-ai-session-preset-menu"]').click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);

    await page.locator('#outside').click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);
    assert.deepEqual(await postedMessages(page), []);
});

test('AI-SESSION-QUICK-CREATE-001 the fast tooltip appears promptly on hover and focus', async t => {
    const page = await openQuickCreatePage(t, { profile: 'deepseek' });
    const quickButton = page.locator(
        '[data-open-session-surface][data-id="project-a"] [data-action="create-ai-session-quick"]'
    );
    const tip = page.locator('.ai-session-fast-tooltip');

    await quickButton.hover();
    await tip.waitFor({ state: 'visible', timeout: 800 });
    assert.equal(await tip.textContent(), 'Codex · deepseek',
        'the tooltip must appear well ahead of the native title delay');
    await page.locator('#outside').hover();
    assert.equal(await tip.count(), 0, 'leaving the button dismisses the tooltip');

    await quickButton.focus();
    await tip.waitFor({ state: 'visible', timeout: 800 });
    await page.locator('#outside').click();
    assert.equal(await tip.count(), 0, 'clicking elsewhere dismisses the tooltip');
});

test('AI-SESSION-QUICK-CREATE-001 the quick button tooltip identifies the provider and profile', async t => {
    const page = await openQuickCreatePage(t, { profile: 'deepseek', withStyles: true });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const quickButton = project.locator('[data-action="create-ai-session-quick"]');

    assert.equal(await quickButton.getAttribute('aria-label'), 'Create chat in Current with Codex · deepseek');
    assert.equal(await quickButton.getAttribute('data-tooltip'), 'Codex · deepseek');
    assert.equal(await project.locator('.ai-session-chats-actions').count(), 0,
        'the CHATS toolbar has no global create action');

    const kimiButton = page.locator(
        '.project[data-id="project-b"] [data-action="create-ai-session-quick"]'
    );
    assert.equal(await kimiButton.getAttribute('data-tooltip'), 'Kimi',
        'providers without a profile name the provider alone in the tooltip');
});

test('AI-SESSION-QUICK-CREATE-001 the quick button follows the remembered provider, not the list filter', async t => {
    const page = await openQuickCreatePage(t, { provider: 'kimi', withStyles: true });
    const project = page.locator('[data-open-session-surface][data-id="project-a"]');
    const quickButton = project.locator('[data-action="create-ai-session-quick"]');

    assert.equal(await quickButton.getAttribute('data-provider'), 'kimi',
        'a stored codex-heavy list filter must not pin the quick-create button');
    assert.equal(await quickButton.getAttribute('aria-label'), 'Create chat in Current with Kimi');
    assert.equal(await quickButton.getAttribute('data-tooltip'), 'Kimi');
    assert.equal(
        await page.locator('[data-open-session-surface][data-id="project-a"] [data-ai-session-region]')
            .getAttribute('data-active-ai-session-provider'),
        'codex',
        'the session list filter keeps its own primary provider'
    );

    await quickButton.click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'kimi',
        currentWorktreeAnchor: true,
    }], 'quick-create launches the remembered provider');
});

test('AI-SESSION-QUICK-CREATE-001 the arrow toggles the dropdown and mirrors aria-expanded', async t => {
    const page = await openQuickCreatePage(t);
    const arrow = page.locator('[data-open-session-surface][data-id="project-a"] [data-action="open-ai-session-preset-menu"]');
    const dropdown = page.locator('#aiSessionCreateDropdown');

    assert.equal(await arrow.getAttribute('aria-haspopup'), 'menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');

    await arrow.click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);
    assert.equal(await arrow.getAttribute('aria-expanded'), 'true');

    await arrow.click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'a second click on the opening arrow closes its menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await postedMessages(page), []);
});

test('AI-SESSION-QUICK-CREATE-001 the dropdown is fully keyboard operable', async t => {
    const page = await openQuickCreatePage(t);
    const project = page.locator('.project[data-id="project-b"]');
    const arrow = project.locator('[data-action="open-ai-session-preset-menu"]');
    const dropdown = page.locator('#aiSessionCreateDropdown');
    const items = dropdown.locator('[role="menuitem"]');

    await arrow.focus();
    await arrow.press('Enter');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true,
        'Enter on the arrow opens the menu');
    assert.equal(await items.nth(0).evaluate(element => document.activeElement === element), true,
        'focus lands on the first menu item when the menu opens');

    await items.nth(0).press('ArrowDown');
    assert.equal(await items.nth(1).evaluate(element => document.activeElement === element), true);
    await items.nth(1).press('End');
    assert.equal(await items.nth(2).evaluate(element => document.activeElement === element), true,
        'End jumps to the last provider preset');
    await items.nth(2).press('ArrowDown');
    assert.equal(await items.nth(0).evaluate(element => document.activeElement === element), true,
        'roving focus wraps around');

    await items.nth(0).press('ArrowDown');
    await items.nth(1).press('Enter');
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
        currentWorktreeAnchor: true,
    }], 'Enter activates the focused provider item for the originating project');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);

    await arrow.press('Enter');
    await items.nth(0).press('Escape');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'Escape closes the menu');
    assert.equal(await arrow.evaluate(element => document.activeElement === element), true,
        'Escape restores focus to the arrow that opened the menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
        currentWorktreeAnchor: true,
    }], 'Escape posts nothing');
});
