'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { getAiSessionsDiv } = require('../../out/webview/webviewAiSessionContent');
const { getAiSessionWorktreeMenu } = require('../../out/webview/webviewAiSessionContent');
const {
    buildOpenWindowRowViewModels,
} = require('../../out/openWorkspaces/windowRowViewModel');
const {
    getOpenWindowSwitcherGroupContent,
} = require('../../out/webview/webviewWindowSwitcherContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const controlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
    'utf8'
);
const groupFormScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewGroupFormScripts.js'),
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
const betaMainKey = { repositoryKey: '/beta/.git', canonicalWorktreePath: '/beta/main' };
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
        revision: 1,
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
        activeAiSessionTab: 'chats',
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
        <div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace
            data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">
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

test('WORKTREE-GROUPS-UI-001 renders the anchor row with labeled real branches and a unified actions menu', async t => {
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
    assert.equal(await anchor.locator('.ai-session-worktree-more').count(), 1,
        'the anchor shares the same actions menu as every other row');
    assert.equal(await anchor.locator('[data-action="create-ai-session-quick"]').count(), 0,
        'no standalone + button: creation lives in the menu');
    assert.equal(
        await anchor.locator('.codex-session-row[data-session-id="s-main"]').count(), 1,
        'main-checkout sessions collect under the anchor');
});

test('WORKTREE-GROUPS-UI-001 the anchor menu launches main-checkout sessions and never offers removal', async t => {
    const sessionHtml = () => surface({
        worktreeAnchor: {
            // Multi-root anchor: no single main checkout, so the menu
            // offers the plain new-worktree entry and no branch seed.
            entries: [
                { repositoryLabel: 'alpha', branch: 'main' },
                { repositoryLabel: 'beta', branch: 'main' },
            ],
            worktreeKeys: [alphaMainKey, betaMainKey],
            sessions: [],
            activity: 'idle',
        },
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const quickItem = menu.locator('[data-action="worktree-quick-create"]');
    assert.equal(await quickItem.isVisible(), true,
        'quick create is offered for the Current anchor');
    assert.equal(await menu.locator('[data-action="worktree-provider-create"]').first()
        .isVisible(), true, 'per-provider creation is offered');
    assert.equal(await menu.locator('[data-action="worktree-create-with-options"]')
        .isVisible(), true, 'the full-options creation entry is offered');
    assert.equal(await menu.locator('[data-action="worktree-new"]').isVisible(), true,
        'multi-root anchors offer the plain new-worktree entry');
    assert.equal(await menu.locator('[data-action="worktree-remove"]').isHidden(), true,
        'the anchor can never be removed');
    assert.equal(await menu.locator('[data-action="worktree-branch-create"]')
        .isHidden(), true, 'no worktree target: branch creation stays hidden');
    assert.equal(await menu.locator('[data-action="worktree-group-rename"]')
        .isHidden(), true, 'no group: group actions stay hidden');

    await quickItem.evaluate(item => item.click());
    const messages = await page.evaluate(() => window.__postedMessages);
    const created = messages.filter(message => message.type === 'create-ai-session-quick');
    assert.equal(created.length, 1);
    assert.equal(created[0].worktreeKey, undefined,
        'no worktree key: the session starts in the main checkout, like Chats +');
    // The full-options entry launches the picker flow without a key too.
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-create-with-options"]')
        .evaluate(item => item.click());
    const withOptions = (await page.evaluate(() => window.__postedMessages))
        .filter(message => message.type === 'create-ai-session');
    assert.equal(withOptions.length, 1);
    assert.equal(withOptions[0].worktreeKey, undefined);
});

test('WORKTREE-GROUPS-UI-001 group rows carry no standalone plus button', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow()],
    }), 320);
    t.after(() => page.close());
    const row = page.locator('.ai-session-worktree-task-group');
    assert.equal(await row.locator('[data-action="create-ai-session-quick"]').count(), 0,
        'session creation lives in the ⋯ menu');
    assert.equal(await row.locator('.ai-session-worktree-more').count(), 1);
});

test('WORKTREE-GROUPS-UI-001 renders group repositories in the header tooltip, sessions, and a member summary', async t => {
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
    const header = row.locator('.ai-session-worktree-header');
    assert.equal(await header.getAttribute('data-tooltip'), 'Repositories:\nalpha\nbeta',
        'repository names move out of the row and into the header tooltip');
    assert.match(await header.getAttribute('aria-label'), /repositories: alpha, beta$/,
        'the full repository list remains available to keyboard and assistive-technology users');
    assert.equal(await row.locator('.ai-session-repo-chip').count(), 0,
        'repository chips do not compete with the task name for inline space');
    assert.equal(await row.locator('.codex-session-row[data-session-id="s-1"]').count(), 1,
        'sessions aggregate across group members');
    const summary = await row.locator('.ai-session-worktree-member-summary').textContent();
    assert.ok(summary.includes('2 worktrees'));
    assert.ok(summary.includes('alpha, beta'));
    assert.equal(await row.locator('[data-action="create-ai-session-quick"]').count(), 0,
        'no standalone + on group rows: creation lives in the menu');
    assert.equal(
        await row.getAttribute('data-worktree-path'),
        '/alpha/.worktrees/fix-login',
        'the menu context still targets the primary member worktree');
    assert.equal(await row.locator('[data-action="merge-worktree-groups"]').count(), 0,
        'no merge affordance without a same-slug candidate');
});

test('WORKTREE-GROUPS-UI-001 puts every group repository in the header tooltip', async t => {
    // Annotation feedback: repository chips consume the task-name space.
    // The header tooltip has the complete list, regardless of repository
    // count, while the row itself stays chip-free.
    const page = await openSurfacePage(surface({
        worktreeGroups: [
            groupRow({
                chips: [
                    { label: 'a', title: 'alpha' },
                    { label: 'b', title: 'beta' },
                    { label: 'g', title: 'gamma' },
                    { label: 'd', title: 'delta' },
                    { label: 'e', title: 'epsilon' },
                    { label: 'z', title: 'zeta' },
                ],
            }),
            groupRow({
                groupId: 'g-4',
                displayName: 'four-chip-task',
                chips: [
                    { label: 'a', title: 'alpha' },
                    { label: 'b', title: 'beta' },
                    { label: 'g', title: 'gamma' },
                    { label: 'd', title: 'delta' },
                ],
            }),
        ],
    }), 320);
    t.after(() => page.close());

    const row = page.locator('.ai-session-worktree-task-group').first();
    const header = row.locator('.ai-session-worktree-header');
    assert.equal(await header.getAttribute('data-tooltip'),
        'Repositories:\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta',
        'all repositories are available from one tooltip, without a +N truncation marker');
    assert.match(await header.getAttribute('aria-label'),
        /repositories: alpha, beta, gamma, delta, epsilon, zeta$/);
    assert.equal(await row.locator('.ai-session-repo-chip').count(), 0);

    const fourChipRow = page.locator('.ai-session-worktree-task-group').nth(1);
    assert.equal(await fourChipRow.locator('.ai-session-worktree-header').getAttribute('data-tooltip'),
        'Repositories:\nalpha\nbeta\ngamma\ndelta');
    assert.equal(await fourChipRow.locator('.ai-session-repo-chip').count(), 0,
        'the four-repository case is also chip-free');
});

