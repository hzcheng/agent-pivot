'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { getAiSessionsDiv } = require('../../out/webview/webviewAiSessionContent');

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
        worktrees: [],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 2,
        bareWorktreeCount: 0,
        ...(overrides || {}),
    });
}

function repositoryOptions() {
    return [
        {
            repositoryKey: '/alpha/.git', label: 'alpha',
            defaultBaseRef: 'refs/heads/main',
            localBranches: ['main', 'release/1.0'],
            defaultChecked: true,
            setupCommand: ['npm', 'ci'],
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

async function openFormPage(t) {
    const groupHtml = `<div class="open-current-workspace-group current-card-expanded"><div class="group-list">`
        + `<div class="project workspace-card" data-id="project-a" data-current-workspace`
        + ` data-codex-expanded data-workspace-scope-identity="scope:current">${surface()}</div>`
        + `</div></div>`;
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
        'webviewTodoGroupScripts.js',
        'webviewProjectCollapseScripts.js',
        'webviewTodoControlScripts.js',
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

async function openBootstrappedForm(page) {
    await page.locator('[data-action="create-isolated-session"]')
        .evaluate(button => button.click());
    const openRequest = (await postedMessages(page))
        .find(message => message.type === 'open-worktree-group-form');
    assert.ok(openRequest, 'the new-worktree button opens the inline form');
    assert.equal(openRequest.version, 1);
    await postHostMessage(page, {
        type: 'worktree-group-form-state',
        version: 1,
        projectId: 'project-a',
        repositories: repositoryOptions(),
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

    await confirm.click();
    const confirmRequest = (await postedMessages(page))
        .find(message => message.type === 'confirm-worktree-group');
    assert.ok(confirmRequest);
    assert.deepEqual(confirmRequest.members, [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/main',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/alpha/.worktrees/fix-login',
        setupCommand: ['npm', 'ci'],
    }], 'the host receives exactly the previewed values');
    assert.equal(confirmRequest.primaryRepositoryKey, '/alpha/.git');

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
    const available = form.locator('[data-group-form-action="confirm-available"]');
    assert.match(await available.textContent(), /available 1\/2/);

    await available.click();
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
    await page.locator('[data-action="create-isolated-session"]')
        .evaluate(button => button.click());
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
    await page.locator('[data-group-form-action="close"]').click();
    await page.evaluate(() => {
        window.__groupFormSeed = true;
    });
    await page.locator('[data-action="create-isolated-session"]')
        .evaluate(button => button.click());
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
    const groupHtml = `<div class="open-current-workspace-group current-card-expanded"><div class="group-list">`
        + `<div class="project workspace-card" data-id="project-a" data-current-workspace`
        + ` data-codex-expanded data-workspace-scope-identity="scope:current">`
        + surface({ worktreeGroups: [failedGroup] })
        + `</div></div>`;
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
        'webviewTodoGroupScripts.js',
        'webviewProjectCollapseScripts.js',
        'webviewTodoControlScripts.js',
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
