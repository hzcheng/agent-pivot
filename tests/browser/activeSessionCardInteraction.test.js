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

function loadDashboardMessageHandlers() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
        parse: value => ({ fsPath: value, path: value, toString: () => value }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/dashboard/messageHandlers');
    } finally {
        Module._load = previousLoad;
    }
}

function loadOpenWorkspaceDashboardController() {
    const vscode = createFakeVscode({});
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/openWorkspaces/dashboardController');
    } finally {
        Module._load = previousLoad;
    }
}

const {
    getAiSessionsDiv,
    getCurrentWorkspaceGroupContent,
    getStewardContent,
} = loadWebviewContent();
const { createDashboardMessageHandlers } = loadDashboardMessageHandlers();
const { OpenWorkspaceDashboardController } = loadOpenWorkspaceDashboardController();
const {
    AiSessionAttentionController,
} = require('../../out/aiSessions/attentionController');
const {
    createAiSessionAttentionEventCapability,
} = require('../../out/aiSessions/attentionEventCapability');
const {
    AiSessionDashboardController,
} = require('../../out/aiSessions/dashboardController');
const {
    getAttentionProjectKey,
} = require('../../out/aiSessions/attentionProject');
const {
    CurrentWorkspaceSessionAuthority,
} = require('../../out/workspaces/currentWorkspaceSessionAuthority');
const {
    AiSessionProjectionCoordinator,
} = require('../../out/workspaces/sessionHydrationController');
const {
    hydrateWorkspaceAiSessions,
} = require('../../out/workspaces/sessionHydration');
const {
    buildOpenWorkspacesUpdatedMessage,
} = require('../../out/dashboard/webviewUpdateMessages');
const {
    getRenderedCurrentWorkspaceNavigationIdentity,
    buildAiSessionPresentationState,
} = require('../../out/aiSessions/presentationMessage');
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

