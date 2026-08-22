'use strict';

// Covers OPEN-WINDOW-SWITCHER-UI-001 (window-switcher rows: slot structure,
// aria model, zero-displacement state transitions) and the webview half of
// OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 (pending lifecycle: request, settle,
// stale/duplicate receipts, supersede, timeout, retry, reconcile after DOM
// replacement).
//
// PR-A scope: the renderer output and the navigation pending manager are
// exercised against a synthetic document. PR-B adds the production-DOM
// end-to-end: the real getStewardContent OPEN tab, the assembled production
// script set, v4 open-workspaces-updated application, and row click routing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

const {
    buildOpenWindowRowViewModels,
} = require('../../out/openWorkspaces/windowRowViewModel');
const {
    getOpenWindowSwitcherGroupContent,
} = require('../../out/webview/webviewWindowSwitcherContent');

const navigationScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewOpenWindowNavigationScripts.js'),
    'utf8'
);
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);

const BROWSER_CONDITION_TIMEOUT_MS = 5_000;

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function makeCard(id, kind, overrides = {}) {
    return {
        id,
        kind,
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: `identity-${id}`,
        scopeIdentity: `scope-${id}`,
        name: id,
        environment: 'local',
        environmentLabel: 'Local',
        roots: [{ id: `root-${id}`, name: id, ordinal: 0 }],
        attentionCount: 0,
        ...overrides,
    };
}

function renderSwitcherHtml() {
    const rows = buildOpenWindowRowViewModels([
        makeCard('__currentWorkspace-' + 'a'.repeat(24), 'current', {
            name: 'alpha', runningSessionCount: 2, attentionCount: 1, pinned: true,
        }),
        makeCard('__openWorkspaceNavigation-' + 'b'.repeat(24), 'navigation', {
            name: 'beta', runningSessionCount: 1,
        }),
        makeCard('__openWorkspaceNavigation-' + 'c'.repeat(24), 'navigation', {
            name: 'gamma',
        }),
    ]);
    return getOpenWindowSwitcherGroupContent(rows, 'ready');
}

async function openSwitcherPage(t, { width = 360 } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(
        `<!DOCTYPE html><html><head><style>${dashboardStyles}</style></head><body>${renderSwitcherHtml()}</body></html>`,
        { waitUntil: 'load' },
    );
    await page.evaluate(source => {
        window.__postedMessages = [];
        window.vscode = {
            _state: {},
            getState() { return this._state; },
            setState(next) { this._state = next; },
            postMessage(message) { window.__postedMessages.push(message); return true; },
        };
        eval(source);
    }, navigationScript);
    return page;
}

