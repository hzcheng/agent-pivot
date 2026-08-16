'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isBoundedOptionalLocalPath,
    isIdentityField,
    isLocalPath,
    materializePendingRequest,
    materializeResumeRequest,
    snapshotPendingRequest,
    snapshotResumeRequest,
    validateDispatchIdentity,
} = require('../../../out/aiSessions/tmuxRuntimeRequest');

function directoryScope() {
    return {
        workspaceNavigationIdentity: 'navigation:fixture', workspaceScopeIdentity: 'scope:fixture',
        workspaceRootHostPaths: ['/work/a'], primaryRootId: 'root:fixture', primaryCwd: '/work/a',
        additionalDirectories: [],
    };
}

function resumeIdentity(overrides = {}) {
    return {
        provider: 'codex',
        workspaceScopeIdentity: 'scope-a',
        workspaceNavigationIdentity: 'navigation-a',
        workspaceRootHostPaths: ['/work/a'],
        cwd: '/work/a',
        sessionId: 'session-123456789',
        ...overrides,
    };
}

function pendingIdentity(overrides = {}) {
    return {
        provider: 'kimi',
        workspaceScopeIdentity: 'scope-a',
        workspaceNavigationIdentity: 'navigation-a',
        workspaceRootHostPaths: ['/work/a'],
        cwd: '/work/a',
        pendingId: 'pending-123456789',
        ...overrides,
    };
}

function launch(overrides = {}) {
    return {
        executable: 'provider-tool',
        args: ['--flag', 'value'],
        ...overrides,
    };
}

function resumeRequest(overrides = {}) {
    return {
        identity: resumeIdentity(),
        projectName: 'Project Alpha',
        sessionName: 'Fix replication',
        terminalName: 'Agent Pivot: codex',
        directoryScope: directoryScope(),
        launch: launch(),
        ...overrides,
    };
}

function pendingRequest(overrides = {}) {
    return {
        identity: pendingIdentity(),
        projectName: 'Project Alpha',
        terminalName: 'Agent Pivot: kimi',
        createdAt: '2026-01-02T03:04:05.000Z',
        excludedSessionIds: ['session-old-1', 'session-old-2'],
        directoryScope: directoryScope(),
        launch: launch(),
        ...overrides,
    };
}

test('RUNTIME-TMUX-BACKEND-001 snapshots resume and pending requests through happy paths', () => {
    const request = resumeRequest();
    const deferred = snapshotResumeRequest(request);
    assert.deepEqual(deferred.identity, resumeIdentity());
    assert.notEqual(deferred.identity, request.identity);
    assert.notEqual(deferred.identity.workspaceRootHostPaths, request.identity.workspaceRootHostPaths);
    assert.equal(deferred.projectName, 'Project Alpha');
    assert.equal(deferred.sessionName, 'Fix replication');
    assert.equal(deferred.terminalName, 'Agent Pivot: codex');
    assert.equal(deferred.launchMarkerPath, '');
    assert.equal(deferred.directoryScope, request.directoryScope);
    assert.deepEqual(deferred.createLaunchSpec(), launch());

    const pending = pendingRequest({ title: 'Triage alerts' });
    const deferredPending = snapshotPendingRequest(pending);
    assert.deepEqual(deferredPending.identity, pendingIdentity());
    assert.equal(deferredPending.createdAt, '2026-01-02T03:04:05.000Z');
    assert.deepEqual(deferredPending.excludedSessionIds, ['session-old-1', 'session-old-2']);
    assert.notEqual(deferredPending.excludedSessionIds, pending.excludedSessionIds);
    assert.equal(deferredPending.title, 'Triage alerts');
    assert.equal(deferredPending.directoryScope, pending.directoryScope);
    assert.deepEqual(deferredPending.createLaunchSpec(), launch());

    const untitled = snapshotPendingRequest(pendingRequest());
    assert.equal(Object.prototype.hasOwnProperty.call(untitled, 'title'), false);
});

test('RUNTIME-TMUX-BACKEND-001 falls back to the session id for display names and bounds them', () => {
    const deferred = snapshotResumeRequest(resumeRequest({ sessionName: undefined }));
    assert.equal(deferred.sessionName, 'session-123456789');
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ sessionName: 'x'.repeat(201) })),
        /display name is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ sessionName: 'bad\u0007name' })),
        /display name is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ sessionName: 42 })),
        /shape is invalid/
    );
});

test('RUNTIME-TMUX-BACKEND-001 rejects non-record requests, identities, and launches', () => {
    assert.throws(() => snapshotResumeRequest(null), /shape is invalid/);
    assert.throws(() => snapshotResumeRequest(['not', 'a', 'record']), /shape is invalid/);
    assert.throws(() => snapshotPendingRequest('nope'), /shape is invalid/);
    assert.throws(() => snapshotResumeRequest(resumeRequest({ identity: null })), /shape is invalid/);
    assert.throws(() => snapshotPendingRequest(pendingRequest({ identity: ['bad'] })), /shape is invalid/);
    assert.throws(() => snapshotResumeRequest(resumeRequest({ launch: 42 })), /shape is invalid/);
    assert.throws(() => snapshotResumeRequest(resumeRequest({ projectName: 7 })), /shape is invalid/);
    assert.throws(() => snapshotPendingRequest(pendingRequest({ createdAt: undefined })), /shape is invalid/);
    assert.throws(() => snapshotPendingRequest(pendingRequest({ title: 9 })), /shape is invalid/);
});

