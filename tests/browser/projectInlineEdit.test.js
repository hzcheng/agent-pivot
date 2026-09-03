'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = { file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }) };
    const previousLoad = Module._load;
    try {
        Module._load = (request, parent, isMain) => request === 'vscode'
            ? vscode : previousLoad.call(this, request, parent, isMain);
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getProjectsPanelContent } = loadWebviewContent();
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const readScript = name => fs.readFileSync(
    path.join(__dirname, '../../src/webview', name), 'utf8');

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function projectsMarkup() {
    return getProjectsPanelContent([{
        id: 'group-a', groupName: 'Projects', collapsed: false,
        projects: [{
            id: 'project-a', name: 'Project A', path: '/work/project-a',
            description: 'Original description', tags: ['frontend'],
        }],
    }], {
        config: { get: (_key, fallback) => fallback },
        favoritesGroupCollapsed: true,
        otherStorageHasData: false,
    });
}

function projectsMarkupWithFavoriteMirror() {
    return getProjectsPanelContent([{
        id: 'reddev-container', groupName: 'reddev container', collapsed: false,
        projects: [{
            id: 'agent-pivot', name: 'agent-pivot', path: '/work/agent-pivot',
            description: 'Original description', tags: ['frontend'], favorite: true,
        }],
    }], {
        config: { get: (_key, fallback) => fallback },
        favoritesGroupCollapsed: false,
        otherStorageHasData: false,
    });
}

async function openInlineEditPage(t) {
    const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head>
        <body><main id="dashboard-tab-projects">${projectsMarkup()}</main></body></html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.vscode = { postMessage: message => window.__postedMessages.push(message) };
        window.normalizeDashboardSearchCatalog = value => value;
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
        'webviewProjectEditScripts.js',
        'webviewProjectsPanelScripts.js',
        'webviewDashboardValidationScripts.js',
        'webviewDashboardProjectsPanelScripts.js',
    ]) {
        await page.addScriptTag({ content: readScript(name) });
    }
    await page.evaluate(markup => {
        window.__testProjectsPanel = createDashboardProjectsPanel({
            options: {
                postMessage: () => undefined,
                onProjectsMounted: () => initProjects(),
            },
            panels: { projects: document.getElementById('dashboard-tab-projects') },
            scheduleTimeout: () => null,
            cancelTimeout: () => undefined,
            panelRequestTimeoutMs: 0,
            showPanelLoading: () => undefined,
            showPanelUnavailable: () => undefined,
            restoreScroll: () => undefined,
            replaceSearchCatalog: () => undefined,
            getActiveTab: () => 'projects',
            getSearchQuery: () => '',
            getPendingScrollRestoreTab: () => null,
            setPendingScrollRestoreTab: () => undefined,
        });
        window.__testProjectsPanel.ensureProjectsPanel();
        if (!window.__testProjectsPanel.applyProjectsPanelMessage({
            type: 'projects-panel-content', version: 1, requestId: 1, html: markup,
        })) {
            throw new Error('The inline-edit test setup could not mount its Projects panel.');
        }
    }, projectsMarkup());
    await page.evaluate(() => { window.__postedMessages.length = 0; });
    return page;
}

test('PROJECT-INLINE-EDIT-001 opens and saves in the row without invoking the legacy VS Code prompt action', async t => {
    const page = await openInlineEditPage(t);

    await page.locator('.project[data-id="project-a"] [data-action="edit-inline"]')
        .evaluate(button => button.click());

    const form = page.locator('.project[data-id="project-a"] .project-edit-form');
    assert.equal(await form.isVisible(), true, 'the pencil opens the inline form in its project row');
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), [],
        'opening the inline form must not post edit-project or any other Host action');

    await form.locator('[data-edit-field="name"]').fill('Renamed Project');
    await form.locator('[data-edit-field="description"]').fill('Updated description');
    await form.locator('[data-edit-field="tags"]').fill('frontend, urgent');
    await form.locator('[data-action="save-edit"]').evaluate(button => button.click());

    const request = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.equal(request.type, 'save-project-inline');
    assert.equal(request.version, 1);
    assert.match(request.requestId, /^project-inline-edit-/);
    assert.deepEqual({
        projectId: request.projectId,
        groupId: request.groupId,
        name: request.name,
        description: request.description,
        tags: request.tags,
    }, {
        projectId: 'project-a',
        groupId: 'group-a',
        name: 'Renamed Project',
        description: 'Updated description',
        tags: 'frontend, urgent',
    });
    assert.equal(await form.locator('[data-edit-field="name"]').isDisabled(), true,
        'the form remains pending until the Host applies authoritative state');

    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'project-inline-edit-settlement', version: 1,
        requestId: request.requestId, projectId: 'project-a', status: 'saved',
    });
    assert.equal(await form.locator('[data-edit-field="name"]').isDisabled(), true,
        'a settlement alone must not clear pending state before authority is applied');
    assert.equal(await page.evaluate(markup => window.__testProjectsPanel.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated', version: 1, sequence: 1, mode: 'replace',
        html: markup,
        searchCatalog: {
            version: 3, sessions: [], worktrees: [], openWorkspaces: [],
            savedProjects: [], todos: [], skills: [],
        },
        groupOrders: [{ groupId: 'group-a', projectIds: ['project-a'] }],
        favoriteProjectIds: [],
    }), projectsMarkup()), true, 'the production Projects panel must accept the authority update');
    assert.equal(await form.locator('[data-edit-field="name"]').isDisabled(), false,
        'the authoritative replacement following settlement unlocks the form');
    assert.equal(await form.locator('[data-project-edit-feedback]').textContent(), 'Saved.');
});