test('OPEN-WINDOW-SWITCHER-UI-001 renders single-line rows with the aria model', async t => {
    const page = await openSwitcherPage(t);
    const structure = await page.evaluate(() => {
        const group = document.querySelector('[data-group-id="open-window-switcher"]');
        const rows = Array.from(document.querySelectorAll('[data-open-window-row]'));
        return {
            groupRole: group.getAttribute('role'),
            rowCount: rows.length,
            rowRoles: rows.map(row => row.getAttribute('role')),
            current: (() => {
                const current = rows[0];
                const main = current.querySelector('[data-action="focus-open-window"]');
                return {
                    ariaCurrent: main.getAttribute('aria-current'),
                    ariaDisabled: main.getAttribute('aria-disabled'),
                    ariaLabel: main.getAttribute('aria-label'),
                    title: main.getAttribute('title'),
                };
            })(),
            navigation: (() => {
                const nav = rows[1];
                const main = nav.querySelector('[data-action="focus-open-window"]');
                return {
                    ariaCurrent: main.getAttribute('aria-current'),
                    ariaDisabled: main.getAttribute('aria-disabled'),
                    title: main.getAttribute('title'),
                };
            })(),
            counts: rows.map(row => ({
                running: row.querySelector('.open-window-running').textContent,
                attention: row.querySelector('.open-window-attention').textContent,
                runningAria: row.querySelector('.open-window-running').getAttribute('aria-label'),
                attentionAria: row.querySelector('.open-window-attention').getAttribute('aria-label'),
            })),
            pinPressed: rows.map(row => row.querySelector('[data-action="toggle-open-workspace-pin"]').getAttribute('aria-pressed')),
            moreHaspopup: rows.map(row => row.querySelector('[data-action="open-window-menu"]').getAttribute('aria-haspopup')),
        };
    });
    assert.equal(structure.groupRole, 'list');
    assert.equal(structure.rowCount, 3);
    assert.deepEqual(structure.rowRoles, ['listitem', 'listitem', 'listitem']);
    assert.equal(structure.current.ariaCurrent, 'true');
    assert.equal(structure.current.ariaDisabled, 'true');
    assert.equal(structure.current.ariaLabel, 'Current window: alpha');
    assert.match(structure.current.title, /^Current window: alpha/);
    assert.equal(structure.navigation.ariaCurrent, null);
    assert.equal(structure.navigation.ariaDisabled, null);
    assert.match(structure.navigation.title, /^Focus window: beta/);
    // 运行/待处理为 0 时留空但保留槽位（含 aria-label）。
    assert.deepEqual(structure.counts, [
        { running: '●2', attention: '⚠1', runningAria: '2 sessions running in this window', attentionAria: '1 session needs attention in this window' },
        { running: '●1', attention: '', runningAria: '1 session running in this window', attentionAria: 'Nothing needs attention' },
        { running: '', attention: '', runningAria: 'No running sessions', attentionAria: 'Nothing needs attention' },
    ]);
    assert.deepEqual(structure.pinPressed, ['true', 'false', 'false']);
    assert.deepEqual(structure.moreHaspopup, ['menu', 'menu', 'menu']);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 webview pending lifecycle', async t => {
    const page = await openSwitcherPage(t);
    const cardId = '__openWorkspaceNavigation-' + 'b'.repeat(24);

    // request posts the versioned message and marks the row pending
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.request(id);
    }, cardId);
    let snapshot = await page.evaluate(id => ({
        posted: window.__postedMessages.slice(),
        state: document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-state'),
        pending: window.__agentPivotOpenWindowNavigation.isPending(id),
    }), cardId);
    assert.equal(snapshot.posted.length, 1);
    assert.deepEqual(snapshot.posted[0], {
        type: 'open-window-navigation-request', version: 1, requestId: 1, cardId,
    });
    assert.equal(snapshot.state, 'pending');
    assert.equal(snapshot.pending, true);

    // stale receipt (wrong requestId) is ignored
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 99, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.equal(await page.evaluate(id => window.__agentPivotOpenWindowNavigation.isPending(id), cardId), true);

    // malformed receipt is rejected
    assert.equal(await page.evaluate(id => window.__agentPivotOpenWindowNavigation.complete({
        type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id,
    }), cardId), false);

    // focused settlement clears pending
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'focused',
        });
    }, cardId);
    snapshot = await page.evaluate(id => ({
        state: document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-state'),
        pending: window.__agentPivotOpenWindowNavigation.isPending(id),
    }), cardId);
    assert.equal(snapshot.state, null);
    assert.equal(snapshot.pending, false);

    // duplicate settlement after resolution is ignored
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'failed',
        });
    }, cardId);
    assert.equal(await page.evaluate(id =>
        document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-state'), cardId), null);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 failure shows inline error and retry issues a fresh requestId', async t => {
    const page = await openSwitcherPage(t);
    const cardId = '__openWorkspaceNavigation-' + 'b'.repeat(24);

    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.request(id), cardId);
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'failed',
        });
    }, cardId);
    const errorState = await page.evaluate(id => {
        const row = document.querySelector(`[data-open-window-row][data-id="${id}"]`);
        return {
            state: row.getAttribute('data-navigation-state'),
            outcome: row.getAttribute('data-navigation-outcome'),
            retryHidden: row.querySelector('[data-action="retry-open-window-navigation"]').hidden,
        };
    }, cardId);
    assert.equal(errorState.state, 'error');
    assert.equal(errorState.outcome, 'failed');
    assert.equal(errorState.retryHidden, false);

    // retry issues a new requestId and returns to pending
    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.retry(id), cardId);
    const afterRetry = await page.evaluate(id => ({
        postedCount: window.__postedMessages.length,
        lastRequestId: window.__postedMessages[window.__postedMessages.length - 1].requestId,
        state: document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-state'),
        retryHidden: document.querySelector(`[data-open-window-row][data-id="${id}"] [data-action="retry-open-window-navigation"]`).hidden,
    }), cardId);
    assert.equal(afterRetry.postedCount, 2);
    assert.equal(afterRetry.lastRequestId, 2);
    assert.equal(afterRetry.state, 'pending');
    assert.equal(afterRetry.retryHidden, true);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 consecutive clicks supersede and timeout fails the row', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(
        `<!DOCTYPE html><html><head><style>${dashboardStyles}</style></head><body>${renderSwitcherHtml()}</body></html>`,
        { waitUntil: 'load' },
    );
    const cardId = '__openWorkspaceNavigation-' + 'b'.repeat(24);
    await page.evaluate(source => {
        window.__postedMessages = [];
        window.__timeoutCallbacks = [];
        const originalSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, ms) => {
            window.__timeoutCallbacks.push(callback);
            return window.__timeoutCallbacks.length;
        };
        window.__originalSetTimeout = originalSetTimeout;
        window.vscode = {
            postMessage(message) { window.__postedMessages.push(message); return true; },
        };
        eval(source);
    }, navigationScript);

    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.request(id);
        window.__agentPivotOpenWindowNavigation.request(id);
    }, cardId);
    assert.equal((await page.evaluate(() => window.__postedMessages)).length, 2);
    assert.equal(await page.evaluate(() => window.__timeoutCallbacks.length), 2);

    // settlement for the superseded request is ignored
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.equal(await page.evaluate(id => window.__agentPivotOpenWindowNavigation.isPending(id), cardId), true);

    // fire the live timeout: the row settles into the error state
    await page.evaluate(() => {
        window.__timeoutCallbacks[1]();
    });
    const state = await page.evaluate(id => ({
        state: document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-state'),
        outcome: document.querySelector(`[data-open-window-row][data-id="${id}"]`).getAttribute('data-navigation-outcome'),
        retryHidden: document.querySelector(`[data-open-window-row][data-id="${id}"] [data-action="retry-open-window-navigation"]`).hidden,
        pending: window.__agentPivotOpenWindowNavigation.isPending(id),
    }), cardId);
    assert.equal(state.state, 'error');
    assert.equal(state.outcome, 'failed');
    assert.equal(state.retryHidden, false);
    assert.equal(state.pending, false);
});