test('WORKTREE-GROUPS-UI-001 keeps the task name readable without repository chips', async t => {
    // Repository names live in the header tooltip, leaving the task title as
    // the only flexible label in the group header.
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow({
            displayName: 'fix-the-authentication-login-flow-regression',
            chips: [
                { label: 'agent-pivot', title: 'agent-pivot' },
                { label: 'agent-platform', title: 'agent-platform' },
                { label: 'infrastructure', title: 'infrastructure' },
                { label: 'documentation', title: 'documentation' },
            ],
        })],
        activeAiSessions: [liveSession()],
    }), 320);
    t.after(() => page.close());

    const layout = await page.evaluate(() => {
        const title = document.querySelector(
            '.ai-session-worktree-task-group .ai-session-worktree-title');
        return {
            titleWidth: title.getBoundingClientRect().width,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
        };
    });
    assert.ok(layout.titleWidth >= 40,
        `the task name keeps a readable floor (got ${layout.titleWidth}px)`);
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1,
        `no horizontal overflow (document ${layout.documentWidth}px)`);
});

test('WORKTREE-GROUPS-UI-001 puts merge in the actions menu and keeps the discriminator stable', async t => {
    const { page } = await openGroupActionsPage(t, () => surface({
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
    }));

    const groups = page.locator('.ai-session-worktree-task-group');
    assert.equal(await groups.locator('[data-action="merge-worktree-groups"]').count(), 0,
        'merge is not a standalone row affordance');
    await groups.first().locator('.ai-session-worktree-more').evaluate(button => button.click());
    const mergeItem = page.locator('#aiSessionWorktreeMenu [data-action="merge-worktree-groups"]');
    assert.equal(await mergeItem.isVisible(), true,
        'eligible groups expose merge from the actions menu');
    const names = await page.locator('.ai-session-worktree-task-group .ai-session-worktree-title')
        .allTextContents();
    assert.deepEqual(names, ['fix-login', 'fix-login']);
    assert.equal(
        await page.locator('.ai-session-worktree-discriminator').count(), 2,
        'colliding display names carry a stable branch discriminator');
});

test('WORKTREE-GROUPS-UI-001 merge request ids carry a per-document nonce (review R6)', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [
            groupRow({ mergeCandidateGroupIds: ['g-2'] }),
            groupRow({ groupId: 'g-2', mergeCandidateGroupIds: ['g-1'] }),
        ],
    });
    const firstDocument = await openGroupActionsPage(t, sessionHtml);
    await firstDocument.page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await firstDocument.page.locator(
        '#aiSessionWorktreeMenu [data-action="merge-worktree-groups"]')
        .evaluate(item => item.click());
    const first = await firstDocument.page.evaluate(() => window.__postedMessages.at(-1));
    assert.match(first.requestId, /^worktree-merge-[a-z0-9]+-1$/,
        'the merge request id carries a per-document nonce');
    assert.deepEqual({ ...first, requestId: '<nonce>' }, {
        type: 'merge-worktree-groups',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        sourceGroupId: 'g-1',
    });

    // The host replay cache outlives the document: a rebuilt document must
    // never regenerate the previous document's first request id and be
    // answered from the stale cache without executing.
    const secondDocument = await openGroupActionsPage(t, sessionHtml);
    await secondDocument.page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await secondDocument.page.locator(
        '#aiSessionWorktreeMenu [data-action="merge-worktree-groups"]')
        .evaluate(item => item.click());
    const second = await secondDocument.page.evaluate(() => window.__postedMessages.at(-1));
    assert.match(second.requestId, /^worktree-merge-[a-z0-9]+-1$/);
    assert.notEqual(second.requestId, first.requestId,
        'a rebuilt document starts its own nonce-namespaced sequence');
});

test('WORKTREE-GROUPS-UI-001 flags legacy-scope sessions until restart', async t => {
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow()],
        activeAiSessions: [liveSession({ legacyScope: true })],
    }), 320);
    t.after(() => page.close());

    const badge = page.locator(
        '[data-ai-session-panel="chats"]'
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
    assert.equal(await page.locator('.ai-session-worktree-anchor').count(), 1);
    assert.equal(await page.locator('.ai-session-worktree-task-group').count(), 1);
    const layout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1,
        `no horizontal overflow at 170px (document ${layout.documentWidth}px)`);
});

test('WORKTREE-GROUPS-RENAME-001 expanded member details stay contained at 170px', async t => {
    const longLabel = 'agent-pivot-with-a-very-long-repository-name';
    const longBranch = 'agent-pivot/fix-login-with-a-very-long-branch-name';
    const page = await openSurfacePage(surface({
        worktreeGroups: [groupRow({
            members: [
                member({
                    repositoryLabel: longLabel,
                    branchName: longBranch,
                }),
                member({
                    memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                    isPrimary: false,
                }),
            ],
            chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        })],
    }), 170);
    t.after(() => page.close());

    await page.evaluate(() => {
        setWorktreeGroupMemberDetailsExpanded(
            document.querySelector('.ai-session-worktree-group[data-group-id="g-1"]'), true);
    });
    const toggle = page.locator('[data-action="toggle-group-member-details"]');
    assert.match(await toggle.getAttribute('aria-label'), /collapse details/i,
        'the accessible name follows the toggle state');
    const detailsId = await toggle.getAttribute('aria-controls');
    assert.ok(detailsId, 'the toggle points at the details region');
    assert.equal(
        await page.locator('.ai-session-worktree-member-details').first().getAttribute('id'),
        detailsId);
    const layout = await page.evaluate(() => {
        const overflow = [];
        document.querySelectorAll('.ai-session-worktree-member-detail *').forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1)) {
                overflow.push(`${el.className} right=${rect.right.toFixed(1)}`);
            }
        });
        return {
            overflow,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
        };
    });
    assert.deepEqual(layout.overflow, [],
        'long repository/branch/path values ellipsize instead of clipping');
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1);
    assert.equal(
        await page.locator('.ai-session-worktree-member-detail-repo').first()
            .getAttribute('data-tooltip'),
        longLabel, 'the full repository label stays reachable via tooltip');
    assert.equal(
        await page.locator('.ai-session-worktree-member-detail-branch').first()
            .getAttribute('data-tooltip'),
        longBranch, 'the full branch name stays reachable via tooltip');
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

    const panel = page.locator('[data-ai-session-panel="chats"]');
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-main"]').count(), 1);
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-1"]').count(), 1);
    assert.equal(await panel.locator('.codex-session-row[data-session-id="s-manual"]').count(), 1);
    const unmanagedSection = panel.locator('.ai-session-worktree-unmanaged');
    assert.equal(await unmanagedSection.count(), 0,
        'no session is left over for the Unmanaged section');
});

