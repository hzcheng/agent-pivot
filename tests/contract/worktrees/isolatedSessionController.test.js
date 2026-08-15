'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    IsolatedSessionController,
} = require('../../../out/worktrees/isolatedSessionController');

const workspace = {
    navigationIdentity: 'navigation:workspace',
    scopeIdentity: 'scope:workspace',
    kind: 'singleFolder',
    displayName: 'Workspace',
    navigationUri: 'file:///repo',
    environment: 'local',
    roots: [{ id: 'root', name: 'repo', uri: 'file:///repo', hostPath: '/repo', ordinal: 0 }],
};

function repository(repositoryKey = '/repo/.git', rootId = 'root', worktreePath = '/repo') {
    return {
        repositoryKey,
        rootBindings: [{ workspaceRootId: rootId, repositoryRelativePath: '' }],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: { repositoryKey, canonicalWorktreePath: worktreePath },
            branchRef: 'refs/heads/main', head: 'a'.repeat(40), isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
    };
}

function recoveryOperation() {
    return {
        version: 1,
        operationId: 'request-restored',
        projectId: 'project',
        workspaceNavigationIdentity: 'navigation:workspace',
        providerId: 'codex',
        profile: { kind: 'base' },
        setupCommand: ['npm', 'ci'],
        plan: {
            repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
            taskName: 'Restored task', slug: 'restored-task',
            branchName: 'agent-pivot/restored-task',
            worktreePath: '/repo/.agent-pivot/worktrees/restored-task',
        },
        completedSteps: ['worktree'],
        worktreeKey: {
            repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/.agent-pivot/worktrees/restored-task',
        },
        row: {
            kind: 'provisioning', operationId: 'request-restored', repositoryKey: '/repo/.git',
            taskName: 'Restored task', proposedPath: '/repo/.agent-pivot/worktrees/restored-task',
            stage: 'setting-up', completedSteps: ['worktree'], retryable: false, cancellable: true,
        },
    };
}

function fixture(overrides = {}) {
    const effects = [];
    const publications = [];
    const settlements = [];
    const persisted = [];
    const tombstones = [];
    const firstRepository = repository();
    const snapshot = {
        revision: 1,
        repositories: [firstRepository],
        truncatedWorktreeCount: 0,
    };
    const target = {
        cardId: 'project',
        workspace,
        sessions: {
            activeProvider: 'kimi',
            quickCreateProvider: 'codex',
            quickCreateProfile: 'glm',
        },
    };
    const provisioner = {
        isBranchAvailable: async (_cwd, branch) => {
            effects.push(['branch', branch]);
            return true;
        },
        isPathAvailable: async candidatePath => {
            effects.push(['path', candidatePath]);
            return true;
        },
        createWorktree: async (plan, isCancelled) => {
            effects.push(['create', plan, isCancelled()]);
            return {
                repositoryKey: plan.repositoryKey,
                canonicalWorktreePath: plan.worktreePath,
            };
        },
        validateCreatedWorktree: async () => undefined,
    };
    const controller = new IsolatedSessionController({
        getWorkspaceTarget: projectId => projectId === 'project' ? target : null,
        getWorktreeSnapshot: () => snapshot,
        getActiveEditorPath: () => undefined,
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        isWorkspaceTrusted: () => true,
        showInputBox: async () => ' Fix login race ',
        showQuickPick: async items => items[0],
        refreshWorktreeSnapshot: async () => { effects.push(['refresh-snapshot']); },
        getSetupCommand: () => ['npm', 'ci'],
        runSetup: async (plan, worktreeKey, isCancelled, command) => {
            effects.push(['setup-command', plan.taskName, worktreeKey, isCancelled(), command]);
        },
        publishRows: (revision, rows) => publications.push({ revision, rows }),
        onSettled: outcome => settlements.push(outcome),
        persistOperations: operations => { persisted.push(operations); return Promise.resolve(); },
        persistTombstones: records => {
            for (const record of records) {
                if (!tombstones.some(entry => entry.operationId === record.operationId)) {
                    tombstones.push(record);
                }
            }
            return Promise.resolve();
        },
        deleteTombstones: ids => {
            for (const id of ids) {
                const index = tombstones.findIndex(entry => entry.operationId === id);
                if (index >= 0) tombstones.splice(index, 1);
            }
            return Promise.resolve();
        },
        provisioner,
        ...overrides,
    });
    return {
        controller, effects, publications, settlements, persisted, tombstones,
        snapshot, target, provisioner,
    };
}