test('OPEN-WINDOW-SWITCHER-UI-001 state transitions do not shift row geometry', async t => {
    const page = await openSwitcherPage(t);
    const cardId = '__openWorkspaceNavigation-' + 'b'.repeat(24);
    const rowTops = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]'))
            .map(row => row.getBoundingClientRect().top)
    );
    const before = await rowTops();
    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.request(id), cardId);
    const pending = await rowTops();
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'failed',
        });
    }, cardId);
    const error = await rowTops();
    assert.deepEqual(pending, before);
    assert.deepEqual(error, before);
});

test('OPEN-WINDOW-SWITCHER-UI-001 reconcile replays pending and error after DOM replacement', async t => {
    const page = await openSwitcherPage(t);
    const pendingId = '__openWorkspaceNavigation-' + 'b'.repeat(24);
    const errorId = '__openWorkspaceNavigation-' + 'c'.repeat(24);

    await page.evaluate(({ pendingId, errorId }) => {
        window.__agentPivotOpenWindowNavigation.request(pendingId);
        window.__agentPivotOpenWindowNavigation.request(errorId);
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 2, cardId: errorId, outcome: 'stale-target',
        });
    }, { pendingId, errorId });

    // Simulate an authoritative innerHTML replacement: rebuild rows fresh.
    await page.evaluate(html => {
        document.querySelector('body').innerHTML = html;
    }, renderSwitcherHtml());
    let states = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]'))
            .map(row => row.getAttribute('data-navigation-state'))
    );
    assert.deepEqual(states, [null, null, null]);

    await page.evaluate(() => window.__agentPivotOpenWindowNavigation.reconcile(document));
    states = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]'))
            .map(row => ({
                state: row.getAttribute('data-navigation-state'),
                outcome: row.getAttribute('data-navigation-outcome'),
            }))
    );
    assert.deepEqual(states, [
        { state: null, outcome: null },
        { state: 'pending', outcome: null },
        { state: 'error', outcome: 'stale-target' },
    ]);
});

test('OPEN-WINDOW-SWITCHER-UI-001 responsive width matrix hides slots without shifting rows', async t => {
    const wide = await openSwitcherPage(t, { width: 400 });
    const narrow = await openSwitcherPage(t, { width: 240 });
    const widePinVisible = await wide.evaluate(() => {
        const row = document.querySelectorAll('[data-open-window-row]')[1];
        return getComputedStyle(row.querySelector('[data-action="toggle-open-workspace-pin"]')).display !== 'none';
    });
    const narrowPinVisible = await narrow.evaluate(() => {
        const row = document.querySelectorAll('[data-open-window-row]')[1];
        return getComputedStyle(row.querySelector('[data-action="toggle-open-workspace-pin"]')).display !== 'none';
    });
    // ≥360px：未 pin 的 ★ 在 DOM 中（hover 显示）；<280px：未 pin 的 ★ 不渲染。
    assert.equal(widePinVisible, true);
    assert.equal(narrowPinVisible, false);
});

// --- production OPEN tab end-to-end (PR-B) ---------------------------------

function loadWithFakeVscode(requestPath) {
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
        return require(requestPath);
    } finally {
        Module._load = previousLoad;
    }
}

const productionContent = loadWithFakeVscode('../../out/webview/webviewContent');
const productionUpdateMessages = loadWithFakeVscode('../../out/dashboard/webviewUpdateMessages');

// Same script set (and order) as scripts/build-dashboard-webview-bundle.js.
const productionScriptNames = [
    'webviewScrollStateScripts.js',
    'webviewAiSessionViewStateScripts.js',
    'webviewWorkspaceUpdateScripts.js',
    'webviewProjectCollapseScripts.js',
    'webviewOpenWindowNavigationScripts.js',
    'webviewProjectContextMenuScripts.js',
    'webviewProjectAiUpdateScripts.js',
    'webviewGroupFormScripts.js',
    'webviewProjectAiSessionControlsScripts.js',
    'webviewProjectScripts.js',
];