test('WORKTREE-GROUPS-UI-001 collapse state is keyed independently for anchor and groups', async t => {
    const page = await openSurfacePage(surface({
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
    assert.equal(await row.locator('.ai-session-worktree-more').count(), 1,
        'M3: the group menu stays reachable (rename) while worktree-targeted '
        + 'items hide without a usable primary');
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
        worktreeGroups: [primaryPickerGroup],
    });
    const groupHtml = () =>
        `<div class="open-session-surface" data-open-session-surface data-id="project-a"`
        + ` data-current-workspace data-workspace-scope-identity="scope:current"`
        + ` data-workspace-navigation-identity="navigation:current">${sessionHtml()}</div>`;
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
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: groupFormScript });
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
    const groupHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a"`
        + ` data-current-workspace data-workspace-scope-identity="scope:current"`
        + ` data-workspace-navigation-identity="navigation:current">${sessionHtml}</div>`;
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

test('WORKTREE-GROUPS-ORDER-001 preserves rendered group order when attention clears', async t => {
    const renderedGroups = olderActivity => surface({
        worktreeGroups: [
            groupRow({ groupId: 'g-newer', displayName: 'newer task', activity: 'active' }),
            groupRow({
                groupId: 'g-older', displayName: 'older task', activity: olderActivity,
                members: [member({
                    memberId: 'm-older', path: '/alpha/.worktrees/older-task',
                    worktreeKey: {
                        repositoryKey: '/alpha/.git',
                        canonicalWorktreePath: '/alpha/.worktrees/older-task',
                    },
                })],
            }),
        ],
    });
    const initial = () => renderedGroups('attention');
    const settled = () => renderedGroups('active');
    const { page, applyUpdate, replacement } = await openGroupActionsPage(t, initial, settled);
    const groupIds = () => page.locator('.ai-session-worktree-task-group')
        .evaluateAll(rows => rows.map(row => row.getAttribute('data-group-id')));

    assert.deepEqual(await groupIds(), ['g-newer', 'g-older']);
    assert.equal(await applyUpdate(replacement()), true);
    assert.deepEqual(await groupIds(), ['g-newer', 'g-older']);
});

test('WORKTREE-GROUPS-ORDER-001 preserves unmanaged worktree order when attention clears', async t => {
    const worktrees = secondActivity => [
        {
            kind: 'ready',
            git: {
                key: {
                    repositoryKey: '/alpha/.git',
                    canonicalWorktreePath: '/alpha/.worktrees/first',
                },
                branchRef: 'refs/heads/first', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
            activity: 'active', sessions: [], authority: { canResume: true, canRemove: true },
        },
        {
            kind: 'ready',
            git: {
                key: {
                    repositoryKey: '/beta/.git',
                    canonicalWorktreePath: '/beta/.worktrees/second',
                },
                branchRef: 'refs/heads/second', head: 'b'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
            activity: secondActivity, sessions: [], authority: { canResume: true, canRemove: true },
        },
    ];
    const initial = () => surface({ worktrees: worktrees('attention') });
    const settled = () => surface({ worktrees: worktrees('active') });
    const { page, applyUpdate, replacement } = await openGroupActionsPage(t, initial, settled);
    const paths = () => page.locator('.ai-session-worktree-group:not(.ai-session-worktree-anchor)')
        .evaluateAll(rows => rows.map(row => row.getAttribute('data-worktree-path')));

    assert.deepEqual(await paths(), [
        '/alpha/.worktrees/first',
        '/beta/.worktrees/second',
    ]);
    assert.equal(await applyUpdate(replacement()), true);
    assert.deepEqual(await paths(), [
        '/alpha/.worktrees/first',
        '/beta/.worktrees/second',
    ]);
});

async function openGroupActionsPage(t, sessionHtml, replacementHtml) {
    const groupHtml = () =>
        `<div class="open-session-surface" data-open-session-surface data-id="project-a"`
        + ` data-current-workspace data-workspace-scope-identity="scope:current"`
        + ` data-workspace-navigation-identity="navigation:current">${sessionHtml()}</div>`;
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div id="dashboard-tab-open"><div class="sticky-groups-wrapper">${groupHtml()}</div></div>
        ${getAiSessionWorktreeMenu()}
    </body></html>`);
    await page.addStyleTag({ content: styles });
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.__writtenState = {};
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => window.__writtenState,
            setState(value) { window.__writtenState = value; },
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: groupFormScript });
    await page.addScriptTag({ content: controlsScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    const applyUpdate = html => page.evaluate(replacementHtml =>
        applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: 1,
            html: replacementHtml,
        }), html);
    const replacement = () => groupHtml().replace(
        sessionHtml(), (replacementHtml || sessionHtml)());
    return { page, applyUpdate, replacement };
}

test('WORKTREE-GROUPS-RENAME-001 member summary expands into per-member details and survives updates', async t => {
    const twoMemberGroup = () => groupRow({
        members: [
            member(),
            member({
                memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                branchName: 'agent-pivot/fix-login-beta',
                path: '/beta/.worktrees/fix-login', worktreeKey: betaLoginKey,
                isPrimary: false,
            }),
        ],
        chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
    });
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page, applyUpdate, replacement } = await openGroupActionsPage(t, sessionHtml);

    const toggle = page.locator('[data-action="toggle-group-member-details"]');
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const details = page.locator('.ai-session-worktree-member-details');
    assert.equal(await details.count(), 1);
    assert.equal(await details.first().isHidden(), true,
        'member details start collapsed');

    await toggle.evaluate(button => button.click());
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await details.first().isVisible(), true);
    const detailRows = page.locator('.ai-session-worktree-member-detail');
    assert.equal(await detailRows.count(), 2);
    const firstDetail = await detailRows.first().textContent();
    assert.ok(firstDetail.includes('alpha'));
    assert.ok(firstDetail.includes('agent-pivot/fix-login'));
    assert.ok(firstDetail.includes('/alpha/.worktrees/fix-login'));
    assert.equal(
        await detailRows.first().locator('.ai-session-worktree-member-detail-primary').count(),
        1, 'the primary member carries a badge');
    assert.equal(
        await detailRows.nth(1).locator('.ai-session-worktree-member-detail-primary').count(),
        0);

    const applied = await applyUpdate(replacement());
    assert.equal(applied, true);
    assert.equal(
        await page.locator('[data-action="toggle-group-member-details"]')
            .getAttribute('aria-expanded'),
        'true', 'the expansion survives the authoritative replacement');
    assert.equal(
        await page.locator('.ai-session-worktree-member-details').first().isVisible(), true);
    const persisted = await page.evaluate(() => window.__writtenState);
    assert.deepEqual(
        persisted.aiSessionExpandedGroupMembers['project-a'],
        [JSON.stringify(['group', 'g-1'])],
        'the expansion persists by stable group key');
});

test('WORKTREE-GROUPS-RENAME-001 renames a group inline through the settlement lifecycle', async t => {
    const renamedGroup = () => groupRow({ displayName: 'Fix login v2', revision: 2 });
    const sessionHtml = () => surface({
        worktreeGroups: [groupRow()],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const renameItem = menu.locator('[data-action="worktree-group-rename"]');
    assert.equal(await renameItem.isVisible(), true, 'group rows offer rename');
    assert.equal(
        await menu.locator('[data-action="worktree-quick-create"]').isVisible(), true,
        'a ready primary keeps the worktree session actions');

    await renameItem.evaluate(item => item.click());
    const input = page.locator('.ai-session-worktree-rename-input');
    assert.equal(await input.count(), 1);
    assert.equal(await input.inputValue(), 'fix-login');
    assert.equal(await page.locator(
        '.ai-session-worktree-group[data-group-id="g-1"] .ai-session-worktree-toolbar')
        .first().isHidden(), true, 'the toolbar hides while renaming');
    assert.equal(await page.evaluate(
        () => document.activeElement
            && document.activeElement.classList.contains('ai-session-worktree-rename-input')),
        true, 'the rename input takes focus');

    await input.fill('Fix login v2');
    await input.press('Enter');
    const renameMessage = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.match(renameMessage.requestId, /^group-rename-[a-z0-9]+-1$/,
        'the request id carries a per-document nonce');
    assert.deepEqual({ ...renameMessage, requestId: '<nonce>' }, {
        type: 'rename-worktree-group',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        displayName: 'Fix login v2',
        baseRevision: 1,
    });
    assert.equal(await input.evaluate(el => el.readOnly), true,
        'the submitted editor is pending (readonly keeps focus stable)');
    assert.equal(await page.evaluate(
        () => document.activeElement
            && document.activeElement.classList.contains('ai-session-worktree-rename-input')),
        true, 'readonly keeps the focus on the input');

    const postSettlement = status => page.evaluate(statusValue => {
        const request = window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').at(-1);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-rename-settlement',
                version: 1,
                requestId: request.requestId,
                projectId: request.projectId,
                groupId: request.groupId,
                status: statusValue,
                ...(statusValue === 'failed' ? { errorCode: 'group-not-found' } : {}),
            },
        }));
    }, status);
    await postSettlement('accepted');
    assert.equal(await input.evaluate(el => el.readOnly), true,
        'accepted keeps the pending state');
    await postSettlement('failed');
    assert.equal(await input.evaluate(el => el.readOnly), false,
        'a failed settlement re-enables the editor in place (no refresh on failure)');
    assert.match(
        await page.locator('[data-ai-session-live-region]').textContent(),
        /could not rename/i,
        'the failure is announced politely');

    await input.press('Enter');
    assert.equal(await input.evaluate(el => el.readOnly), true);
    await postSettlement('settled');
    assert.equal(await input.evaluate(el => el.readOnly), true,
        'settled keeps the editor pending until the replacement lands');
    const renamedHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a"`
        + ` data-current-workspace data-workspace-scope-identity="scope:current"`
        + ` data-workspace-navigation-identity="navigation:current">${surface({
            worktreeGroups: [renamedGroup()],
        })}</div>`;
    const applied = await applyUpdate(renamedHtml);
    assert.equal(applied, true);
    assert.equal(await page.locator('.ai-session-worktree-rename-input').count(), 0,
        'the authoritative replacement resolves the pending editor');
    assert.equal(
        await page.locator('.ai-session-worktree-group[data-group-id="g-1"]'
            + ' .ai-session-worktree-title').textContent(),
        'Fix login v2');
    assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return active && active.classList.contains('ai-session-worktree-header')
            && active.closest('.ai-session-worktree-group')
                ?.getAttribute('data-group-id') === 'g-1';
    }), true, 'a successful rename parks focus on the renamed group header');
});

