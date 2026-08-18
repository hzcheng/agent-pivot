'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    handleMergeWorktreeGroups,
} = require('../../../out/worktrees/groupMergeHandler');

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
    const shown = { picks: null, placeHolder: null, warnings: [], refreshed: 0 };
    const deps = {
        getNavigationIdentity: projectId => (projectId === 'project' ? WORKSPACE : null),
        store,
        showQuickPick: async (picks, placeHolder) => {
            shown.picks = picks;
            shown.placeHolder = placeHolder;
            return deps.pickResult;
        },
        showWarning: message => shown.warnings.push(message),
        refreshNow: async () => { shown.refreshed += 1; },
        logError: () => {},
        pickResult: undefined,
    };
    return { store, deps, shown };
}

const sourceGroupId = store => store.listGroups(WORKSPACE)[0].groupId;

test('WORKTREE-GROUPS-MERGE-001 malformed or unroutable messages are dropped without any UI', async () => {
    const { deps, shown } = await fixture();
    await handleMergeWorktreeGroups(null, deps);
    await handleMergeWorktreeGroups({ type: 'merge-worktree-groups' }, deps);
    await handleMergeWorktreeGroups(
        { projectId: 'project', sourceGroupId: 'missing' }, deps);
    await handleMergeWorktreeGroups(
        { projectId: 'other-project', sourceGroupId: 'x' }, deps);
    assert.equal(shown.picks, null);
    assert.equal(shown.refreshed, 0);
});

test('WORKTREE-GROUPS-MERGE-001 the host re-derives candidates and merges with the double revision binding', async () => {
    const { store, deps, shown } = await fixture();
    deps.pickResult = undefined; // first: dialog dismissed
    await handleMergeWorktreeGroups(
        { projectId: 'project', sourceGroupId: sourceGroupId(store) }, deps);
    assert.equal(shown.picks.length, 1);
    assert.equal(shown.refreshed, 0, 'a dismissed dialog changes nothing');

    const groups = store.listGroups(WORKSPACE);
    deps.pickResult = { label: 'Fix login (2)', groupId: groups[1].groupId };
    await handleMergeWorktreeGroups(
        { projectId: 'project', sourceGroupId: groups[0].groupId }, deps);
    const merged = store.listGroups(WORKSPACE);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].groupId, groups[1].groupId, 'source merged into the chosen target');
    assert.equal(merged[0].members.length, 2);
    assert.equal(shown.refreshed, 1);
});

test('WORKTREE-GROUPS-MERGE-001 a revision drift between dialog and write warns and writes nothing', async () => {
    const { store, deps, shown } = await fixture();
    const groups = store.listGroups(WORKSPACE);
    deps.showQuickPick = async (picks) => {
        // The source group changes while the dialog is open.
        await store.renameGroup(WORKSPACE, groups[0].groupId, 'Renamed while open');
        return { label: 'target', groupId: groups[1].groupId };
    };
    await handleMergeWorktreeGroups(
        { projectId: 'project', sourceGroupId: groups[0].groupId }, deps);
    assert.equal(store.listGroups(WORKSPACE).length, 2, 'stale merge writes nothing');
    assert.equal(shown.warnings.length, 1);
    assert.ok(shown.warnings[0].includes('changed while the merge was open'));
    assert.equal(shown.refreshed, 0);
});