function productionOpenTabDocument(cards, otherWindowsStatus = 'ready') {
    return productionContent.getStewardContent(
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
        otherWindowsStatus,
        2,
    )
        .replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')
        .replace(/<link[^>]*rel="stylesheet"[^>]*>/, '')
        .replace(/<script(?![^>]*type="application\/json")[\s\S]*?<\/script>/g, '')
        .replace('</head>', `<style>${dashboardStyles}</style></head>`)
        .replace('class="dashboard-styles-pending"', '');
}

async function openProductionOpenTabPage(t, cards, otherWindowsStatus = 'ready') {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(productionOpenTabDocument(cards, otherWindowsStatus), { waitUntil: 'load' });
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            _state: {},
            getState() { return this._state; },
            setState(next) { this._state = next; },
            postMessage(message) { window.__postedMessages.push(message); return true; },
        };
    });
    for (const name of productionScriptNames) {
        await page.addScriptTag({
            content: fs.readFileSync(path.join(__dirname, '../../src/webview', name), 'utf8'),
        });
    }
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

test('OPEN-WINDOW-SWITCHER-UI-001 production OPEN tab routes row clicks and keeps row geometry across a v4 window-switch refresh', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', {
        name: 'alpha',
    });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', {
        name: 'beta',
    });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);

    const rowTops = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]'))
            .map(row => Math.round(row.getBoundingClientRect().top))
    );
    const before = await rowTops();
    assert.equal(before.length, 2, 'the production document renders one row per window');
    assert.equal(await page.locator('[data-group-id="open-window-switcher"]').count(), 1);
    assert.equal(await page.locator('.open-other-windows-group').count(), 0,
        'the retired other-windows group must not render');

    // Clicking a non-current row posts the versioned navigation request.
    const navigationRow = page.locator('[data-open-window-row][data-window-kind="navigation"]');
    await navigationRow.locator('[data-action="focus-open-window"]').click();
    let posted = await page.evaluate(() => window.__postedMessages);
    let requests = posted.filter(message => message.type === 'open-window-navigation-request');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
        type: 'open-window-navigation-request',
        version: 1,
        requestId: 1,
        cardId: navigationCard.id,
    });
    assert.equal(await navigationRow.getAttribute('data-navigation-state'), 'pending');

    // Clicking the current row is inert: no navigation request is posted.
    // (force: the button is aria-disabled, which is exactly the inertness
    // being asserted, so bypass Playwright's enabled check.)
    await page.locator('[data-open-window-row][data-window-kind="current"] [data-action="focus-open-window"]')
        .click({ force: true });
    posted = await page.evaluate(() => window.__postedMessages);
    requests = posted.filter(message => message.type === 'open-window-navigation-request');
    assert.equal(requests.length, 1, 'the current row must not post navigation requests');

    // An authoritative v4 refresh (e.g. the owning window switched and
    // attention changed) replaces the wrapper without displacing the rows.
    const html = productionContent.getOpenWorkspacesGroupContent(
        [currentCard, { ...navigationCard, attentionCount: 2 }],
        'ready',
    );
    await page.evaluate(message => {
        window.dispatchEvent(new MessageEvent('message', { data: message }));
    }, {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: 'production-window-switch-1',
        projectionRevision: 1,
        windowRowCount: 2,
        currentWindowRowCount: 1,
        navigationWindowRowCount: 1,
        currentDetailCount: 1,
        otherWindowsStatus: 'ready',
        html,
        searchCatalog: {
            version: 3,
            sessions: [],
            worktrees: [],
            openWorkspaces: [{ identity: 'alpha' }, { identity: 'beta' }],
            savedProjects: [], todos: [],
        },
        presentation: {
            type: 'ai-session-presentation-state',
            version: 1,
            projectionRevision: 1,
            workspaceScopeIdentity: currentCard.scopeIdentity,
            workspaceNavigationIdentity: currentCard.navigationIdentity,
            attentionCount: 0,
            activeAttentionCount: 0,
            runningSessionCount: 0,
            runningCardAnimation: 'current',
            runningIconAnimation: 'current',
            revealFocused: false,
            focusedTarget: null,
            attentionSessions: [],
            sessions: [],
        },
    });

    assert.deepEqual(await rowTops(), before,
        'the window-switch refresh must not displace the switcher rows');
    assert.equal(await navigationRow.getAttribute('data-navigation-state'), 'pending',
        'reconcile replays the pending navigation state after the replacement');
    assert.equal(
        await navigationRow.locator('.open-window-attention').textContent(),
        '⚠2',
        'the refreshed row adopts the authoritative attention count',
    );

    posted = await page.evaluate(() => window.__postedMessages);
    const receipt = posted.find(message => message.type === 'open-workspaces-rendered');
    assert.ok(receipt, 'the v3 rendered receipt is posted after the v4 update');
    assert.deepEqual(receipt, {
        type: 'open-workspaces-rendered',
        version: 3,
        semanticRevision: 'production-window-switch-1',
        windowRowCount: 2,
        currentWindowRowCount: 1,
        navigationWindowRowCount: 1,
        currentDetailCount: 1,
        hasWindowSwitcher: true,
        otherWindowsStatus: 'ready',
    });

    // Settle the pending navigation so no timer outlives the page.
    await page.evaluate(cardId => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result',
            version: 1,
            requestId: 1,
            cardId,
            outcome: 'focused',
        });
    }, navigationCard.id);
    assert.equal(await navigationRow.getAttribute('data-navigation-state'), null);
});

