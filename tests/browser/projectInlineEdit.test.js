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
    ]) {
        await page.addScriptTag({ content: readScript(name) });
    }
    await page.evaluate(() => initProjects());
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
        name: request.name,
        description: request.description,
        tags: request.tags,
    }, {
        projectId: 'project-a',
        name: 'Renamed Project',
        description: 'Updated description',
        tags: 'frontend, urgent',
    });
    assert.equal(await form.locator('[data-edit-field="name"]').isDisabled(), true,
        'the form remains pending until the Host applies authoritative state');
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
