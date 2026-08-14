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

test('WORKTREE-GROUPS-UI-001 renders the anchor row with labeled real branches and no actions', async t => {
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
    assert.ok(tooltip.includes('alpha: main'));
    assert.ok(tooltip.includes('beta: 1.0'),
        'full per-repository branch detail is one hover away');
    assert.equal(await anchor.locator('.ai-session-worktree-more').count(), 0,
        'the anchor is not a managed worktree');
    assert.equal(await anchor.locator('[data-action="create-ai-session-quick"]').count(), 0);
    assert.equal(
        await anchor.locator('.codex-session-row[data-session-id="s-main"]').count(), 1,
        'main-checkout sessions collect under the anchor');
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
