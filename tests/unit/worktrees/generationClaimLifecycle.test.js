'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    resolveGenerationClaimDisposition,
} = require('../../../out/worktrees/generationClaimReconciliation');
const { judgeSessionGeneration } = require('../../../out/worktrees/retiredWorktrees');

const WORKSPACE = 'workspace-nav-id';
const KEY = {
    repositoryKey: '/repos/alpha/.git',
    canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
};

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

function retiredInput(overrides) {
    return {
        retirementId: 'r-1',
        repositoryKey: KEY.repositoryKey,
        canonicalWorktreePath: KEY.canonicalWorktreePath,
        branchName: 'agent-pivot/fix-login',
        deletedAt: 200,
        generationCutoffAt: 100,
        affectedSessions: [],
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 claim lifecycle state machine: write, crash, launch outcomes, deletion admission', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await store.recordRetiredIdentity(WORKSPACE, retiredInput());

    const pendingClaimsForKey = () => store.listGenerationClaims(WORKSPACE)
        .filter(claim => claim.state === 'pending'
            && claim.worktreeKey.canonicalWorktreePath === KEY.canonicalWorktreePath);

    // Phase 0 — before any claim write: nothing blocks deletion admission.
    assert.deepEqual(pendingClaimsForKey(), []);

    // Phase 1 — claim persisted, launch not attempted, process exits
    // (crash between the claim write and coordinator.create). The claim
    // survives reconciliation with empty evidence: absence is not proof.
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-crash-before-launch',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        creatingProvider: 'codex',
        launchMarkerPath: '/tmp/marker-crash.done',
    });
    assert.equal(pendingClaimsForKey().length, 1,
        'a persisted pending claim blocks deletion admission from this point on');
    let outcome = await store.reconcileGenerationClaims(WORKSPACE, claim =>
        resolveGenerationClaimDisposition(claim, {
            navigationIdentity: WORKSPACE,
            boundSessionByMarkerPath: new Map(),
        }));
    assert.deepEqual(outcome, { promoted: 0, kept: 1 },
        'crash-before-launch claims survive: reconciliation never discards');
    assert.equal(pendingClaimsForKey().length, 1,
        'the claim keeps blocking until explicit handling');

    // Phase 2 — a second creation fails with a *proven* not-started error:
    // the compensating delete releases exactly that claim.
    const doomed = await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-proven-failure',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 160,
        creatingProvider: 'codex',
        launchMarkerPath: '/tmp/marker-proven.done',
    });
    assert.equal(await store.removeGenerationClaim(WORKSPACE, doomed.claimId), true);
    assert.equal(pendingClaimsForKey().length, 1);

    // Phase 3 — a third creation's runtime promoted but the process died
    // before the claim promotion: the durable binding marker re-attaches
    // the session id.
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'p-crash-after-promote',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 170,
        creatingProvider: 'codex',
        launchMarkerPath: '/tmp/marker-promoted.done',
    });
    outcome = await store.reconcileGenerationClaims(WORKSPACE, claim =>
        resolveGenerationClaimDisposition(claim, {
            navigationIdentity: WORKSPACE,
            boundSessionByMarkerPath: new Map([[
                '/tmp/marker-promoted.done',
                {
                    provider: 'codex',
                    sessionId: 's-survivor',
                    navigationIdentity: WORKSPACE,
                    worktreeKey: KEY,
                },
            ]]),
        }));
    assert.deepEqual(outcome, { promoted: 1, kept: 1 });

    // Phase 4 — the promoted claim proves the current generation; the
    // still-pending claim keeps blocking deletion admission.
    const claims = store.listGenerationClaims(WORKSPACE);
    assert.equal(judgeSessionGeneration(retiredInput(), {
        provider: 'codex', sessionId: 's-survivor',
    }, claims, [retiredInput()], 1000), 'current');
    assert.equal(pendingClaimsForKey().length, 1,
        'the crash-before-launch claim is still pending and blocking');
    assert.equal(judgeSessionGeneration(retiredInput(), {
        provider: 'kimi', sessionId: 's-unknown',
    }, claims, [retiredInput()], 1000), 'retired',
        'unproven sessions stay fail-closed throughout');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a corrupt bucket quarantines instead of guessing', async () => {
    // Duplicate retirement ids in the persisted blob: the whole section is
    // quarantined — reads empty, mutations fail closed — rather than
    // letting array order pick an authoritative deletion fact.
    const corrupt = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: {
                version: 2,
                groups: [],
                retiredIdentities: [
                    retiredInput(),
                    retiredInput({ canonicalWorktreePath: '/repos/alpha/.worktrees/other' }),
                ],
                deletionJournal: [],
                generationClaims: [],
                lastGenerationCutoffAt: 100,
            },
        },
    });
    const store = new WorktreeGroupManifestStore(corrupt);
    assert.equal(store.isRetiredStoreCorrupt(WORKSPACE), true);
    assert.deepEqual(store.listRetiredIdentities(WORKSPACE), []);
    await assert.rejects(
        store.recordRetiredIdentity(WORKSPACE, retiredInput({ retirementId: 'r-new' })),
        error => error.code === 'store-corrupt');
});
