'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const AiSessionProfileController = require('../../../out/aiSessions/sessionProfileController').default;

// SESSION-CODEX-PROFILE-PERSIST-001

function makeController(overrides = {}) {
    const data = { sessions: {}, pending: {} };
    const mementoData = {};
    const errors = [];
    const saveErrors = [];
    const store = {
        getAll: () => ({ ...data.sessions }),
        get: key => data.sessions[key],
        set: (key, decision) => { data.sessions[key] = decision; },
        remove: key => { delete data.sessions[key]; },
        getPending: pendingId => data.pending[pendingId]?.decision,
        getPendingAll: () => Object.fromEntries(
            Object.entries(data.pending).map(([key, value]) => [key, value.decision])
        ),
        setPending: (pendingId, decision) => { data.pending[pendingId] = { decision, createdAt: 1 }; },
        settlePending: (pendingId, sessionKey) => {
            const entry = data.pending[pendingId];
            if (!entry) {
                return null;
            }
            delete data.pending[pendingId];
            data.sessions[sessionKey] = entry.decision;
            return entry.decision;
        },
        ...overrides.store,
    };
    const controller = new AiSessionProfileController({
        store,
        isProviderId: value => value === 'codex' || value === 'kimi',
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        logError: (message, error) => errors.push([message, error]),
        showSaveError: () => saveErrors.push('shown'),
        lastUsedMemento: {
            get: key => mementoData[key],
            update: (key, value) => { mementoData[key] = value; },
        },
        isProfileAvailable: overrides.isProfileAvailable,
        nowMs: overrides.nowMs,
    });
    return { controller, data, mementoData, errors, saveErrors };
}

test('SESSION-CODEX-PROFILE-PERSIST-001 records, settles and reads profile decisions', () => {
    const { controller, data } = makeController();
    controller.recordPending('p1', { kind: 'profile', name: 'deepseek' });
    controller.recordPending('p2', { kind: 'base' });
    assert.deepEqual(controller.getPendingAll(), {
        p1: { kind: 'profile', name: 'deepseek' },
        p2: { kind: 'base' },
    });

    controller.settlePending('codex', 'p1', 's1');
    assert.deepEqual(controller.getDecision('codex', 's1'), { kind: 'profile', name: 'deepseek' });
    assert.deepEqual(controller.getDecision('codex', 'unknown'), undefined);
    assert.deepEqual(Object.keys(data.pending), ['p2']);

    controller.settlePending('kimi', 'p2', 's9');
    assert.deepEqual(controller.getDecision('kimi', 's9'), { kind: 'base' });
});

test('SESSION-CODEX-PROFILE-PERSIST-001 copies decisions on runtime rebind without overwriting', () => {
    const { controller } = makeController();
    controller.recordPending('p1', { kind: 'profile', name: 'deepseek' });
    controller.settlePending('codex', 'p1', 'old-session');
    controller.copyForRebind('codex', 'old-session', 'new-session');
    assert.deepEqual(controller.getDecision('codex', 'new-session'), { kind: 'profile', name: 'deepseek' });

    controller.copyForRebind('codex', 'old-session', 'occupied');
    controller.copyForRebind('codex', '', 'new-session');
    assert.deepEqual(controller.getDecision('codex', 'new-session'), { kind: 'profile', name: 'deepseek' });
});

test('SESSION-CODEX-PROFILE-PERSIST-001 remembers the last used decision only through the memento', () => {
    const { controller, mementoData } = makeController();
    assert.equal(controller.getLastUsed(), null);
    controller.rememberLastUsed({ kind: 'profile', name: 'deepseek' });
    assert.deepEqual(controller.getLastUsed(), { kind: 'profile', name: 'deepseek' });
    controller.rememberLastUsed({ kind: 'base' });
    assert.deepEqual(controller.getLastUsed(), { kind: 'base' });

    mementoData['codexLastProfile.v1'] = { kind: 'profile', name: '' };
    assert.equal(controller.getLastUsed(), null, 'malformed memento values normalize to null');
});

test('SESSION-CODEX-PROFILE-PERSIST-001 reports availability with a short-lived cache', () => {
    let nowMs = 0;
    const statCalls = [];
    const { controller } = makeController({
        isProfileAvailable: name => {
            statCalls.push(name);
            return name !== 'deleted';
        },
        nowMs: () => nowMs,
    });
    controller.recordPending('p1', { kind: 'profile', name: 'deepseek' });
    controller.settlePending('codex', 'p1', 's1');
    controller.recordPending('p2', { kind: 'profile', name: 'deleted' });

    assert.deepEqual(controller.getAvailability(), { deepseek: true, deleted: false });
    controller.getAvailability();
    assert.deepEqual(statCalls.sort(), ['deepseek', 'deleted'], 'results are cached within the TTL');

    nowMs += 11 * 1000;
    controller.getAvailability();
    assert.equal(statCalls.length, 4, 'the cache expires after the TTL');
});

test('SESSION-CODEX-PROFILE-PERSIST-001 surfaces persistence failures to the user', () => {
    const { controller, saveErrors, errors } = makeController({
        store: {
            setPending: () => { throw new Error('disk full'); },
        },
    });
    controller.recordPending('p1', { kind: 'base' });
    assert.equal(saveErrors.length, 1, 'a failed decision save must notify the user');
    assert.equal(errors.length, 1);
});
