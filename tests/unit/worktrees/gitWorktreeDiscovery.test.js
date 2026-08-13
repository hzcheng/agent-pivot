'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    GitWorktreeDiscovery,
    GitWorktreeDiscoveryError,
} = require('../../../out/worktrees/gitWorktreeDiscovery');

function result(exitCode, stdout = '', stderr = '') {
    return { exitCode, stdout, stderr };
}

function porcelain(records, nul = true) {
    const separator = nul ? '\0' : '\n';
    const end = nul ? '\0\0' : '\n\n';
    return records.map(record => [
        `worktree ${record.path}`,
        ...(record.bare ? ['bare'] : [`HEAD ${record.head}`]),
        ...(record.branch ? [`branch ${record.branch}`] : []),
        ...(record.detached ? ['detached'] : []),
        ...(record.locked ? ['locked reason'] : []),
        ...(record.prunable ? ['prunable reason'] : []),
    ].join(separator)).join(`${separator}${separator}`) + end;
}

test('WORKTREE-DISCOVERY-001 deduplicates common dirs, binds roots, and classifies health and heads', async () => {
    const calls = [];
    const existing = new Set(['/repo/main', '/repo/main/packages/api', '/repo/topic', '/other']);
    const runGit = async (cwd, args) => {
        calls.push({ cwd, args: [...args] });
        const command = args.slice(2).join(' ');
        if (command === 'rev-parse --path-format=absolute --git-common-dir') {
            return result(0, cwd === '/other' ? '/other/.git\n' : '/repo/.git\n');
        }
        if (command === 'rev-parse --path-format=absolute --show-toplevel') {
            return result(0, cwd === '/other' ? '/other\n' : '/repo/main\n');
        }
        if (command === 'worktree list --porcelain -z') {
            if (cwd === '/other') {
                return result(0, porcelain([{ path: '/other', head: '9'.repeat(40), branch: 'refs/heads/trunk' }]));
            }
            return result(0, porcelain([
                { path: '/repo/main', head: '1'.repeat(40), branch: 'refs/heads/main' },
                { path: '/repo/topic', head: '2'.repeat(40), branch: 'refs/heads/topic', locked: true },
                { path: '/repo/missing', head: '3'.repeat(40), detached: true },
                { path: '/repo/stale', head: '4'.repeat(40), branch: 'refs/heads/stale', prunable: true },
            ]));
        }
        if (args[2] === 'merge-base') {
            if (args[5] === '2'.repeat(40)) return result(0);
            if (args[5] === '3'.repeat(40)) return result(1);
            if (args[5] === '4'.repeat(40)) return result(128, '', 'base missing');
            if (args[5] === '9'.repeat(40)) return result(0);
        }
        throw new Error(`Unexpected Git command: ${command}`);
    };
    const discovery = new GitWorktreeDiscovery({
        runGit,
        canonicalizeExistingPath: async value => value.replace('/repo/.git', '/canonical/repo.git'),
        isDirectory: async value => existing.has(value),
        getBaseRef: repositoryKey => repositoryKey === '/other/.git'
            ? 'refs/heads/release'
            : undefined,
    });

    const snapshot = await discovery.discover({
        workspaceRoots: [
            { id: 'api', hostPath: '/repo/main/packages/api' },
            { id: 'main', hostPath: '/repo/main' },
            { id: 'other', hostPath: '/other' },
            { id: 'non-git', hostPath: '/tmp/plain' },
        ],
    });

    assert.equal(snapshot.repositories.length, 2);
    const repo = snapshot.repositories[0];
    assert.equal(repo.repositoryKey, '/canonical/repo.git');
    assert.equal(repo.baseRef, 'refs/heads/main');
    assert.deepEqual(repo.rootBindings, [
        { workspaceRootId: 'api', repositoryRelativePath: 'packages/api' },
        { workspaceRootId: 'main', repositoryRelativePath: '' },
    ]);
    assert.equal(repo.worktrees[0].isMain, true);
    assert.equal(repo.worktrees[0].headKind, 'branch');
    assert.equal(repo.worktrees[1].health, 'locked');
    assert.equal(repo.worktrees[1].headKind, 'contained-in-base');
    assert.equal(repo.worktrees[2].health, 'missing');
    assert.equal(repo.worktrees[2].headKind, 'detached');
    assert.equal(repo.worktrees[3].health, 'prunable');
    assert.equal(repo.worktrees[3].headKind, 'unknown');
    assert.equal(snapshot.repositories[1].baseRef, 'refs/heads/release');
    assert.equal(snapshot.repositories[1].worktrees[0].headKind, 'contained-in-base');
    assert.equal(calls.filter(call => call.args.includes('worktree')).length, 2);
});

