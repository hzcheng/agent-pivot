'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    worktreeKeysEqual,
    worktreeKeysMatch,
    worktreeKeyToString,
    worktreeKeyTombstoneKey,
} = require('../../../out/worktrees/types');

const alpha = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix' };
const alphaAgain = { ...alpha };
const beta = { repositoryKey: '/beta/.git', canonicalWorktreePath: '/beta/.worktrees/fix' };

test('ARCH-WORKTREE-IDENTITY-CODEC-001 canonical equality and the optional-field match', () => {
    assert.ok(worktreeKeysEqual(alpha, alphaAgain));
    assert.ok(!worktreeKeysEqual(alpha, beta));

    // Optional-field rule: both undefined matches; exactly one is a mismatch.
    assert.ok(worktreeKeysMatch(undefined, undefined));
    assert.ok(!worktreeKeysMatch(alpha, undefined));
    assert.ok(!worktreeKeysMatch(undefined, alpha));
    assert.ok(worktreeKeysMatch(alpha, alphaAgain));
    assert.ok(!worktreeKeysMatch(alpha, beta));
});

test('ARCH-WORKTREE-IDENTITY-CODEC-001 the string encodings are byte-stable contracts', () => {
    assert.equal(worktreeKeyToString(alpha), '/alpha/.git::/alpha/.worktrees/fix');
    // Persisted tombstone contract: space-joined, byte-stable; the synthetic
    // tombstone sha1 input and the pruning sets both consume this form.
    assert.equal(worktreeKeyTombstoneKey('/alpha/.git', '/alpha/.worktrees/fix'),
        '/alpha/.git /alpha/.worktrees/fix');
});
