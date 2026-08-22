'use strict';

// Unit coverage for the window-switcher display-name disambiguation (PRD:
// 同名窗口按最短唯一后缀消歧，确定性) and row view-model projection.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    resolveWindowDisplayNames,
} = require('../../../out/openWorkspaces/windowDisplayNames');
const {
    buildOpenWindowRowViewModels,
} = require('../../../out/openWorkspaces/windowRowViewModel');

test('window display names: unique names pass through unchanged', () => {
    const result = resolveWindowDisplayNames([
        { id: 'a', name: 'alpha', pathSegments: ['x', 'alpha'] },
        { id: 'b', name: 'beta', pathSegments: ['x', 'beta'] },
    ]);
    assert.equal(result.get('a'), 'alpha');
    assert.equal(result.get('b'), 'beta');
});

test('window display names: duplicates get the shortest unique suffix', () => {
    const result = resolveWindowDisplayNames([
        { id: 'a', name: 'app', pathSegments: ['repo', 'main', 'app'] },
        { id: 'b', name: 'app', pathSegments: ['repo', '.worktrees', 'feat', 'app'] },
    ]);
    assert.equal(result.get('a'), 'app — main');
    assert.equal(result.get('b'), 'app — feat');
});

test('window display names: suffix grows until unique', () => {
    const result = resolveWindowDisplayNames([
        { id: 'a', name: 'app', pathSegments: ['repo', 'one', 'wt', 'app'] },
        { id: 'b', name: 'app', pathSegments: ['repo', 'two', 'wt', 'app'] },
    ]);
    assert.equal(result.get('a'), 'app — one/wt');
    assert.equal(result.get('b'), 'app — two/wt');
});

test('window display names: identical paths fall back to deterministic ordinals', () => {
    const first = resolveWindowDisplayNames([
        { id: 'a', name: 'app', pathSegments: [] },
        { id: 'b', name: 'app', pathSegments: [] },
    ]);
    const second = resolveWindowDisplayNames([
        { id: 'b', name: 'app', pathSegments: [] },
        { id: 'a', name: 'app', pathSegments: [] },
    ]);
    assert.equal(first.get('a'), second.get('a'));
    assert.equal(first.get('b'), second.get('b'));
    assert.notEqual(first.get('a'), first.get('b'));
});

test('window display names: three-way collision mixes suffix and ordinal', () => {
    const result = resolveWindowDisplayNames([
        { id: 'a', name: 'app', pathSegments: ['r', 'm', 'app'] },
        { id: 'b', name: 'app', pathSegments: ['r', 'm', 'app'] },
        { id: 'c', name: 'app', pathSegments: ['r', 'w', 'app'] },
    ]);
    assert.equal(result.get('c'), 'app — w');
    assert.notEqual(result.get('a'), result.get('b'));
});

function card(id, overrides = {}) {
    return {
        id,
        kind: 'navigation',
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

test('window row view models: maps counts, pin, kind and disambiguated names', () => {
    const rows = buildOpenWindowRowViewModels([
        card('c1', { kind: 'current', name: 'app', runningSessionCount: 2, attentionCount: 1, pinned: true }),
        card('n1', { name: 'app', runningSessionCount: 1 }),
    ], new Map([
        ['c1', ['repo', 'main', 'app']],
        ['n1', ['repo', 'wt', 'app']],
    ]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'current');
    assert.equal(rows[0].displayName, 'app — main');
    assert.equal(rows[0].runningCount, 2);
    assert.equal(rows[0].attentionCount, 1);
    assert.equal(rows[0].pinned, true);
    assert.equal(rows[0].remoteType, 0);
    assert.equal(rows[1].displayName, 'app — wt');
    assert.equal(rows[1].pinned, false);
});

test('window row view models: negative counts clamp to zero', () => {
    const rows = buildOpenWindowRowViewModels([
        card('n1', { runningSessionCount: -3, attentionCount: -1 }),
    ]);
    assert.equal(rows[0].runningCount, 0);
    assert.equal(rows[0].attentionCount, 0);
});
