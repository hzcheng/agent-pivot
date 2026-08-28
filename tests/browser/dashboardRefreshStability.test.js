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
const dashboardScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardScripts.js'), 'utf8'
);
const skillPanelScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewSkillPanelScripts.js'), 'utf8'
);
const projectsPanelScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectsPanelScripts.js'), 'utf8'
);
const dashboardValidationScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardValidationScripts.js'), 'utf8'
);
const dashboardSearchScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardSearchScripts.js'), 'utf8'
);
const dashboardProjectsPanelScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardProjectsPanelScripts.js'), 'utf8'
);
const dashboardAiPanelScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardAiPanelScripts.js'), 'utf8'
);
const scrollStateScriptPath = path.join(
    __dirname, '../../src/webview/webviewScrollStateScripts.js'
);
const scrollStateScript = fs.existsSync(scrollStateScriptPath)
    ? fs.readFileSync(scrollStateScriptPath, 'utf8')
    : null;
const BROWSER_CONDITION_TIMEOUT_MS = 5_000;

function waitForPageCondition(page, condition, argument) {
    return page.waitForFunction(condition, argument, { timeout: BROWSER_CONDITION_TIMEOUT_MS });
}

let browser;

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 bound every browser condition wait', () => {
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

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 provide shared semantic anchors and clamped fallback', async t => {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><div id="list" style="height:100px;overflow:auto">
        <div data-id="a" style="height:50px"></div><div data-id="b" style="height:50px"></div>
        <div data-id="c" style="height:50px"></div><div data-id="d" style="height:50px"></div>
        <div data-id="e" style="height:50px"></div><div data-id="f" style="height:50px"></div>
    </div>`);
    if (scrollStateScript) await page.addScriptTag({ content: scrollStateScript });

    const captured = await page.evaluate(() => {
        const list = document.querySelector('#list');
        list.scrollTop = 60;
        return {
            namespaceType: typeof window.__agentPivotScrollState,
            captureType: typeof window.__agentPivotScrollState?.capture,
            restoreType: typeof window.__agentPivotScrollState?.restore,
            anchor: window.__agentPivotScrollState?.capture(list, {
                itemSelector: '[data-id]',
                getKey: item => item.dataset.id,
                endThreshold: 0,
            }),
        };
    });
    assert.equal(captured.namespaceType, 'object');
    assert.equal(captured.captureType, 'function');
    assert.equal(captured.restoreType, 'function');
    assert.equal(captured.anchor.itemKey, 'b');

    const restored = await page.evaluate(anchor => {
        const list = document.querySelector('#list');
        const beforeOffset = document.querySelector('[data-id="b"]').getBoundingClientRect().top
            - list.getBoundingClientRect().top;
        list.insertAdjacentHTML('afterbegin', '<div data-id="inserted" style="height:50px"></div>');
        const restored = window.__agentPivotScrollState.restore(list, anchor, {
            itemSelector: '[data-id]',
            getKey: item => item.dataset.id,
        });
        const afterOffset = document.querySelector('[data-id="b"]').getBoundingClientRect().top
            - list.getBoundingClientRect().top;
        return { restored, beforeOffset, afterOffset };
    }, captured.anchor);
    assert.equal(restored.restored, true);
    assert.ok(Math.abs(restored.afterOffset - restored.beforeOffset) <= 1);

    const fallback = await page.evaluate(() => {
        const list = document.querySelector('#list');
        list.innerHTML = '<div data-id="a" style="height:50px"></div>'
            + '<div data-id="c" style="height:50px"></div>'
            + '<div data-id="d" style="height:50px"></div>';
        return {
            restored: window.__agentPivotScrollState.restore(list, {
                scrollTop: 999,
                itemKey: 'removed',
                itemOffset: 0,
                atEnd: false,
            }, {
                itemSelector: '[data-id]',
                getKey: item => item.dataset.id,
            }),
            scrollTop: list.scrollTop,
            maxScrollTop: list.scrollHeight - list.clientHeight,
        };
    });
    assert.equal(fallback.restored, true);
    assert.equal(fallback.scrollTop, fallback.maxScrollTop);
});

function catalog() {
    return { version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [] };
}

function catalogWithSavedProject(name) {
    return {
        version: 3, sessions: [], worktrees: [], openWorkspaces: [], todos: [],
        savedProjects: [{
            key: 'saved:' + name, identity: '/work/' + name, searchText: name,
            projectId: name, name, description: '', action: 'open-saved', groupLabels: [],
        }],
    };
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

async function openDashboardPage(t) {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head>
        <body class="steward-sidebar" style="min-height:1400px">
        <div class="steward-sticky-header"></div><div role="tablist">
        <button data-dashboard-tab="open"></button><button data-dashboard-tab="projects"></button>
        <button data-dashboard-tab="ai"></button></div>
        <main><section id="dashboard-tab-open"></section>
        <section id="dashboard-tab-projects"><div class="dashboard-projects-loading"></div></section>
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
        window.__projectsMountGeneration = 0;
        window.vscode = { postMessage: message => window.__messages.push(message) };
    });
    if (scrollStateScript) await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: skillPanelScript });
    await page.addScriptTag({ content: projectsPanelScript });
    await page.addScriptTag({ content: dashboardValidationScript });
    await page.addScriptTag({ content: dashboardSearchScript });
    await page.addScriptTag({ content: dashboardProjectsPanelScript });
    await page.addScriptTag({ content: dashboardAiPanelScript });
    await page.addScriptTag({ content: dashboardScript });
    await page.evaluate(() => {
        window.__dashboard = initDashboard({
            postMessage: message => window.__messages.push(message),
            onProjectsMounted: panel => {
                const mountGeneration = ++window.__projectsMountGeneration;
                panel.removeAttribute('data-header-fit-generation');
                requestAnimationFrame(() => {
                    if (window.__projectsMountGeneration === mountGeneration) {
                        panel.setAttribute('data-header-fit-generation', String(mountGeneration));
                    }
                });
            },
        });
    });
    return page;
}

async function post(page, message) {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
}

test('WEBVIEW-DASHBOARD-SEARCH-001 refreshes search results from the lazy Projects panel authority', async t => {
    const page = await openDashboardPage(t);
    await page.evaluate(() => window.__dashboard.activateTab('projects'));
    await post(page, {
        type: 'projects-panel-content', version: 1, requestId: 1,
        html: projectsMarkup(['reddev-container']),
        searchCatalog: catalogWithSavedProject('reddev-container'),
    });
    await page.evaluate(() => window.__dashboard.setSearchQuery('reddev'));

    const result = page.locator('.dashboard-search-result');
    assert.equal(await result.count(), 1);
    assert.equal(await result.textContent(), 'reddev-container');
    assert.equal(await page.locator('#dashboard-search-results').isVisible(), true);
});

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 preserves a project anchor, focus, and window position through required replacement and header fitting', async t => {
    const page = await openDashboardPage(t);
    await page.evaluate(() => window.__dashboard.activateTab('projects'));
    await post(page, {
        type: 'projects-panel-content', version: 1, requestId: 1, html: projectsMarkup(['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f']),
    });
    const anchor = page.locator('.project[data-id="project-e"]');
    await waitForPageCondition(page, () => {
        const list = document.querySelector('.saved-project-group .group-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    const before = await anchor.evaluate(node => {
        const list = node.closest('.group-list');
        list.scrollTop = node.offsetTop - list.offsetTop - 15;
        node.querySelector('[data-action="edit-inline"]').setAttribute('tabindex', '0');
        node.querySelector('[data-action="edit-inline"]').focus();
        window.scrollTo(0, 80);
        return { offset: node.getBoundingClientRect().top - list.getBoundingClientRect().top, scrollY: window.scrollY };
    });
    const previousMountGeneration = await page.evaluate(() => window.__projectsMountGeneration);
    await post(page, {
        type: 'projects-panel-updated', version: 1, sequence: 1, mode: 'replace',
        html: projectsMarkup(['project-x', 'project-d', 'project-c', 'project-e', 'project-f']),
        searchCatalog: catalog(), groupOrders: [{ groupId: 'group-a', projectIds: ['project-x', 'project-d', 'project-c', 'project-e', 'project-f'] }], favoriteProjectIds: [],
    });
    await waitForPageCondition(page, previousGeneration => {
        const panel = document.querySelector('#dashboard-tab-projects');
        const expectedGeneration = previousGeneration + 1;
        return window.__projectsMountGeneration === expectedGeneration
            && panel
            && panel.getAttribute('data-header-fit-generation') === String(expectedGeneration);
    }, previousMountGeneration);
    const restored = page.locator('.project[data-id="project-e"]');
    assert.ok(Math.abs((await restored.evaluate(node => {
        const list = node.closest('.group-list');
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    })) - before.offset) <= 1);
    assert.equal(await restored.locator('[data-action="edit-inline"]').evaluate(node => document.activeElement === node), true);
    assert.equal(await page.evaluate(() => window.scrollY), before.scrollY);
});

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 clamps the saved raw position when the semantic project anchor disappears', async t => {
    const page = await openDashboardPage(t);
    await page.evaluate(() => window.__dashboard.activateTab('projects'));
    await post(page, {
        type: 'projects-panel-content', version: 1, requestId: 1,
        html: projectsMarkup(['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f']),
    });
    await waitForPageCondition(page, () => {
        const list = document.querySelector('.saved-project-group .group-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    await page.evaluate(() => {
        const list = document.querySelector('.saved-project-group .group-list');
        list.scrollTop = list.scrollHeight - list.clientHeight;
    });
    await post(page, {
        type: 'projects-panel-updated', version: 1, sequence: 1, mode: 'replace',
        html: projectsMarkup(['project-a', 'project-b', 'project-c', 'project-x']),
        searchCatalog: catalog(),
        groupOrders: [{
            groupId: 'group-a',
            projectIds: ['project-a', 'project-b', 'project-c', 'project-x'],
        }],
        favoriteProjectIds: [],
    });
    const restored = await page.evaluate(() => {
        const list = document.querySelector('.saved-project-group .group-list');
        return {
            scrollTop: list.scrollTop,
            maxScrollTop: list.scrollHeight - list.clientHeight,
        };
    });
    assert.ok(restored.maxScrollTop > 0);
    assert.equal(restored.scrollTop, restored.maxScrollTop);
});
