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
            showSaveAction: true,
        }),
        makeCard('__openWorkspaceNavigation-' + 'b'.repeat(24), 'navigation', {
            name: 'beta', runningSessionCount: 1, environment: 'ssh', environmentLabel: 'SSH',
        }),
        makeCard('__openWorkspaceNavigation-' + 'c'.repeat(24), 'navigation', {
            name: 'gamma', environment: 'devContainer', environmentLabel: 'Dev Container',
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
                attentionBeforeRunning: Boolean(row.querySelector('.open-window-attention')
                    .compareDocumentPosition(row.querySelector('.open-window-running'))
                    & Node.DOCUMENT_POSITION_FOLLOWING),
            })),
            iconTitles: rows.map(row => row.querySelector('.open-window-icon').getAttribute('title')),
            environmentChipCount: document.querySelectorAll('.open-window-env-chip').length,
            pinPressed: rows.map(row => row.querySelector('[data-action="toggle-open-workspace-pin"]').getAttribute('aria-pressed')),
            moreHaspopup: rows.map(row => row.querySelector('[data-action="open-window-menu"]').getAttribute('aria-haspopup')),
            saveButtons: rows.map(row => {
                const button = row.querySelector('[data-action="save-current-workspace"]');
                return button && { title: button.getAttribute('title'), ariaLabel: button.getAttribute('aria-label') };
            }),
            saveBeforeAttention: (() => {
                const save = rows[0].querySelector('[data-action="save-current-workspace"]');
                const attention = rows[0].querySelector('.open-window-attention');
                return Boolean(save.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING);
            })(),
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
        { running: '●2', attention: '1', runningAria: '2 sessions running in this window', attentionAria: '1 session needs attention in this window', attentionBeforeRunning: true },
        { running: '●1', attention: '', runningAria: '1 session running in this window', attentionAria: 'Nothing needs attention', attentionBeforeRunning: true },
        { running: '', attention: '', runningAria: 'No running sessions', attentionAria: 'Nothing needs attention', attentionBeforeRunning: true },
    ]);
    assert.deepEqual(structure.iconTitles, ['Local Project', 'SSH Project', 'Dev Container Project']);
    assert.equal(structure.environmentChipCount, 0);
    assert.deepEqual(structure.pinPressed, ['true', 'false', 'false']);
    assert.deepEqual(structure.moreHaspopup, ['menu', 'menu', 'menu']);
    assert.deepEqual(structure.saveButtons, [
        { title: 'Save Workspace', ariaLabel: 'Save Workspace' },
        null,
        null,
    ]);
    assert.equal(structure.saveBeforeAttention, true);
});

test('OPEN-WINDOW-SWITCHER-UI-001 saves an unsaved current workspace from its row button', async t => {
    const page = await openSwitcherPage(t);
    await page.locator('[data-open-window-row][data-window-kind="current"] [data-action="save-current-workspace"]').click();
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), [{
        type: 'save-current-workspace',
        projectId: '__currentWorkspace-' + 'a'.repeat(24),
    }]);
});