test('WORKTREE-GROUPS-RENAME-001 a stale settlement cannot settle another document\'s request', async t => {
    // Reloads restart the request serial; a settlement from a previous
    // document must never correlate with a live request (review: cross-
    // document settlement mix-up).
    const sessionHtml = () => surface({
        worktreeGroups: [groupRow()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-group-rename"]')
        .evaluate(item => item.click());
    const input = page.locator('.ai-session-worktree-rename-input');
    await input.fill('Fix login v2');
    await input.press('Enter');
    assert.equal(await input.evaluate(el => el.readOnly), true);

    // A settlement naming a request this document never issued: ignored.
    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-rename-settlement',
                version: 1,
                requestId: 'group-rename-1',
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'failed',
                errorCode: 'group-not-found',
            },
        }));
    });
    assert.equal(await input.evaluate(el => el.readOnly), true,
        'a settlement with an unknown request id is ignored');

    // Same request id but a different project: also ignored.
    await page.evaluate(() => {
        const request = window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').at(-1);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-rename-settlement',
                version: 1,
                requestId: request.requestId,
                projectId: 'project-b',
                groupId: 'g-1',
                status: 'failed',
                errorCode: 'group-not-found',
            },
        }));
    });
    assert.equal(await input.evaluate(el => el.readOnly), true,
        'a settlement for another project is ignored');

    // A duplicate terminal settlement after failure must not disturb the
    // re-enabled editor either.
    await page.evaluate(() => {
        const request = window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').at(-1);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-rename-settlement',
                version: 1,
                requestId: request.requestId,
                projectId: request.projectId,
                groupId: request.groupId,
                status: 'failed',
                errorCode: 'group-not-found',
            },
        }));
    });
    assert.equal(await input.evaluate(el => el.readOnly), false,
        'the correlated failure re-enables the editor');
    await page.evaluate(() => {
        const request = window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').at(-1);
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-rename-settlement',
                version: 1,
                requestId: request.requestId,
                projectId: request.projectId,
                groupId: request.groupId,
                status: 'settled',
            },
        }));
    });
    assert.equal(await page.locator('.ai-session-worktree-rename-input').evaluate(el => el.readOnly),
        false, 'a duplicate settlement after the terminal one is ignored');
});

