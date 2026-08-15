'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorkspaceSessionHydrationController,
} = require('../../../out/workspaces/sessionHydrationController');
const { getAttentionProjectKeys } = require('../../../out/aiSessions/attentionProject');

const WORKSPACE = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'savedMultiRoot',
    displayName: 'Fixture',
    navigationUri: 'file:///work/fixture.code-workspace',
    environment: 'local',
    roots: [
        { id: 'root:a', name: 'A', uri: 'file:///work/a', hostPath: '/work/a/', ordinal: 0 },
        { id: 'root:b', name: 'B', uri: 'file:///work/b', hostPath: '/work/b', ordinal: 1 },
    ],
};

const WORKTREE_SNAPSHOT = {
    revision: 12,
    repositories: [{
        repositoryKey: '/work/repo/.git',
        rootBindings: [
            { workspaceRootId: 'root:a', repositoryRelativePath: 'a' },
            { workspaceRootId: 'root:b', repositoryRelativePath: 'b' },
        ],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: {
                repositoryKey: '/work/repo/.git',
                canonicalWorktreePath: '/work',
            },
            branchRef: 'refs/heads/main', head: '1'.repeat(40), isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }, {
            key: {
                repositoryKey: '/work/repo/.git',
                canonicalWorktreePath: '/work-topic',
            },
            branchRef: 'refs/heads/topic', head: '2'.repeat(40), isMain: false,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
    }],
    truncatedWorktreeCount: 3,
};

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-CONTROLLER-001 / WORKTREE-SNAPSHOT-001 / WORKTREE-PRESENTATION-001 preserves scan, projection, runtime, pending, worktree, and diagnostic boundaries', () => {
    let reason = 'refresh';
    let nowMs = 1000;
    const reads = [];
    const diagnostics = [];
    const session = {
        id: 'session-a', name: 'Original', cwd: '/work/a',
        updatedAt: '2026-07-16T10:00:00Z',
    };
    const activeIdentity = {
        provider: 'codex',
        sessionId: 'session-a',
        workspaceScopeIdentity: WORKSPACE.scopeIdentity,
        workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
        workspaceRootHostPaths: ['/work/a', '/work/b'],
        cwd: '/work/a',
    };
    const pendingIdentity = {
        provider: 'kimi',
        pendingId: 'pending-a',
        workspaceScopeIdentity: WORKSPACE.scopeIdentity,
        workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
        workspaceRootHostPaths: ['/work/a', '/work/b'],
        cwd: '/work/b',
    };
    const controller = new WorkspaceSessionHydrationController({
        providers: [
            { id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] },
            { id: 'kimi', label: 'Kimi', terminalCwdFields: ['cwd'] },
        ],
        readCoordinator: {
            getResults: options => {
                reads.push(options);
                return {
                    codex: {
                        available: true, scannedFiles: 2, parsedFiles: 2,
                        sessions: [session, {
                            id: 'session-topic', name: 'Topic', cwd: '/work-topic/a/src',
                            updatedAt: '2026-07-16T11:00:00Z',
                        }, {
                            id: 'session-topic-tools', name: 'Topic tools', cwd: '/work-topic/tools',
                            updatedAt: '2026-07-16T12:00:00Z',
                        }],
                    },
                    kimi: { available: false, scannedFiles: 0, parsedFiles: 0, sessions: [] },
                };
            },
        },
        incrementalScanMaxFiles: 123,
        getRefreshReason: () => reason,
        getSessionComparableCwd: (_provider, value) => value.cwd,
        getPinnedSessions: () => new Set(['codex:session-a']),
        getAliases: () => ({ 'codex:session-a': 'Renamed' }),
        getProviderSelection: scope => scope === WORKSPACE.scopeIdentity
            ? { primaryProvider: 'codex', selectedProviders: ['codex', 'kimi'] }
            : undefined,
        getExpanded: scope => scope === WORKSPACE.scopeIdentity,
        getProjectionSnapshot: () => ({
            revision: 1,
            worktreeSnapshot: WORKTREE_SNAPSHOT,
            activeRuntimes: [{
                identity: activeIdentity,
                backend: 'vscode', state: 'active', markerPath: '/tmp/a.done',
                runStartedAtMs: 1, attached: true,
            }],
            pendingRuntimes: [{
                identity: pendingIdentity,
                backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done',
                runStartedAtMs: 2, attached: false, createdAt: '2026-07-16T10:01:00Z',
                excludedSessionIds: [], title: 'New Kimi',
                tmux: { layout: 'session', sessionName: 'fixture' },
            }],
            executionSnapshot: {
                'codex:session-a': { state: 'running', token: 'run', occurredAtMs: 3 },
            },
            focusedIdentity: activeIdentity,
            attentionAggregate: {
                protocolVersion: 1,
                aggregateRevision: 'a'.repeat(64),
                generatedAtMs: 4,
                sessions: [{
                    projectId: getAttentionProjectKeys(['file:///work/a'])[0],
                    sessionKey: 'codex:session-a',
                    reasons: ['completed'],
                    eventIds: ['event-a'],
                    observedAtMs: 4,
                }],
            },
        }),
        nowMs: () => { nowMs += 7; return nowMs; },
        logDiagnostic: event => diagnostics.push(event),
    });

    assert.equal(controller.hydrate(null), null);
    assert.equal(reads.length, 0);
    assert.deepEqual(diagnostics[0], {
        event: 'workspace-ai-session-hydration',
        reason: 'refresh',
        durationMs: 7,
        workspaceCount: 0,
        candidatePathCount: 0,
        providerCount: 2,
        sessionCount: 0,
    });

    const hydrated = controller.hydrate(WORKSPACE);
    assert.deepEqual(reads[0], {
        candidatePaths: ['/work/a', '/work/b', '/work', '/work-topic'],
        reason: 'refresh',
        maxFiles: 123,
    });
    assert.equal(hydrated.activeProvider, 'codex');
    assert.deepEqual(hydrated.selectedProviders, ['codex', 'kimi']);
    assert.equal(hydrated.expanded, true);
    assert.deepEqual(hydrated.unavailableProviders, ['kimi']);
    assert.equal(hydrated.sessionsByProvider.codex[0].name, 'Renamed');
    assert.equal(hydrated.sessionsByProvider.codex[0].pinned, true);
    assert.deepEqual(hydrated.sessionsByProvider.codex[0].attention, {
        eventId: 'event-a', reason: 'completed', unread: true,
    });
    assert.deepEqual(hydrated.sessionsByProvider.codex.map(item => ({
        id: item.id,
        worktreePath: item.worktreeKey && item.worktreeKey.canonicalWorktreePath,
        primaryRootId: item.primaryRootId,
        outsideWorkspace: item.outsideWorkspace,
    })), [{
        id: 'session-a', worktreePath: '/work', primaryRootId: 'root:a',
        outsideWorkspace: undefined,
    }, {
        id: 'session-topic-tools', worktreePath: '/work-topic', primaryRootId: undefined,
        outsideWorkspace: true,
    }, {
        id: 'session-topic', worktreePath: '/work-topic', primaryRootId: 'root:a',
        outsideWorkspace: undefined,
    }]);
    assert.deepEqual(hydrated.worktrees.map(row => ({
        kind: row.kind,
        path: row.git.key.canonicalWorktreePath,
        activity: row.activity,
        sessions: row.sessions.map(item => item.id),
        authority: row.authority,
    })), [{
        kind: 'ready', path: '/work-topic', activity: 'idle',
        sessions: ['session-topic-tools', 'session-topic'],
        authority: {
            canInput: false, canFocus: false, canStop: false, canResume: true,
            canArchive: true, canRemove: true,
            canTakeControl: false, liveOwnerAvailable: false,
        },
    }], 'unmanaged rows exclude the main checkout and manifest-claimed worktrees');
    assert.deepEqual({
        entries: hydrated.worktreeAnchor.entries,
        activity: hydrated.worktreeAnchor.activity,
        sessions: hydrated.worktreeAnchor.sessions.map(item => item.id),
    }, {
        entries: [{ repositoryLabel: 'repo', branch: 'main' }],
        activity: 'attention',
        sessions: ['session-a'],
    }, 'the main checkout collapses into the anchor with its live sessions');
    assert.deepEqual(hydrated.worktreeGroups, [],
        'no manifest records means no group rows');
    assert.deepEqual(hydrated.unmanagedSessions, []);
    assert.deepEqual(hydrated.unmanagedActiveSessions, []);
    assert.deepEqual(hydrated.activeSessions.map(item => ({
        provider: item.provider,
        pending: item.pending,
        primaryRootId: item.primaryRootId,
        focused: item.focused,
    })), [
        { provider: 'codex', pending: false, primaryRootId: 'root:a', focused: true },
        { provider: 'kimi', pending: true, primaryRootId: 'root:b', focused: false },
    ]);
    assert.equal(diagnostics[1].activeSessionCount, 2);
    assert.equal(diagnostics[1].unavailableProviderCount, 1);
    assert.equal(diagnostics[1].worktreeSnapshotRevision, 12);
    assert.equal(diagnostics[1].worktreeRepositoryCount, 1);
    assert.equal(diagnostics[1].truncatedWorktreeCount, 3);

    reason = 'terminal-candidates';
    controller.hydrate(WORKSPACE);
    assert.equal(reads[1].maxFiles, 0);
});

