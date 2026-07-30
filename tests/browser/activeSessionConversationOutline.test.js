'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');
const {
    buildConversationOutline,
} = require('../../out/aiSessions/conversation/model');

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

test('ACTIVE-SESSION-CONVERSATION-LAYOUT-001 bounds every browser condition wait', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    assert.equal((source.match(/\.waitForFunction\(/g) || []).length, 1);
    assert.match(source, /const BROWSER_CONDITION_TIMEOUT_MS = 5_000;/);
    assert.match(
        source,
        /return page\.waitForFunction\(condition, undefined, \{\s*timeout: BROWSER_CONDITION_TIMEOUT_MS,\s*\}\);/
    );
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

function sessionSurfaceMarkup(activeAiSessions, markerCount = 0) {
    let sessionsMarkup = getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex', 'kimi'],
        activeAiSessionTab: 'active',
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions,
    });
    if (markerCount) {
        const markers = Array.from({ length: markerCount }, (_, index) =>
            `<button type="button" data-ai-session-conversation-marker
                data-interaction-id="interaction-${index}"
                style="display:block;width:100%;min-height:24px">Input ${index + 1}</button>`
        ).join('');
        sessionsMarkup = sessionsMarkup.replace(
            /(<div class="ai-session-conversation-rail"[^>]*) hidden><\/div>/,
            `$1>${markers}</div>`
        );
    }
    return sessionsMarkup;
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

function listProjectMarkup(activeAiSessions, historySessions, selectedTab = 'active') {
    return `<div class="project workspace-card" data-id="project-a" data-current-workspace
        data-codex-expanded
        data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a"
        style="--steward-ai-session-list-max-height: 130px">
        ${listSessionSurfaceMarkup(activeAiSessions, historySessions, selectedTab)}
    </div>`;
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

async function relativeTop(locator, scroller) {
    return locator.evaluate((node, selector) => {
        const container = node.closest(selector);
        return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    }, '.codex-sessions-list');
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

function projectMarkup(activeAiSessions, markerCount = 0) {
    return `<div class="project workspace-card" data-id="project-a" data-current-workspace
        data-codex-expanded
        data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a"
        style="--steward-ai-session-list-max-height: 130px">
        ${sessionSurfaceMarkup(activeAiSessions, markerCount)}
    </div>`;
}

function navigationProjectMarkup() {
    return `<div class="project workspace-card" data-id="project-other"
        data-open-workspace-list-card data-workspace-navigation data-other-workspace
        data-workspace-navigation-identity="navigation-other"></div>`;
}

function currentOpenWorkspaceProjectMarkup() {
    return `<div class="project workspace-card" data-id="project-a"
        data-open-workspace-list-card data-open-workspace-current
        data-workspace-navigation-identity="navigation-project-a"></div>`;
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

async function openConversationPage(t, activeAiSessions, viewport = { width: 360, height: 900 }) {
    const page = await browser.newPage({ viewport });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(documentMarkup(activeAiSessions));
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.__setStateCalls = [];
        window.__conversationObserverDisconnects = 0;
        const NativeResizeObserver = window.ResizeObserver;
        window.ResizeObserver = class {
            constructor(callback) {
                this.observer = new NativeResizeObserver(callback);
            }
            observe(target) {
                this.observer.observe(target);
            }
            disconnect() {
                window.__conversationObserverDisconnects += 1;
                this.observer.disconnect();
            }
        };
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState: state => window.__setStateCalls.push(state),
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
        window.__setStateCalls.length = 0;
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

function summary(id, userGraphemeCount, userPreview, overrides = {}) {
    return {
        id,
        timestamp: 1_767_225_600_000,
        userPreview,
        userGraphemeCount,
        responseState: 'complete',
        ...overrides,
    };
}

function summaries(count, prefix = 'interaction') {
    return Array.from({ length: count }, (_, index) =>
        summary(`${prefix}-${index}`, index + 1, `Input ${index + 1}`)
    );
}

function modelInteractions(count) {
    return Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        return {
            id: `model-${number}`,
            providerTurnId: `turn-${number}`,
            timestamp: 1_767_225_600_000 + number,
            userMarkdown: `Model input ${number}`,
            userPreview: `Model input ${number}`,
            userGraphemeCount: 12,
            assistantMarkdown: [`Model response ${number}`],
            responseState: number === count ? 'inProgress' : 'complete',
        };
    });
}

function outlineResult({
    requestId = 1,
    subscriptionGeneration = 1,
    projectId = 'project-a',
    provider = 'codex',
    sessionId = 'session-a',
    sourceRevision = 'r1',
    interactions = [],
    totalInteractions = interactions.length,
    partial = false,
} = {}) {
    return {
        type: 'ai-session-conversation-outline-result',
        version: 1,
        requestId,
        subscriptionGeneration,
        projectId,
        provider,
        sessionId,
        payload: {
            provider,
            sessionId,
            sourceRevision,
            totalInteractions,
            partial,
            interactions,
        },
    };
}

function outlineError(error, overrides = {}) {
    return {
        type: 'ai-session-conversation-outline-result',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        error,
        ...overrides,
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

async function conversationMessages(page) {
    return (await postedMessages(page)).filter(message =>
        message.type === 'request-ai-session-conversation-outline'
        || message.type === 'cancel-ai-session-conversation'
    );
}

async function seedConversationRail(page, provider, sessionId, count = 18) {
    await row(page, provider, sessionId)
        .locator('[data-ai-session-conversation-rail]')
        .evaluate((rail, markerCount) => {
            rail.hidden = false;
            const loading = rail.parentElement.querySelector('.ai-session-conversation-loading');
            if (loading) loading.hidden = true;
            for (let index = 0; index < markerCount; index += 1) {
                const marker = document.createElement('button');
                const stroke = document.createElement('span');
                const preview = document.createElement('span');
                marker.type = 'button';
                marker.className = 'ai-session-conversation-marker';
                marker.setAttribute('data-ai-session-conversation-marker', '');
                marker.setAttribute('data-interaction-id', `interaction-${index}`);
                stroke.className = 'ai-session-conversation-marker-stroke';
                stroke.setAttribute('aria-hidden', 'true');
                preview.className = 'ai-session-conversation-marker-preview';
                preview.textContent = `Input ${index + 1}`;
                marker.appendChild(stroke);
                marker.appendChild(preview);
                rail.appendChild(marker);
            }
        }, count);
}

async function isFullyInsideViewport(page, locator) {
    return locator.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
}

async function postWorkspaceUpdate(page, activeAiSessions, markerCount = 0) {
    const html = `<div class="open-current-workspace-group">
        ${projectMarkup(activeAiSessions, markerCount)}
    </div>`;
    await page.evaluate(htmlValue => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: 1,
            html: htmlValue,
        } }));
    }, html);
}

async function postOpenWorkspacesUpdate(page, options) {
    const currentMarkup = options.currentSessions
        ? `<div class="open-current-workspace-group">
            ${projectMarkup(options.currentSessions, options.markerCount || 0)}
        </div>`
        : '<div class="open-current-workspace-group"></div>';
    const navigationMarkup = `<div class="open-other-windows-group"
        data-other-windows-status="ready">
        ${options.currentSessions ? currentOpenWorkspaceProjectMarkup() : ''}
        ${options.navigationSessions
        ? navigationProjectMarkup(options.navigationSessions)
        : ''}
    </div>`;
    const currentWorkspaceCount = options.currentSessions ? 1 : 0;
    const navigationWorkspaceCount = options.navigationSessions ? 1 : 0;
    await page.evaluate(value => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'open-workspaces-updated',
            version: 2,
            semanticRevision: value.semanticRevision,
            currentWorkspaceCount: value.currentWorkspaceCount,
            navigationWorkspaceCount: value.navigationWorkspaceCount,
            otherWindowsStatus: 'ready',
            html: value.html,
            searchCatalog: {
                version: 2,
                sessions: [],
                openWorkspaces: Array.from(
                    { length: value.currentWorkspaceCount + value.navigationWorkspaceCount },
                    (_, index) => ({ identity: `workspace-${index}` })
                ),
                savedProjects: [],
                todos: [],
            },
        } }));
    }, {
        semanticRevision: options.semanticRevision,
        currentWorkspaceCount,
        navigationWorkspaceCount,
        html: currentMarkup + navigationMarkup,
    });
}