test('WORKTREE-GROUPS-RENAME-001 escape and unchanged input cancel without a message', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [groupRow()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-group-rename"]')
        .evaluate(item => item.click());
    const input = page.locator('.ai-session-worktree-rename-input');
    await input.fill('a different name');
    await input.press('Escape');
    assert.equal(await input.count(), 0, 'Escape abandons the edit');
    assert.equal(await page.locator(
        '.ai-session-worktree-group[data-group-id="g-1"] .ai-session-worktree-toolbar')
        .first().isVisible(), true, 'the toolbar returns');
    assert.equal(await page.evaluate(
        () => window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').length),
        0, 'no mutation was submitted');

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-group-rename"]')
        .evaluate(item => item.click());
    await page.locator('.ai-session-worktree-rename-input').press('Enter');
    assert.equal(await page.locator('.ai-session-worktree-rename-input').count(), 0,
        'an unchanged name closes the editor without submitting');
    assert.equal(await page.evaluate(
        () => window.__postedMessages
            .filter(message => message.type === 'rename-worktree-group').length),
        0);
});

test('WORKTREE-GROUPS-RENAME-001 the editor freezes the base revision it opened with', async t => {
    // Open the editor at revision 1; a concurrent mutation advances the
    // group to revision 2 and the replacement restores the editor — the
    // submit must still carry revision 1 so the host fails closed.
    const rev1Html = () => surface({
        worktreeGroups: [groupRow()],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, rev1Html);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-group-rename"]')
        .evaluate(item => item.click());
    const input = page.locator('.ai-session-worktree-rename-input');
    await input.fill('Fix login v2');

    const rev2Html = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${surface({
            worktreeGroups: [groupRow({ revision: 2 })],
        })}</div>`;
    const applied = await applyUpdate(rev2Html);
    assert.equal(applied, true);
    assert.equal(await page.locator('.ai-session-worktree-rename-input').count(), 1,
        'the unsubmitted editor survives the replacement');

    await page.locator('.ai-session-worktree-rename-input').press('Enter');
    const renameMessage = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.equal(renameMessage.baseRevision, 1,
        'the frozen revision travels with the restored editor');
});

test('WORKTREE-GROUPS-RENAME-001 a group without a ready primary still offers rename only', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [groupRow({
            canCreateSession: false,
            needsPrimarySelection: true,
            members: [member({
                status: 'missing', isPrimary: true,
                path: '/alpha/.worktrees/gone',
                worktreeKey: undefined,
            })],
        })],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);

    const more = page.locator('.ai-session-worktree-more[data-group-id="g-1"]');
    assert.equal(await more.count(), 1,
        'the group menu stays reachable without a ready primary');
    await more.evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    assert.equal(
        await menu.locator('[data-action="worktree-group-rename"]').isVisible(), true);
    assert.equal(
        await menu.locator('[data-action="worktree-quick-create"]').isHidden(), true,
        'session actions hide without a usable primary worktree');
    assert.equal(
        await menu.locator('[data-action="worktree-provider-create"]').first().isHidden(), true);
    assert.equal(
        await menu.locator('[data-action="worktree-branch-create"]').isHidden(), true);
    assert.equal(
        await menu.locator('[data-action="worktree-remove"]').isHidden(), true);
});

function twoMemberGroup(overrides) {
    return groupRow({
        primaryMemberId: undefined,
        members: [
            member(),
            member({
                memberId: 'm-2',
                repositoryKey: '/beta/.git',
                repositoryLabel: 'beta',
                branchName: 'agent-pivot/fix-login-2',
                path: '/beta/.worktrees/fix-login-2',
                isPrimary: false,
                worktreeKey: betaLoginKey,
            }),
        ],
        ...(overrides || {}),
    });
}


async function postAggregateRevisionPresentation(page, aggregateRevision, projectionRevision) {
    await page.evaluate(input => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'ai-session-presentation-state',
            version: 1,
            projectionRevision: input.projectionRevision,
            workspaceScopeIdentity: 'scope:current',
            workspaceNavigationIdentity: 'navigation:current',
            worktreeGroupsAggregateRevision: input.aggregateRevision,
            attentionCount: 0,
            activeAttentionCount: 0,
            runningSessionCount: 0,
            runningCardAnimation: 'current',
            runningIconAnimation: 'current',
            // The direct-presentation path requires revealFocused: true;
            // with no sessions in the harness it reveals nothing.
            revealFocused: true,
            focusedTarget: null,
            attentionSessions: [],
            sessions: [],
        } }));
    }, { aggregateRevision, projectionRevision });
}

async function expandMemberDetails(page, groupId) {
    await page.locator(
        `.ai-session-worktree-group[data-group-id="${groupId}"]`
        + ' [data-action="toggle-group-member-details"]'
    ).evaluate(button => button.click());
}

test('WORKTREE-GROUPS-MEMBER-DELETE-001 removes a member through the card settlement lifecycle', async t => {
    const withoutMember = () => surface({
        worktreeGroups: [twoMemberGroup({ members: [member()] })],
    });
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);

    await expandMemberDetails(page, 'g-1');
    const removeButton = page.locator(
        '[data-action="preview-group-member-deletion"][data-member-id="m-2"]');
    assert.equal(await removeButton.count(), 1, 'ready members offer removal');
    await removeButton.evaluate(button => button.click());

    const card = page.locator('.ai-session-worktree-deletion-card');
    assert.equal(await card.count(), 1, 'the loading card opens');
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.match(previewRequest.requestId, /^group-delete-preview-[a-z0-9]+-1$/,
        'preview request ids carry the per-document nonce');
    assert.deepEqual({ ...previewRequest, requestId: '<nonce>' }, {
        type: 'preview-worktree-group-deletion',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        mode: 'member',
        memberId: 'm-2',
    });

    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-2',
                    repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login-2',
                    branchName: 'agent-pivot/fix-login-2',
                    blocker: null,
                    historyCount: 2,
                    isPrimary: false,
                },
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    assert.match(await card.textContent(), /beta/);
    assert.match(await card.textContent(), /2 past sessions/);
    assert.match(await card.textContent(), /local branch is kept/);
    const confirm = card.locator('[data-action="confirm-group-member-deletion"]');
    assert.equal(await confirm.evaluate(button => button.disabled), false);

    await confirm.evaluate(button => button.click());
    const deleteRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual({ ...deleteRequest, requestId: '<nonce>' }, {
        type: 'delete-worktree-group-member',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        mode: 'member',
        memberId: 'm-2',
        baseRevision: 1,
    });
    assert.equal(await card.getAttribute('aria-busy'), 'true',
        'the submitted card is pending');

    const postSettlement = status => page.evaluate(({ requestId, statusValue }) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: statusValue,
                ...(statusValue === 'failed' ? { errorCode: 'worktree-active' } : {}),
                ...(statusValue === 'settled' || statusValue === 'partial'
                    ? { minimumAggregateRevision: 3 }
                    : {}),
            },
        }));
    }, { requestId: deleteRequest.requestId, statusValue: status });
    await postSettlement('accepted');
    assert.equal(await card.count(), 1, 'accepted keeps the card pending');
    await postSettlement('settled');
    assert.equal(await card.count(), 1,
        'settled keeps the card until the authoritative replacement');
    // The rendered aggregate must reach the settlement's bound revision
    // before any replacement may retire the pending card (decision J).
    await postAggregateRevisionPresentation(page, 3, 900);
    const renamedHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${withoutMember()}</div>`;
    assert.equal(await applyUpdate(renamedHtml), true);
    assert.equal(await card.count(), 0,
        'the replacement with the member gone retires the card');
    assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return active && active.classList.contains('ai-session-worktree-header');
    }), true, 'focus parks on the group header after the deletion');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 a blocked preview disables confirm and cancel restores focus', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await expandMemberDetails(page, 'g-1');
    await page.locator('[data-action="preview-group-member-deletion"][data-member-id="m-2"]')
        .evaluate(button => button.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-2',
                    repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login-2',
                    branchName: 'agent-pivot/fix-login-2',
                    blocker: 'worktree-active',
                    historyCount: 0,
                    isPrimary: false,
                },
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    const card = page.locator('.ai-session-worktree-deletion-card');
    assert.match(await card.textContent(), /an AI session is running/);
    assert.equal(await card.locator(
        '[data-action="confirm-group-member-deletion"]').evaluate(button => button.disabled),
        true, 'a blocked member cannot be confirmed');
    await card.locator('[data-action="cancel-group-member-deletion"]')
        .evaluate(button => button.click());
    assert.equal(await card.count(), 0, 'cancel removes the card');
    assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return active && active.getAttribute('data-action') === 'preview-group-member-deletion'
            && active.getAttribute('data-member-id') === 'm-2';
    }), true, 'focus returns to the remove button');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 deleting the primary requires a replacement choice', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await expandMemberDetails(page, 'g-1');
    await page.locator('[data-action="preview-group-member-deletion"][data-member-id="m-1"]')
        .evaluate(button => button.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-1',
                    repositoryLabel: 'alpha',
                    path: '/alpha/.worktrees/fix-login',
                    branchName: 'agent-pivot/fix-login',
                    blocker: null,
                    historyCount: 0,
                    isPrimary: true,
                },
                replacementRequired: true,
                replacementCandidates: [{ memberId: 'm-2', repositoryLabel: 'beta' }],
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    const card = page.locator('.ai-session-worktree-deletion-card');
    const confirm = card.locator('[data-action="confirm-group-member-deletion"]');
    assert.equal(await confirm.evaluate(button => button.disabled), true,
        'confirm stays disabled until a replacement is chosen');
    await card.locator('.ai-session-worktree-deletion-replacement')
        .evaluate(radio => radio.click());
    assert.equal(await confirm.evaluate(button => button.disabled), false);
    await confirm.evaluate(button => button.click());
    const deleteRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.equal(deleteRequest.replacementPrimaryMemberId, 'm-2');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 a partial settlement surfaces the Retry banner', async t => {
    const failedJournal = {
        operationId: 'op-1',
        pendingCount: 0,
        failedCount: 1,
    };
    const withBanner = () => surface({
        worktreeGroups: [twoMemberGroup({ deletion: failedJournal })],
    });
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);
    await expandMemberDetails(page, 'g-1');
    await page.locator('[data-action="preview-group-member-deletion"][data-member-id="m-2"]')
        .evaluate(button => button.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-2',
                    repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login-2',
                    branchName: 'agent-pivot/fix-login-2',
                    blocker: null,
                    historyCount: 0,
                    isPrimary: false,
                },
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    await page.locator('[data-action="confirm-group-member-deletion"]')
        .evaluate(button => button.click());
    const deleteRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'partial',
                minimumAggregateRevision: 2,
            },
        }));
    }, deleteRequest.requestId);
    await postAggregateRevisionPresentation(page, 2, 901);
    const bannerHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${withBanner()}</div>`;
    assert.equal(await applyUpdate(bannerHtml), true);
    assert.equal(await page.locator('.ai-session-worktree-deletion-card').count(), 0,
        'the card retires when the banner takes over');
    const banner = page.locator('.ai-session-worktree-deletion[data-operation-id="op-1"]');
    assert.equal(await banner.count(), 1, 'the Retry banner is visible');
    await banner.locator('[data-action="retry-group-deletion"]')
        .evaluate(button => button.click());
    const retryRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual({ ...retryRequest, requestId: '<nonce>' }, {
        type: 'retry-worktree-group-deletion',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        operationId: 'op-1',
    });
    assert.equal(await banner.locator('[data-action="retry-group-deletion"]')
        .evaluate(button => button.disabled), true,
        'the banner is pending while the retry runs');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 the deletion card stays contained at 170px', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml, undefined);
    await page.setViewportSize({ width: 170, height: 900 });
    await expandMemberDetails(page, 'g-1');
    await page.locator('[data-action="preview-group-member-deletion"][data-member-id="m-2"]')
        .evaluate(button => button.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-2',
                    repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login-2',
                    branchName: 'agent-pivot/fix-login-2',
                    blocker: null,
                    historyCount: 12,
                    isPrimary: false,
                },
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    const card = page.locator('.ai-session-worktree-deletion-card');
    assert.equal(await card.count(), 1);
    const overflow = await page.evaluate(() => {
        const cardEl = document.querySelector('.ai-session-worktree-deletion-card');
        const project = cardEl.closest('[data-open-session-surface]');
        return cardEl.getBoundingClientRect().right
            > project.getBoundingClientRect().right + 1;
    });
    assert.equal(overflow, false, 'the card never overflows the card column at 170px');
    assert.equal(await card.locator('[data-action="confirm-group-member-deletion"]')
        .isVisible(), true, 'confirm stays reachable at 170px');
});

test('WORKTREE-GROUPS-GROUP-DELETE-001 removes the whole group through the card and restores focus', async t => {
    const withoutGroup = () => surface({
        worktreeGroups: [],
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
    });
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const deleteItem = menu.locator('[data-action="worktree-group-delete"]');
    assert.equal(await deleteItem.isVisible(), true, 'group rows offer group deletion');
    await deleteItem.evaluate(item => item.click());

    const card = page.locator('.ai-session-worktree-deletion-card');
    assert.equal(await card.count(), 1, 'the loading card opens');
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual({ ...previewRequest, requestId: '<nonce>' }, {
        type: 'preview-worktree-group-deletion',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        mode: 'group',
    });
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                mode: 'group',
                status: 'ready',
                members: [
                    {
                        memberId: 'm-1', repositoryLabel: 'alpha',
                        path: '/alpha/.worktrees/fix-login',
                        branchName: 'agent-pivot/fix-login',
                        blocker: null, historyCount: 1, isPrimary: true,
                    },
                    {
                        memberId: 'm-2', repositoryLabel: 'beta',
                        path: '/beta/.worktrees/fix-login-2',
                        branchName: 'agent-pivot/fix-login-2',
                        blocker: null, historyCount: 2, isPrimary: false,
                    },
                ],
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    assert.match(await card.textContent(), /Remove all 2 worktrees/);
    assert.match(await card.textContent(), /3 past sessions/);
    assert.match(await card.textContent(), /alpha \(agent-pivot\/fix-login\)/);
    assert.match(await card.textContent(), /beta \(agent-pivot\/fix-login-2\)/);
    // Whole-group deletion never asks for a replacement primary (PRD §6.4).
    assert.equal(await card.locator('.ai-session-worktree-deletion-replacement').count(), 0);

    await card.locator('[data-action="confirm-group-member-deletion"]')
        .evaluate(button => button.click());
    const deleteRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual({ ...deleteRequest, requestId: '<nonce>' }, {
        type: 'delete-worktree-group-member',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        groupId: 'g-1',
        mode: 'group',
        baseRevision: 1,
    });
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'settled',
                minimumAggregateRevision: 2,
            },
        }));
    }, deleteRequest.requestId);
    await postAggregateRevisionPresentation(page, 2, 902);
    const clearedHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${withoutGroup()}</div>`;
    assert.equal(await applyUpdate(clearedHtml), true);
    assert.equal(await page.locator('.ai-session-worktree-task-group').count(), 0,
        'the group row is gone');
    assert.equal(await page.locator('.ai-session-worktree-deletion-card').count(), 0,
        'the card retired with the group');
    assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return !!(active && active.closest('.ai-session-worktree-anchor'));
    }), true, 'focus falls to the next group or the Current anchor');
});

