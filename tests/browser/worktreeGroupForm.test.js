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
const readScript = name => fs.readFileSync(
    path.join(__dirname, '../../src/webview', name), 'utf8');

const alphaLoginKey = {
    repositoryKey: '/alpha/.git',
    canonicalWorktreePath: '/alpha/.worktrees/fix-login',
};

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
        worktreeAnchor: {
            entries: [
                { repositoryLabel: 'alpha', branch: 'main' },
                { repositoryLabel: 'beta', branch: 'main' },
            ],
            worktreeKeys: [
                { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/main' },
                { repositoryKey: '/beta/.git', canonicalWorktreePath: '/beta/main' },
            ],
            sessions: [],
            activity: 'idle',
        },
        worktrees: [],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 2,
        bareWorktreeCount: 0,
        ...(overrides || {}),
    });
}

function repositoryOptions(alphaOverrides) {
    return [
        {
            repositoryKey: '/alpha/.git', label: 'alpha',
            defaultBaseRef: 'refs/heads/main',
            localBranches: ['main', 'release/1.0'],
            remoteBranches: ['origin/feature/remote-base'],
            defaultChecked: true,
            setupCommand: ['npm', 'ci'],
            ...(alphaOverrides || {}),
        },
        {
            repositoryKey: '/beta/.git', label: 'beta',
            defaultBaseRef: 'refs/heads/1.0',
            localBranches: ['1.0', 'main'],
            defaultChecked: false,
            setupCommand: [],
        },
    ];
}

let browser;
test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function currentGroupHtml() {
    return `<div class="open-session-surface" data-open-session-surface data-id="project-a"`
        + ` data-current-workspace data-workspace-scope-identity="scope:current"`
        + ` data-workspace-navigation-identity="navigation:current">${surface()}</div>`;
}

// The OPEN tab shell: the persistent WINDOWS switcher above the lifted
// current-session surface.
function openWindowSwitcherHtml() {
    return getOpenWindowSwitcherGroupContent(buildOpenWindowRowViewModels([{
        id: 'project-a',
        kind: 'current',
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: 'navigation:current',
        scopeIdentity: 'scope:current',
        name: 'Project A',
        environment: 'local',
        environmentLabel: 'Local',
        color: '',
        roots: [{ id: 'root-project-a', name: 'Project A', ordinal: 0 }],
        attentionCount: 0,
    }]), 'ready');
}

function presentationMessage(projectionRevision) {
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision,
        workspaceScopeIdentity: 'scope:current',
        workspaceNavigationIdentity: 'navigation:current',
        attentionCount: 0,
        activeAttentionCount: 0,
        runningSessionCount: 0,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: null,
        sessions: [],
        attentionSessions: [],
    };
}