test('AI-SESSION-QUICK-CREATE-001 hydration carries the quick-create profile into the view model', () => {
    const makeController = (getQuickCreateProfile, getQuickCreateProvider) => new WorkspaceSessionHydrationController({
        providers: [{ id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] }],
        readCoordinator: {
            getResults: () => ({
                codex: { available: true, scannedFiles: 0, parsedFiles: 0, sessions: [] },
            }),
        },
        incrementalScanMaxFiles: 10,
        getRefreshReason: () => 'refresh',
        getSessionComparableCwd: (_provider, value) => value.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getQuickCreateProfile,
        getQuickCreateProvider,
        getProviderSelection: () => undefined,
        getExpanded: () => true,
        getProjectionSnapshot: () => ({
            revision: 1,
            activeRuntimes: [],
            pendingRuntimes: [],
            executionSnapshot: {},
            focusedIdentity: null,
            attentionAggregate: null,
        }),
    });

    const withProfile = makeController(() => 'deepseek').hydrate(WORKSPACE);
    assert.equal(withProfile.quickCreateProfile, 'deepseek',
        'the webview snapshot must name the profile quick-create would launch with');

    const withProvider = makeController(() => undefined, () => 'kimi').hydrate(WORKSPACE);
    assert.equal(withProvider.quickCreateProvider, 'kimi',
        'the webview snapshot must name the provider quick-create remembers');

    const withoutEither = makeController(() => undefined, () => undefined).hydrate(WORKSPACE);
    assert.deepEqual(withoutEither.worktrees, []);
    assert.deepEqual(withoutEither.unmanagedSessions, []);
    assert.deepEqual(withoutEither.unmanagedActiveSessions, []);
    assert.equal(withoutEither.truncatedWorktreeCount, 0);
    assert.equal('quickCreateProfile' in withoutEither, false,
        'no quick-create profile keeps the field out of the view model');
    assert.equal('quickCreateProvider' in withoutEither, false,
        'no remembered provider keeps the field out of the view model');

    const legacy = makeController(undefined).hydrate(WORKSPACE);
    assert.equal('quickCreateProfile' in legacy, false,
        'hosts without the wiring keep the field out of the view model');
    assert.equal('quickCreateProvider' in legacy, false);
});