async function postInvalidOpenWorkspacesUpdate(page, semanticRevision) {
    await page.evaluate(revision => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'open-workspaces-updated',
            version: 2,
            semanticRevision: revision,
            currentWorkspaceCount: 1,
            navigationWorkspaceCount: 0,
            otherWindowsStatus: 'ready',
            html: `<div class="open-current-workspace-group"></div>
                <div class="open-other-windows-group"
                    data-other-windows-status="ready"></div>`,
            searchCatalog: {
                version: 2,
                sessions: [],
                openWorkspaces: [{ identity: 'missing-current-workspace' }],
                savedProjects: [],
                todos: [],
            },
        } }));
    }, semanticRevision);
}

test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 renders only an exact current focused expansion result', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const rail = focused.locator('[data-ai-session-conversation-rail]');

    const invalidResults = [
        { ...outlineResult({ interactions: [summary('version', 1, 'Version')] }), version: 2 },
        { ...outlineResult({ interactions: [summary('fractional-request', 1, 'Request')] }), requestId: 1.5 },
        { ...outlineResult({ interactions: [summary('unsafe-request', 1, 'Request')] }), requestId: Number.MAX_SAFE_INTEGER + 1 },
        { ...outlineResult({ interactions: [summary('future', 1, 'Future')] }), requestId: 2 },
        { ...outlineResult({ interactions: [summary('generation', 1, 'Generation')] }), subscriptionGeneration: 0 },
        { ...outlineResult({ interactions: [summary('fractional-generation', 1, 'Generation')] }), subscriptionGeneration: 1.5 },
        outlineResult({ projectId: 'project-b', interactions: [summary('project', 1, 'Project')] }),
        outlineResult({ provider: 'kimi', interactions: [summary('provider', 1, 'Provider')] }),
        outlineResult({ sessionId: 'session-b', interactions: [summary('session', 1, 'Session')] }),
        { ...outlineResult({ interactions: [summary('extra-envelope', 1, 'Extra')] }), undocumented: true },
        {
            ...outlineResult({ interactions: [summary('both', 1, 'Both')] }),
            error: { code: 'unavailable' },
        },
        {
            ...outlineResult({ interactions: [summary('payload-provider', 1, 'Payload')] }),
            payload: {
                ...outlineResult().payload,
                provider: 'kimi',
                interactions: [summary('payload-provider', 1, 'Payload')],
                totalInteractions: 1,
            },
        },
        {
            ...outlineResult({ interactions: [summary('payload-session', 1, 'Payload')] }),
            payload: {
                ...outlineResult().payload,
                sessionId: 'session-b',
                interactions: [summary('payload-session', 1, 'Payload')],
                totalInteractions: 1,
            },
        },
        {
            ...outlineResult({ interactions: [summary('revision', 1, 'Revision')] }),
            payload: {
                ...outlineResult().payload,
                sourceRevision: '',
                interactions: [summary('revision', 1, 'Revision')],
                totalInteractions: 1,
            },
        },
        outlineResult({
            interactions: [{ ...summary('malformed', 1, 'Malformed'), userGraphemeCount: -1 }],
        }),
        outlineResult({
            interactions: [summary('oversized-count', 64_001, 'Oversized count')],
        }),
        outlineResult({
            interactions: [summary('oversized-preview', 161, 'x'.repeat(161))],
        }),
        outlineResult({
            interactions: [summary('oversized-code-units', 1, 'e\u0301'.repeat(2_049))],
        }),
        outlineResult({
            interactions: [{ ...summary('response', 1, 'Response'), responseState: 'streaming' }],
        }),
        outlineResult({
            interactions: [
                summary('duplicate', 1, 'First'),
                summary('duplicate', 2, 'Second'),
            ],
        }),
        {
            ...outlineResult({ interactions: [summary('extra', 1, 'Extra')] }),
            payload: {
                ...outlineResult().payload,
                interactions: [summary('extra', 1, 'Extra')],
                totalInteractions: 1,
                undocumented: true,
            },
        },
        outlineError({ code: 'unknown' }),
        outlineError({
            code: 'unavailable',
            reason: 'unsupportedCodexProtocol',
        }),
        outlineError({
            code: 'unavailable',
            reason: 'codexRetryExhausted',
            retryAfterMs: 0,
        }),
        outlineError({
            code: 'unavailable',
            reason: 'reconnectingCodex',
            retryAfterMs: 60_001,
        }),
        {
            ...outlineError({ code: 'unavailable' }),
            error: { code: 'unavailable', undocumented: true },
        },
    ];
    for (const result of invalidResults) {
        await postHostMessage(page, result);
    }
    assert.equal(await rail.locator('[data-ai-session-conversation-marker]').count(), 0);
    assert.equal(
        await focused.locator('.ai-session-conversation-loading').textContent(),
        'Loading conversation…'
    );

    await postHostMessage(page, outlineResult({
        interactions: [summary('current', 12, 'Current input')],
    }));
    assert.equal(await rail.locator('[data-ai-session-conversation-marker]').count(), 1);
    assert.equal(
        await rail.locator('[data-ai-session-conversation-marker]').getAttribute(
            'data-interaction-id'
        ),
        'current'
    );

    const closedPage = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const closedRow = row(closedPage, 'codex', 'session-a');
    await closedRow.locator('.ai-session-primary-action').click();
    await closedRow.locator('.ai-session-primary-action').click();
    await postHostMessage(closedPage, outlineResult({
        interactions: [summary('closed', 4, 'Closed input')],
    }));
    assert.equal(
        await closedRow.locator('[data-ai-session-conversation-marker]').count(),
        0
    );

    const unfocusedPage = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const unfocusedRow = row(unfocusedPage, 'codex', 'session-a');
    await unfocusedRow.locator('.ai-session-primary-action').click();
    await unfocusedRow.evaluate(node => node.removeAttribute('data-session-focused'));
    await postHostMessage(unfocusedPage, outlineResult({
        interactions: [summary('unfocused', 4, 'Unfocused input')],
    }));
    assert.equal(
        await unfocusedRow.locator('[data-ai-session-conversation-marker]').count(),
        0
    );

    const replacedPage = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    await row(replacedPage, 'codex', 'session-a')
        .locator('.ai-session-primary-action').click();
    await postWorkspaceUpdate(replacedPage, [
        session('codex', 'session-a', true),
    ]);
    const replacedRow = row(replacedPage, 'codex', 'session-a');
    await postHostMessage(replacedPage, outlineResult({
        requestId: 2,
        subscriptionGeneration: 2,
        interactions: [summary('replacement-request', 3, 'Replacement request')],
    }));
    assert.equal(
        await replacedRow.locator('[data-ai-session-conversation-marker]').count(),
        0
    );
    await postHostMessage(replacedPage, outlineResult({
        requestId: 1,
        subscriptionGeneration: 1,
        interactions: [summary('retained-current', 3, 'Retained current')],
    }));
    assert.equal(
        await replacedRow.locator('[data-interaction-id="retained-current"]').count(),
        1
    );
});