async function openFormPage(t) {
    const groupHtml = currentGroupHtml();
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div id="dashboard-tab-open"><div class="sticky-groups-wrapper">${groupHtml}</div></div>
        ${getAiSessionWorktreeMenu()}
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
    for (const name of [
        'webviewAiSessionViewStateScripts.js',
        'webviewScrollStateScripts.js',
        'webviewWorkspaceUpdateScripts.js',
        'webviewProjectCollapseScripts.js',
        'webviewProjectContextMenuScripts.js',
        'webviewProjectAiUpdateScripts.js',
        'webviewGroupFormScripts.js',
        'webviewProjectAiSessionControlsScripts.js',
        'webviewProjectScripts.js',
    ]) {
        await page.addScriptTag({ content: readScript(name) });
    }
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

async function postedMessages(page) {
    return page.evaluate(() => window.__postedMessages);
}

async function postHostMessage(page, message) {
    await page.evaluate(value => {
        window.dispatchEvent(new MessageEvent('message', { data: value }));
    }, message);
}

async function openBootstrappedForm(page, options) {
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    const openRequest = (await postedMessages(page))
        .find(message => message.type === 'open-worktree-group-form');
    assert.ok(openRequest, 'the anchor menu opens the inline form');
    assert.equal(openRequest.version, 1);
    await postHostMessage(page, {
        type: 'worktree-group-form-state',
        version: 1,
        projectId: 'project-a',
        repositories: options || repositoryOptions(),
    });
}

async function answerPreview(page, members) {
    const request = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.ok(request, 'a preview request was sent');
    await postHostMessage(page, {
        type: 'worktree-group-preview',
        version: 1,
        requestId: request.requestId,
        projectId: 'project-a',
        previewId: 'preview-host-1',
        slug: 'fix-login',
        members,
    });
    return request;
}

function okMembers() {
    return [{
        repositoryKey: '/alpha/.git', label: 'alpha',
        baseRef: 'refs/heads/main',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/alpha/.worktrees/fix-login',
        setupCommand: ['npm', 'ci'],
        preflight: 'ok',
    }];
}

test('WORKTREE-GROUPS-CREATE-UI-001 both authoritative replacement paths reconcile the form', () => {
    // applyOpenWorkspacesUpdate swaps the whole wrapper innerHTML; the
    // ai-sessions path replaces the current-workspace group. Both must
    // re-render an open form or the card silently vanishes mid-editing.
    const projectScripts = readScript('webviewProjectScripts.js');
    assert.match(projectScripts,
        /open-workspaces-updated[\s\S]{0,1500}worktreeGroupForm\.reconcileDom\(\)/);
    const updateScripts = readScript('webviewProjectAiUpdateScripts.js');
    assert.match(updateScripts, /reconcileWorktreeGroupFormDom\(\)/);
});

test('WORKTREE-GROUPS-CREATE-UI-001 opens inline, previews, and confirms the exact preview values', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const form = page.locator('[data-worktree-group-form]');
    assert.equal(await form.count(), 1, 'the form renders inline in the panel');
    assert.equal(await form.locator('[data-group-form-check]').count(), 2);
    assert.equal(
        await form.locator('[data-group-form-check="/alpha/.git"]').isChecked(), true,
        'the default repository is checked');
    assert.equal(
        await form.locator('[data-group-form-check="/beta/.git"]').isChecked(), false);

    await page.locator('[data-group-form-name]').fill('Fix login');
    await page.waitForTimeout(350);
    const previewRequest = await answerPreview(page, okMembers());
    assert.equal(previewRequest.displayName, 'Fix login');
    assert.deepEqual(previewRequest.selections, [{ repositoryKey: '/alpha/.git' }],
        'only checked repositories are previewed');

    assert.match(
        await form.locator('.ai-session-group-form-plan').textContent(),
        /\/alpha\/\.worktrees\/fix-login/,
        'the plan preview renders');
    const confirm = form.locator('[data-group-form-action="confirm"]');
    assert.equal(await confirm.isEnabled(), true);

    await confirm.evaluate(button => button.click());
    const confirmRequest = (await postedMessages(page))
        .find(message => message.type === 'confirm-worktree-group');
    assert.ok(confirmRequest);
    assert.deepEqual(confirmRequest.members, [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/main',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/alpha/.worktrees/fix-login',
        setupEnabled: true,
    }], 'the host receives exactly the previewed values, with setup as a toggle only');
    assert.equal(confirmRequest.primaryRepositoryKey, '/alpha/.git');
    assert.equal(confirmRequest.previewId, 'preview-host-1',
        'the confirm references the authoritative preview snapshot');

    await postHostMessage(page, {
        type: 'worktree-group-creation-settlement',
        version: 1,
        requestId: confirmRequest.requestId,
        status: 'created',
        groupId: 'g-new',
    });
    assert.equal(await page.locator('[data-worktree-group-form]').count(), 0,
        'a created settlement closes the form');
});

