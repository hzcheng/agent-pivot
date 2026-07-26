'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    createRuntimeFilesystemFixture,
    makeTmuxKnownBinding,
} = require('../../helpers/runtimeContract');
const AiSessionAliasStore = require('../../../out/aiSessions/aliasStore').default;
const AiSessionPinStore = require('../../../out/aiSessions/pinStore').default;
const AiSessionWorkspaceStateStore = require('../../../out/aiSessions/workspaceStateStore').default;
const {
    AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX,
} = require('../../../out/aiSessions/terminalBindingStore');
const AiSessionTerminalBindingStore = require('../../../out/aiSessions/terminalBindingStore').default;
const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');
const { normalizeTodoData } = require('../../../out/todos/types');
const {
    ProductionAttentionStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore');
const {
    OpenWorkspaceStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceStore');
const {
    OPEN_WORKSPACE_LEASE_MS,
    SELF,
    makeRegistration,
} = require('../openProjects/helpers');

const NOW = Date.parse('2026-07-18T10:00:00.000Z');

function makeState(initial = {}) {
    const values = { ...initial };
    return {
        values,
        memento: {
            get(key, fallback) {
                return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
            },
            async update(key, value) {
                if (value === undefined) delete values[key];
                else values[key] = value;
            },
        },
    };
}

function makeAttentionSnapshot(sequence = 1) {
    return {
        version: 1,
        generatedAtMs: NOW,
        items: [],
        instanceId: 'a'.repeat(32),
        sequence,
        heartbeat: sequence,
    };
}

test('PERSIST-ALIAS-STORE-001 reads valid aliases, drops missing fields, and exposes corrupt JSON to its controller boundary', t => {
    const root = makeTempDirectory(t, 'agent-pivot-persistence-alias-');
    const aliasesPath = path.join(root, 'ai-session-aliases.json');
    const store = new AiSessionAliasStore(root);

    assert.deepEqual(store.getAll(), {});
    store.saveAll({
        'codex:valid': 'Valid alias',
        'kimi:missing': '',
        'claude:wrong-type': 7,
    });
    assert.deepEqual(store.getAll(), { 'codex:valid': 'Valid alias' });
    store.set('kimi:trimmed', '  Multi\nLine  ');
    assert.equal(store.getAll()['kimi:trimmed'], 'Multi Line');
    store.remove('kimi:trimmed');
    assert.equal(store.getAll()['kimi:trimmed'], undefined);

    fs.writeFileSync(aliasesPath, '[]', 'utf8');
    assert.deepEqual(store.getAll(), {});
    fs.writeFileSync(aliasesPath, '{"codex:partial":', 'utf8');
    assert.throws(() => store.getAll(), SyntaxError);
});

test('PERSIST-PIN-STORE-001 makes duplicate writes idempotent and never resurrects stale legacy pins', t => {
    const root = makeTempDirectory(t, 'agent-pivot-persistence-pin-');
    const store = new AiSessionPinStore(root);

    store.add('codex:duplicate');
    store.add('codex:duplicate');
    assert.deepEqual(Array.from(store.getAll()), ['codex:duplicate']);

    store.migrateLegacy(['kimi:legacy', '', 'kimi:legacy']);
    assert.deepEqual(Array.from(store.getAll()).sort(), ['codex:duplicate', 'kimi:legacy']);
    store.remove('kimi:legacy');
    store.migrateLegacy(['kimi:legacy']);
    assert.equal(store.has('kimi:legacy'), false);
    assert.equal(store.toggle('claude:toggle'), true);
    assert.equal(store.toggle('claude:toggle'), false);

    const pinRoot = path.join(root, 'pinned-ai-sessions');
    fs.writeFileSync(path.join(pinRoot, 'partial.pin'), '', 'utf8');
    fs.writeFileSync(path.join(pinRoot, 'ignored.tmp'), 'claude:ignored', 'utf8');
    assert.deepEqual(Array.from(store.getAll()), ['codex:duplicate']);
});

test('PERSIST-PROJECT-STATE-STORE-001 sanitizes workspace state and ignores invalid writes', async () => {
    const state = makeState({
        'workspaceExpandedAiSessions.v2': ['scope-a', '', 7, 'scope-a', 'scope-b'],
        'workspaceActiveAiSessionProvider.v2': {
            'scope-a': 'codex',
            'scope-b': 'unknown',
            'scope-c': 'kimi',
        },
        'workspaceAiSessionProviderSelection.v1': {
            'scope-a': {
                primaryProvider: 'codex',
                selectedProviders: ['codex', 'claude', 'claude', 'unknown'],
            },
            'scope-b': { primaryProvider: 'unknown', selectedProviders: [] },
        },
    });
    const store = new AiSessionWorkspaceStateStore(
        state.memento,
        value => value === 'codex' || value === 'kimi' || value === 'claude'
    );

    assert.deepEqual(Array.from(store.getExpandedWorkspaces()), ['scope-a', 'scope-b']);
    assert.deepEqual(store.getActiveProviders(), { 'scope-a': 'codex', 'scope-c': 'kimi' });
    assert.deepEqual(store.getProviderSelections(), {
        'scope-a': {
            primaryProvider: 'codex',
            selectedProviders: ['codex', 'claude'],
        },
    });
    await store.setExpanded('scope-c', true);
    await store.setExpanded('', true);
    await store.setActiveProvider('scope-d', 'claude');
    await store.setActiveProvider('scope-e', 'unknown');
    await store.setProviderSelection('scope-d', {
        primaryProvider: 'claude',
        selectedProviders: ['claude', 'kimi'],
    });
    await store.setProviderSelection('scope-e', {
        primaryProvider: 'codex',
        selectedProviders: ['codex', 'claude', 'unknown', 'claude', 'kimi'],
    });
    await store.setProviderSelection('scope-f', {
        primaryProvider: 'unknown',
        selectedProviders: [],
    });
    assert.deepEqual(state.values['workspaceExpandedAiSessions.v2'], [
        'scope-a', 'scope-b', 'scope-c',
    ]);
    assert.deepEqual(state.values['workspaceActiveAiSessionProvider.v2'], {
        'scope-a': 'codex', 'scope-c': 'kimi', 'scope-d': 'claude',
        'scope-e': 'codex', 'scope-f': 'codex',
    });
    assert.deepEqual(state.values['workspaceAiSessionProviderSelection.v1']['scope-d'], {
        primaryProvider: 'claude',
        selectedProviders: ['claude', 'kimi'],
    });
    assert.equal(
        state.values['workspaceActiveAiSessionProvider.v2']['scope-d'],
        'claude'
    );
    assert.deepEqual(state.values['workspaceAiSessionProviderSelection.v1']['scope-e'], {
        primaryProvider: 'codex',
        selectedProviders: ['codex', 'kimi', 'claude'],
    });
    assert.equal(
        state.values['workspaceActiveAiSessionProvider.v2']['scope-e'],
        'codex'
    );
    assert.deepEqual(state.values['workspaceAiSessionProviderSelection.v1']['scope-f'], {
        primaryProvider: 'codex',
        selectedProviders: ['codex'],
    });
    assert.equal(
        state.values['workspaceActiveAiSessionProvider.v2']['scope-f'],
        'codex'
    );
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 rolls back both provider records when the legacy write fails', async () => {
    const combinedKey = 'workspaceAiSessionProviderSelection.v1';
    const legacyKey = 'workspaceActiveAiSessionProvider.v2';
    const values = {
        [combinedKey]: {
            'scope-a': {
                primaryProvider: 'codex',
                selectedProviders: ['codex'],
            },
        },
        [legacyKey]: { 'scope-a': 'codex' },
    };
    const updates = [];
    let legacyWriteFailed = false;
    const store = new AiSessionWorkspaceStateStore({
        get: key => values[key],
        async update(key, value) {
            updates.push([key, value]);
            values[key] = value;
            if (key === legacyKey && !legacyWriteFailed) {
                legacyWriteFailed = true;
                throw new Error('controlled legacy write failure');
            }
        },
    }, value => value === 'codex' || value === 'kimi' || value === 'claude');

    await assert.rejects(
        store.setProviderSelection('scope-a', {
            primaryProvider: 'claude',
            selectedProviders: ['claude', 'codex'],
        }),
        /controlled legacy write failure/
    );

    assert.deepEqual(values[combinedKey], {
        'scope-a': {
            primaryProvider: 'codex',
            selectedProviders: ['codex'],
        },
    });
    assert.deepEqual(values[legacyKey], { 'scope-a': 'codex' });
    assert.deepEqual(updates.map(([key]) => key), [
        combinedKey,
        legacyKey,
        legacyKey,
        combinedKey,
    ]);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 rejects without false success when provider-record rollback also fails', async () => {
    const combinedKey = 'workspaceAiSessionProviderSelection.v1';
    const legacyKey = 'workspaceActiveAiSessionProvider.v2';
    const values = {
        [combinedKey]: {
            'scope-a': {
                primaryProvider: 'codex',
                selectedProviders: ['codex'],
            },
        },
        [legacyKey]: { 'scope-a': 'codex' },
    };
    let combinedWrites = 0;
    let legacyWrites = 0;
    const store = new AiSessionWorkspaceStateStore({
        get: key => values[key],
        async update(key, value) {
            if (key === combinedKey) {
                combinedWrites += 1;
                if (combinedWrites === 2) {
                    throw new Error('controlled rollback failure');
                }
                values[key] = value;
                return;
            }
            legacyWrites += 1;
            values[key] = value;
            if (legacyWrites === 1) {
                throw new Error('controlled legacy write failure');
            }
        },
    }, value => value === 'codex' || value === 'kimi' || value === 'claude');

    await assert.rejects(
        store.setProviderSelection('scope-a', {
            primaryProvider: 'claude',
            selectedProviders: ['claude', 'codex'],
        })
    );

    assert.deepEqual(values[combinedKey]['scope-a'], {
        primaryProvider: 'claude',
        selectedProviders: ['claude', 'codex'],
    });
    assert.deepEqual(values[legacyKey], { 'scope-a': 'codex' });
    assert.equal(combinedWrites, 2);
    assert.equal(legacyWrites, 2);
});

test('TODO-TODO-STORE-001 preserves unversioned V1 data while dropping duplicate, orphaned, and missing-field records', () => {
    const normalized = normalizeTodoData({
        groups: [
            { id: 'group', title: ' Group ', collapsed: false, order: 0 },
            { id: 'group', title: 'Duplicate', collapsed: false, order: 1 },
            { title: 'Missing ID', order: 2 },
        ],
        todos: [
            {
                id: 'todo', groupId: 'group', title: ' Keep ', notes: ' note ', priority: 'high',
                completed: false, createdAt: '2026-07-18T00:00:00.000Z',
                updatedAt: '2026-07-18T00:00:00.000Z', order: 0,
            },
            { id: 'todo', groupId: 'group', title: 'Duplicate', order: 1 },
            { id: 'orphan', groupId: 'missing', title: 'Orphan', order: 2 },
            { groupId: 'group', title: 'Missing ID', order: 3 },
        ],
    });

    assert.deepEqual(normalized.groups, [
        { id: 'group', title: 'Group', collapsed: false, order: 0 },
    ]);
    assert.deepEqual(normalized.todos.map(todo => [todo.id, todo.title, todo.notes]), [
        ['todo', 'Keep', 'note'],
    ]);
    assert.throws(() => normalizeTodoData({ version: 2 }), /Unsupported TODO data version/);
});

test('PERSIST-AI-SESSION-TERMINAL-BINDING-STORE-001 PERSIST-AI-SESSION-TERMINAL-PERSISTENCE-001 preserves workspace-bound records and rejects missing or oversized fields', async () => {
    const processId = 42001;
    const legacyProcessId = 42002;
    const missingProcessId = 42003;
    const workspaceIdentity = {
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work/project'],
        cwd: '/work/project',
    };
    const state = makeState({
        [`${AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX}${legacyProcessId}`]: {
            version: 2,
            state: 'bound',
            providerId: 'kimi',
            sessionId: 'legacy',
            markerPath: '/tmp/legacy.done',
            runStartedAtMs: 1,
            updatedAtMs: 2,
            ...workspaceIdentity,
        },
        [`${AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX}${missingProcessId}`]: {
            version: 2,
            state: 'bound',
            providerId: 'codex',
            markerPath: '/tmp/missing.done',
            runStartedAtMs: 1,
            updatedAtMs: 2,
        },
    });
    const store = new AiSessionTerminalBindingStore(state.memento, undefined, () => NOW);

    assert.equal(store.get(legacyProcessId).sessionId, 'legacy');
    assert.equal(store.get(missingProcessId), null);
    store.setPending(processId, {
        providerId: 'codex',
        markerPath: '/tmp/valid.done',
        ...workspaceIdentity,
        pendingId: 'pending-valid',
        createdAt: '2026-07-18T10:00:00.000Z',
        excludedSessionIds: ['older'],
        title: 'Valid pending binding',
    });
    await store.flush();
    assert.deepEqual(store.get(processId).excludedSessionIds, ['older']);
    store.setBound(processId, {
        providerId: 'codex',
        sessionId: 'valid',
        markerPath: '/tmp/valid.done',
        runStartedAtMs: NOW,
        ...workspaceIdentity,
    });
    store.setBound(42004, {
        providerId: 'codex',
        sessionId: 'oversized',
        markerPath: `/${'x'.repeat(4097)}`,
        runStartedAtMs: NOW,
        ...workspaceIdentity,
    });
    await store.flush();
    assert.equal(new AiSessionTerminalBindingStore(state.memento).get(processId).sessionId, 'valid');
    assert.equal(new AiSessionTerminalBindingStore(state.memento).get(42004), null);

    store.setReleased(processId, {
        providerId: 'codex',
        sessionId: 'valid',
        markerPath: '/tmp/valid.done',
        ...workspaceIdentity,
    });
    await store.flush();
    assert.equal(store.get(processId).state, 'released');
    store.remove(processId);
    await store.flush();
    assert.equal(store.get(processId), null);
});

test('RUNTIME-TMUX-STORE-001 ignores corrupt, oversized, partially written, and stale binding files', async t => {
    const fixture = createRuntimeFilesystemFixture(t, 'agent-pivot-persistence-tmux-');
    const binding = makeTmuxKnownBinding('persistence', { lastSeenAtMs: NOW });
    const store = new TmuxRuntimeBindingStore(fixture.root, () => NOW);
    await store.setKnown(binding);
    assert.deepEqual(await store.listKnown(), [binding]);

    const [recordName] = fs.readdirSync(fixture.root).filter(name => name.endsWith('.json'));
    const recordPath = fixture.resolve(recordName);
    fs.writeFileSync(recordPath, '{"version":1', 'utf8');
    fs.writeFileSync(fixture.resolve('.interrupted.tmp'), JSON.stringify(binding), 'utf8');
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => NOW).listKnown(), []);

    fs.writeFileSync(recordPath, 'x'.repeat(1024 * 1024 + 1), 'utf8');
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => NOW).listKnown(), []);

    await store.setKnown(binding);
    const staleNow = NOW + (31 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => staleNow).listKnown(), []);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-LIFECYCLE-001 ignores corrupt, oversized, and partial files while rejecting stale sequences', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-persistence-attention-');
    const store = new ProductionAttentionStore(root, 'persistence');
    const snapshot = makeAttentionSnapshot(2);
    await store.write(snapshot, NOW, 'fixture');
    await assert.rejects(store.write(makeAttentionSnapshot(1), NOW + 1, 'fixture'), /sequence decreased/);
    assert.deepEqual((await store.scan(NOW)).snapshots, [snapshot]);

    const ownerPath = path.join(root, 'instances', `${snapshot.instanceId}.json`);
    fs.writeFileSync(ownerPath, '{"storageVersion":1', 'utf8');
    fs.writeFileSync(path.join(root, 'instances', `${snapshot.instanceId}.partial.tmp`), '{}', 'utf8');
    assert.deepEqual((await new ProductionAttentionStore(root, 'reader').scan(NOW)).snapshots, []);

    fs.writeFileSync(ownerPath, 'x'.repeat(256 * 1024 + 1), 'utf8');
    assert.deepEqual((await new ProductionAttentionStore(root, 'reader').scan(NOW)).snapshots, []);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-CLOCK-001 expires attention by receipt time', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-persistence-attention-clock-');
    const store = new ProductionAttentionStore(root, 'clock');
    const snapshot = makeAttentionSnapshot();
    await store.write(snapshot, NOW, 'fixture');
    assert.deepEqual((await store.scan(NOW + 90_000)).snapshots, [snapshot]);
    assert.deepEqual((await store.scan(NOW + 90_001)).snapshots, []);
});