test('WORKTREE-GROUPS-GROUP-DELETE-001 detached members block whole-group deletion with a visible-only alternative', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-group-delete"]')
        .evaluate(item => item.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                mode: 'group',
                status: 'ready',
                members: [{
                    memberId: 'm-1', repositoryLabel: 'alpha',
                    path: '/alpha/.worktrees/fix-login',
                    branchName: 'agent-pivot/fix-login',
                    blocker: null, historyCount: 0, isPrimary: true,
                }],
                detachedCount: 1,
                wholeGroupBlocked: true,
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    const card = page.locator('.ai-session-worktree-deletion-card');
    assert.match(await card.textContent(), /outside the workspace/);
    assert.equal(await card.locator('[data-action="confirm-group-member-deletion"]')
        .evaluate(button => button.disabled), true,
        'whole-group deletion stays disabled with detached members');
    const visibleOnly = card.locator('[data-action="preview-group-visible-deletion"]');
    assert.equal(await visibleOnly.count(), 1, 'the visible-only alternative is offered');
    await visibleOnly.evaluate(button => button.click());
    const switchRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.equal(switchRequest.type, 'preview-worktree-group-deletion');
    assert.equal(switchRequest.mode, 'visible-only');
});

test('WORKTREE-GROUPS-DERIVE-001 derives a group through the prefilled inline form', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const deriveItem = menu.locator('[data-action="worktree-group-derive"]');
    assert.equal(await deriveItem.isVisible(), true, 'group rows offer derive');
    await deriveItem.evaluate(item => item.click());

    const openRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual(openRequest, {
        type: 'open-worktree-group-form',
        version: 1,
        projectId: 'project-a',
        sourceGroupId: 'g-1',
    }, 'the derive entry binds the source group');

    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-form-state',
                version: 1,
                projectId: 'project-a',
                derive: {
                    sourceGroupId: 'g-1',
                    sourceName: 'fix-login',
                    suggestedName: 'fix-login-2',
                    checkedRepositories: ['/alpha/.git'],
                    baseOverrides: {
                        '/alpha/.git': 'refs/heads/agent-pivot/fix-login',
                    },
                    skipped: [{
                        repositoryLabel: 'beta',
                        reason: 'repository not in workspace',
                    }],
                },
                repositories: [
                    {
                        repositoryKey: '/alpha/.git',
                        label: 'alpha',
                        defaultBaseRef: 'refs/heads/main',
                        localBranches: ['main', 'agent-pivot/fix-login'],
                        defaultChecked: false,
                        setupCommand: [],
                    },
                    {
                        repositoryKey: '/beta/.git',
                        label: 'beta',
                        defaultBaseRef: 'refs/heads/main',
                        localBranches: ['main'],
                        defaultChecked: true,
                        setupCommand: [],
                    },
                ],
            },
        }));
    });
    const form = page.locator('[data-worktree-group-form]');
    assert.equal(await form.count(), 1, 'the derive form opens inline');
    assert.match(await form.locator('.ai-session-group-form-title').textContent(),
        /Derive from fix-login/);
    assert.equal(await page.locator('[data-group-form-name]').inputValue(), 'fix-login-2',
        'the default name is the source name with -2');
    assert.equal(
        await form.locator('[data-group-form-check="\/alpha\/.git"]').isChecked(), true,
        'source member repositories are prechecked');
    assert.equal(
        await form.locator('[data-group-form-check="\/beta\/.git"]').isChecked(), false,
        'skipped repositories stay unchecked');
    assert.match(await form.textContent(), /beta \(repository not in workspace\)/,
        'skipped members are noted with their reason');
    // The preview binds the source group for revision drift detection.
    const previewRequest = await page.evaluate(() => window.__postedMessages
        .filter(message => message.type === 'preview-worktree-group').at(-1));
    assert.equal(previewRequest.sourceGroupId, 'g-1');
    assert.deepEqual(previewRequest.selections, [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/agent-pivot/fix-login',
    }], 'the base ref is overridden to the source branch');
});