test('OPEN-WINDOW-SWITCHER-UI-001 keeps window rows quiet by default and reserves emphasis for the current window', async t => {
    const page = await openSwitcherPage(t);
    await page.addStyleTag({ content: `
        :root {
            --vscode-sideBar-background: #181818;
            --vscode-editorWidget-background: #202020;
            --vscode-widget-border: #666;
            --vscode-focusBorder: #6ea8fe;
            --vscode-list-inactiveSelectionBackground: rgba(110, 168, 254, 0.12);
        }
    ` });
    // Let the row surface transitions (120ms) settle before reading computed
    // values: the added tokens change the current row's background.
    await page.waitForTimeout(250);

    const appearance = await page.locator('[data-open-window-row]').nth(1).evaluate(row => {
        const style = getComputedStyle(row);
        return {
            background: style.backgroundColor,
            borderTopWidth: style.borderTopWidth,
            borderTopStyle: style.borderTopStyle,
            borderTopColor: style.borderTopColor,
            boxShadow: style.boxShadow,
            indicator: getComputedStyle(row.querySelector('.open-window-indicator'), '::before').backgroundColor,
        };
    });
    const rail = await page.locator('[data-open-window-switcher-list]').evaluate(list => {
        const style = getComputedStyle(list);
        const rect = list.getBoundingClientRect();
        const rowRect = list.querySelector('[data-open-window-row]').getBoundingClientRect();
        return {
            background: style.backgroundColor,
            boxShadow: style.boxShadow,
            marginLeft: style.marginLeft,
            marginRight: style.marginRight,
            edgeToEdge: rect.left === rowRect.left && rect.width === rowRect.width,
        };
    });
    const current = await page.locator('[data-open-window-row]').first().evaluate(row => ({
        background: getComputedStyle(row).backgroundColor,
        sheen: getComputedStyle(row).backgroundImage,
        boxShadow: getComputedStyle(row).boxShadow,
        indicator: getComputedStyle(row.querySelector('.open-window-indicator'), '::before').backgroundColor,
        indicatorWidth: getComputedStyle(row.querySelector('.open-window-indicator'), '::before').width,
        nameWeight: getComputedStyle(row.querySelector('.open-window-name')).fontWeight,
    }));
    assert.equal(rail.background, 'rgba(0, 0, 0, 0)',
        'the rail is transparent: the sidebar itself is the surface, not a nested card');
    assert.equal(rail.boxShadow, 'none');
    assert.equal(rail.marginLeft, '0px');
    assert.equal(rail.marginRight, '0px');
    assert.equal(rail.edgeToEdge, true,
        'window rows must span the full rail width so they align with the worktree cards below');
    assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
    assert.equal(appearance.borderTopWidth, '0px');
    assert.equal(appearance.borderTopStyle, 'none');
    assert.equal(appearance.boxShadow, 'none');
    assert.equal(appearance.indicator, 'rgba(127, 127, 127, 0.34)',
        'a quiet tick keeps resting rows scannable without boxing them in');
    assert.equal(current.background, 'rgba(110, 168, 254, 0.12)');
    assert.match(current.sheen, /^linear-gradient/,
        'the current window carries a soft top sheen instead of a flat fill');
    assert.match(current.boxShadow, /rgba\(127, 127, 127, 0\.2\).*inset/,
        'the current window uses a hairline ring rather than a hard border');
    assert.equal(current.indicator, 'rgb(110, 168, 254)',
        'the accent bar is the single confident focus-color element');
    assert.equal(current.indicatorWidth, '3px');
    assert.equal(current.nameWeight, '600');
});

