'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseAiSessionCreationWorktreeKey,
    resolveAiSessionWorktreeCreationTarget,
} = require('../../../out/aiSessions/worktreeCreationTarget');

const workspace = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'savedMultiRoot',
    displayName: 'Fixture',
    navigationUri: 'file:///repo/app.code-workspace',
    environment: 'local',
    roots: [
        { id: 'frontend', name: 'frontend', uri: 'file:///repo/frontend', hostPath: '/repo/frontend', ordinal: 0 },
        { id: 'backend', name: 'backend', uri: 'file:///other/backend', hostPath: '/other/backend', ordinal: 1 },
    ],
};

function worktree(path, branchRef, overrides = {}) {
    return {
        key: { repositoryKey: '/repo/.git', canonicalWorktreePath: path },
        branchRef,
        head: 'a'.repeat(40),
        isMain: path === '/repo',
        isBare: false,
        health: 'normal',
        headKind: 'branch',
        ...overrides,
    };
}

function snapshot(worktrees, repositories = []) {
    return {
        revision: 1,
        repositories: [{
            repositoryKey: '/repo/.git',
            rootBindings: [{ workspaceRootId: 'frontend', repositoryRelativePath: 'frontend' }],
            worktrees,
        }, ...repositories],
        truncatedWorktreeCount: 0,
    };
}

test('WORKTREE-SESSION-CREATE-TARGET-001 preserves legacy workspace launch outside Git', () => {
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: { revision: 1, repositories: [], truncatedWorktreeCount: 0 },
    }), { status: 'workspace' });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 never falls back while discovery is unavailable', () => {
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: null,
    }), { status: 'blocked', reason: 'snapshot-unavailable' });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 active editor uniquely selects its sibling worktree', () => {
    const main = worktree('/repo', 'refs/heads/main');
    const feature = worktree('/repo-feature', 'refs/heads/feature/auth');
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: snapshot([main, feature]),
        activeEditorPath: '/repo-feature/frontend/src/login.ts',
    }), { status: 'selected', key: feature.key });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 Current creation ignores an active feature worktree', () => {
    const main = worktree('/repo', 'refs/heads/main');
    const feature = worktree('/repo-feature', 'refs/heads/feature/auth');
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: snapshot([main, feature]),
        activeEditorPath: '/repo-feature/frontend/src/login.ts',
        mainCheckoutOnly: true,
    }), { status: 'selected', key: main.key });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 directly selects the only launchable worktree', () => {
    const linked = worktree('/repo-linked', undefined, { headKind: 'detached' });
    const bare = worktree('/repo.git', undefined, { isBare: true, headKind: 'unknown' });
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: snapshot([bare, linked]),
    }), { status: 'selected', key: linked.key });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 requires an explicit pick when multiple worktrees remain', () => {
    const main = worktree('/repo', 'refs/heads/main');
    const feature = worktree('/repo-feature', 'refs/heads/feature/auth');
    const missing = worktree('/repo-missing', 'refs/heads/old', { health: 'missing' });
    const result = resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: snapshot([main, missing, feature]),
    });
    assert.deepEqual(result, {
        status: 'pick',
        candidates: [
            { key: main.key, label: 'main', description: '/repo' },
            { key: feature.key, label: 'feature/auth', description: '/repo-feature' },
        ],
    });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 validates explicit row targets against the current snapshot', () => {
    const main = worktree('/repo', 'refs/heads/main');
    const staleKey = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/gone' };
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace, snapshot: snapshot([main]), explicitKey: main.key,
    }), { status: 'selected', key: main.key });
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace, snapshot: snapshot([main]), explicitKey: staleKey,
    }), { status: 'blocked', reason: 'target-unavailable' });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 blocks repositories with no linked launchable worktree', () => {
    assert.deepEqual(resolveAiSessionWorktreeCreationTarget({
        workspace,
        snapshot: snapshot([
            worktree('/repo.git', undefined, { isBare: true }),
            worktree('/gone', 'refs/heads/gone', { health: 'prunable' }),
        ]),
    }), { status: 'blocked', reason: 'no-linked-worktrees' });
});

test('WORKTREE-SESSION-CREATE-TARGET-001 accepts only the exact worktree message key shape', () => {
    const key = { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-feature' };
    assert.deepEqual(parseAiSessionCreationWorktreeKey(key), key);
    for (const invalid of [
        null,
        [],
        { repositoryKey: '/repo/.git' },
        { ...key, extra: true },
        { ...key, canonicalWorktreePath: '' },
        { ...key, repositoryKey: 42 },
    ]) {
        assert.equal(parseAiSessionCreationWorktreeKey(invalid), null);
    }
});
