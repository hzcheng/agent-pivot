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

const { getAiSessionsDiv, getCurrentWorkspaceGroupContent } = loadWebviewContent();
const {
    CurrentWorkspaceSessionAuthority,
} = require('../../out/workspaces/currentWorkspaceSessionAuthority');
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
const aiSessionControlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
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

function currentWorkspaceGroupMarkup(
    activeAiSessions,
    attentionCount = 0,
    options = {}
) {
    const projectId = options.projectId || 'project-a';
    const scopeIdentity = options.scopeIdentity || 'scope-project-a';
    const navigationIdentity = options.navigationIdentity
        || 'navigation-project-a';
    return getCurrentWorkspaceGroupContent({
        id: projectId,
        kind: 'current',
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: activeAiSessions
            .filter(entry => entry.executionState === 'running').length,
        navigationIdentity,
        scopeIdentity,
        name: 'Project A',
        environment: 'local',
        environmentLabel: 'Local',
        color: '',
        roots: [{ id: 'root-project-a', name: 'Project A', ordinal: 0 }],
        attentionCount,
        aiSessions: {
            activeProvider: 'codex',
            selectedProviders: ['codex'],
            expanded: true,
            sessionsByProvider: { codex: [], kimi: [], claude: [] },
            unavailableProviders: [],
            activeSessions: activeAiSessions,
            aiSessionCount: 1,
            activeSessionCount: activeAiSessions.length,
            activeAttentionCount: activeAiSessions
                .filter(entry => entry.needsAttention).length,
        },
    });
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

async function isRowFullyVisibleInList(rowLocator) {
    return rowLocator.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        if (!list || node.offsetParent === null) return false;
        const listRect = list.getBoundingClientRect();
        const rowRect = node.getBoundingClientRect();
        return rowRect.height > 0
            && rowRect.top >= listRect.top - 1
            && rowRect.bottom <= listRect.bottom + 1;
    });
}

function documentMarkup(activeAiSessions, currentWorkspaceMarkup, initialPresentation) {
    const initialPresentationMarkup = initialPresentation
        ? `<script id="dashboard-ai-session-presentation" type="application/json">${JSON.stringify(
            initialPresentation
        ).replace(/</g, '\\u003c')}</script>`
        : '';
    return `<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                ${initialPresentationMarkup}
                <div class="steward-sticky-header"></div>
                <div class="sticky-groups-wrapper">
                    ${currentWorkspaceMarkup || `<div class="open-current-workspace-group">
                        ${projectMarkup(activeAiSessions)}
                    </div>`}
                </div>
            </body>
        </html>`;
}

