'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ManagedWorktreeRemovalController,
} = require('../../../out/worktrees/managedWorktreeRemovalController');
const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    WorktreeDeletionController,
} = require('../../../out/worktrees/deletionController');

const WORKSPACE = 'workspace-nav-id';

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function memento() {
    const values = new Map();
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        async update(key, value) {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

async function fixture(t) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-journal-'));
    const repositoryPath = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repositoryPath);
    git(repositoryPath, ['init', '-b', 'main']);
    git(repositoryPath, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repositoryPath, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repositoryPath, 'README.md'), 'fixture\n');
    git(repositoryPath, ['add', 'README.md']);
    git(repositoryPath, ['commit', '-m', 'fixture']);
    git(repositoryPath, [
        'worktree', 'add', '-b', 'agent-pivot/cleanup-task',
        path.join(repositoryPath, '.agent-pivot', 'worktrees', 'cleanup-task'),
        'refs/heads/main',
    ]);
    const repositoryKey = await fs.promises.realpath(path.join(repositoryPath, '.git'));
    const worktreePath = await fs.promises.realpath(
        path.join(repositoryPath, '.agent-pivot', 'worktrees', 'cleanup-task'));
    const key = { repositoryKey, canonicalWorktreePath: worktreePath };
    const mainKey = { repositoryKey, canonicalWorktreePath: repositoryPath };
    const snapshot = {
        revision: 1, truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey, rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            baseRef: 'refs/heads/main',
            worktrees: [
                { key: mainKey, branchRef: 'refs/heads/main', head: 'a'.repeat(40),
                    isMain: true, isBare: false, health: 'normal', headKind: 'branch' },
                { key, branchRef: 'refs/heads/agent-pivot/cleanup-task', head: 'a'.repeat(40),
                    isMain: false, isBare: false, health: 'normal', headKind: 'branch' },
            ],
        }],
    };
    const store = new WorktreeGroupManifestStore(memento());
    const group = await store.createGroup(WORKSPACE, {
        displayName: 'cleanup task',
        suggestedSlug: 'cleanup-task',
        members: [{
            repositoryKey,
            worktreeKey: key,
            branchName: 'agent-pivot/cleanup-task',
            path: key.canonicalWorktreePath,
            state: 'ready',
        }],
    });
    const removal = new ManagedWorktreeRemovalController({
        getSnapshot: () => snapshot,
        isProjectTarget: () => true,
        isActive: () => false,
        isOpenWorkspace: () => false,
        isProvisioning: () => false,
        confirm: async () => 'Remove Worktree',
        refresh: async () => undefined,
    });
    const controller = new WorktreeDeletionController({
        store,
        recheckBlocker: (_group, member) => member.worktreeKey
            ? removal.getRemovalBlocker(member.worktreeKey)
            : Promise.resolve('worktree-not-removable'),
        snapshotAffectedSessions: async () => [{ provider: 'codex', sessionId: 's-old' }],
        removeWorktree: target => removal.removeVerified(target.worktreeKey),
        observeWorktree: async target => {
            try {
                await fs.promises.access(target.canonicalWorktreePath);
                return 'present';
            } catch {
                return 'missing';
            }
        },
        nowMs: () => 1000,
    });
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { repositoryPath, key, store, group, controller, worktreePath };
}

test('WORKTREE-GROUPS-MEMBER-DELETE-001 journaled deletion removes a real worktree end to end', async t => {
    const { repositoryPath, key, store, group, controller, worktreePath } = await fixture(t);
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'started');
    // The journal is durable before the physical removal starts.
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 1);
    assert.equal(fs.existsSync(worktreePath), true);
    await controller.executeOperation(WORKSPACE, outcome.journal.operationId);
    assert.equal(fs.existsSync(worktreePath), false, 'the directory is gone');
    assert.equal(git(repositoryPath, ['show-ref', '--verify', '--quiet',
        'refs/heads/agent-pivot/cleanup-task']), '', 'the branch is kept');
    assert.equal(store.listGroups(WORKSPACE).length, 0,
        'the group disappears with its last member');
    const retired = store.listRetiredIdentities(WORKSPACE);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].canonicalWorktreePath, key.canonicalWorktreePath);
    assert.deepEqual(retired[0].affectedSessions, [{ provider: 'codex', sessionId: 's-old' }]);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    assert.equal(store.listDeletionHistory(WORKSPACE)[0].outcome, 'completed');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 a dirty worktree is blocked at admission and deletes after cleanup', async t => {
    const { store, group, controller, worktreePath } = await fixture(t);
    await fs.promises.writeFile(path.join(worktreePath, 'dirty.txt'), 'dirty');
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'blocked',
        'the admission-time recheck rejects the dirty worktree with zero side effects');
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(store.listGroups(WORKSPACE).length, 1);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    // Clean it up and the full flow succeeds.
    await fs.promises.rm(path.join(worktreePath, 'dirty.txt'));
    const retry = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(retry.kind, 'started');
    await controller.executeOperation(WORKSPACE, retry.journal.operationId);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
});
