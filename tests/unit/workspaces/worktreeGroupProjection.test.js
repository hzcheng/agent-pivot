'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildWorktreeGroupProjection,
    buildChips,
} = require('../../../out/workspaces/worktreeGroupProjection');

const WORKSPACE = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'savedMultiRoot',
    displayName: 'Fixture',
    navigationUri: 'file:///work/fixture.code-workspace',
    environment: 'local',
    roots: [
        {
            id: 'alpha', name: 'Alpha', uri: 'file:///alpha/main',
            hostPath: '/alpha/main', ordinal: 0,
        },
        {
            id: 'beta', name: 'Beta', uri: 'file:///beta/main',
            hostPath: '/beta/main', ordinal: 1,
        },
    ],
};

function gitWorktree(repositoryKey, worktreePath, options) {
    return {
        key: { repositoryKey, canonicalWorktreePath: worktreePath },
        head: '1'.repeat(40),
        branchRef: 'refs/heads/main',
        isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        ...(options || {}),
    };
}

const SNAPSHOT = {
    revision: 1,
    repositories: [{
        repositoryKey: '/alpha/.git',
        rootBindings: [{ workspaceRootId: 'alpha', repositoryRelativePath: '' }],
        worktrees: [
            gitWorktree('/alpha/.git', '/alpha/main', { isMain: true }),
            gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
                branchRef: 'refs/heads/agent-pivot/fix-login',
            }),
        ],
    }, {
        repositoryKey: '/beta/.git',
        rootBindings: [{ workspaceRootId: 'beta', repositoryRelativePath: '' }],
        worktrees: [
            gitWorktree('/beta/.git', '/beta/main', {
                isMain: true, branchRef: 'refs/heads/1.0',
            }),
            gitWorktree('/beta/.git', '/beta/.worktrees/fix-login', {
                branchRef: 'refs/heads/agent-pivot/fix-login',
            }),
            gitWorktree('/beta/.git', '/beta/.worktrees/solo', {
                branchRef: 'refs/heads/agent-pivot/solo',
            }),
        ],
    }],
    truncatedWorktreeCount: 0,
};

function member(repositoryKey, slug, overrides) {
    return {
        memberId: `m-${repositoryKey}-${slug}`,
        repositoryKey,
        worktreeKey: {
            repositoryKey,
            canonicalWorktreePath: `/${repositoryKey.includes('alpha') ? 'alpha' : 'beta'}/.worktrees/${slug}`,
        },
        branchName: `agent-pivot/${slug}`,
        path: `/${repositoryKey.includes('alpha') ? 'alpha' : 'beta'}/.worktrees/${slug}`,
        state: 'ready',
        ...(overrides || {}),
    };
}

function group(overrides) {
    return {
        groupId: 'g-1',
        displayName: 'Fix login',
        suggestedSlug: 'fix-login',
        primaryMemberId: 'm-alpha',
        members: [member('/alpha/.git', 'fix-login', { memberId: 'm-alpha' })],
        createdAt: 100,
        ...(overrides || {}),
    };
}

function project(overrides) {
    return buildWorktreeGroupProjection({
        workspace: WORKSPACE,
        snapshot: SNAPSHOT,
        groups: [],
        sessions: [],
        activeSessions: [],
        ...(overrides || {}),
    });
}

test('WORKTREE-GROUPS-002 collapses main checkouts into one anchor with labeled real branches', () => {
    const { anchor } = project();
    assert.deepEqual(anchor.entries, [
        { repositoryLabel: 'alpha', branch: 'main' },
        { repositoryLabel: 'beta', branch: '1.0' },
    ]);
    assert.equal(anchor.activity, 'idle');
});

test('WORKTREE-GROUPS-002 groups manifest worktrees into one row and leaves the rest unmanaged', () => {
    const { groups, unmanaged } = project({
        groups: [group({
            members: [
                member('/alpha/.git', 'fix-login', { memberId: 'm-alpha' }),
                member('/beta/.git', 'fix-login', { memberId: 'm-beta' }),
            ],
        })],
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].members.length, 2);
    assert.equal(groups[0].members.find(m => m.memberId === 'm-alpha').isPrimary, true);
    assert.equal(groups[0].canCreateSession, true);
    assert.deepEqual(unmanaged.map(row => row.git.key.canonicalWorktreePath),
        ['/beta/.worktrees/solo'],
        'main checkouts and claimed worktrees never appear as unmanaged rows');
});

