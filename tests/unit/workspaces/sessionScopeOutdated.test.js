'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isGroupSessionScopeOutdated,
} = require('../../../out/workspaces/sessionHydration');

const WORKSPACE = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'multiRoot',
    displayName: 'Fixture',
    navigationUri: 'file:///fixture.code-workspace',
    environment: 'local',
    roots: [
        { id: 'alpha', name: 'Alpha', uri: 'file:///alpha/main', hostPath: '/alpha/main', ordinal: 0 },
        { id: 'beta', name: 'Beta', uri: 'file:///beta/main', hostPath: '/beta/main', ordinal: 1 },
    ],
};

const ALPHA_KEY = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix' };
const BETA_KEY = { repositoryKey: '/beta/.git', canonicalWorktreePath: '/beta/.worktrees/fix' };

const SNAPSHOT = {
    revision: 1,
    repositories: [
        {
            repositoryKey: '/alpha/.git',
            rootBindings: [{ workspaceRootId: 'alpha', repositoryRelativePath: '' }],
            worktrees: [],
        },
        {
            repositoryKey: '/beta/.git',
            // Subdirectory binding: the session writes <worktree>/src, not
            // the whole worktree root.
            rootBindings: [{ workspaceRootId: 'beta', repositoryRelativePath: 'src' }],
            worktrees: [],
        },
    ],
};

function groupWithBeta(state) {
    return [{
        groupId: 'g-1',
        displayName: 'Fix',
        suggestedSlug: 'fix',
        primaryMemberId: 'm-alpha',
        createdAt: 1,
        revision: 1,
        members: [
            {
                memberId: 'm-alpha', repositoryKey: '/alpha/.git',
                worktreeKey: ALPHA_KEY, branchName: 'b/fix',
                path: ALPHA_KEY.canonicalWorktreePath, state: 'ready',
            },
            {
                memberId: 'm-beta', repositoryKey: '/beta/.git',
                worktreeKey: BETA_KEY, branchName: 'b/fix',
                path: BETA_KEY.canonicalWorktreePath, state,
            },
        ],
    }];
}

function runtime(overrides) {
    return {
        identity: {
            provider: 'codex',
            sessionId: 's-1',
            cwd: ALPHA_KEY.canonicalWorktreePath,
            worktreeKey: ALPHA_KEY,
            isolatedRoots: true,
            writableRootHostPaths: [ALPHA_KEY.canonicalWorktreePath],
            ...(overrides || {}),
        },
    };
}

test('WORKTREE-GROUPS-ADD-REPO-001 a ready new member outdates the live session scope', () => {
    // The group gained beta/src after the session started.
    assert.equal(isGroupSessionScopeOutdated(
        runtime(), groupWithBeta('ready'), SNAPSHOT, WORKSPACE), true);
    // A session persisted WITH the new member's mapped path is current.
    assert.equal(isGroupSessionScopeOutdated(
        runtime({
            writableRootHostPaths: [
                ALPHA_KEY.canonicalWorktreePath,
                '/beta/.worktrees/fix/src',
            ],
        }), groupWithBeta('ready'), SNAPSHOT, WORKSPACE), false);
});

test('WORKTREE-GROUPS-ADD-REPO-001 non-ready members never enter the expected scope', () => {
    for (const state of ['planned', 'provisioning', 'failed', 'deleting']) {
        assert.equal(isGroupSessionScopeOutdated(
            runtime(), groupWithBeta(state), SNAPSHOT, WORKSPACE), false,
            `member state ${state} must not outdate the scope`);
    }
    const detached = groupWithBeta('ready');
    detached[0].members[1].detached = true;
    assert.equal(isGroupSessionScopeOutdated(
        runtime(), detached, SNAPSHOT, WORKSPACE), false,
        'detached members stay out of the expected scope');
});

