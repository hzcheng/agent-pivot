'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WorktreeBaseRefStore } = require('../../../out/worktrees/baseRefStore');

function memento(initial) {
    const values = new Map(Object.entries(initial || {}));
    const updates = [];
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        async update(key, value) {
            updates.push({ key, value: JSON.parse(JSON.stringify(value)) });
            values.set(key, value);
        },
        updates,
    };
}

test('WORKTREE-DISCOVERY-001 remembers the initial base ref once and accepts an explicit update', async () => {
    const state = memento();
    const store = new WorktreeBaseRefStore(state);
    await store.rememberInitial('/repo/.git', 'refs/heads/main');
    await store.rememberInitial('/repo/.git', 'refs/heads/temporary');
    assert.equal(store.get('/repo/.git'), 'refs/heads/main');
    assert.equal(state.updates.length, 1);

    await store.set('/repo/.git', 'refs/heads/release');
    assert.equal(store.get('/repo/.git'), 'refs/heads/release');
    await store.delete('/repo/.git');
    assert.equal(store.get('/repo/.git'), undefined);
});

test('WORKTREE-DISCOVERY-001 ignores corrupt persisted entries and rejects unsafe writes', async () => {
    const state = memento({
        'agentPivot.worktreeBaseRefs.v1': {
            '/valid/.git': 'refs/heads/main',
            '/bad-ref/.git': '-option',
            'bad\nrepo': 'refs/heads/main',
            '/bad-value/.git': 42,
        },
    });
    const store = new WorktreeBaseRefStore(state);
    assert.equal(store.get('/valid/.git'), 'refs/heads/main');
    assert.equal(store.get('/bad-ref/.git'), undefined);
    await assert.rejects(store.set('/repo/.git', '-option'), /invalid/);
    await assert.rejects(store.set('bad\nrepo', 'refs/heads/main'), /invalid/);
});

test('WORKTREE-DISCOVERY-001 serializes concurrent initial-base writes without losing repositories', async () => {
    const state = memento();
    const store = new WorktreeBaseRefStore(state);
    await Promise.all([
        store.rememberInitial('/one/.git', 'refs/heads/main'),
        store.rememberInitial('/two/.git', 'refs/heads/trunk'),
    ]);
    assert.equal(store.get('/one/.git'), 'refs/heads/main');
    assert.equal(store.get('/two/.git'), 'refs/heads/trunk');
});
