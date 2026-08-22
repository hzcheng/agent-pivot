'use strict';

// Unit coverage for the production open-workspaces-updated v4 message builder.

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadWithFakeVscode } = require('../../contract/openProjects/helpers');
const {
    buildOpenWorkspacesUpdatedMessage,
} = loadWithFakeVscode('../../../out/dashboard/webviewUpdateMessages');

function card(id, kind, overrides = {}) {
    return {
        id,
        kind,
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: 'n-' + id,
        scopeIdentity: 's-' + id,
        name: id,
        environment: 'local',
        environmentLabel: 'Local',
        roots: [{ id: 'r-' + id, name: id, ordinal: 0 }],
        attentionCount: 0,
        ...overrides,
    };
}

function input(overrides = {}) {
    return {
        groups: [],
        cards: [card('c', 'current'), card('n1', 'navigation'), card('n2', 'navigation')],
        semanticRevision: 'rev-1',
        projectionRevision: 3,
        otherWindowsStatus: 'ready',
        presentation: { version: 1, projects: {} },
        ...overrides,
    };
}

test('open-workspaces-updated v4 carries explicit window-row counts and switcher html', () => {
    const message = buildOpenWorkspacesUpdatedMessage(input());
    assert.equal(message.type, 'open-workspaces-updated');
    assert.equal(message.version, 4);
    assert.equal(message.windowRowCount, 3);
    assert.equal(message.currentWindowRowCount, 1);
    assert.equal(message.navigationWindowRowCount, 2);
    assert.equal(message.currentDetailCount, 1);
    assert.match(message.html, /data-group-id="open-window-switcher"/);
    assert.match(message.html, /data-open-window-row/);
    // CHATS/ALL is a direct sibling of the WINDOWS switcher, not a card shell.
    assert.match(message.html, /data-open-session-surface/);
    assert.ok(!message.html.includes('CURRENT WINDOW'));
    assert.ok(!message.html.includes('open-tab-split-resizer'));
    assert.equal(message.semanticRevision, 'rev-1');
});

test('open-workspaces-updated v4 handles a missing current window', () => {
    const message = buildOpenWorkspacesUpdatedMessage(input({
        cards: [card('n1', 'navigation')],
    }));
    assert.equal(message.windowRowCount, 1);
    assert.equal(message.currentWindowRowCount, 0);
    assert.equal(message.navigationWindowRowCount, 1);
    assert.equal(message.currentDetailCount, 0);
});

test('open-workspaces-updated v4 renders bridge status into the fixed switcher slot', () => {
    const message = buildOpenWorkspacesUpdatedMessage(input({ otherWindowsStatus: 'connecting' }));
    assert.match(message.html, /data-open-window-switcher-status/);
    assert.match(message.html, /Looking for your other open windows/);
    assert.equal(message.otherWindowsStatus, 'connecting');
});