test('WORKTREE-GROUPS-ADD-REPO-001 legacy and unknown scopes never show the hint', () => {
    // Legacy (pre-isolation) sessions carry legacyScope instead.
    assert.equal(isGroupSessionScopeOutdated(
        runtime({ isolatedRoots: false }), groupWithBeta('ready'), SNAPSHOT, WORKSPACE), false);
    // Unknown persisted scope: absence of data is not evidence.
    assert.equal(isGroupSessionScopeOutdated(
        runtime({ writableRootHostPaths: undefined }),
        groupWithBeta('ready'), SNAPSHOT, WORKSPACE), false);
    // A session that does not belong to the group is unaffected.
    assert.equal(isGroupSessionScopeOutdated(
        runtime({
            worktreeKey: { repositoryKey: '/other/.git', canonicalWorktreePath: '/other/x' },
        }), groupWithBeta('ready'), SNAPSHOT, WORKSPACE), false);
});

test('WORKTREE-GROUPS-ADD-REPO-001 Windows paths compare case- and separator-insensitively', () => {
    const workspace = {
        ...WORKSPACE,
        roots: [
            { id: 'alpha', name: 'Alpha', uri: 'file:///C:/alpha/main',
                hostPath: 'C:\\alpha\\main', ordinal: 0 },
            { id: 'beta', name: 'Beta', uri: 'file:///C:/beta/main',
                hostPath: 'C:\\beta\\main', ordinal: 1 },
        ],
    };
    const snapshot = {
        revision: 1,
        repositories: [
            {
                repositoryKey: 'C:\\alpha\\.git',
                rootBindings: [{ workspaceRootId: 'alpha', repositoryRelativePath: '' }],
                worktrees: [],
            },
            {
                repositoryKey: 'C:\\beta\\.git',
                rootBindings: [{ workspaceRootId: 'beta', repositoryRelativePath: 'src' }],
                worktrees: [],
            },
        ],
    };
    const group = [{
        groupId: 'g-1', displayName: 'Fix', suggestedSlug: 'fix',
        primaryMemberId: 'm-alpha', createdAt: 1, revision: 1,
        members: [
            {
                memberId: 'm-alpha', repositoryKey: 'C:\\alpha\\.git',
                worktreeKey: {
                    repositoryKey: 'C:\\alpha\\.git',
                    canonicalWorktreePath: 'C:\\Alpha\\.Worktrees\\Fix',
                },
                branchName: 'b/fix', path: 'C:\\Alpha\\.Worktrees\\Fix', state: 'ready',
            },
            {
                memberId: 'm-beta', repositoryKey: 'C:\\beta\\.git',
                worktreeKey: {
                    repositoryKey: 'C:\\beta\\.git',
                    canonicalWorktreePath: 'c:\\beta\\.worktrees\\fix',
                },
                branchName: 'b/fix', path: 'c:\\beta\\.worktrees\\fix', state: 'ready',
            },
        ],
    }];
    const current = runtime({
        worktreeKey: {
            repositoryKey: 'C:\\alpha\\.git',
            canonicalWorktreePath: 'C:\\Alpha\\.Worktrees\\Fix',
        },
        cwd: 'C:\\Alpha\\.Worktrees\\Fix',
        // Persisted at creation: different case and separators.
        writableRootHostPaths: [
            'c:/alpha/.worktrees/fix',
            'C:/Beta/.worktrees/Fix/src',
        ],
    });
    assert.equal(isGroupSessionScopeOutdated(current, group, snapshot, workspace), false,
        'case and separator differences never produce a false hint');
    const missing = runtime({
        worktreeKey: {
            repositoryKey: 'C:\\alpha\\.git',
            canonicalWorktreePath: 'C:\\Alpha\\.Worktrees\\Fix',
        },
        cwd: 'C:\\Alpha\\.Worktrees\\Fix',
        writableRootHostPaths: ['c:/alpha/.worktrees/fix'],
    });
    assert.equal(isGroupSessionScopeOutdated(missing, group, snapshot, workspace), true);
});

test('WORKTREE-GROUPS-ADD-REPO-001 a removed member leaves stale write access flagged', () => {
    // The session started when beta was a member; beta was removed from
    // the group since — the persisted extra root must flag the session.
    const stale = runtime({
        writableRootHostPaths: [
            ALPHA_KEY.canonicalWorktreePath,
            '/beta/.worktrees/fix/src',
        ],
    });
    // Group now has ONLY alpha (beta removed).
    const group = groupWithBeta('ready');
    group[0].members.pop();
    assert.equal(isGroupSessionScopeOutdated(stale, group, SNAPSHOT, WORKSPACE), true,
        'persisted roots beyond the expected scope outdate the session');
});