test('WORKTREE-GROUPS-CREATE-UI-001 preflight failures gate confirm and offer the available subset', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    // Check both repositories, then preview with beta blocked.
    await page.locator('[data-group-form-check="/beta/.git"]').evaluate(box => {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('[data-group-form-name]').fill('Fix login');
    await page.waitForTimeout(350);
    await answerPreview(page, [
        okMembers()[0],
        {
            repositoryKey: '/beta/.git', label: 'beta',
            baseRef: 'refs/heads/1.0',
            branchName: '', worktreePath: '',
            setupCommand: [],
            preflight: { code: 'repository-has-no-commits' },
        },
    ]);

    const form = page.locator('[data-worktree-group-form]');
    assert.equal(await form.locator('[data-group-form-action="confirm"]').isDisabled(), true,
        'plain confirm is disabled while any member is blocked');
    assert.match(await form.locator('.ai-session-group-form-preflight').textContent(),
        /no commits/);
    const betaBase = form.locator('[data-group-form-base="/beta/.git"]');
    assert.equal(await betaBase.getAttribute('aria-invalid'), 'true',
        'the blocked member control carries aria-invalid');
    assert.match(await betaBase.getAttribute('aria-errormessage') || '',
        /group-form-preflight-/,
        'the preflight error is referenced from the member control');
    // The expanded filter input keeps the association (a11y review).
    await betaBase.evaluate(button => button.click());
    const filterInput = page.locator('[data-group-form-base-filter="/beta/.git"]');
    assert.equal(await filterInput.getAttribute('aria-invalid'), 'true');
    assert.match(await filterInput.getAttribute('aria-errormessage') || '',
        /group-form-preflight-/);
    await page.keyboard.press('Escape');
    const available = form.locator('[data-group-form-action="confirm-available"]');
    assert.match(await available.textContent(), /available 1\/2/);

    await available.evaluate(button => button.click());
    const confirmRequest = (await postedMessages(page))
        .find(message => message.type === 'confirm-worktree-group');
    assert.deepEqual(confirmRequest.members.map(member => member.repositoryKey),
        ['/alpha/.git'],
        'the explicit action skips the blocked repository');
});

test('WORKTREE-GROUPS-CREATE-UI-001 Esc keeps unsubmitted input and stale previews are discarded', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    await page.locator('[data-group-form-name]').fill('First name');
    await page.waitForTimeout(350);
    const firstRequest = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    await page.locator('[data-group-form-name]').fill('Second name');
    await page.waitForTimeout(350);
    // The response to the first (stale) request must not apply.
    await postHostMessage(page, {
        type: 'worktree-group-preview',
        version: 1,
        requestId: firstRequest.requestId,
        projectId: 'project-a',
        previewId: 'preview-host-0',
        slug: 'first-name',
        members: okMembers(),
    });
    const confirm = page.locator('[data-group-form-action="confirm"]');
    assert.equal(await confirm.isDisabled(), true,
        'a stale preview response never enables confirm');
    await answerPreview(page, okMembers());
    assert.equal(await confirm.isEnabled(), true);

    await page.locator('[data-group-form-name]').press('Escape');
    assert.equal(await page.locator('[data-worktree-group-form]').count(), 0,
        'Esc closes the form');
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    await postHostMessage(page, {
        type: 'worktree-group-form-state',
        version: 1,
        projectId: 'project-a',
        repositories: repositoryOptions(),
    });
    assert.equal(await page.locator('[data-group-form-name]').inputValue(), 'Second name',
        'reopening keeps the unsubmitted input');
});

test('WORKTREE-GROUPS-CREATE-UI-001 branch-from-here seeds the repository and base ref', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);
    // Simulate the seeded form state the host sends for branch-from-here.
    await page.locator('[data-group-form-action="close"]').evaluate(button => button.click());
    await page.evaluate(() => {
        window.__groupFormSeed = true;
    });
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    await postHostMessage(page, {
        type: 'worktree-group-form-state',
        version: 1,
        projectId: 'project-a',
        seed: { repositoryKey: '/beta/.git', baseRef: 'refs/heads/topic/seeded' },
        repositories: repositoryOptions(),
    });
    assert.equal(
        await page.locator('[data-group-form-check="/beta/.git"]').isChecked(), true,
        'the seeded repository is checked');
    assert.equal(
        await page.locator('[data-group-form-check="/alpha/.git"]').isChecked(), false,
        'other repositories stay unchecked for a seeded form');
});