test('SESSION-WORKTREE-ASSIGNMENT-001 preserves legacy history and active runtimes as unmanaged', () => {
    const identity = {
        provider: 'codex', sessionId: 'legacy-active',
        workspaceScopeIdentity: WORKSPACE.scopeIdentity,
        workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
        workspaceRootHostPaths: ['/old/checkout'], cwd: '/old/checkout',
    };
    const controller = new WorkspaceSessionHydrationController({
        providers: [{ id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] }],
        readCoordinator: {
            getResults: () => ({
                codex: {
                    available: true, scannedFiles: 1, parsedFiles: 1,
                    sessions: [{ id: 'legacy-history', name: 'Legacy', cwd: '/work/a' }],
                },
            }),
        },
        incrementalScanMaxFiles: 10,
        getRefreshReason: () => 'unmanaged-test',
        getSessionComparableCwd: (_provider, session) => session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getProviderSelection: () => undefined,
        getExpanded: () => true,
        getProjectionSnapshot: () => ({
            revision: 1,
            worktreeSnapshot: {
                revision: 4,
                repositories: [{
                    repositoryKey: '/replacement/.git',
                    rootBindings: [{ workspaceRootId: 'root:a', repositoryRelativePath: '' }],
                    worktrees: [{
                        key: {
                            repositoryKey: '/replacement/.git',
                            canonicalWorktreePath: '/replacement/main',
                        },
                        head: '4'.repeat(40), isMain: true, isBare: false,
                        health: 'normal', headKind: 'detached',
                    }],
                }],
                truncatedWorktreeCount: 0,
            },
            activeRuntimes: [{
                identity, backend: 'vscode', state: 'active', markerPath: '/tmp/legacy.done',
                runStartedAtMs: 1, attached: true,
            }],
            pendingRuntimes: [], executionSnapshot: {}, focusedIdentity: null,
            attentionAggregate: null,
        }),
    });

    const hydrated = controller.hydrate(WORKSPACE);
    assert.deepEqual(hydrated.unmanagedSessions.map(session => session.id), ['legacy-history']);
    assert.deepEqual(hydrated.unmanagedActiveSessions.map(session => session.sessionId), ['legacy-active']);
    assert.deepEqual(hydrated.worktrees.map(row => ({
        path: row.git.key.canonicalWorktreePath,
        activity: row.activity,
        sessions: row.sessions.length,
    })), [], 'the main checkout is anchored, never listed as a manageable row');
    assert.deepEqual(hydrated.worktreeAnchor.entries,
        [{ repositoryLabel: 'replacement', branch: '44444444' }]);
});

