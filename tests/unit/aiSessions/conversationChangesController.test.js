'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ConversationChangesController,
} = require('../../../out/aiSessions/conversation/conversationChangesController');
const {
    ChangesCollector,
} = require('../../../out/worktrees/changesCollector');

const REPO_KEY = '/repos/api/.git';
const WT_PATH = '/repos/api/.worktrees/fix-login';
const BASELINE = {
    commitSha: 'a'.repeat(40),
    capturedAt: 1724000000000,
    source: { kind: 'branch', fullRef: 'refs/heads/main' },
};
const TARGET = {
    projectId: 'project', provider: 'codex', sessionId: 'session-1',
    workspaceName: 'ws', interactionId: 'i1', expectedRevision: 'r1',
    displayName: 'Session', duplicateDisplayName: false,
};

function fixture(overrides = {}) {
    const posted = [];
    const group = {
        groupId: 'group-1',
        members: [{
            memberId: 'member-1',
            repositoryKey: REPO_KEY,
            worktreeKey: {
                repositoryKey: REPO_KEY,
                canonicalWorktreePath: WT_PATH,
            },
            branchName: 'agent-pivot/fix-login',
            path: WT_PATH,
            state: 'ready',
            baseline: BASELINE,
        }],
    };
    const options = {
        getPanel: () => ({
            webview: {
                postMessage: message => {
                    posted.push(message);
                    return Promise.resolve(true);
                },
            },
        }),
        getTarget: () => TARGET,
        getSubscriptionGeneration: () => 7,
        isSuspended: () => false,
        resolveSessionIdentity: async () => ({
            worktreeKey: {
                repositoryKey: REPO_KEY,
                canonicalWorktreePath: WT_PATH,
            },
            navigationIdentity: 'nav',
        }),
        resolveWorktreeKey: async () => undefined,
        findGroupByWorktreeKey: () => group,
        listRetiredIdentities: () => [],
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status')) {
                    return { stdout: ' M a.ts\0?? b.ts\0', stderr: '' };
                }
                if (args.includes('merge-base')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('rev-list')) {
                    return { stdout: '2\n', stderr: '' };
                }
                if (args.includes('diff')) {
                    return { stdout: 'a.ts\0b.ts\0c.ts\0', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
        openWorkingChangeDiff: async () => {},
        openTaskResultReview: async () => {},
        showWorktreeInSourceControl: async () => {},
        now: () => 1724000000000,
        ...overrides,
    };
    return {
        posted,
        controller: new ConversationChangesController(options),
        options,
    };
}

function lastChanges(posted) {
    return posted.filter(message =>
        message.type === 'conversation-viewer-changes').at(-1)?.changes;
}

test('WORKTREE-CHANGES-PANEL-001 resolves group members through the manifest and publishes aggregate state', async () => {
    const { posted, controller } = fixture();
    await controller.activate(TARGET);

    const state = lastChanges(posted);
    assert.equal(state.kind, 'ready');
    assert.equal(state.aggregate.completeness, 'complete');
    assert.equal(state.aggregate.workingItemCount, 2);
    assert.equal(state.aggregate.aheadCount, 2);
    assert.equal(state.members.length, 1);
    assert.equal(state.members[0].memberId, 'member-1');
    assert.equal(state.selectedMemberId, 'member-1');
    assert.equal(state.detail.taskFileCount, 3);
    assert.deepEqual(state.detail.items.map(item => item.group),
        ['changes', 'untracked']);
    assert.equal(posted[0].subscriptionGeneration, 7);
});

test('WORKTREE-CHANGES-PANEL-001 retired identity beats the live fallback', async () => {
    const { posted, controller } = fixture({
        findGroupByWorktreeKey: () => undefined,
        listRetiredIdentities: () => [{
            retirementId: 'r1',
            repositoryKey: REPO_KEY,
            canonicalWorktreePath: WT_PATH,
            branchName: 'agent-pivot/fix-login',
            deletedAt: 1,
            generationCutoffAt: 1,
            affectedSessions: [],
        }],
    });
    await controller.activate(TARGET);
    const state = lastChanges(posted);
    assert.equal(state.kind, 'retired');
    assert.deepEqual(state.members, [],
        'a retired session exposes no members; the UI keys on kind');
});

test('WORKTREE-CHANGES-PANEL-001 unmanaged sessions degrade to a single-member view', async () => {
    const { posted, controller } = fixture({
        resolveSessionIdentity: async () => ({
            cwd: '/some/path', navigationIdentity: 'nav',
        }),
        resolveWorktreeKey: async candidate =>
            candidate === '/some/path'
                ? { repositoryKey: REPO_KEY, canonicalWorktreePath: WT_PATH }
                : undefined,
        findGroupByWorktreeKey: () => undefined,
    });
    await controller.activate(TARGET);
    const state = lastChanges(posted);
    assert.equal(state.kind, 'ready');
    assert.equal(state.members.length, 1);
    assert.match(state.members[0].memberId, /^unmanaged-[0-9a-f]{16}$/,
        'the synthesized member id fits the protocol charset');
    assert.equal(state.members[0].availability, 'baselineUnavailable',
        'an unmanaged worktree never pretends a task start');
});

test('WORKTREE-CHANGES-PANEL-001 non-git sessions publish nothing actionable', async () => {
    const { posted, controller } = fixture({
        resolveSessionIdentity: async () => undefined,
    });
    await controller.activate(TARGET);
    const state = lastChanges(posted);
    assert.equal(state.kind, 'unavailable');
    assert.deepEqual(state.members, []);
});

test('WORKTREE-CHANGES-PANEL-001 open-file rejects paths escaping the worktree', async () => {
    const opened = [];
    const { controller } = fixture({
        openWorkingChangeDiff: async (worktreePath, item) => {
            opened.push([worktreePath, item.path]);
        },
    });
    await controller.activate(TARGET);
    await controller.handleOpenFile({
        memberId: 'member-1',
        item: { group: 'changes', xy: ' M', path: '../../etc/passwd' },
    });
    await controller.handleOpenFile({
        memberId: 'member-1',
        item: { group: 'changes', xy: ' M', path: 'src/a.ts' },
    });
    await controller.handleOpenFile({
        memberId: 'forged-member',
        item: { group: 'changes', xy: ' M', path: 'src/a.ts' },
    });
    assert.deepEqual(opened, [[WT_PATH, 'src/a.ts']],
        'only an in-worktree path of a known member opens');
});

test('WORKTREE-CHANGES-PANEL-001 review requires a verified baseline and open-scm targets the member', async () => {
    const reviews = [];
    const scm = [];
    const { controller } = fixture({
        openTaskResultReview: async (worktreePath, sha, title) => {
            reviews.push([worktreePath, sha, title]);
        },
        showWorktreeInSourceControl: async root => {
            scm.push(root);
        },
    });
    await controller.activate(TARGET);
    await controller.handleReview('member-1');
    assert.deepEqual(reviews, [[
        WT_PATH, BASELINE.commitSha, 'Task result · api (agent-pivot/fix-login)',
    ]]);
    await controller.handleOpenScm('member-1');
    assert.deepEqual(scm, [WT_PATH]);
});

test('WORKTREE-CHANGES-PANEL-001 remembers the selected member across reactivation', async () => {
    const { posted, controller } = fixture();
    await controller.activate(TARGET);
    controller.handleSelect('member-1');
    // Reactivating the same session is a no-op (state kept)…
    const before = posted.length;
    await controller.activate(TARGET);
    assert.equal(posted.length, before);
    // …and after a reset the remembered selection wins over the default.
    controller.reset();
    await controller.activate(TARGET);
    assert.equal(lastChanges(posted).selectedMemberId, 'member-1');
});

test('WORKTREE-CHANGES-PANEL-001 publishes with the current generation, not the activation-time one', async () => {
    let generation = 7;
    const { posted, controller } = fixture({
        getSubscriptionGeneration: () => generation,
    });
    await controller.activate(TARGET);
    assert.equal(posted.at(-1).subscriptionGeneration, 7);

    // The viewer bumped its generation (rebind/refresh) after activation;
    // the next publish must carry the new generation or the webview drops
    // it silently and the panel freezes.
    generation = 8;
    await controller.handleRefresh();
    assert.equal(posted.at(-1).subscriptionGeneration, 8);
    assert.equal(posted.at(-1).changes.kind, 'ready');
});