test('ACTIVE-SESSION-CONVERSATION-OUTLINE-001 renders the actual Task 6 capped shape on first and live results', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    const state = focused.locator('.ai-session-conversation-loading');
    const count = focused.locator('[data-ai-session-conversation-count]');
    const initialOutline = buildConversationOutline(
        'codex',
        'session-a',
        'model-r2000',
        modelInteractions(2_000),
        false
    );
    assert.equal(initialOutline.partial, false);
    assert.equal(initialOutline.totalInteractions, 2_000);
    assert.equal(initialOutline.interactions.length, 2_000);
    await postHostMessage(page, outlineResult({
        sourceRevision: initialOutline.sourceRevision,
        interactions: initialOutline.interactions,
        totalInteractions: initialOutline.totalInteractions,
        partial: initialOutline.partial,
    }));
    assert.equal(
        await rail.locator('[data-ai-session-conversation-marker]').count(),
        2_000
    );
    assert.equal(await count.textContent(), '2000');
    assert.equal(await state.isHidden(), true);

    const liveOutline = buildConversationOutline(
        'codex',
        'session-a',
        'model-r2001',
        modelInteractions(2_001),
        false
    );
    assert.equal(liveOutline.partial, true);
    assert.equal(liveOutline.totalInteractions, 2_001);
    assert.equal(liveOutline.interactions.length, 2_000);
    assert.equal(liveOutline.interactions[0].id, 'model-2');
    await postHostMessage(page, outlineResult({
        sourceRevision: liveOutline.sourceRevision,
        interactions: liveOutline.interactions,
        totalInteractions: liveOutline.totalInteractions,
        partial: liveOutline.partial,
    }));
    assert.equal(
        await rail.locator('[data-ai-session-conversation-marker]').count(),
        2_000
    );
    assert.equal(
        await rail.locator('[data-ai-session-conversation-marker]')
            .first().getAttribute('data-interaction-id'),
        'model-2'
    );
    assert.equal(
        await rail.locator('[data-ai-session-conversation-marker]')
            .last().getAttribute('data-interaction-id'),
        'model-2001'
    );
    assert.equal(await count.textContent(), '2,000+');
    assert.equal(await state.getAttribute('data-state'), 'partial');
    assert.equal(await state.textContent(), 'Older inputs omitted');
});

test('ACTIVE-SESSION-CONVERSATION-STATES-001 rejects every invalid public error pairing without changing rendered state', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    const state = focused.locator('.ai-session-conversation-loading');
    const codes = [
        'unavailable', 'staleRevision', 'unsupportedVersion', 'tooLarge', 'timeout',
    ];
    const reasons = [
        undefined,
        'missingSource',
        'updateCodex',
        'unsupportedCodexProtocol',
        'reconnectingCodex',
        'codexRetryExhausted',
    ];
    const isAllowed = (code, reason, retryAfterMs) => {
        if (reason === undefined) {
            return retryAfterMs === undefined;
        }
        if (reason === 'missingSource'
            || reason === 'updateCodex'
            || reason === 'reconnectingCodex') {
            return code === 'unavailable' && retryAfterMs === undefined;
        }
        if (reason === 'unsupportedCodexProtocol') {
            return code === 'unsupportedVersion' && retryAfterMs === undefined;
        }
        return reason === 'codexRetryExhausted'
            && code === 'unavailable'
            && Number.isSafeInteger(retryAfterMs)
            && retryAfterMs > 0
            && retryAfterMs <= 60_000;
    };
    const invalidErrors = [];
    for (const code of codes) {
        for (const reason of reasons) {
            for (const retryAfterMs of [undefined, 1]) {
                if (isAllowed(code, reason, retryAfterMs)) continue;
                invalidErrors.push({
                    label: `${code}/${reason || 'none'}/${retryAfterMs ?? 'none'}`,
                    error: {
                        code,
                        ...(reason === undefined ? {} : { reason }),
                        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                    },
                });
            }
        }
    }
    for (const retryAfterMs of [0, -1, 1.5, 60_001]) {
        invalidErrors.push({
            label: `unavailable/codexRetryExhausted/${retryAfterMs}`,
            error: {
                code: 'unavailable',
                reason: 'codexRetryExhausted',
                retryAfterMs,
            },
        });
    }

    const violations = [];
    for (const [index, candidate] of invalidErrors.entries()) {
        const baselineId = `error-baseline-${index}`;
        await postHostMessage(page, outlineResult({
            sourceRevision: `error-r${index}`,
            interactions: [summary(baselineId, 3, `Baseline ${index}`)],
        }));
        await postHostMessage(page, outlineError(candidate.error));
        const markerIds = await rail
            .locator('[data-ai-session-conversation-marker]')
            .evaluateAll(nodes => nodes.map(node =>
                node.getAttribute('data-interaction-id')
            ));
        const unchanged = markerIds.length === 1
            && markerIds[0] === baselineId
            && await state.isHidden()
            && await page.evaluate(() =>
                activeAiSessionConversationRetryTimer === null
                && activeAiSessionConversationRetryDeadline === 0
            );
        if (!unchanged) {
            violations.push(candidate.label);
        }
    }
    assert.deepEqual(violations, []);

    for (const [index, code] of codes.entries()) {
        await postHostMessage(page, outlineResult({
            sourceRevision: `generic-r${index}`,
            interactions: [summary(`generic-baseline-${index}`, 3, 'Generic')],
        }));
        await postHostMessage(page, outlineError({ code }));
        assert.equal(
            await rail.locator('[data-ai-session-conversation-marker]').count(),
            0,
            `generic ${code} must be accepted`
        );
        assert.equal(
            await page.evaluate(() => activeAiSessionConversationRetryTimer),
            null
        );
    }
});