test('PROJECT-INLINE-EDIT-001 restores only the matching failed save for retry', async t => {
    const page = await openInlineEditPage(t);
    await page.locator('.project[data-id="project-a"] [data-action="edit-inline"]')
        .evaluate(button => button.click());
    await page.locator('[data-action="save-edit"]').evaluate(button => button.click());
    const request = await page.evaluate(() => window.__postedMessages.at(-1));

    await page.evaluate(staleRequestId => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'project-inline-edit-settlement', version: 1,
            requestId: staleRequestId, projectId: 'project-a', status: 'failed',
        } }));
    }, request.requestId + '-stale');
    assert.equal(await page.locator('[data-edit-field="name"]').isDisabled(), true,
        'a stale settlement must not unlock the pending form');

    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'project-inline-edit-settlement', version: 1,
        requestId: request.requestId, projectId: 'project-a', status: 'failed',
    });
    assert.equal(await page.locator('[data-edit-field="name"]').isDisabled(), false,
        'the matching failed settlement restores form controls');
    assert.equal(await page.locator('[data-project-edit-feedback]').textContent(),
        'Could not save the project. Try again.');
});

test('PROJECT-INLINE-EDIT-001 edits the clicked source card rather than its Favorites mirror', async t => {
    const page = await openInlineEditPage(t);
    await page.locator('#dashboard-tab-projects').evaluate((panel, html) => {
        panel.innerHTML = html;
    }, projectsMarkupWithFavoriteMirror());

    const sourceProject = page.locator(
        '.group[data-group-id="reddev-container"] .project[data-id="agent-pivot"]'
    );
    const favoriteProject = page.locator(
        '.group[data-system-group="__favorites"] .project[data-id="agent-pivot"]'
    );
    await sourceProject.locator('[data-action="edit-inline"]').evaluate(button => button.click());

    assert.equal(await sourceProject.locator('.project-edit-form').isVisible(), true,
        'the source card entered edit mode');
    assert.equal(await favoriteProject.locator('.project-edit-form').isVisible(), false,
        'the Favorites mirror remains a read-only view of the source edit');
    assert.equal(await page.evaluate(() => window.__postedMessages.some(
        message => message.type === 'selected-project'
    )), false, 'the edit click does not fall through into project opening');
});

test('PROJECT-INLINE-EDIT-001 preserves the active source form through an authoritative panel replacement', async t => {
    const page = await openInlineEditPage(t);
    await page.locator('#dashboard-tab-projects').evaluate((panel, html) => {
        panel.innerHTML = html;
    }, projectsMarkupWithFavoriteMirror());

    const sourceProject = page.locator(
        '.group[data-group-id="reddev-container"] .project[data-id="agent-pivot"]'
    );
    await sourceProject.locator('[data-action="edit-inline"]').evaluate(button => button.click());
    await sourceProject.locator('[data-edit-field="description"]').fill('Still editing');
    await sourceProject.locator('[data-edit-field="description"]').evaluate(input => {
        input.setSelectionRange(3, 8);
    });
    const state = await page.evaluate(() => window.__agentPivotProjectInlineEdit.captureState());

    await page.locator('#dashboard-tab-projects').evaluate((panel, html) => {
        panel.innerHTML = html;
    }, projectsMarkupWithFavoriteMirror());
    await page.evaluate(value => window.__agentPivotProjectInlineEdit.restoreState(value), state);

    const restoredSource = page.locator(
        '.group[data-group-id="reddev-container"] .project[data-id="agent-pivot"]'
    );
    assert.equal(await restoredSource.locator('.project-edit-form').isVisible(), true);
    assert.equal(await restoredSource.locator('[data-edit-field="description"]').inputValue(),
        'Still editing');
    assert.equal(await page.locator(
        '.group[data-system-group="__favorites"] .project[data-id="agent-pivot"]'
    ).locator('.project-edit-form').isVisible(), false);
    assert.equal(await restoredSource.locator('[data-edit-field="description"]')
        .evaluate(input => document.activeElement === input), true,
        'the editor focus returns to the same field after replacement');
    assert.deepEqual(await restoredSource.locator('[data-edit-field="description"]')
        .evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 8],
    'the editor selection returns to the same semantic field after replacement');
});
