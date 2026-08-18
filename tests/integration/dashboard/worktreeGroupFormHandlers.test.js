'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createWorktreeGroupFormHandlers,
} = require('../../../out/dashboard/worktreeGroupFormHandlers');

function fixture(controllerOverrides = {}) {
    const posted = [];
    const confirmCalls = [];
    const controller = {
        listRepositoryOptions: async () => [],
        listAddRepoOptions: async () => null,
        deriveFormContext: async () => null,
        preview: async () => ({ previewId: 'preview-1', slug: 'fix-login', members: [] }),
        confirm: async request => {
            confirmCalls.push(request);
            return { kind: 'created', groupId: 'g1' };
        },
        retryMember: async () => ({ kind: 'succeeded', operationId: 'group-member-m1' }),
        dismissMember: async () => 'dismissed',
        ...controllerOverrides,
    };
    const handlers = createWorktreeGroupFormHandlers({
        controller,
        postMessage: async message => {
            posted.push(message);
            return true;
        },
        getSnapshot: () => null,
        logError: () => {},
    });
    return { handlers, posted, confirmCalls };
}

function confirmMessage(overrides = {}) {
    return {
        type: 'confirm-worktree-group', version: 1, requestId: 'confirm-1',
        projectId: 'project', previewId: 'preview-1', displayName: 'Fix login',
        members: [{
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login', setupEnabled: false,
        }],
        ...overrides,
    };
}

const statuses = posted => posted.map(message => message.status);

