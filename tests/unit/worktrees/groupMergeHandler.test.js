'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    handleMergeWorktreeGroups,
} = require('../../../out/worktrees/groupMergeHandler');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');

const WORKSPACE = 'navigation:unit';

function memento() {
    const values = new Map();
    return {
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

function readyMember(repositoryKey, slug) {
    return {
        repositoryKey,
        branchName: `agent-pivot/${slug}`,
        path: `/repo/.worktrees/${slug}`,
        state: 'ready',
        worktreeKey: { repositoryKey, canonicalWorktreePath: `/repo/.worktrees/${slug}` },
    };
}

async function fixture(twoGroups = true) {
    const store = new WorktreeGroupManifestStore(memento());
    await store.createGroup(WORKSPACE, {
        displayName: 'Fix login', suggestedSlug: 'fix-login',
        members: [readyMember('/alpha/.git', 'fix-login')],
    });
    if (twoGroups) {
        await store.createGroup(WORKSPACE, {
            displayName: 'Fix login (2)', suggestedSlug: 'fix-login',
            members: [readyMember('/beta/.git', 'fix-login-2')],
        });
    }
    const posted = [];
    const shown = { picks: null, warnings: [], refreshed: 0 };
    const deps = {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: projectId => (projectId === 'project' ? WORKSPACE : null),
        store,
        showQuickPick: async (picks, _placeHolder) => {
            shown.picks = picks;
            return deps.pickResult;
        },
        showWarning: message => shown.warnings.push(message),
        refreshNow: async () => { shown.refreshed += 1; },
        logError: () => {},
        replayCache: createSettlementReplayCache(),
        pickResult: undefined,
    };
    return { store, deps, posted, shown };
}

const mergeRequest = (sourceGroupId, overrides = {}) => ({
    type: 'merge-worktree-groups', version: 1,
    requestId: 'merge-n1-1', projectId: 'project', sourceGroupId,
    ...overrides,
});
const sourceGroupId = store => store.listGroups(WORKSPACE)[0].groupId;
const statuses = posted => posted.map(message => message.status);

test('WORKTREE-GROUPS-MERGE-001 malformed messages are dropped without any settlement or UI', async () => {
    const { deps, posted, shown } = await fixture();
    await handleMergeWorktreeGroups(null, deps);
    await handleMergeWorktreeGroups({ type: 'merge-worktree-groups' }, deps);
    await handleMergeWorktreeGroups(mergeRequest(sourceGroupId(deps.store), { version: 2 }), deps);
    await handleMergeWorktreeGroups(mergeRequest(sourceGroupId(deps.store), { requestId: 'bad id!' }), deps);
    assert.deepEqual(posted, []);
    assert.equal(shown.picks, null);
});

test('WORKTREE-GROUPS-MERGE-001 unroutable and stale-source requests settle failed, never silently', async () => {
    const { store, deps, posted } = await fixture();
    await handleMergeWorktreeGroups(mergeRequest('g-any', { projectId: 'other' }), deps);
    await handleMergeWorktreeGroups(mergeRequest('g-missing', { requestId: 'merge-n1-2' }), deps);
    assert.deepEqual(statuses(posted), ['accepted', 'failed', 'accepted', 'failed']);
    assert.equal(posted[1].errorCode, 'workspace-unavailable');
    assert.equal(posted[3].errorCode, 'group-not-found');
    assert.equal(store.listGroups(WORKSPACE).length, 2, 'nothing was written');
});

test('WORKTREE-GROUPS-MERGE-001 the host re-derives candidates, merges with the double revision binding, and settles merged', async () => {
    const { store, deps, posted, shown } = await fixture();
    deps.pickResult = undefined; // dialog dismissed
    await handleMergeWorktreeGroups(mergeRequest(sourceGroupId(store)), deps);
    assert.equal(shown.picks.length, 1);
    assert.deepEqual(statuses(posted), ['accepted', 'cancelled'],
        'a dismissed dialog settles cancelled so the webview never hangs');
    assert.equal(shown.refreshed, 0);

    const groups = store.listGroups(WORKSPACE);
    deps.pickResult = { label: 'Fix login (2)', groupId: groups[1].groupId };
    await handleMergeWorktreeGroups(
        mergeRequest(groups[0].groupId, { requestId: 'merge-n1-2' }), deps);
    const merged = store.listGroups(WORKSPACE);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].groupId, groups[1].groupId, 'source merged into the chosen target');
    assert.equal(merged[0].members.length, 2);
    assert.deepEqual(statuses(posted), ['accepted', 'cancelled', 'accepted', 'merged']);
    assert.equal(posted[3].groupId, groups[1].groupId);
    assert.equal(shown.refreshed, 1);
});

test('WORKTREE-GROUPS-MERGE-001 the merged settlement waits for the authoritative refresh (review R6)', async () => {
    const { store, deps, posted } = await fixture();
    let releaseRefresh;
    deps.refreshNow = () => new Promise(resolve => { releaseRefresh = resolve; });
    const groups = store.listGroups(WORKSPACE);
    deps.pickResult = { label: 'Fix login (2)', groupId: groups[1].groupId };
    const handler = handleMergeWorktreeGroups(mergeRequest(groups[0].groupId), deps);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(statuses(posted), ['accepted'],
        'the terminal settlement is not posted before the refresh completes');
    releaseRefresh();
    await handler;
    assert.deepEqual(statuses(posted), ['accepted', 'merged']);
});

test('WORKTREE-GROUPS-MERGE-001 a replay is settled from the cache and never re-executes', async () => {
    const { store, deps, posted } = await fixture();
    const groups = store.listGroups(WORKSPACE);
    deps.pickResult = { label: 'Fix login (2)', groupId: groups[1].groupId };
    const request = mergeRequest(groups[0].groupId);
    await handleMergeWorktreeGroups(request, deps);
    assert.equal(store.listGroups(WORKSPACE).length, 1);
    await handleMergeWorktreeGroups(request, deps);
    assert.equal(store.listGroups(WORKSPACE).length, 1, 'no second merge');
    assert.deepEqual(statuses(posted), ['accepted', 'merged', 'merged'],
        'the replay re-receives the recorded terminal settlement');
});

test('WORKTREE-GROUPS-MERGE-001 a revision drift between dialog and write settles failed and warns', async () => {
    const { store, deps, posted, shown } = await fixture();
    const groups = store.listGroups(WORKSPACE);
    deps.showQuickPick = async () => {
        await store.renameGroup(WORKSPACE, groups[0].groupId, 'Renamed while open');
        return { label: 'target', groupId: groups[1].groupId };
    };
    await handleMergeWorktreeGroups(mergeRequest(groups[0].groupId), deps);
    assert.equal(store.listGroups(WORKSPACE).length, 2, 'stale merge writes nothing');
    assert.deepEqual(statuses(posted), ['accepted', 'failed']);
    assert.equal(posted[1].errorCode, 'group-changed');
    assert.ok(shown.warnings[0].includes('changed while the merge was open'));
});
