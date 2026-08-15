'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
    WorktreeGroupManifestError,
} = require('../../../out/worktrees/groupManifestStore');

const WORKSPACE = 'workspace-nav-id';
const OTHER_WORKSPACE = 'other-workspace-nav-id';

function memento(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        async update(key, value) {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

function readyMember(repositoryKey, slug) {
    return {
        repositoryKey: `/repos/${repositoryKey}/.git`,
        worktreeKey: {
            repositoryKey: `/repos/${repositoryKey}/.git`,
            canonicalWorktreePath: `/repos/${repositoryKey}/.worktrees/${slug}`,
        },
        branchName: `agent-pivot/${slug}`,
        path: `/repos/${repositoryKey}/.worktrees/${slug}`,
        state: 'ready',
    };
}

function plannedMember(repositoryKey, slug) {
    return {
        repositoryKey: `/repos/${repositoryKey}/.git`,
        branchName: `agent-pivot/${slug}`,
        path: `/repos/${repositoryKey}/.worktrees/${slug}`,
        state: 'planned',
    };
}

async function createGroup(store, members, overrides) {
    return store.createGroup(WORKSPACE, {
        displayName: 'fix login',
        suggestedSlug: 'fix-login',
        members,
        ...(overrides || {}),
    });
}

test('WORKTREE-GROUPS-001 creates a group and resolves the primary ready member', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        plannedMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    assert.equal(group.members.length, 2);
    const beta = group.members.find(member => member.repositoryKey.includes('beta'));
    assert.equal(group.primaryMemberId, beta.memberId);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 rejects a requested primary that is not ready', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await assert.rejects(
        createGroup(store, [plannedMember('alpha', 'x'), readyMember('beta', 'x')],
            { primaryMemberIndex: 0 }),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'primary-not-ready');
    const group = await createGroup(store,
        [plannedMember('alpha', 'x'), readyMember('beta', 'x')],
        { primaryMemberIndex: 1 });
    assert.ok(group.primaryMemberId);
});

test('WORKTREE-GROUPS-001 enforces one member per repository within a group', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await assert.rejects(
        createGroup(store, [readyMember('alpha', 'one'), readyMember('alpha', 'two')]),
        error => error.code === 'repository-conflict');
    const group = await createGroup(store, [readyMember('alpha', 'one')]);
    await assert.rejects(
        store.addMember(WORKSPACE, group.groupId, readyMember('alpha', 'two')),
        error => error.code === 'repository-conflict');
});

test('WORKTREE-GROUPS-001 enforces a worktree key belongs to at most one group per workspace', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    await assert.rejects(
        createGroup(store, [readyMember('alpha', 'fix-login')]),
        error => error.code === 'worktree-key-claimed');
    // The same physical worktree may be grouped independently in another
    // workspace bucket (PRD §9 known rule).
    const other = await store.createGroup(OTHER_WORKSPACE, {
        displayName: 'other', suggestedSlug: 'fix-login',
        members: [readyMember('alpha', 'fix-login')],
    });
    assert.ok(other.groupId);
    assert.equal(store.findGroupByWorktreeKey(WORKSPACE,
        readyMember('alpha', 'fix-login').worktreeKey).groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 clears the primary when it stops being ready and requires a ready replacement', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    const primary = group.members.find(member => member.memberId === group.primaryMemberId);
    const other = group.members.find(member => member.memberId !== group.primaryMemberId);
    await assert.rejects(
        store.setPrimaryMember(WORKSPACE, group.groupId, 'missing-member'),
        error => error.code === 'member-not-found');
    const failed = await store.updateMember(WORKSPACE, group.groupId, primary.memberId,
        { state: 'failed', lastError: 'interrupted' });
    assert.equal(failed.primaryMemberId, null);
    const updated = await store.setPrimaryMember(WORKSPACE, group.groupId, other.memberId);
    assert.equal(updated.primaryMemberId, other.memberId);
});

