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
const { getTodoPanelContent } = require('../../out/todos/webviewContent');
const { buildTodoViewModel } = require('../../out/todos/viewModel');
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const dashboardScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardScripts.js'), 'utf8'
);
const todoScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoScripts.js'), 'utf8'
);
const BROWSER_CONDITION_TIMEOUT_MS = 5_000;

function waitForPageCondition(page, condition) {
    return page.waitForFunction(condition, undefined, { timeout: BROWSER_CONDITION_TIMEOUT_MS });
}

let browser;

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 and TODO-AUTHORITATIVE-REFRESH-STATE-001 bound every browser condition wait', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    assert.equal((source.match(/\.waitForFunction\(/g) || []).length, 1);
    assert.match(source, /const BROWSER_CONDITION_TIMEOUT_MS = 5_000;/);
});

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function catalog() {
    return { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] };
}

function project(id) {
    return { id, name: id, path: `/work/${id}`, description: `${id} description`, favorite: false };
}

function projectsMarkup(ids) {
    return getProjectsPanelContent([{
        id: 'group-a', groupName: 'Projects', collapsed: false, projects: ids.map(project),
    }], {
        config: { get: (_key, fallback) => _key === 'maxVisibleProjectsPerGroup' ? 3 : fallback },
        favoritesGroupCollapsed: true,
        otherStorageHasData: false,
    });
}

function todoSnapshot(todoIds, includeSecondGroup = true) {
    const groups = [{ id: 'group-a', title: 'Primary', collapsed: false, order: 0 }];
    if (includeSecondGroup) groups.push({ id: 'group-b', title: 'Secondary', collapsed: false, order: 1 });
    return {
        version: 1,
        showCompleted: false,
        data: {
            version: 1,
            groups,
            todos: todoIds.map((id, index) => ({
                id, groupId: index === todoIds.length - 1 && includeSecondGroup ? 'group-b' : 'group-a',
                title: id, notes: '', priority: 'medium', completed: false,
                createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', order: index,
            })),
        },
    };
}

function todoMarkup(snapshot) {
    return getTodoPanelContent(buildTodoViewModel(snapshot.data, {
        showCompleted: snapshot.showCompleted,
    }), { maxVisibleTodosPerGroup: 3 });
}

