'use strict';

// Covers OPEN-WINDOW-SWITCHER-UI-001 (window-switcher rows: slot structure,
// aria model, zero-displacement state transitions) and the webview half of
// OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 (pending lifecycle: request, settle,
// stale/duplicate receipts, supersede, timeout, retry, reconcile after DOM
// replacement).
//
// PR-A scope: the renderer output and the navigation pending manager are
// exercised here against a synthetic document; the production DOM switch
// lands in PR-B.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

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
        { running: '●2', attention: '⚠1', runningAria: '2 sessions running in this window', attentionAria: '1 sessions need attention in this window' },
        { running: '●1', attention: '', runningAria: '1 sessions running in this window', attentionAria: 'Nothing needs attention' },
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