test('WORKTREE-GROUPS-001 removes the group record when its last member is removed', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        plannedMember('beta', 'fix-login'),
    ]);
    const remaining = await store.removeMember(
        WORKSPACE, group.groupId, group.members[0].memberId);
    assert.equal(remaining.members.length, 1);
    const gone = await store.removeMember(
        WORKSPACE, group.groupId, remaining.members[0].memberId);
    assert.equal(gone, null);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-001 merges groups, moves every member state along, and blocks repository conflicts', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const target = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    const source = await store.createGroup(OTHER_WORKSPACE, {
        displayName: 'source', suggestedSlug: 'fix-login',
        members: [readyMember('beta', 'fix-login')],
    });
    void source;
    const conflicting = await createGroup(store, [readyMember('alpha', 'fix-login-2')]);
    await assert.rejects(
        store.mergeGroups(WORKSPACE, target.groupId, conflicting.groupId),
        error => error.code === 'repository-conflict');
    const compatible = await store.createGroup(WORKSPACE, {
        displayName: 'compatible', suggestedSlug: 'fix-login',
        members: [{ ...plannedMember('beta', 'fix-login'), state: 'failed', lastError: 'interrupted' }],
    });
    const merged = await store.mergeGroups(WORKSPACE, target.groupId, compatible.groupId);
    assert.equal(merged.members.length, 2);
    const moved = merged.members.find(member => member.repositoryKey.includes('beta'));
    assert.equal(moved.state, 'failed');
    assert.equal(moved.lastError, 'interrupted');
    assert.equal(store.listGroups(WORKSPACE).length, 2);
    assert.equal(merged.primaryMemberId, target.primaryMemberId);
});

test('WORKTREE-GROUPS-001 tracks repository detachment without changing bucket membership', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    await store.setRepositoryDetached(WORKSPACE, readyMember('beta', 'fix-login').repositoryKey, true);
    let listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.find(member =>
        member.repositoryKey.includes('beta')).detached, true);
    await store.setRepositoryDetached(WORKSPACE, readyMember('beta', 'fix-login').repositoryKey, false);
    listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.find(member =>
        member.repositoryKey.includes('beta')).detached, undefined);
    assert.equal(listed[0].groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 ignores corrupt persisted entries and rejects unsafe writes', async () => {
    const state = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [
                null,
                { groupId: 'g1' },
                {
                    groupId: 'g2', displayName: 'ok', suggestedSlug: 'ok', createdAt: 1,
                    primaryMemberId: null,
                    members: [{
                        memberId: 'm1', repositoryKey: '/repos/alpha/.git',
                        branchName: 'agent-pivot/ok', path: '/tmp/ok', state: 'ready',
                    }],
                },
                {
                    groupId: 'g3', displayName: 'good', suggestedSlug: 'good', createdAt: 2,
                    primaryMemberId: null,
                    members: [{
                        memberId: 'm2', repositoryKey: '/repos/beta/.git',
                        worktreeKey: {
                            repositoryKey: '/repos/beta/.git',
                            canonicalWorktreePath: '/repos/beta/.worktrees/good',
                        },
                        branchName: 'agent-pivot/good',
                        path: '/repos/beta/.worktrees/good', state: 'ready',
                    }],
                },
            ],
            'bad\nbucket': [],
        },
    });
    const store = new WorktreeGroupManifestStore(state);
    const groups = store.listGroups(WORKSPACE);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].groupId, 'g3');
    await assert.rejects(
        createGroup(store, [{ ...readyMember('alpha', 'x'), branchName: '-evil' }]),
        error => error.code === 'invalid-record');
    await assert.rejects(
        store.createGroup('bad\nidentity', {
            displayName: 'x', suggestedSlug: 'x', members: [readyMember('alpha', 'x')],
        }),
        error => error.code === 'invalid-record');
});