async function openDashboardPage(t) {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head>
        <body class="steward-sidebar" style="min-height:1400px">
        <div class="steward-sticky-header"></div><div role="tablist">
        <button data-dashboard-tab="open"></button><button data-dashboard-tab="projects"></button>
        <button data-dashboard-tab="todo"></button><button data-dashboard-tab="ai"></button></div>
        <main><section id="dashboard-tab-open"></section>
        <section id="dashboard-tab-projects"><div class="dashboard-projects-loading"></div></section>
        <section id="dashboard-tab-todo"><div class="dashboard-todo-loading"></div></section>
        <section id="dashboard-panel-ai"><div class="dashboard-ai-loading"></div></section>
        <section id="dashboard-search-results"></section></main>
        <script id="dashboard-search-catalog" type="application/json">${JSON.stringify(catalog())}</script>
        </body></html>`);
    await page.evaluate(() => {
        const storage = new Map();
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            value: {
                getItem: key => storage.has(key) ? storage.get(key) : null,
                setItem: (key, value) => storage.set(key, String(value)),
                removeItem: key => storage.delete(key),
            },
        });
        window.__messages = [];
        window.__todoRenders = 0;
        window.vscode = { postMessage: message => window.__messages.push(message) };
    });
    await page.addScriptTag({ content: dashboardScript });
    await page.addScriptTag({ content: todoScript });
    await page.evaluate(() => {
        window.__todos = initTodos({
            postMessage: message => window.__messages.push(message),
            onRendered: () => { window.__todoRenders += 1; },
        });
        window.__dashboard = initDashboard({
            postMessage: message => window.__messages.push(message),
            onTodoMounted: (panel, message) => window.__todos.mount(panel, message.snapshot),
            onProjectsMounted: panel => {
                requestAnimationFrame(() => panel.setAttribute('data-header-fit-flushed', 'true'));
            },
        });
    });
    return page;
}

async function post(page, message) {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
}

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 preserves a project anchor, focus, and window position through required replacement and header fitting', async t => {
    const page = await openDashboardPage(t);
    await page.evaluate(() => window.__dashboard.activateTab('projects'));
    await post(page, {
        type: 'projects-panel-content', version: 1, requestId: 1, html: projectsMarkup(['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f']),
    });
    const anchor = page.locator('.project[data-id="project-e"]');
    const list = page.locator('.saved-project-group .group-list');
    await waitForPageCondition(page, () => {
        const list = document.querySelector('.saved-project-group .group-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    const before = await anchor.evaluate(node => {
        const list = node.closest('.group-list');
        list.scrollTop = node.offsetTop - list.offsetTop - 15;
        node.querySelector('[data-action="edit"]').setAttribute('tabindex', '0');
        node.querySelector('[data-action="edit"]').focus();
        window.scrollTo(0, 80);
        return { offset: node.getBoundingClientRect().top - list.getBoundingClientRect().top, scrollY: window.scrollY };
    });
    await post(page, {
        type: 'projects-panel-updated', version: 1, sequence: 1, mode: 'replace',
        html: projectsMarkup(['project-x', 'project-d', 'project-c', 'project-e', 'project-f']),
        searchCatalog: catalog(), groupOrders: [{ groupId: 'group-a', projectIds: ['project-x', 'project-d', 'project-c', 'project-e', 'project-f'] }], favoriteProjectIds: [],
    });
    await page.locator('#dashboard-tab-projects[data-header-fit-flushed="true"]').waitFor();
    const restored = page.locator('.project[data-id="project-e"]');
    assert.ok(Math.abs((await restored.evaluate(node => {
        const list = node.closest('.group-list');
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    })) - before.offset) <= 1);
    assert.equal(await restored.locator('[data-action="edit"]').evaluate(node => document.activeElement === node), true);
    assert.equal(await page.evaluate(() => window.scrollY), before.scrollY);
});

test('TODO-AUTHORITATIVE-REFRESH-STATE-001 renders one mounted refresh and preserves surviving anchors, detail, draft, compose, focus, and window position', async t => {
    const page = await openDashboardPage(t);
    const initial = todoSnapshot(['todo-a', 'todo-b', 'todo-c', 'todo-d', 'todo-e', 'todo-f']);
    await page.evaluate(() => window.__dashboard.activateTab('todo'));
    await post(page, { type: 'todo-panel-content', version: 1, requestId: 1, html: todoMarkup(initial), snapshot: initial, searchCatalog: catalog() });
    await page.locator('[data-action="todo-open-detail"][data-todo-id="todo-c"]').click();
    await page.locator('[data-action="todo-edit-detail"]').click();
    await page.locator('form[data-todo-form="detail-edit"] [name="title"]').fill('unsaved detail title');
    await page.locator('[data-action="todo-quick-add"][data-group-id="group-a"]').click({ force: true });
    await page.locator('form[data-todo-form="quick-add"][data-group-id="group-a"] [name="title"]').fill('unsaved compose title');
    await page.locator('form[data-todo-form="detail-edit"] [name="notes"]').focus();
    const before = await page.evaluate(() => {
        const panel = document.querySelector('.todo-panel');
        const list = document.querySelector('.todo-list');
        const anchor = document.querySelector('[data-todo-id="todo-e"]');
        list.scrollTop = anchor.offsetTop - list.offsetTop - 10;
        window.__mountedTodoPanel = panel;
        window.scrollTo(0, 90);
        return { offset: anchor.getBoundingClientRect().top - list.getBoundingClientRect().top, scrollY: window.scrollY, renders: window.__todoRenders };
    });
    const refreshed = todoSnapshot(['todo-a', 'todo-new', 'todo-b', 'todo-c', 'todo-d', 'todo-e', 'todo-f']);
    await post(page, { type: 'todo-panel-updated', version: 1, html: todoMarkup(refreshed), snapshot: refreshed, searchCatalog: catalog() });
    assert.equal(await page.evaluate(() => document.querySelector('.todo-panel') === window.__mountedTodoPanel), true);
    assert.equal(await page.evaluate(() => window.__todoRenders), before.renders + 1);
    assert.ok(Math.abs((await page.locator('.todo-item[data-todo-id="todo-e"]').evaluate(node => {
        const list = node.closest('.todo-list');
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    })) - before.offset) <= 1);
    assert.equal(await page.locator('form[data-todo-form="detail-edit"] [name="title"]').inputValue(), 'unsaved detail title');
    assert.equal(await page.locator('form[data-todo-form="quick-add"][data-group-id="group-a"] [name="title"]').inputValue(), 'unsaved compose title');
    assert.equal(await page.locator('form[data-todo-form="detail-edit"] [name="notes"]').evaluate(node => document.activeElement === node), true);
    assert.equal(await page.evaluate(() => window.scrollY), before.scrollY);
});

test('TODO-AUTHORITATIVE-REFRESH-STATE-001 discards local state only when its authoritative identity disappears', async t => {
    const page = await openDashboardPage(t);
    const initial = todoSnapshot(['todo-a', 'todo-b', 'todo-c', 'todo-d', 'todo-e', 'todo-f']);
    await page.evaluate(() => window.__dashboard.activateTab('todo'));
    await post(page, { type: 'todo-panel-content', version: 1, requestId: 1, html: todoMarkup(initial), snapshot: initial, searchCatalog: catalog() });
    await page.locator('[data-action="todo-open-detail"][data-todo-id="todo-c"]').click();
    await page.locator('[data-action="todo-edit-detail"]').click();
    await page.locator('form[data-todo-form="detail-edit"] [name="title"]').fill('discarded detail');
    await page.locator('[data-action="todo-quick-add"][data-group-id="group-b"]').click({ force: true });
    await page.locator('form[data-todo-form="quick-add"][data-group-id="group-b"] [name="title"]').fill('discarded compose');
    const before = await page.evaluate(() => {
        const list = document.querySelector('.todo-list');
        const anchor = document.querySelector('[data-todo-id="todo-e"]');
        list.scrollTop = anchor.offsetTop - list.offsetTop - 10;
        return anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    const refreshed = todoSnapshot(['todo-a', 'todo-b', 'todo-d', 'todo-e'], false);
    await post(page, { type: 'todo-panel-updated', version: 1, html: todoMarkup(refreshed), snapshot: refreshed, searchCatalog: catalog() });
    assert.equal(await page.locator('.todo-item[data-todo-id="todo-c"]').count(), 0);
    assert.equal(await page.locator('form[data-todo-form="detail-edit"]').count(), 0);
    assert.equal(await page.locator('form[data-todo-form="quick-add"][data-group-id="group-b"]').count(), 0);
    assert.equal(await page.locator('form[data-todo-form="detail-edit"] [name="title"]').count(), 0);
    assert.ok(Math.abs((await page.locator('.todo-item[data-todo-id="todo-e"]').evaluate(node => {
        const list = node.closest('.todo-list');
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    })) - before) <= 1);
});
