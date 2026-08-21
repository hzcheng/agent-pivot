'use strict';

// Unit coverage for the window-switcher renderer (c8-instrumented suites only;
// the browser-level behavior lives in tests/browser/dashboardWindowSwitcher.test.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getOpenWindowRowHtml,
    getOpenWindowSwitcherGroupContent,
} = require('../../../out/webview/webviewWindowSwitcherContent');

function row(overrides = {}) {
    return {
        cardId: '__openWorkspaceNavigation-' + 'b'.repeat(24),
        kind: 'navigation',
        navigationIdentity: 'identity-1',
        displayName: 'beta',
        fullName: 'beta',
        environmentLabel: 'Local',
        runningCount: 1,
        attentionCount: 0,
        pinned: false,
        ...overrides,
    };
}

test('window switcher renderer: current row carries the triple encoding and aria semantics', () => {
    const html = getOpenWindowRowHtml(row({
        kind: 'current',
        cardId: '__currentWorkspace-' + 'a'.repeat(24),
        displayName: 'alpha',
        fullName: 'alpha',
        pinned: true,
        runningCount: 2,
        attentionCount: 3,
    }));
    assert.match(html, /role="listitem"/);
    assert.match(html, /aria-current="true"/);
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /aria-label="Current window: alpha"/);
    assert.match(html, /title="Current window: alpha/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /●2/);
    assert.match(html, /⚠3/);
});

test('window switcher renderer: navigation row points at the focus affordance', () => {
    const html = getOpenWindowRowHtml(row());
    assert.match(html, /title="Focus window: beta/);
    assert.match(html, /aria-label="Focus window: beta"/);
    assert.ok(!html.includes('aria-current'));
    assert.ok(!html.includes('aria-disabled'));
});

test('window switcher renderer: zero counts keep empty slots with aria labels', () => {
    const html = getOpenWindowRowHtml(row({ runningCount: 0, attentionCount: 0 }));
    assert.match(html, /class="open-window-running"[^>]*aria-label="No running sessions"/);
    assert.match(html, /class="open-window-attention"[^>]*aria-label="Nothing needs attention"/);
});

test('window switcher renderer: environment chip and escaping', () => {
    const html = getOpenWindowRowHtml(row({
        displayName: 'beta<b>',
        fullName: 'beta<b>',
        environmentLabel: 'SSH',
    }));
    assert.match(html, /beta&lt;b&gt;/);
    assert.ok(!html.includes('beta<b>'));
    assert.match(html, /open-window-env-chip">SSH</);
});

test('window switcher group: list role, count badge, status slot, and live region', () => {
    const html = getOpenWindowSwitcherGroupContent([row()], 'ready');
    assert.match(html, /role="list"/);
    assert.match(html, /aria-label="Windows"/);
    assert.match(html, /open-window-count">1</);
    assert.match(html, /data-open-window-switcher-status/);
    assert.match(html, /data-open-workspace-pin-live-region/);
    assert.match(html, /data-other-windows-status="ready"/);
});