test('OPEN-WINDOW-SWITCHER-UI-001 keeps hover visible without widget theme tokens at default and minimum widths', async t => {
    for (const width of [360, 170]) {
        const page = await openSwitcherPage(t, { width });
        await page.addStyleTag({ content: `
            :root {
                --vscode-sideBar-background: #181818;
                --vscode-panel-border: #666;
                --vscode-editorWidget-background: initial;
                --vscode-widget-border: initial;
                --vscode-list-hoverBackground: rgba(255, 255, 255, 0.06);
            }
        ` });
        const row = page.locator('[data-open-window-row]').nth(1);
        const computed = await page.locator('[data-open-window-switcher-list]').evaluate(element => {
            const style = getComputedStyle(element);
            return {
                background: style.backgroundColor,
                boxShadow: style.boxShadow,
            };
        });
        assert.equal(computed.background, 'rgba(0, 0, 0, 0)',
            'the rail adds no surface of its own, even when widget tokens are absent');
        assert.equal(computed.boxShadow, 'none');

        const restingPixels = await row.screenshot();
        await row.hover();
        await page.waitForTimeout(250);
        assert.notDeepEqual(await row.screenshot(), restingPixels,
            `hover must remain visible without widget theme tokens at ${width}px`);
        const hoverShadow = await row.evaluate(element => getComputedStyle(element).boxShadow);
        assert.match(hoverShadow, /rgba\(127, 127, 127, 0\.16\).*inset/,
            `the hover hairline ring must not depend on theme widget tokens at ${width}px`);
    }
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
        announcement: document.querySelector('[data-open-window-nav-live-region]').textContent,
    }), cardId);
    assert.equal(snapshot.state, null);
    assert.equal(snapshot.pending, false);
    assert.equal(snapshot.announcement, 'Now in window beta');

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

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 consecutive clicks coalesce without swallowing A-B-A', async t => {
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

    const otherCardId = '__openWorkspaceNavigation-' + 'c'.repeat(24);
    await page.evaluate(({ cardId, otherCardId }) => {
        window.__agentPivotOpenWindowNavigation.request(cardId);
        window.__agentPivotOpenWindowNavigation.request(cardId);
        window.__agentPivotOpenWindowNavigation.request(otherCardId);
        window.__agentPivotOpenWindowNavigation.request(cardId);
    }, { cardId, otherCardId });
    const requests = await page.evaluate(() => window.__postedMessages);
    assert.deepEqual(requests.map(request => request.cardId), [
        cardId, otherCardId, cardId,
    ], 'only a consecutive same-row click is coalesced; A-B-A preserves the final A intent');
    assert.equal(await page.evaluate(() => window.__timeoutCallbacks.length), 3);

    // settlement for the superseded request is ignored
    await page.evaluate(id => {
        window.__agentPivotOpenWindowNavigation.complete({
            type: 'open-window-navigation-result', version: 1, requestId: 1, cardId: id, outcome: 'focused',
        });
    }, cardId);
    assert.equal(await page.evaluate(id => window.__agentPivotOpenWindowNavigation.isPending(id), cardId), true);

    // fire the live timeout for the final A: the row settles into the error state
    await page.evaluate(() => {
        window.__timeoutCallbacks[2]();
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

    await page.evaluate(id => window.__agentPivotOpenWindowNavigation.retry(id), cardId);
    const retried = await page.evaluate(() => window.__postedMessages.at(-1));
    assert.equal(retried.cardId, cardId);
    assert.equal(retried.requestId, 4,
        'a timeout clears pending so Retry always sends a fresh request');
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
    const compact = await openSwitcherPage(t, { width: 320 });
    const narrow = await openSwitcherPage(t, { width: 240 });
    const widePinVisible = await wide.evaluate(() => {
        const row = document.querySelectorAll('[data-open-window-row]')[1];
        return getComputedStyle(row.querySelector('[data-action="toggle-open-workspace-pin"]')).display !== 'none';
    });
    const narrowPinVisible = await narrow.evaluate(() => {
        const row = document.querySelectorAll('[data-open-window-row]')[1];
        return getComputedStyle(row.querySelector('[data-action="toggle-open-workspace-pin"]')).display !== 'none';
    });
    const narrowSave = await narrow.evaluate(() => {
        const row = document.querySelector('[data-open-window-row][data-window-kind="current"]');
        const button = row.querySelector('[data-action="save-current-workspace"]');
        return {
            visible: getComputedStyle(button).display !== 'none',
            overflows: row.scrollWidth > row.clientWidth,
        };
    });
    const compactLayout = await compact.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]')).map(row => {
            const pin = row.querySelector('[data-action="toggle-open-workspace-pin"]');
            const attention = row.querySelector('.open-window-attention').getBoundingClientRect();
            const running = row.querySelector('.open-window-running').getBoundingClientRect();
            return {
                pinDisplay: getComputedStyle(pin).display,
                pinVisibility: getComputedStyle(pin).visibility,
                attentionLeft: Math.round(attention.left),
                runningLeft: Math.round(running.left),
            };
        })
    );
    // ≥360px：未 pin 的 ★ 在 DOM 中（hover 显示）；<280px：所有 Pin 槽位统一收起。
    assert.equal(widePinVisible, true);
    assert.equal(narrowPinVisible, false);
    assert.deepEqual(narrowSave, { visible: true, overflows: false },
        'an unsaved current workspace keeps Save Workspace available without horizontal overflow');
    assert.ok(compactLayout.every(item => item.pinDisplay !== 'none'),
        'every row retains its fixed Pin slot at compact widths');
    assert.deepEqual(compactLayout.map(item => item.pinVisibility), ['visible', 'hidden', 'hidden']);
    assert.equal(new Set(compactLayout.map(item => item.attentionLeft)).size, 1,
        'attention stays in one column across pinned and unpinned rows');
    assert.equal(new Set(compactLayout.map(item => item.runningLeft)).size, 1,
        'running stays in one column across pinned and unpinned rows');
    const compactUnpinnedRow = compact.locator('[data-open-window-row]').nth(1);
    await compactUnpinnedRow.hover();
    assert.equal(await compactUnpinnedRow.locator('[data-action="toggle-open-workspace-pin"]')
        .evaluate(pin => getComputedStyle(pin).visibility), 'visible',
    'hover still reveals the Pin control in its reserved compact-width slot');
    const keyboardUnpinnedRow = compact.locator('[data-open-window-row]').nth(2);
    await keyboardUnpinnedRow.locator('[data-action="focus-open-window"]').focus();
    await compact.keyboard.press('Tab');
    assert.deepEqual(await compact.evaluate(() => ({
        action: document.activeElement?.getAttribute('data-action'),
        pinVisibility: getComputedStyle(document.activeElement).visibility,
    })), { action: 'toggle-open-workspace-pin', pinVisibility: 'visible' },
    'keyboard focus reveals and reaches the compact-width Pin control without a hidden focus stop');
});