function waitForPageCondition(page, condition, argument) {
    return page.waitForFunction(condition, argument, {
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
        data-workspace-navigation-identity="navigation-project-a">
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
            aiSessionCount: activeAiSessions.length,
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
        data-workspace-navigation-identity="navigation-project-a">
        ${listSessionSurfaceMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>`;
}

function currentOpenWorkspaceProjectMarkup() {
    return `<div class="project workspace-card" data-id="project-a"
        data-open-workspace-list-card data-open-workspace-current
        data-workspace-navigation-identity="navigation-project-a"></div>`;
}

async function postListAiSessionsUpdate(
    page,
    activeAiSessions,
    historySessions,
    selectedTab = 'active',
    projectionRevision = 2
) {
    const html = `<div class="open-current-workspace-group">
        ${listProjectMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>`;
    const presentation = presentationMessage(activeAiSessions, projectionRevision);
    await page.evaluate(({ htmlValue, presentationValue, revision }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'ai-sessions-updated', version: 3,
            sequence: revision, projectionRevision: revision,
            generatedAt: '2026-08-11T00:00:00.000Z',
            currentWorkspaceCount: 1, html: htmlValue,
            searchCatalog: {
                version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [],
            },
            presentation: presentationValue,
        } }));
    }, { htmlValue: html, presentationValue: presentation, revision: projectionRevision });
}

async function postListOpenWorkspacesUpdate(
    page,
    activeAiSessions,
    historySessions,
    selectedTab = 'active',
    projectionRevision = 2
) {
    const html = `<div class="open-current-workspace-group">
        ${listProjectMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>
    <div class="open-other-windows-group" data-other-windows-status="ready">
        ${currentOpenWorkspaceProjectMarkup()}
    </div>`;
    const presentation = presentationMessage(activeAiSessions, projectionRevision);
    await page.evaluate(({ htmlValue, presentationValue, revision }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'open-workspaces-updated', version: 3,
            semanticRevision: `list-replacement-${revision}`,
            projectionRevision: revision,
            currentWorkspaceCount: 1, navigationWorkspaceCount: 0, otherWindowsStatus: 'ready',
            html: htmlValue,
            searchCatalog: {
                version: 3, sessions: [], worktrees: [], openWorkspaces: [{ identity: 'project-a' }],
                savedProjects: [], todos: [],
            },
            presentation: presentationValue,
        } }));
    }, { htmlValue: html, presentationValue: presentation, revision: projectionRevision });
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
    initialPresentation,
    preserveInitialMessages = false
) {
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(documentMarkup(
        activeAiSessions,
        currentWorkspaceMarkup,
        initialPresentation
    ));
    await bootCardPageScripts(page, preserveInitialMessages);
    return page;
}

async function bootCardPageScripts(page, preserveInitialMessages = false) {
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
    await page.evaluate(preserveMessages => {
        initProjects();
        if (!preserveMessages) window.__postedMessages.length = 0;
    }, preserveInitialMessages);
}

function productionDashboardDocumentMarkup(cards, presentation) {
    return getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'https://assets.test',
            asWebviewUri: resource => ({
                toString: () => `https://assets.test/${path.basename(resource.fsPath)}`,
            }),
        },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
        cards,
        'ready',
        2,
        presentation,
    )
        .replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')
        .replace(/<link[^>]*rel="stylesheet"[^>]*>/, '')
        .replace(/<script(?![^>]*type="application\/json")[\s\S]*?<\/script>/g, '')
        .replace('</head>', `<style>${styles}</style></head>`)
        .replace('class="dashboard-styles-pending"', '');
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

function presentationSnapshot(activeSessions, options = {}) {
    const message = presentationMessage(activeSessions, 1, options);
    return {
        workspaceScopeIdentity: message.workspaceScopeIdentity,
        workspaceNavigationIdentity: message.workspaceNavigationIdentity,
        attentionCount: message.attentionCount,
        activeAttentionCount: message.activeAttentionCount,
        runningSessionCount: message.runningSessionCount,
        focusedTarget: message.focusedTarget,
        attentionSessions: message.attentionSessions,
        sessions: message.sessions,
    };
}

function aiSessionViewModel(activeSessions) {
    return {
        activeProvider: 'codex',
        selectedProviders: ['codex'],
        expanded: true,
        sessionsByProvider: { codex: [], kimi: [], claude: [] },
        unavailableProviders: [],
        activeSessions,
        aiSessionCount: activeSessions.length,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(entry => entry.needsAttention).length,
        attentionCount: activeSessions.filter(entry => entry.needsAttention).length,
    };
}

function aiSessionsEnvelope(activeSessions, projectionRevision, options = {}) {
    const presentation = {
        ...presentationMessage(activeSessions, projectionRevision, options),
        ...(options.presentationOverrides || {}),
    };
    const attentionCount = options.attentionCount
        ?? Object.keys(options.attention || {}).length;
    return {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: projectionRevision,
        projectionRevision,
        generatedAt: '2026-08-11T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: currentWorkspaceGroupMarkup(activeSessions, attentionCount),
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
        presentation,
    };
}

function openWorkspacesEnvelope(activeSessions, projectionRevision, options = {}) {
    const presentation = {
        ...presentationMessage(activeSessions, projectionRevision, options),
        ...(options.presentationOverrides || {}),
    };
    const attentionCount = options.attentionCount
        ?? Object.keys(options.attention || {}).length;
    return {
        type: 'open-workspaces-updated',
        version: 3,
        projectionRevision,
        semanticRevision: options.semanticRevision || `open-revision-${projectionRevision}`,
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `${currentWorkspaceGroupMarkup(activeSessions, attentionCount)}
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
        presentation,
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

function attentionAggregate(revision, projectId, sessionKey, eventIds) {
    return {
        protocolVersion: 1,
        aggregateRevision: revision,
        generatedAtMs: 1_000,
        sessions: eventIds.length ? [{
            projectId,
            sessionKey,
            reasons: ['completed'],
            eventIds,
            observedAtMs: 1_000,
        }] : [],
    };
}

function createAttentionAcknowledgementHandler(acknowledgeEventIds, postMessage) {
    const ignored = async () => undefined;
    return createDashboardMessageHandlers({
        postMessage: postMessage || ignored,
        getStewardInfos: () => ({ config: { get: (_key, fallback) => fallback } }),
        projectService: { getGroups: () => [] },
        promptDashboardController: { getPanelContent: ignored, handle: ignored },
        getPromptTerminalCommandController: () => ({ handleInsertRequest: ignored }),
        aiSessionCommandController: {
            toggleSessionsExpanded: ignored,
            selectProviders: ignored,
            togglePin: ignored,
            renameSession: ignored,
            copySessionId: ignored,
        },
        aiSessionTerminalCommandController: {
            focusActive: async () => false,
            focusPending: ignored,
            closeTerminal: ignored,
            stopSession: ignored,
        },
        conversationCapability: { followActiveConversation: ignored },
        aiSessionArchiveController: { archiveSessions: ignored },
        acknowledgeAiSessionAttentionEventIds: acknowledgeEventIds,
        logOpenWorkspaceDiagnostic() {},
        refreshStewardViews() {},
        requestActiveAiSessionTerminalHighlight() {},
        onOpenWorkspacesRendererReady() {},
        showAgentPivotSettings: ignored,
        showBridgeExtension: ignored,
        showSponsorOptions: ignored,
        showWarningMessage() {},
    })['acknowledge-ai-session-attention'];
}

async function assertAttentionCleared(page, provider, sessionId) {
    const sessionRow = row(page, provider, sessionId);
    const project = page.locator('.workspace-card[data-current-workspace]');
    const compact = page.locator('.workspace-card[data-open-workspace-current]');
    assert.equal(await sessionRow.getAttribute('data-session-needs-attention'), null);
    assert.equal(await sessionRow.getAttribute('data-ai-session-attention'), null);
    assert.equal(await sessionRow.getAttribute('data-session-event-id'), null);
    assert.equal(await sessionRow.getAttribute('data-attention-acknowledgement-pending'), null);
    assert.equal(await sessionRow.locator('.ai-session-attention-indicator').count(), 0);
    assert.equal(await project.locator('[data-ai-session-tab="active"] .ai-session-tab-attention').count(), 0);
    assert.equal(await project.locator('.ai-session-attention-count').count(), 0);
    assert.equal(
        await project.locator('.project-codex-badge').getAttribute('data-ai-session-attention-count'),
        '0'
    );
    assert.doesNotMatch(
        await project.locator('.project-codex-badge').getAttribute('aria-label'),
        /attention/i
    );
    assert.equal(await compact.locator('.project-ai-attention-badge').count(), 0);
}

test('WEBVIEW-AI-SESSION-LIST-SCROLL-001 preserves semantic Active and History anchors through both atomic replacement paths', async t => {
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
    await postListAiSessionsUpdate(page, [
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
    ], 'active', 3);
    const historyRestored = page.locator(
        '.ai-session-history-panel .codex-session-row[data-session-id="history-5"]'
    );
    assert.ok(Math.abs((await relativeTop(historyRestored)) - historyBefore) <= 1);
    assert.equal(await page.locator('[data-ai-session-tab="sessions"]').getAttribute('aria-selected'), 'true');
    assert.equal(await historyRestored.locator('.ai-session-primary-action').evaluate(node => document.activeElement === node), true);
});

test('WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001 syncs the group fit class when the card toggles', async t => {
    const active = [session('codex', 'active-1', true)];
    const page = await openCardPage(t, active, { width: 360, height: 900 },
        currentWorkspaceGroupMarkup(active));
    const group = page.locator('.open-current-workspace-group');
    const cardDescription = page.locator('.open-current-workspace-group .workspace-card .project-description');
    assert.equal(
        await group.evaluate(node => node.classList.contains('current-card-expanded')),
        true,
        'the expanded fixture must render the fit class on the group'
    );

    await cardDescription.click();
    await waitForPageCondition(page, () => !document.querySelector(
        '.open-current-workspace-group .workspace-card'
    ).hasAttribute('data-codex-expanded'));
    assert.equal(
        await group.evaluate(node => node.classList.contains('current-card-expanded')),
        false,
        'collapsing the card must drop the fit class from the group'
    );
    assert.ok(
        (await page.evaluate(() => window.__postedMessages))
            .some(message => message.type === 'toggle-codex-sessions' && message.expanded === false),
        'the collapse must still post the toggle message'
    );

    await cardDescription.click();
    await waitForPageCondition(page, () => document.querySelector(
        '.open-current-workspace-group .workspace-card'
    ).hasAttribute('data-codex-expanded'));
    assert.equal(
        await group.evaluate(node => node.classList.contains('current-card-expanded')),
        true,
        're-expanding the card must restore the fit class on the group'
    );
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 reveals the newly focused card when an AI or open-workspaces refresh moves focus', async t => {
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

    await postListAiSessionsUpdate(page, active.map((entry, index) => ({
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
    })), history, 'active', 3);
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
    await postHostMessage(page, presentationMessage(initial, 2, { revealFocused: true }));
    await postHostMessage(page, aiSessionsEnvelope([
        session('codex', 'session-a', false),
        session('codex', 'session-b', true),
    ], 1));

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
    await postHostMessage(page, aiSessionsEnvelope([
        session('codex', 'session-a', false),
        session('codex', 'session-b', true),
    ], 3));
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
        revealFocused: true,
    }));
    await postHostMessage(page, aiSessionsEnvelope([
        session('codex', 'session-a', true),
        {
            ...session('codex', 'session-b', false),
            executionState: 'stopped',
        },
    ], 5));
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

test('ACTIVE-SESSION-FOCUS-REVEAL-001 keeps the focused card highlight when another workspace has the same session identity', async t => {
    const initial = [
        session('codex', 'session-a', true),
        session('codex', 'session-b', false),
    ];
    const page = await openCardPage(t, initial);
    await page.addStyleTag({
        content: ':root { --vscode-focusBorder: rgb(0, 127, 212); }'
            + ' *, *::before, *::after { transition: none !important; }',
    });
    const focusedRow = row(page, 'codex', 'session-a');
    const primaryAction = focusedRow.locator('.ai-session-primary-action');
    await postHostMessage(page, presentationMessage(initial, 2, { revealFocused: true }));
    assert.equal(await focusedRow.getAttribute('data-session-focused'), '');
    assert.equal(await focusedRow.getAttribute('data-ai-session-active-terminal'), '');
    assert.equal(await primaryAction.getAttribute('title'), 'Open AI conversation for Codex Session');
    assert.match(
        await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
        /rgba?\(0, 127, 212/
    );

    const otherWorkspacePresentation = presentationMessage(
        initial,
        3,
        {
            focusedTarget: { provider: 'codex', sessionId: 'session-a' },
            revealFocused: true,
        }
    );
    otherWorkspacePresentation.workspaceScopeIdentity = 'scope-project-b';
    otherWorkspacePresentation.workspaceNavigationIdentity = 'navigation-project-b';
    await postHostMessage(page, otherWorkspacePresentation);

    assert.equal(await focusedRow.getAttribute('data-session-focused'), '');
    assert.equal(await focusedRow.getAttribute('data-ai-session-active-terminal'), '');
    assert.equal(await focusedRow.locator('.ai-session-open-conversation-hint').count(), 1);
    assert.equal(await primaryAction.getAttribute('title'), 'Open AI conversation for Codex Session');
    assert.match(
        await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
        /rgba?\(0, 127, 212/
    );
    await page.setViewportSize({ width: 240, height: 900 });
    assert.match(
        await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
        /rgba?\(0, 127, 212/
    );
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'request-full-refresh',
        reason: 'mismatched-ai-session-presentation-workspace',
    });

    await page.evaluate(() => { window.__postedMessages.length = 0; });
    const replacement = [session('codex', 'session-c', true)];
    for (const envelope of [
        aiSessionsEnvelope(replacement, 4, {
            presentationOverrides: {
                workspaceScopeIdentity: 'scope-project-b',
                workspaceNavigationIdentity: 'navigation-project-b',
            },
        }),
        openWorkspacesEnvelope(replacement, 5, {
            presentationOverrides: {
                workspaceScopeIdentity: 'scope-project-b',
                workspaceNavigationIdentity: 'navigation-project-b',
            },
        }),
    ]) {
        await postHostMessage(page, envelope);
        assert.equal(await row(page, 'codex', 'session-c').count(), 0);
        assert.equal(await focusedRow.getAttribute('data-session-focused'), '');
        assert.match(
            await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
            /rgba?\(0, 127, 212/
        );
        assert.deepEqual((await postedMessages(page)).at(-1), {
            type: 'request-full-refresh',
            reason: 'mismatched-ai-session-presentation-workspace',
        });
    }
    await postHostMessage(page, presentationMessage(initial, 5, { revealFocused: true }));
    assert.equal(await focusedRow.getAttribute('data-session-focused'), '',
        'a rejected workspace envelope must not commit its projection revision');
    await primaryAction.click();
    assert.equal((await postedMessages(page)).at(-1).type, 'open-active-ai-session-conversation');
});

test('OPEN-WORKSPACE-PRESENTATION-CONVERGENCE-001 applies a production OPEN transaction without refreshing when the Bridge self-registration lags', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);
    await page.addStyleTag({
        content: ':root { --vscode-focusBorder: rgb(0, 127, 212); }'
            + ' *, *::before, *::after { transition: none !important; }',
    });
    const currentWorkspace = {
        navigationIdentity: 'navigation-project-a',
        scopeIdentity: 'scope-project-a',
        kind: 'singleFolder',
        displayName: 'Project A',
        navigationUri: 'file:///work/project-a',
        environment: 'local',
        roots: [{
            id: 'root-project-a',
            name: 'Project A',
            uri: 'file:///work/project-a',
            hostPath: '/work/project-a',
            ordinal: 0,
        }],
    };
    const staleBridgeWorkspace = {
        ...currentWorkspace,
        navigationIdentity: 'navigation-stale-bridge',
        scopeIdentity: 'scope-stale-bridge',
    };
    const transaction = {
        revision: 2,
        presentation: presentationSnapshot(replacement),
    };
    const delivered = [];
    const controller = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => currentWorkspace,
        isWorkspaceSavedAsProject: () => true,
        getWorkspaceProjectColor: () => '',
        getCurrentWorkspaceAiSessions: () => aiSessionViewModel(replacement),
        beginAiSessionProjection: () => transaction,
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => 'current',
        getRunningIconAnimation: () => 'current',
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => '11111111111111111111111111111111',
        postMessage: message => { delivered.push(message); return Promise.resolve(true); },
        refresh() {},
        isVisible: () => true,
        logDiagnostic() {},
        logError(error) { throw error; },
        nowMs: () => 5_000,
    });
    controller.setAggregate({
        protocolVersion: 4,
        semanticRevision: 'b'.repeat(64),
        observedAtMs: 5_000,
        registrations: [{
            protocolVersion: 4,
            instanceId: '11111111111111111111111111111111',
            sequence: 1,
            openedAtMs: 1_000,
            lastFocusedAtMs: 4_000,
            leaseUpdatedAtMs: 4_500,
            workspace: staleBridgeWorkspace,
        }],
    });

    await controller.postUpdated();
    assert.equal(delivered.length, 1);
    assert.equal(
        delivered[0].presentation.workspaceScopeIdentity,
        currentWorkspace.scopeIdentity,
    );
    await postHostMessage(page, delivered[0]);

    const focusedRow = row(page, 'codex', 'session-b');
    assert.equal(await row(page, 'codex', 'session-a').count(), 0);
    assert.equal(await focusedRow.getAttribute('data-session-focused'), '');
    assert.match(
        await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
        /rgba?\(0, 127, 212/,
    );
    assert.equal(
        await page.locator('[data-current-workspace]')
            .getAttribute('data-workspace-navigation-identity'),
        staleBridgeWorkspace.navigationIdentity,
    );
    assert.equal(
        await page.locator('[data-current-workspace]')
            .getAttribute('data-workspace-scope-identity'),
        currentWorkspace.scopeIdentity,
    );
    assert.deepEqual((await postedMessages(page)).filter(message =>
        message.type === 'request-full-refresh'
    ), []);

    const mismatchedEnvelope = {
        ...delivered[0],
        projectionRevision: 3,
        semanticRevision: 'c'.repeat(64),
        presentation: {
            ...delivered[0].presentation,
            projectionRevision: 3,
            workspaceScopeIdentity: currentWorkspace.scopeIdentity,
            workspaceNavigationIdentity: currentWorkspace.navigationIdentity,
        },
    };
    await postHostMessage(page, mismatchedEnvelope);
    assert.deepEqual((await postedMessages(page)).filter(message =>
        message.type === 'request-full-refresh'
    ), [{
        type: 'request-full-refresh',
        reason: 'mismatched-ai-session-presentation-workspace',
    }]);

    const cards = controller.getCards(transaction);
    const fullDocumentPresentation = buildAiSessionPresentationState(
        false,
        transaction,
        getRenderedCurrentWorkspaceNavigationIdentity(cards),
        'current',
        'current',
    );
    await page.setContent(productionDashboardDocumentMarkup(
        cards,
        fullDocumentPresentation,
    ));
    await bootCardPageScripts(page, true);

    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), '');
    assert.equal(
        await page.locator('[data-current-workspace]')
            .getAttribute('data-workspace-navigation-identity'),
        staleBridgeWorkspace.navigationIdentity,
    );
    assert.equal(
        await page.locator('[data-current-workspace]')
            .getAttribute('data-workspace-scope-identity'),
        currentWorkspace.scopeIdentity,
    );
    assert.deepEqual((await postedMessages(page)).filter(message =>
        message.type === 'request-full-refresh'
    ), [], 'the production full-refresh response must converge in one document generation');
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 rejects a reused OPEN semantic revision before adopting another workspace focus', async t => {
    const initial = [session('codex', 'session-a', true)];
    const page = await openCardPage(t, initial);
    await page.addStyleTag({
        content: ':root { --vscode-focusBorder: rgb(0, 127, 212); }'
            + ' *, *::before, *::after { transition: none !important; }',
    });
    await postHostMessage(page, openWorkspacesEnvelope(initial, 2, {
        semanticRevision: 'reused-open-revision',
    }));
    await page.evaluate(() => { window.__postedMessages.length = 0; });

    const otherWorkspace = openWorkspacesEnvelope(
        [session('codex', 'session-b', true)],
        3,
        {
            semanticRevision: 'reused-open-revision',
            presentationOverrides: {
                workspaceScopeIdentity: 'scope-project-b',
                workspaceNavigationIdentity: 'navigation-project-b',
            },
        }
    );
    otherWorkspace.html = `${currentWorkspaceGroupMarkup(
        [session('codex', 'session-b', true)],
        0,
        {
            scopeIdentity: 'scope-project-b',
            navigationIdentity: 'navigation-project-b',
        }
    )}<div class="open-other-windows-group" data-other-windows-status="ready">
        ${currentOpenWorkspaceProjectMarkup()}
    </div>`;
    await postHostMessage(page, otherWorkspace);

    const focusedRow = row(page, 'codex', 'session-a');
    assert.equal(await focusedRow.getAttribute('data-session-focused'), '');
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.match(
        await focusedRow.evaluate(element => getComputedStyle(element).boxShadow),
        /rgba?\(0, 127, 212/
    );
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'mismatched-ai-session-presentation-workspace',
    }]);

    await postHostMessage(page, presentationMessage(initial, 3, { revealFocused: true }));
    assert.equal(await focusedRow.getAttribute('data-session-focused'), '',
        'the rejected no-op replacement must not commit its projection revision');
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects legacy AI update messages', async t => {
    const initial = [session('codex', 'session-a', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 2,
        projectionRevision: 2,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'legacy-session', true),
        ])}</div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
    });

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'legacy-session').count(), 0);
    assert.deepEqual(
        (await postedMessages(page))
            .filter(message => message.type === 'request-full-refresh')
            .map(message => message.reason),
        ['unsupported-ai-session-message'],
    );
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects legacy OPEN update messages', async t => {
    const initial = [session('codex', 'session-a', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 2,
        projectionRevision: 2,
        semanticRevision: 'legacy-open-update',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'legacy-session', true),
        ])}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
    });

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'legacy-session').count(), 0);
    assert.deepEqual(
        (await postedMessages(page))
            .filter(message => message.type === 'request-full-refresh')
            .map(message => message.reason),
        ['unsupported-open-workspaces-message'],
    );
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 ignores standalone workspace replacement messages', async t => {
    const initial = [session('codex', 'session-a', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, {
        type: 'workspace-updated',
        version: 2,
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            session('codex', 'legacy-session', true),
        ])}</div>`,
    });

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'legacy-session').count(), 0);
    assert.deepEqual(await postedMessages(page), []);
});

