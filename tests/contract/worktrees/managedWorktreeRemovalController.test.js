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

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function fixture(t) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-remove-'));
    const repositoryPath = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repositoryPath);
    git(repositoryPath, ['init', '-b', 'main']);
    git(repositoryPath, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repositoryPath, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repositoryPath, 'README.md'), 'fixture\n');
    git(repositoryPath, ['add', 'README.md']);
    git(repositoryPath, ['commit', '-m', 'fixture']);
    const repositoryKey = await fs.promises.realpath(path.join(repositoryPath, '.git'));
    const worktreePath = path.join(repositoryPath, '.agent-pivot', 'worktrees', 'cleanup-task');
    git(repositoryPath, [
        'worktree', 'add', '-b', 'agent-pivot/cleanup-task',
        worktreePath, 'refs/heads/main',
    ]);
    const key = { repositoryKey, canonicalWorktreePath: await fs.promises.realpath(worktreePath) };
    const mainKey = { repositoryKey, canonicalWorktreePath: repositoryPath };
    const snapshot = {
        revision: 1, truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey, rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            baseRef: 'refs/heads/main',
            worktrees: [{ key: mainKey, branchRef: 'refs/heads/main', head: 'a'.repeat(40),
                isMain: true, isBare: false, health: 'normal', headKind: 'branch' },
            { key, branchRef: 'refs/heads/agent-pivot/cleanup-task', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch' }],
        }],
    };
    const effects = [];
    let active = false;
    let open = false;
    let provisioning = false;
    let onConfirm = () => undefined;
    let confirmation = 'Remove Worktree';
    const controller = new ManagedWorktreeRemovalController({
        getSnapshot: () => snapshot,
        isProjectTarget: projectId => projectId === 'project',
        isActive: candidate => active && candidate.canonicalWorktreePath === key.canonicalWorktreePath,
        isOpenWorkspace: candidate => open
            && candidate.canonicalWorktreePath === key.canonicalWorktreePath,
        isProvisioning: candidate => provisioning
            && candidate.canonicalWorktreePath === key.canonicalWorktreePath,
        confirm: async message => {
            effects.push(['confirm', message]);
            onConfirm();
            return confirmation;
        },
        refresh: async () => { effects.push(['refresh']); },
    });
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    return {
        repositoryPath, repositoryKey, worktreePath: key.canonicalWorktreePath,
        key, mainKey, snapshot, effects, controller,
        setActive(value) { active = value; },
        setOpen(value) { open = value; },
        setProvisioning(value) { provisioning = value; },
        setOnConfirm(value) { onConfirm = value; },
        setConfirmation(value) { confirmation = value; },
    };
}

test('WORKTREE-MANAGED-CLEANUP-001 removes a confirmed clean idle managed worktree and keeps its branch', async t => {
    const current = await fixture(t);
    const outcome = await current.controller.remove('project', current.key);

    assert.equal(outcome.kind, 'succeeded');
    assert.equal(fs.existsSync(current.worktreePath), false);
    assert.equal(git(current.repositoryPath, ['show-ref', '--verify', '--quiet',
        'refs/heads/agent-pivot/cleanup-task']), '');
    assert.deepEqual(current.effects.map(effect => effect[0]), ['confirm', 'refresh']);
});

test('WORKTREE-MANAGED-CLEANUP-001 rejects dirty and active worktrees before confirmation', async t => {
    const dirty = await fixture(t);
    await fs.promises.writeFile(path.join(dirty.worktreePath, 'untracked.txt'), 'dirty');
    assert.deepEqual(await dirty.controller.remove('project', dirty.key), {
        kind: 'rejected', errorCode: 'worktree-dirty',
    });
    assert.deepEqual(dirty.effects, []);
    assert.equal(fs.existsSync(dirty.worktreePath), true);

    const active = await fixture(t);
    active.setActive(true);
    assert.deepEqual(await active.controller.remove('project', active.key), {
        kind: 'rejected', errorCode: 'worktree-active',
    });
    assert.deepEqual(active.effects, []);

    const open = await fixture(t);
    open.setOpen(true);
    assert.deepEqual(await open.controller.remove('project', open.key), {
        kind: 'rejected', errorCode: 'worktree-open',
    });
    assert.deepEqual(open.effects, []);

    const provisioning = await fixture(t);
    provisioning.setProvisioning(true);
    assert.deepEqual(await provisioning.controller.remove('project', provisioning.key), {
        kind: 'rejected', errorCode: 'worktree-provisioning',
    });
    assert.deepEqual(provisioning.effects, []);
});

test('WORKTREE-MANAGED-CLEANUP-001 revalidates identity and activity after confirmation', async t => {
    const branchChanged = await fixture(t);
    git(branchChanged.worktreePath, ['switch', '-c', 'agent-pivot/replaced']);
    assert.deepEqual(await branchChanged.controller.remove('project', branchChanged.key), {
        kind: 'rejected', errorCode: 'worktree-identity-changed',
    });
    assert.deepEqual(branchChanged.effects, []);

    const becameActive = await fixture(t);
    becameActive.setOnConfirm(() => becameActive.setActive(true));
    assert.deepEqual(await becameActive.controller.remove('project', becameActive.key), {
        kind: 'rejected', errorCode: 'worktree-active',
    });
    assert.equal(fs.existsSync(becameActive.worktreePath), true);
});

test('WORKTREE-MANAGED-CLEANUP-001 rejects main, unmanaged, wrong-project, and cancelled removal', async t => {
    const current = await fixture(t);
    assert.equal((await current.controller.remove('project', current.mainKey)).errorCode,
        'worktree-not-removable');
    assert.equal((await current.controller.remove('other', current.key)).errorCode,
        'project-unavailable');
    const unmanagedPath = path.join(path.dirname(current.repositoryPath), 'unmanaged');
    git(current.repositoryPath, ['worktree', 'add', '-b', 'unmanaged', unmanagedPath]);
    current.snapshot.repositories[0].worktrees.push({
        key: { repositoryKey: current.repositoryKey, canonicalWorktreePath: unmanagedPath },
        branchRef: 'refs/heads/unmanaged', head: 'a'.repeat(40), isMain: false,
        isBare: false, health: 'normal', headKind: 'branch',
    });
    assert.equal((await current.controller.remove('project', {
        repositoryKey: current.repositoryKey, canonicalWorktreePath: unmanagedPath,
    })).errorCode, 'worktree-not-removable');
    current.setConfirmation(undefined);
    assert.deepEqual(await current.controller.remove('project', current.key), { kind: 'cancelled' });
    assert.equal(fs.existsSync(current.worktreePath), true);
});

test('WORKTREE-MANAGED-CLEANUP-001 reports partial when removal succeeds before refresh fails', async t => {
    const current = await fixture(t);
    const controller = new ManagedWorktreeRemovalController({
        getSnapshot: () => current.snapshot,
        isProjectTarget: () => true,
        isActive: () => false,
        isOpenWorkspace: () => false,
        isProvisioning: () => false,
        confirm: async () => 'Remove Worktree',
        refresh: async () => { throw new Error('refresh'); },
    });

    assert.deepEqual(await controller.remove('project', current.key), {
        kind: 'partial', errorCode: 'worktree-removed-refresh-failed',
    });
    assert.equal(fs.existsSync(current.worktreePath), false);
});