test('WORKTREE-GROUPS-001 serializes concurrent writes without losing groups', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const [one, two] = await Promise.all([
        createGroup(store, [readyMember('alpha', 'one')]),
        store.createGroup(WORKSPACE, {
            displayName: 'two', suggestedSlug: 'two', members: [readyMember('beta', 'two')],
        }),
    ]);
    const ids = store.listGroups(WORKSPACE).map(group => group.groupId).sort();
    assert.deepEqual(ids, [one.groupId, two.groupId].sort());
});

function retiredInput(overrides) {
    return {
        retirementId: 'r-1',
        repositoryKey: '/repos/alpha/.git',
        canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        branchName: 'agent-pivot/fix-login',
        deletedAt: 200,
        generationCutoffAt: 100,
        affectedSessions: [{ provider: 'codex', sessionId: 's-1' }],
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 v1 buckets migrate structurally with empty new sections', async () => {
    // The legacy format stores bare group arrays per bucket; the v2
    // aggregate must carry them over untouched and start every new section
    // empty — nothing is inferred into retired identities or claims.
    const store = new WorktreeGroupManifestStore(memento());
    const created = await createGroup(store, [readyMember('alpha', 'fix-login')]);

    const reloaded = new WorktreeGroupManifestStore(memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [{
                groupId: created.groupId,
                displayName: created.displayName,
                suggestedSlug: created.suggestedSlug,
                primaryMemberId: created.primaryMemberId,
                members: created.members,
                createdAt: created.createdAt,
                revision: created.revision,
            }],
        },
    }));
    assert.equal(reloaded.listGroups(WORKSPACE).length, 1,
        'legacy group arrays still load');
    assert.deepEqual(reloaded.listRetiredIdentities(WORKSPACE), []);
    assert.deepEqual(reloaded.listGenerationClaims(WORKSPACE), []);
    assert.equal(reloaded.nextGenerationCutoff(WORKSPACE, 5), 5);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 retired records round-trip with claims and cutoffs', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const record = await store.recordRetiredIdentity(WORKSPACE, retiredInput({
        origin: { groupId: 'g-1', memberId: 'm-1', displayName: 'Fix login' },
        affectedSessions: [
            { provider: 'codex', sessionId: 's-1' },
            { provider: 'codex', sessionId: 's-1' },
            { provider: 'kimi', sessionId: 's-2' },
        ],
    }));
    assert.equal(record.affectedSessions.length, 2, 'affected sessions dedupe');
    const listed = store.listRetiredIdentities(WORKSPACE);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].retirementId, 'r-1');
    assert.equal(listed[0].origin.displayName, 'Fix login');
    assert.equal(store.nextGenerationCutoff(WORKSPACE, 1), 101,
        'the cutoff high-water mark moved with the record');

    const claim = await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-1',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
    });
    assert.equal(claim.state, 'pending');
    const promoted = await store.promoteGenerationClaim(
        WORKSPACE, 'p-1', { provider: 'codex', sessionId: 's-9' });
    assert.equal(promoted.state, 'promoted');
    assert.equal(promoted.sessionId, 's-9');

    // Full round-trip through the persisted shape.
    const reloaded = new WorktreeGroupManifestStore(memento({
        'agentPivot.worktreeGroups.v1': JSON.parse(JSON.stringify({
            [WORKSPACE]: {
                version: 2,
                groups: [],
                retiredIdentities: store.listRetiredIdentities(WORKSPACE),
                deletionJournal: [],
                generationClaims: store.listGenerationClaims(WORKSPACE),
                lastGenerationCutoffAt: 100,
            },
        })),
    }));
    assert.equal(reloaded.listRetiredIdentities(WORKSPACE).length, 1);
    assert.equal(reloaded.listGenerationClaims(WORKSPACE)[0].state, 'promoted');
    assert.equal(reloaded.nextGenerationCutoff(WORKSPACE, 1), 101);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 claims require a known retirement basis', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await assert.rejects(
        store.createGenerationClaim(WORKSPACE, {
            pendingId: 'p-1',
            worktreeKey: {
                repositoryKey: '/repos/alpha/.git',
                canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
            },
            createdAfterRetirementId: 'r-missing',
            createdAtMs: 150,
        }),
        error => error.code === 'invalid-record');
    await assert.rejects(
        store.promoteGenerationClaim(WORKSPACE, 'p-unknown', {
            provider: 'codex', sessionId: 's-1',
        }),
        error => error.code === 'invalid-record');
    assert.equal(await store.removeGenerationClaim(WORKSPACE, 'c-missing'), false);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 retired cleanup releases claims and never regresses the cutoff', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());
    const claim = await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-1',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
    });
    assert.equal(await store.removeRetiredIdentity(WORKSPACE, 'r-1'), true);
    assert.deepEqual(store.listRetiredIdentities(WORKSPACE), []);
    assert.deepEqual(store.listGenerationClaims(WORKSPACE), [],
        'claims referencing the removed retirement are released');
    void claim;
    // Even with every retired record gone, a rolled-back clock must not
    // reuse an older cutoff.
    assert.equal(store.nextGenerationCutoff(WORKSPACE, 10), 101);
    await store.recordRetiredIdentity(WORKSPACE, retiredInput({
        retirementId: 'r-2', generationCutoffAt: 101,
    }));
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 retired capacity fails closed and truncation is explicit', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const manySessions = Array.from({ length: 300 }, (_, index) => ({
        provider: 'codex', sessionId: `s-${index}`,
    }));
    const record = await store.recordRetiredIdentity(WORKSPACE, retiredInput({
        affectedSessions: manySessions,
    }));
    assert.equal(record.affectedSessions.length, 256);
    assert.equal(record.truncated, true,
        'detail truncation is explicit; the generation rules fail closed for the rest');

    for (let index = 0; index < 255; index++) {
        await store.recordRetiredIdentity(WORKSPACE, retiredInput({
            retirementId: `r-fill-${index}`,
            canonicalWorktreePath: `/repos/alpha/.worktrees/fill-${index}`,
        }));
    }
    await assert.rejects(
        store.recordRetiredIdentity(WORKSPACE, retiredInput({
            retirementId: 'r-overflow',
            canonicalWorktreePath: '/repos/alpha/.worktrees/overflow',
        })),
        error => error.code === 'store-full',
        'the 257th retired record is refused instead of evicting silently');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 store enforces the reference invariants', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());
    await assert.rejects(
        store.recordRetiredIdentity(WORKSPACE, retiredInput({
            canonicalWorktreePath: '/repos/alpha/.worktrees/other',
        })),
        error => error.code === 'invalid-record',
        'duplicate retirement ids are rejected');
    await assert.rejects(
        store.createGenerationClaim(WORKSPACE, {
            pendingId: 'p-1',
            worktreeKey: {
                repositoryKey: '/repos/beta/.git',
                canonicalWorktreePath: '/repos/beta/.worktrees/fix-login',
            },
            createdAfterRetirementId: 'r-1',
            createdAtMs: 150,
        }),
        error => error.code === 'invalid-record',
        'a claim cannot reference a retirement of a different worktree key');
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-dup',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
    });
    await assert.rejects(
        store.createGenerationClaim(WORKSPACE, {
            pendingId: 'p-dup',
            worktreeKey: {
                repositoryKey: '/repos/alpha/.git',
                canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
            },
            createdAfterRetirementId: 'r-1',
            createdAtMs: 160,
        }),
        error => error.code === 'invalid-record',
        'pending ids stay unique');
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-second',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 170,
    });
    await store.promoteGenerationClaim(WORKSPACE, 'p-dup', {
        provider: 'codex', sessionId: 's-shared',
    });
    await assert.rejects(
        store.promoteGenerationClaim(WORKSPACE, 'p-second', {
            provider: 'codex', sessionId: 's-shared',
        }),
        error => error.code === 'invalid-record',
        'a promoted session identity backs at most one claim');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 promotion verifies the creating provider', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-1',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        creatingProvider: 'codex',
    });
    await assert.rejects(
        store.promoteGenerationClaim(WORKSPACE, 'p-1', {
            provider: 'kimi', sessionId: 's-1',
        }),
        error => error.code === 'invalid-record',
        'a Codex pending claim cannot be promoted into a Kimi session');
    const promoted = await store.promoteGenerationClaim(WORKSPACE, 'p-1', {
        provider: 'codex', sessionId: 's-1',
    });
    assert.equal(promoted.provider, 'codex');
});