test('WORKTREE-GROUPS-CREATE-UI-001 select-all and Clear drive the member checkboxes', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const tools = page.locator('.ai-session-group-form-tools');
    assert.equal(await tools.count(), 1, 'multi-repo forms offer bulk selection');
    await tools.locator('[data-group-form-action="select-all"]')
        .evaluate(button => button.click());
    assert.equal(await page.locator('[data-group-form-check="/beta/.git"]').isChecked(), true);
    await tools.locator('[data-group-form-action="select-none"]')
        .evaluate(button => button.click());
    assert.equal(await page.locator('[data-group-form-check="/alpha/.git"]').isChecked(), false);
    await page.waitForTimeout(50);
    const lastPreview = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.deepEqual(lastPreview.selections, [],
        'clearing every repository previews an empty selection');
});

test('WORKTREE-GROUPS-CREATE-UI-001 confirm failures render human text and the form stays single-instance', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);
    // Only one form instance: invoking the menu entry while the form is
    // open is a no-op (no second open request, the card survives).
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    assert.equal((await postedMessages(page))
        .filter(message => message.type === 'open-worktree-group-form').length, 1);
    assert.equal(await page.locator('[data-worktree-group-form]').count(), 1);

    await page.locator('[data-group-form-name]').fill('Fix login');
    await page.waitForTimeout(350);
    await answerPreview(page, okMembers());
    await page.locator('[data-group-form-action="confirm"]')
        .evaluate(button => button.click());
    const confirmRequest = (await postedMessages(page))
        .find(message => message.type === 'confirm-worktree-group');
    await postHostMessage(page, {
        type: 'worktree-group-creation-settlement',
        version: 1,
        requestId: confirmRequest.requestId,
        status: 'failed',
        errorCode: 'base-ref-unavailable',
    });
    const error = page.locator('.ai-session-group-form-error');
    assert.match(await error.textContent(), /base branch is no longer available/,
        'a vanished remote base is described without exposing its raw error code');
    assert.equal(await page.locator('[data-worktree-group-form]').count(), 1,
        'a failed creation keeps the form open for correction');

    await page.locator('[data-group-form-action="close"]')
        .evaluate(button => button.click());
    // Closing the form frees the menu entry to reopen it.
    await page.locator('.ai-session-worktree-anchor .ai-session-worktree-more')
        .evaluate(button => button.click());
    await page.locator('#aiSessionWorktreeMenu [data-action="worktree-new"]')
        .evaluate(item => item.click());
    assert.equal((await postedMessages(page))
        .filter(message => message.type === 'open-worktree-group-form').length, 2,
        'the menu entry reopens the form after close');
});

test('WORKTREE-GROUPS-CREATE-UI-001 an empty setup command in the preview is authoritative', async t => {
    // Config changed to empty after bootstrap: the form must show "no
    // setup configured", never the stale bootstrap command.
    const page = await openFormPage(t);
    await openBootstrappedForm(page);
    await page.locator('[data-group-form-name]').fill('Fix login');
    await page.waitForTimeout(350);
    await answerPreview(page, [{
        ...okMembers()[0],
        setupCommand: [],
    }]);
    const alphaRow = page.locator('[data-group-form-member="/alpha/.git"]');
    const setup = alphaRow.locator('.ai-session-group-form-setup-none');
    assert.equal(await setup.count(), 1);
    assert.match(await setup.textContent(), /no setup configured/);
    assert.equal(await alphaRow.locator('[data-group-form-setup]').count(), 0,
        'the stale bootstrap command is gone');
});

test('WORKTREE-GROUPS-CREATE-UI-001 the base combobox filters and selects by keyboard', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    await page.locator('[data-group-form-base="/alpha/.git"]')
        .evaluate(button => button.click());
    const filter = page.locator('[data-group-form-base-filter]');
    assert.equal(await filter.count(), 1, 'the combobox opens with a filter input');
    await filter.evaluate(input => input.focus());
    await page.keyboard.type('rele');
    const options = page.locator('[data-group-form-base-option]');
    assert.deepEqual(await options.allTextContents(), ['release/1.0'],
        'typing filters the local branch list');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    const lastPreview = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.deepEqual(lastPreview.selections, [
        { repositoryKey: '/alpha/.git', baseRef: 'refs/heads/release/1.0' },
    ], 'the keyboard selection drives the next preview');
    assert.equal(await page.locator('[data-group-form-base="/alpha/.git"]').textContent(),
        'release/1.0 \u25be'.replace('\\u25be', '\u25be'));
});