test('ACTIVE-SESSION-CONVERSATION-STATES-001 distinguishes loading, empty, stale, partial, and exact Codex errors', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const panel = focused.locator('[data-ai-session-conversation-panel]');
    const state = panel.locator('.ai-session-conversation-loading');
    const count = panel.locator('[data-ai-session-conversation-count]');

    assert.equal(await state.getAttribute('data-state'), 'loading');
    assert.equal(await state.textContent(), 'Loading conversation…');

    await postHostMessage(page, outlineResult());
    assert.equal(await state.getAttribute('data-state'), 'empty');
    assert.equal(await state.textContent(), 'No user inputs yet');
    assert.equal(await count.textContent(), '0');

    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'missingSource',
    }));
    assert.equal(await state.getAttribute('data-state'), 'unavailable');
    assert.match(await state.textContent(), /Conversation history unavailable/);

    await postHostMessage(page, outlineError({ code: 'staleRevision' }));
    assert.equal(await state.getAttribute('data-state'), 'stale');
    assert.match(await state.textContent(), /Conversation history changed/);

    const sourcePartialOutline = buildConversationOutline(
        'codex',
        'session-a',
        'source-partial',
        modelInteractions(2),
        true
    );
    await postHostMessage(page, outlineResult({
        sourceRevision: sourcePartialOutline.sourceRevision,
        totalInteractions: sourcePartialOutline.totalInteractions,
        partial: sourcePartialOutline.partial,
        interactions: sourcePartialOutline.interactions,
    }));
    assert.equal(await state.getAttribute('data-state'), 'partial');
    assert.match(await state.textContent(), /Older inputs omitted/);
    assert.equal(await count.textContent(), '2');

    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'updateCodex',
    }));
    assert.equal(await state.textContent(), 'Update Codex to view conversation historyRetry');

    await postHostMessage(page, outlineError({
        code: 'unsupportedVersion',
        reason: 'unsupportedCodexProtocol',
    }));
    assert.match(await state.textContent(), /Installed Codex protocol is not supported/);
    assert.match(
        await state.textContent(),
        /Compare your installed Codex and Agent Pivot versions/
    );

    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'reconnectingCodex',
    }));
    assert.match(await state.textContent(), /Reconnecting to Codex…/);
    const reconnectRetry = state.locator('button', { hasText: 'Retry' });
    assert.equal(await reconnectRetry.isEnabled(), true);
    await reconnectRetry.click();
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });

    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'codexRetryExhausted',
        retryAfterMs: 25,
    }, {
        requestId: 2,
        subscriptionGeneration: 2,
    }));
    assert.match(await state.textContent(), /Codex conversation history unavailable/);
    const exhaustedRetry = state.locator('button', { hasText: 'Retry' });
    assert.equal(await exhaustedRetry.isDisabled(), true);
    await waitForPageCondition(page, () => {
        const button = document.querySelector(
            '[data-ai-session-conversation-state] [data-action="retry-ai-session-conversation"]'
        );
        return button && !button.disabled;
    });
    assert.equal(await exhaustedRetry.isEnabled(), true);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 renders safe readable equal-width rows and posts exact opaque navigation', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const hostilePreview = ');background:url(javascript:alert(1))';
    await postHostMessage(page, {
        type: 'ai-session-conversation-outline-result',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        payload: {
            provider: 'codex',
            sessionId: 'session-a',
            sourceRevision: 'r1',
            totalInteractions: 3,
            partial: false,
            interactions: [
                summary('input-1', 10, 'First input'),
                summary('input-2', 40, hostilePreview),
                summary('input-3', 20, 'Latest input', {
                    responseState: 'inProgress',
                }),
            ],
        },
    });
    const markers = focused.locator('[data-ai-session-conversation-marker]');
    assert.equal(await markers.count(), 3);
    assert.equal(await markers.nth(0).getAttribute('data-interaction-id'), 'input-1');
    assert.equal(await markers.nth(2).getAttribute('data-interaction-id'), 'input-3');
    const geometry = await markers.evaluateAll(nodes => nodes.map(node => {
        const stroke = node.querySelector(
            '.ai-session-conversation-marker-stroke'
        );
        const preview = node.querySelector(
            '.ai-session-conversation-marker-preview'
        );
        const previewStyle = preview && getComputedStyle(preview);
        return {
            ratio: node.style.getPropertyValue('--ai-input-ratio'),
            fillsRail: node.offsetWidth === node.parentElement.clientWidth,
            rowHeight: node.getBoundingClientRect().height,
            strokeWidth: stroke && getComputedStyle(stroke).width,
            strokeHeight: stroke && getComputedStyle(stroke).height,
            preview: preview && preview.textContent,
            whiteSpace: previewStyle && previewStyle.whiteSpace,
            overflow: previewStyle && previewStyle.overflow,
            textOverflow: previewStyle && previewStyle.textOverflow,
            tabIndex: node.tabIndex,
            selected: node.getAttribute('aria-selected'),
            role: node.getAttribute('role'),
        };
    }));
    assert.deepEqual(geometry, [
        {
            ratio: '',
            fillsRail: true,
            rowHeight: 28,
            strokeWidth: '14px',
            strokeHeight: '2px',
            preview: 'First input',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            tabIndex: -1,
            selected: 'false',
            role: 'option',
        },
        {
            ratio: '',
            fillsRail: true,
            rowHeight: 28,
            strokeWidth: '14px',
            strokeHeight: '2px',
            preview: hostilePreview,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            tabIndex: -1,
            selected: 'false',
            role: 'option',
        },
        {
            ratio: '',
            fillsRail: true,
            rowHeight: 28,
            strokeWidth: '14px',
            strokeHeight: '2px',
            preview: 'Latest input',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            tabIndex: 0,
            selected: 'true',
            role: 'option',
        },
    ]);
    assert.notEqual(await markers.nth(2).getAttribute('data-latest'), null);
    assert.notEqual(await markers.nth(2).getAttribute('data-current'), null);
    assert.equal(await markers.nth(1).textContent(), hostilePreview);
    assert.match(await markers.nth(1).getAttribute('title'), /background:url/);
    assert.equal(await markers.nth(1).getAttribute('style'), null);
    assert.match(await markers.nth(0).getAttribute('aria-label'), /First input/);
    assert.match(await markers.nth(0).getAttribute('aria-label'), /2026/);

    await markers.nth(0).focus();
    await page.keyboard.press('End');
    assert.equal(await markers.nth(2).evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Enter');
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-3',
        expectedRevision: 'r1',
    });
    await page.keyboard.press('ArrowUp');
    assert.equal(await markers.nth(1).evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Home');
    assert.equal(await markers.nth(0).evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await markers.nth(1).evaluate(node => document.activeElement === node), true);
    await markers.nth(0).click();
    assert.deepEqual(await markers.evaluateAll(nodes => nodes.map(node => ({
        tabIndex: node.tabIndex,
        selected: node.getAttribute('aria-selected'),
    }))), [
        { tabIndex: 0, selected: 'true' },
        { tabIndex: -1, selected: 'false' },
        { tabIndex: -1, selected: 'false' },
    ]);
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: 3,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-1',
        expectedRevision: 'r1',
    });
    assert.notEqual(await focused.getAttribute('data-conversation-expanded'), null);

    const longPreview = '👨‍👩‍👧‍👦'.repeat(160);
    await postHostMessage(page, outlineResult({
        sourceRevision: 'r2',
        interactions: [summary('long-preview', 160, longPreview)],
    }));
    const truncatedMarker = focused.locator('[data-interaction-id="long-preview"]');
    assert.equal(await truncatedMarker.evaluate(node =>
        Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' })
            .segment(node.textContent)).length
    ), 160);
    assert.equal(await truncatedMarker.evaluate(node =>
        Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' })
            .segment(node.title.split(' — ').at(-1))).length
    ), 160);

    await page.evaluate(() => { window.__postedMessages.length = 0; });
    await truncatedMarker.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    assert.equal(await truncatedMarker.evaluate(node => document.activeElement === node), true);
    assert.deepEqual(await postedMessages(page), []);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 caps the readable rail and preserves bounded scrolling', async t => {
    const spaciousPage = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const spaciousRow = row(spaciousPage, 'codex', 'session-a');
    await spaciousRow.locator('.ai-session-primary-action').click();
    const shortOutline = [
        summary('fits-1', 2, 'Fits one'),
        summary('fits-2', 3, 'Fits two'),
        summary('fits-3', 4, 'Fits three'),
    ];
    await postHostMessage(spaciousPage, outlineResult({ interactions: shortOutline }));
    assert.equal(
        await spaciousRow.locator('[data-ai-session-conversation-rail]')
            .evaluate(node => node.scrollTop),
        0
    );
    const shortRailGeometry = await spaciousRow
        .locator('[data-ai-session-conversation-rail]')
        .evaluate(node => ({
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
        }));
    assert.deepEqual(shortRailGeometry, {
        clientHeight: 84,
        scrollHeight: 84,
    });

    const spaciousLongOutline = Array.from({ length: 18 }, (_, index) =>
        summary(`spacious-${index}`, index + 1, `Spacious input ${index}`)
    );
    await postHostMessage(
        spaciousPage,
        outlineResult({
            sourceRevision: 'spacious-r2',
            interactions: spaciousLongOutline,
        })
    );
    await waitForPageCondition(spaciousPage, () => {
        const node = document.querySelector(
            '[data-ai-session-conversation-rail]'
        );
        return node && node.scrollHeight > node.clientHeight;
    });
    assert.deepEqual(
        await spaciousRow.locator('[data-ai-session-conversation-rail]')
            .evaluate(node => ({
                clientHeight: node.clientHeight,
                overflows: node.scrollHeight > node.clientHeight,
            })),
        { clientHeight: 168, overflows: true }
    );

    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ], { width: 360, height: 260 });
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    const interactions = Array.from({ length: 18 }, (_, index) =>
        summary(`scroll-${index}`, index + 1, `Scroll input ${index}`)
    );
    await postHostMessage(page, outlineResult({ interactions }));
    await waitForPageCondition(page, () => {
        const node = document.querySelector('[data-ai-session-conversation-rail]');
        const latest = node?.querySelector('[data-latest]');
        if (!node || !latest || node.scrollTop <= 0) return false;
        return latest.getBoundingClientRect().bottom
            <= node.getBoundingClientRect().bottom + 1;
    });

    const initialMarkers = focused.locator('[data-ai-session-conversation-marker]');
    await initialMarkers.nth(17).focus();
    await page.keyboard.press('Home');
    assert.equal(await initialMarkers.nth(0).evaluate(node => {
        const railNode = node.closest('[data-ai-session-conversation-rail]');
        const nodeRect = node.getBoundingClientRect();
        const railRect = railNode.getBoundingClientRect();
        return document.activeElement === node
            && nodeRect.top >= railRect.top - 1
            && nodeRect.bottom <= railRect.bottom + 1;
    }), true);
    await page.keyboard.press('End');
    assert.equal(await initialMarkers.nth(17).evaluate(node => {
        const railNode = node.closest('[data-ai-session-conversation-rail]');
        const nodeRect = node.getBoundingClientRect();
        const railRect = railNode.getBoundingClientRect();
        return document.activeElement === node
            && nodeRect.top >= railRect.top - 1
            && nodeRect.bottom <= railRect.bottom + 1;
    }), true);

    const atEndBefore = await rail.evaluate(node => {
        node.scrollTop = node.scrollHeight - node.clientHeight;
        return node.scrollTop;
    });
    await postHostMessage(page, outlineResult({
        sourceRevision: 'r2',
        interactions: [
            ...interactions,
            summary('scroll-18', 19, 'New live input'),
        ],
    }));
    assert.ok(atEndBefore > 0);
    assert.equal(await rail.evaluate(node =>
        node.scrollHeight - node.clientHeight - node.scrollTop
    ), 0);
    assert.equal(await focused.locator('[data-interaction-id="scroll-17"]')
        .evaluate(node => document.activeElement === node), true);
    assert.equal(await focused.locator('[data-interaction-id="scroll-18"]')
        .evaluate(node => {
            const railNode = node.closest('[data-ai-session-conversation-rail]');
            return node.getBoundingClientRect().bottom
                <= railNode.getBoundingClientRect().bottom + 1;
        }), true);

    const historicalScrollTop = await rail.evaluate(node => {
        node.scrollTop = 24;
        return node.scrollTop;
    });
    await postHostMessage(page, outlineResult({
        sourceRevision: 'r3',
        interactions: [
            ...interactions,
            summary('scroll-18', 19, 'New live input'),
            summary('scroll-19', 20, 'Unread input'),
        ],
    }));
    assert.equal(await rail.evaluate(node => node.scrollTop), historicalScrollTop);

    const invalidThresholdScrollTop = await rail.evaluate(node => {
        node.scrollTop = node.scrollHeight - node.clientHeight;
        node.setAttribute('data-auto-scroll-threshold', '8px');
        return node.scrollTop;
    });
    await postHostMessage(page, outlineResult({
        sourceRevision: 'r4',
        interactions: [
            ...interactions,
            summary('scroll-18', 19, 'New live input'),
            summary('scroll-19', 20, 'Unread input'),
            summary('scroll-20', 21, 'Invalid threshold input'),
        ],
    }));
    assert.equal(await rail.evaluate(node => node.scrollTop), invalidThresholdScrollTop);
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-002 retains rendered history scroll and focus after matching HTML replacement', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ], { width: 360, height: 260 });
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const interactions = Array.from({ length: 18 }, (_, index) =>
        summary(`restore-${index}`, index + 1, `Restore input ${index}`)
    );
    await postHostMessage(page, outlineResult({ interactions }));
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    await waitForPageCondition(page, () => {
        const node = document.querySelector('[data-ai-session-conversation-rail]');
        return node && node.scrollHeight > node.clientHeight;
    });
    const capturedScrollTop = await rail.evaluate(node => {
        node.scrollTop = 64;
        node.querySelector('[data-interaction-id="restore-6"]').focus();
        return node.scrollTop;
    });
    assert.ok(capturedScrollTop > 0);

    const requestsBefore = (await conversationMessages(page))
        .filter(message => message.type === 'request-ai-session-conversation-outline').length;
    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
    ]);
    const restored = row(page, 'codex', 'session-a');
    assert.equal(
        await restored.locator('[data-interaction-id="restore-6"]').isVisible(),
        true,
        'the last validated outline must remain visible synchronously'
    );
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        requestsBefore,
        'a same-identity replacement must retain the existing subscription'
    );
    assert.equal(
        await restored.locator('.ai-session-conversation-loading').isVisible(),
        false
    );
    assert.equal(
        await restored.locator('[data-ai-session-conversation-rail]')
            .evaluate(node => node.scrollTop),
        capturedScrollTop
    );
    assert.equal(
        await restored.locator('[data-interaction-id="restore-6"]')
            .evaluate(node => document.activeElement === node),
        true
    );
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-002 retains a validated error after matching HTML replacement without another Host request', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineError({ code: 'timeout' }));
    assert.equal(
        await focused.locator('.ai-session-conversation-loading').textContent(),
        'Conversation history timed outRetry'
    );
    const requestsBefore = (await conversationMessages(page))
        .filter(message => message.type === 'request-ai-session-conversation-outline').length;

    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
    ]);
    const restored = row(page, 'codex', 'session-a');
    assert.equal(
        await restored.locator('.ai-session-conversation-loading').textContent(),
        'Conversation history timed outRetry'
    );
    assert.equal(
        await restored.locator('.ai-session-conversation-loading').getAttribute('data-state'),
        'unavailable'
    );
    assert.equal(
        await restored.locator('[data-ai-session-conversation-marker]').count(),
        0
    );
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        requestsBefore
    );

    await restored.locator('[data-action="retry-ai-session-conversation"]').click();
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        requestsBefore + 1
    );
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-002 replaces a cached outline with the latest validated error and retains its Retry deadline', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineResult({
        interactions: [summary('must-not-return', 16, 'Must not return')],
    }));
    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'codexRetryExhausted',
        retryAfterMs: 60_000,
    }));
    const deadlineBefore = await page.evaluate(() =>
        activeAiSessionConversationRetryDeadline
    );
    const requestsBefore = (await conversationMessages(page))
        .filter(message => message.type === 'request-ai-session-conversation-outline').length;

    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
    ]);
    const restored = row(page, 'codex', 'session-a');
    const deadlineAfter = await page.evaluate(() =>
        activeAiSessionConversationRetryDeadline
    );
    assert.equal(
        await restored.locator('[data-interaction-id="must-not-return"]').count(),
        0
    );
    assert.equal(
        await restored.locator('.ai-session-conversation-loading').textContent(),
        'Codex conversation history unavailableRetry'
    );
    assert.equal(
        await restored.locator('[data-action="retry-ai-session-conversation"]').isDisabled(),
        true
    );
    assert.ok(deadlineBefore > Date.now());
    assert.ok(
        Math.abs(deadlineAfter - deadlineBefore) <= 5,
        `expected retained Retry deadline ${deadlineBefore}, received ${deadlineAfter}`
    );
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        requestsBefore
    );
});