test('WORKTREE-GROUPS-RENAME-001 rename rejects a stale expected revision atomically', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    await assert.rejects(
        store.renameGroup(WORKSPACE, group.groupId, 'new name', group.revision + 1),
        error => error.code === 'group-changed',
        'a rename based on an older revision fails closed');
    assert.equal(store.listGroups(WORKSPACE)[0].displayName, 'fix login');
    assert.equal(store.listGroups(WORKSPACE)[0].revision, group.revision,
        'the rejected rename changes nothing');
    const renamed = await store.renameGroup(
        WORKSPACE, group.groupId, 'new name', group.revision);
    assert.equal(renamed.displayName, 'new name');
    assert.equal(renamed.revision, group.revision + 1);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 reconciliation promotes and keeps in one write', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());
    for (const pendingId of ['p-promote', 'p-keep', 'p-throw']) {
        await store.createGenerationClaim(WORKSPACE, {
            pendingId,
            worktreeKey: {
                repositoryKey: '/repos/alpha/.git',
                canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
            },
            createdAfterRetirementId: 'r-1',
            createdAtMs: 150,
        });
    }
    const outcome = await store.reconcileGenerationClaims(WORKSPACE, claim => {
        if (claim.pendingId === 'p-promote') {
            return { kind: 'promote', provider: 'codex', sessionId: 's-found' };
        }
        if (claim.pendingId === 'p-throw') {
            throw new Error('resolver exploded');
        }
        return { kind: 'keep' };
    });
    assert.deepEqual(outcome, { promoted: 1, kept: 2 },
        'a resolver failure keeps the claim (fail-closed)');
    const claims = store.listGenerationClaims(WORKSPACE);
    const byPending = id => claims.find(claim =>
        claim.pendingId === id || claim.sessionId === id);
    assert.equal(byPending('s-found').state, 'promoted');
    assert.equal(byPending('p-keep').state, 'pending');
    assert.equal(byPending('p-throw').state, 'pending');

    // A second pass is a no-op: reconciliation is idempotent.
    const again = await store.reconcileGenerationClaims(WORKSPACE, () => ({ kind: 'keep' }));
    assert.deepEqual(again, { promoted: 0, kept: 2 });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 reconciliation keeps ambiguous promotion targets', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());
    for (const pendingId of ['p-a', 'p-b']) {
        await store.createGenerationClaim(WORKSPACE, {
            pendingId,
            worktreeKey: {
                repositoryKey: '/repos/alpha/.git',
                canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
            },
            createdAfterRetirementId: 'r-1',
            createdAtMs: 150,
        });
    }
    const outcome = await store.reconcileGenerationClaims(WORKSPACE, () => ({
        kind: 'promote', provider: 'codex', sessionId: 's-same',
    }));
    assert.deepEqual(outcome, { promoted: 0, kept: 2 },
        'two claims onto the same session identity are both kept — never an order-based guess');
    assert.equal(store.listGenerationClaims(WORKSPACE)
        .filter(claim => claim.state === 'pending').length, 2);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 the byte cap measures UTF-8 bytes, not code units', async () => {
    // A CJK path occupies ~3 UTF-8 bytes per code unit: a blob can fit the
    // old .length check while exceeding the real byte budget.
    const store = new WorktreeGroupManifestStore(memento());
    const hugePath = `/repos/alpha/.worktrees/${'目'.repeat(32000)}`;
    const members = [];
    for (let index = 0; index < 12; index++) {
        members.push({
            repositoryKey: `/repos/huge-${index}/.git`,
            worktreeKey: {
                repositoryKey: `/repos/huge-${index}/.git`,
                canonicalWorktreePath: `${hugePath}-${index}`,
            },
            branchName: `agent-pivot/huge-${index}`,
            path: `${hugePath}-${index}`,
            state: 'ready',
        });
    }
    await assert.rejects(
        store.createGroup(WORKSPACE, {
            displayName: 'huge', suggestedSlug: 'huge', members,
        }),
        error => error.code === 'store-full',
        'multibyte content cannot smuggle past the byte cap');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 persisted blobs are re-validated against cross-record invariants', async () => {
    const retiredRecord = over => ({
        retirementId: 'r-1',
        repositoryKey: '/repos/alpha/.git',
        canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        branchName: 'agent-pivot/fix-login',
        deletedAt: 200,
        generationCutoffAt: 100,
        affectedSessions: [],
        ...(over || {}),
    });
    const pendingClaim = over => ({
        claimId: 'c-1',
        worktreeKey: {
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        state: 'pending',
        pendingId: 'p-1',
        ...(over || {}),
    });
    const seeded = (records, claims, cutoff) => memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: {
                version: 2,
                groups: [],
                retiredIdentities: records,
                deletionJournal: [],
                generationClaims: claims,
                lastGenerationCutoffAt: cutoff,
            },
        },
    });

    // Duplicate retirement ids quarantine the whole retired/claim section:
    // no record may win by array order.
    let store = new WorktreeGroupManifestStore(seeded(
        [retiredRecord(), retiredRecord({
            canonicalWorktreePath: '/repos/alpha/.worktrees/dup',
        })],
        [pendingClaim()], 100));
    assert.equal(store.isRetiredStoreCorrupt(WORKSPACE), true);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 2,
        'retired records stay readable: unresumable marking is fail-closed');
    assert.deepEqual(store.listGenerationClaims(WORKSPACE), []);
    await assert.rejects(
        store.recordRetiredIdentity(WORKSPACE, retiredInput({ retirementId: 'r-new' })),
        error => error.code === 'store-corrupt',
        'mutations fail closed while the section is quarantined');

    // Claims with a missing or key-mismatched basis quarantine the bucket:
    // a pending claim may be the only deletion blocker for a live session,
    // so nothing is dropped — the whole section is marked corrupt.
    store = new WorktreeGroupManifestStore(seeded(
        [retiredRecord()],
        [
            pendingClaim({
                claimId: 'c-missing', pendingId: 'p-missing',
                createdAfterRetirementId: 'r-gone',
            }),
            pendingClaim({
                claimId: 'c-foreign', pendingId: 'p-foreign',
                worktreeKey: {
                    repositoryKey: '/repos/beta/.git',
                    canonicalWorktreePath: '/repos/beta/.worktrees/x',
                },
            }),
            pendingClaim(),
        ],
        100));
    assert.equal(store.isRetiredStoreCorrupt(WORKSPACE), true);
    assert.deepEqual(store.listGenerationClaims(WORKSPACE), [],
        'claims are suppressed while quarantined');

    // Duplicate pending ids / promoted identities quarantine as well —
    // never an order-based choice.
    store = new WorktreeGroupManifestStore(seeded(
        [retiredRecord()],
        [
            pendingClaim(),
            pendingClaim({ claimId: 'c-2', pendingId: 'p-1' }),
        ],
        100));
    assert.equal(store.isRetiredStoreCorrupt(WORKSPACE), true,
        'duplicate pending ids quarantine the bucket');

    store = new WorktreeGroupManifestStore(seeded(
        [retiredRecord(), retiredRecord({
            retirementId: 'r-2', generationCutoffAt: 300, deletedAt: 400,
        })],
        [
            {
                claimId: 'c-3', createdAfterRetirementId: 'r-1', createdAtMs: 150,
                state: 'promoted', provider: 'codex', sessionId: 's-1',
                worktreeKey: pendingClaim().worktreeKey,
            },
            {
                claimId: 'c-4', createdAfterRetirementId: 'r-2', createdAtMs: 350,
                state: 'promoted', provider: 'codex', sessionId: 's-1',
                worktreeKey: pendingClaim().worktreeKey,
            },
        ],
        300));
    assert.equal(store.isRetiredStoreCorrupt(WORKSPACE), true,
        'duplicate promoted identities quarantine the bucket, regardless of order');

    // A stored high-water mark below the records' cutoffs is repaired up.
    store = new WorktreeGroupManifestStore(seeded([retiredRecord()], [], 5));
    assert.equal(store.nextGenerationCutoff(WORKSPACE, 1), 101);
});