test('WORKTREE-GROUPS-CREATE-UI-001 the base combobox offers remote branches and previews their full ref', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    await page.locator('[data-group-form-base="/alpha/.git"]')
        .evaluate(button => button.click());
    const filter = page.locator('[data-group-form-base-filter]');
    await filter.evaluate(input => input.focus());
    await page.keyboard.type('origin/feature');
    const options = page.locator('[data-group-form-base-option]');
    assert.deepEqual(await options.allTextContents(), ['origin/feature/remote-base (remote)'],
        'a fetched remote branch is searchable alongside local base branches');

    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    const lastPreview = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.deepEqual(lastPreview.selections, [{
        repositoryKey: '/alpha/.git', baseRef: 'refs/remotes/origin/feature/remote-base',
    }], 'remote selection preserves the fully-qualified ref for Host validation');
    assert.equal(await page.locator('[data-group-form-base="/alpha/.git"]').textContent(),
        'origin/feature/remote-base (remote) \u25be'.replace('\\u25be', '\u25be'));
});

test('WORKTREE-GROUPS-CREATE-UI-001 distinguishes local and remote base branches and bounds remote results', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page, repositoryOptions({
        localBranches: ['main', 'origin/feature/remote-base'],
        remoteBranches: Array.from({ length: 120 }, (_value, index) =>
            index === 0 ? 'origin/feature/remote-base' : `origin/archive/${index}`),
    }));

    const form = page.locator('[data-worktree-group-form]');
    assert.match(await form.locator('.ai-session-group-form-remote-hint').textContent(),
        /last fetch/i, 'the form explains that remote choices are fetched snapshots');
    await page.locator('[data-group-form-base="/alpha/.git"]')
        .evaluate(button => button.click());
    const filter = page.locator('[data-group-form-base-filter]');
    await filter.evaluate(input => input.focus());
    await page.keyboard.type('origin/feature');
    const collisionOptions = page.locator('[data-group-form-base-option]');
    assert.deepEqual(await collisionOptions.allTextContents(), [
        'origin/feature/remote-base', 'origin/feature/remote-base (remote)',
    ], 'matching local and remote refs carry distinct source labels');

    await filter.evaluate(input => {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.locator('[data-group-form-base-option]').count(), 100,
        'opening a repository with many remote refs renders a bounded result set');
    assert.match(await form.locator('.ai-session-group-form-base-limit').textContent(),
        /Showing the first 100/i);
});

test('WORKTREE-GROUPS-CREATE-UI-001 the form stays usable at the 170px minimum width', async t => {
    const page = await openFormPage(t);
    await page.setViewportSize({ width: 170, height: 600 });
    await openBootstrappedForm(page);

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 170,
        'no horizontal overflow');
    const form = page.locator('[data-worktree-group-form]');
    assert.equal(await form.locator('[data-group-form-name]').count(), 1);
    const widths = await form.evaluate(element => {
        const contentWidth = element.querySelector('.ai-session-group-form-member')
            .getBoundingClientRect().width;
        const base = element.querySelector('[data-group-form-base]')
            .getBoundingClientRect().width;
        const confirm = element.querySelector('[data-group-form-action="confirm"]')
            .getBoundingClientRect();
        return { contentWidth, base, confirmWidth: confirm.width, confirmRight: confirm.right };
    });
    assert.ok(widths.contentWidth > 0);
    assert.ok(widths.base >= widths.contentWidth - 10,
        `the base combobox spans the stacked member row content box (${widths.base} of ${widths.contentWidth})`);
    assert.ok(widths.confirmWidth > 0 && widths.confirmRight <= 170,
        'the confirm action stays fully inside the viewport');
});