test('ACTIVE-SESSION-FOCUS-REVEAL-001 rejects non-focus standalone presentation messages', async t => {
    const initial = [session('codex', 'session-a', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, presentationMessage([
        session('codex', 'session-a', false),
    ], 2, { revealFocused: false }));

    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.deepEqual(
        (await postedMessages(page))
            .filter(message => message.type === 'request-full-refresh')
            .map(message => message.reason),
        ['invalid-direct-ai-session-presentation-state'],
    );
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 applies AI HTML and complete attention owners from one message', async t => {
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
        version: 3,
        sequence: 2,
        projectionRevision: 2,
        generatedAt: '2026-08-10T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
        ])}</div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([attentionSession], 2, {
            attention: { 'codex:session-a': ['event-a', 'event-b'] },
        }),
    });

    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'),
        ''
    );
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['event-a', 'event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 applies OPEN HTML and complete attention owners from one message', async t => {
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
        version: 3,
        projectionRevision: 2,
        semanticRevision: 'open-envelope-revision',
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
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([attentionSession], 2, {
            attention: {
                'codex:session-a': ['open-event-a', 'open-event-b'],
            },
        }),
    });

    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'),
        ''
    );
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['open-event-a', 'open-event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 closes an AI envelope revision against conflicting direct presentation', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'event-a',
    };
    const otherSession = session('codex', 'session-b', false);
    const page = await openCardPage(t, [session('codex', 'session-a', true)]);
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: 2,
        projectionRevision: 2,
        generatedAt: '2026-08-11T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
            otherSession,
        ])}</div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([attentionSession, otherSession], 2, {
            attention: { 'codex:session-a': ['event-a', 'event-b'] },
        }),
    });
    await postHostMessage(page, presentationMessage([
        { ...attentionSession, focused: false },
        { ...otherSession, focused: true },
    ], 2, { revealFocused: true }));

    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), null);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'), '');
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['event-a', 'event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 closes an OPEN envelope revision against conflicting direct presentation', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'open-event-a',
    };
    const otherSession = session('codex', 'session-b', false);
    const page = await openCardPage(t, [session('codex', 'session-a', true)]);
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 3,
        projectionRevision: 2,
        semanticRevision: 'closed-open-envelope-revision',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
            otherSession,
        ])}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([attentionSession, otherSession], 2, {
            attention: {
                'codex:session-a': ['open-event-a', 'open-event-b'],
            },
        }),
    });
    await postHostMessage(page, presentationMessage([
        { ...attentionSession, focused: false },
        { ...otherSession, focused: true },
    ], 2, { revealFocused: true }));

    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), null);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'), '');
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['open-event-a', 'open-event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 applies and closes AI envelope after matching direct presentation', async t => {
    const initialSessions = [
        session('codex', 'session-a', true),
        session('codex', 'session-b', false),
    ];
    const attentionSession = {
        ...initialSessions[0],
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'event-a',
    };
    const otherSession = initialSessions[1];
    const addedSession = session('codex', 'session-c', false);
    const conflictingPresentation = presentationMessage([
        { ...attentionSession, focused: false },
        { ...otherSession, focused: true },
    ], 2, { revealFocused: true });
    const page = await openCardPage(t, initialSessions);

    await postHostMessage(page, conflictingPresentation);
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), '');
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: 2,
        projectionRevision: 2,
        generatedAt: '2026-08-11T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
            otherSession,
            addedSession,
        ])}</div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([
            attentionSession,
            otherSession,
            addedSession,
        ], 2, {
            attention: { 'codex:session-a': ['event-a', 'event-b'] },
        }),
    });

    assert.equal(await row(page, 'codex', 'session-c').count(), 1);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), null);
    await postHostMessage(page, conflictingPresentation);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'), '');
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['event-a', 'event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 applies and closes OPEN envelope after matching direct presentation', async t => {
    const initialSessions = [
        session('codex', 'session-a', true),
        session('codex', 'session-b', false),
    ];
    const attentionSession = {
        ...initialSessions[0],
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: 'open-event-a',
    };
    const otherSession = initialSessions[1];
    const addedSession = session('codex', 'session-c', false);
    const conflictingPresentation = presentationMessage([
        { ...attentionSession, focused: false },
        { ...otherSession, focused: true },
    ], 2, { revealFocused: true });
    const page = await openCardPage(t, initialSessions);

    await postHostMessage(page, conflictingPresentation);
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), '');
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 3,
        projectionRevision: 2,
        semanticRevision: 'direct-first-open-envelope-revision',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup([
            attentionSession,
            otherSession,
            addedSession,
        ])}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage([
            attentionSession,
            otherSession,
            addedSession,
        ], 2, {
            attention: {
                'codex:session-a': ['open-event-a', 'open-event-b'],
            },
        }),
    });

    assert.equal(await row(page, 'codex', 'session-c').count(), 1);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    assert.equal(await row(page, 'codex', 'session-b').getAttribute('data-session-focused'), null);
    await postHostMessage(page, conflictingPresentation);
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-ai-session-attention'), '');
    assert.equal(await row(page, 'codex', 'session-a').getAttribute('data-session-focused'), '');
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['open-event-a', 'open-event-b'],
    ]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects an invalid presentation before replacing HTML', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);
    await postHostMessage(page, {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: 2,
        projectionRevision: 2,
        generatedAt: '2026-08-10T00:00:00.000Z',
        currentWorkspaceCount: 1,
        html: `<div class="open-current-workspace-group">${projectMarkup(
            replacement
        )}</div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage(replacement, 3),
    });

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'invalid-ai-session-presentation-envelope',
    }]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects an invalid OPEN presentation before replacing HTML', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);
    await postHostMessage(page, {
        type: 'open-workspaces-updated',
        version: 3,
        projectionRevision: 2,
        semanticRevision: 'invalid-open-envelope',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 0,
        otherWindowsStatus: 'ready',
        html: `<div class="open-current-workspace-group">${projectMarkup(
            replacement
        )}</div>
            <div class="open-other-windows-group" data-other-windows-status="ready">
                ${currentOpenWorkspaceProjectMarkup()}
            </div>`,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'project-a' }],
            savedProjects: [],
            todos: [],
        },
        presentation: presentationMessage(replacement, 3),
    });

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'invalid-open-workspaces-presentation-envelope',
    }]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rolls back an invalid OPEN replacement without committing its revision', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);
    const invalidReplacement = openWorkspacesEnvelope(replacement, 2, {
        semanticRevision: 'invalid-open-replacement',
    });
    invalidReplacement.html = '<div data-invalid-open-replacement></div>';

    await postHostMessage(page, invalidReplacement);

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'invalid-open-workspaces-update',
    }]);

    await page.evaluate(() => { window.__postedMessages.length = 0; });
    await postHostMessage(page, openWorkspacesEnvelope(replacement, 2, {
        semanticRevision: 'valid-open-replacement',
    }));
    assert.equal(await row(page, 'codex', 'session-a').count(), 0);
    assert.equal(await row(page, 'codex', 'session-b').count(), 1);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects focus reveal inside an AI envelope', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, aiSessionsEnvelope(replacement, 2, {
        presentationOverrides: { revealFocused: true },
    }));

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'invalid-ai-session-presentation-envelope',
    }]);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 rejects focus reveal inside an OPEN envelope', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const page = await openCardPage(t, initial);

    await postHostMessage(page, openWorkspacesEnvelope(replacement, 2, {
        presentationOverrides: { revealFocused: true },
    }));

    assert.equal(await row(page, 'codex', 'session-a').count(), 1);
    assert.equal(await row(page, 'codex', 'session-b').count(), 0);
    assert.deepEqual(await postedMessages(page), [{
        type: 'request-full-refresh',
        reason: 'invalid-open-workspaces-presentation-envelope',
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

    await postHostMessage(page, aiSessionsEnvelope([{
            ...attentionSession,
            attentionEventId: 'stale-event',
        }], 4, { attention: { 'codex:session-a': ['stale-event'] } }));

    assert.equal(
        await row(page, 'codex', 'session-a').getAttribute('data-session-event-id'),
        'event-a'
    );
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    const acknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(acknowledgements.map(message => message.eventIds), [
        ['event-a', 'event-b'],
    ]);
});

test('ACTIVE-SESSION-FULL-RENDER-TRANSACTION-001 rejects an invalid initial presentation without committing its revision', async t => {
    const initial = [session('codex', 'session-a', true)];
    const replacement = [session('codex', 'session-b', true)];
    const invalidInitialPresentation = {
        ...presentationMessage(initial, 1),
        version: 2,
    };
    const page = await openCardPage(
        t,
        initial,
        { width: 360, height: 900 },
        undefined,
        invalidInitialPresentation,
        true
    );

    assert.deepEqual((await postedMessages(page)).filter(message =>
        message.type === 'request-full-refresh'
    ), [{
        type: 'request-full-refresh',
        reason: 'invalid-initial-ai-session-presentation-state',
    }]);

    await page.evaluate(() => { window.__postedMessages.length = 0; });
    await postHostMessage(page, aiSessionsEnvelope(replacement, 1));
    assert.equal(await row(page, 'codex', 'session-a').count(), 0);
    assert.equal(await row(page, 'codex', 'session-b').count(), 1);
});

test('ATTENTION-SESSION-CARD-ACKNOWLEDGEMENT-001 keeps acknowledgement pending until its committed v3 presentation is applied', async t => {
    const eventIds = ['event-a', 'event-b'];
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped',
        status: 'stopped',
        needsAttention: true,
        attentionEventId: eventIds[0],
    };
    const page = await openCardPage(
        t,
        [attentionSession],
        undefined,
        undefined,
        presentationMessage([attentionSession], 5, {
            attention: { 'codex:session-a': eventIds },
        })
    );
    const primaryAction = row(page, 'codex', 'session-a')
        .locator('.ai-session-primary-action');

    await primaryAction.click();
    await primaryAction.click();
    const posted = await postedMessages(page);
    const acknowledgements = posted.filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.equal(acknowledgements.length, 1,
        'rapid activation must share the pending acknowledgement request');
    const request = acknowledgements[0];
    assert.deepEqual(request, {
        type: 'acknowledge-ai-session-attention',
        version: 1,
        requestId: request.requestId,
        provider: 'codex',
        sessionId: 'session-a',
        workspaceScopeIdentity: 'scope-project-a',
        projectionRevision: 5,
        eventIds,
    });
    assert.ok(Number.isSafeInteger(request.requestId) && request.requestId > 0,
        'the acknowledgement requestId must be a safe positive integer');
    assert.equal(posted.filter(message =>
        message.type === 'open-active-ai-session-conversation'
    ).length, 2, 'pending acknowledgement must not suppress the independent open action');

    const result = overrides => ({
        type: 'ai-session-attention-acknowledgement-result',
        version: 1,
        requestId: request.requestId,
        provider: request.provider,
        sessionId: request.sessionId,
        workspaceScopeIdentity: request.workspaceScopeIdentity,
        projectionRevision: request.projectionRevision,
        outcome: 'committed',
        ...overrides,
    });
    const retry = async () => {
        await page.evaluate(() => {
            window.__agentPivotAcknowledgeSession('codex', 'session-a');
        });
        return (await postedMessages(page)).filter(message =>
            message.type === 'acknowledge-ai-session-attention'
        ).length;
    };
    await postHostMessage(page, result({ projectionRevision: 4 }));
    assert.equal(await retry(), 1, 'an old settlement cannot release pending');
    await postHostMessage(page, result({ sessionId: 'session-b' }));
    assert.equal(await retry(), 1, 'an unrelated settlement cannot release pending');
    await postHostMessage(page, result({}));
    assert.equal(await retry(), 1,
        'a matching committed settlement alone cannot release pending');

    const postV3 = async (projectionRevision, renderedSession, attention) => {
        await postHostMessage(page, {
            type: 'ai-sessions-updated',
            version: 3,
            sequence: projectionRevision,
            projectionRevision,
            generatedAt: '2026-08-11T00:00:00.000Z',
            currentWorkspaceCount: 1,
            html: `<div class="open-current-workspace-group">${projectMarkup([
                renderedSession,
            ])}</div>`,
            searchCatalog: {
                version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [],
            },
            presentation: presentationMessage([renderedSession], projectionRevision, {
                attention: { 'codex:session-a': attention },
            }),
        });
    };
    await postV3(6, attentionSession, eventIds);
    assert.equal(await retry(), 1,
        'a newer presentation retaining an observed event cannot release pending');

    const clearedSession = { ...attentionSession, needsAttention: false };
    delete clearedSession.attentionEventId;
    await postV3(7, clearedSession, []);
    const nextEventIds = ['event-c'];
    await postV3(8, {
        ...attentionSession,
        attentionEventId: nextEventIds[0],
    }, nextEventIds);
    await row(page, 'codex', 'session-a').locator('.ai-session-primary-action').click();
    let finalAcknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.equal(finalAcknowledgements.length, 2,
        'matching committed outcome plus applied cleared v3 presentation releases pending');
    assert.deepEqual(finalAcknowledgements[1].eventIds, nextEventIds);
    assert.equal(finalAcknowledgements[1].projectionRevision, 8);

    await postV3(9, clearedSession, []);
    assert.equal(await retry(), 2,
        'a cleared v3 presentation alone cannot release pending before its result');
    await postHostMessage(page, result({
        requestId: finalAcknowledgements[1].requestId,
        projectionRevision: finalAcknowledgements[1].projectionRevision,
    }));
    await postHostMessage(page, result({
        requestId: finalAcknowledgements[1].requestId,
        projectionRevision: finalAcknowledgements[1].projectionRevision,
    }));
    const degradedEventIds = ['event-d'];
    await postV3(10, {
        ...attentionSession, attentionEventId: degradedEventIds[0],
    }, degradedEventIds);
    await retry();
    finalAcknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    const degradedRequest = finalAcknowledgements.at(-1);
    await postHostMessage(page, result({
        requestId: degradedRequest.requestId,
        projectionRevision: degradedRequest.projectionRevision,
        outcome: 'degraded-local',
    }));
    assert.equal(await row(page, 'codex', 'session-a')
        .getAttribute('data-attention-acknowledgement-pending'), null);
    assert.match(await page.locator('[data-ai-session-live-region]').textContent(),
        /cross-window sync could not be confirmed/i);

    const rejectedEventIds = ['event-e'];
    await postV3(11, {
        ...attentionSession, attentionEventId: rejectedEventIds[0],
    }, rejectedEventIds);
    await retry();
    finalAcknowledgements = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    const rejectedRequest = finalAcknowledgements.at(-1);
    await postHostMessage(page, result({
        requestId: rejectedRequest.requestId,
        projectionRevision: rejectedRequest.projectionRevision,
        outcome: 'rejected',
    }));
    assert.match(await page.locator('[data-ai-session-live-region]').textContent(),
        /could not clear session attention/i);

    const timeoutEventIds = ['event-f'];
    await postV3(12, {
        ...attentionSession, attentionEventId: timeoutEventIds[0],
    }, timeoutEventIds);
    await page.evaluate(() => {
        window.__agentPivotAttentionAcknowledgementTimeoutMs = 10;
        window.__agentPivotAcknowledgeSession('codex', 'session-a');
    });
    await waitForPageCondition(page, () => window.__postedMessages.some(message =>
        message.type === 'request-full-refresh'
            && message.reason === 'ai-session-attention-acknowledgement-timeout'
    ));
    assert.equal(await row(page, 'codex', 'session-a')
        .getAttribute('data-attention-acknowledgement-pending'), null);
    assert.match(await page.locator('[data-ai-session-live-region]').textContent(),
        /timed out/i);
});

test('ATTENTION-SESSION-CARD-ACKNOWLEDGEMENT-001 scopes pending acknowledgement to one workspace presentation', async t => {
    const attentionSession = {
        ...session('codex', 'session-a', true),
        executionState: 'stopped', status: 'stopped', needsAttention: true,
        attentionEventId: 'event-a',
    };
    const initial = presentationMessage([attentionSession], 5, {
        attention: { 'codex:session-a': ['event-a'] },
    });
    const page = await openCardPage(t, [attentionSession], undefined, undefined, initial);
    await page.evaluate(() => {
        window.__attentionAcknowledgementTimers = [];
        window.setTimeout = callback => {
            var handle = { callback: callback, cleared: false };
            window.__attentionAcknowledgementTimers.push(handle);
            return handle;
        };
        window.clearTimeout = handle => { handle.cleared = true; };
        window.__agentPivotAttentionAcknowledgementTimeoutMs = 10;
        window.__agentPivotAcknowledgeSession('codex', 'session-a');
    });
    const firstRequest = (await postedMessages(page)).find(message =>
        message.type === 'acknowledge-ai-session-attention'
    );

    const workspaceBEnvelope = aiSessionsEnvelope([attentionSession], 6, {
            attention: { 'codex:session-a': ['event-a'] },
            presentationOverrides: {
                workspaceScopeIdentity: 'scope-project-b',
                workspaceNavigationIdentity: 'navigation-project-b',
            },
        });
    workspaceBEnvelope.html = currentWorkspaceGroupMarkup([attentionSession], 1, {
        scopeIdentity: 'scope-project-b',
        navigationIdentity: 'navigation-project-b',
    });
    await postHostMessage(page, workspaceBEnvelope);
    await page.evaluate(() => {
        window.__agentPivotAttentionAcknowledgementTimeoutMs = 1_000;
        window.__agentPivotAcknowledgeSession('codex', 'session-a');
        var oldTimer = window.__attentionAcknowledgementTimers[0];
        if (!oldTimer.cleared) throw new Error('the old workspace timer was not cancelled');
        oldTimer.callback();
    });
    const requests = (await postedMessages(page)).filter(message =>
        message.type === 'acknowledge-ai-session-attention'
    );
    assert.deepEqual(requests.map(message => message.workspaceScopeIdentity), [
        'scope-project-a', 'scope-project-b',
    ], 'an old workspace pending entry cannot suppress the same session identity in a new scope');
    assert.equal((await postedMessages(page)).filter(message =>
        message.type === 'request-full-refresh'
            && message.reason === 'ai-session-attention-acknowledgement-timeout'
    ).length, 0, 'the old workspace timeout must be cancelled silently');
    assert.equal(await page.locator('[data-ai-session-live-region]').textContent(), '');
    assert.equal(await row(page, 'codex', 'session-a')
        .getAttribute('data-attention-acknowledgement-pending'), '');
    await postHostMessage(page, {
        type: 'ai-session-attention-acknowledgement-result',
        version: 1,
        requestId: firstRequest.requestId,
        provider: firstRequest.provider,
        sessionId: firstRequest.sessionId,
        workspaceScopeIdentity: firstRequest.workspaceScopeIdentity,
        projectionRevision: firstRequest.projectionRevision,
        outcome: 'degraded-local',
    });
    assert.equal(await page.locator('[data-ai-session-live-region]').textContent(), '',
        'a late result from the old workspace must not announce in the new workspace');
    assert.equal(await row(page, 'codex', 'session-a')
        .getAttribute('data-attention-acknowledgement-pending'), '',
    'a late old-workspace result must not clear the new workspace request');
});

test('ATTENTION-SESSION-CARD-ACKNOWLEDGEMENT-001 clears a stopped Kimi card through the production v3 refresh', async t => {
    const sessionId = 'fixture-kimi-session-a';
    const sessionKey = `kimi:${sessionId}`;
    const eventIds = ['kimi-completed-event-a', 'kimi-completed-event-b'];
    const rootPath = '/fixtures/attention-card';
    const projectId = getAttentionProjectKey(rootPath);
    const workspace = {
        navigationIdentity: 'navigation:fixture-attention-card',
        scopeIdentity: 'scope:fixture-attention-card',
        kind: 'singleFolder',
        displayName: 'Fixture Attention Card',
        navigationUri: `file://${rootPath}`,
        environment: 'local',
        roots: [{
            id: 'root:fixture-attention-card',
            name: 'attention-card',
            uri: `file://${rootPath}`,
            hostPath: rootPath,
            ordinal: 0,
        }],
    };
    const runtime = {
        identity: {
            provider: 'kimi',
            sessionId,
            workspaceScopeIdentity: workspace.scopeIdentity,
            workspaceNavigationIdentity: workspace.navigationIdentity,
            workspaceRootHostPaths: [rootPath],
            cwd: rootPath,
        },
        backend: 'tmux',
        state: 'active',
        markerPath: '/fixtures/attention-card.done',
        runStartedAtMs: 900,
        attached: false,
        tmux: { layout: 'project', sessionName: 'fixture', windowName: 'fixture' },
    };
    const attentionController = new AiSessionAttentionController({
        isEnabled: () => true,
        getWorkspaceTarget: () => null,
        getProviders: () => [],
        getRuntimeById: () => runtime,
        publish: async () => true,
        scheduleRefresh() {},
        nowMs: () => 1_000,
    });
    attentionController.setRemoteAggregate(attentionAggregate(
        'initial-fixture-aggregate', projectId, sessionKey, eventIds
    ));
    const projectionCoordinator = new AiSessionProjectionCoordinator({
        getActiveRuntimes: () => [runtime],
        getPendingRuntimes: () => [],
        getExecutionSnapshot: () => ({
            [sessionKey]: { state: 'stopped', stateChangedAt: 1_000 },
        }),
        getFocusedIdentity: () => runtime.identity,
        getAttentionAggregate: () => attentionController.getEffectiveAggregate(),
    });
    let lastProjectedCards = [];
    const getCards = projection => {
        const aiSessions = hydrateWorkspaceAiSessions({
            workspace,
            providers: [{ id: 'kimi', label: 'Kimi' }],
            sessionResults: {
                kimi: {
                    available: true,
                    sessions: [{ id: sessionId, name: 'Fixture Kimi Session', cwd: rootPath }],
                },
            },
            getSessionComparableCwd: (_provider, item) => item.cwd,
            pinnedSessions: new Set(),
            aliases: {},
            activeRuntimes: projection.activeRuntimes,
            pendingRuntimes: projection.pendingRuntimes,
            executionSnapshot: projection.executionSnapshot,
            focusedIdentity: projection.focusedIdentity,
            attentionAggregate: projection.attentionAggregate,
            activePresentation: projection.presentation,
            activeProvider: 'kimi',
            providerSelection: { primaryProvider: 'kimi', selectedProviders: ['kimi'] },
            expanded: true,
        });
        lastProjectedCards = [{
            id: 'fixture-project',
            kind: 'current',
            workspaceKind: workspace.kind,
            showSaveAction: false,
            pinned: false,
            runningSessionCount: aiSessions.activeSessions.filter(
                item => item.executionState === 'running'
            ).length,
            navigationIdentity: workspace.navigationIdentity,
            scopeIdentity: workspace.scopeIdentity,
            name: workspace.displayName,
            environment: workspace.environment,
            environmentLabel: 'Local',
            color: '',
            roots: workspace.roots.map(({ id, name, ordinal }) => ({ id, name, ordinal })),
            aiSessions,
            attentionCount: aiSessions.attentionCount,
        }];
        return lastProjectedCards;
    };
    let page = null;
    const deliveredEnvelopes = [];
    const deliveryPromises = [];
    let resolveSecondDelivery;
    const secondDelivery = new Promise(resolve => { resolveSecondDelivery = resolve; });
    const dashboardController = new AiSessionDashboardController({
        providerIds: ['kimi'],
        isVisible: () => true,
        invalidateCache() {},
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCards,
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: () => projectionCoordinator.captureNext(workspace),
        postMessage: message => {
            assert.equal(message.type, 'ai-sessions-updated');
            assert.equal(message.version, 3);
            assert.equal(message.projectionRevision, message.presentation.projectionRevision);
            deliveredEnvelopes.push(message);
            const delivery = postHostMessage(page, message).then(() => true);
            deliveryPromises.push(delivery);
            if (deliveredEnvelopes.length === 2) resolveSecondDelivery();
            return delivery;
        },
        refresh() {},
        logError: (_message, error) => { throw error; },
        debounceMs: 0,
        watcherRefreshMinIntervalMs: 0,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: handle => clearTimeout(handle),
    });
    const initialEnvelope = dashboardController.getUpdatedMessage('initial-fixture');
    const initialOpenEnvelope = buildOpenWorkspacesUpdatedMessage({
        groups: [],
        cards: lastProjectedCards,
        collapsed: false,
        semanticRevision: 'initial-fixture-open-workspaces',
        projectionRevision: initialEnvelope.projectionRevision,
        otherWindowsStatus: 'ready',
        todoSearchItems: [],
        presentation: initialEnvelope.presentation,
    });
    const bridgeAcknowledgements = [];
    let bridgeAggregateListener = () => undefined;
    const fakeBridge = {
        acknowledge: async ids => {
            bridgeAcknowledgements.push(ids.slice());
            bridgeAggregateListener(attentionAggregate(
                'stale-fixture-replay', projectId, sessionKey, eventIds
            ));
            return 'committed';
        },
        publish: async () => true,
        dispose() {},
    };
    const attentionCapability = createAiSessionAttentionEventCapability({
        tmuxRuntimeDiscovery: {
            loadPersistedInactive: async () => undefined,
            getActive: () => [], getPending: () => [], getInactive: () => [],
            getDiagnostics: () => [],
        },
        tmuxRuntimeBackend: {
            getConflicts: () => [], getFocusedRuntime: () => null,
            isAttachTerminalCandidate: () => false,
            restoreAttachTerminals: async () => undefined,
        },
        tmuxRuntimeStore: {
            listKnown: async () => [], listPending: async () => [], listInactive: async () => [],
        },
        aiSessionTerminalService: {
            getTrackedTerminalEntries: () => [], isComplete: () => false,
        },
        getRuntimeConfiguration: () => ({ mode: 'vscode' }),
        getCurrentOpenWorkspace: () => workspace,
        getActiveTerminal: () => null,
        isVisible: () => true,
        assertActive() {},
        createBridgeClient: onAggregate => {
            bridgeAggregateListener = onAggregate;
            return fakeBridge;
        },
        onDidOpenTerminal: () => ({ dispose() {} }),
        onDidChangeActiveTerminal: () => ({ dispose() {} }),
        onDidCloseTerminal: () => ({ dispose() {} }),
        logError: (_message, error) => { throw error; },
        logAiSessionRuntimeFailure: (_operation, error) => { throw error; },
        getRuntimeCoordinator: () => ({ getActive: () => [], getPending: () => [] }),
        getAttentionController: () => attentionController,
        runSafeLifecycleTask: async (_operation, task) => { await task(); },
        evaluateLifecycleTick() {},
        refreshViewsNow: reason => { void dashboardController.refreshNow(reason); },
        scheduleRefresh: reason => dashboardController.scheduleRefresh(reason),
        postOpenWorkspacesUpdated() {},
        getActiveTerminalHighlighter: () => ({
            sync() {}, handleTerminalClosed() {}, getIdentity: () => null,
        }),
        getTmuxFocusedRuntimeMonitor: () => ({ request: async () => undefined }),
        publishRestoredAttachTerminal() {},
    });
    attentionCapability.startBridgeClient();
    const initialMarkup = initialOpenEnvelope.html;
    page = await openCardPage(
        t,
        [],
        { width: 360, height: 900 },
        initialMarkup,
        initialEnvelope.presentation
    );
    t.after(() => {
        attentionCapability.dispose();
        dashboardController.dispose();
    });
    const project = page.locator('.workspace-card[data-current-workspace]');
    const compact = page.locator('.workspace-card[data-open-workspace-current]');
    assert.equal(await project.locator('.ai-session-attention-count').textContent(), '1');
    assert.equal(
        await project.locator('.ai-session-attention-count').getAttribute('aria-label'),
        '1 AI session needs attention'
    );
    assert.equal(
        await project.locator('[data-ai-session-tab="active"] .ai-session-tab-attention')
            .getAttribute('aria-label'),
        '1 active AI session needs attention'
    );
    assert.equal(await compact.locator('.project-ai-attention-badge').textContent(), '1');
    assert.equal(
        await compact.locator('.project-ai-attention-badge').getAttribute('aria-label'),
        '1 item needs attention'
    );
    const acknowledgementResults = [];
    const hostHandler = createAttentionAcknowledgementHandler(
        (ids, target) => attentionCapability.acknowledgeEventIds(ids, target),
        message => {
            acknowledgementResults.push(message);
            return postHostMessage(page, message);
        }
    );
    const exposedName = '__hostAttentionMessage_fixture';
    await page.exposeFunction(exposedName, message => {
        if (message?.type === 'acknowledge-ai-session-attention') {
            return hostHandler(message);
        }
    });
    await page.evaluate(name => {
        const originalPostMessage = window.vscode.postMessage;
        window.__hostAttentionSettlements = [];
        window.vscode.postMessage = message => {
            originalPostMessage(message);
            var settlement = Promise.resolve(window[name](message));
            if (message.type === 'acknowledge-ai-session-attention') {
                window.__hostAttentionSettlements.push(settlement);
            }
            return settlement;
        };
    }, exposedName);

    await row(page, 'kimi', sessionId).locator('.ai-session-primary-action').click();
    await page.evaluate(() => Promise.all(window.__hostAttentionSettlements));
    let deliveryTimeout;
    try {
        await Promise.race([
            secondDelivery,
            new Promise((_, reject) => {
                deliveryTimeout = setTimeout(
                    () => reject(new Error('timed out waiting for the final v3 attention envelope')),
                    BROWSER_CONDITION_TIMEOUT_MS
                );
            }),
        ]);
    } finally {
        clearTimeout(deliveryTimeout);
    }
    await Promise.all(deliveryPromises);

    assert.deepEqual(acknowledgementResults.map(message => message.outcome), ['committed'],
        'the Host must settle the authoritative acknowledgement as committed');
    assert.deepEqual(bridgeAcknowledgements, [eventIds],
        'the Host acknowledges the complete presentation owner, not only the row fallback');
    assert.deepEqual(attentionController.getEffectiveAggregate().sessions, [],
        'a stale bridge aggregate must not resurrect acknowledged owner events');
    assert.ok(deliveredEnvelopes.length >= 2);
    assert.ok(deliveredEnvelopes.every(message =>
        message.version === 3 && message.presentation.attentionSessions.length === 0
    ));
    const finalEnvelope = deliveredEnvelopes[deliveredEnvelopes.length - 1];
    assert.equal(finalEnvelope.presentation.attentionSessions.length, 0);
    await waitForPageCondition(page, ({ provider, id }) => {
        var currentRow = document.querySelector(
            '.active-ai-session-row[data-session-provider="' + provider
                + '"][data-session-id="' + CSS.escape(id) + '"]'
        );
        return currentRow
            && !currentRow.hasAttribute('data-ai-session-attention')
            && !currentRow.hasAttribute('data-attention-acknowledgement-pending');
    }, { provider: 'kimi', id: sessionId });
    await assertAttentionCleared(page, 'kimi', sessionId);
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
        {
            focusedTarget: { provider: 'codex', pendingId: 'pending-one' },
            revealFocused: true,
        }
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
        {
            focusedTarget: { provider: 'codex', sessionId: 'established-one' },
            revealFocused: true,
        }
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

    await postHostMessage(page, aiSessionsEnvelope([running], 2));

    const currentRow = row(page, 'codex', 'current-session');
    assert.equal(await currentRow.getAttribute('data-execution-state'), 'running');
    assert.notEqual(await currentRow.getAttribute('data-session-icon-fx'), null);
    assert.equal(await currentRow.getAttribute('data-session-needs-attention'), null);
    assert.equal(await currentRow.getAttribute('data-ai-session-attention'), null);
    assert.equal(await currentRow.getAttribute('data-session-event-id'), null);
    assert.equal(await currentRow.locator('.ai-session-attention-indicator').count(), 0);

    const stopped = { ...running, executionState: 'stopped' };
    await postHostMessage(page, aiSessionsEnvelope([stopped], 3, {
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
            document.querySelector('.sticky-groups-wrapper'),
            { attributes: true, childList: true, subtree: true }
        );
    });

    await postHostMessage(page, aiSessionsEnvelope([stoppedSession], 2, {
        attention: { 'codex:current-session': ['attention-event'] },
    }));
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
    await postHostMessage(page, aiSessionsEnvelope([
        { ...stoppedSession, executionState: 'running' },
    ], 3));
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

    await postHostMessage(page, aiSessionsEnvelope([], 2, {
        attention: { 'codex:history-only': ['history-attention'] },
    }));
    assert.equal(
        await card.locator('.ai-session-attention-count').textContent(),
        '1'
    );
    assert.equal(await card.getAttribute('data-has-ai-session-badge'), '');

    await postHostMessage(page, aiSessionsEnvelope([], 3));
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
    await postHostMessage(page, aiSessionsEnvelope(active, 2, {
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
    await postHostMessage(page, openWorkspacesEnvelope(authoritativeAttention, 4, {
        semanticRevision: 'stale-window-switch-attention',
        attention: { 'codex:session-c': ['event-c'] },
    }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await postHostMessage(page, presentationMessage(active, 3, {
        attention: { 'codex:session-b': ['stale-event-b'] },
        revealFocused: true,
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
        ...aiSessionsEnvelope(active, 2, {
            presentationOverrides: {
                workspaceScopeIdentity: 'scope:five-roots',
                workspaceNavigationIdentity: 'navigation:reddb-dev',
            },
        }),
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
