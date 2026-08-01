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
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getAiSessionsDiv } = loadWebviewContent();
const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const todoGroupScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoGroupScripts.js'),
    'utf8'
);
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
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
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const styles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);

const BROWSER_CONDITION_TIMEOUT_MS = 5_000;

function waitForPageCondition(page, condition) {
    return page.waitForFunction(condition, undefined, {
        timeout: BROWSER_CONDITION_TIMEOUT_MS,
    });
}

let browser;

test('WEBVIEW-AI-SESSION-LIST-SCROLL-001 bounds every browser condition wait', () => {
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

function session(provider, sessionId, focused) {
    return {
        key: `${provider}:${sessionId}`,
        provider,
        sessionId,
        name: `${provider} ${sessionId}`,
        executionState: 'running',
        status: 'running',
        focused,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
    };
}

function historySession(provider, sessionId) {
    return {
        id: sessionId,
        name: `${provider} ${sessionId}`,
        active: false,
    };
}

function sessionSurfaceMarkup(activeAiSessions, selectedTab = 'active') {
    return getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex', 'kimi'],
        activeAiSessionTab: selectedTab,
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions,
    });
}

function listSessionSurfaceMarkup(activeAiSessions, historySessions, selectedTab = 'active') {
    return getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: selectedTab,
        codexSessions: historySessions,
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions,
    });
}

function projectMarkup(activeAiSessions) {
    return `<div class="project workspace-card" data-id="project-a" data-current-workspace
        data-codex-expanded
        data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a"
        style="--steward-ai-session-list-max-height: 130px">
        ${sessionSurfaceMarkup(activeAiSessions)}
    </div>`;
}

function listProjectMarkup(activeAiSessions, historySessions, selectedTab = 'active') {
    return `<div class="project workspace-card" data-id="project-a" data-current-workspace
        data-codex-expanded
        data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a"
        style="--steward-ai-session-list-max-height: 130px">
        ${listSessionSurfaceMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>`;
}

function currentOpenWorkspaceProjectMarkup() {
    return `<div class="project workspace-card" data-id="project-a"
        data-open-workspace-list-card data-open-workspace-current
        data-workspace-navigation-identity="navigation-project-a"></div>`;
}

async function postListWorkspaceUpdate(page, activeAiSessions, historySessions, selectedTab = 'active') {
    const html = `<div class="open-current-workspace-group">
        ${listProjectMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>`;
    await page.evaluate(htmlValue => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'workspace-updated', version: 2, currentWorkspaceCount: 1, html: htmlValue,
        } }));
    }, html);
}

async function postListOpenWorkspacesUpdate(page, activeAiSessions, historySessions, selectedTab = 'active') {
    const html = `<div class="open-current-workspace-group">
        ${listProjectMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>
    <div class="open-other-windows-group" data-other-windows-status="ready">
        ${currentOpenWorkspaceProjectMarkup()}
    </div>`;
    await page.evaluate(htmlValue => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'open-workspaces-updated', version: 2, semanticRevision: 'list-replacement',
            currentWorkspaceCount: 1, navigationWorkspaceCount: 0, otherWindowsStatus: 'ready',
            html: htmlValue,
            searchCatalog: {
                version: 2, sessions: [], openWorkspaces: [{ identity: 'project-a' }],
                savedProjects: [], todos: [],
            },
        } }));
    }, html);
}

async function relativeTop(locator) {
    return locator.evaluate((node, selector) => {
        const container = node.closest(selector);
        return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    }, '.codex-sessions-list');
}

function documentMarkup(activeAiSessions) {
    return `<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <div class="steward-sticky-header"></div>
                <div class="sticky-groups-wrapper">
                    <div class="open-current-workspace-group">
                        ${projectMarkup(activeAiSessions)}
                    </div>
                </div>
            </body>
        </html>`;
}