test('OPEN-WINDOW-SWITCHER-UI-001 keeps bridge status in the WINDOWS title row without a gap before window rows', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'f'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'g'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);
    const layout = await page.evaluate(() => {
        const header = document.querySelector('.open-window-switcher-header');
        const status = document.querySelector('[data-open-window-switcher-status]');
        const firstRow = document.querySelector('[data-open-window-row]');
        const headerBox = header.getBoundingClientRect();
        const rowBox = firstRow.getBoundingClientRect();
        return {
            headerHeight: Math.round(headerBox.height),
            headerFontSize: getComputedStyle(header).fontSize,
            headerBorderBottomWidth: getComputedStyle(header).borderBottomWidth,
            statusDisplay: getComputedStyle(status).display,
            statusSharesHeader: status.parentElement === header,
            rowGap: Math.round(rowBox.top - headerBox.bottom),
        };
    });

    assert.equal(layout.statusDisplay, 'flex', 'ready state reserves the fixed horizontal status slot');
    assert.equal(layout.statusSharesHeader, true,
        'bridge status stays in the WINDOWS title row instead of creating a second row');
    assert.equal(layout.headerFontSize, '10px');
    assert.equal(layout.headerBorderBottomWidth, '1px',
        'a hairline separates the WINDOWS label from its rows');
    assert.ok(layout.headerHeight <= 21,
        'the navigation label stays compact, including its one-pixel separator');
    assert.ok(layout.rowGap <= 2,
        'the first window row follows the WINDOWS title without a blank status row; only rail inset is allowed');
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
        undefined,
        undefined,
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

test('OPEN-WINDOW-SWITCHER-UI-001 production OPEN tab omits the retired layout migration notice', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const page = await openProductionOpenTabPage(t, [currentCard]);
    const notice = page.locator('[data-open-tab-layout-notice]');
    assert.equal(await notice.count(), 0,
        'the retired layout-migration flag must not restore a one-time OPEN tab notice');
});

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

    await navigationRow.locator('[data-action="focus-open-window"]').click();
    posted = await page.evaluate(() => window.__postedMessages);
    requests = posted.filter(message => message.type === 'open-window-navigation-request');
    assert.equal(requests.length, 1,
        'a consecutive click on the same pending row must reuse the first request');

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
        '2',
        'the refreshed row adopts the authoritative attention count',
    );
    assert.equal(await navigationRow.locator('.open-window-attention-dot').count(), 1,
        'the refreshed attention count keeps its red-dot marker');

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

