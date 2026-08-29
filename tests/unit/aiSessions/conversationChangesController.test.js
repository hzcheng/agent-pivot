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
const ACTIVE_WT_PATH = '/repos/api/.worktrees/refactor-auth';
const OLDER_WT_PATH = '/repos/api/.worktrees/older-task';
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
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
            }),
            commitExists: async () => true,
        },
        openCommitFileDiff: async () => {},
        openCommitReview: async () => {},
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
        message.type === 'conversation-viewer-changes'
        && message.version === 2).at(-1)?.changes;
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

test('WORKTREE-CHANGES-PANEL-001 publishes legacy and current changes messages for adjacent documents', async () => {
    const { posted, controller } = fixture();
    await controller.activate(TARGET);
    const messages = posted.filter(message =>
        message.type === 'conversation-viewer-changes');
    assert.deepEqual(messages.map(message => message.version), [2, 1]);
    assert.ok('headSha' in messages[0].changes.members[0]
        || 'upstream' in messages[0].changes.members[0]);
    assert.ok(!('headSha' in messages[1].changes.members[0]));
    assert.ok(!('upstream' in messages[1].changes.members[0]));
});

test('WORKTREE-CHANGES-PANEL-001 member views carry headSha and the upstream tracking state', async () => {
    const headSha = 'c'.repeat(40);
    const upstreamSha = 'd'.repeat(40);
    const { posted, controller } = fixture({
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('symbolic-ref')) {
                    return {
                        stdout: 'refs/heads/agent-pivot/fix-login\n', stderr: '',
                    };
                }
                if (args.includes('for-each-ref')) {
                    return {
                        stdout: 'refs/remotes/origin/agent-pivot/fix-login\n',
                        stderr: '',
                    };
                }
                if (args.includes('rev-parse')) {
                    return { stdout: `${headSha}\n${upstreamSha}\n`, stderr: '' };
                }
                if (args.includes('--left-right')) {
                    return { stdout: '1\t2\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });
    await controller.activate(TARGET);
    const member = lastChanges(posted).members[0];
    assert.equal(member.headSha, headSha);
    assert.deepEqual(member.upstream, {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/agent-pivot/fix-login',
        sha: upstreamSha,
        ahead: 2,
        behind: 1,
    });
});

test('WORKTREE-CHANGES-PANEL-001 member views prefer the current Git branch over the saved worktree plan', async () => {
    const { posted, controller } = fixture({
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('symbolic-ref')) {
                    return { stdout: 'refs/heads/main\n', stderr: '' };
                }
                if (args.includes('rev-parse')) {
                    return { stdout: `${'c'.repeat(40)}\n`, stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });
    await controller.activate(TARGET);

    assert.equal(lastChanges(posted).members[0].branchName, 'main',
        'a manual branch switch must not leave the header on the stale plan');
});

test('WORKTREE-CHANGES-PANEL-001 unreadable member views omit headSha and upstream', async () => {
    const { posted, controller } = fixture({
        collector: new ChangesCollector({
            execGit: async () => {
                throw new Error('not a git repository');
            },
            now: () => 1724000000000,
        }),
    });
    await controller.activate(TARGET);
    const member = lastChanges(posted).members[0];
    assert.equal(member.availability, 'unreadable');
    assert.ok(!('headSha' in member));
    assert.ok(!('upstream' in member));
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
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('symbolic-ref')) {
                    return { stdout: 'refs/heads/main\n', stderr: '' };
                }
                if (args.includes('rev-parse')) {
                    return { stdout: `${'c'.repeat(40)}\n`, stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });
    await controller.activate(TARGET);
    const state = lastChanges(posted);
    assert.equal(state.kind, 'ready');
    assert.equal(state.members.length, 1);
    assert.match(state.members[0].memberId, /^unmanaged-[0-9a-f]{16}$/,
        'the synthesized member id fits the protocol charset');
    assert.equal(state.members[0].availability, 'baselineUnavailable',
        'an unmanaged worktree never pretends a task start');
    assert.equal(state.members[0].branchName, 'main',
        'the header reports the live Git branch instead of its empty fallback');
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
    const authoritativeItem = controller.snapshot.detail.items[0];
    await controller.handleOpenFile({
        memberId: 'member-1',
        item: { group: 'changes', xy: ' M', path: '../../etc/passwd' },
    });
    await controller.handleOpenFile({
        memberId: 'member-1',
        item: authoritativeItem,
    });
    await controller.handleOpenFile({
        memberId: 'forged-member',
        item: { group: 'changes', xy: ' M', path: 'src/a.ts' },
    });
    await controller.handleOpenFile({
        memberId: 'member-1',
        item: { group: 'untracked', xy: '??', path: 'src/a.ts' },
    });
    assert.deepEqual(opened, [[WT_PATH, authoritativeItem.path]],
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

test('WORKTREE-CHANGES-PANEL-001 review titles use the live branch shown in the sidebar', async () => {
    const taskReviews = [];
    const commitReviews = [];
    const sha = 'c'.repeat(40);
    const { controller } = fixture({
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status')) return { stdout: '', stderr: '' };
                if (args.includes('symbolic-ref')) {
                    return { stdout: 'refs/heads/main\n', stderr: '' };
                }
                if (args.includes('for-each-ref')) return { stdout: '', stderr: '' };
                if (args.includes('rev-parse')) {
                    return { stdout: `${sha}\n`, stderr: '' };
                }
                if (args.includes('merge-base')) return { stdout: '', stderr: '' };
                if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
                if (args.includes('diff')) return { stdout: '', stderr: '' };
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
        openTaskResultReview: async (...args) => taskReviews.push(args),
        openCommitReview: async (...args) => commitReviews.push(args),
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: sha,
            }),
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
            }),
            commitExists: async () => true,
        },
    });
    await controller.activate(TARGET);
    await controller.handleReview('member-1');
    await controller.handleCommitReview({ memberId: 'member-1', sha });

    assert.equal(taskReviews[0][2], 'Task result · api (main)');
    assert.equal(commitReviews[0][3], 'Commit ccccccc · api (main)');
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

test('WORKTREE-CHANGES-PANEL-001 rejects a stale activation resolution', async () => {
    let releaseOldIdentity;
    const oldIdentity = new Promise(resolve => {
        releaseOldIdentity = resolve;
    });
    let identityCall = 0;
    const { posted, controller } = fixture({
        findGroupByWorktreeKey: navigationIdentity => ({
            groupId: 'group-1',
            members: [{
                memberId: 'member-1',
                repositoryKey: REPO_KEY,
                worktreeKey: {
                    repositoryKey: REPO_KEY,
                    canonicalWorktreePath: WT_PATH,
                },
                branchName: navigationIdentity === 'nav-old'
                    ? 'stale'
                    : 'current',
                path: WT_PATH,
                state: 'ready',
                baseline: BASELINE,
            }],
        }),
        resolveSessionIdentity: async target => {
            identityCall += 1;
            if (target.sessionId === 'session-old') {
                return oldIdentity.then(() => ({
                    worktreeKey: {
                        repositoryKey: REPO_KEY,
                        canonicalWorktreePath: WT_PATH,
                    },
                    navigationIdentity: 'nav-old',
                }));
            }
            return {
                worktreeKey: {
                    repositoryKey: REPO_KEY,
                    canonicalWorktreePath: WT_PATH,
                },
                navigationIdentity: 'nav-new',
            };
        },
    });
    const oldActivation = controller.activate({
        ...TARGET, sessionId: 'session-old',
    });
    const before = posted.length;
    await controller.activate({ ...TARGET, sessionId: 'session-new' });
    releaseOldIdentity(undefined);
    await oldActivation;
    assert.equal(identityCall, 2);
    assert.ok(posted.length > before,
        'the newer activation publishes normally');
    assert.equal(posted.filter(message =>
        message.type === 'conversation-viewer-changes'
        && message.changes.kind === 'ready'
        && message.changes.members.some(member =>
            member.branchName === 'stale')).length, 0,
        'the stale activation cannot publish its resolved member set');
});

test('WORKTREE-CHANGES-PANEL-001 drains queued collection for the latest active target', async () => {
    let releaseOldCollection;
    const oldCollection = new Promise(resolve => {
        releaseOldCollection = resolve;
    });
    let oldCollectionStarted = false;
    const group = {
        groupId: 'group-1',
        members: [{
            memberId: 'member-1',
            repositoryKey: REPO_KEY,
            worktreeKey: {
                repositoryKey: REPO_KEY,
                canonicalWorktreePath: WT_PATH,
            },
            branchName: 'old',
            path: WT_PATH,
            state: 'ready',
            baseline: BASELINE,
        }],
    };
    const { posted, controller } = fixture({
        findGroupByWorktreeKey: () => group,
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status') && !oldCollectionStarted) {
                    oldCollectionStarted = true;
                    await oldCollection;
                }
                if (args.includes('status')) {
                    return { stdout: ' M a.ts\0', stderr: '' };
                }
                if (args.includes('merge-base')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('rev-list')) {
                    return { stdout: '2\n', stderr: '' };
                }
                if (args.includes('diff')) {
                    return { stdout: 'a.ts\0', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });
    const oldActivation = controller.activate({
        ...TARGET, sessionId: 'session-old',
    });
    await new Promise(resolve => setImmediate(resolve));
    group.members[0].branchName = 'new';
    const before = posted.length;
    const newActivation = controller.activate({
        ...TARGET, sessionId: 'session-new',
    });
    await newActivation;
    assert.equal(posted.length, before,
        'the queued new collection waits for the in-flight old collection');
    releaseOldCollection();
    await oldActivation;
    assert.ok(posted.length > before,
        'the old collection drains and publishes the new session state');
    assert.equal(lastChanges(posted).members[0].branchName, 'new');
});

test('WORKTREE-CHANGES-PANEL-001 discards an old active instance after A-B-A', async () => {
    let releaseOldCollection;
    const oldCollection = new Promise(resolve => {
        releaseOldCollection = resolve;
    });
    let oldCollectionStarted = false;
    const group = {
        groupId: 'group-1',
        members: [{
            memberId: 'member-1',
            repositoryKey: REPO_KEY,
            worktreeKey: {
                repositoryKey: REPO_KEY,
                canonicalWorktreePath: WT_PATH,
            },
            branchName: 'stale',
            path: WT_PATH,
            state: 'ready',
            baseline: BASELINE,
        }],
    };
    const { posted, controller } = fixture({
        findGroupByWorktreeKey: () => group,
        collector: new ChangesCollector({
            execGit: async args => {
                if (args.includes('status') && !oldCollectionStarted) {
                    oldCollectionStarted = true;
                    await oldCollection;
                }
                if (args.includes('status')) {
                    return { stdout: ' M a.ts\0', stderr: '' };
                }
                if (args.includes('merge-base')) {
                    return { stdout: '', stderr: '' };
                }
                if (args.includes('rev-list')) {
                    return { stdout: '2\n', stderr: '' };
                }
                if (args.includes('diff')) {
                    return { stdout: 'a.ts\0', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });
    const oldTarget = { ...TARGET, sessionId: 'session-a' };
    const oldActivation = controller.activate(oldTarget);
    await new Promise(resolve => setImmediate(resolve));
    await controller.activate({ ...TARGET, sessionId: 'session-b' });
    group.members[0].branchName = 'rebound';
    const reboundActivation = controller.activate(oldTarget);
    await reboundActivation;
    releaseOldCollection();
    await oldActivation;
    assert.equal(lastChanges(posted).members[0].branchName, 'rebound',
        'an instance captured before A-B-A cannot publish stale snapshots into the new A activation');
});

test('WORKTREE-CHANGES-PANEL-001 refresh re-resolves membership changes', async () => {
    let secondGroup = false;
    const { posted, controller } = fixture({
        findGroupByWorktreeKey: () => secondGroup
            ? {
                groupId: 'group-1',
                primaryMemberId: 'member-2',
                members: [{
                    memberId: 'member-2',
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
            }
            : {
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
            },
    });
    await controller.activate(TARGET);
    assert.equal(lastChanges(posted).members[0].memberId, 'member-1');

    secondGroup = true;
    await controller.handleRefresh();
    const state = lastChanges(posted);
    assert.equal(state.members[0].memberId, 'member-2',
        'a member swap surfaces without reopening the conversation');
    assert.equal(state.selectedMemberId, 'member-2',
        'a vanished selection falls back to a live member');
});

test('WORKTREE-CHANGES-PANEL-001 follows the worktree currently modified by the conversation', async () => {
    const activeKey = {
        repositoryKey: REPO_KEY,
        canonicalWorktreePath: ACTIVE_WT_PATH,
    };
    const { posted, controller } = fixture({
        resolveWorktreeKey: async candidate =>
            candidate === ACTIVE_WT_PATH ? activeKey : undefined,
        findGroupByWorktreeKey: (_navigationIdentity, key) =>
            key.canonicalWorktreePath === ACTIVE_WT_PATH
                ? {
                    groupId: 'group-2',
                    primaryMemberId: 'member-2',
                    members: [{
                        memberId: 'member-2',
                        repositoryKey: REPO_KEY,
                        worktreeKey: activeKey,
                        branchName: 'agent-pivot/refactor-auth',
                        path: ACTIVE_WT_PATH,
                        state: 'ready',
                        baseline: BASELINE,
                    }],
                }
                : {
                    groupId: 'group-1',
                    primaryMemberId: 'member-1',
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
                },
    });

    await controller.activate(TARGET);
    assert.equal(lastChanges(posted).selectedMemberId, 'member-1',
        'the persisted session worktree supplies the initial selection');

    await controller.onTelemetryRefreshed(TARGET, ACTIVE_WT_PATH);

    const state = lastChanges(posted);
    assert.equal(state.selectedMemberId, 'member-2');
    assert.equal(state.detail.memberId, 'member-2',
        'the Git sidebar switches to the worktree where the conversation is working');

    await controller.handleRefresh();
    assert.equal(lastChanges(posted).selectedMemberId, 'member-2',
        'a manual refresh retains the telemetry-derived active worktree');
});

test('WORKTREE-CHANGES-PANEL-001 replays telemetry received during initial changes activation', async () => {
    let releaseIdentity;
    let identityCalls = 0;
    const activeKey = {
        repositoryKey: REPO_KEY,
        canonicalWorktreePath: ACTIVE_WT_PATH,
    };
    const { posted, controller } = fixture({
        resolveSessionIdentity: () => {
            identityCalls += 1;
            if (identityCalls > 1) {
                return Promise.resolve({
                    worktreeKey: {
                        repositoryKey: REPO_KEY,
                        canonicalWorktreePath: WT_PATH,
                    },
                    navigationIdentity: 'nav',
                });
            }
            return new Promise(resolve => {
                releaseIdentity = resolve;
            });
        },
        resolveWorktreeKey: async candidate =>
            candidate === ACTIVE_WT_PATH ? activeKey : undefined,
        findGroupByWorktreeKey: (_navigationIdentity, key) =>
            key.canonicalWorktreePath === ACTIVE_WT_PATH
                ? {
                    groupId: 'group-2',
                    primaryMemberId: 'member-2',
                    members: [{
                        memberId: 'member-2',
                        repositoryKey: REPO_KEY,
                        worktreeKey: activeKey,
                        branchName: 'agent-pivot/refactor-auth',
                        path: ACTIVE_WT_PATH,
                        state: 'ready',
                        baseline: BASELINE,
                    }],
                }
                : {
                    groupId: 'group-1',
                    primaryMemberId: 'member-1',
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
                },
    });

    const activation = controller.activate(TARGET);
    await new Promise(resolve => setImmediate(resolve));
    await controller.onTelemetryRefreshed(TARGET, ACTIVE_WT_PATH);
    releaseIdentity({
        worktreeKey: {
            repositoryKey: REPO_KEY,
            canonicalWorktreePath: WT_PATH,
        },
        navigationIdentity: 'nav',
    });
    await activation;

    assert.equal(lastChanges(posted).selectedMemberId, 'member-2',
        'the first visible Changes state honors the already-resolved worktree');
});

test('WORKTREE-CHANGES-PANEL-001 discards an old collection when telemetry changes worktrees', async () => {
    let releaseOldCollection;
    const oldCollection = new Promise(resolve => {
        releaseOldCollection = resolve;
    });
    let oldCollectionStarted = false;
    const activeKey = {
        repositoryKey: REPO_KEY,
        canonicalWorktreePath: ACTIVE_WT_PATH,
    };
    const { posted, controller } = fixture({
        resolveWorktreeKey: async candidate =>
            candidate === ACTIVE_WT_PATH ? activeKey : undefined,
        findGroupByWorktreeKey: (_navigationIdentity, key) =>
            key.canonicalWorktreePath === ACTIVE_WT_PATH
                ? {
                    groupId: 'group-2', primaryMemberId: 'member-2', members: [{
                        memberId: 'member-2', repositoryKey: REPO_KEY,
                        worktreeKey: activeKey,
                        branchName: 'agent-pivot/refactor-auth',
                        path: ACTIVE_WT_PATH, state: 'ready', baseline: BASELINE,
                    }],
                }
                : {
                    groupId: 'group-1', primaryMemberId: 'member-1', members: [{
                        memberId: 'member-1', repositoryKey: REPO_KEY,
                        worktreeKey: {
                            repositoryKey: REPO_KEY,
                            canonicalWorktreePath: WT_PATH,
                        },
                        branchName: 'agent-pivot/fix-login',
                        path: WT_PATH, state: 'ready', baseline: BASELINE,
                    }],
                },
        collector: new ChangesCollector({
            execGit: async (args, cwd) => {
                if (args.includes('status')) {
                    if (cwd === WT_PATH && !oldCollectionStarted) {
                        oldCollectionStarted = true;
                        await oldCollection;
                        return { stdout: ' M stale.ts\0', stderr: '' };
                    }
                    return {
                        stdout: cwd === ACTIVE_WT_PATH
                            ? ' M active.ts\0' : '',
                        stderr: '',
                    };
                }
                if (args.includes('merge-base')) return { stdout: '', stderr: '' };
                if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
                if (args.includes('diff')) return { stdout: '', stderr: '' };
                return { stdout: '', stderr: '' };
            },
            now: () => 1724000000000,
        }),
    });

    const activation = controller.activate(TARGET);
    for (let attempt = 0; attempt < 20 && !oldCollectionStarted; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(oldCollectionStarted, true, 'the old worktree collection began');

    await controller.onTelemetryRefreshed(TARGET, ACTIVE_WT_PATH);
    releaseOldCollection();
    await activation;

    const states = posted.filter(message =>
        message.type === 'conversation-viewer-changes' && message.version === 2
    ).map(message => message.changes);
    assert.ok(states.length > 0, 'the rebound worktree publishes a new state');
    assert.ok(states.every(state => state.selectedMemberId === 'member-2'),
        'no result collected for the old worktree is published after the rebind');
    assert.deepEqual(lastChanges(posted).detail.items.map(item => item.path),
        ['active.ts']);
});

test('WORKTREE-CHANGES-PANEL-001 keeps the newest telemetry worktree when resolutions finish out of order', async () => {
    let releaseOlder;
    let releaseActive;
    const olderResolution = new Promise(resolve => { releaseOlder = resolve; });
    const activeResolution = new Promise(resolve => { releaseActive = resolve; });
    const olderKey = {
        repositoryKey: REPO_KEY,
        canonicalWorktreePath: OLDER_WT_PATH,
    };
    const activeKey = {
        repositoryKey: REPO_KEY,
        canonicalWorktreePath: ACTIVE_WT_PATH,
    };
    const groupFor = (memberId, key) => ({
        groupId: `group-${memberId}`,
        primaryMemberId: memberId,
        members: [{
            memberId,
            repositoryKey: REPO_KEY,
            worktreeKey: key,
            branchName: `agent-pivot/${memberId}`,
            path: key.canonicalWorktreePath,
            state: 'ready',
            baseline: BASELINE,
        }],
    });
    const { posted, controller } = fixture({
        resolveWorktreeKey: candidate => {
            if (candidate === OLDER_WT_PATH) return olderResolution;
            if (candidate === ACTIVE_WT_PATH) return activeResolution;
            return Promise.resolve(undefined);
        },
        findGroupByWorktreeKey: (_navigationIdentity, key) =>
            key.canonicalWorktreePath === OLDER_WT_PATH
                ? groupFor('member-older', olderKey)
                : key.canonicalWorktreePath === ACTIVE_WT_PATH
                    ? groupFor('member-active', activeKey)
                    : groupFor('member-launch', {
                        repositoryKey: REPO_KEY,
                        canonicalWorktreePath: WT_PATH,
                    }),
    });
    await controller.activate(TARGET);

    const older = controller.onTelemetryRefreshed(TARGET, OLDER_WT_PATH);
    await new Promise(resolve => setImmediate(resolve));
    const active = controller.onTelemetryRefreshed(TARGET, ACTIVE_WT_PATH);
    await new Promise(resolve => setImmediate(resolve));
    releaseActive(activeKey);
    await active;
    releaseOlder(olderKey);
    await older;

    assert.equal(lastChanges(posted).selectedMemberId, 'member-active',
        'a late resolution cannot replace the newer worktree selection');
});

test('WORKTREE-CHANGES-COMMITS-001 commits list responds with the stamped generation and member correlation', async () => {
    const sha = 'c'.repeat(40);
    const listArgs = [];
    const { posted, controller } = fixture({
        commitsCollector: {
            list: async (worktreePath, request, baselineSha, upstreamSha) => {
                listArgs.push({ worktreePath, request, baselineSha, upstreamSha });
                return {
                    commits: [{
                        sha, subject: 'fix: race', authorName: 'hz',
                        authorTime: 1724000000, inTrackingBranch: false,
                    }],
                    hasMore: false,
                    historyHead: 'f'.repeat(40),
                    sectionComplete: true,
                    baselineRow: { sha: BASELINE.commitSha, subject: 'base' },
                };
            },
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
            }),
            commitExists: async () => true,
        },
    });
    await controller.activate(TARGET);
    await controller.handleCommitsList({
        requestId: 'req-1', memberId: 'member-1',
        scope: 'since-start', offset: 0,
    });
    const response = posted.find(message =>
        message.type === 'conversation-viewer-commits');
    assert.ok(response, 'a commits response is posted');
    assert.equal(response.requestId, 'req-1');
    assert.equal(response.subscriptionGeneration, 7,
        'the response is stamped with the current generation');
    assert.equal(response.memberId, 'member-1');
    assert.equal(response.commits[0].sha, sha);
    assert.equal(response.sectionComplete, true);
    assert.deepEqual(response.baselineRow,
        { sha: BASELINE.commitSha, subject: 'base' });
    assert.equal(listArgs[0].baselineSha, BASELINE.commitSha,
        'an available member passes its frozen baseline to the collector');
    assert.equal(listArgs[0].upstreamSha, undefined,
        'a member without tracking collects no row badge set (§15.5.2)');
});

test('WORKTREE-CHANGES-COMMITS-001 commits list responds degraded for unreadable members and ignores unknown members', async () => {
    const { posted, controller } = fixture();
    await controller.activate(TARGET);
    await controller.handleCommitsList({
        requestId: 'req-x', memberId: 'nobody',
        scope: 'since-start', offset: 0,
    });
    assert.ok(!posted.some(message =>
        message.type === 'conversation-viewer-commits'),
        'an unknown member id gets no response');

    // Unreadable member: the collector fails (repo gone), so availability
    // is unreadable and the response degrades without collector work.
    const gone = fixture({
        collector: new ChangesCollector({
            execGit: async () => {
                throw new Error('not a git repository');
            },
        }),
    });
    await gone.controller.activate(TARGET);
    await gone.controller.handleCommitsList({
        requestId: 'req-y', memberId: 'member-1',
        scope: 'since-start', offset: 0,
    });
    const degraded = gone.posted.find(message =>
        message.type === 'conversation-viewer-commits');
    assert.equal(degraded.degraded, 'unreadable');
    assert.equal(degraded.commits.length, 0);
});

test('WORKTREE-CHANGES-COMMITS-001 commit detail and review resolve the authoritative member state', async () => {
    const sha = 'c'.repeat(40);
    const parent = 'b'.repeat(40);
    const detail = {
        files: [
            { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
            { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R' },
        ],
        totalFiles: 2,
        filesTruncated: false,
        parentSha: parent,
    };
    const reviewed = [];
    const opened = [];
    const { posted, controller } = fixture({
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => detail,
            commitExists: async () => true,
        },
        openCommitReview: async (...args) => reviewed.push(args),
        openCommitFileDiff: async (...args) => opened.push(args),
    });
    await controller.activate(TARGET);

    await controller.handleCommitDetail({
        requestId: 'req-2', memberId: 'member-1', sha,
    });
    const detailResponse = posted.find(message =>
        message.type === 'conversation-viewer-commit-detail');
    assert.equal(detailResponse.requestId, 'req-2');
    assert.equal(detailResponse.sha, sha);
    assert.equal(detailResponse.files.length, 2);
    assert.equal(detailResponse.subscriptionGeneration, 7);

    // Open-file resolves the file against the authoritative detail: a
    // descriptor the commit does not contain is refused.
    await controller.handleCommitOpenFile({
        memberId: 'member-1', sha, path: 'src/evil.ts',
    });
    assert.equal(opened.length, 0);
    await controller.handleCommitOpenFile({
        memberId: 'member-1', sha, path: 'src/new.ts', oldPath: 'src/old.ts',
    });
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], WT_PATH);
    assert.equal(opened[0][1], sha);
    assert.equal(opened[0][2], parent,
        'the diff opens parent ↔ commit (root commits pass undefined)');
    assert.deepEqual(opened[0][3],
        { path: 'src/new.ts', oldPath: 'src/old.ts' });

    await controller.handleCommitReview({ memberId: 'member-1', sha });
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0][2], parent);
    assert.equal(reviewed[0][4].length, 2);
    assert.equal(reviewed[0][5], 2,
        'the review title stays honest about the file cap');
});

test('WORKTREE-CHANGES-COMMITS-001 a rewritten-away commit toasts and triggers a refresh push', async () => {
    const sha = 'c'.repeat(40);
    const toasts = [];
    const { posted, controller, options } = fixture({
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: 'unknown-commit',
            }),
            commitExists: async () => false,
        },
        openCommitFileDiff: async () => {
            throw new Error('must not open');
        },
        openCommitReview: async () => {
            throw new Error('must not open');
        },
        showToast: message => toasts.push(message),
    });
    await controller.activate(TARGET);
    const before = posted.length;
    await controller.handleCommitOpenFile({
        memberId: 'member-1', sha, path: 'src/a.ts',
    });
    assert.deepEqual(toasts,
        ['Commit no longer exists (history rewritten).']);
    for (let attempt = 0; attempt < 100
        && posted.length === before; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(posted.length > before,
        'a refresh push follows the toast (invalidation re-collects)');

    await controller.handleCommitReview({ memberId: 'member-1', sha });
    assert.equal(toasts.length, 2);
});

test('WORKTREE-CHANGES-COMMITS-001 a vanished commit during detail load also toasts and refreshes', async () => {
    const sha = 'c'.repeat(40);
    const toasts = [];
    const { posted, controller } = fixture({
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: 'unknown-commit',
            }),
            commitExists: async () => false,
        },
        showToast: message => toasts.push(message),
    });
    await controller.activate(TARGET);
    const before = posted.length;
    await controller.handleCommitDetail({
        requestId: 'req-9', memberId: 'member-1', sha,
    });
    assert.deepEqual(toasts,
        ['Commit no longer exists (history rewritten).'],
        'unknown-commit surfaces as a toast, not a silent retry loop');
    const response = posted.find(message =>
        message.type === 'conversation-viewer-commit-detail');
    assert.equal(response.degraded, 'unknown-commit',
        'the row still settles its pending state');
    for (let attempt = 0; attempt < 100
        && !posted.slice(before).some(message =>
            message.type === 'conversation-viewer-changes'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(posted.slice(before).some(message =>
        message.type === 'conversation-viewer-changes'),
        'a refresh push follows (invalidation re-collects)');
});

test('WORKTREE-CHANGES-COMMITS-001 diff and review open failures surface as host toasts', async () => {
    const sha = 'c'.repeat(40);
    const toasts = [];
    const detail = {
        files: [{ path: 'src/a.ts', status: 'M', additions: 1,
            deletions: 0 }],
        totalFiles: 1, filesTruncated: false, parentSha: 'b'.repeat(40),
    };
    const { controller } = fixture({
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => detail,
            commitExists: async () => true,
        },
        openCommitFileDiff: async () => {
            throw new Error('editor gone');
        },
        openCommitReview: async () => {
            throw new Error('changes api gone');
        },
        showToast: message => toasts.push(message),
    });
    await controller.activate(TARGET);
    await controller.handleCommitOpenFile({
        memberId: 'member-1', sha, path: 'src/a.ts',
    });
    await controller.handleCommitReview({ memberId: 'member-1', sha });
    assert.deepEqual(toasts, [
        'Failed to open the file diff.',
        'Failed to open the commit review.',
    ], 'open failures toast instead of vanishing (PRD §14.3)');
});

test('WORKTREE-CHANGES-COMMITS-001 degraded detail lookups on open-file and review toast instead of vanishing', async () => {
    const sha = 'c'.repeat(40);
    const toasts = [];
    const opened = [];
    const reviewed = [];
    const { controller } = fixture({
        commitsCollector: {
            list: async () => ({
                commits: [], hasMore: false, historyHead: 'f'.repeat(40),
            }),
            detail: async () => ({
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: 'timeout',
            }),
            commitExists: async () => true,
        },
        openCommitFileDiff: async (...args) => opened.push(args),
        openCommitReview: async (...args) => reviewed.push(args),
        showToast: message => toasts.push(message),
    });
    await controller.activate(TARGET);
    await controller.handleCommitOpenFile({
        memberId: 'member-1', sha, path: 'src/a.ts',
    });
    await controller.handleCommitReview({ memberId: 'member-1', sha });
    assert.deepEqual(toasts, [
        'Failed to load the commit details.',
        'Failed to load the commit details.',
    ]);
    assert.equal(opened.length, 0, 'no diff opens without the detail');
    assert.equal(reviewed.length, 0);
});
