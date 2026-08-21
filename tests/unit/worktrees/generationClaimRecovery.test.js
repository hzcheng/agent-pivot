'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGenerationClaimRecovery } = require('../../../out/worktrees/generationClaimRecovery');

const WORKSPACE = { navigationIdentity: 'nav:one' };
const CLAIM = {
    state: 'pending',
    launchMarkerPath: '/markers/m1',
    worktreeKey: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/wt' },
};

function createHarness(overrides = {}) {
    const calls = { reconciled: [], errors: [] };
    const recover = createGenerationClaimRecovery({
        listGenerationClaims: () => overrides.claims ?? [CLAIM],
        reconcileGenerationClaims: async (identity, resolve) => {
            calls.reconciled.push((overrides.claims ?? [CLAIM]).map(claim => resolve(claim).kind));
        },
        listTerminalBindings: () => 'bindings' in overrides ? overrides.bindings : [],
        logError: message => calls.errors.push(message),
        ...overrides.deps,
    });
    return { recover, calls };
}

test('claim recovery keeps claims when bindings are absent, missing, or ambiguous', async () => {
    // No bindings at all: enumeration failed is not evidence.
    const none = createHarness({ bindings: null });
    await none.recover(WORKSPACE);
    assert.deepEqual(none.calls.reconciled, []);

    // No claim has a launch marker path: nothing to resolve.
    const noMarker = createHarness({ claims: [{ state: 'pending' }] });
    await noMarker.recover(WORKSPACE);
    assert.deepEqual(noMarker.calls.reconciled, [['keep']]);

    // Duplicate marker paths across different sessions: ambiguous, fail closed.
    const ambiguous = createHarness({
        bindings: [
            { state: 'bound', providerId: 'codex', sessionId: 'a', workspaceNavigationIdentity: 'nav:one', markerPath: '/markers/m1', worktreeKey: CLAIM.worktreeKey },
            { state: 'released', providerId: 'kimi', sessionId: 'b', workspaceNavigationIdentity: 'nav:one', markerPath: '/markers/m1', worktreeKey: CLAIM.worktreeKey },
        ],
    });
    await ambiguous.recover(WORKSPACE);
    assert.deepEqual(ambiguous.calls.reconciled, []);
    assert.equal(ambiguous.calls.errors.length, 1);
});

test('claim recovery promotes only the exactly matching bound session', async () => {
    const exact = createHarness({
        bindings: [{
            state: 'bound',
            providerId: 'codex',
            sessionId: 'sess-1',
            workspaceNavigationIdentity: 'nav:one',
            markerPath: '/markers/m1',
            worktreeKey: CLAIM.worktreeKey,
        }],
    });
    await exact.recover(WORKSPACE);
    assert.deepEqual(exact.calls.reconciled, [['promote']]);

    const wrongBucket = createHarness({
        bindings: [{
            state: 'bound',
            providerId: 'codex',
            sessionId: 'sess-1',
            workspaceNavigationIdentity: 'nav:other',
            markerPath: '/markers/m1',
            worktreeKey: CLAIM.worktreeKey,
        }],
    });
    await wrongBucket.recover(WORKSPACE);
    assert.deepEqual(wrongBucket.calls.reconciled, [['keep']]);
});

test('claim recovery is a no-op without pending claims', async () => {
    const harness = createHarness({ claims: [] });
    await harness.recover(WORKSPACE);
    assert.deepEqual(harness.calls.reconciled, []);
    assert.deepEqual(harness.calls.errors, []);
});