test('OPEN-WINDOW-SWITCHER-UI-001 tail clicks switch windows without stealing dedicated row actions', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'h'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'i'.repeat(24), 'navigation', {
        name: 'beta', runningSessionCount: 2, attentionCount: 1,
    });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);
    const navigationRow = page.locator(`[data-open-window-row][data-id="${navigationCard.id}"]`);

    await navigationRow.locator('.open-window-running').click();
    let posted = await page.evaluate(() => window.__postedMessages);
    assert.deepEqual(posted.filter(message => message.type === 'open-window-navigation-request'), [{
        type: 'open-window-navigation-request', version: 1, requestId: 1, cardId: navigationCard.id,
    }], 'the fixed running-count slot is part of the window-switch hit area');

    await navigationRow.locator('[data-action="open-window-menu"]').click();
    posted = await page.evaluate(() => window.__postedMessages);
    assert.equal(posted.filter(message => message.type === 'open-window-navigation-request').length, 1,
        'the ⋯ menu remains the only non-switching region at the row tail');
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 1);
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
    assert.equal(await page.locator('[data-open-session-surface] .open-current-workspace-empty').count(), 1,
        'the empty state stays rendered after the incremental update');
});

test('OPEN-WINDOW-SWITCHER-UI-001 bridge status keeps window and chat surfaces stationary', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 'd'.repeat(24), 'current', { name: 'alpha' });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'e'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);

    const measure = () => page.evaluate(() => {
        const group = document.querySelector('[data-group-id="open-window-switcher"]');
        const status = group.querySelector('[data-open-window-switcher-status]');
        const list = group.querySelector('[data-open-window-switcher-list]');
        const chats = document.querySelector('[data-open-session-surface]');
        return {
            groupHeight: group.getBoundingClientRect().height,
            statusHeight: status.getBoundingClientRect().height,
            listTop: list.getBoundingClientRect().top,
            chatsTop: chats.getBoundingClientRect().top,
            rowTops: Array.from(list.querySelectorAll('[data-open-window-row]'))
                .map(row => row.getBoundingClientRect().top),
        };
    });

    const ready = await measure();
    assert.ok(ready.statusHeight > 0,
        'a ready bridge reserves its blank status row');
    assert.equal(ready.rowTops.length, 2);

    let revision = 10;
    for (const status of ['connecting', 'unavailable', 'update-required']) {
        await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], status, ++revision);
        const next = await measure();
        assert.ok(next.statusHeight > 0,
            `bridge status "${status}" receives a visible status row`);
        assert.equal(next.statusHeight, ready.statusHeight,
            `bridge status "${status}" retains the fixed status-slot height`);
        assert.equal(next.listTop, ready.listTop,
            `bridge status "${status}" does not move window rows`);
        assert.equal(next.chatsTop, ready.chatsTop,
            `bridge status "${status}" does not move CHATS/ALL`);
    }
    // The status text renders only when it has a message.
    await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], 'connecting', ++revision);
    assert.match(await page.locator('[data-open-window-switcher-status]').textContent() || '',
        /Looking for your other open windows/);

    await postOpenWorkspacesUpdate(page, [currentCard, navigationCard], 'ready', ++revision);
    assert.deepEqual(await measure(), ready,
        'returning to ready clears text without moving either surface');
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