test('WORKTREE-GROUPS-002 aggregates sessions across members and derives activity', () => {
    const alphaKey = member('/alpha/.git', 'fix-login').worktreeKey;
    const betaKey = member('/beta/.git', 'fix-login').worktreeKey;
    const sessions = [
        { id: 's1', name: 'One', provider: 'codex', worktreeKey: alphaKey },
        {
            id: 's2', name: 'Two', provider: 'codex', worktreeKey: betaKey,
            attention: { unread: true },
        },
    ];
    const { groups, anchor } = project({
        groups: [group({
            members: [
                member('/alpha/.git', 'fix-login', { memberId: 'm-alpha' }),
                member('/beta/.git', 'fix-login', { memberId: 'm-beta' }),
            ],
        })],
        sessions,
    });
    assert.deepEqual(groups[0].sessions.map(session => session.id), ['s2', 's1'],
        'attention sessions sort first within the group');
    assert.equal(groups[0].activity, 'attention');
    assert.equal(anchor.sessions.length, 0);
});

test('WORKTREE-GROUPS-002 anchor collects sessions that run in main checkouts', () => {
    const mainKey = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/main' };
    const { anchor } = project({
        sessions: [{ id: 's1', name: 'Main', provider: 'codex', worktreeKey: mainKey }],
        activeSessions: [{
            key: 'codex:s1', provider: 'codex', sessionId: 's1', name: 'Main',
            executionState: 'running', focused: false, needsAttention: false,
            pending: false, backend: 'vscode', attached: true, worktreeKey: mainKey,
        }],
    });
    assert.equal(anchor.sessions.length, 1);
    assert.equal(anchor.activity, 'active');
});

test('WORKTREE-GROUPS-002 member status reflects manifest state and snapshot health', () => {
    const { groups } = project({
        groups: [group({
            members: [
                member('/alpha/.git', 'fix-login', { memberId: 'm-alpha' }),
                {
                    memberId: 'm-planned', repositoryKey: '/gamma/.git',
                    branchName: 'agent-pivot/fix-login', path: '/gamma/.worktrees/fix-login',
                    state: 'provisioning',
                },
                member('/beta/.git', 'fix-login', {
                    memberId: 'm-beta', detached: true,
                }),
            ],
        })],
    });
    const byId = Object.fromEntries(groups[0].members.map(m => [m.memberId, m.status]));
    assert.equal(byId['m-alpha'], 'ready');
    assert.equal(byId['m-planned'], 'pending');
    assert.equal(byId['m-beta'], 'detached');
    assert.equal(groups[0].hasDetachedMembers, true);
});

test('WORKTREE-GROUPS-002 marks missing worktrees without dropping the group row', () => {
    const { groups } = project({
        groups: [group({
            members: [member('/alpha/.git', 'fix-login', {
                memberId: 'm-alpha',
                worktreeKey: {
                    repositoryKey: '/alpha/.git',
                    canonicalWorktreePath: '/alpha/.worktrees/deleted-externally',
                },
                path: '/alpha/.worktrees/deleted-externally',
            })],
        })],
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].members[0].status, 'missing');
});

test('WORKTREE-GROUPS-002 merge hints follow shared suggested slugs without merging silently', () => {
    const { groups } = project({
        groups: [
            group(),
            group({
                groupId: 'g-2', createdAt: 200,
                members: [member('/beta/.git', 'fix-login', { memberId: 'm-beta' })],
            }),
            group({
                groupId: 'g-3', displayName: 'Other', suggestedSlug: 'other', createdAt: 300,
                members: [member('/beta/.git', 'solo', { memberId: 'm-solo' })],
            }),
        ],
    });
    const byId = Object.fromEntries(groups.map(row => [row.groupId, row]));
    assert.deepEqual(byId['g-1'].mergeCandidateGroupIds, ['g-2']);
    assert.deepEqual(byId['g-2'].mergeCandidateGroupIds, ['g-1']);
    assert.deepEqual(byId['g-3'].mergeCandidateGroupIds, []);
    assert.equal(groups.length, 3, 'merge candidates stay separate rows');
});