test('WORKTREE-GROUPS-002 deleted worktrees keep history identity through the manifest fallback', () => {
    const controller = new WorkspaceSessionHydrationController({
        providers: [{ id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] }],
        readCoordinator: {
            getResults: () => ({
                codex: {
                    available: true, scannedFiles: 2, parsedFiles: 2,
                    sessions: [
                        { id: 'inside-repo', name: 'Inside', cwd: '/work-topic/src' },
                        { id: 'outside-root', name: 'Outside', cwd: '/managed/deleted/lib' },
                    ],
                },
            }),
        },
        incrementalScanMaxFiles: 10,
        getRefreshReason: () => 'deleted-worktree',
        getSessionComparableCwd: (_provider, session) => session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getProviderSelection: () => undefined,
        getExpanded: () => true,
        getWorktreeGroups: () => [{
            groupId: 'g-1', displayName: 'Topic', suggestedSlug: 'topic',
            primaryMemberId: 'm-1', createdAt: 1,
            members: [{
                memberId: 'm-1', repositoryKey: '/work/repo/.git',
                worktreeKey: {
                    repositoryKey: '/work/repo/.git',
                    canonicalWorktreePath: '/work-topic',
                },
                branchName: 'agent-pivot/topic', path: '/work-topic', state: 'ready',
            }, {
                memberId: 'm-2', repositoryKey: '/external/repo/.git',
                worktreeKey: {
                    repositoryKey: '/external/repo/.git',
                    canonicalWorktreePath: '/managed/deleted',
                },
                branchName: 'agent-pivot/topic', path: '/managed/deleted', state: 'ready',
            }],
        }],
        getProjectionSnapshot: () => ({
            revision: 1,
            worktreeSnapshot: {
                revision: 4,
                repositories: [{
                    repositoryKey: '/work/repo/.git',
                    rootBindings: [{ workspaceRootId: 'root:a', repositoryRelativePath: 'a' }],
                    worktrees: [{
                        key: {
                            repositoryKey: '/work/repo/.git',
                            canonicalWorktreePath: '/work',
                        },
                        head: '4'.repeat(40), isMain: true, isBare: false,
                        health: 'normal', headKind: 'detached',
                    }],
                }],
                truncatedWorktreeCount: 0,
            },
            activeRuntimes: [], pendingRuntimes: [], executionSnapshot: {},
            focusedIdentity: null, attentionAggregate: null,
        }),
    });

    const hydrated = controller.hydrate(WORKSPACE);
    const byId = Object.fromEntries(
        hydrated.sessionsByProvider.codex.map(session => [session.id, session]));
    assert.deepEqual(byId['inside-repo'].worktreeKey, {
        repositoryKey: '/work/repo/.git',
        canonicalWorktreePath: '/work-topic',
    }, 'a deleted in-repo worktree keeps its identity so resume fails closed');
    assert.equal(byId['inside-repo'].worktreeUnavailable, true);
    assert.deepEqual(byId['outside-root'].worktreeKey, {
        repositoryKey: '/external/repo/.git',
        canonicalWorktreePath: '/managed/deleted',
    }, 'a deleted worktree outside the workspace roots stays in history');
    assert.equal(byId['outside-root'].worktreeUnavailable, true);
});