test('WORKTREE-GROUPS-RENAME-001 starts revision at 1 and migrates legacy records', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const created = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    assert.equal(created.revision, 1);

    const legacyState = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [{
                groupId: 'legacy',
                displayName: 'legacy group',
                suggestedSlug: 'legacy-group',
                primaryMemberId: 'm1',
                createdAt: 1,
                members: [{
                    memberId: 'm1', repositoryKey: '/repos/alpha/.git',
                    worktreeKey: {
                        repositoryKey: '/repos/alpha/.git',
                        canonicalWorktreePath: '/repos/alpha/.worktrees/legacy',
                    },
                    branchName: 'agent-pivot/legacy',
                    path: '/repos/alpha/.worktrees/legacy', state: 'ready',
                }],
            }],
        },
    });
    const legacyStore = new WorktreeGroupManifestStore(legacyState);
    assert.equal(legacyStore.listGroups(WORKSPACE)[0].revision, 1);
    const renamed = await legacyStore.renameGroup(WORKSPACE, 'legacy', 'new name');
    assert.equal(renamed.revision, 2);
});

test('WORKTREE-GROUPS-RENAME-001 drops records with a corrupt revision and rejects overflow', async () => {
    const corruptState = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [
                {
                    groupId: 'corrupt',
                    displayName: 'corrupt group',
                    suggestedSlug: 'corrupt-group',
                    primaryMemberId: 'm1',
                    createdAt: 1,
                    revision: 'not-a-number',
                    members: [{
                        memberId: 'm1', repositoryKey: '/repos/alpha/.git',
                        worktreeKey: {
                            repositoryKey: '/repos/alpha/.git',
                            canonicalWorktreePath: '/repos/alpha/.worktrees/corrupt',
                        },
                        branchName: 'agent-pivot/corrupt',
                        path: '/repos/alpha/.worktrees/corrupt', state: 'ready',
                    }],
                },
                {
                    groupId: 'healthy',
                    displayName: 'healthy group',
                    suggestedSlug: 'healthy-group',
                    primaryMemberId: 'm2',
                    createdAt: 2,
                    revision: 4,
                    members: [{
                        memberId: 'm2', repositoryKey: '/repos/beta/.git',
                        worktreeKey: {
                            repositoryKey: '/repos/beta/.git',
                            canonicalWorktreePath: '/repos/beta/.worktrees/healthy',
                        },
                        branchName: 'agent-pivot/healthy',
                        path: '/repos/beta/.worktrees/healthy', state: 'ready',
                    }],
                },
            ],
        },
    });
    const store = new WorktreeGroupManifestStore(corruptState);
    const groups = store.listGroups(WORKSPACE);
    assert.deepEqual(groups.map(group => group.groupId), ['healthy'],
        'a present-but-corrupt revision drops the record instead of resetting to 1');
    assert.equal(groups[0].revision, 4);

    const overflowState = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [{
                groupId: 'maxed',
                displayName: 'maxed group',
                suggestedSlug: 'maxed-group',
                primaryMemberId: 'm1',
                createdAt: 1,
                revision: Number.MAX_SAFE_INTEGER,
                members: [{
                    memberId: 'm1', repositoryKey: '/repos/alpha/.git',
                    worktreeKey: {
                        repositoryKey: '/repos/alpha/.git',
                        canonicalWorktreePath: '/repos/alpha/.worktrees/maxed',
                    },
                    branchName: 'agent-pivot/maxed',
                    path: '/repos/alpha/.worktrees/maxed', state: 'ready',
                }],
            }],
        },
    });
    const overflowStore = new WorktreeGroupManifestStore(overflowState);
    await assert.rejects(
        overflowStore.renameGroup(WORKSPACE, 'maxed', 'new name'),
        error => error.code === 'invalid-record',
        'a mutation that would overflow the revision is refused');
    assert.equal(
        overflowStore.listGroups(WORKSPACE)[0].revision,
        Number.MAX_SAFE_INTEGER,
        'the refused mutation leaves the revision untouched');
});

