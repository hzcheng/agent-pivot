'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    resolveGenerationClaimDisposition,
} = require('../../../out/worktrees/generationClaimReconciliation');

function pendingClaim(overrides) {
    return {
        claimId: 'c-1',
        worktreeKey: {
            repositoryKey: '/alpha/.git',
            canonicalWorktreePath: '/alpha/.worktrees/fix-login',
        },
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        state: 'pending',
        pendingId: 'p-1',
        creatingProvider: 'codex',
        launchMarkerPath: '/tmp/marker-1.done',
        ...(overrides || {}),
    };
}

function evidence(overrides) {
    return {
        livePendingIds: new Set(),
        pendingBindingIds: new Set(),
        boundSessionByMarkerPath: new Map(),
        markerExists: () => false,
        hasProviderActivityOnPath: () => false,
        isCreationInFlight: () => false,
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 in-flight creations are never discarded', () => {
    // The claim window (claim persisted, runtime not started) shows zero
    // evidence by definition; only the in-flight mark distinguishes it
    // from a crashed creation.
    const disposition = resolveGenerationClaimDisposition(
        pendingClaim(), evidence({ isCreationInFlight: () => true }));
    assert.deepEqual(disposition, { kind: 'keep' });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 failed evidence enumeration keeps every claim', () => {
    for (const broken of [
        { livePendingIds: null },
        { pendingBindingIds: null },
        { boundSessionByMarkerPath: null },
    ]) {
        assert.deepEqual(
            resolveGenerationClaimDisposition(pendingClaim(), evidence(broken)),
            { kind: 'keep' });
    }
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 live pending runtimes and bindings own their claims', () => {
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence({
        livePendingIds: new Set(['p-1']),
    })), { kind: 'keep' });
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence({
        pendingBindingIds: new Set(['p-1']),
    })), { kind: 'keep' });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a bound marker re-attaches the session after a crash', () => {
    const disposition = resolveGenerationClaimDisposition(pendingClaim(), evidence({
        boundSessionByMarkerPath: new Map([[
            '/tmp/marker-1.done', { provider: 'codex', sessionId: 's-found' },
        ]]),
    }));
    assert.deepEqual(disposition, {
        kind: 'promote', provider: 'codex', sessionId: 's-found',
    });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a completed marker without a binding keeps the claim', () => {
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence({
        markerExists: () => true,
    })), { kind: 'keep' });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 legacy claims without recovery fields are kept', () => {
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ launchMarkerPath: undefined }),
        evidence()), { kind: 'keep' },
        'no marker path: cannot prove the launch never happened');
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ creatingProvider: undefined }),
        evidence()), { kind: 'keep' },
        'no provider: cannot scan authoritatively');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 discard requires authoritative negative evidence', () => {
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence({
        hasProviderActivityOnPath: () => 'unknown',
    })), { kind: 'keep' }, 'an unreadable or truncated provider scan keeps the claim');
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence({
        hasProviderActivityOnPath: () => true,
    })), { kind: 'keep' }, 'provider activity on the path keeps the claim');
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), evidence()),
        { kind: 'discard' },
        'no runtime, no binding, no marker, authoritative silence → discard');
});