test('WORKTREE-GROUPS-CREATE-HANDLER-001 a valid confirm receives accepted then settled with the bound request', async () => {
    const { handlers, posted, confirmCalls } = fixture();
    await handlers['confirm-worktree-group'](confirmMessage());

    assert.deepEqual(statuses(posted), ['accepted', 'created']);
    assert.equal(posted[0].type, 'worktree-group-creation-settlement');
    assert.equal(posted[0].requestId, 'confirm-1');
    assert.equal(posted[1].groupId, 'g1');
    assert.equal(confirmCalls.length, 1);
    assert.equal(confirmCalls[0].previewId, 'preview-1',
        'the handler passes the preview binding through untouched');
    assert.equal(confirmCalls[0].members.length, 1);
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 a malformed confirm is dropped without any settlement', async () => {
    const { handlers, posted, confirmCalls } = fixture();
    await handlers['confirm-worktree-group']({ type: 'confirm-worktree-group' });
    await handlers['confirm-worktree-group'](confirmMessage({ version: 2 }));
    await handlers['confirm-worktree-group'](confirmMessage({ requestId: 'bad id!' }));

    assert.deepEqual(posted, []);
    assert.equal(confirmCalls.length, 0);
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 every accepted confirm owes exactly one terminal settlement, even when the controller throws', async () => {
    const { handlers, posted } = fixture({
        confirm: async () => { throw new Error('boom'); },
    });
    await handlers['confirm-worktree-group'](confirmMessage());

    assert.deepEqual(statuses(posted), ['accepted', 'failed']);
    assert.equal(posted[1].errorCode, 'unexpected-error');
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 a replayed confirm settles failed as preview-stale (no replay cache on this family)', async () => {
    const replays = [];
    const { handlers, posted } = fixture({
        confirm: async request => {
            replays.push(request);
            return { kind: 'failed', errorCode: 'preview-stale' };
        },
    });
    const message = confirmMessage();
    await handlers['confirm-worktree-group'](message);
    await handlers['confirm-worktree-group'](message);

    assert.equal(replays.length, 2,
        'the handler has no replay cache — the duplicate reaches the controller');
    assert.deepEqual(statuses(posted), ['accepted', 'failed', 'accepted', 'failed']);
    assert.equal(posted[1].errorCode, 'preview-stale');
    assert.equal(posted[3].errorCode, 'preview-stale',
        'the single-use preview token downstream rejects the replay');
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 retry and dismiss members follow the accepted→settled chain', async () => {
    const { handlers, posted } = fixture();
    const request = {
        type: 'retry-worktree-group-member', version: 1, requestId: 'retry-1',
        projectId: 'project', groupId: 'g1', memberId: 'm1',
    };
    await handlers['retry-worktree-group-member'](request);
    await handlers['dismiss-worktree-group-member']({
        ...request, type: 'dismiss-worktree-group-member', requestId: 'dismiss-1',
    });

    assert.deepEqual(posted.map(message => [message.type, message.status]), [
        ['worktree-group-member-settlement', 'accepted'],
        ['worktree-group-member-settlement', 'settled'],
        ['worktree-group-member-settlement', 'accepted'],
        ['worktree-group-member-settlement', 'settled'],
    ]);
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 open-form rejects a forged add-repo target without posting state', async () => {
    const { handlers, posted } = fixture();
    // Open-form carries no requestId (exact-key protocol).
    await handlers['open-worktree-group-form']({
        type: 'open-worktree-group-form', version: 1,
        projectId: 'project', targetGroupId: 'g-missing',
    });
    assert.deepEqual(posted, [],
        'listAddRepoOptions returning null drops the message without a post');

    const withRepos = fixture({
        listRepositoryOptions: async () => [{ repositoryKey: '/alpha/.git' }],
    });
    await withRepos.handlers['open-worktree-group-form']({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
    });
    assert.equal(withRepos.posted.length, 1);
    assert.equal(withRepos.posted[0].type, 'worktree-group-form-state');
    assert.deepEqual(withRepos.posted[0].repositories, [{ repositoryKey: '/alpha/.git' }]);
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 open-form carries derive, add-repo, and seed context', async () => {
    const { handlers, posted } = fixture({
        listAddRepoOptions: async () => ({
            group: { groupId: 'g1', displayName: 'Core' },
            options: [{ repositoryKey: '/beta/.git' }],
        }),
        deriveFormContext: async () => ({ sourceGroupId: 'g9' }),
    });
    await handlers['open-worktree-group-form']({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        targetGroupId: 'g1',
    });
    assert.equal(posted[0].type, 'worktree-group-form-state');
    assert.deepEqual(posted[0].addRepo, { groupId: 'g1', displayName: 'Core' });

    const seeded = fixture({
        deriveFormContext: async () => ({ sourceGroupId: 'g9' }),
    });
    // Seed resolution goes through the snapshot: seedRepositoryKey plus a
    // matching worktree path surfaces the branch reference.
    const snapshot = {
        repositories: [{
            repositoryKey: '/alpha/.git',
            worktrees: [{ key: { canonicalWorktreePath: '/alpha/.worktrees/x' }, branchRef: 'refs/heads/feature' }],
        }],
    };
    const seededHandlers = createWorktreeGroupFormHandlers({
        controller: {
            listRepositoryOptions: async () => [],
            listAddRepoOptions: async () => null,
            deriveFormContext: async () => null,
            preview: async () => ({ previewId: 'p', slug: 's', members: [] }),
            confirm: async () => ({ kind: 'created', groupId: 'g' }),
            retryMember: async () => ({ kind: 'succeeded', operationId: 'o' }),
            dismissMember: async () => 'dismissed',
        },
        postMessage: async message => { seeded.posted.push(message); return true; },
        getSnapshot: () => snapshot,
        logError: () => {},
    });
    await seededHandlers['open-worktree-group-form']({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        seedRepositoryKey: '/alpha/.git', seedWorktreePath: '/alpha/.worktrees/x',
    });
    assert.deepEqual(seeded.posted[0].seed, {
        repositoryKey: '/alpha/.git', baseRef: 'refs/heads/feature',
    });
});

test('WORKTREE-GROUPS-CREATE-HANDLER-001 preview echoes the request correlation', async () => {
    const { handlers, posted } = fixture();
    await handlers['preview-worktree-group']({
        type: 'preview-worktree-group', version: 1, requestId: 'preview-req-1',
        projectId: 'project', displayName: 'Fix login',
        selections: [{ repositoryKey: '/alpha/.git' }],
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'worktree-group-preview');
    assert.equal(posted[0].requestId, 'preview-req-1');
    assert.equal(posted[0].previewId, 'preview-1');
});