test('WORKTREE-DISCOVERY-001 feature-detects NUL porcelain and reports bounded list failures', async () => {
    let lineFallback = false;
    const discovery = new GitWorktreeDiscovery({
        runGit: async (_cwd, args) => {
            const command = args.slice(2).join(' ');
            if (command.includes('--git-common-dir')) return result(0, '/repo/.git\n');
            if (command.includes('--show-toplevel')) return result(0, '/repo\n');
            if (command === 'worktree list --porcelain -z') return result(129, '', 'unknown switch `z`');
            if (command === 'worktree list --porcelain') {
                lineFallback = true;
                return result(0, porcelain([
                    { path: '/repo', head: '1'.repeat(40), branch: 'refs/heads/main' },
                ], false));
            }
            throw new Error(command);
        },
        canonicalizeExistingPath: async value => value,
        isDirectory: async () => true,
    });
    const snapshot = await discovery.discover({ workspaceRoots: [{ id: 'repo', hostPath: '/repo' }] });
    assert.equal(lineFallback, true);
    assert.equal(snapshot.repositories[0].worktrees.length, 1);
    lineFallback = false;
    await discovery.discover({ workspaceRoots: [{ id: 'repo', hostPath: '/repo' }] });
    assert.equal(lineFallback, true, 'the compatible line mode stays cached after feature detection');

    const broken = new GitWorktreeDiscovery({
        runGit: async (_cwd, args) => {
            const command = args.slice(2).join(' ');
            if (command.includes('--git-common-dir')) return result(0, '/repo/.git\n');
            if (command.includes('--show-toplevel')) return result(0, '/repo\n');
            return result(128, '', `fatal ${'x'.repeat(1000)}`);
        },
        canonicalizeExistingPath: async value => value,
        isDirectory: async () => true,
    });
    await assert.rejects(
        broken.discover({ workspaceRoots: [{ id: 'repo', hostPath: '/repo' }] }),
        error => error instanceof GitWorktreeDiscoveryError && error.message.length < 600
    );
});

test('WORKTREE-DISCOVERY-001 canonicalizes symlinked roots before deriving repository-relative bindings', async () => {
    const discovery = new GitWorktreeDiscovery({
        runGit: async (_cwd, args) => {
            const command = args.slice(2).join(' ');
            if (command.includes('--git-common-dir')) return result(0, '/real/repo/.git\n');
            if (command.includes('--show-toplevel')) return result(0, '/link/repo\n');
            if (command === 'worktree list --porcelain -z') return result(0, porcelain([
                { path: '/real/repo', head: '1'.repeat(40), branch: 'refs/heads/main' },
            ]));
            throw new Error(command);
        },
        canonicalizeExistingPath: async value => value.replace('/link/repo', '/real/repo'),
        isDirectory: async () => true,
    });
    const snapshot = await discovery.discover({
        workspaceRoots: [{ id: 'package', hostPath: '/link/repo/packages/api' }],
    });
    assert.deepEqual(snapshot.repositories[0].rootBindings, [{
        workspaceRootId: 'package',
        repositoryRelativePath: 'packages/api',
    }]);
});

test('WORKTREE-DISCOVERY-001 caps at 64 while retaining workspace and runtime priority worktrees', async () => {
    const records = Array.from({ length: 70 }, (_, index) => ({
        path: index === 0 ? '/repo/main' : `/repo/w${index}`,
        head: index.toString(16).padStart(40, '0'),
        branch: index === 0 ? 'refs/heads/main' : `refs/heads/w${index}`,
    }));
    const discovery = new GitWorktreeDiscovery({
        runGit: async (_cwd, args) => {
            const command = args.slice(2).join(' ');
            if (command.includes('--git-common-dir')) return result(0, '/repo/.git\n');
            if (command.includes('--show-toplevel')) return result(0, '/repo/main\n');
            if (command === 'worktree list --porcelain -z') return result(0, porcelain(records));
            if (args[2] === 'merge-base') return result(1);
            throw new Error(command);
        },
        canonicalizeExistingPath: async value => value,
        isDirectory: async () => true,
    });
    const snapshot = await discovery.discover({
        workspaceRoots: [{ id: 'repo', hostPath: '/repo/main' }],
        priorityWorktreeKeys: [{
            repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/w69',
        }],
    });
    const paths = snapshot.repositories[0].worktrees.map(item => item.key.canonicalWorktreePath);
    assert.equal(paths.length, 64);
    assert.equal(snapshot.truncatedWorktreeCount, 6);
    assert.ok(paths.includes('/repo/main'));
    assert.ok(paths.includes('/repo/w69'));
    assert.equal(paths.includes('/repo/w64'), false);
});

test('WORKTREE-DISCOVERY-001 does not allow configuration to raise the hard worktree cap', async () => {
    const records = Array.from({ length: 65 }, (_, index) => ({
        path: index === 0 ? '/repo/main' : `/repo/w${index}`,
        head: index.toString(16).padStart(40, '0'),
        branch: index === 0 ? 'refs/heads/main' : `refs/heads/w${index}`,
    }));
    const discovery = new GitWorktreeDiscovery({
        maxWorktrees: 1000,
        runGit: async (_cwd, args) => {
            const command = args.slice(2).join(' ');
            if (command.includes('--git-common-dir')) return result(0, '/repo/.git\n');
            if (command.includes('--show-toplevel')) return result(0, '/repo/main\n');
            if (command === 'worktree list --porcelain -z') return result(0, porcelain(records));
            if (args[2] === 'merge-base') return result(1);
            throw new Error(command);
        },
        canonicalizeExistingPath: async value => value,
        isDirectory: async () => true,
    });
    const snapshot = await discovery.discover({
        workspaceRoots: [{ id: 'repo', hostPath: '/repo/main' }],
    });
    assert.equal(snapshot.repositories[0].worktrees.length, 64);
    assert.equal(snapshot.truncatedWorktreeCount, 1);
});