test('WORKTREE-GROUPS-RENAME-001 increments the revision on every successful mutation', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        plannedMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    let revision = group.revision;
    const readyBeta = group.members.find(member => member.state === 'ready');

    const renamed = await store.renameGroup(WORKSPACE, group.groupId, 'renamed');
    assert.equal(renamed.revision, ++revision);
    const reprimary = await store.setPrimaryMember(WORKSPACE, group.groupId, readyBeta.memberId);
    assert.equal(reprimary.revision, ++revision);
    const updated = await store.updateMember(
        WORKSPACE, group.groupId, reprimary.members[0].memberId, { lastError: 'x' });
    assert.equal(updated.revision, ++revision);
    const added = await store.addMember(
        WORKSPACE, group.groupId, plannedMember('gamma', 'fix-login'));
    assert.equal(added.revision, ++revision);
    const detached = await store.setRepositoryDetached(WORKSPACE, '/repos/alpha/.git', true);
    assert.equal(detached, undefined);
    assert.equal(store.listGroups(WORKSPACE)[0].revision, ++revision);
    const removedGamma = added.members.find(member => member.repositoryKey.includes('gamma'));
    const afterRemove = await store.removeMember(WORKSPACE, group.groupId, removedGamma.memberId);
    assert.equal(afterRemove.revision, ++revision);

    const other = await store.createGroup(WORKSPACE, {
        displayName: 'other', suggestedSlug: 'other', members: [readyMember('delta', 'other')],
    });
    const merged = await store.mergeGroups(WORKSPACE, group.groupId, other.groupId);
    assert.equal(merged.revision, revision + 1);
});

