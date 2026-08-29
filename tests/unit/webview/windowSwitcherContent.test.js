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
        remoteType: 0,
        environmentLabel: 'Local',
        runningCount: 1,
        attentionCount: 0,
        pinned: false,
        folderNames: ['beta'],
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
    assert.match(html, /open-window-attention-dot/);
    assert.match(html, /open-window-attention-dot[^>]*><\/span>3/);
    const attentionIndex = html.indexOf('class="open-window-attention"');
    const runningIndex = html.indexOf('class="open-window-running"');
    assert.notEqual(attentionIndex, -1);
    assert.notEqual(runningIndex, -1);
    assert.ok(attentionIndex < runningIndex, 'attention count precedes the running count');
});

test('window switcher renderer: an unsaved current workspace gets a save button in its fixed action slot', () => {
    const unsaved = getOpenWindowRowHtml(row({
        kind: 'current',
        cardId: '__currentWorkspace-' + 'a'.repeat(24),
        showSaveAction: true,
    }));
    const saved = getOpenWindowRowHtml(row({
        kind: 'current',
        cardId: '__currentWorkspace-' + 'a'.repeat(24),
        showSaveAction: false,
    }));
    const navigation = getOpenWindowRowHtml(row({ showSaveAction: true }));
    assert.match(unsaved, /class="open-window-save"[^>]*data-action="save-current-workspace"/);
    assert.match(unsaved, /title="Save Workspace"/);
    assert.ok(
        unsaved.indexOf('class="open-window-save"') < unsaved.indexOf('class="open-window-attention"'),
        'Save Workspace appears before the attention indicator',
    );
    assert.match(saved, /class="open-window-save-slot"/);
    assert.match(navigation, /class="open-window-save-slot"/);
    assert.ok(!navigation.includes('data-action="save-current-workspace"'));
});

test('window switcher renderer: navigation row points at the focus affordance', () => {
    const html = getOpenWindowRowHtml(row());
    assert.match(html, /title="Focus window: beta/);
    assert.match(html, /aria-label="Focus window: beta"/);
    assert.match(html, /1 folder: beta/);
    assert.ok(!html.includes('aria-current'));
    assert.ok(!html.includes('aria-disabled'));
});

test('window switcher renderer: zero counts keep empty slots with aria labels', () => {
    const html = getOpenWindowRowHtml(row({ runningCount: 0, attentionCount: 0 }));
    assert.match(html, /class="open-window-running"[^>]*aria-label="No running sessions"/);
    assert.match(html, /class="open-window-attention"[^>]*aria-label="Nothing needs attention"/);
});

test('window switcher renderer: singular count labels and slot roles', () => {
    const html = getOpenWindowRowHtml(row({ runningCount: 1, attentionCount: 1 }));
    assert.match(html, /aria-label="1 session running in this window"/);
    assert.match(html, /aria-label="1 session needs attention in this window"/);
});

test('window switcher renderer: semantic environment icon replaces the environment chip', () => {
    const remote = getOpenWindowRowHtml(row({
        displayName: 'beta<b>', fullName: 'beta<b>', environmentLabel: 'SSH', remoteType: 1,
    }));
    assert.match(remote, /beta&lt;b&gt;/);
    assert.ok(!remote.includes('beta<b>'));
    assert.match(remote, /open-window-icon" title="SSH Project"/);
    assert.match(remote, /viewBox="0 0 640 512"/);
    const container = getOpenWindowRowHtml(row({ remoteType: 3 }));
    assert.match(container, /open-window-icon" title="Dev Container Project"/);
    assert.match(container, /viewBox="0 0 24 24"/);
    assert.ok(!remote.includes('open-window-env-chip'));
    assert.ok(!remote.includes('>SSH<'));
});

test('window switcher group: list role, count badge, status slot, and live regions', () => {
    const html = getOpenWindowSwitcherGroupContent([row()], 'ready');
    assert.match(html, /role="list"/);
    assert.match(html, /aria-label="Windows"/);
    assert.match(html, /open-window-count">1</);
    assert.match(html, /data-open-window-switcher-status/);
    assert.match(html, /data-open-workspace-pin-live-region/);
    assert.match(html, /data-open-window-nav-live-region/);
    assert.match(html, /data-other-windows-status="ready"/);
});

test('window switcher group: non-ready status disables navigation rows', () => {
    const html = getOpenWindowSwitcherGroupContent(
        [row({ kind: 'current', cardId: '__currentWorkspace-' + 'a'.repeat(24) }), row()],
        'connecting',
        '<p>Looking for your other open windows…</p>',
    );
    assert.match(html, /Looking for your other open windows/);
    const navRowStart = html.indexOf('data-window-kind="navigation"');
    const currentRowStart = html.indexOf('data-window-kind="current"');
    assert.ok(currentRowStart !== -1 && currentRowStart < navRowStart,
        'the current row stays on top while the bridge is not ready');
    assert.match(html.slice(navRowStart, navRowStart + 400), /data-navigation-disabled="true"/);
});