test('ACTIVE-SESSION-CONVERSATION-RETRY-001 clears Retry timers on collapse and disposal while retaining the deadline through replacement', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'codexRetryExhausted',
        retryAfterMs: 60_000,
    }));
    assert.equal(await page.evaluate(() =>
        typeof activeAiSessionConversationRetryTimer
    ), 'number');
    await focused.locator('.ai-session-primary-action').click();
    assert.equal(await page.evaluate(() =>
        typeof activeAiSessionConversationRetryTimer === 'undefined'
            ? undefined
            : activeAiSessionConversationRetryTimer
    ), null);

    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineError({
        code: 'unavailable',
        reason: 'codexRetryExhausted',
        retryAfterMs: 60_000,
    }, {
        requestId: 3,
        subscriptionGeneration: 3,
    }));
    assert.equal(await page.evaluate(() =>
        typeof activeAiSessionConversationRetryTimer
    ), 'number');
    const replacementDeadline = await page.evaluate(() =>
        activeAiSessionConversationRetryDeadline
    );
    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
    ]);
    assert.equal(await page.evaluate(() =>
        typeof activeAiSessionConversationRetryTimer
    ), 'number');
    assert.ok(Math.abs((await page.evaluate(() =>
        activeAiSessionConversationRetryDeadline
    )) - replacementDeadline) <= 5);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await page.evaluate(() =>
        typeof activeAiSessionConversationRetryTimer === 'undefined'
            ? undefined
            : activeAiSessionConversationRetryTimer
    ), null);
});