test('RUNTIME-TMUX-BACKEND-001 requires dense bounded string arrays', () => {
    const sparse = ['a', , 'b'];
    assert.throws(() => snapshotResumeRequest(resumeRequest({ launch: launch({ args: sparse }) })), /dense/);
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ args: ['a', 1] }) })),
        /dense/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ args: 'nope' }) })),
        /must be an array/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ args: new Array(257).fill('a') }) })),
        /too many/
    );
    assert.throws(
        () => snapshotPendingRequest(pendingRequest({ excludedSessionIds: new Array(1001).fill('s') })),
        /too many/
    );
    const sparseExclusions = ['a', , 'b'];
    assert.throws(
        () => snapshotPendingRequest(pendingRequest({ excludedSessionIds: sparseExclusions })),
        /dense/
    );
});

test('RUNTIME-TMUX-BACKEND-001 honors the createLaunchSpec function path', () => {
    const request = resumeRequest();
    delete request.launch;
    request.launchMarkerPath = '/tmp/marker';
    const factory = () => ({ executable: 'fn-tool', args: ['run'] });
    request.createLaunchSpec = factory;
    const deferred = snapshotResumeRequest(request);
    assert.equal(deferred.launchMarkerPath, '/tmp/marker');
    assert.equal(deferred.createLaunchSpec, factory);
    assert.throws(() => {
        const invalid = resumeRequest();
        delete invalid.launch;
        invalid.createLaunchSpec = factory;
        snapshotResumeRequest(invalid);
    }, /launch marker is invalid/);
});

test('RUNTIME-TMUX-BACKEND-001 resolves launchMarkerPath fallback and explicit override', () => {
    const fromMarker = snapshotResumeRequest(resumeRequest({ launch: launch({ markerPath: '/tmp/m' }) }));
    assert.equal(fromMarker.launchMarkerPath, '/tmp/m');
    const override = snapshotResumeRequest(resumeRequest({
        launch: launch({ markerPath: '/tmp/m' }),
        launchMarkerPath: '/tmp/override',
    }));
    assert.equal(override.launchMarkerPath, '/tmp/override');
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch(), launchMarkerPath: 42 })),
        /shape is invalid/
    );
});

test('RUNTIME-TMUX-BACKEND-001 materializes deferred requests with cloned identities', () => {
    const deferred = snapshotResumeRequest(resumeRequest({ launch: launch({ markerPath: '/tmp/m' }) }));
    const materialized = materializeResumeRequest(deferred);
    assert.equal(materialized.launchMarkerPath, '/tmp/m');
    assert.deepEqual(materialized.launch, launch({ markerPath: '/tmp/m' }));
    assert.deepEqual(materialized.identity, deferred.identity);
    assert.notEqual(materialized.identity, deferred.identity);
    assert.equal(materialized.sessionName, 'Fix replication');

    const deferredPending = snapshotPendingRequest(pendingRequest({ title: 'Triage' }));
    const materializedPending = materializePendingRequest(deferredPending);
    assert.deepEqual(materializedPending.launch, launch());
    assert.deepEqual(materializedPending.excludedSessionIds, ['session-old-1', 'session-old-2']);
    assert.notEqual(materializedPending.excludedSessionIds, deferredPending.excludedSessionIds);
    assert.equal(materializedPending.title, 'Triage');
    assert.notEqual(materializedPending.identity, deferredPending.identity);
});

test('RUNTIME-TMUX-WORKTREE-REQUEST-001 snapshots v3 identity fields defensively', () => {
    const identity = resumeIdentity({
        workspaceRootHostPaths: ['/repos/frontend', '/repos/backend'],
        writableRootHostPaths: ['/managed/frontend-feature', '/repos/backend'],
        worktreeKey: {
            repositoryKey: '/repos/frontend/.git',
            canonicalWorktreePath: '/managed/frontend-feature',
        },
        cwd: '/managed/frontend-feature',
    });
    const deferred = snapshotResumeRequest(resumeRequest({ identity }));

    assert.deepEqual(deferred.identity, identity);
    assert.notEqual(deferred.identity.writableRootHostPaths, identity.writableRootHostPaths);
    assert.notEqual(deferred.identity.worktreeKey, identity.worktreeKey);
    identity.writableRootHostPaths.push('/mutated');
    identity.worktreeKey.canonicalWorktreePath = '/mutated';
    assert.deepEqual(deferred.identity.writableRootHostPaths, [
        '/managed/frontend-feature', '/repos/backend',
    ]);
    assert.equal(deferred.identity.worktreeKey.canonicalWorktreePath, '/managed/frontend-feature');
});

