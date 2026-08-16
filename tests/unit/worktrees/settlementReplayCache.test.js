'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');

test('WORKTREE-GROUPS-RENAME-001 replays receive the recorded settlement and eviction is bounded', () => {
    const cache = createSettlementReplayCache(2);
    assert.equal(cache.get('r-1'), undefined);
    cache.remember('r-1', Promise.resolve({ status: 'settled' }));
    return cache.get('r-1').then(value => {
        assert.deepEqual(value, { status: 'settled' },
            'a replayed request id re-receives its terminal settlement');
        cache.remember('r-2', Promise.resolve({ status: 'settled' }));
        cache.remember('r-3', Promise.resolve({ status: 'settled' }));
        assert.equal(cache.get('r-1'), undefined,
            'the oldest entry is evicted past the bound');
        assert.equal(cache.isExpired('r-1'), true,
            'an evicted id becomes a tombstone: replays fail closed');
        assert.equal(cache.isExpired('r-3'), false);
        return cache.get('r-3');
    }).then(value => {
        assert.deepEqual(value, { status: 'settled' });
    });
});