test('WORKTREE-ISOLATED-SESSION-001 provisions the worktree only and refreshes discovery', async () => {
    const current = fixture();

    const outcome = await current.controller.start('request-1', 'project');

    assert.equal(outcome.kind, 'succeeded');
    assert.equal(current.publications.at(-1).rows.length, 0);
    assert.deepEqual(current.publications.slice(0, -1).map(item => item.rows[0].stage), [
        'queued', 'creating', 'setting-up',
    ]);
    assert.deepEqual(current.effects.find(effect => effect[0] === 'setup-command')[4],
        ['npm', 'ci']);
    const create = current.effects.find(effect => effect[0] === 'create');
    assert.equal(create[1].taskName, 'Fix login race');
    assert.equal(create[1].branchName, 'agent-pivot/fix-login-race');
    assert.equal(create[1].worktreePath, '/repo/.worktrees/fix-login-race');
    assert.ok(current.effects.some(effect => effect[0] === 'refresh-snapshot'),
        'a finished worktree must refresh discovery so it appears in the list');
    assert.equal(current.effects.filter(effect => effect[0] === 'start-session').length, 0,
        'provisioning never starts a session; sessions are created from the row menu');
    assert.deepEqual(current.settlements, [outcome]);
});

test('WORKTREE-GROUPS-003 awaits the manifest record before publishing success', async () => {
    const recorded = [];
    let resolveRecord;
    const recordGate = new Promise(resolve => {
        resolveRecord = resolve;
    });
    const current = fixture({
        recordProvisionedWorktree: async info => {
            await recordGate;
            recorded.push(info);
        },
    });

    let settled = false;
    const start = current.controller.start('request-manifest', 'project')
        .then(outcome => {
            settled = true;
            return outcome;
        });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false,
        'the success settlement waits for the manifest write');
    assert.equal(recorded.length, 0);
    resolveRecord();
    const outcome = await start;
    assert.equal(outcome.kind, 'succeeded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].projectId, 'project');
    assert.equal(recorded[0].plan.branchName, 'agent-pivot/fix-login-race');
    assert.equal(recorded[0].worktreeKey.canonicalWorktreePath,
        '/repo/.worktrees/fix-login-race');
});

test('WORKTREE-GROUPS-003 binds the manifest record to the starting navigation identity', async () => {
    const recorded = [];
    const current = fixture({
        recordProvisionedWorktree: async info => { recorded.push(info); },
    });

    const outcome = await current.controller.start('request-identity', 'project');

    assert.equal(outcome.kind, 'succeeded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].navigationIdentity, 'navigation:workspace',
        'the manifest write must match the identity captured at start, not a re-resolved one');
    assert.ok(current.persisted.some(operations => operations.some(record =>
        record.operationId === 'request-identity'
        && record.workspaceNavigationIdentity === 'navigation:workspace')),
        'recovery records persist the starting navigation identity');
    assert.deepEqual(
        current.controller.getVisibleRows('navigation:workspace').map(row => row.operationId),
        [],
        'a settled operation leaves no row');
});

test('WORKTREE-GROUPS-003 visible rows follow the workspace navigation identity', async () => {
    let releaseSetup;
    const current = fixture({
        runSetup: () => new Promise(resolve => { releaseSetup = resolve; }),
    });
    const pending = current.controller.start('request-visible', 'project');
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(
        current.controller.getVisibleRows('navigation:workspace').map(row => row.operationId),
        ['request-visible'],
        'the owning workspace sees its provisioning row');
    assert.deepEqual(current.controller.getVisibleRows('navigation:other'), [],
        'another workspace bucket never sees it');
    assert.deepEqual(current.controller.getVisibleRows(''), [],
        'an unavailable identity fails closed');

    releaseSetup();
    await pending;
});

test('WORKTREE-GROUPS-003 a restored operation keeps its starting navigation identity', async () => {
    const recorded = [];
    const current = fixture({
        recoveredOperations: [recoveryOperation()],
        recordProvisionedWorktree: async info => { recorded.push(info); },
    });

    const outcome = await current.controller.retry('request-restored', 'project');

    assert.equal(outcome.kind, 'succeeded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].navigationIdentity, 'navigation:workspace',
        'the manifest write uses the identity captured when the operation started');
});