test('RUNTIME-TMUX-BACKEND-001 rejects launch specs whose marker changes before dispatch', () => {
    const deferred = snapshotResumeRequest(resumeRequest({ launch: launch({ markerPath: '/tmp/m' }) }));
    const tampered = {
        ...deferred,
        createLaunchSpec: () => launch({ markerPath: '/tmp/other' }),
    };
    assert.throws(() => materializeResumeRequest(tampered), /marker changed before dispatch/);
    const tamperedPending = {
        ...snapshotPendingRequest(pendingRequest()),
        createLaunchSpec: () => launch({ markerPath: '/tmp/other' }),
    };
    assert.throws(() => materializePendingRequest(tamperedPending), /marker changed before dispatch/);
});

test('RUNTIME-TMUX-BACKEND-001 validates executable, arguments, cwd, and marker paths', () => {
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ executable: '' }) })),
        /provider executable is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ executable: 'bad\u000aexec' }) })),
        /provider executable is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ executable: 'x'.repeat(4097) }) })),
        /provider executable is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ args: ['a'.repeat(16 * 1024 + 1)] }) })),
        /launch argument is invalid or too large/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ args: ['nul\u0000byte'] }) })),
        /launch argument is invalid or too large/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ cwd: 'bad\u0007cwd' }) })),
        /provider launch cwd is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ markerPath: 'bad\u0007marker' }) })),
        /provider marker path is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: launch({ windowsDirectShell: 'zsh' }) })),
        /shape is invalid/
    );
    const shell = snapshotResumeRequest(resumeRequest({ launch: launch({ windowsDirectShell: 'powershell' }) }));
    assert.equal(shell.createLaunchSpec().windowsDirectShell, 'powershell');
});

test('RUNTIME-TMUX-BACKEND-001 enforces aggregate and serialized launch budgets', () => {
    const wide = launch({ args: new Array(250).fill('a'.repeat(200)) });
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: wide })),
        /aggregate launch budget/
    );
    const quoted = launch({ args: new Array(230).fill("'".repeat(130)) });
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ launch: quoted })),
        /serialized provider launch exceeds the tmux command budget/
    );
});

test('RUNTIME-TMUX-BACKEND-001 validates dispatch identity shape and whitelist', () => {
    assert.doesNotThrow(() => validateDispatchIdentity(resumeIdentity()));
    assert.doesNotThrow(() => validateDispatchIdentity(pendingIdentity()));
    assert.throws(() => validateDispatchIdentity(null), /cwd is invalid/);
    assert.throws(
        () => validateDispatchIdentity(resumeIdentity({ provider: 'other' })),
        /cwd is invalid/
    );
    assert.throws(
        () => validateDispatchIdentity(resumeIdentity({ pendingId: 'pending-1' })),
        /cwd is invalid/
    );
    assert.throws(
        () => validateDispatchIdentity(resumeIdentity({ sessionId: undefined })),
        /cwd is invalid/
    );
    assert.throws(
        () => validateDispatchIdentity(resumeIdentity({ sessionId: 'has space' })),
        /cwd is invalid/
    );
    assert.throws(
        () => validateDispatchIdentity(resumeIdentity({ cwd: 'bad\u0007cwd' })),
        /cwd is invalid/
    );
    assert.throws(
        () => snapshotResumeRequest(resumeRequest({ identity: resumeIdentity({ sessionId: 'bad id' }) })),
        /cwd is invalid/
    );
});

test('RUNTIME-TMUX-BACKEND-001 bounds identity fields and local paths', () => {
    assert.equal(isIdentityField('session-1'), true);
    assert.equal(isIdentityField(''), false);
    assert.equal(isIdentityField('x'.repeat(512)), true);
    assert.equal(isIdentityField('x'.repeat(513)), false);
    assert.equal(isIdentityField('bad\u000afield'), false);
    assert.equal(isIdentityField(42), false);

    assert.equal(isLocalPath('/tmp/marker'), true);
    assert.equal(isLocalPath(''), false);
    assert.equal(isLocalPath('x'.repeat(4096)), true);
    assert.equal(isLocalPath('x'.repeat(4097)), false);
    assert.equal(isLocalPath('bad\u0007path'), false);
    assert.equal(isLocalPath(undefined), false);

    assert.equal(isBoundedOptionalLocalPath(''), true);
    assert.equal(isBoundedOptionalLocalPath('/tmp/marker'), true);
    assert.equal(isBoundedOptionalLocalPath('x'.repeat(4096)), true);
    assert.equal(isBoundedOptionalLocalPath('x'.repeat(4097)), false);
    assert.equal(isBoundedOptionalLocalPath('bad\u0007path'), false);
    assert.equal(isBoundedOptionalLocalPath(undefined), false);
});
