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
const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const styles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);

let browser;

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

function projectMarkup(activeAiSessions, markerCount = 0) {
    return `<div class="project workspace-card" data-id="project-a" data-current-workspace
        data-codex-expanded
        data-workspace-scope-identity="scope-project-a"
        data-workspace-navigation-identity="navigation-project-a"
        style="--steward-ai-session-list-max-height: 130px">
        ${sessionSurfaceMarkup(activeAiSessions, markerCount)}
    </div>`;
}

function navigationProjectMarkup(activeAiSessions) {
    return `<div class="project workspace-card" data-id="project-a" data-other-workspace
        data-codex-expanded
        data-workspace-navigation-identity="navigation-other"
        style="--steward-ai-session-list-max-height: 130px">
        ${sessionSurfaceMarkup(activeAiSessions)}
    </div>`;
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
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
        window.__setStateCalls.length = 0;
    });
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
                marker.type = 'button';
                marker.setAttribute('data-ai-session-conversation-marker', '');
                marker.setAttribute('data-interaction-id', `interaction-${index}`);
                marker.textContent = `Input ${index + 1}`;
                marker.style.display = 'block';
                marker.style.width = '100%';
                marker.style.minHeight = '24px';
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
    const navigationMarkup = options.navigationSessions
        ? `<div class="open-other-windows-group" data-other-windows-status="ready">
            ${navigationProjectMarkup(options.navigationSessions)}
        </div>`
        : '';
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
    await seedConversationRail(page, 'codex', 'session-a');
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
    assert.ok(spaciousRail.clientHeight > 0);
    assert.equal(spaciousRail.clientHeight, spaciousRail.scrollHeight);
    assert.equal(spaciousRail.firstMarkerVisible, true);
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
        const marker = node.querySelector('[data-ai-session-conversation-marker]');
        const railRect = node.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        return {
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            markerVisible: markerRect.top >= railRect.top
                && markerRect.bottom <= railRect.bottom,
        };
    });
    assert.ok(constrainedRail.clientHeight >= 72);
    assert.ok(constrainedRail.clientHeight < constrainedRail.scrollHeight);
    assert.equal(constrainedRail.overflowY, 'auto');
    assert.equal(constrainedRail.markerVisible, true);
    assert.equal(await conversationPanel.evaluate(node =>
        getComputedStyle(node).overflowY !== 'auto'
    ), true);
    assert.equal(await list.evaluate(node => getComputedStyle(node).overflowY), 'auto');

    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await isFullyInsideViewport(page, conversationPanel), true);
    assert.deepEqual(await conversationRail.evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    })), {
        clientHeight: spaciousRail.scrollHeight,
        scrollHeight: spaciousRail.scrollHeight,
    });

    await conversationRail.evaluate(node => {
        Array.from(node.querySelectorAll(
            '[data-ai-session-conversation-marker]'
        )).slice(1).forEach(marker => marker.remove());
    });
    await page.waitForTimeout(100);
    assert.deepEqual(await conversationRail.evaluate(node => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    })), {
        clientHeight: 24,
        scrollHeight: 24,
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

test('ACTIVE-SESSION-CONVERSATION-RESTORE-001 restores only the same still-focused identity and otherwise sends a newer exact cancel', async t => {
    const page = await openConversationPage(t, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ]);
    const focused = row(page, 'codex', 'session-a');
    await focused.locator('.ai-session-primary-action').click();
    await seedConversationRail(page, 'codex', 'session-a');
    await page.setViewportSize({ width: 360, height: 260 });
    await page.waitForFunction(() => {
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

    await postWorkspaceUpdate(page, [
        session('codex', 'session-a', true),
        session('kimi', 'session-b', false),
    ], 18);
    const restored = row(page, 'codex', 'session-a');
    await assertExpanded(
        restored,
        restored.locator('.ai-session-primary-action'),
        restored.locator('[data-ai-session-conversation-panel]')
    );
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
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
        requestId: 3,
        subscriptionGeneration: 3,
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
    await seedConversationRail(page, 'codex', 'session-a');
    await page.setViewportSize({ width: 360, height: 260 });
    await page.waitForFunction(() => {
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
        markerCount: 18,
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
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
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
    assert.deepEqual((await conversationMessages(page)).at(-1), {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 3,
        subscriptionGeneration: 3,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
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
        requestId: 4,
        subscriptionGeneration: 4,
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