async function openCardPage(
    t,
    activeAiSessions,
    viewport = { width: 360, height: 900 },
    currentWorkspaceMarkup,
    initialPresentation
) {
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(documentMarkup(
        activeAiSessions,
        currentWorkspaceMarkup,
        initialPresentation
    ));
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
    await page.addScriptTag({ content: aiSessionControlsScript });
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
    await page.addScriptTag({ content: aiSessionControlsScript });
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

function presentationMessage(activeSessions, projectionRevision, options = {}) {
    const attention = options.attention || {};
    const attentionSessions = Object.entries(attention).map(([sessionKey, eventIds]) => ({
        sessionKey,
        eventIds,
    }));
    const focusedEntry = activeSessions.find(entry => entry.focused);
    const focusedTarget = options.focusedTarget ?? (focusedEntry
        ? focusedEntry.pending
            ? { provider: focusedEntry.provider, pendingId: focusedEntry.pendingId }
            : { provider: focusedEntry.provider, sessionId: focusedEntry.sessionId }
        : null);
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision,
        workspaceScopeIdentity: 'scope-project-a',
        workspaceNavigationIdentity: 'navigation-project-a',
        attentionCount: options.attentionCount ?? attentionSessions.length,
        activeAttentionCount: activeSessions.filter(entry =>
            (attention[`${entry.provider}:${entry.sessionId}`] || []).length > 0
        ).length,
        runningSessionCount: activeSessions.filter(entry =>
            entry.executionState === 'running'
        ).length,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: options.revealFocused === true,
        focusedTarget,
        attentionSessions,
        sessions: activeSessions.filter(entry => !entry.pending).map(entry => {
            const eventIds = attention[`${entry.provider}:${entry.sessionId}`] || [];
            return {
                provider: entry.provider,
                sessionId: entry.sessionId,
                executionState: entry.executionState,
                focused: entry.focused,
                needsAttention: eventIds.length > 0,
                conflict: entry.conflict === true,
                eventIds,
            };
        }),
    };
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

test('ACTIVE-SESSION-FOCUS-REVEAL-001 reveals the newly focused card when a workspace or open-workspaces refresh moves focus', async t => {
    const active = Array.from({ length: 8 }, (_, index) => session(
        'codex', `active-${index + 1}`, index === 0
    ));
    const history = Array.from({ length: 8 }, (_, index) =>
        historySession('codex', `history-${index + 1}`)
    );
    const page = await openListPage(t, active, history);
    await waitForPageCondition(page, () => {
        const list = document.querySelector('[data-ai-session-panel="active"] .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), false);

    await postListWorkspaceUpdate(page, active.map((entry, index) => ({
        ...entry,
        focused: index === 6,
    })), history);
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), true);

    await page.locator('[data-ai-session-tab="sessions"]').click();
    assert.equal(
        await page.locator('[data-ai-session-tab="sessions"]').getAttribute('aria-selected'),
        'true'
    );
    await postListOpenWorkspacesUpdate(page, active.map((entry, index) => ({
        ...entry,
        focused: index === 1,
    })), history);
    assert.equal(
        await page.locator('[data-ai-session-tab="active"]').getAttribute('aria-selected'),
        'true'
    );
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-2')), true);
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 keeps a newer complete presentation when older HTML arrives later', async t => {
    const initial = [
        session('codex', 'session-a', true),
        session('codex', 'session-b', false),
    ];
    const page = await openCardPage(t, initial);
    await postHostMessage(page, presentationMessage(initial, 2));
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 1,
        projectionRevision: 1,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'session-a', false),
            session('codex', 'session-b', true),
        ])}</div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });

    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-ai-session-active-terminal'),
        ''
    );
    assert.equal(
        await row(page, 'codex', 'session-b').getAttribute('data-ai-session-active-terminal'),
        null
    );

    await postHostMessage(page, presentationMessage(initial, 4, { revealFocused: true }));
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 3,
        projectionRevision: 3,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'session-a', false),
            session('codex', 'session-b', true),
        ])}</div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-ai-session-active-terminal'),
        ''
    );
    assert.equal(
        await row(page, 'codex', 'session-a').locator('.ai-session-open-conversation-hint').count(),
        1
    );
    assert.equal(
        await row(page, 'codex', 'session-b').locator('.ai-session-open-conversation-hint').count(),
        0
    );

    const attentionState = [
        session('codex', 'session-a', true),
        { ...session('codex', 'session-b', false), executionState: 'stopped' },
    ];
    await postHostMessage(page, presentationMessage(attentionState, 6, {
        attention: { 'codex:session-b': ['event-b'] },
    }));
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 5,
        projectionRevision: 5,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'session-a', true),
            {
                ...session('codex', 'session-b', false),
                executionState: 'stopped',
            },
        ])}</div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });
    assert.equal(
        await row(page, 'codex', 'session-b').getAttribute('data-ai-session-attention'),
        ''
    );
    assert.equal(
        await row(page, 'codex', 'session-b').getAttribute('data-session-event-id'),
        'event-b'
    );
    assert.equal(
        await row(page, 'codex', 'session-b').locator('.ai-session-attention-indicator').count(),
        1
    );
});

test('ACTIVE-SESSION-PRESENTATION-TRANSACTION-001 accepts same-revision owner events after HTML arrives first', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'event-a',
    };
    const page = await openCardPage(t, [session('codex', 'session-a', true)]);
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 1,
        projectionRevision: 2,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
        ])}</div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });
    await postHostMessage(page, presentationMessage([attentionSession], 2, {
        attention: { 'codex:session-a': ['event-a', 'event-b'] },
    }));

    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements, [{
        type: 'acknowledge-ai-session-attention',
        eventIds: ['event-a', 'event-b'],
    }]);
});