test('WORKTREE-GROUPS-003 recovery rows and operations stay locked to their starting identity', async () => {
    // Save Workspace As can reuse a legacy projectId for different roots:
    // a record bound to another navigation identity must not be visible,
    // retryable, cancellable, or dismissable from this workspace.
    const foreign = {
        ...recoveryOperation(),
        operationId: 'request-foreign',
        workspaceNavigationIdentity: 'navigation:other-workspace',
    };
    foreign.row = { ...foreign.row, operationId: 'request-foreign' };
    // Records predating identity binding cannot be verified either; they
    // fail closed rather than operating on whichever workspace shares the
    // legacy projectId.
    const legacy = recoveryOperation();
    delete legacy.workspaceNavigationIdentity;
    const current = fixture({ recoveredOperations: [foreign, legacy] });

    assert.deepEqual(
        current.controller.getVisibleRows('navigation:workspace').map(row => row.operationId),
        [],
        'foreign and unverifiable rows stay out of this workspace');
    assert.equal(current.controller.getRows().length, 2,
        'the records themselves survive untouched');
    for (const operationId of ['request-foreign', 'request-restored']) {
        assert.equal(
            (await current.controller.retry(operationId, 'project')).errorCode,
            'workspace-unavailable');
        assert.equal(current.controller.cancel(operationId, 'project'), false);
        assert.equal(await current.controller.dismiss(operationId, 'project'), false);
    }
    assert.equal(current.controller.getRows().length, 2,
        'blocked operations leave the recovery records intact');
    assert.deepEqual(current.effects.filter(effect =>
        effect[0] === 'setup-command' || effect[0] === 'create'), []);
});

test('WORKTREE-GROUPS-003 a failed manifest write degrades success to a retryable partial', async () => {
    const manifestError = new Error('manifest unavailable');
    manifestError.code = 'manifest-unavailable';
    const current = fixture({
        recordProvisionedWorktree: async () => { throw manifestError; },
    });

    const outcome = await current.controller.start('request-manifest-fails', 'project');

    assert.equal(outcome.kind, 'partial',
        'a worktree whose manifest record never landed is not a success');
    assert.equal(outcome.errorCode, 'manifest-unavailable');
    assert.equal(current.settlements.at(-1).kind, 'partial');
    assert.equal(current.publications.at(-1).rows.length, 1,
        'the operation stays visible as a retryable row');
    assert.equal(current.publications.at(-1).rows[0].retryable, true);
});

test('WORKTREE-GROUPS-CREATE-001 group member operations stay out of Unmanaged and bind the group', async () => {
    const recorded = [];
    const current = fixture({
        recordProvisionedWorktree: async info => { recorded.push(info); },
    });
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };

    const outcome = await current.controller.startGroupMember({
        operationId: 'group-member-m1',
        projectId: 'project',
        navigationIdentity: 'navigation:workspace',
        plan,
        setupCommand: ['npm', 'ci'],
        groupId: 'g1',
        memberId: 'm1',
        preferredPrimary: true,
    });
    assert.equal(outcome.kind, 'succeeded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].groupId, 'g1');
    assert.equal(recorded[0].memberId, 'm1');
    assert.equal(recorded[0].preferredPrimary, true);
    assert.equal(recorded[0].navigationIdentity, 'navigation:workspace');
    assert.deepEqual(current.controller.getVisibleRows('navigation:workspace'), [],
        'group member operations render in the group row, never in Unmanaged');
    assert.deepEqual(current.controller.getActiveGroupMemberIds(), [],
        'a settled member is no longer active');
});

test('WORKTREE-GROUPS-CREATE-001 a failed group member retries its exact confirmed plan', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const attemptedPlans = [];
    let failCreates = true;
    const current = fixture({
        provisioner: {
            isBranchAvailable: async () => true,
            isPathAvailable: async () => true,
            createWorktree: async attempted => {
                attemptedPlans.push(attempted);
                if (failCreates) {
                    throw Object.assign(new Error('conflict'), { code: 'branch-conflict' });
                }
                return {
                    repositoryKey: attempted.repositoryKey,
                    canonicalWorktreePath: attempted.worktreePath,
                };
            },
            validateCreatedWorktree: async () => undefined,
        },
    });
    const failed = await current.controller.startGroupMember({
        operationId: 'group-member-m2', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'm2',
    });
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.errorCode, 'branch-conflict');
    assert.deepEqual(current.controller.getActiveGroupMemberIds(), [],
        'a settled-failed member is not active');
    assert.deepEqual(current.controller.getVisibleRows('navigation:workspace'), []);

    failCreates = false;
    const retried = await current.controller.retry('group-member-m2', 'project');
    assert.equal(retried.kind, 'succeeded');
    assert.equal(attemptedPlans.length, 2);
    assert.equal(attemptedPlans[1].branchName, 'agent-pivot/fix-login',
        'a group member retry executes the confirmed plan verbatim');
    assert.equal(attemptedPlans[1].worktreePath, '/repo/.worktrees/fix-login',
        'an execution-time collision never silently re-suffixes the path');
});