test('PERSIST-STORE-001 counts corrupt and oversized open-workspace records, ignores partial writes, and expires stale leases', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-persistence-open-workspace-');
    const registration = makeRegistration(SELF, NOW, '/work/project', {
        leaseUpdatedAtMs: NOW,
        sequence: 2,
    });
    const store = new OpenWorkspaceStore(root, SELF);
    await store.write(registration);
    assert.deepEqual((await store.scan(NOW)).registrations, [registration]);
    await assert.rejects(store.write({ ...registration, sequence: 1 }), /sequence decreased/);

    const instances = path.join(root, 'open-workspaces', 'v3', 'instances');
    const ownerPath = path.join(instances, `${SELF}.json`);
    fs.writeFileSync(ownerPath, '{"protocolVersion":1', 'utf8');
    fs.writeFileSync(path.join(instances, `${SELF}.partial.tmp`), '{}', 'utf8');
    const corrupt = await new OpenWorkspaceStore(root, SELF).scan(NOW);
    assert.deepEqual(corrupt.registrations, []);
    assert.equal(corrupt.counters.parseErrors, 1);

    fs.writeFileSync(ownerPath, 'x'.repeat(256 * 1024 + 1), 'utf8');
    const oversized = await new OpenWorkspaceStore(root, SELF).scan(NOW);
    assert.deepEqual(oversized.registrations, []);
    assert.equal(oversized.counters.oversizedFiles, 1);

    fs.writeFileSync(ownerPath, `${JSON.stringify(registration)}\n`, 'utf8');
    const stale = await new OpenWorkspaceStore(root, SELF).scan(NOW + OPEN_WORKSPACE_LEASE_MS + 1);
    assert.deepEqual(stale.registrations, []);
    assert.equal(stale.counters.expired, 1);
});