test('OPEN-WINDOW-SWITCHER-UI-001 arrow keys move focus between rows and the more menu opens with keyboard dismissal', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);

    // Arrow keys move focus between the row focus buttons.
    await page.locator('[data-open-window-row][data-window-kind="current"] [data-action="focus-open-window"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'focus-open-window');
    assert.equal(await page.evaluate(() =>
        document.activeElement?.closest('[data-open-window-row]')?.getAttribute('data-window-kind')), 'navigation');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() =>
        document.activeElement?.closest('[data-open-window-row]')?.getAttribute('data-window-kind')), 'current');

    // The more menu opens from the ⋯ button, Escape closes it and focus returns.
    const moreButton = page.locator('[data-open-window-row][data-window-kind="navigation"] [data-action="open-window-menu"]');
    await moreButton.click();
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 1);
    assert.equal(await page.evaluate(() =>
        document.querySelector('#openWindowMenu [data-open-window-menu-non-current]')?.hidden), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'open-window-menu');

    // Menu Focus Window on a navigation row issues a navigation request.
    await moreButton.click();
    await page.keyboard.press('Enter');
    const posted = await page.evaluate(() => window.__postedMessages);
    assert.ok(posted.some(message => message.type === 'open-window-navigation-request'),
        'the menu Focus Window item drives the navigation protocol');
});

test('OPEN-WINDOW-SWITCHER-UI-001 bridge-not-ready disables non-current rows and hides their menu Focus item', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard], 'connecting');
    const navigationRow = page.locator('[data-open-window-row][data-window-kind="navigation"]');
    assert.equal(await navigationRow.getAttribute('data-navigation-disabled'), 'true');
    assert.match(await navigationRow.getAttribute('class') || '', /open-window-row-disabled/);

    // Clicking a disabled row must not post a navigation request.
    await navigationRow.locator('[data-action="focus-open-window"]').click({ force: true });
    const posted = await page.evaluate(() => window.__postedMessages);
    assert.equal(posted.filter(message => message.type === 'open-window-navigation-request').length, 0);

    // The menu opens but the Focus Window item is hidden for disabled rows.
    await navigationRow.locator('[data-action="open-window-menu"]').click();
    assert.equal(await page.evaluate(() =>
        document.querySelector('#openWindowMenu [data-open-window-menu-non-current]')?.hidden), true);
    await page.keyboard.press('Escape');

    // The connecting status renders in the fixed switcher slot.
    assert.match(await page.locator('[data-open-window-switcher-status]').textContent() || '',
        /Looking for your other open windows/);
    // The current row stays on top while the bridge is not ready.
    assert.equal(await page.locator('[data-open-window-row]').first().getAttribute('data-window-kind'), 'current');
});


// --- review follow-ups -------------------------------------------------------

function makeSwitcherPresentation(projectionRevision, overrides = {}) {
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision,
        workspaceScopeIdentity: null,
        workspaceNavigationIdentity: null,
        attentionCount: 0,
        activeAttentionCount: 0,
        runningSessionCount: 0,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: null,
        attentionSessions: [],
        sessions: [],
        ...overrides,
    };
}

function makeSwitcherCatalog(cards) {
    return {
        version: 3,
        sessions: [],
        worktrees: [],
        openWorkspaces: cards.map(card => ({ identity: card.navigationIdentity })),
        savedProjects: [], todos: [],
    };
}

// Dispatches an authoritative v4 open-workspaces update whose counts and html
// are derived from the given cards (the same shape the host posts).
async function postOpenWorkspacesUpdate(page, cards, otherWindowsStatus, revision) {
    const html = productionContent.getOpenWorkspacesGroupContent(cards, otherWindowsStatus);
    const current = cards.find(card => card.kind === 'current') || null;
    const navigationRowCount = cards.filter(card => card.kind === 'navigation').length;
    await page.evaluate(message => {
        window.dispatchEvent(new MessageEvent('message', { data: message }));
    }, {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: `review-followup-${revision}`,
        projectionRevision: revision,
        windowRowCount: (current ? 1 : 0) + navigationRowCount,
        currentWindowRowCount: current ? 1 : 0,
        navigationWindowRowCount: navigationRowCount,
        currentDetailCount: current && current.roots.length > 0 ? 1 : 0,
        otherWindowsStatus,
        html,
        searchCatalog: makeSwitcherCatalog(cards),
        presentation: makeSwitcherPresentation(
            revision,
            current && current.roots.length > 0
                ? {
                    workspaceScopeIdentity: current.scopeIdentity,
                    workspaceNavigationIdentity: current.navigationIdentity,
                }
                : {},
        ),
    });
}

