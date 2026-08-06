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

function render(status, collapsed = false) {
    const html = getOpenWorkspacesGroupContent([], collapsed, status);
    const start = html.indexOf('<div class="group steward-section open-other-windows-group');
    assert.ok(start >= 0, 'the other-windows group must be rendered');
    // The CURRENT WINDOW section carries its own "Live" badge, so every badge
    // assertion has to be scoped to the other-windows group.
    return html.slice(start);
}

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 marks the section as connecting instead of claiming a live empty list', () => {
    const html = render('connecting');

    assert.match(html, /data-other-windows-status="connecting"/);
    assert.doesNotMatch(html, /<span class="group-title-badge">Live<\/span>/);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 shows a connecting surface while the bridge handshake is in flight', () => {
    const html = render('connecting');

    assert.match(html, /class="open-other-windows-state"/);
    assert.match(html, /data-other-windows-connecting/);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 keeps the collapsed preference while connecting', () => {
    assert.match(render('connecting', true), /open-other-windows-group collapsed/);
    assert.match(render('ready', true), /open-other-windows-group collapsed/);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 still forces the section open for a broken bridge', () => {
    assert.doesNotMatch(render('unavailable', true), /open-other-windows-group collapsed/);
    assert.doesNotMatch(render('update-required', true), /open-other-windows-group collapsed/);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 leaves the settled statuses unchanged', () => {
    assert.match(render('ready'), /<span class="group-title-badge">Live<\/span>/);
    assert.match(render('unavailable'), /<span class="group-title-badge">Unavailable<\/span>/);
    assert.match(render('update-required'), /<span class="group-title-badge">Update required<\/span>/);
    assert.doesNotMatch(render('ready'), /class="open-other-windows-state"/);
});