test('OPEN-WINDOW-SWITCHER-UI-001 direct save closes More and restores focus after its button disappears', async t => {
    const currentCard = makeCard('__currentWorkspace-' + 's'.repeat(24), 'current', {
        name: 'alpha', showSaveAction: true,
    });
    const navigationCard = makeCard('__openWorkspaceNavigation-' + 'n'.repeat(24), 'navigation', { name: 'beta' });
    const page = await openProductionOpenTabPage(t, [currentCard, navigationCard]);
    const currentRow = `[data-open-window-row][data-id="${currentCard.id}"]`;
    const navigationMore = page.locator(
        `[data-open-window-row][data-id="${navigationCard.id}"] [data-action="open-window-menu"]`
    );

    await navigationMore.click();
    assert.equal(await navigationMore.getAttribute('aria-expanded'), 'true');
    const saveButton = page.locator(`${currentRow} [data-action="save-current-workspace"]`);
    await saveButton.click();
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), [{
        type: 'save-current-workspace', projectId: currentCard.id,
    }]);
    assert.equal(await page.locator('#openWindowMenu.visible').count(), 0);
    assert.equal(await navigationMore.getAttribute('aria-expanded'), 'false');

    await postOpenWorkspacesUpdate(page, [
        { ...currentCard, showSaveAction: false },
        navigationCard,
    ], 'ready', 31);
    assert.equal(await page.locator(`${currentRow} [data-action="save-current-workspace"]`).count(), 0);
    assert.deepEqual(await page.evaluate(() => ({
        action: document.activeElement?.getAttribute('data-action'),
        cardId: document.activeElement?.closest('[data-open-window-row]')?.getAttribute('data-id'),
    })), { action: 'open-window-menu', cardId: currentCard.id },
    'when Save Workspace disappears, focus moves to More in the same current-window row');

    const blankSlotCursor = await page.locator(
        `[data-open-window-row][data-id="${navigationCard.id}"] .open-window-save-slot`
    ).evaluate(slot => getComputedStyle(slot).cursor);
    assert.equal(blankSlotCursor, 'default');
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
    const emptySlot = emptyRow.locator('.open-window-pin-slot');
    assert.equal(await emptySlot.count(), 1,
        'the empty window keeps a non-interactive Pin spacer for stable count columns');
    assert.equal(await emptySlot.getAttribute('aria-hidden'), 'true');
    assert.equal(
        await page.locator('[data-open-window-row][data-window-kind="navigation"] [data-action="toggle-open-workspace-pin"]').count(),
        1,
        'regular rows keep their pin button',
    );

    const getCountColumns = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-open-window-row]')).map(row => ({
            attentionLeft: Math.round(row.querySelector('.open-window-attention').getBoundingClientRect().left),
            runningLeft: Math.round(row.querySelector('.open-window-running').getBoundingClientRect().left),
        }))
    );
    for (const width of [360, 320]) {
        await page.setViewportSize({ width, height: 600 });
        const columns = await getCountColumns();
        assert.equal(new Set(columns.map(column => column.attentionLeft)).size, 1,
            `attention remains aligned with the empty-window spacer at ${width}px`);
        assert.equal(new Set(columns.map(column => column.runningLeft)).size, 1,
            `running remains aligned with the empty-window spacer at ${width}px`);
    }

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
    const listItem = menu.locator('[role="menuitemradio"][data-view-mode="list"]');
    assert.equal(await treeItem.getAttribute('aria-checked'), 'true');
    assert.equal(await listItem.getAttribute('aria-checked'), 'false');
    assert.equal(await treeItem.evaluate(node => document.activeElement === node), true);

    // Selecting List synchronizes the radio state and persists through the
    // existing host-owned window view-state message.
    await listItem.click();
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.locator('[data-ai-session-region]').getAttribute('data-chats-view-mode'), 'list');
    assert.equal(await listItem.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-chats-view-mode',
        version: 1,
        projectId: currentCard.id,
        viewMode: 'list',
    });

    // Esc 关闭并把焦点还给触发按钮。
    await trigger.click();
    assert.equal(await listItem.evaluate(node => document.activeElement === node), true);
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
    assert.equal(await listItem.evaluate(node => document.activeElement === node), true);
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