function retiredFixture(overrides) {
    return {
        retirementId: 'r-1',
        repositoryKey: '/external/repo/.git',
        canonicalWorktreePath: '/managed/deleted',
        branchName: 'agent-pivot/topic',
        deletedAt: Date.parse('2026-08-01T00:00:00Z'),
        generationCutoffAt: Date.parse('2026-08-01T00:00:00Z'),
        origin: { groupId: 'g-1', memberId: 'm-2', displayName: 'Topic' },
        affectedSessions: [],
        ...(overrides || {}),
    };
}

function hydrateWithRetired(sessions, retired, claims) {
    const controller = new WorkspaceSessionHydrationController({
        providers: [{ id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] }],
        readCoordinator: {
            getResults: () => ({
                codex: {
                    available: true, scannedFiles: sessions.length,
                    parsedFiles: sessions.length,
                    sessions,
                },
            }),
        },
        incrementalScanMaxFiles: 10,
        getRefreshReason: () => 'retired-derivation',
        getSessionComparableCwd: (_provider, session) => session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getProviderSelection: () => undefined,
        getExpanded: () => true,
        getWorktreeGroups: () => [],
        getRetiredWorktreeIdentities: () => retired,
        getGenerationClaims: () => claims || [],
        getProjectionSnapshot: () => ({
            revision: 1,
            worktreeSnapshot: {
                revision: 4,
                repositories: [],
                truncatedWorktreeCount: 0,
            },
            activeRuntimes: [], pendingRuntimes: [], executionSnapshot: {},
            focusedIdentity: null, attentionAggregate: null,
        }),
    });
    const hydrated = controller.hydrate(WORKSPACE);
    return Object.fromEntries(
        hydrated.sessionsByProvider.codex.map(session => [session.id, session]));
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 retired identities keep pre-deletion history after member removal', () => {
    // The manifest member is gone (deletion removed it); the retired record
    // alone must keep the history session visible and unresumable —
    // including sessions whose path sits outside the workspace roots.
    const byId = hydrateWithRetired([
        {
            id: 'frozen', name: 'Frozen', cwd: '/managed/deleted/lib',
            createdAt: '2026-07-01T00:00:00Z',
        },
        {
            id: 'by-creation-time', name: 'ByTime', cwd: '/managed/deleted',
            createdAt: '2026-07-20T00:00:00Z',
        },
        {
            id: 'no-evidence', name: 'NoEvidence', cwd: '/managed/deleted/tools',
        },
    ], [retiredFixture({
        affectedSessions: [{ provider: 'codex', sessionId: 'frozen' }],
    })]);
    for (const id of ['frozen', 'by-creation-time', 'no-evidence']) {
        assert.deepEqual(byId[id].worktreeKey, {
            repositoryKey: '/external/repo/.git',
            canonicalWorktreePath: '/managed/deleted',
        }, `${id} keeps the retired worktree identity`);
        assert.equal(byId[id].worktreeUnavailable, true,
            `${id} cannot resume into the deleted directory`);
    }
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 current-generation sessions are not claimed by a retired record', () => {
    const claimed = {
        claimId: 'c-1',
        worktreeKey: {
            repositoryKey: '/external/repo/.git',
            canonicalWorktreePath: '/managed/deleted',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: Date.parse('2026-08-02T00:00:00Z'),
        state: 'promoted',
        provider: 'codex',
        sessionId: 'rebuilt',
    };
    const byId = hydrateWithRetired([
        // Created after the cutoff with an explicit claim.
        {
            id: 'rebuilt', name: 'Rebuilt', cwd: '/managed/deleted/lib',
            createdAt: '2026-08-02T00:00:00Z',
        },
        // Created after the cutoff with a stable creation time only.
        {
            id: 'after-cutoff', name: 'AfterCutoff', cwd: '/managed/deleted/lib',
            createdAt: '2026-08-03T00:00:00Z',
        },
    ], [retiredFixture()], [claimed]);
    assert.equal(byId['rebuilt'], undefined,
        'a claimed current-generation session follows normal assignment, not the retired record');
    assert.equal(byId['after-cutoff'], undefined,
        'a stable post-cutoff creation time escapes the retired generation');
});

