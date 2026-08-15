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

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a bound marker re-attaches the session after a crash', () => {
    const disposition = resolveGenerationClaimDisposition(pendingClaim(), {
        boundSessionByMarkerPath: new Map([[
            '/tmp/marker-1.done', { provider: 'codex', sessionId: 's-found' },
        ]]),
    });
    assert.deepEqual(disposition, {
        kind: 'promote', provider: 'codex', sessionId: 's-found',
    });
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 absence of evidence is never a reason to discard', () => {
    // Markers are cleaned up when terminals close and provider inventories
    // cannot prove a negative, so reconciliation never discards: empty
    // evidence, failed enumeration, and legacy claims all keep.
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), {
        boundSessionByMarkerPath: new Map(),
    }), { kind: 'keep' }, 'no binding found: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(pendingClaim(), {
        boundSessionByMarkerPath: null,
    }), { kind: 'keep' }, 'enumeration failed or ambiguous: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ launchMarkerPath: undefined }),
        { boundSessionByMarkerPath: new Map() },
    ), { kind: 'keep' }, 'legacy claim without a marker path: keep');
    assert.deepEqual(resolveGenerationClaimDisposition(
        pendingClaim({ state: 'promoted', provider: 'codex', sessionId: 's-1' }),
        { boundSessionByMarkerPath: new Map() },
    ), { kind: 'keep' }, 'already-promoted claims are left alone');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a stale snapshot can only delay, never mis-promote', () => {
    // The marker link is a durable fact: when the snapshot predates the
    // binding, the claim simply waits for the next tick.
    const claim = pendingClaim();
    assert.deepEqual(resolveGenerationClaimDisposition(claim, {
        boundSessionByMarkerPath: new Map([[
            '/tmp/other-marker.done', { provider: 'codex', sessionId: 's-other' },
        ]]),
    }), { kind: 'keep' }, 'a different marker never attaches');
});
