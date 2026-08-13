'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
    createTmuxRuntimeHarness,
    fakeCreateRequest,
    workspaceIdentity,
} = require('../../helpers/runtimeContract');
const { buildReadableTmuxLocator } = require('../../../out/aiSessions/tmuxNaming');

async function seedPending(layout, pendingId = `pending-${layout}-1`) {
    const harness = createTmuxRuntimeHarness(layout);
    const request = fakeCreateRequest(pendingId);
    const pendingRuntime = await harness.backend.ensurePending(request, layout);
    return { harness, request, pendingRuntime };
}

function renameCounts(harness) {
    return {
        sessions: harness.operations.filter(item => item.type === 'rename-session').length,
        windows: harness.operations.filter(item => item.type === 'rename-window').length,
    };
}

function failNextRenameWindow(harness) {
    const client = harness.dependencies.client;
    const realRenameWindow = client.renameWindow;
    let failures = 1;
    client.renameWindow = async (sessionName, windowName, nextName) => {
        if (failures-- > 0) {
            throw new Error('injected rename failure');
        }
        return realRenameWindow(sessionName, windowName, nextName);
    };
}

function legacyPromotionFingerprint(binding, intent) {
    return createHash('sha256').update(JSON.stringify([
        2,
        binding.provider,
        binding.workspaceScopeIdentity,
        binding.workspaceNavigationIdentity,
        binding.workspaceRootHostPaths.slice().sort(),
        binding.pendingId,
        binding.cwd,
        binding.createdAt,
        binding.excludedSessionIds,
        binding.title ?? null,
        binding.acceptedAtMs,
        binding.layout,
        binding.locator,
        intent.markerPath,
        intent.finalSessionName,
        intent.finalLocator,
    ]), 'utf8').digest('hex');
}

function asLegacyV2Binding(record) {
    const clone = structuredClone(record);
    clone.version = 2;
    delete clone.writableRootHostPaths;
    delete clone.worktreeKey;
    return clone;
}

function downgradeLiveMetadataToV2(harness) {
    for (const row of harness.windows) {
        row.sessionMetadata.version = '2';
        row.windowMetadata.version = '2';
        delete row.sessionMetadata.writableRootHostPaths;
        delete row.sessionMetadata.worktreeKey;
        delete row.windowMetadata.writableRootHostPaths;
        delete row.windowMetadata.worktreeKey;
        row.metadata = { ...row.sessionMetadata, ...row.windowMetadata };
    }
}