test('WORKTREE-GROUPS-002 colliding display names get a stable branch discriminator', () => {
    const { groups } = project({
        groups: [
            group(),
            group({
                groupId: 'g-2', createdAt: 200,
                members: [member('/beta/.git', 'fix-login', { memberId: 'm-beta' })],
            }),
        ],
    });
    const byId = Object.fromEntries(groups.map(row => [row.groupId, row]));
    assert.equal(byId['g-1'].discriminator, 'agent-pivot/fix-login');
    assert.equal(byId['g-2'].discriminator, 'agent-pivot/fix-login');
});

test('WORKTREE-GROUPS-002 groups sort by activity then recency', () => {
    const { groups } = project({
        groups: [
            group({ groupId: 'g-idle', createdAt: 300 }),
            group({
                groupId: 'g-busy', createdAt: 100,
                members: [member('/beta/.git', 'fix-login', { memberId: 'm-beta' })],
            }),
        ],
        activeSessions: [{
            key: 'codex:s1', provider: 'codex', sessionId: 's1', name: 'Live',
            executionState: 'running', focused: false, needsAttention: false,
            pending: false, backend: 'vscode', attached: true,
            worktreeKey: member('/beta/.git', 'fix-login').worktreeKey,
        }],
    });
    assert.deepEqual(groups.map(row => row.groupId), ['g-busy', 'g-idle']);
});

test('WORKTREE-GROUPS-002 chips use the shortest prefix unique across the workspace', () => {
    const chips = buildChips(['agent-pivot'], ['agent-pivot', 'agent-platform', 'pi']);
    assert.deepEqual(chips, [{ label: 'agent-pi', title: 'agent-pivot' }],
        'a single-member group still disambiguates against sibling repositories');
    assert.deepEqual(buildChips(['pi', 'agent-pivot'],
        ['agent-pivot', 'agent-platform', 'pi'])[0],
        { label: 'p', title: 'pi' });
    const { groups } = project({ groups: [group()] });
    assert.deepEqual(groups[0].chips, [{ label: 'a', title: 'alpha' }]);
});

test('WORKTREE-GROUPS-002 failed or missing members push the group into attention', () => {
    const failed = project({
        groups: [group({
            primaryMemberId: null,
            members: [{
                memberId: 'm-failed', repositoryKey: '/alpha/.git',
                branchName: 'agent-pivot/fix-login', path: '/alpha/.worktrees/fix-login',
                state: 'failed', lastError: 'interrupted',
            }],
        })],
    });
    assert.equal(failed.groups[0].activity, 'attention',
        'a failed member is as visible as an unread session');

    const missing = project({
        groups: [group({
            members: [member('/alpha/.git', 'fix-login', {
                memberId: 'm-alpha',
                worktreeKey: {
                    repositoryKey: '/alpha/.git',
                    canonicalWorktreePath: '/alpha/.worktrees/deleted-externally',
                },
                path: '/alpha/.worktrees/deleted-externally',
            })],
        })],
    });
    assert.equal(missing.groups[0].activity, 'attention',
        'an externally deleted worktree must not look like a healthy group');

    const detached = project({
        groups: [group({
            members: [
                member('/alpha/.git', 'fix-login', { memberId: 'm-alpha' }),
                member('/beta/.git', 'fix-login', { memberId: 'm-beta', detached: true }),
            ],
        })],
    });
    assert.equal(detached.groups[0].activity, 'idle',
        'detached members are informational, not attention');
});

test('WORKTREE-GROUPS-002 a group without a ready primary cannot create sessions', () => {
    const { groups } = project({
        groups: [group({
            primaryMemberId: null,
            members: [{
                memberId: 'm-failed', repositoryKey: '/alpha/.git',
                branchName: 'agent-pivot/fix-login', path: '/alpha/.worktrees/fix-login',
                state: 'failed', lastError: 'interrupted',
            }],
        })],
    });
    assert.equal(groups[0].canCreateSession, false);
    assert.equal(groups[0].needsPrimarySelection, false,
        'no ready member means there is nothing to select as primary');
    assert.equal(groups[0].members[0].status, 'failed');
    assert.equal(groups[0].members[0].errorCode, 'interrupted');
});