test('WORKTREE-GROUPS-CREATE-001 startGroupMember rejects a mismatched navigation identity', async () => {
    // A Save Workspace As between confirm and member start must never mix
    // the manifest bucket and the physical provisioning.
    const current = fixture();
    const outcome = await current.controller.startGroupMember({
        operationId: 'group-member-mismatch',
        projectId: 'project',
        navigationIdentity: 'navigation:another-workspace',
        plan: {
            repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
            taskName: 'Fix login', slug: 'fix-login',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/repo/.worktrees/fix-login',
        },
        setupCommand: [],
        groupId: 'g1',
        memberId: 'm9',
    });
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.errorCode, 'workspace-unavailable');
    assert.equal(current.effects.filter(effect => effect[0] === 'create').length, 0,
        'no physical work happens under a mismatched identity');
});

test('WORKTREE-GROUPS-CREATE-001 preferredPrimary survives persistence and restore', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    let failSetup = true;
    const current = fixture({
        runSetup: async () => {
            if (failSetup) {
                throw Object.assign(new Error('setup'), { code: 'setup-failed' });
            }
        },
    });
    const failed = await current.controller.startGroupMember({
        operationId: 'group-member-m5', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'm5',
        preferredPrimary: true,
    });
    assert.equal(failed.kind, 'partial');
    const persistedRecord = current.persisted.at(-1)
        .find(record => record.operationId === 'group-member-m5');
    assert.equal(persistedRecord.preferredPrimary, true,
        'the confirmed primary choice is persisted with the recovery record');

    // Restore into a fresh controller and retry: the recovered context
    // still carries the primary preference.
    const recorded = [];
    const restored = fixture({
        recoveredOperations: current.persisted.at(-1),
        recordProvisionedWorktree: async info => { recorded.push(info); },
    });
    const retried = await restored.controller.retry('group-member-m5', 'project');
    assert.equal(retried.kind, 'succeeded');
    assert.equal(recorded[0].preferredPrimary, true);
});

test('WORKTREE-GROUPS-CREATE-001 dismissing a setup-incomplete member keeps a seeding tombstone', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-m6', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'm6',
    });

    assert.equal(await current.controller.dismiss('group-member-m6', 'project'), true);
    const tombstone = current.tombstones
        .find(record => record.operationId === 'group-member-m6');
    assert.equal(tombstone.tombstone, true,
        'the dismissed record persists as a tombstone');
    assert.equal(tombstone.groupId, 'g1');
    assert.deepEqual(current.controller.getRows(), [], 'no row survives');

    // The tombstone restores without a row and keeps blocking seeding.
    const restored = fixture({ recoveredOperations: current.tombstones });
    assert.deepEqual(restored.controller.getRows(), [],
        'a tombstone never restores as a retry row');
    assert.ok(restored.controller.hasOperation('group-member-m6') === false);
});

test('WORKTREE-GROUPS-CREATE-001 pruned tombstones are never resurrected by the next persist', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-m7', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'm7',
    });
    assert.equal(await current.controller.dismiss('group-member-m7', 'project'), true);
    assert.ok(current.tombstones.length > 0);

    // The store prunes the tombstone (physical worktree gone) and the
    // controller drops its in-memory copy.
    current.controller.removeTombstones(['group-member-m7']);
    assert.equal(current.controller.isTombstoneStoreFull(), false);
    // Any later persist must not bring it back.
    await current.controller.startGroupMember({
        operationId: 'group-member-m8', projectId: 'project',
        navigationIdentity: 'navigation:workspace',
        plan: { ...plan, branchName: 'agent-pivot/other', worktreePath: '/repo/.worktrees/other' },
        setupCommand: [], groupId: 'g1', memberId: 'm8',
    });
    assert.equal(current.tombstones.length, 0,
        'the pruned tombstone stays pruned');
});

test('WORKTREE-GROUPS-CREATE-001 dismiss fails closed when the tombstone cannot persist', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    let persistFails = false;
    const persistenceErrors = [];
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: records => {
            if (persistFails) {
                return Promise.reject(new Error('disk full'));
            }
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return Promise.resolve();
        },
        onPersistenceError: error => persistenceErrors.push(error),
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-m9', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'm9',
    });
    persistFails = true;
    assert.equal(await current.controller.dismiss('group-member-m9', 'project'), false,
        'the dismiss reports failure instead of losing the protection');
    assert.equal(current.controller.getRows().length, 1,
        'the failed row survives for another attempt');
    assert.ok(persistenceErrors.length > 0);
});