test('ACTIVE-SESSION-CONVERSATION-EXPANSION-001 focuses first, toggles one focused card, consumes actions, and starts a new document closed', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focusedCard = row(page, 'codex', 'session-a');
    const focusedHeader = focusedCard.locator('.ai-session-primary-action');
    const nonFocusedCard = row(page, 'kimi', 'session-b');
    const conversationPanel = focusedCard.locator('[data-ai-session-conversation-panel]');

    await expectClosed(focusedCard, focusedHeader, conversationPanel, true);
    await expectClosed(
        nonFocusedCard,
        nonFocusedCard.locator('.ai-session-primary-action'),
        nonFocusedCard.locator('[data-ai-session-conversation-panel]'),
        false
    );

    await focusedCard.click();
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });

    await focusedCard.locator('[data-action="toggle-ai-session-pin"]').click();
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);
    assert.equal((await postedMessages(page)).at(-1).type, 'toggle-ai-session-pin');
    await seedConversationRail(page, 'codex', 'session-a', 2);
    await focusedCard.locator('[data-ai-session-conversation-marker]').first().click();
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);

    await focusedHeader.click();
    await expectClosed(focusedCard, focusedHeader, conversationPanel, true);
    assert.equal((await postedMessages(page)).at(-1).type, 'cancel-ai-session-conversation');

    await focusedHeader.focus();
    await focusedHeader.press('Enter');
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);
    await focusedHeader.press('Space');
    await expectClosed(focusedCard, focusedHeader, conversationPanel, true);
    await focusedHeader.press('Space');
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);
    await focusedHeader.press('Escape');
    await expectClosed(focusedCard, focusedHeader, conversationPanel, true);
    assert.equal(
        await focusedHeader.evaluate(node => document.activeElement === node),
        true
    );

    await focusedHeader.click();
    await nonFocusedCard.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'focus-ai-session-terminal',
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-b',
    });
    await expectClosed(focusedCard, focusedHeader, conversationPanel, true);
    assert.equal(await nonFocusedCard.getAttribute('data-conversation-expanded'), null);

    const reload = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    await expectClosed(
        row(reload, 'codex', 'session-a'),
        row(reload, 'codex', 'session-a').locator('.ai-session-primary-action'),
        row(reload, 'codex', 'session-a').locator('[data-ai-session-conversation-panel]'),
        true
    );
    assert.deepEqual(await reload.evaluate(() => window.__setStateCalls), []);
});

test('ACTIVE-SESSION-CONVERSATION-EXPANSION-002 keeps exactly one focused shell open', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', true),
    ]);
    const first = row(page, 'codex', 'session-a');
    const second = row(page, 'kimi', 'session-b');

    await first.locator('.ai-session-primary-action').click();
    await second.locator('.ai-session-primary-action').click();

    assert.equal(
        await page.locator('.active-ai-session-row[data-conversation-expanded]').count(),
        1
    );
    assert.equal(await first.getAttribute('data-conversation-expanded'), null);
    assert.notEqual(await second.getAttribute('data-conversation-expanded'), null);
});