test('WORKTREE-GROUPS-CREATE-UI-001 failed member rows offer Retry and Dismiss', async t => {
    const failedGroup = {
        kind: 'group',
        groupId: 'g-1',
        displayName: 'fix-login',
        activity: 'attention',
        sessions: [],
        members: [
            {
                memberId: 'm-1', repositoryKey: '/alpha/.git', repositoryLabel: 'alpha',
                branchName: 'agent-pivot/fix-login', path: '/alpha/.worktrees/fix-login',
                status: 'ready', isPrimary: true, worktreeKey: alphaLoginKey,
            },
            {
                memberId: 'm-2', repositoryKey: '/beta/.git', repositoryLabel: 'beta',
                branchName: 'agent-pivot/fix-login', path: '/beta/.worktrees/fix-login',
                status: 'failed', isPrimary: false, errorCode: 'path-conflict',
            },
        ],
        chips: [{ label: 'a', title: 'alpha' }, { label: 'b', title: 'beta' }],
        hasDetachedMembers: false,
        needsPrimarySelection: false,
        canCreateSession: true,
        mergeCandidateGroupIds: [],
    };
    const groupHtml = `<div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace`
        + ` data-workspace-scope-identity="scope:current" data-workspace-navigation-identity="navigation:current">`
        + surface({ worktreeGroups: [failedGroup] })
        + `</div>`;
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div id="dashboard-tab-open"><div class="sticky-groups-wrapper">${groupHtml}</div></div>
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
    for (const name of [
        'webviewAiSessionViewStateScripts.js',
        'webviewScrollStateScripts.js',
        'webviewWorkspaceUpdateScripts.js',
        'webviewProjectCollapseScripts.js',
        'webviewProjectContextMenuScripts.js',
        'webviewProjectAiUpdateScripts.js',
        'webviewGroupFormScripts.js',
        'webviewProjectAiSessionControlsScripts.js',
        'webviewProjectScripts.js',
    ]) {
        await page.addScriptTag({ content: readScript(name) });
    }
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });

    const memberRow = page.locator('[data-member-status="failed"]');
    assert.equal(await memberRow.count(), 1, 'the failed member renders its own row');
    assert.match(await memberRow.textContent(), /path already exists/,
        'the error is human-readable, not a raw code');
    await memberRow.locator('[data-action="retry-group-member"]')
        .evaluate(button => button.click());
    const retryRequest = (await postedMessages(page))
        .find(message => message.type === 'retry-worktree-group-member');
    assert.ok(retryRequest);
    assert.equal(retryRequest.groupId, 'g-1');
    assert.equal(retryRequest.memberId, 'm-2');

    await memberRow.locator('[data-action="dismiss-group-member"]')
        .evaluate(button => button.click());
    const dismissRequest = (await postedMessages(page))
        .find(message => message.type === 'dismiss-worktree-group-member');
    assert.ok(dismissRequest);
    assert.equal(dismissRequest.memberId, 'm-2');
});
test('WORKTREE-GROUPS-CREATE-UI-001 typing keeps focus and value while previews stream in', async t => {
    // Regression: rebuilding the form on every keystroke destroyed the
    // focused input, so only the first character ever registered.
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const input = page.locator('[data-group-form-name]');
    // The minimal fixture lacks the full layout chain, so focus directly;
    // the keyboard events still travel the real input path.
    await input.evaluate(element => element.focus());
    await page.keyboard.type('Fix');
    await page.waitForTimeout(350);
    // A preview response arriving mid-typing must not drop focus either.
    await answerPreview(page, okMembers());
    await page.keyboard.type(' login');

    assert.equal(await input.inputValue(), 'Fix login');
    assert.equal(await page.evaluate(() =>
        document.activeElement
        && document.activeElement.hasAttribute('data-group-form-name')), true,
        'the name input keeps focus across preview-driven re-renders');
    assert.equal(await page.evaluate(() => {
        const element = document.querySelector('[data-group-form-name]');
        return element.selectionStart;
    }), 'Fix login'.length,
        'the caret stays at the end of the typed text');
});