test('WORKTREE-GROUPS-CREATE-001 dismiss awaits the tombstone write itself, not the live record', async () => {
    // Regression: the awaited persist used to exclude the tombstone while
    // the row was still live, so a failing tombstone write still returned
    // true after the row was discarded.
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    let failTombstoneWrites = false;
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: () => failTombstoneWrites
            ? Promise.reject(new Error('disk full'))
            : Promise.resolve(),
        onPersistenceError: () => undefined,
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-t1', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 't1',
    });
    failTombstoneWrites = true;
    assert.equal(await current.controller.dismiss('group-member-t1', 'project'), false,
        'a failed tombstone write fails the dismiss');
    assert.equal(current.controller.getRows().length, 1,
        'the row survives for another attempt');
    assert.ok(current.controller.hasOperation('group-member-t1'));
});

test('WORKTREE-GROUPS-CREATE-001 prune through the controller cannot be resurrected by a queued persist', async () => {
    const { WorktreeProvisioningStore } = require('../../../out/worktrees/provisioningStore');
    const mementoState = new Map();
    const memento = {
        get(key, fallback) { return mementoState.has(key) ? mementoState.get(key) : fallback; },
        async update(key, value) { mementoState.set(key, JSON.parse(JSON.stringify(value))); },
    };
    const store = new WorktreeProvisioningStore(memento);
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistOperations: operations => store.replaceLive(operations),
        persistTombstones: records => store.appendTombstones(records),
        deleteTombstones: ids => store.deleteTombstones(ids),
        pruneTombstones: (paths, truncated, startedAt, repos) =>
            store.pruneTombstones(paths, truncated, startedAt, repos),
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-t2', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 't2',
    });
    assert.equal(await current.controller.dismiss('group-member-t2', 'project'), true);
    assert.ok(store.read().some(record => record.tombstone));

    // Prune: the controller drops memory first; a persist triggered right
    // after captures the clean state and cannot resurrect the record.
    const prune = current.controller.pruneTombstones(
        new Set(), false, Date.now() + 60_000, new Set(['/repo/.git']));
    await current.controller.startGroupMember({
        operationId: 'group-member-t3', projectId: 'project',
        navigationIdentity: 'navigation:workspace',
        plan: { ...plan, branchName: 'agent-pivot/other', worktreePath: '/repo/.worktrees/other' },
        setupCommand: [], groupId: 'g1', memberId: 't3',
    });
    await prune;
    assert.ok(!store.read().some(record => record.tombstone),
        'the pruned tombstone stays pruned through interleaved persists');
});

test('WORKTREE-GROUPS-CREATE-001 concurrent synthetic tombstone writes share the in-flight persist', async () => {
    let releasePersist;
    const persistGate = new Promise(resolve => { releasePersist = resolve; });
    let persistCalls = 0;
    const current = fixture({
        persistTombstones: records => {
            persistCalls += 1;
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return persistGate.then(() => undefined);
        },
    });
    const input = {
        repositoryKey: '/repo/.git',
        worktreePath: '/repo/.worktrees/fix-login',
        branchName: 'agent-pivot/fix-login',
        taskName: 'Fix login',
        projectId: 'project',
        navigationIdentity: 'navigation:workspace',
    };
    const first = current.controller.writeSyntheticTombstone(input);
    const second = current.controller.writeSyntheticTombstone(input);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false,
        'the concurrent caller waits for the same durable write');
    releasePersist();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.ok(persistCalls >= 1);
});

test('WORKTREE-GROUPS-CREATE-001 concurrent dismisses share one flight and one outcome', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    let failPersists = true;
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: records => {
            if (failPersists) {
                return Promise.reject(new Error('disk full'));
            }
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return Promise.resolve();
        },
        onPersistenceError: () => undefined,
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-c1', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'c1',
    });
    const [first, second] = await Promise.all([
        current.controller.dismiss('group-member-c1', 'project'),
        current.controller.dismiss('group-member-c1', 'project'),
    ]);
    assert.deepEqual([first, second], [false, false],
        'a failed tombstone write fails every concurrent caller');
    assert.equal(current.controller.getRows().length, 1,
        'the row survives for another attempt');

    failPersists = false;
    const [third, fourth] = await Promise.all([
        current.controller.dismiss('group-member-c1', 'project'),
        current.controller.dismiss('group-member-c1', 'project'),
    ]);
    assert.deepEqual([third, fourth], [true, true]);
    assert.equal(current.tombstones.length, 1, 'exactly one durable tombstone');
    assert.equal(current.persisted.at(-1)
        .filter(record => record.operationId === 'group-member-c1').length, 0,
        'no same-id live record accompanies the tombstone');
});