test('WORKTREE-GROUPS-ADD-REPO-001 adds a repository through the locked-name inline form', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);

    await page.locator('.ai-session-worktree-more[data-group-id="g-1"]')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const addRepoItem = menu.locator('[data-action="worktree-group-add-repo"]');
    assert.equal(await addRepoItem.isVisible(), true, 'group rows offer add-repo');
    await addRepoItem.evaluate(item => item.click());

    const openRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.deepEqual(openRequest, {
        type: 'open-worktree-group-form',
        version: 1,
        projectId: 'project-a',
        targetGroupId: 'g-1',
    });

    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-form-state',
                version: 1,
                projectId: 'project-a',
                addRepo: { groupId: 'g-1', displayName: 'fix-login' },
                repositories: [
                    {
                        repositoryKey: '/gamma/.git',
                        label: 'gamma',
                        defaultBaseRef: 'refs/heads/main',
                        localBranches: ['main'],
                        defaultChecked: true,
                        setupCommand: [],
                    },
                    {
                        repositoryKey: '/delta/.git',
                        label: 'delta',
                        defaultBaseRef: 'refs/heads/main',
                        localBranches: ['main'],
                        defaultChecked: false,
                        setupCommand: [],
                    },
                ],
            },
        }));
    });
    const form = page.locator('[data-worktree-group-form]');
    assert.equal(await form.count(), 1, 'the add-repo form opens inline');
    assert.match(await form.locator('.ai-session-group-form-title').textContent(),
        /Add repositories to fix-login/);
    const nameInput = page.locator('[data-group-form-name]');
    assert.equal(await nameInput.inputValue(), 'fix-login');
    assert.equal(await nameInput.evaluate(input => input.readOnly), true,
        'the group name is locked');
    assert.equal(await form.locator('[data-group-form-check]').count(), 2,
        'only eligible repositories are listed');
    assert.equal(
        await form.locator('[data-group-form-check="\\/gamma\\/.git"]').isChecked(), true,
        'the active editor repository is prechecked');
    assert.equal(
        await form.locator('[data-group-form-check="\\/delta\\/.git"]').isChecked(), false,
        'other eligible repositories stay unchecked');
    const previewRequest = await page.evaluate(() => window.__postedMessages
        .filter(message => message.type === 'preview-worktree-group').at(-1));
    assert.equal(previewRequest.targetGroupId, 'g-1',
        'the preview binds the target group');
    // Confirm echoes the bound target.
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                previewId: 'preview-host-1',
                slug: 'fix-login',
                members: [{
                    repositoryKey: '/gamma/.git', label: 'gamma',
                    baseRef: 'refs/heads/main',
                    branchName: 'agent-pivot/fix-login',
                    worktreePath: '/gamma/.worktrees/fix-login',
                    setupCommand: [],
                    preflight: 'ok',
                }],
            },
        }));
    }, previewRequest.requestId);
    const confirm = form.locator('[data-group-form-action="confirm"]');
    assert.equal(await confirm.isEnabled(), true);
    await confirm.evaluate(button => button.click());
    const confirmRequest = await page.evaluate(() => window.__postedMessages
        .filter(message => message.type === 'confirm-worktree-group').at(-1));
    assert.equal(confirmRequest.targetGroupId, 'g-1');
    assert.equal(confirmRequest.displayName, 'fix-login',
        'the locked name is confirmed, not a user edit');
});

test('WORKTREE-GROUPS-ADD-REPO-001 the scope-outdated note renders on the group row', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup({ scopeOutdatedSessions: 2 })],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    const note = page.locator('.ai-session-worktree-scope-outdated');
    assert.equal(await note.count(), 1);
    assert.match(await note.textContent(), /2 sessions cannot write the new worktree/);
    assert.match(await note.textContent(), /restart to pick it up/);
});