test('ACTIVE-SESSION-CONVERSATION-LAYOUT-001 measures one row delta synchronously and bounds only the rail in a short viewport', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
        session('claude', 'session-c', false),
    ]);
    const focusedCard = row(page, 'codex', 'session-a');
    const focusedHeader = focusedCard.locator('.ai-session-primary-action');
    const conversationPanel = focusedCard.locator('[data-ai-session-conversation-panel]');
    const conversationRail = focusedCard.locator('[data-ai-session-conversation-rail]');
    const list = page.locator('.ai-session-active-panel .codex-sessions-list');
    const collapsed = await page.evaluate(() => {
        const listNode = document.querySelector('.ai-session-active-panel .codex-sessions-list');
        const rowNode = document.querySelector('.active-ai-session-row[data-session-focused]');
        return {
            listHeight: listNode.getBoundingClientRect().height,
            rowHeight: rowNode.getBoundingClientRect().height,
        };
    });

    await page.setViewportSize({ width: 360, height: 900 });
    await focusedCard.click();
    await postHostMessage(page, outlineResult({
        interactions: summaries(18),
    }));
    await assertExpanded(focusedCard, focusedHeader, conversationPanel);
    assert.equal(await isFullyInsideViewport(page, conversationPanel), true);
    const spaciousRail = await conversationRail.evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        firstMarkerVisible: (() => {
            const marker = node.querySelector('[data-ai-session-conversation-marker]');
            const railRect = node.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            return markerRect.top >= railRect.top && markerRect.bottom <= railRect.bottom;
        })(),
        lastMarkerVisible: (() => {
            const markers = node.querySelectorAll('[data-ai-session-conversation-marker]');
            const marker = markers[markers.length - 1];
            const railRect = node.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            return markerRect.top >= railRect.top && markerRect.bottom <= railRect.bottom;
        })(),
    }));
    assert.equal(spaciousRail.clientHeight, 168);
    assert.ok(spaciousRail.clientHeight < spaciousRail.scrollHeight);
    assert.equal(spaciousRail.firstMarkerVisible, false);
    assert.equal(spaciousRail.lastMarkerVisible, true);
    const expanded = await page.evaluate(() => {
        const listNode = document.querySelector('.ai-session-active-panel .codex-sessions-list');
        const rowNode = document.querySelector('.active-ai-session-row[data-session-focused]');
        return {
            listHeight: listNode.getBoundingClientRect().height,
            rowHeight: rowNode.getBoundingClientRect().height,
        };
    });
    assert.ok(Math.abs(
        (expanded.listHeight - collapsed.listHeight)
        - (expanded.rowHeight - collapsed.rowHeight)
    ) < 1);

    await page.setViewportSize({ width: 360, height: 260 });
    await focusedHeader.scrollIntoViewIfNeeded();
    assert.equal(await focusedHeader.isVisible(), true);
    assert.equal(await conversationPanel.locator('header').isVisible(), true);
    const constrainedRail = await conversationRail.evaluate(node => {
        const marker = node.querySelector('[data-latest]');
        const railRect = node.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        return {
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            latestMarkerVisible: markerRect.top >= railRect.top
                && markerRect.bottom <= railRect.bottom,
        };
    });
    assert.ok(constrainedRail.clientHeight >= 72);
    assert.ok(constrainedRail.clientHeight < constrainedRail.scrollHeight);
    assert.equal(constrainedRail.overflowY, 'auto');
    assert.equal(constrainedRail.latestMarkerVisible, true);
    assert.equal(await conversationPanel.evaluate(node =>
        getComputedStyle(node).overflowY !== 'auto'
    ), true);
    assert.equal(await list.evaluate(node => getComputedStyle(node).overflowY), 'auto');

    await page.setViewportSize({ width: 360, height: 900 });
    await waitForPageCondition(page, () => {
        const expandedRow = document.querySelector(
            '.active-ai-session-row[data-conversation-expanded]'
        );
        const panelNode = expandedRow?.querySelector(
            '[data-ai-session-conversation-panel]'
        );
        const railNode = expandedRow?.querySelector(
            '[data-ai-session-conversation-rail]'
        );
        if (!panelNode || !railNode) return false;
        const panelRect = panelNode.getBoundingClientRect();
        return railNode.clientHeight === 168
            && railNode.scrollHeight > railNode.clientHeight
            && panelRect.top >= 0
            && panelRect.bottom <= window.innerHeight;
    });
    assert.equal(await isFullyInsideViewport(page, conversationPanel), true);
    assert.deepEqual(await conversationRail.evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    })), {
        clientHeight: 168,
        scrollHeight: spaciousRail.scrollHeight,
    });

    const historicalScrollTop = await conversationRail.evaluate(node => {
        node.scrollTop = 56;
        return node.scrollTop;
    });
    assert.equal(historicalScrollTop, 56);
    await page.setViewportSize({ width: 360, height: 260 });
    await waitForPageCondition(page, () => {
        const railNode = document.querySelector(
            '.active-ai-session-row[data-conversation-expanded] '
            + '[data-ai-session-conversation-rail]'
        );
        return railNode
            && railNode.clientHeight >= 72
            && railNode.clientHeight < 168;
    });
    assert.equal(
        await conversationRail.evaluate(node => node.scrollTop),
        historicalScrollTop
    );
    await page.setViewportSize({ width: 360, height: 900 });
    await waitForPageCondition(page, () => {
        const railNode = document.querySelector(
            '.active-ai-session-row[data-conversation-expanded] '
            + '[data-ai-session-conversation-rail]'
        );
        return railNode && railNode.clientHeight === 168;
    });
    assert.equal(
        await conversationRail.evaluate(node => node.scrollTop),
        historicalScrollTop
    );

    await conversationRail.evaluate(node => {
        Array.from(node.querySelectorAll(
            '[data-ai-session-conversation-marker]'
        )).slice(1).forEach(marker => marker.remove());
    });
    await waitForPageCondition(page, () => {
        const railNode = document.querySelector(
            '.active-ai-session-row[data-conversation-expanded] '
            + '[data-ai-session-conversation-rail]'
        );
        return railNode
            && railNode.clientHeight === 28
            && railNode.scrollHeight === 28;
    });
    assert.deepEqual(await conversationRail.evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    })), {
        clientHeight: 28,
        scrollHeight: 28,
    });

    const loadingPage = await openConversationPage(t, [
        session('codex', 'loading-session', true),
    ]);
    const loadingRow = row(loadingPage, 'codex', 'loading-session');
    await loadingRow.locator('.ai-session-primary-action').click();
    const loadingPanel = loadingRow.locator('[data-ai-session-conversation-panel]');
    assert.equal(await loadingPanel.locator('.ai-session-conversation-loading').isVisible(), true);
    assert.ok(await loadingPanel.evaluate(node =>
        node.getBoundingClientRect().height > 0
        && node.getBoundingClientRect().height < 160
    ));
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-001 keeps one pending envelope and its durable restore state through two replacements', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
    ], { width: 360, height: 260 });
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    assert.deepEqual(await conversationMessages(page), [{
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }]);
    await seedConversationRail(page, 'codex', 'session-a', 18);
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    const anchor = await rail.evaluate(node => {
        node.scrollTop = 64;
        node.querySelector('[data-interaction-id="interaction-6"]').focus();
        return node.querySelector('[data-interaction-id="interaction-6"]').getBoundingClientRect().top
            - node.getBoundingClientRect().top;
    });
    await postWorkspaceUpdate(page, [session('codex', 'session-a', true)]);
    await postWorkspaceUpdate(page, [session('codex', 'session-a', true)]);
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        1,
        'two same-identity replacements must retain request 1/generation 1'
    );
    await postHostMessage(page, outlineResult({
        interactions: [...summaries(18), summary('interaction-18', 19, 'Later input')],
    }));
    const restored = row(page, 'codex', 'session-a');
    const restoredRail = restored.locator('[data-ai-session-conversation-rail]');
    assert.equal(await restored.locator('[data-interaction-id="interaction-6"]').isVisible(), true);
    const restoredAnchor = await restored.locator(
        '[data-interaction-id="interaction-6"]'
    ).evaluate(node =>
        node.getBoundingClientRect().top - node.closest('[data-ai-session-conversation-rail]').getBoundingClientRect().top
    );
    assert.ok(
        Math.abs(restoredAnchor - anchor) <= 1,
        `expected retained offset ${anchor}, received ${restoredAnchor}`
    );
    assert.equal(await restoredRail.locator('[data-interaction-id="interaction-6"]').evaluate(node => document.activeElement === node), true);
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-001 preserves history while live-end readers follow and automatic recovery leaves the outer list anchored', async t => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(
        'codex', `session-${index + 1}`, index === 4
    ));
    const page = await openConversationPage(t, sessions, { width: 360, height: 260 });
    const focused = row(page, 'codex', 'session-5');
    const outer = page.locator('.ai-session-active-panel .codex-sessions-list');
    await waitForPageCondition(page, () => {
        const list = document.querySelector('.ai-session-active-panel .codex-sessions-list');
        return list && list.scrollHeight > list.clientHeight;
    });
    const outerAnchor = await focused.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        list.scrollTop = node.offsetTop - list.offsetTop - 20;
        return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    await focused.locator('.ai-session-primary-action').click();
    const interactions = summaries(18);
    const rail = focused.locator('[data-ai-session-conversation-rail]');
    await postHostMessage(page, outlineResult({
        sessionId: 'session-5',
        interactions,
    }));
    const historyAnchor = await rail.evaluate(node => {
        node.scrollTop = 48;
        node.querySelector('[data-interaction-id="interaction-6"]').focus();
        return node.querySelector('[data-interaction-id="interaction-6"]').getBoundingClientRect().top
            - node.getBoundingClientRect().top;
    });
    await postWorkspaceUpdate(page, sessions);
    await postHostMessage(page, outlineResult({ sessionId: 'session-5', interactions: [
        ...interactions, summary('interaction-18', 19, 'Later input'),
    ] }));
    const restored = row(page, 'codex', 'session-5');
    assert.ok(Math.abs((await relativeTop(restored)) - outerAnchor) <= 1);
    assert.equal(
        await restored.locator('[data-interaction-id="interaction-6"]').count(),
        1,
        'the retained subscription must render the live result into the replacement'
    );
    assert.ok(Math.abs((await restored.locator('[data-interaction-id="interaction-6"]').evaluate(node =>
        node.getBoundingClientRect().top - node.closest('[data-ai-session-conversation-rail]').getBoundingClientRect().top
    )) - historyAnchor) <= 1);

    const liveRail = restored.locator('[data-ai-session-conversation-rail]');
    await liveRail.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight; });
    await postWorkspaceUpdate(page, sessions);
    await postHostMessage(page, outlineResult({ sessionId: 'session-5', interactions: [
        ...interactions, summary('interaction-18', 19, 'Later input'), summary('interaction-19', 20, 'Live input'),
    ] }));
    const liveRestored = row(page, 'codex', 'session-5');
    assert.equal(await liveRestored.locator('[data-ai-session-conversation-rail]').evaluate(node =>
        node.scrollHeight - node.clientHeight - node.scrollTop
    ), 0);
    assert.ok(Math.abs((await relativeTop(liveRestored)) - outerAnchor) <= 1);
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-001 restores only the same still-focused identity and otherwise sends a newer exact cancel', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineResult({
        interactions: summaries(18),
    }));
    await page.setViewportSize({ width: 360, height: 260 });
    await waitForPageCondition(page, () => {
        const rail = document.querySelector(
            '[data-conversation-expanded] [data-ai-session-conversation-rail]'
        );
        return rail && rail.clientHeight < rail.scrollHeight;
    });
    const capturedScrollTop = await focused
        .locator('[data-ai-session-conversation-rail]')
        .evaluate(rail => {
            rail.scrollTop = 64;
            rail.querySelector('[data-interaction-id="interaction-6"]').focus();
            return rail.scrollTop;
        });
    assert.ok(capturedScrollTop > 0);

    const requestsBefore = (await conversationMessages(page))
        .filter(message => message.type === 'request-ai-session-conversation-outline').length;
    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const restored = row(page, 'codex', 'session-a');
    await assertExpanded(
        restored,
        restored.locator('.ai-session-primary-action'),
        restored.locator('[data-ai-session-conversation-panel]')
    );
    assert.equal(
        await restored.locator('[data-interaction-id="interaction-6"]').isVisible(),
        true,
        'the last validated outline must remain visible synchronously'
    );
    assert.equal(
        (await conversationMessages(page))
            .filter(message => message.type === 'request-ai-session-conversation-outline').length,
        requestsBefore,
        'a same-identity replacement must retain the existing subscription'
    );
    assert.equal(await restored.locator('.ai-session-conversation-loading').isVisible(), false);
    assert.equal(
        await restored.locator('[data-ai-session-conversation-rail]').evaluate(
            rail => rail.scrollTop
        ),
        capturedScrollTop
    );
    assert.equal(
        await restored.locator('[data-interaction-id="interaction-6"]').evaluate(
            marker => document.activeElement === marker
        ),
        true
    );

    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', false),
        session('kimi', 'session-b', true),
    ]);
    assert.equal(
        await page.locator('.active-ai-session-row[data-conversation-expanded]').count(),
        0
    );
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'cancel-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.deepEqual(await page.evaluate(() => window.__setStateCalls), []);
});