test('WORKTREE-GROUPS-CREATE-001 a completed retry clears the tombstone for that worktree', async () => {
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-c2', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'c2',
    });
    assert.equal(await current.controller.dismiss('group-member-c2', 'project'), true);
    assert.ok(current.tombstones.length > 0);

    // The worktree later provisions fully (e.g. retried): its tombstone
    // must stop claiming setup-incomplete and stop occupying capacity.
    current.controller.removeTombstonesForWorktree(
        '/repo/.git', '/repo/.worktrees/fix-login');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(current.tombstones.length, 0);
});

test('WORKTREE-GROUPS-CREATE-001 a failed tombstone write never deletes the durable live record first', async () => {
    // Tombstone-first ordering: when the tombstone bucket write fails, the
    // live bucket is untouched and the recovery survives the "restart".
    const { WorktreeProvisioningStore } = require('../../../out/worktrees/provisioningStore');
    const mementoState = new Map();
    const memento = {
        get(key, fallback) { return mementoState.has(key) ? mementoState.get(key) : fallback; },
        async update(key, value) {
            if (failTombstoneBucket && key.includes('Tombstones')) {
                throw new Error('disk full');
            }
            mementoState.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
    let failTombstoneBucket = false;
    const store = new WorktreeProvisioningStore(memento);
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistOperations: operations => store.replaceLive(operations),
        persistTombstones: records => store.appendTombstones(records),
        deleteTombstones: ids => store.deleteTombstones(ids),
        onPersistenceError: () => undefined,
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-o1', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'o1',
    });
    failTombstoneBucket = true;
    assert.equal(await current.controller.dismiss('group-member-o1', 'project'), false);
    const durable = store.read();
    assert.equal(durable.length, 1,
        'the live recovery record survives the failed transition');
    assert.equal(durable[0].tombstone, undefined);
    assert.equal(durable[0].operationId, 'group-member-o1');
});

test('WORKTREE-GROUPS-CREATE-001 single-flight never shares across project scopes', async () => {
    let releasePersist;
    let gatePersist = false;
    const gate = new Promise(resolve => { releasePersist = resolve; });
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: records => {
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return gatePersist ? gate.then(() => undefined) : Promise.resolve();
        },
    });
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    await current.controller.startGroupMember({
        operationId: 'group-member-o2', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'o2',
    });
    gatePersist = true;
    const legitimate = current.controller.dismiss('group-member-o2', 'project');
    const forged = await current.controller.dismiss('group-member-o2', 'forged-project');
    assert.equal(forged, false,
        'a forged projectId never rides the in-flight transaction');
    releasePersist();
    assert.equal(await legitimate, true);
});

test('WORKTREE-GROUPS-CREATE-001 a live-cleanup failure after the tombstone commit still completes the dismiss', async () => {
    // Once the tombstone is durable, the dismissal is safely committed:
    // a failing live-bucket cleanup must not roll back and report failure
    // (the tombstone outranks the stale live record on read).
    const { WorktreeProvisioningStore } = require('../../../out/worktrees/provisioningStore');
    const mementoState = new Map();
    let failLiveWrites = false;
    const memento = {
        get(key, fallback) { return mementoState.has(key) ? mementoState.get(key) : fallback; },
        async update(key, value) {
            if (failLiveWrites && !key.includes('Tombstones')) {
                throw new Error('disk full');
            }
            mementoState.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
    const store = new WorktreeProvisioningStore(memento);
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistOperations: operations => store.replaceLive(operations),
        persistTombstones: records => store.appendTombstones(records),
        onPersistenceError: () => undefined,
    });
    await current.controller.startGroupMember({
        operationId: 'group-member-p1', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'p1',
    });
    failLiveWrites = true;
    assert.equal(await current.controller.dismiss('group-member-p1', 'project'), true,
        'a committed tombstone commits the dismissal');
    const durable = store.read();
    assert.equal(durable.length, 1);
    assert.equal(durable[0].tombstone, true,
        'the tombstone is the authoritative durable record');
    assert.equal(current.controller.getRows().length, 0);
});

