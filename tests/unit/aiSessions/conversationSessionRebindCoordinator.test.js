'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ConversationSessionRebindCoordinator,
    hasCommittedConversationSessionRuntimeRebind,
} = require('../../../out/aiSessions/conversation/sessionRebindCoordinator');

function target(sessionId, overrides = {}) {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        ...overrides,
    };
}

test('CONVERSATION-SESSION-REBIND-001 durably retries partial metadata migration and resolves only the explicit target chain', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-session-rebind-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const firstCalls = [];
    const first = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: {
            async copyForRebind(previous, next) {
                firstCalls.push(['comments', previous, next]);
                throw new Error('transient comment failure');
            },
        },
        bookmarkStore: {
            async copyForRebind(previous, next) {
                firstCalls.push(['bookmarks', previous, next]);
                return 'copied';
            },
        },
        now: () => Date.parse('2026-08-06T10:00:00.000Z'),
    });

    await assert.rejects(
        first.rebind(target('old-root'), target('new-root')),
        /comments/
    );
    assert.equal(first.resolve(target('old-root')).sessionId, 'new-root');
    assert.equal(
        first.resolve(target('old-root', { provider: 'claude' })).sessionId,
        'old-root'
    );
    assert.deepEqual(firstCalls.map(call => call[0]), ['comments', 'bookmarks']);

    const retryCalls = [];
    const restarted = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: {
            async copyForRebind(previous, next) {
                retryCalls.push(['comments', previous, next]);
                return 'copied';
            },
        },
        bookmarkStore: {
            async copyForRebind(previous, next) {
                retryCalls.push(['bookmarks', previous, next]);
                return 'copied';
            },
        },
        now: () => Date.parse('2026-08-06T10:01:00.000Z'),
    });
    await restarted.restore();

    assert.deepEqual(retryCalls.map(call => call[0]), ['comments']);
    assert.equal(restarted.resolve(target('old-root')).sessionId, 'new-root');
    await restarted.rebind(target('new-root'), target('newer-root'));
    assert.equal(restarted.resolve(target('old-root')).sessionId, 'newer-root');
    assert.equal(restarted.resolve(target('unrelated')).sessionId, 'unrelated');

    await restarted.prepare(target('pending-old'), target('pending-new'));
    const uncommittedCalls = [];
    const uncommitted = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: {
            async copyForRebind() {
                uncommittedCalls.push('comments');
                return 'copied';
            },
        },
        bookmarkStore: {
            async copyForRebind() {
                uncommittedCalls.push('bookmarks');
                return 'copied';
            },
        },
        isRuntimeRebindCommitted: async () => false,
    });
    await uncommitted.restore();
    assert.equal(
        uncommitted.resolve(target('pending-old')).sessionId,
        'pending-old'
    );
    assert.deepEqual(uncommittedCalls, []);

    assert.equal(hasCommittedConversationSessionRuntimeRebind(
        [target('pending-old'), target('pending-new')],
        target('pending-old'),
        target('pending-new')
    ), false, 'an existing destination does not prove a runtime rebind');
    assert.equal(hasCommittedConversationSessionRuntimeRebind(
        [target('pending-new')],
        target('pending-old'),
        target('pending-new')
    ), true, 'a committed runtime rebind removes old before exposing new');

    const destinationCollision = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: { async copyForRebind() { return 'copied'; } },
        bookmarkStore: { async copyForRebind() { return 'copied'; } },
        isRuntimeRebindCommitted: async (previous, next) =>
            hasCommittedConversationSessionRuntimeRebind(
                [target('pending-old'), target('pending-new')],
                previous,
                next
            ),
    });
    await destinationCollision.restore();
    assert.equal(
        destinationCollision.resolve(target('pending-old')).sessionId,
        'pending-old',
        'restart must not promote a stale destination collision'
    );

    const crashRecoveryCalls = [];
    const crashRecovery = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: {
            async copyForRebind() {
                crashRecoveryCalls.push('comments');
                return 'copied';
            },
        },
        bookmarkStore: {
            async copyForRebind() {
                crashRecoveryCalls.push('bookmarks');
                return 'copied';
            },
        },
        isRuntimeRebindCommitted: async (previous, next) =>
            previous.sessionId === 'pending-old'
                && next.sessionId === 'pending-new',
    });
    await crashRecovery.restore();
    assert.equal(
        crashRecovery.resolve(target('pending-old')).sessionId,
        'pending-new'
    );
    assert.deepEqual(crashRecoveryCalls, ['comments', 'bookmarks']);
});

test('CONVERSATION-SESSION-REBIND-001 retries a failed intent write in the same process', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-session-rebind-write-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const coordinator = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: { async copyForRebind() { return 'source-empty'; } },
        bookmarkStore: { async copyForRebind() { return 'source-empty'; } },
    });
    const writeRecord = coordinator.writeRecord.bind(coordinator);
    let writes = 0;
    coordinator.writeRecord = async record => {
        writes += 1;
        if (writes === 1) {
            throw new Error('transient intent write failure');
        }
        await writeRecord(record);
    };

    await assert.rejects(
        coordinator.prepare(target('write-old'), target('write-new')),
        /transient intent write failure/
    );
    await coordinator.prepare(target('write-old'), target('write-new'));
    assert.equal(writes, 2, 'retry must durably write the pre-commit intent');

    const restarted = new ConversationSessionRebindCoordinator({
        globalStoragePath: root,
        commentStore: { async copyForRebind() { return 'source-empty'; } },
        bookmarkStore: { async copyForRebind() { return 'source-empty'; } },
        isRuntimeRebindCommitted: async () => false,
    });
    await restarted.restore();
    assert.equal(
        restarted.resolve(target('write-old')).sessionId,
        'write-old'
    );
});