test('OPEN-WINDOW-SWITCHER-UI-001 empty window accepts incremental ai-sessions updates without a full refresh', async t => {
    const emptyCard = makeCard('__currentWorkspace-empty', 'current', {
        name: 'This Window',
        roots: [],
        canPin: false,
    });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [emptyCard, navigationCard]);

    // The host builder must not declare an unrenderable current card: the
    // webview filters zero-root cards, so declaring one splits declared 1 vs
    // rendered 0 and the consistency guard force-refreshes every update.
    const message = productionUpdateMessages.buildAiSessionsUpdatedMessage({
        groups: [],
        cards: [emptyCard, navigationCard],
        sequence: 42,
        generatedAt: '2026-08-22T00:00:00.000Z',
        presentation: makeSwitcherPresentation(42),
    });
    assert.equal(message.currentWorkspaceCount, 0,
        'the zero-root (empty-window) current card is not renderable and must not be declared');
    assert.ok(!message.html.includes('data-current-workspace'),
        'the empty window renders the empty state instead of a workspace card');

    await page.evaluate(update => {
        window.dispatchEvent(new MessageEvent('message', { data: update }));
    }, message);

    const posted = await page.evaluate(() => window.__postedMessages);
    assert.equal(
        posted.filter(postedMessage => postedMessage.type === 'request-full-refresh').length,
        0,
        'an empty-window incremental update must not trip the workspace consistency guard',
    );
    assert.equal(await page.locator('.open-current-workspace-group .open-current-workspace-empty').count(), 1,
        'the empty state stays rendered after the incremental update');
});

test('OPEN-WINDOW-SWITCHER-UI-001 bridge status transitions keep the switcher geometry constant', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);

    const measure = () => page.evaluate(() => {
        const group = document.querySelector('[data-group-id="open-window-switcher"]');
        const status = group.querySelector('[data-open-window-switcher-status]');
        const list = group.querySelector('[data-open-window-switcher-list]');
        return {
            groupHeight: group.getBoundingClientRect().height,
            statusHeight: status.getBoundingClientRect().height,
            listTop: list.getBoundingClientRect().top,
            rowTops: Array.from(list.querySelectorAll('[data-open-window-row]'))
                .map(row => row.getBoundingClientRect().top),
        };
    });

    const ready = await measure();
    assert.ok(ready.statusHeight > 0,
        'the status slot stays reserved while the bridge is ready (fixed slot, zero displacement)');
    assert.equal(ready.rowTops.length, 2);

    let revision = 10;
    for (const status of ['connecting', 'unavailable', 'update-required', 'ready']) {
        await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], status, ++revision);
        const next = await measure();
        assert.deepEqual(next, ready,
            `bridge status "${status}" must not shift the switcher geometry`);
    }
    // The status text still renders inside the fixed slot.
    await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], 'connecting', ++revision);
    assert.match(await page.locator('[data-open-window-switcher-status]').textContent() || '',
        /Looking for your other open windows/);
});

test('OPEN-WINDOW-SWITCHER-UI-001 v4 replacement restores focus to the same row control', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);
    const navigationRow = `[data-open-window-row][data-id="${navigationCard.id}"]`;

    const assertFocusRestored = async (action, revision) => {
        await page.locator(`${navigationRow} [data-action="${action}"]`).focus();
        await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], 'ready', revision);
        const focused = await page.evaluate(() => ({
            action: document.activeElement?.getAttribute('data-action'),
            cardId: document.activeElement?.closest('[data-open-window-row]')?.getAttribute('data-id'),
        }));
        assert.deepEqual(focused, { action, cardId: navigationCard.id },
            `the ${action} control keeps focus across the authoritative replacement`);
    };

    await assertFocusRestored('focus-open-window', 21);
    await assertFocusRestored('open-window-menu', 22);
    await assertFocusRestored('toggle-open-workspace-pin', 23);

    // Retry: error the row, focus its retry control, then replace — the
    // navigation reconcile must re-unhide retry before the focus restore.
    await page.evaluate(cardId => {
        window.__agentPivotOpenWindowNavigation.request(cardId);
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result',
            version: 1,
            requestId: 1,
            cardId,
            outcome: 'failed',
        });
    }, navigationCard.id);
    await assertFocusRestored('retry-open-window-navigation', 24);
});

test('OPEN-WINDOW-SWITCHER-UI-001 outside-click menu close does not steal focus back to the trigger', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);

    const moreButton = page.locator('[data-open-window-row][data-window-kind="navigation"] [data-action="open-window-menu"]');
    await moreButton.click();
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 1);

    // Clicking elsewhere dismisses the menu; focus follows the click, not the trigger.
    await page.locator('[data-group-id="open-window-switcher"] .group-title-text').first().click();
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 0);
    const activeAction = await page.evaluate(() => document.activeElement?.getAttribute('data-action'));
    assert.notEqual(activeAction, 'open-window-menu',
        'outside-click dismissal must not yank focus back to the ⋯ trigger');

    // Escape still returns focus to the trigger (keyboard dismissal contract).
    await moreButton.click();
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'open-window-menu',
        'Escape dismissal still returns focus to the ⋯ trigger');
});