test('WORKTREE-GROUPS-CREATE-001 a late same-scope caller joins the in-flight dismiss', async () => {
    let releasePersist;
    let gatePersist = false;
    const gate = new Promise(resolve => { releasePersist = resolve; });
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: records => {
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return gatePersist ? gate.then(() => undefined) : Promise.resolve();
        },
    });
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    await current.controller.startGroupMember({
        operationId: 'group-member-p2', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'p2',
    });
    gatePersist = true;
    const first = current.controller.dismiss('group-member-p2', 'project');
    // Let the transaction start (its context teardown happens inside).
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const second = current.controller.dismiss('group-member-p2', 'project');
    releasePersist();
    assert.equal(await first, true);
    assert.equal(await second, true,
        'a late caller with the same identity shares the flight outcome');
});

test('WORKTREE-GROUPS-CREATE-001 retry and dismiss never interleave on one operation', async () => {
    let releaseTombstone;
    let gateTombstone = false;
    const gate = new Promise(resolve => { releaseTombstone = resolve; });
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
        persistTombstones: records => {
            for (const record of records) {
                if (!current.tombstones.some(entry => entry.operationId === record.operationId)) {
                    current.tombstones.push(record);
                }
            }
            return gateTombstone ? gate.then(() => undefined) : Promise.resolve();
        },
    });
    const plan = {
        repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
        taskName: 'Fix login', slug: 'fix-login',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/repo/.worktrees/fix-login',
    };
    await current.controller.startGroupMember({
        operationId: 'group-member-x1', projectId: 'project',
        navigationIdentity: 'navigation:workspace', plan,
        setupCommand: ['npm', 'ci'], groupId: 'g1', memberId: 'x1',
    });
    gateTombstone = true;
    const dismiss = current.controller.dismiss('group-member-x1', 'project');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const retry = await current.controller.retry('group-member-x1', 'project');
    assert.equal(retry.errorCode, 'retry-unavailable',
        'retry cannot start while the dismissal commits');
    releaseTombstone();
    assert.equal(await dismiss, true);
    assert.equal(current.controller.getRows().length, 0);
});

test('WORKTREE-ISOLATED-SESSION-001 branches a new worktree from the selected worktree branch', async () => {
    const current = fixture();
    current.snapshot.repositories[0].worktrees.push({
        key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-feature' },
        branchRef: 'refs/heads/feature/auth', head: 'b'.repeat(40), isMain: false,
        isBare: false, health: 'normal', headKind: 'branch',
    });

    const outcome = await current.controller.start('request-branch', 'project', {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    });

    assert.equal(outcome.kind, 'succeeded');
    const create = current.effects.find(effect => effect[0] === 'create');
    assert.equal(create[1].baseRef, 'refs/heads/feature/auth',
        'the plan must branch from the selected worktree, not the default base ref');
});

test('WORKTREE-ISOLATED-SESSION-001 rejects source worktrees outside the snapshot or workspace', async () => {
    const current = fixture();

    const unknown = await current.controller.start('request-unknown', 'project', {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/not-in-snapshot',
    });
    assert.deepEqual(unknown, {
        kind: 'rejected', operationId: 'request-unknown', errorCode: 'base-ref-unavailable',
    });

    const foreign = await current.controller.start('request-foreign', 'project', {
        repositoryKey: '/foreign/.git',
        canonicalWorktreePath: '/foreign',
    });
    assert.deepEqual(foreign, {
        kind: 'rejected', operationId: 'request-foreign', errorCode: 'base-ref-unavailable',
    });
    assert.equal(current.effects.filter(effect => effect[0] === 'create').length, 0,
        'rejected source worktrees must never reach Git');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 restores an interrupted operation and freezes setup argv', async () => {
    const current = fixture({
        recoveredOperations: [recoveryOperation()],
        getSetupCommand: () => ['pnpm', 'install'],
    });

    assert.equal(current.controller.getRows()[0].errorCode, 'interrupted');
    const outcome = await current.controller.retry('request-restored', 'project');
    assert.equal(outcome.kind, 'succeeded');
    assert.deepEqual(current.effects.filter(effect => effect[0] === 'create'), []);
    assert.deepEqual(current.effects.find(effect => effect[0] === 'setup-command')[4],
        ['npm', 'ci']);
});

test('WORKTREE-PROVISIONING-RECOVERY-001 blocks restored side effects in an untrusted workspace', async () => {
    const current = fixture({
        recoveredOperations: [recoveryOperation()],
        isWorkspaceTrusted: () => false,
    });

    const outcome = await current.controller.retry('request-restored', 'project');
    assert.equal(outcome.errorCode, 'workspace-untrusted');
    assert.deepEqual(current.effects.filter(effect =>
        effect[0] === 'setup-command' || effect[0] === 'start-session'), []);
    assert.equal(current.controller.getRows()[0].errorCode, 'interrupted');
});