test('WORKTREE-GROUPS-RENAME-001 rename derives the slug and writes name, slug, revision together', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    const renamed = await store.renameGroup(WORKSPACE, group.groupId, 'Fix login v2');
    assert.equal(renamed.displayName, 'Fix login v2');
    assert.equal(renamed.suggestedSlug, 'fix-login-v2',
        'the store authoritatively derives the suggested slug from the new name');
    assert.equal(renamed.revision, group.revision + 1);
    const persisted = store.listGroups(WORKSPACE)[0];
    assert.equal(persisted.displayName, 'Fix login v2');
    assert.equal(persisted.suggestedSlug, 'fix-login-v2');
    assert.equal(persisted.revision, renamed.revision);

    const cjk = await store.renameGroup(WORKSPACE, group.groupId, '修复登录');
    assert.match(cjk.suggestedSlug, /^task-[a-f0-9]{6}$/,
        'CJK names fall back to a task-<6-char id> slug (PRD §5.2)');
    const short = await store.renameGroup(WORKSPACE, group.groupId, 'ab');
    assert.match(short.suggestedSlug, /^task-[a-f0-9]{6}$/,
        'names with fewer than 3 usable ASCII characters fall back too');

    // A failed rename (invalid name) must not move the revision.
    await assert.rejects(
        store.renameGroup(WORKSPACE, group.groupId, ''),
        error => error.code === 'invalid-record');
    await assert.rejects(
        store.renameGroup(WORKSPACE, group.groupId, '   '),
        error => error.code === 'invalid-record');
    assert.equal(store.listGroups(WORKSPACE)[0].revision, short.revision);
});