test('ACTIVE-SESSION-PRESENTATION-TRANSACTION-001 hydration consumes the captured presentation without recomputing it', () => {
    const identity = {
        provider: 'codex',
        sessionId: 'session-a',
        workspaceScopeIdentity: WORKSPACE.scopeIdentity,
        workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
        workspaceRootHostPaths: ['/work/a', '/work/b'],
        cwd: '/work/a',
    };
    const projection = {
        revision: 7,
        activeRuntimes: [{
            identity,
            backend: 'vscode', state: 'active', markerPath: '/tmp/a.done',
            runStartedAtMs: 1, attached: true,
        }],
        pendingRuntimes: [],
        executionSnapshot: {
            'codex:session-a': { state: 'running', token: 'run', occurredAtMs: 3 },
        },
        focusedIdentity: identity,
        attentionAggregate: null,
        presentation: {
            workspaceScopeIdentity: WORKSPACE.scopeIdentity,
            workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
            attentionCount: 1,
            activeAttentionCount: 1,
            runningSessionCount: 0,
            focusedTarget: { provider: 'codex', sessionId: 'session-a' },
            attentionSessions: [{
                sessionKey: 'codex:session-a', eventIds: ['captured-event'],
            }],
            sessions: [{
                provider: 'codex', sessionId: 'session-a', executionState: 'stopped',
                focused: true, needsAttention: true, conflict: false,
                eventIds: ['captured-event'],
            }],
        },
    };
    const controller = new WorkspaceSessionHydrationController({
        providers: [{ id: 'codex', label: 'Codex', terminalCwdFields: ['cwd'] }],
        readCoordinator: {
            getResults: () => ({
                codex: {
                    available: true, scannedFiles: 1, parsedFiles: 1,
                    sessions: [{ id: 'session-a', name: 'Session A', cwd: '/work/a' }],
                },
            }),
        },
        incrementalScanMaxFiles: 10,
        getRefreshReason: () => 'transaction-test',
        getSessionComparableCwd: (_provider, session) => session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getProviderSelection: () => undefined,
        getExpanded: () => true,
        getProjectionSnapshot: () => projection,
    });

    const hydrated = controller.hydrate(WORKSPACE, projection);
    assert.equal(hydrated.attentionCount, 1);
    assert.deepEqual(hydrated.activeSessions.map(session => ({
        executionState: session.executionState,
        focused: session.focused,
        needsAttention: session.needsAttention,
        attentionEventId: session.attentionEventId,
    })), [{
        executionState: 'stopped',
        focused: true,
        needsAttention: true,
        attentionEventId: 'captured-event',
    }]);
});