test('WORKTREE-ISOLATED-SESSION-001 active editor chooses one repository before the fallback picker', async () => {
    const current = fixture();
    current.snapshot.repositories.push(repository('/nested/.git', 'root', '/repo/packages/nested'));
    let picks = 0;
    const controller = new IsolatedSessionController({
        getWorkspaceTarget: () => current.target,
        getWorktreeSnapshot: () => current.snapshot,
        getActiveEditorPath: () => '/repo/packages/nested/src/index.ts',
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        isWorkspaceTrusted: () => true,
        showInputBox: async () => 'Nested task',
        showQuickPick: async () => { picks += 1; return undefined; },
        refreshWorktreeSnapshot: async () => undefined,
        publishRows: () => undefined,
        provisioner: current.provisioner,
    });

    const outcome = await controller.start('request-nested', 'project');
    assert.equal(outcome.kind, 'succeeded');
    assert.equal(outcome.worktreeKey.repositoryKey, '/nested/.git');
    assert.equal(picks, 0);
});

test('WORKTREE-ISOLATED-SESSION-001 cancellation and duplicate preparation do not publish phantom rows', async () => {
    let releaseInput;
    const input = new Promise(resolve => { releaseInput = resolve; });
    const current = fixture({ showInputBox: () => input });

    const pending = current.controller.start('request-prompt', 'project');
    assert.deepEqual(await current.controller.start('request-prompt', 'project'), {
        kind: 'rejected', operationId: 'request-prompt', errorCode: 'duplicate-operation',
    });
    releaseInput(undefined);
    assert.deepEqual(await pending, { kind: 'cancelled', operationId: 'request-prompt' });
    assert.deepEqual(current.publications, []);
    assert.deepEqual(current.effects, []);
});

test('WORKTREE-ISOLATED-SESSION-001 rejects untrusted workspaces before prompts or Git checks', async () => {
    const current = fixture({ isWorkspaceTrusted: () => false });
    assert.deepEqual(await current.controller.start('request-untrusted', 'project'), {
        kind: 'rejected', operationId: 'request-untrusted', errorCode: 'workspace-untrusted',
    });
    assert.deepEqual(current.effects, []);
    assert.deepEqual(current.publications, []);
});

test('WORKTREE-ISOLATED-SESSION-001 reallocates after a pre-create branch collision', async () => {
    let createAttempts = 0;
    let collided = false;
    const current = fixture({
        provisioner: {
            isBranchAvailable: async (_cwd, branchName) =>
                !(collided && branchName === 'agent-pivot/fix-login-race'),
            isPathAvailable: async () => true,
            createWorktree: async plan => {
                createAttempts += 1;
                if (createAttempts === 1) {
                    collided = true;
                    throw Object.assign(new Error('race'), { code: 'branch-conflict' });
                }
                return {
                    repositoryKey: plan.repositoryKey,
                    canonicalWorktreePath: plan.worktreePath,
                };
            },
            validateCreatedWorktree: async () => undefined,
        },
    });

    const failed = await current.controller.start('request-collision', 'project');
    assert.equal(failed.errorCode, 'branch-conflict');
    const succeeded = await current.controller.retry('request-collision', 'project');
    assert.equal(succeeded.kind, 'succeeded');
    assert.equal(succeeded.worktreeKey.canonicalWorktreePath,
        '/repo/.worktrees/fix-login-race-2');
    assert.equal(createAttempts, 2);
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 dismiss drops a failed row only from its own project', async () => {
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('request-dismiss', 'project');
    assert.equal(current.controller.getRows()[0].stage, 'failed');

    assert.equal(await current.controller.dismiss('request-dismiss', 'forged-project'), false,
        'another project cannot dismiss the row');
    assert.equal(current.controller.getRows().length, 1);
    assert.equal(await current.controller.dismiss('request-dismiss', 'project'), true);
    assert.deepEqual(current.controller.getRows(), []);
    assert.equal(current.tombstones.length, 1,
        'a setup-incomplete worktree keeps a tombstone, never a row');
    assert.equal(current.tombstones[0].tombstone, true);
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 rejects retry and cancel from another project scope', async () => {
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('request-scoped', 'project');

    assert.equal((await current.controller.retry('request-scoped', 'forged-project')).errorCode,
        'retry-unavailable');
    assert.equal(current.controller.cancel('request-scoped', 'forged-project'), false);
    assert.equal(current.controller.getRows()[0].retryable, true);
});