async function openCardPage(t, activeAiSessions, viewport = { width: 360, height: 900 }) {
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(documentMarkup(activeAiSessions));
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState() {},
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: todoGroupScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: todoControlScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

async function openListPage(t, activeAiSessions, historySessions) {
    const page = await browser.newPage({ viewport: { width: 360, height: 320 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head>
        <body class="steward-sidebar"><div class="steward-sticky-header"></div>
        <div class="sticky-groups-wrapper"><div class="open-current-workspace-group">
        ${listProjectMarkup(activeAiSessions, historySessions)}</div></div></body></html>`);
    await page.evaluate(() => {
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = { getState: () => undefined, setState() {}, postMessage() {} };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: todoGroupScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: todoControlScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => initProjects());
    return page;
}

function row(page, provider, sessionId) {
    return page.locator(
        `.active-ai-session-row[data-session-provider="${provider}"][data-session-id="${sessionId}"]`
    );
}

async function postedMessages(page) {
    return page.evaluate(() => window.__postedMessages);
}

async function postHostMessage(page, message) {
    await page.evaluate(value => {
        window.dispatchEvent(new MessageEvent('message', { data: value }));
    }, message);
}

function focusOrigin(overrides = {}) {
    return {
        type: 'focus-ai-session-conversation-origin',
        version: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'interaction-1',
        ...overrides,
    };
}

test('WEBVIEW-AI-SESSION-LIST-SCROLL-001 preserves semantic Active and History anchors through both workspace replacement paths', async t => {
    const active = Array.from({ length: 8 }, (_, index) => session(
        'codex', `active-${index + 1}`, index === 4
    ));
    const history = Array.from({ length: 8 }, (_, index) =>
        historySession('codex', `history-${index + 1}`)
    );
    const page = await openListPage(t, active, history);
    const activeAnchor = row(page, 'codex', 'active-5');
    await waitForPageCondition(page, () => {
        const list = document.querySelector('[data-ai-session-panel="active"] .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    const activeBefore = await activeAnchor.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        list.scrollTop = node.offsetTop - list.offsetTop - 22;
        node.querySelector('.ai-session-primary-action').focus();
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    await postListWorkspaceUpdate(page, [
        session('codex', 'active-inserted', false), ...active,
    ], history);
    const activeRestored = row(page, 'codex', 'active-5');
    assert.ok(Math.abs((await relativeTop(activeRestored)) - activeBefore) <= 1);
    assert.equal(await page.locator('[data-ai-session-tab="active"]').getAttribute('aria-selected'), 'true');
    assert.equal(await activeRestored.locator('.ai-session-primary-action').evaluate(node => document.activeElement === node), true);

    await page.locator('[data-ai-session-tab="sessions"]').click();
    const historyAnchor = page.locator(
        '.ai-session-history-panel .codex-session-row[data-session-id="history-5"]'
    );
    await waitForPageCondition(page, () => {
        const list = document.querySelector('[data-ai-session-panel="sessions"] .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    const historyBefore = await historyAnchor.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        list.scrollTop = node.offsetTop - list.offsetTop;
        node.querySelector('.ai-session-primary-action').focus();
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    await postListOpenWorkspacesUpdate(page, active, [
        history[3], history[1], historySession('codex', 'history-inserted'),
        history[0], history[2], ...history.slice(4),
    ]);
    const historyRestored = page.locator(
        '.ai-session-history-panel .codex-session-row[data-session-id="history-5"]'
    );
    assert.ok(Math.abs((await relativeTop(historyRestored)) - historyBefore) <= 1);
    assert.equal(await page.locator('[data-ai-session-tab="sessions"]').getAttribute('aria-selected'), 'true');
    assert.equal(await historyRestored.locator('.ai-session-primary-action').evaluate(node => document.activeElement === node), true);
});

test('ACTIVE-SESSION-CONVERSATION-OPEN-001 click focuses an unfocused card and opens the conversation for a focused card', async t => {
    const page = await openCardPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);

    await row(page, 'kimi', 'session-b').locator('.ai-session-primary-action').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'focus-ai-session-terminal',
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-b',
    });

    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'open-active-ai-session-conversation',
        version: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(
        await row(page, 'codex', 'session-a')
            .locator('.ai-session-open-conversation-hint').count(),
        1
    );
    assert.equal(
        await row(page, 'kimi', 'session-b')
            .locator('.ai-session-open-conversation-hint').count(),
        0
    );
});

test('ACTIVE-SESSION-CONVERSATION-FOCUS-001 restores ACTIVE and the origin card header without focusing another session', async t => {
    const page = await openCardPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focused = row(page, 'codex', 'session-a');
    const activeTab = page.locator('[data-ai-session-tab="active"]');
    const sessionsTab = page.locator('[data-ai-session-tab="sessions"]');
    await sessionsTab.click();
    assert.equal(await sessionsTab.getAttribute('aria-selected'), 'true');

    await postHostMessage(page, focusOrigin());
    assert.equal(await activeTab.getAttribute('aria-selected'), 'true');
    assert.equal(
        await focused.locator('.ai-session-primary-action')
            .evaluate(header => document.activeElement === header),
        true
    );
    assert.equal(
        await row(page, 'kimi', 'session-b')
            .locator('.ai-session-primary-action')
            .evaluate(header => document.activeElement === header),
        false
    );
});

test('ACTIVE-SESSION-CONVERSATION-FOCUS-002 falls back to ACTIVE for a stale same-project origin and ignores malformed or wrong-project messages', async t => {
    const page = await openCardPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const sessionsTab = page.locator('[data-ai-session-tab="sessions"]');
    const activeTab = page.locator('[data-ai-session-tab="active"]');
    await sessionsTab.focus();

    await postHostMessage(page, focusOrigin({
        sessionId: 'stale-session',
    }));
    assert.equal(
        await activeTab.evaluate(tab => document.activeElement === tab),
        true
    );

    await sessionsTab.focus();
    await postHostMessage(page, focusOrigin({
        projectId: 'other-project',
    }));
    assert.equal(
        await sessionsTab.evaluate(tab => document.activeElement === tab),
        true
    );

    await postHostMessage(page, {
        ...focusOrigin(),
        unexpected: true,
    });
    assert.equal(
        await sessionsTab.evaluate(tab => document.activeElement === tab),
        true
    );
});
