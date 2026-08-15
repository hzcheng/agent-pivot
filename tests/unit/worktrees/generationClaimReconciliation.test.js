'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    resolveGenerationClaimDisposition,
} = require('../../../out/worktrees/generationClaimReconciliation');

const KEY = {
    repositoryKey: '/alpha/.git',
    canonicalWorktreePath: '/alpha/.worktrees/fix-login',
};

function pendingClaim(overrides) {
    return {
        claimId: 'c-1',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        state: 'pending',
        pendingId: 'p-1',
        creatingProvider: 'codex',
        launchMarkerPath: '/tmp/marker-1.done',
        ...(overrides || {}),
    };
}

function boundEntry(overrides) {
    return {
        provider: 'codex',
        sessionId: 's-found',
        navigationIdentity: 'nav-1',
        worktreeKey: KEY,
        ...(overrides || {}),
    };
}

function evidence(map, overrides) {
    return {
        navigationIdentity: 'nav-1',
        boundSessionByMarkerPath: map,
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a bound marker re-attaches the session after a crash', () => {
    const disposition = resolveGenerationClaimDisposition(pendingClaim(), evidence(
        new Map([['/tmp/marker-1.done', boundEntry()]])));
    assert.deepEqual(disposition, {
        kind: 'promote', provider: 'codex', sessionId: 's-found',
    });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 absence of evidence is never a reason to discard', () => {
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(),
        evidence(new Map())), { kind: 'keep' }, 'no binding found: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(),
        evidence(null)), { kind: 'keep' }, 'enumeration failed or ambiguous: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ launchMarkerPath: undefined }),
        evidence(new Map())), { kind: 'keep' }, 'legacy claim without a marker path: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ state: 'promoted', provider: 'codex', sessionId: 's-1' }),
        evidence(new Map())), { kind: 'keep' }, 'already-promoted claims are left alone');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 promotion requires the full composite identity to match', () => {
    const mismatches = [
        ['another bucket', boundEntry({ navigationIdentity: 'nav-2' })],
        ['another provider', boundEntry({ provider: 'kimi' })],
        ['another worktree key', boundEntry({
            worktreeKey: {
                repositoryKey: '/beta/.git',
                canonicalWorktreePath: '/beta/.worktrees/fix-login',
            },
        })],
    ];
    for (const [label, entry] of mismatches) {
        assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence(
            new Map([['/tmp/marker-1.done', entry]]))),
            { kind: 'keep' }, label);
    }
    // A binding without a worktree key cannot prove anything about this
    // path: keep, never promote.
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence(
        new Map([['/tmp/marker-1.done', boundEntry({ worktreeKey: undefined })]]))),
        { kind: 'keep' }, 'keyless binding');
});