test('OPEN-WINDOW-SWITCHER-UI-001 empty window row renders no pin entry points', async t => {
    const emptyCard = makeCard('__currentWorkspace-empty', 'current', {
        name: 'This Window',
        roots: [],
        canPin: false,
    });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [emptyCard, navigationCard]);

    const emptyRow = page.locator('[data-open-window-row][data-id="__currentWorkspace-empty"]');
    assert.equal(await emptyRow.getAttribute('data-can-pin'), 'false');
    assert.equal(await emptyRow.locator('[data-action="toggle-open-workspace-pin"]').count(), 0,
        'the empty window must not offer a pin the host protocol rejects');
    assert.equal(
        await page.locator('[data-open-window-row][data-window-kind="navigation"] [data-action="toggle-open-workspace-pin"]').count(),
        1,
        'regular rows keep their pin button',
    );

    // The ⋯ menu hides the Pin item for the empty row but keeps Save Workspace.
    await emptyRow.locator('[data-action="open-window-menu"]').click();
    assert.equal(await page.evaluate(() =>
        document.querySelector('#openWindowMenu [data-open-window-menu-pin]')?.hidden), true);
    assert.equal(await page.evaluate(() =>
        document.querySelector('#openWindowMenu [data-open-window-menu-current]')?.hidden), false);
    await page.keyboard.press('Escape');

    // The menu Pin item comes back for pinnable rows.
    await page.locator('[data-open-window-row][data-window-kind="navigation"] [data-action="open-window-menu"]').click();
    assert.equal(await page.evaluate(() =>
        document.querySelector('#openWindowMenu [data-open-window-menu-pin]')?.hidden), false);
    await page.keyboard.press('Escape');
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 a late focused receipt clears the timeout error state', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(
        `<!DOCTYPE html><html><head><style>${dashboardStyles}</style></head><body>${renderSwitcherHtml()}</body></html>`,
        { waitUntil: 'load' },
    );
    const cardId = '__openWorkspaceNavigation-' + 'b'.repeat(24);
    await page.evaluate(source => {
        window.__postedMessages = [];
        window.__timeoutCallbacks = [];
        window.setTimeout = callback => {
            window.__timeoutCallbacks.push(callback);
            return window.__timeoutCallbacks.length;
        };
        window.vscode = {
            postMessage(message) { window.__postedMessages.push(message); return true; },
        };
        eval(source);
    }, navigationScript);

    const rowState = id => page.evaluate(rowId => ({
        state: document.querySelector(`[data-open-window-row][data-id="${rowId}"]`).getAttribute('data-navigation-state'),
        outcome: document.querySelector(`[data-open-window-row][data-id="${rowId}"]`).getAttribute('data-navigation-outcome'),
        retryHidden: document.querySelector(`[data-open-window-row][data-id="${rowId}"] [data-action="retry-open-window-navigation"]`).hidden,
    }), id);

    // The request times out into the error state…
    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.request(id), cardId);
    await page.evaluate(() => window.__timeoutCallbacks[0]());
    assert.deepEqual(await rowState(cardId), { state: 'error', outcome: 'failed', retryHidden: false });

    // …but the host never cancelled the switch: its late focused receipt
    // clears the error instead of being dropped as a stale settlement.
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.deepEqual(await rowState(cardId), { state: null, outcome: null, retryHidden: true });

    // A late receipt that does not match the error's requestId is still ignored.
    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.request(id), cardId);
    await page.evaluate(() => window.__timeoutCallbacks[1]());
    assert.deepEqual(await rowState(cardId), { state: 'error', outcome: 'failed', retryHidden: false });
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 99, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.deepEqual(await rowState(cardId), { state: 'error', outcome: 'failed', retryHidden: false },
        'an unmatched late receipt must not clear the error state');

    // A newer request supersedes the error: its own settlement wins.
    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.request(id), cardId);
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 3, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.deepEqual(await rowState(cardId), { state: null, outcome: null, retryHidden: true });
});

