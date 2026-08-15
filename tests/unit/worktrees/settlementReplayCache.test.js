'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');

test('WORKTREE-GROUPS-RENAME-001 replays receive the recorded settlement and eviction is bounded', () => {
    const cache = createSettlementReplayCache(2);
    assert.equal(cache.get('r-1'), undefined);
    cache.remember('r-1', { status: 'settled' });
    assert.deepEqual(cache.get('r-1'), { status: 'settled' },
        'a replayed request id re-receives its terminal settlement');
    cache.remember('r-1', { status: 'failed' });
    assert.deepEqual(cache.get('r-1'), { status: 'failed' },
        're-remembering replaces the entry');
    cache.remember('r-2', { status: 'settled' });
    cache.remember('r-3', { status: 'settled' });
    assert.equal(cache.get('r-1'), undefined,
        'the oldest entry is evicted past the bound');
    assert.deepEqual(cache.get('r-3'), { status: 'settled' });
});
