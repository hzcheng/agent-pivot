'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const archive = require('../../../out/aiSessions/archiveBatch');
const aggregateArchive = require('../../../out/aiSessions/archiveBatchAcrossProviders');
const { AiSessionArchiveController } = require('../../../out/aiSessions/archiveController');
const { hydrateWorkspaceAiSessions } = require('../../../out/workspaces/sessionHydration');
const { getAttentionProjectKeys } = require('../../../out/aiSessions/attentionProject');

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-001 RUNTIME-AI-SESSION-ARCHIVE-RUNTIME-001 rejects running items and cleans every successful archive side effect', () => {
    const effects = [];
    const running = archive.archiveBatchAiSessionItem('running', {
        isRunning: () => true, archiveSession: () => true,
        deleteEntryMarker: () => effects.push('marker'), untrackTerminal: () => effects.push('terminal'),
        deletePin: () => effects.push('pin'), deleteAlias: () => effects.push('alias'),
    });
    assert.equal(running, 'running');
    assert.deepEqual(effects, []);
    const archived = archive.archiveBatchAiSessionItem('finished', {
        isRunning: () => false, archiveSession: () => true,
        deleteEntryMarker: () => effects.push('marker'), untrackTerminal: () => effects.push('terminal'),
        deletePin: () => effects.push('pin'), deleteAlias: () => effects.push('alias'),
    });
    assert.equal(archived, 'archived');
    assert.deepEqual(effects, ['marker', 'terminal', 'pin', 'alias']);
});

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 emits one terminal completion for bounded validated selection', async () => {
    const completions = [];
    const effects = [];
    const sessions = [{ id: 'a', pinned: true }, { id: 'b' }];
    await archive.executeBatchAiSessionArchiveRequest({ projectId: 'p', provider: 'codex', sessionIds: ['a', 'a', 'missing', 3] }, {
        resolveProject: () => ({ id: 'p', activeAiSessionProvider: 'codex' }),
        getProjectSessions: () => sessions, resolveCurrentSessions: () => sessions,
        confirm: async value => { effects.push(['confirm', value]); return true; },
        archiveSession: id => id === 'a' ? 'archived' : 'failed',
        reportScopeRejected: () => effects.push('scope'), reportSelectionRejected: () => effects.push('selection'),
        reportResult: result => effects.push(['result', result]), logUnexpectedError: () => effects.push('error'),
        postCompletion: value => completions.push(value), refresh: () => effects.push('refresh'),
    });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].status, 'finished');
    assert.deepEqual(completions[0].result.archivedIds, ['a']);
    assert.deepEqual(completions[0].result.rejectedIds, ['missing']);
    assert.equal(completions[0].result.malformedCount, 1);
    assert.equal(effects.filter(item => item === 'refresh').length, 1);
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 keeps cross-provider collisions distinct and validates authoritative scope', () => {
    const selection = aggregateArchive.resolveAggregateAiSessionArchiveSelection(
        [
            { provider: 'codex', sessionId: 'same' },
            { provider: 'claude', sessionId: 'same' },
            { provider: 'unknown', sessionId: 'same' },
            { provider: 'codex', sessionId: '' },
            { provider: 'codex', sessionId: 'same' },
            { provider: 'codex', sessionId: 'active' },
            { provider: 'kimi', sessionId: 'outside-selection' },
        ],
        {
            selectedProviders: ['codex', 'claude'],
            sessionsByProvider: {
                codex: [
                    { id: 'same', provider: 'codex' },
                    { id: 'active', provider: 'codex', active: true },
                ],
                claude: [{ id: 'same', provider: 'claude', pinned: true }],
                kimi: [{ id: 'outside-selection', provider: 'kimi' }],
            },
        }
    );
    assert.deepEqual(selection.eligible.map(item => item.provider), ['codex', 'claude']);
    assert.deepEqual(selection.eligible.map(item => item.session.id), ['same', 'same']);
    assert.equal(selection.rejectedCount, 3);
    assert.equal(selection.malformedCount, 1);
});

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 archives aggregate items with one confirmation, completion, refresh, and runtime sync', async () => {
    const confirmations = [];
    const completions = [];
    const effects = [];
    const errors = [];
    const sessionsByProvider = {
        codex: [{ id: 'same', provider: 'codex' }],
        claude: [{ id: 'same', provider: 'claude', pinned: true }],
    };
    const controller = new AiSessionArchiveController({
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        getProvider: provider => ({
            label: provider === 'claude' ? 'Claude' : 'Codex',
            service: {
                archiveSession: () => {
                    if (provider === 'claude') throw new Error('claude failed');
                    effects.push(['archive', provider]);
                    return true;
                },
            },
        }),
        getProviderLabel: provider => provider === 'claude' ? 'Claude' : 'Codex',
        getWorkspaceTarget: projectId => projectId === 'workspace-a' ? {
            cardId: projectId,
            workspace: {
                scopeIdentity: 'scope:a',
                navigationIdentity: 'navigation:a',
            },
            sessions: {
                workspaceScopeIdentity: 'scope:a',
                workspaceNavigationIdentity: 'navigation:a',
                selectedProviders: ['codex', 'claude'],
                sessionsByProvider,
            },
        } : null,
        getRuntimeById: () => null,
        refreshRuntimeGuard: async () => { effects.push('guard'); },
        isRuntimeComplete: () => false,
        focusRuntime: () => undefined,
        deleteRuntimeMarker: () => undefined,
        untrackRuntime: () => undefined,
        deletePin: () => undefined,
        deleteAlias: () => undefined,
        confirmSingleArchive: async () => 'Archive',
        confirmBatchArchive: async message => {
            confirmations.push(message);
            return 'Archive';
        },
        showWarningMessage: message => effects.push(['warning', message]),
        showErrorMessage: message => effects.push(['error', message]),
        showInformationMessage: message => effects.push(['info', message]),
        appendLine: message => effects.push(['log', message]),
        postCompletion: completion => completions.push(completion),
        refresh: () => effects.push('refresh'),
        syncActiveRuntime: () => effects.push('sync'),
        logUnexpectedError: (operation, error, sessionId) => {
            errors.push({ operation, message: error.message, sessionId });
        },
    });

    await controller.archiveSessions(
        'workspace-a',
        [
            { provider: 'claude', sessionId: 'same' },
            { provider: 'codex', sessionId: 'same' },
        ],
        7,
        1
    );

    assert.deepEqual(confirmations, [
        'Archive 2 selected AI sessions? 1 selected session is pinned.',
    ]);
    assert.equal(completions.length, 1);
    assert.deepEqual(
        {
            version: completions[0].version,
            requestId: completions[0].requestId,
            projectId: completions[0].projectId,
            status: completions[0].status,
        },
        { version: 1, requestId: 7, projectId: 'workspace-a', status: 'finished' }
    );
    assert.deepEqual(completions[0].result.archived, [
        { provider: 'codex', sessionId: 'same' },
    ]);
    assert.deepEqual(completions[0].result.failed, [
        { provider: 'claude', sessionId: 'same' },
    ]);
    assert.equal(effects.filter(item => item === 'refresh').length, 1);
    assert.equal(effects.filter(item => item === 'sync').length, 1);
    assert.equal(errors.length, 1);
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 executes interleaved items in selected-provider order while preserving stable composite results', async () => {
    const effects = [];
    const completions = [];
    const sessionsByProvider = {
        codex: [
            { id: 'codex-first', provider: 'codex' },
            { id: 'codex-second', provider: 'codex' },
        ],
        claude: [{ id: 'claude-middle', provider: 'claude' }],
    };
    const controller = new AiSessionArchiveController({
        isProviderId: value => value === 'codex' || value === 'claude',
        getProvider: provider => ({
            label: provider === 'claude' ? 'Claude' : 'Codex',
            service: {
                archiveSession: sessionId => {
                    effects.push(['archive', provider, sessionId]);
                    return true;
                },
            },
        }),
        getProviderLabel: provider => provider === 'claude' ? 'Claude' : 'Codex',
        getWorkspaceTarget: () => ({
            cardId: 'workspace-a',
            workspace: {
                scopeIdentity: 'scope:a',
                navigationIdentity: 'navigation:a',
            },
            sessions: {
                workspaceScopeIdentity: 'scope:a',
                workspaceNavigationIdentity: 'navigation:a',
                selectedProviders: ['codex', 'claude'],
                sessionsByProvider,
            },
        }),
        getRuntimeById: () => null,
        refreshRuntimeGuard: async () => undefined,
        isRuntimeComplete: () => false,
        focusRuntime: () => undefined,
        deleteRuntimeMarker: () => undefined,
        untrackRuntime: () => undefined,
        deletePin: () => undefined,
        deleteAlias: () => undefined,
        confirmSingleArchive: async () => 'Archive',
        confirmBatchArchive: async () => 'Archive',
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
        showInformationMessage: () => undefined,
        appendLine: () => undefined,
        postCompletion: completion => completions.push(completion),
        refresh: () => effects.push('refresh'),
        syncActiveRuntime: () => effects.push('sync'),
        logUnexpectedError: () => undefined,
    });

    await controller.archiveSessions('workspace-a', [
        { provider: 'codex', sessionId: 'codex-first' },
        { provider: 'claude', sessionId: 'claude-middle' },
        { provider: 'codex', sessionId: 'codex-second' },
    ], 12, 1);

    assert.deepEqual(effects, [
        ['archive', 'codex', 'codex-first'],
        ['archive', 'codex', 'codex-second'],
        ['archive', 'claude', 'claude-middle'],
        'refresh',
        'sync',
    ]);
    assert.equal(completions.length, 1);
    assert.deepEqual(completions[0].result.archived, [
        { provider: 'codex', sessionId: 'codex-first' },
        { provider: 'codex', sessionId: 'codex-second' },
        { provider: 'claude', sessionId: 'claude-middle' },
    ]);
});

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 settles an initial runtime guard failure exactly once without archiving or duplicate refresh', async () => {
    const completions = [];
    const effects = [];
    const controller = new AiSessionArchiveController({
        isProviderId: value => value === 'codex',
        getProvider: () => ({
            label: 'Codex',
            service: { archiveSession: () => { effects.push('archive'); return true; } },
        }),
        getProviderLabel: () => 'Codex',
        getWorkspaceTarget: () => {
            effects.push('target');
            return null;
        },
        getRuntimeById: () => null,
        refreshRuntimeGuard: async () => {
            effects.push('guard');
            throw new Error('refresh failed');
        },
        isRuntimeComplete: () => false,
        focusRuntime: () => undefined,
        deleteRuntimeMarker: () => undefined,
        untrackRuntime: () => undefined,
        deletePin: () => undefined,
        deleteAlias: () => undefined,
        confirmSingleArchive: async () => 'Archive',
        confirmBatchArchive: async () => {
            effects.push('confirm');
            return 'Archive';
        },
        showWarningMessage: () => undefined,
        showErrorMessage: () => effects.push('error'),
        showInformationMessage: () => undefined,
        appendLine: () => undefined,
        postCompletion: completion => completions.push(completion),
        refresh: () => effects.push('refresh'),
        syncActiveRuntime: () => effects.push('sync'),
        logUnexpectedError: operation => effects.push(operation),
    });

    await controller.archiveSessions(
        'workspace-a',
        [{ provider: 'codex', sessionId: 'same' }],
        9,
        1
    );

    assert.deepEqual(completions, [{
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 9,
        projectId: 'workspace-a',
        status: 'rejected',
        result: undefined,
    }]);
    assert.deepEqual(effects, [
        'guard',
        'refresh-runtime-guard',
        'error',
        'refresh',
        'sync',
    ]);
});

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 rejects correlated malformed aggregate protocol before mutation', async () => {
    const completions = [];
    const effects = [];
    const controller = new AiSessionArchiveController({
        isProviderId: value => value === 'codex',
        getProvider: () => ({
            label: 'Codex',
            service: { archiveSession: () => { effects.push('archive'); return true; } },
        }),
        getProviderLabel: () => 'Codex',
        getWorkspaceTarget: () => { effects.push('target'); return null; },
        getRuntimeById: () => null,
        refreshRuntimeGuard: async () => { effects.push('guard'); },
        isRuntimeComplete: () => false,
        focusRuntime: () => undefined,
        deleteRuntimeMarker: () => undefined,
        untrackRuntime: () => undefined,
        deletePin: () => undefined,
        deleteAlias: () => undefined,
        confirmSingleArchive: async () => 'Archive',
        confirmBatchArchive: async () => 'Archive',
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
        showInformationMessage: () => undefined,
        appendLine: () => undefined,
        postCompletion: completion => completions.push(completion),
        refresh: () => effects.push('refresh'),
        syncActiveRuntime: () => effects.push('sync'),
        logUnexpectedError: () => undefined,
    });

    await controller.archiveSessions('workspace-a', { item: 'not-an-array' }, 11, 2);

    assert.deepEqual(completions, [{
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 11,
        projectId: 'workspace-a',
        status: 'rejected',
        result: undefined,
    }]);
    assert.deepEqual(effects, []);

    await controller.archiveSessions('workspace-a', [], 0, 1);
    assert.equal(completions.length, 1, 'an unsafe correlation must not receive a completion');
    assert.deepEqual(effects, []);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-001 projects assignment, pin, alias, provider availability, and attention without input mutation leaks', () => {
    const workspace = {
        navigationIdentity: 'navigation:fixture',
        scopeIdentity: 'scope:fixture',
        kind: 'singleFolder',
        displayName: 'App',
        navigationUri: 'file:///work/app',
        environment: 'local',
        roots: [{
            id: 'root:fixture', name: 'app', uri: 'file:///work/app',
            hostPath: '/work/app', ordinal: 0,
        }],
    };
    const session = { id: 's', name: 'Original', cwd: '/work/app', updatedAt: '2026-01-01T00:00:00Z' };
    const projectAttentionKey = getAttentionProjectKeys(['file:///work/app'])[0];
    const result = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: { codex: { available: true, sessions: [session] } },
        getSessionComparableCwd: (_provider, value) => value.cwd,
        expanded: true,
        pinnedSessions: new Set(['codex:s']),
        aliases: { 'codex:s': 'Alias' },
        attentionAggregate: {
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: projectAttentionKey, sessionKey: 'codex:s',
                reasons: ['completed'], eventIds: ['event'], observedAtMs: 1,
            }],
        },
    });
    assert.equal(result.expanded, true);
    assert.equal(result.activeProvider, 'codex');
    assert.deepEqual(result.selectedProviders, ['codex']);
    assert.deepEqual(result.sessionsByProvider.codex.map(item => ({
        name: item.name, pinned: item.pinned, attention: item.attention,
    })), [{
        name: 'Alias', pinned: true, attention: { eventId: 'event', reason: 'completed', unread: true },
    }]);
    assert.equal(session.name, 'Original');

    const unavailable = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: { codex: { available: false, sessions: [] } },
        getSessionComparableCwd: () => '',
        pinnedSessions: new Set(),
        aliases: {},
    });
    assert.deepEqual(unavailable.unavailableProviders, ['codex']);
    assert.deepEqual(unavailable.sessionsByProvider.codex, []);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 keeps the old root in History and projects the rebound root as running', () => {
    const workspace = {
        navigationIdentity: 'navigation:fixture',
        scopeIdentity: 'scope:fixture',
        kind: 'singleFolder',
        displayName: 'App',
        navigationUri: 'file:///work',
        environment: 'local',
        roots: [{
            id: 'root:fixture', name: 'work', uri: 'file:///work',
            hostPath: '/work', ordinal: 0,
        }],
    };
    const result = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: {
            codex: {
                available: true,
                sessions: [
                    {
                        id: 'new-root', name: 'New work', cwd: '/work',
                        updatedAt: '2026-07-23T06:30:00Z',
                    },
                    {
                        id: 'old-root', name: 'Old work', cwd: '/work',
                        updatedAt: '2026-07-22T14:40:03Z',
                    },
                ],
            },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(),
        aliases: {},
        activeRuntimes: [{
            identity: {
                provider: 'codex',
                sessionId: 'new-root',
                workspaceScopeIdentity: workspace.scopeIdentity,
                workspaceNavigationIdentity: workspace.navigationIdentity,
                workspaceRootHostPaths: ['/work'],
                cwd: '/work',
            },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/root.done',
            runStartedAtMs: 1,
            attached: false,
            tmux: {
                layout: 'project',
                sessionName: 'ap-work-stable',
                windowName: 'codex-old-readable-stable',
            },
        }],
        executionSnapshot: {
            'codex:new-root': {
                state: 'running',
                token: 'run',
                occurredAtMs: 2,
            },
        },
    });

    assert.deepEqual(result.activeSessions.map(session => ({
        sessionId: session.sessionId,
        name: session.name,
        executionState: session.executionState,
    })), [{
        sessionId: 'new-root',
        name: 'New work',
        executionState: 'running',
    }]);
    assert.deepEqual(result.sessionsByProvider.codex.map(session => ({
        id: session.id,
        active: session.active,
    })), [
        { id: 'new-root', active: true },
        { id: 'old-root', active: false },
    ]);
});