test('WORKTREE-GROUPS-CREATE-UI-001 typing keeps focus and caret through authoritative replacements', async t => {
    // Regression: ai-sessions-updated and open-workspaces-updated replace the
    // DOM subtree that hosts the form slot. The form focus must be captured
    // before the replacement and restored by the reconcile re-render, or
    // every background refresh interrupts typing.
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const input = page.locator('[data-group-form-name]');
    await input.evaluate(element => element.focus());
    await page.keyboard.type('Fix');

    // Path A: ai-sessions-updated replaces the current-workspace group.
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: 1,
        projectionRevision: 1,
        generatedAt: '2026-08-17T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: currentGroupHtml(),
        searchCatalog: {
            version: 3, sessions: [], worktrees: [], openWorkspaces: [],
            savedProjects: [], todos: [],
        },
        presentation: presentationMessage(1),
    });
    assert.equal(await input.inputValue(), 'Fix',
        'the ai-sessions replacement keeps the unsubmitted input');
    assert.equal(await page.evaluate(() =>
        document.activeElement
        && document.activeElement.hasAttribute('data-group-form-name')), true,
        'the ai-sessions replacement keeps the name input focused');
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-group-form-name]').selectionStart), 'Fix'.length,
        'the caret survives the ai-sessions replacement');

    // Typing continues without any re-focus.
    await page.keyboard.type(' login');

    // Path B: open-workspaces-updated replaces the whole wrapper.
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: 'form-focus-2',
        projectionRevision: 2,
        windowRowCount: 1,
        currentWindowRowCount: 1,
        navigationWindowRowCount: 0,
        currentDetailCount: 1,
        otherWindowsStatus: 'ready',
        html: openWindowSwitcherHtml() + currentGroupHtml(),
        searchCatalog: {
            version: 3, sessions: [], worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }], savedProjects: [], todos: [],
        },
        presentation: presentationMessage(2),
    });
    assert.equal(await input.inputValue(), 'Fix login',
        'the open-workspaces replacement keeps the unsubmitted input');
    assert.equal(await page.evaluate(() =>
        document.activeElement
        && document.activeElement.hasAttribute('data-group-form-name')), true,
        'the open-workspaces replacement keeps the name input focused');
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-group-form-name]').selectionStart), 'Fix login'.length,
        'the caret survives the open-workspaces replacement');
});

test('WORKTREE-GROUPS-CREATE-UI-001 IME composition defers previews and re-renders until compositionend', async t => {
    // Regression: typing a CJK name kept an in-flight IME composition in the
    // name input; every debounced preview response rebuilt the form and
    // detached that input, aborting the composition (candidate window died).
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const input = page.locator('[data-group-form-name]');
    await input.evaluate(element => element.focus());
    await page.keyboard.type('Fix');
    await page.waitForTimeout(350);
    const previewRequest = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.ok(previewRequest, 'a preview request was sent for the committed text');

    // Start an IME composition: the preedit lives in the input but is not
    // committed yet.
    await input.evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        element.value = 'Fix ni';
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true, isComposing: true,
            inputType: 'insertCompositionText', data: 'ni',
        }));
    });
    await page.waitForTimeout(400);
    assert.equal((await postedMessages(page))
        .some(message => message.type === 'preview-worktree-group'
            && message.displayName === 'Fix ni'), false,
        'preedit text is never sent for preview');

    // A preview response arriving mid-composition must not rebuild the form.
    await page.evaluate(() => {
        window.__composingNameInput = document.querySelector('[data-group-form-name]');
    });
    await postHostMessage(page, {
        type: 'worktree-group-preview',
        version: 1,
        requestId: previewRequest.requestId,
        projectId: 'project-a',
        previewId: 'preview-host-1',
        slug: 'fix',
        members: okMembers(),
    });
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-group-form-name]') === window.__composingNameInput), true,
        'a preview response mid-composition does not detach the composing input');
    assert.equal(await input.inputValue(), 'Fix ni',
        'the preedit text survives the deferred re-render');

    // Commit the composition (value updates before compositionend, as in
    // Chromium) and finish with the real trailing input event.
    await input.evaluate(element => {
        element.value = 'Fix 你';
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true, isComposing: false, inputType: 'insertText', data: '你',
        }));
    });
    assert.match(await page.locator('.ai-session-group-form-plan').textContent(),
        /\/alpha\/\.worktrees\/fix-login/,
        'the deferred render flushed on compositionend');
    await page.waitForTimeout(350);
    const committedPreview = (await postedMessages(page))
        .filter(message => message.type === 'preview-worktree-group').at(-1);
    assert.equal(committedPreview.displayName, 'Fix 你',
        'the committed composition text is previewed');
    assert.equal(await page.locator('[data-group-form-name]').inputValue(), 'Fix 你');
});

