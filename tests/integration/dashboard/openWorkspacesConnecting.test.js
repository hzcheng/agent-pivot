'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

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
        delete require.cache[require.resolve('../../../out/webview/webviewContent')];
        return require('../../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getOpenWorkspacesGroupContent } = loadWebviewContent();

function makeWindowCard(id, kind) {
    return {
        id,
        kind,
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: `navigation:${id}`,
        scopeIdentity: `scope:${id}`,
        name: id,
        environment: 'local',
        environmentLabel: 'Local',
        color: '#00aacc',
        roots: [{ id: `root:${id}`, name: id, ordinal: 0 }],
        attentionCount: 0,
    };
}

// The navigation card comes first on purpose: while the bridge is not ready
// the current row must be pinned to the top of the switcher, so the input
// order has to be observable in the output.
function render(status) {
    const html = getOpenWorkspacesGroupContent([
        makeWindowCard('other', 'navigation'),
        makeWindowCard('current', 'current'),
    ], status);
    const start = html.indexOf('<div class="group open-window-switcher-group');
    assert.ok(start >= 0, 'the window switcher group must be rendered');
    return html.slice(start);
}

function rowTags(html) {
    return Array.from(html.matchAll(/<div class="open-window-row[^"]*"[^>]*>/g))
        .map(match => match[0]);
}

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 marks the switcher as connecting instead of claiming a live list', () => {
    const html = render('connecting');

    assert.match(html, /class="group open-window-switcher-group"[^>]*data-other-windows-status="connecting"/);
    assert.match(html, /class="group-title-badge open-window-count">2</,
        'the switcher keeps showing the known window rows while connecting');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 shows a connecting surface in the switcher status slot while the bridge handshake is in flight', () => {
    const html = render('connecting');

    assert.match(html, /data-open-window-switcher-status>[\s\S]*?class="open-other-windows-state"[^>]*data-other-windows-connecting/);
    assert.match(html, /Looking for your other open windows/);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 disables navigation rows and pins the current row on top until the bridge is ready', () => {
    for (const status of ['connecting', 'unavailable', 'update-required']) {
        const html = render(status);
        const rows = rowTags(html);
        assert.equal(rows.length, 2, status);
        assert.match(rows[0], /data-window-kind="current"/,
            `${status}: the current row is pinned to the top while the bridge is not ready`);
        assert.match(rows[1], /data-window-kind="navigation"/);
        assert.match(rows[1], /open-window-row-disabled/,
            `${status}: navigation rows render disabled while the bridge is not ready`);
        assert.equal((html.match(/data-navigation-disabled="true"/g) || []).length, 1,
            `${status}: only the navigation row carries the navigation-disabled marker`);
        assert.doesNotMatch(rows[0], /data-navigation-disabled/,
            `${status}: the current row itself never gets navigation-disabled`);
    }
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 leaves the settled statuses unchanged', () => {
    const ready = render('ready');
    assert.match(ready, /data-other-windows-status="ready"/);
    assert.doesNotMatch(ready, /class="open-other-windows-state"/,
        'a ready bridge renders no status slot content');
    assert.doesNotMatch(ready, /data-navigation-disabled/);
    const readyRows = rowTags(ready);
    assert.match(readyRows[0], /data-window-kind="navigation"/,
        'a ready bridge keeps the stable window order instead of forcing the current row on top');

    const unavailable = render('unavailable');
    assert.match(unavailable, /data-other-windows-status="unavailable"/);
    assert.match(unavailable, /Open-window discovery is temporarily unavailable/);

    const updateRequired = render('update-required');
    assert.match(updateRequired, /data-other-windows-status="update-required"/);
    assert.match(updateRequired, /Update the Agent Pivot UI Bridge extension/);
    assert.match(updateRequired, /data-action="open-bridge-extension"/);
});