test('ACTIVE-SESSION-CONVERSATION-RESTORE-001 preserves or cancels expansion through authoritative open-workspaces replacement', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await postHostMessage(page, outlineResult({
        interactions: summaries(18),
    }));
    await page.setViewportSize({ width: 360, height: 260 });
    await waitForPageCondition(page, () => {
        const rail = document.querySelector(
            '[data-conversation-expanded] [data-ai-session-conversation-rail]'
        );
        return rail && rail.clientHeight < rail.scrollHeight;
    });
    const captured = await focused
        .locator('[data-ai-session-conversation-rail]')
        .evaluate(rail => {
            rail.scrollTop = 64;
            rail.querySelector('[data-interaction-id="interaction-6"]').focus();
            return {
                scrollTop: rail.scrollTop,
                disconnects: window.__conversationObserverDisconnects,
            };
        });

    await postOpenWorkspacesUpdate(page, {
        semanticRevision: 'same-focused',
        currentSessions: [
            session('codex', 'session-a', true),
            session('kimi', 'session-b', false),
        ],
    });
    const restored = row(page, 'codex', 'session-a');
    await assertExpanded(
        restored,
        restored.locator('.ai-session-primary-action'),
        restored.locator('[data-ai-session-conversation-panel]')
    );
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    await postHostMessage(page, outlineResult({
        requestId: 1,
        subscriptionGeneration: 1,
        sourceRevision: 'r2',
        interactions: summaries(18),
    }));
    assert.equal(
        await restored.locator('[data-ai-session-conversation-rail]').evaluate(
            rail => rail.scrollTop
        ),
        captured.scrollTop
    );
    assert.equal(
        await restored.locator('[data-interaction-id="interaction-6"]').evaluate(
            marker => document.activeElement === marker
        ),
        true
    );
    assert.ok(await page.evaluate(
        count => window.__conversationObserverDisconnects > count,
        captured.disconnects
    ));

    const restoredScrollTop = await restored
        .locator('[data-ai-session-conversation-rail]')
        .evaluate(rail => rail.scrollTop);
    const geometryBeforeRollback = await restored.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        return {
            rowHeight: node.getBoundingClientRect().height,
            listHeight: list.getBoundingClientRect().height,
            collapsedRowHeight: node.__stewardCollapsedConversationHeight,
            collapsedListHeight: list.__stewardCollapsedConversationHeight,
        };
    });
    const disconnectsBeforeRollback = await page.evaluate(
        () => window.__conversationObserverDisconnects
    );
    await postInvalidOpenWorkspacesUpdate(page, 'invalid-missing-current');
    const rolledBack = row(page, 'codex', 'session-a');
    await assertExpanded(
        rolledBack,
        rolledBack.locator('.ai-session-primary-action'),
        rolledBack.locator('[data-ai-session-conversation-panel]')
    );
    const geometryAfterRollback = await rolledBack.evaluate(node => {
        const list = node.closest('.codex-sessions-list');
        return {
            rowHeight: node.getBoundingClientRect().height,
            listHeight: list.getBoundingClientRect().height,
            collapsedRowHeight: node.__stewardCollapsedConversationHeight,
            collapsedListHeight: list.__stewardCollapsedConversationHeight,
        };
    });
    assert.ok(
        Math.abs(geometryAfterRollback.rowHeight
            - geometryBeforeRollback.rowHeight) <= 1,
        `expected rollback row height ${geometryBeforeRollback.rowHeight}, `
            + `received ${geometryAfterRollback.rowHeight}`
    );
    assert.ok(
        Math.abs(geometryAfterRollback.listHeight
            - geometryBeforeRollback.listHeight) <= 1,
        `expected rollback list height ${geometryBeforeRollback.listHeight}, `
            + `received ${geometryAfterRollback.listHeight}`
    );
    assert.ok(
        Math.abs(geometryAfterRollback.collapsedRowHeight
            - geometryBeforeRollback.collapsedRowHeight) <= 1,
        `expected rollback collapsed row baseline `
            + `${geometryBeforeRollback.collapsedRowHeight}, `
            + `received ${geometryAfterRollback.collapsedRowHeight}`
    );
    assert.ok(
        Math.abs(geometryAfterRollback.collapsedListHeight
            - geometryBeforeRollback.collapsedListHeight) <= 1,
        `expected rollback collapsed list baseline `
            + `${geometryBeforeRollback.collapsedListHeight}, `
            + `received ${geometryAfterRollback.collapsedListHeight}`
    );
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    await postHostMessage(page, outlineResult({
        requestId: 1,
        subscriptionGeneration: 1,
        sourceRevision: 'r3',
        interactions: summaries(18),
    }));
    assert.equal(
        await rolledBack.locator('[data-ai-session-conversation-rail]').evaluate(
            rail => rail.scrollTop
        ),
        restoredScrollTop
    );
    assert.equal(
        await rolledBack.locator('[data-interaction-id="interaction-6"]').evaluate(
            marker => document.activeElement === marker
        ),
        true
    );
    assert.ok(await page.evaluate(
        count => window.__conversationObserverDisconnects > count,
        disconnectsBeforeRollback
    ));

    const disconnectsBeforeMismatch = await page.evaluate(
        () => window.__conversationObserverDisconnects
    );
    await postOpenWorkspacesUpdate(page, {
        semanticRevision: 'changed-current-identity',
        currentSessions: [
            session('codex', 'session-a', false),
            session('kimi', 'session-b', true),
        ],
        navigationSessions: [
            session('codex', 'session-a', true),
        ],
    });
    assert.equal(
        await page.locator(
            '.workspace-card[data-current-workspace] [data-conversation-expanded]'
        ).count(),
        0
    );
    assert.equal(
        await page.locator(
            '.workspace-card[data-other-workspace] [data-conversation-expanded]'
        ).count(),
        0
    );
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'cancel-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.deepEqual(await page.evaluate(() => ({
        expandedKey: expandedActiveAiSessionConversationKey,
        observer: activeAiSessionConversationResizeObserver,
        mutationObserver: activeAiSessionConversationMutationObserver,
        disconnects: window.__conversationObserverDisconnects,
    })), {
        expandedKey: null,
        observer: null,
        mutationObserver: null,
        disconnects: disconnectsBeforeMismatch + 1,
    });
});

test('ACTIVE-SESSION-CONVERSATION-FOCUS-001 restores ACTIVE and the exact marker then the same-row header without focusing another session', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    const request = (await conversationMessages(page)).at(-1);
    await postHostMessage(page, outlineResult({
        requestId: request.requestId,
        subscriptionGeneration: request.subscriptionGeneration,
        interactions: [
            summary('interaction-0', 1, 'First'),
            summary('interaction-1', 2, 'Second'),
        ],
    }));
    const activeTab = page.locator('[data-ai-session-tab="active"]');
    const sessionsTab = page.locator('[data-ai-session-tab="sessions"]');
    await sessionsTab.click();
    assert.equal(await sessionsTab.getAttribute('aria-selected'), 'true');
    assert.equal(
        await focused.getAttribute('data-conversation-expanded'),
        ''
    );

    await postHostMessage(page, focusOrigin());
    assert.equal(await activeTab.getAttribute('aria-selected'), 'true');
    assert.equal(
        await focused.locator('[data-interaction-id="interaction-1"]')
            .evaluate(marker => document.activeElement === marker),
        true
    );

    await postHostMessage(page, focusOrigin({
        interactionId: 'opaque-missing-interaction',
    }));
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
    const page = await openConversationPage(t, [
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

async function expectClosed(card, header, panel, expectsShell) {
    assert.equal(await card.getAttribute('data-conversation-expanded'), null);
    if (expectsShell) {
        assert.equal(await header.getAttribute('aria-expanded'), 'false');
        assert.equal(await panel.getAttribute('hidden'), '');
    } else {
        assert.equal(await header.getAttribute('aria-expanded'), null);
        assert.equal(await panel.count(), 0);
    }
}

async function assertExpanded(card, header, panel) {
    assert.notEqual(await card.getAttribute('data-conversation-expanded'), null);
    assert.equal(await header.getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.isVisible(), true);
}