test('WORKTREE-GROUPS-CREATE-UI-001 authoritative replacements wait for the IME composition to end', async t => {
    // Regression: ai-sessions-updated / open-workspaces-updated replace the
    // subtree hosting the form slot; applying them mid-composition detached
    // the composing input and aborted the IME session.
    const page = await openFormPage(t);
    await openBootstrappedForm(page);

    const input = page.locator('[data-group-form-name]');
    await input.evaluate(element => element.focus());
    await page.keyboard.type('Fix');
    await input.evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        element.value = 'Fix ni';
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true, isComposing: true,
            inputType: 'insertCompositionText', data: 'ni',
        }));
    });
    await page.evaluate(() => {
        window.__composingNameInput = document.querySelector('[data-group-form-name]');
    });

    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: 1,
        projectionRevision: 1,
        generatedAt: '2026-08-17T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: currentGroupHtml(),
        searchCatalog: {
            version: 3, sessions: [], worktrees: [], openWorkspaces: [],
            savedProjects: [], todos: [],
        },
        presentation: presentationMessage(1),
    });
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-group-form-name]') === window.__composingNameInput), true,
        'the ai-sessions replacement is deferred while composing');

    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: 'form-composition-1',
        projectionRevision: 2,
        windowRowCount: 1,
        currentWindowRowCount: 1,
        navigationWindowRowCount: 0,
        currentDetailCount: 1,
        otherWindowsStatus: 'ready',
        html: openWindowSwitcherHtml() + currentGroupHtml(),
        searchCatalog: {
            version: 3, sessions: [], worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }], savedProjects: [], todos: [],
        },
        presentation: presentationMessage(2),
    });
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-group-form-name]') === window.__composingNameInput), true,
        'the open-workspaces replacement is deferred while composing');
    assert.equal(await input.inputValue(), 'Fix ni',
        'the preedit text survives both deferred replacements');

    await input.evaluate(element => {
        element.value = 'Fix 你好';
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true, isComposing: false, inputType: 'insertText', data: '你好',
        }));
    });
    await page.waitForFunction(() =>
        document.querySelector('[data-group-form-name]')
        && document.querySelector('[data-group-form-name]') !== window.__composingNameInput,
        'the queued replacements replay once the composition ends');
    assert.equal(await page.locator('[data-group-form-name]').inputValue(), 'Fix 你好',
        'the replayed replacements keep the committed name');
    assert.equal(await page.evaluate(() =>
        document.activeElement
        && document.activeElement.hasAttribute('data-group-form-name')), true,
        'the name input is focused again after the replayed replacements');
});

test('WORKTREE-GROUPS-CREATE-UI-001 the form survives external DOM replacement and its slot scrolls', async t => {
    const page = await openFormPage(t);
    await openBootstrappedForm(page);
    await page.locator('[data-group-form-name]').fill('Fix login');

    // An authoritative replacement wipes the slot; the next form-related
    // message re-renders from the preserved state.
    await page.evaluate(() => {
        document.querySelector('[data-worktree-group-form-slot]').innerHTML = '';
    });
    await postHostMessage(page, {
        type: 'worktree-group-form-state',
        version: 1,
        projectId: 'project-a',
        repositories: repositoryOptions(),
    });
    assert.equal(await page.locator('[data-group-form-name]').inputValue(), 'Fix login',
        'external DOM replacement cannot lose the unsubmitted form');

    // The slot caps its height and scrolls internally so a tall form never
    // pushes the worktree list out of reach (asserted on the compiled
    // stylesheet: the bare fixture cannot reproduce the flex height chain).
    const slotRule = styles.match(/\.ai-session-group-form-slot\{[^}]*\}/);
    assert.ok(slotRule, 'the slot rule exists in the compiled stylesheet');
    assert.match(slotRule[0], /max-height:\s*60%/);
    assert.match(slotRule[0], /overflow-y:\s*auto/);
});
