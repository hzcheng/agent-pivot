'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    findLatestRetirementForKey,
    findLatestRetirementForPath,
    judgeSessionGeneration,
} = require('../../../out/worktrees/retiredWorktrees');

const KEY = {
    repositoryKey: '/alpha/.git',
    canonicalWorktreePath: '/alpha/.worktrees/fix-login',
};
const NOW = 1000;

function retirement(overrides) {
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

function claim(overrides) {
    return {
        claimId: 'c-1',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        state: 'promoted',
        provider: 'codex',
        sessionId: 's-2',
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 the frozen affected list is authoritative', () => {
    const record = retirement({
        affectedSessions: [{ provider: 'codex', sessionId: 's-1' }],
    });
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-1', createdAtMs: 500,
    }, [], [record], NOW), 'retired');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a promoted claim marks the current generation', () => {
    const record = retirement();
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-2',
    }, [claim()], [record], NOW), 'current');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 multi-round retirements keep generations distinct', () => {
    // P deleted → R1; rebuilt; S2 created (claim post-R1); deleted again →
    // R2. S2 is current for R1 but retired for R2.
    const r1 = retirement({ retirementId: 'r-1', generationCutoffAt: 100 });
    const r2 = retirement({ retirementId: 'r-2', generationCutoffAt: 300, deletedAt: 400 });
    const s2Claim = claim({ createdAfterRetirementId: 'r-1', createdAtMs: 200 });
    const s2 = { provider: 'codex', sessionId: 's-2', createdAtMs: 200 };
    assert.equal(judgeSessionGeneration(r1, s2, [s2Claim], [r1, r2], NOW), 'current');
    assert.equal(judgeSessionGeneration(r2, s2, [s2Claim], [r1, r2], NOW), 'retired',
        'a claim based on the older retirement cannot prove the newer one');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 truncated records fail closed without precise identity', () => {
    const record = retirement({ truncated: true });
    assert.equal(judgeSessionGeneration(record, {
        provider: 'kimi', sessionId: 's-unknown',
    }, [], [record], NOW), 'retired',
        'no frozen identity, no claim, no creation time → old generation');
    assert.equal(judgeSessionGeneration(record, {
        provider: 'kimi', sessionId: 's-unknown', createdAtMs: Number.NaN,
    }, [], [record], NOW), 'retired', 'an invalid creation time is no evidence');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 stable creation time judges borderline sessions', () => {
    const record = retirement({ generationCutoffAt: 100 });
    assert.equal(judgeSessionGeneration(record, {
        provider: 'claude', sessionId: 's-3', createdAtMs: 100,
    }, [], [record], NOW), 'retired', 'creation at the cutoff is pre-deletion');
    assert.equal(judgeSessionGeneration(record, {
        provider: 'claude', sessionId: 's-4', createdAtMs: 101,
    }, [], [record], NOW), 'current');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a claim on another worktree does not apply', () => {
    const record = retirement();
    const foreignClaim = claim({
        worktreeKey: {
            repositoryKey: '/beta/.git',
            canonicalWorktreePath: '/beta/.worktrees/fix-login',
        },
    });
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-2',
    }, [foreignClaim], [record], NOW), 'retired');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 pending claims never judge generations', () => {
    const record = retirement();
    const pendingClaim = {
        claimId: 'c-1',
        worktreeKey: KEY,
        createdAfterRetirementId: 'r-1',
        createdAtMs: 150,
        state: 'pending',
        pendingId: 'p-1',
    };
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-2',
    }, [pendingClaim], [record], NOW), 'retired');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 path lookup prefers the longest, latest match', () => {
    const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const contained = (parent, child) =>
        child === parent || child.startsWith(parent + '/');
    const outer = retirement({
        retirementId: 'r-outer',
        canonicalWorktreePath: '/alpha/.worktrees',
    });
    const innerOld = retirement({ retirementId: 'r-old', generationCutoffAt: 100 });
    const innerNew = retirement({ retirementId: 'r-new', generationCutoffAt: 200 });
    const found = findLatestRetirementForPath(
        [outer, innerOld, innerNew],
        '/alpha/.worktrees/fix-login/src/file.ts',
        normalize,
        contained);
    assert.equal(found.retirementId, 'r-new',
        'longest path wins; equal paths prefer the latest cutoff');
    assert.equal(findLatestRetirementForPath(
        [outer], '/elsewhere/x', normalize, contained), null);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 key lookup returns the latest retirement', () => {
    const r1 = retirement({ retirementId: 'r-1', generationCutoffAt: 100 });
    const r2 = retirement({ retirementId: 'r-2', generationCutoffAt: 300 });
    assert.equal(findLatestRetirementForKey([r1, r2], KEY).retirementId, 'r-2');
    assert.equal(findLatestRetirementForKey([r1], {
        repositoryKey: '/beta/.git',
        canonicalWorktreePath: '/beta/.worktrees/fix-login',
    }), null);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 drifted future creation times fail closed', () => {
    const record = retirement({ generationCutoffAt: 100 });
    // Within the tolerated skew: judged by the cutoff as usual.
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-ok', createdAtMs: 101,
    }, [], [record], NOW), 'current');
    // Beyond the skew (here: the maximum legal Date): drifted evidence is
    // no evidence at all.
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-drift', createdAtMs: 8.64e15,
    }, [], [record], NOW), 'retired',
        'a far-future creation time must not prove the current generation');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a claim based on a foreign key cannot prove the generation', () => {
    // The claim matches this record's key, but its basis retirement is a
    // *different* worktree's newer retirement — cutoff comparison alone
    // would wrongly accept it.
    const record = retirement({ generationCutoffAt: 100 });
    const foreignBasis = retirement({
        retirementId: 'r-foreign',
        repositoryKey: '/beta/.git',
        canonicalWorktreePath: '/beta/.worktrees/fix-login',
        generationCutoffAt: 300,
    });
    const mismatchedClaim = claim({ createdAfterRetirementId: 'r-foreign' });
    assert.equal(judgeSessionGeneration(record, {
        provider: 'codex', sessionId: 's-2',
    }, [mismatchedClaim], [record, foreignBasis], NOW), 'retired');
});
