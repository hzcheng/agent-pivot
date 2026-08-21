'use strict';

// Unit coverage for the open-workspaces-updated v4 message builder (PR-A:
// schema defined, not yet posted by production).

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadWithFakeVscode } = require('../../contract/openProjects/helpers');
const {
    buildOpenWorkspacesUpdatedMessageV4,
} = loadWithFakeVscode('../../../out/dashboard/webviewUpdateMessages');

function card(id, kind) {
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
    };
}

function input(overrides = {}) {
    return {
        groups: [],
        cards: [card('c', 'current'), card('n1', 'navigation'), card('n2', 'navigation')],
        semanticRevision: 'rev-1',
        projectionRevision: 3,
        otherWindowsStatus: 'ready',
        todoSearchItems: [],
        windowSwitcherHtml: '<div data-open-window-switcher></div>',
        presentation: { version: 1, projects: {} },
        ...overrides,
    };
}

test('open-workspaces-updated v4 carries explicit window-row counts', () => {
    const message = buildOpenWorkspacesUpdatedMessageV4(input());
    assert.equal(message.type, 'open-workspaces-updated');
    assert.equal(message.version, 4);
    assert.equal(message.windowRowCount, 3);
    assert.equal(message.currentWindowRowCount, 1);
    assert.equal(message.navigationWindowRowCount, 2);
    assert.equal(message.currentDetailCount, 1);
    assert.equal(message.html, '<div data-open-window-switcher></div>');
    assert.equal(message.semanticRevision, 'rev-1');
    assert.ok(message.searchCatalog);
});

test('open-workspaces-updated v4 handles missing current window', () => {
    const message = buildOpenWorkspacesUpdatedMessageV4(input({
        cards: [card('n1', 'navigation')],
    }));
    assert.equal(message.windowRowCount, 1);
    assert.equal(message.currentWindowRowCount, 0);
    assert.equal(message.navigationWindowRowCount, 1);
    assert.equal(message.currentDetailCount, 0);
});
