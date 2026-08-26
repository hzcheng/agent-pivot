'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationHistoryIndex,
    conversationHistorySourceEpoch,
} = require('../../../out/aiSessions/conversation/historyIndex');

function epoch(value) {
    return { value };
}

function checkpoint(startOffset, endOffset, state = { open: false }, estimatedBytes = 1) {
    return { startOffset, endOffset, state, estimatedBytes };
}

test('CONVERSATION-HISTORY-INDEX-001 keeps a completed prefix across append epochs', () => {
    const index = new ConversationHistoryIndex(16);
    const sourceEpoch = epoch('inode:/history:1');
    const first = index.begin(sourceEpoch);
    assert.equal(index.commit(first, checkpoint(0, 4)), true);

    // A normal append uses the same stable source epoch and resumes exactly
    // at the committed reducer frontier.
    const appended = index.begin(sourceEpoch, true);
    assert.equal(appended.startOffset, 4);
    assert.equal(index.commit(appended, checkpoint(4, 9)), true);
    assert.deepEqual(index.coverage(), {
        epoch: sourceEpoch,
        nextOffset: 9,
        checkpointCount: 2,
        estimatedBytes: 2,
    });
});

test('CONVERSATION-HISTORY-INDEX-002 replaces reducer state when the file epoch changes', () => {
    const index = new ConversationHistoryIndex(16);
    const first = index.begin(epoch('inode:/history:1'));
    assert.equal(index.commit(first, checkpoint(0, 4)), true);

    const replacementEpoch = epoch('inode:/history:2');
    const replacement = index.begin(replacementEpoch);
    assert.equal(replacement.startOffset, 0);
    assert.deepEqual(index.coverage(), {
        epoch: replacementEpoch,
        nextOffset: 0,
        checkpointCount: 0,
        estimatedBytes: 0,
    });
});

test('CONVERSATION-HISTORY-INDEX-006 requires verified append continuity before reusing an inode epoch', () => {
    const index = new ConversationHistoryIndex(16);
    const sourceEpoch = epoch('inode:/history:1');
    const first = index.begin(sourceEpoch);
    assert.equal(index.commit(first, checkpoint(0, 4)), true);

    // A truncate or in-place rewrite can preserve inode/birthtime.  Without
    // a successful edge-hash continuation check it must cold-rebuild.
    const rewritten = index.begin(sourceEpoch, false);
    assert.equal(rewritten.startOffset, 0);
    assert.equal(index.coverage().checkpointCount, 0);
});

test('CONVERSATION-HISTORY-INDEX-003 rejects late scans after supersession or invalidation', () => {
    const index = new ConversationHistoryIndex(16);
    const sourceEpoch = epoch('inode:/history:1');
    const stale = index.begin(sourceEpoch);
    const current = index.begin(sourceEpoch, true);
    assert.equal(index.commit(stale, checkpoint(0, 4)), false);
    assert.equal(index.commit(current, checkpoint(0, 4)), true);

    const invalidated = index.begin(sourceEpoch, true);
    index.invalidate();
    assert.equal(index.commit(invalidated, checkpoint(4, 8)), false);
    assert.equal(index.coverage().epoch, undefined);
});

test('CONVERSATION-HISTORY-INDEX-004 enforces the byte budget even for active indexes', () => {
    const index = new ConversationHistoryIndex(3);
    const first = index.begin(epoch('inode:/history:1'));
    assert.equal(index.commit(first, checkpoint(0, 4, {}, 2)), true);
    const next = index.begin(epoch('inode:/history:1'), true);
    assert.equal(index.commit(next, checkpoint(4, 8, {}, 2)), false);
    assert.equal(index.coverage().nextOffset, 4);
    assert.equal(index.coverage().estimatedBytes, 2);
});

test('CONVERSATION-HISTORY-INDEX-005 derives an append-stable source epoch', () => {
    const initial = conversationHistorySourceEpoch({
        canonicalPath: '/provider/history.jsonl',
        device: 1,
        inode: 2,
        birthtimeMs: 3,
    });
    const appended = conversationHistorySourceEpoch({
        canonicalPath: '/provider/history.jsonl',
        device: 1,
        inode: 2,
        birthtimeMs: 3,
    });
    const replaced = conversationHistorySourceEpoch({
        canonicalPath: '/provider/history.jsonl',
        device: 1,
        inode: 4,
        birthtimeMs: 3,
    });
    assert.deepEqual(initial, appended);
    assert.notDeepEqual(initial, replaced);
});
