'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemberSessionFreeze } = require('../../../out/worktrees/memberSessionFreeze');

test('member session freeze prefers the canonical worktree key path and freezes contained sessions', async () => {
    const freeze = createMemberSessionFreeze({
        getResults: () => ({
            codex: {
                available: true,
                sessions: [
                    { id: 'in', cwd: '/repo/wt/src' },
                    { id: 'out', cwd: '/elsewhere' },
                    { id: 'nocwd', cwd: '' },
                ],
            },
            kimi: { available: false, sessions: [{ id: 'skipped', cwd: '/repo/wt' }] },
        }),
    });
    const frozen = await freeze({
        worktreeKey: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/wt' },
        path: '/ignored',
    });
    assert.deepEqual(frozen, [{ provider: 'codex', sessionId: 'in' }]);
});

test('member session freeze falls back to the member path and blanks missing paths', async () => {
    const seen = [];
    const freeze = createMemberSessionFreeze({
        getResults: input => {
            seen.push(input);
            return {};
        },
    });
    assert.deepEqual(await freeze({ path: '/repo/wt/' }), []);
    assert.equal(seen[0].candidatePaths[0], '/repo/wt/');
    assert.equal(seen[0].reason, 'worktree-deletion-snapshot');
    assert.deepEqual(await freeze({ path: '' }), []);
});