test('ACTIVE-SESSION-PRESENTATION-TRANSACTION-001 keeps OPEN HTML and owner events in one revision', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'open-event-a',
    };
    const page = await openCardPage(t, [session('codex', 'session-a', true)]);
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 2,
        projectionRevision: 2,
        semanticRevision: 'open-transaction-revision',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
        ])}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
    });
    await postHostMessage(page, presentationMessage([attentionSession], 2, {
        attention: {
            'codex:session-a': ['open-event-a', 'open-event-b'],
        },
    }));

    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements, [{
        type: 'acknowledge-ai-session-attention',
        eventIds: ['open-event-a', 'open-event-b'],
    }]);
});

test('ACTIVE-SESSION-FULL-RENDER-TRANSACTION-001 seeds the full document revision and complete attention owners', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'event-a',
    };
    const initialPresentation = presentationMessage([attentionSession], 5, {
        attention: { 'codex:session-a': ['event-a', 'event-b'] },
    });
    const page = await openCardPage(
        t,
        [attentionSession],
        { width: 360, height: 900 },
        undefined,
        initialPresentation
    );

    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 4,
        projectionRevision: 4,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([{
            ...attentionSession,
            attentionEventId: 'stale-event',
        }])}</div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });

    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-session-event-id'),
        'event-a'
    );
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements, [{
        type: 'acknowledge-ai-session-attention',
        eventIds: ['event-a', 'event-b'],
    }]);
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 transfers pending focus through the complete presentation', async t => {
    const pending = {
        key: 'pending:codex:pending-one',
        provider: 'codex',
        pendingId: 'pending-one',
        name: 'New Codex session',
        executionState: 'starting',
        focused: true,
        needsAttention: false,
        pending: true,
        backend: 'tmux',
        tmuxLayout: 'project',
        attached: true,
        createdAt: '2026-08-10T00:00:00.000Z',
    };
    const established = session('codex', 'established-one', false);
    const page = await openCardPage(t, [pending, established]);
    const pendingRow = page.locator(
        '.active-ai-session-row[data-session-provider="codex"][data-pending-id="pending-one"]'
    );
    assert.equal(await pendingRow.getAttribute('data-session-focused'), '');
    await postHostMessage(page, presentationMessage(
        [pending, established],
        2,
        { focusedTarget: { provider: 'codex', pendingId: 'pending-one' } }
    ));
    assert.equal(
        await pendingRow.locator('.ai-session-primary-action').getAttribute('title'),
        'Focus pending Codex Session'
    );
    assert.equal(
        await pendingRow.locator('.ai-session-open-conversation-hint').count(),
        0
    );

    const focusedEstablished = { ...established, focused: true };
    await postHostMessage(page, presentationMessage(
        [pending, focusedEstablished],
        3,
        { focusedTarget: { provider: 'codex', sessionId: 'established-one' } }
    ));

    assert.equal(await pendingRow.getAttribute('data-session-focused'), null);
    assert.equal(
        await row(page, 'codex', 'established-one').getAttribute('data-session-focused'),
        ''
    );
    assert.equal(
        await page.locator('.codex-session-row[data-session-focused]').count(),
        1
    );
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 ignores stale Attention DOM state while an Active Session is running', async t => {
    const running = session('codex', 'current-session', true);
    const page = await openCardPage(t, [running]);

    await postHostMessage(page, presentationMessage([running], 2));

    const currentRow = row(page, 'codex', 'current-session');
    assert.equal(await currentRow.getAttribute('data-execution-state'), 'running');
    assert.notEqual(await currentRow.getAttribute('data-session-icon-fx'), null);
    assert.equal(await currentRow.getAttribute('data-session-needs-attention'), null);
    assert.equal(await currentRow.getAttribute('data-ai-session-attention'), null);
    assert.equal(await currentRow.getAttribute('data-session-event-id'), null);
    assert.equal(await currentRow.locator('.ai-session-attention-indicator').count(), 0);

    const stopped = { ...running, executionState: 'stopped' };
    await postHostMessage(page, presentationMessage([stopped], 3, {
        attention: { 'codex:current-session': ['stale-event'] },
    }));

    const stoppedRow = row(page, 'codex', 'current-session');
    assert.equal(await stoppedRow.getAttribute('data-session-icon-fx'), null);
    assert.equal(await stoppedRow.getAttribute('data-ai-session-attention'), '');
    assert.equal(await stoppedRow.getAttribute('data-session-event-id'), 'stale-event');
    assert.equal(await stoppedRow.locator('.ai-session-attention-indicator').count(), 1,
        'suppressing the running dot does not discard the authoritative Attention event');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 applies every Active Session presentation surface atomically', async t => {
    const stoppedSession = {
        ...session('codex', 'current-session', true),
        executionState: 'stopped',
    };
    const page = await openCardPage(
        t,
        [stoppedSession],
        { width: 360, height: 900 },
        `${currentWorkspaceGroupMarkup([stoppedSession])}
            <div class="open-other-windows-group">${currentOpenWorkspaceProjectMarkup()}</div>`
    );
    await page.evaluate(() => {
        document.querySelector('.workspace-card[data-current-workspace]')
            .setAttribute('data-workspace-scope-identity', 'scope-before-root-change');
        window.__activeSessionPresentationSnapshots = [];
        window.__readActiveSessionPresentation = () => {
            const card = document.querySelector('.workspace-card[data-current-workspace]');
            const row = card.querySelector('.active-ai-session-row[data-session-id="current-session"]');
            const summary = card.querySelector('.project-codex-badge');
            const compact = document.querySelector(
                '.workspace-card[data-open-workspace-current]'
            );
            return {
                rowAttention: row.hasAttribute('data-ai-session-attention'),
                tabAttention: !!card.querySelector('[data-ai-session-tab="active"] .ai-session-tab-attention'),
                summaryAttention: Number(summary.getAttribute('data-ai-session-attention-count')),
                rowRunning: row.getAttribute('data-execution-state') === 'running'
                    && row.getAttribute('data-session-icon-fx') === 'current',
                cardRunning: card.classList.contains('session-running')
                    && card.getAttribute('data-session-fx') === 'current'
                    && !!card.querySelector('.project-session-fx'),
                compactAttention: Number(
                    compact.querySelector('.project-ai-attention-badge')?.textContent || 0
                ),
                compactRunning: compact.classList.contains('session-running')
                    && compact.getAttribute('data-session-fx') === 'current'
                    && Number(compact.querySelector(
                        '.project-codex-badge[data-ai-session-active-count]'
                    )?.getAttribute('data-ai-session-active-count') || 0) === 1,
            };
        };
        window.__activeSessionPresentationObserver = new MutationObserver(() => {
            window.__activeSessionPresentationSnapshots.push(
                window.__readActiveSessionPresentation()
            );
        });
        window.__activeSessionPresentationObserver.observe(
            document.querySelector('.workspace-card[data-current-workspace]'),
            { attributes: true, childList: true, subtree: true }
        );
    });

    await postHostMessage(page, {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision: 2,
        workspaceScopeIdentity: 'scope-project-a',
        workspaceNavigationIdentity: 'navigation-project-a',
        attentionCount: 1,
        activeAttentionCount: 1,
        runningSessionCount: 0,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: { provider: 'codex', sessionId: 'current-session' },
        attentionSessions: [{
            sessionKey: 'codex:current-session',
            eventIds: ['attention-event'],
        }],
        sessions: [{
            provider: 'codex',
            sessionId: 'current-session',
            executionState: 'stopped',
            focused: true,
            needsAttention: true,
            conflict: false,
            eventIds: ['attention-event'],
        }],
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const attentionState = {
        rowAttention: true,
        tabAttention: true,
        summaryAttention: 1,
        rowRunning: false,
        cardRunning: false,
        compactAttention: 1,
        compactRunning: false,
    };
    assert.deepEqual(await page.evaluate(() => window.__readActiveSessionPresentation()), attentionState);
    assert.deepEqual(
        await page.evaluate(() => window.__activeSessionPresentationSnapshots),
        [attentionState]
    );

    await page.evaluate(() => { window.__activeSessionPresentationSnapshots = []; });
    await postHostMessage(page, {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision: 3,
        workspaceScopeIdentity: 'scope-project-a',
        workspaceNavigationIdentity: 'navigation-project-a',
        attentionCount: 0,
        activeAttentionCount: 0,
        runningSessionCount: 1,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: { provider: 'codex', sessionId: 'current-session' },
        attentionSessions: [],
        sessions: [{
            provider: 'codex',
            sessionId: 'current-session',
            executionState: 'running',
            focused: true,
            needsAttention: false,
            conflict: false,
            eventIds: [],
        }],
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const runningState = {
        rowAttention: false,
        tabAttention: false,
        summaryAttention: 0,
        rowRunning: true,
        cardRunning: true,
        compactAttention: 0,
        compactRunning: true,
    };
    assert.deepEqual(await page.evaluate(() => window.__readActiveSessionPresentation()), runningState);
    assert.deepEqual(
        await page.evaluate(() => window.__activeSessionPresentationSnapshots),
        [runningState]
    );
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 creates and clears a previously empty current summary', async t => {
    const page = await openCardPage(t, []);
    const card = page.locator('.workspace-card[data-current-workspace]');
    assert.equal(await card.locator('.project-codex-badge').count(), 0);

    await postHostMessage(page, presentationMessage([], 2, {
        attention: { 'codex:history-only': ['history-attention'] },
    }));
    assert.equal(
        await card.locator('.ai-session-attention-count').textContent(),
        '1'
    );
    assert.equal(await card.getAttribute('data-has-ai-session-badge'), '');

    await postHostMessage(page, presentationMessage([], 3));
    assert.equal(await card.locator('.project-codex-badge').count(), 0);
    assert.equal(await card.getAttribute('data-has-ai-session-badge'), null);
});

test('ACTIVE-SESSION-ATTENTION-PROJECTION-001 never flashes stale attention during a window-switch projection', async t => {
    const active = [
        session('codex', 'session-a', false),
        session('codex', 'session-b', true),
        session('codex', 'session-c', false),
    ].map(entry => ({ ...entry, executionState: 'stopped' }));
    const page = await openCardPage(t, active);
    await postHostMessage(page, presentationMessage(active, 2, {
        attention: { 'codex:session-b': ['event-b'] },
    }));
    await page.evaluate(() => {
        window.__attentionProjectionSnapshots = [];
        const recordAttentionProjection = () => {
            window.__attentionProjectionSnapshots.push(Array.from(document.querySelectorAll(
                '.active-ai-session-row[data-ai-session-attention][data-session-id]'
            ), candidate => candidate.getAttribute('data-session-id')).sort());
        };
        window.__attentionProjectionObserver = new MutationObserver(recordAttentionProjection);
        window.__attentionProjectionObserver.observe(
            document.querySelector('.sticky-groups-wrapper'),
            { attributes: true, childList: true, subtree: true }
        );
    });

    const authoritativeAttention = active.map(entry => ({
        ...entry,
        needsAttention: entry.sessionId === 'session-c',
        ...(entry.sessionId === 'session-c' ? { attentionEventId: 'event-c' } : {}),
    }));
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 2,
        projectionRevision: 4,
        semanticRevision: 'stale-window-switch-attention',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup(authoritativeAttention)}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 2,
            sessions: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await postHostMessage(page, presentationMessage(active, 3, {
        attention: { 'codex:session-b': ['stale-event-b'] },
    }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

    const snapshots = await page.evaluate(() => {
        window.__attentionProjectionObserver.disconnect();
        return window.__attentionProjectionSnapshots;
    });
    assert.ok(snapshots.length > 0);
    assert.deepEqual(
        snapshots.filter(snapshot => snapshot.join(',') !== 'session-b'
            && snapshot.join(',') !== 'session-c'),
        [],
        `stale attention became observable: ${JSON.stringify(snapshots)}`
    );
    assert.equal(
        await row(page, 'codex', 'session-c').locator('.ai-session-attention-indicator').count(),
        1
    );
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 reveals a newer direct focus projection inside the bounded Active list', async t => {
    const active = Array.from({ length: 8 }, (_, index) => session(
        'codex', `active-${index + 1}`, index === 0
    ));
    const history = Array.from({ length: 8 }, (_, index) =>
        historySession('codex', `history-${index + 1}`)
    );
    const page = await openListPage(t, active, history);
    await waitForPageCondition(page, () => {
        const list = document.querySelector('[data-ai-session-panel="active"] .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), false);

    await postHostMessage(page, presentationMessage(active.map((entry, index) => ({
        ...entry,
        focused: index === 6,
    })), 2, { revealFocused: true }));

    assert.equal(await row(page, 'codex', 'active-7').getAttribute('data-session-focused'), '');
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), true);
    assert.equal(
        await row(page, 'codex', 'active-7').locator('.ai-session-primary-action').getAttribute('title'),
        'Open AI conversation for Codex Session'
    );
    assert.equal(
        await row(page, 'codex', 'active-7').locator('.ai-session-primary-action').getAttribute('aria-label'),
        'Open AI conversation for Codex session codex active-7'
    );
    assert.equal(
        await row(page, 'codex', 'active-1').locator('.ai-session-primary-action').getAttribute('title'),
        'Focus Codex Session'
    );
    assert.equal(
        await row(page, 'codex', 'active-1').locator('.ai-session-primary-action').getAttribute('aria-label'),
        'Focus Codex session codex active-1 using Direct VS Code terminal, attached'
    );
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 scrolls the origin card into view when conversation focus returns to the sidebar', async t => {
    const active = Array.from({ length: 8 }, (_, index) => session(
        'codex', `active-${index + 1}`, index === 6
    ));
    const history = Array.from({ length: 8 }, (_, index) =>
        historySession('codex', `history-${index + 1}`)
    );
    const page = await openListPage(t, active, history);
    await waitForPageCondition(page, () => {
        const list = document.querySelector('[data-ai-session-panel="active"] .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), false);

    await postHostMessage(page, focusOrigin({ sessionId: 'active-7' }));
    assert.equal(
        await row(page, 'codex', 'active-7')
            .locator('.ai-session-primary-action')
            .evaluate(header => document.activeElement === header),
        true
    );
    assert.equal(await isRowFullyVisibleInList(row(page, 'codex', 'active-7')), true);
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

test('ACTIVE-SESSION-CONVERSATION-OPEN-001 RUNTIME-WORKSPACE-TOPOLOGY-CONTINUITY-001 rendered Conversation actions keep one project authority when roots change', async t => {
    const authority = new CurrentWorkspaceSessionAuthority();
    const beforeProjectId = authority.getProjectId({
        workspaceNavigationIdentity: 'navigation:reddb-dev',
        workspaceScopeIdentity: 'scope:three-roots',
    });
    const active = [session('codex', 'session-a', true)];
    const page = await openCardPage(
        t,
        active,
        { width: 360, height: 900 },
        currentWorkspaceGroupMarkup(active, 0, {
            projectId: beforeProjectId,
            scopeIdentity: 'scope:three-roots',
            navigationIdentity: 'navigation:reddb-dev',
        })
    );
    const afterProjectId = authority.getProjectId({
        workspaceNavigationIdentity: 'navigation:reddb-dev',
        workspaceScopeIdentity: 'scope:five-roots',
    });

    await postHostMessage(page, {
        type: 'workspace-updated',
        version: 2,
        currentWorkspaceCount: 1,
        html: currentWorkspaceGroupMarkup(active, 0, {
            projectId: afterProjectId,
            scopeIdentity: 'scope:five-roots',
            navigationIdentity: 'navigation:reddb-dev',
        }),
    });
    await row(page, 'codex', 'session-a')
        .locator('.ai-session-primary-action')
        .click();

    assert.equal(
        await page.locator('[data-current-workspace]').getAttribute('data-id'),
        beforeProjectId
    );
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'open-active-ai-session-conversation',
        version: 1,
        projectId: beforeProjectId,
        provider: 'codex',
        sessionId: 'session-a',
    });
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
