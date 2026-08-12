'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const AiSessionProfileStore = require('../../../out/aiSessions/sessionProfileStore').default;

// SESSION-CODEX-PROFILE-PERSIST-001

function makeStore(nowMs) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-profiles-'));
    const store = new AiSessionProfileStore(directory, nowMs);
    return { store, directory };
}

test('SESSION-CODEX-PROFILE-PERSIST-001 round-trips three-state decisions', () => {
    const { store, directory } = makeStore();
    try {
        assert.deepEqual(store.getAll(), {});
        store.set('codex:s1', { kind: 'base' });
        store.set('codex:s2', { kind: 'profile', name: 'deepseek' });
        assert.deepEqual(store.get('codex:s1'), { kind: 'base' }, 'base decisions are explicit records');
        assert.deepEqual(store.get('codex:s2'), { kind: 'profile', name: 'deepseek' });
        assert.equal(store.get('codex:legacy'), undefined, 'legacy sessions have no record');

        // Reload from disk to prove persistence.
        const reloaded = new AiSessionProfileStore(directory);
        assert.deepEqual(reloaded.getAll(), {
            'codex:s1': { kind: 'base' },
            'codex:s2': { kind: 'profile', name: 'deepseek' },
        });

        reloaded.remove('codex:s1');
        assert.deepEqual(reloaded.getAll(), { 'codex:s2': { kind: 'profile', name: 'deepseek' } });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PERSIST-001 normalizes malformed records on read', () => {
    const { store, directory } = makeStore();
    try {
        fs.writeFileSync(path.join(directory, 'ai-session-profiles.json'), JSON.stringify({
            sessions: {
                'codex:ok': { kind: 'profile', name: 'deepseek' },
                'codex:bad-kind': { kind: 'weird' },
                'codex:bad-name': { kind: 'profile', name: '../escape' },
                'codex:string': 'deepseek',
            },
            pending: {
                good: { decision: { kind: 'base' }, createdAt: Date.now() },
                broken: { decision: null, createdAt: Date.now() },
            },
        }));
        assert.deepEqual(store.getAll(), { 'codex:ok': { kind: 'profile', name: 'deepseek' } });
        assert.deepEqual(store.getPending('good'), { kind: 'base' });
        assert.equal(store.getPending('broken'), undefined);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PERSIST-001 settles pending decisions onto the session key once', () => {
    const { store, directory } = makeStore();
    try {
        store.setPending('p1', { kind: 'profile', name: 'deepseek' });
        assert.deepEqual(store.getPendingAll(), { p1: { kind: 'profile', name: 'deepseek' } });

        assert.deepEqual(store.settlePending('p1', 'codex:s1'), { kind: 'profile', name: 'deepseek' });
        assert.deepEqual(store.get('codex:s1'), { kind: 'profile', name: 'deepseek' });
        assert.deepEqual(store.getPendingAll(), {}, 'the pending record is consumed');

        assert.equal(store.settlePending('p1', 'codex:s1'), null, 'a second settle does not overwrite');
        assert.equal(store.settlePending('unknown', 'codex:s2'), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PERSIST-001 prunes orphaned pending records after the TTL', () => {
    let nowMs = 1_000_000;
    const { store, directory } = makeStore(() => nowMs);
    try {
        store.setPending('old', { kind: 'base' });
        nowMs += 8 * 24 * 60 * 60 * 1000; // 8 days later
        store.setPending('fresh', { kind: 'profile', name: 'glm' });
        assert.deepEqual(store.getPendingAll(), { fresh: { kind: 'profile', name: 'glm' } });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PERSIST-001 writes atomically and survives corrupt files', () => {
    const { store, directory } = makeStore();
    const filePath = path.join(directory, 'ai-session-profiles.json');
    try {
        store.set('codex:s1', { kind: 'base' });
        const leftovers = fs.readdirSync(directory).filter(entry => entry.endsWith('.tmp'));
        assert.deepEqual(leftovers, [], 'no temp files remain after an atomic rename');

        fs.writeFileSync(filePath, '{"sessions":'); // simulate an interrupted write
        assert.deepEqual(store.getAll(), {}, 'a corrupt file reads as empty instead of throwing');
        store.set('codex:s2', { kind: 'profile', name: 'deepseek' });
        assert.deepEqual(store.get('codex:s2'), { kind: 'profile', name: 'deepseek' }, 'writes recover');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PERSIST-001 ignores invalid inputs instead of writing them', () => {
    const { store, directory } = makeStore();
    try {
        store.set('', { kind: 'base' });
        store.set('codex:s1', { kind: 'profile', name: '-bad' });
        store.setPending('', { kind: 'base' });
        assert.deepEqual(store.getAll(), {});
        assert.deepEqual(store.getPendingAll(), {});
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