test('WORKTREE-GROUPS-ADOPT-MERGE-001 adopts a cluster through the card settlement lifecycle', async t => {
    const suggestions = [{
        slug: 'fix-login',
        members: [
            {
                worktreeKey: alphaLoginKey,
                branchName: 'agent-pivot/fix-login',
                repositoryLabel: 'alpha',
            },
            {
                worktreeKey: betaLoginKey,
                branchName: 'agent-pivot/fix-login',
                repositoryLabel: 'beta',
            },
        ],
    }];
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
        worktreeAdoptSuggestions: suggestions,
    });
    const withoutSuggestion = () => surface({
        worktreeGroups: [twoMemberGroup(), groupRow({
            groupId: 'g-2', displayName: 'fix-login', revision: 1,
        })],
        worktreeAdoptSuggestions: [],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);

    const bar = page.locator('.ai-session-worktree-adopt-suggestion[data-adopt-slug="fix-login"]');
    assert.equal(await bar.count(), 1, 'the suggestion bar renders');
    assert.match(await bar.textContent(), /Adopt 2 worktrees as “fix-login”/);
    await bar.locator('[data-action="adopt-worktree-cluster"]')
        .evaluate(button => button.click());
    const card = page.locator('.ai-session-worktree-adopt-card');
    assert.equal(await card.count(), 1, 'the adopt card opens');
    assert.equal(await card.locator('.ai-session-worktree-adopt-member-check').count(), 2);
    assert.equal(await card.locator('.ai-session-worktree-adopt-name').inputValue(),
        'fix-login', 'the name defaults to the slug');
    // Existing groups are offered as adopt targets.
    assert.match(await card.locator('.ai-session-worktree-adopt-target').textContent(),
        /Add to: fix-login/);
    await card.locator('[data-action="confirm-worktree-adopt"]')
        .evaluate(button => button.click());
    const adoptRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.match(adoptRequest.requestId, /^adopt-[a-z0-9]+-1$/);
    assert.deepEqual({ ...adoptRequest, requestId: '<nonce>' }, {
        type: 'adopt-worktrees',
        version: 1,
        requestId: '<nonce>',
        projectId: 'project-a',
        members: [
            {
                repositoryKey: '/alpha/.git',
                canonicalWorktreePath: '/alpha/.worktrees/fix-login',
            },
            {
                repositoryKey: '/beta/.git',
                canonicalWorktreePath: '/beta/.worktrees/fix-login',
            },
        ],
        displayName: 'fix-login',
    });
    assert.equal(await card.getAttribute('aria-busy'), 'true', 'the card is pending');
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-adopt-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                status: 'settled',
                groupId: 'g-2',
            },
        }));
    }, adoptRequest.requestId);
    assert.equal(await card.count(), 1, 'settled keeps the card until the replacement');
    const adoptedHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${withoutSuggestion()}</div>`;
    assert.equal(await applyUpdate(adoptedHtml), true);
    assert.equal(await page.locator('.ai-session-worktree-adopt-card').count(), 0,
        'the replacement with the suggestion gone retires the card');
    assert.equal(await page.locator('.ai-session-worktree-adopt-suggestion').count(), 0);
});

test('WORKTREE-GROUPS-ADOPT-MERGE-001 a failed adopt re-enables the card in place', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [],
        worktreeAdoptSuggestions: [{
            slug: 'solo',
            members: [{
                worktreeKey: alphaLoginKey,
                branchName: 'agent-pivot/solo',
                repositoryLabel: 'alpha',
            }],
        }],
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await page.locator('[data-action="adopt-worktree-cluster"]')
        .evaluate(button => button.click());
    const card = page.locator('.ai-session-worktree-adopt-card');
    await card.locator('[data-action="confirm-worktree-adopt"]')
        .evaluate(button => button.click());
    const adoptRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-adopt-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                status: 'failed',
                errorCode: 'worktree-key-claimed',
            },
        }));
    }, adoptRequest.requestId);
    assert.equal(await card.locator('[data-action="confirm-worktree-adopt"]')
        .evaluate(button => button.disabled), false,
        'the card is re-enabled after a failed settlement');
    assert.match(
        await page.locator('[data-ai-session-live-region]').textContent(),
        /could not adopt/i);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 pending clears only after the rendered aggregate reaches the settlement revision', async t => {
    const sessionHtml = () => surface({
        worktreeGroups: [twoMemberGroup()],
    });
    const withoutMember = () => surface({
        worktreeGroups: [twoMemberGroup({ members: [member()] })],
    });
    const { page, applyUpdate } = await openGroupActionsPage(t, sessionHtml);
    await expandMemberDetails(page, 'g-1');
    await page.locator('[data-action="preview-group-member-deletion"][data-member-id="m-2"]')
        .evaluate(button => button.click());
    const previewRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-preview',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'ready',
                member: {
                    memberId: 'm-2', repositoryLabel: 'beta',
                    path: '/beta/.worktrees/fix-login-2',
                    branchName: 'agent-pivot/fix-login-2',
                    blocker: null, historyCount: 0, isPrimary: false,
                },
                groupRevision: 1,
            },
        }));
    }, previewRequest.requestId);
    await page.locator('[data-action="confirm-group-member-deletion"]')
        .evaluate(button => button.click());
    const deleteRequest = await page.evaluate(() => window.__postedMessages.at(-1));
    // Settle with a minimum revision beyond anything rendered so far.
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'worktree-group-deletion-settlement',
                version: 1,
                requestId,
                projectId: 'project-a',
                groupId: 'g-1',
                status: 'settled',
                minimumAggregateRevision: 99,
            },
        }));
    }, deleteRequest.requestId);
    // The authoritative replacement shows the member gone, but no
    // presentation at revision ≥ 99 has been rendered: the card must stay.
    const clearedHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">${withoutMember()}</div>`;
    assert.equal(await applyUpdate(clearedHtml), true);
    assert.equal(await page.locator('.ai-session-worktree-deletion-card').count(), 1,
        'the pending card survives a replacement below the bound revision');
    // A presentation at the bound revision lands: the NEXT replacement
    // retires the card.
    await postAggregateRevisionPresentation(page, 99, 903);
    assert.equal(await applyUpdate(clearedHtml), true);
    assert.equal(await page.locator('.ai-session-worktree-deletion-card').count(), 0,
        'once the rendered aggregate reaches the bound revision, the card retires');
});

test('WORKTREE-GROUPS-UI-001 the actions menu closes when the webview loses focus', async t => {
    // VS Code forwards no outside clicks into the webview: the menu must
    // close on window blur (e.g. the user clicked into the editor).
    const sessionHtml = () => surface({
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    assert.equal(await menu.evaluate(el => el.classList.contains('visible')), true);
    await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
    });
    assert.equal(await menu.evaluate(el => el.classList.contains('visible')), false,
        'the menu closes on webview blur');
});

test('WORKTREE-GROUPS-UI-001 a single-root anchor menu offers branch-seeded worktree creation', async t => {
    const sessionHtml = () => surface({
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [alphaMainKey],
            sessions: [],
            activity: 'idle',
        },
    });
    const { page } = await openGroupActionsPage(t, sessionHtml);
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    const menu = page.locator('#aiSessionWorktreeMenu');
    const branchItem = menu.locator('[data-action="worktree-branch-create"]');
    assert.equal(await branchItem.isVisible(), true,
        'single-root anchors offer New worktree from Current');
    assert.match(await branchItem.textContent(), /New worktree from Current/);
    assert.equal(await menu.locator('[data-action="worktree-new"]').isHidden(), true,
        'the plain entry hides when the seeded one exists');
    await branchItem.evaluate(item => item.click());
    const openRequest = (await page.evaluate(() => window.__postedMessages))
        .find(message => message.type === 'open-worktree-group-form');
    assert.deepEqual(openRequest, {
        type: 'open-worktree-group-form',
        version: 1,
        projectId: 'project-a',
        seedRepositoryKey: '/alpha/.git',
        seedWorktreePath: '/alpha/main',
    }, 'the seeded form opens from the current branch');
    // Sessions created from the anchor menu stay keyless (main checkout).
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-provider-create"][data-provider="kimi"]')
        .evaluate(item => item.click());
    const created = (await page.evaluate(() => window.__postedMessages))
        .filter(message => message.type === 'create-ai-session-quick');
    assert.equal(created.length, 1);
    assert.equal(created[0].provider, 'kimi');
    assert.equal(created[0].worktreeKey, undefined,
        'anchor sessions never carry the main-checkout worktree key');
});