test('RUNTIME-TMUX-BACKEND-001 [tmux session] promotion persists known/consumed, clears pending, and migrates attach', async () => {
    const { harness, request, pendingRuntime } = await seedPending('session');
    const promoted = await harness.backend.promotePending(request.identity, 'final-1', 'Final One');

    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-1');
    assert.equal(promoted[0].state, 'active');
    assert.equal(promoted[0].backend, 'tmux');
    assert.ok(harness.store.known.has('codex:final-1'), 'final binding must be persisted as known');
    assert.deepEqual(harness.store.known.get('codex:final-1').locator, promoted[0].tmux);
    assert.equal(harness.store.consumed.size, 1);
    const consumed = [...harness.store.consumed.values()][0];
    assert.equal(consumed.pendingId, request.identity.pendingId);
    assert.equal(consumed.finalSessionId, 'final-1');
    assert.equal(consumed.finalSessionName, 'Final One');
    assert.equal(consumed.layout, 'session');
    assert.deepEqual(consumed.finalLocator, promoted[0].tmux);
    assert.equal(harness.store.pending.size, 0, 'pending record must be removed by cleanup');
    assert.equal(harness.store.promoting.size, 0, 'promoting intent must be removed by cleanup');
    assert.equal(promoted[0].attached, true, 'attach must migrate to the promoted runtime');
    assert.equal(promoted[0].terminal, pendingRuntime.terminal);
    assert.equal(harness.detachCount(), 0, 'promotion must not dispose the attached terminal');
    assert.equal(harness.providerCreateCount(), 1, 'promotion must not dispatch another provider command');
    assert.equal(harness.backend.getPending().length, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux project] promotion renames the window inside the same session', async () => {
    const { harness, request, pendingRuntime } = await seedPending('project');
    const before = renameCounts(harness);
    const promoted = await harness.backend.promotePending(request.identity, 'final-p', 'Final Project');

    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-p');
    assert.equal(promoted[0].tmux.layout, 'project');
    assert.equal(promoted[0].tmux.sessionName, pendingRuntime.tmux.sessionName,
        'project promotion keeps the pending session and renames only the window');
    assert.notEqual(promoted[0].tmux.windowName, pendingRuntime.tmux.windowName);
    const after = renameCounts(harness);
    assert.equal(after.sessions - before.sessions, 0, 'project promotion must not rename sessions');
    assert.equal(after.windows - before.windows, 1, 'project promotion renames exactly one window');
    assert.ok(harness.store.known.has('codex:final-p'));
    assert.equal(harness.store.consumed.size, 1);
    assert.equal(harness.store.pending.size, 0);
    assert.equal(harness.store.promoting.size, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] persisted intent resumes through a reloaded backend without dispatch', async () => {
    const { harness, request } = await seedPending('session');
    failNextRenameWindow(harness);
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-r', 'Final Reload'),
        /injected rename failure/
    );
    assert.equal(harness.store.promoting.size, 1, 'intent must survive the failed transition');
    assert.equal(harness.store.pending.size, 1);

    const reloaded = harness.createReloadedBackend();
    const promoted = await reloaded.promotePending(request.identity, 'final-r', 'Final Reload');
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-r');
    assert.equal(harness.providerCreateCount(), 1, 'resumed promotion must not dispatch again');
    assert.ok(harness.store.known.has('codex:final-r'));
    assert.equal(harness.store.consumed.size, 1);
    assert.equal(harness.store.pending.size, 0);
    assert.equal(harness.store.promoting.size, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] v2 pending state promotes and rewrites v3 ownership', async () => {
    const { harness, request } = await seedPending('session');
    const legacyPending = asLegacyV2Binding(
        harness.store.pending.get(request.identity.pendingId)
    );
    harness.store.pending.set(request.identity.pendingId, legacyPending);
    downgradeLiveMetadataToV2(harness);

    const promoted = await harness.createReloadedBackend().promotePending(
        request.identity, 'final-v2-upgrade', 'Final V2 Upgrade'
    );
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-v2-upgrade');
    assert.equal(harness.store.known.get('codex:final-v2-upgrade').version, 3);
    assert.equal([...harness.store.consumed.values()][0].version, 3);
    assert.ok(harness.windows.every(row => row.sessionMetadata.version === '3'
        && row.windowMetadata.version === '3'));
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] v2 live metadata and promotion intent resume after upgrade', async () => {
    const { harness, request } = await seedPending('session');
    failNextRenameWindow(harness);
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-v2', 'Final Legacy'),
        /injected rename failure/
    );

    const [intentKey, currentIntent] = [...harness.store.promoting.entries()][0];
    const legacyPending = asLegacyV2Binding(currentIntent.pendingBinding);
    const legacyIntent = asLegacyV2Binding({
        ...currentIntent,
        pendingBinding: legacyPending,
    });
    legacyIntent.requestFingerprint = legacyPromotionFingerprint(legacyPending, legacyIntent);
    harness.store.pending.set(request.identity.pendingId, legacyPending);
    harness.store.promoting.set(intentKey, legacyIntent);
    downgradeLiveMetadataToV2(harness);

    const promoted = await harness.createReloadedBackend().promotePending(
        request.identity, 'final-v2', 'Final Legacy'
    );
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-v2');
    assert.equal(harness.providerCreateCount(), 1, 'legacy recovery must not dispatch again');
    assert.equal(harness.store.promoting.size, 0);
    assert.equal(harness.store.pending.size, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] consumed tombstone makes a repeated promote return the final runtime', async () => {
    const { harness, request } = await seedPending('session');
    const first = await harness.backend.promotePending(request.identity, 'final-1', 'Final One');
    assert.equal(first.length, 1);
    assert.equal(harness.store.pending.size, 0, 'cleanup removed the pending record');
    // Simulate a crash between persistConsumed and removePending: the pending
    // record is still present while the consumed tombstone already exists.
    const resurrected = {
        version: 2, state: 'pending', pendingId: request.identity.pendingId,
        provider: request.identity.provider,
        workspaceScopeIdentity: request.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: request.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...request.identity.workspaceRootHostPaths],
        cwd: request.identity.cwd, createdAt: request.createdAt,
        excludedSessionIds: [...request.excludedSessionIds], acceptedAtMs: 1,
        layout: 'session', locator: { ...first[0].tmux, sessionName: 'ap-pending-source' },
        title: request.title, projectName: request.projectName,
    };
    await harness.store.setPending(resurrected);

    const before = renameCounts(harness);
    const second = await harness.backend.promotePending(request.identity, 'final-1', 'Final One');
    assert.equal(second.length, 1, 'tombstone promotion returns the existing final runtime');
    assert.equal(second[0].identity.sessionId, 'final-1');
    assert.notEqual(second[0].state, 'conflict');
    const after = renameCounts(harness);
    assert.equal(after.sessions - before.sessions, 0, 'tombstone promotion must not rename again');
    assert.equal(after.windows - before.windows, 0);
    assert.equal(harness.store.consumed.size, 1);
    assert.equal(harness.store.pending.size, 0, 'cleanup removes the resurrected pending record');
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] an existing final runtime yields two conflicts', async () => {
    const { harness, request } = await seedPending('session');
    await harness.backend.promotePending(request.identity, 'final-1', 'Final One');

    const requestB = fakeCreateRequest('pending-b');
    const pendingB = await harness.backend.ensurePending(requestB, 'session');
    assert.equal(pendingB.identity.pendingId, 'pending-b');

    const result = await harness.backend.promotePending(requestB.identity, 'final-1', 'Final One');
    assert.equal(result.length, 2);
    assert.equal(result[0].state, 'conflict');
    assert.equal(result[0].identity.sessionId, 'final-1');
    assert.equal(result[1].state, 'conflict');
    assert.equal(result[1].identity.pendingId, 'pending-b');
    assert.equal(harness.store.consumed.size, 1, 'the conflicted pending must not be consumed');
    assert.equal(harness.store.pending.size, 1, 'the conflicted pending stays pending');
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] a differently named final and an occupied final locator conflict', async () => {
    const { harness, request } = await seedPending('session');
    await harness.backend.promotePending(request.identity, 'final-1', 'Final One');

    const requestB = fakeCreateRequest('pending-b');
    await harness.backend.ensurePending(requestB, 'session');
    const differentlyNamed = await harness.backend.promotePending(
        requestB.identity, 'final-1', 'Another Name'
    );
    assert.equal(differentlyNamed.length, 2);
    assert.equal(differentlyNamed[0].state, 'conflict');
    assert.equal(differentlyNamed[0].identity.sessionId, 'final-1');
    assert.equal(differentlyNamed[1].state, 'conflict');
    assert.equal(differentlyNamed[1].identity.pendingId, 'pending-b');
    assert.equal(harness.store.pending.size, 1, 'the conflicted pending stays pending');

    const requestC = fakeCreateRequest('pending-c');
    await harness.backend.ensurePending(requestC, 'session');
    const finalIdentityC = {
        provider: requestC.identity.provider,
        workspaceScopeIdentity: requestC.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: requestC.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...requestC.identity.workspaceRootHostPaths],
        cwd: requestC.identity.cwd,
        sessionId: 'final-c',
    };
    const occupiedLocator = buildReadableTmuxLocator(finalIdentityC, 'session', {
        projectName: requestC.projectName, sessionName: 'Final C',
    });
    harness.windows.push({
        sessionName: occupiedLocator.sessionName, windowName: 'foreign-window',
        windowId: '@foreign', active: false,
        sessionMetadata: {}, windowMetadata: {}, metadata: {},
    });
    const occupied = await harness.backend.promotePending(requestC.identity, 'final-c', 'Final C');
    assert.equal(occupied.length, 1, 'an occupied final locator conflicts only the pending runtime');
    assert.equal(occupied[0].state, 'conflict');
    assert.equal(occupied[0].identity.pendingId, 'pending-c');
    assert.equal(harness.store.promoting.size, 0, 'occupied promotion must not persist an intent');
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] an ambiguous pending record rejects promotion', async () => {
    const { harness, request } = await seedPending('session');
    await harness.store.setAmbiguous({
        version: 2, state: 'ambiguous',
        provider: request.identity.provider,
        workspaceScopeIdentity: request.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: request.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...request.identity.workspaceRootHostPaths],
        pendingId: request.identity.pendingId,
        cwd: request.identity.cwd,
        createdAt: request.createdAt,
        excludedSessionIds: [...request.excludedSessionIds],
        layout: 'session',
        locator: { layout: 'session', sessionName: 'ap-ambiguous', windowName: 'ai-session' },
        requestFingerprint: 'ambiguous-fixture',
    });
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-1', 'Final One'),
        /ambiguous/
    );
    assert.equal(harness.store.pending.size, 1, 'the ambiguous pending is left untouched');
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] a persisted intent with a different final session id rejects', async () => {
    const { harness, request } = await seedPending('session');
    failNextRenameWindow(harness);
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-1', 'Final One'),
        /injected rename failure/
    );
    assert.equal(harness.store.promoting.size, 1);
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-2', 'Final One'),
        /conflicting promotion/
    );
    assert.equal(harness.store.pending.size, 1, 'the conflicted pending stays pending');
    assert.equal(harness.store.promoting.size, 1, 'the original intent survives the conflict');
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] a fully landed transition completes on retry', async () => {
    const { harness, request } = await seedPending('session');
    const store = harness.dependencies.runtimeStore;
    const realSetKnown = store.setKnown;
    let failKnown = 1;
    store.setKnown = async record => {
        if (failKnown-- > 0) {
            throw new Error('injected known failure');
        }
        return realSetKnown(record);
    };
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-1', 'Final One'),
        /injected known failure/
    );
    assert.equal(harness.store.promoting.size, 1, 'the intent survives the failed completion');
    assert.equal(harness.store.consumed.size, 0);

    const promoted = await harness.backend.promotePending(request.identity, 'final-1', 'Final One');
    assert.equal(promoted.length, 1, 'the landed transition completes without renaming again');
    assert.equal(promoted[0].identity.sessionId, 'final-1');
    assert.ok(harness.store.known.has('codex:final-1'));
    assert.equal(harness.store.consumed.size, 1);
    assert.equal(harness.store.pending.size, 0);
    assert.equal(harness.store.promoting.size, 0);
    assert.equal(harness.providerCreateCount(), 1);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] a partially renamed runtime completes on retry', async () => {
    const { harness, request } = await seedPending('session');
    failNextRenameWindow(harness);
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-1', 'Final One'),
        /injected rename failure/
    );
    assert.equal(harness.store.promoting.size, 1);

    const promoted = await harness.backend.promotePending(request.identity, 'final-1', 'Final One');
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].identity.sessionId, 'final-1');
    assert.ok(harness.store.known.has('codex:final-1'));
    assert.equal(harness.store.consumed.size, 1);
    assert.equal(harness.store.pending.size, 0);
    assert.equal(harness.store.promoting.size, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] a failed rename with an intact source rejects and drops the intent', async () => {
    const { harness, request } = await seedPending('session');
    const client = harness.dependencies.client;
    const realRenameSession = client.renameSession;
    client.renameSession = async () => {
        throw new Error('injected rename failure');
    };
    await assert.rejects(
        harness.backend.promotePending(request.identity, 'final-1', 'Final One'),
        /injected rename failure/
    );
    client.renameSession = realRenameSession;
    assert.equal(harness.store.promoting.size, 0,
        'an intact source and a free final locator roll the intent back');
    assert.equal(harness.store.pending.size, 1, 'the pending record survives the failed rename');
    assert.equal(harness.store.consumed.size, 0);
});

test('RUNTIME-TMUX-BACKEND-001 [tmux session] invalid input and unknown pendings promote to nothing', async () => {
    const { harness, request } = await seedPending('session');
    assert.deepEqual(await harness.backend.promotePending(request.identity, '', 'Final One'), []);
    assert.deepEqual(await harness.backend.promotePending(request.identity, 'final-1', ''), []);
    assert.deepEqual(
        await harness.backend.promotePending(workspaceIdentity({ pendingId: 'never-seen' }),
            'final-1', 'Final One'),
        []
    );
    assert.equal(harness.store.promoting.size, 0);
    assert.equal(harness.store.consumed.size, 0);
    assert.equal(renameCounts(harness).sessions, 0, 'invalid input must not mutate tmux');
});