test('OPEN-WINDOW-SWITCHER-UI-001 CHATS view menu: split trigger, keyboard, and dismissal semantics', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', {
        name: 'alpha',
        aiSessions: {
            workspaceScopeIdentity: 'scope-alpha',
            workspaceNavigationIdentity: 'identity-alpha',
            activeProvider: 'codex',
            selectedProviders: ['codex'],
            expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 0 }],
            sessionsByProvider: { codex: [] },
            unavailableProviders: [],
            aiSessionCount: 0,
            attentionCount: 0,
            defaultTab: 'chats',
            activeSessions: [],
            activeSessionCount: 0,
            activeAttentionCount: 0,
            worktrees: [],
        },
    });
    const page = await openProductionOpenTabPage(t, [currentCard]);

    // ▾ 是与 tab 相邻的独立控件（不嵌进 role="tab"），命中区与 aria 契约。
    const trigger = page.locator('[data-action="toggle-chats-view-menu"]');
    assert.equal(await trigger.count(), 1);
    assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    const tabBox = await page.locator('[data-ai-session-tab="chats"]').boundingBox();
    const triggerBox = await trigger.boundingBox();
    assert.ok(tabBox && triggerBox && triggerBox.width >= 24 && triggerBox.height >= 24,
        'the ▾ trigger keeps the >=24px hit area');
    assert.ok(triggerBox.x >= tabBox.x + tabBox.width + 3,
        'the ▾ trigger sits beside the tab with the dead zone');

    // 点击打开：菜单可见、trigger aria-expanded、当前项聚焦。
    await trigger.click();
    const menu = page.locator('[data-chats-view-menu]');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    const treeItem = menu.locator('[role="menuitemradio"][data-view-mode="tree"]');
    assert.equal(await treeItem.getAttribute('aria-checked'), 'true');
    assert.equal(await treeItem.evaluate(node => document.activeElement === node), true);

    // Esc 关闭并把焦点还给触发按钮。
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await trigger.evaluate(node => document.activeElement === node), true,
        'Escape returns focus to the ▾ trigger');

    // 外部点击关闭且不夺焦点。
    await trigger.click();
    assert.equal(await menu.isVisible(), true);
    await page.locator('[data-group-id="open-window-switcher"] .group-title-text').first().click();
    assert.equal(await menu.isVisible(), false);
    assert.equal(await trigger.evaluate(node => document.activeElement === node), false,
        'outside-click dismissal must not yank focus back to the ▾ trigger');

    // 键盘：触发按钮上 ↓ 直接开菜单并聚焦当前项。
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await treeItem.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Escape');
});

test('OPEN-WINDOW-SWITCHER-UI-001 CHATS view menu anchors to the trigger and activates CHATS from ALL', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', {
        name: 'alpha',
        aiSessions: {
            workspaceScopeIdentity: 'scope-alpha',
            workspaceNavigationIdentity: 'identity-alpha',
            activeProvider: 'codex',
            selectedProviders: ['codex'],
            expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 0 }],
            sessionsByProvider: { codex: [] },
            unavailableProviders: [],
            aiSessionCount: 0,
            attentionCount: 0,
            defaultTab: 'chats',
            activeSessions: [],
            activeSessionCount: 0,
            activeAttentionCount: 0,
            worktrees: [],
        },
    });
    const page = await openProductionOpenTabPage(t, [currentCard]);
    const trigger = page.locator('[data-action="toggle-chats-view-menu"]');
    const menu = page.locator('[data-chats-view-menu]');

    // 几何：菜单贴着 trigger 下方（同一相对定位容器），而不是卡片底部。
    await trigger.click();
    const geometry = await page.evaluate(() => {
        const triggerRect = document.querySelector('[data-action="toggle-chats-view-menu"]')
            .getBoundingClientRect();
        const pairRect = document.querySelector('.ai-session-tab-pair').getBoundingClientRect();
        const menuRect = document.querySelector('[data-chats-view-menu]').getBoundingClientRect();
        return {
            triggerBottom: triggerRect.bottom,
            pairLeft: pairRect.left,
            menuTop: menuRect.top,
            menuLeft: menuRect.left,
            menuHeight: menuRect.height,
            menuOffsetParent: document.querySelector('[data-chats-view-menu]').offsetParent?.className || null,
        };
    });
    assert.ok(geometry.menuHeight > 0, 'the menu is laid out');
    assert.ok(Math.abs(geometry.menuTop - geometry.triggerBottom) <= 8,
        `the menu must open right below the trigger, got ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.menuLeft - geometry.pairLeft) <= 2,
        `the split menu left-aligns with the tab pair, got ${JSON.stringify(geometry)}`);
    assert.match(geometry.menuOffsetParent || '', /ai-session-tab-pair/,
        'the menu anchors to the tab pair, not the card');
    await page.keyboard.press('Escape');

    // PRD：非活动 tab 上的 ▾ 点击 = 激活 CHATS 并开菜单（菜单不得随隐藏面板不可见）。
    await page.locator('[data-ai-session-tab="all"]').click();
    await trigger.click();
    assert.equal(await page.locator('[data-ai-session-tab="chats"]').getAttribute('aria-selected'), 'true',
        'the ▾ on an inactive CHATS tab activates CHATS first');
    assert.equal(await menu.isVisible(), true, 'the menu stays visible after activating CHATS');
    const posts = await page.evaluate(() => window.__postedMessages
        .filter(message => message.type === 'select-ai-session-view-tab'));
    assert.equal(posts.at(-1)?.tab, 'chats',
        'the activation persists the CHATS tab host-side');
    await page.keyboard.press('Escape');
});
