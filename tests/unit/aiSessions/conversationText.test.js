'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const text = require('../../../out/aiSessions/conversation/text');
const types = require('../../../out/aiSessions/conversation/types');

test('SESSION-AI-SESSION-CONVERSATION-TEXT-001 counts and truncates visible input without splitting graphemes', () => {
    assert.equal(text.countGraphemes('A👨‍👩‍👧‍👦e\u0301中'), 4);
    assert.equal(text.truncateGraphemes('A👨‍👩‍👧‍👦e\u0301中', 3), 'A👨‍👩‍👧‍👦e\u0301…');
    assert.equal(text.normalizeVisibleText('  hello\r\n\tworld  '), 'hello\nworld');
    assert.equal(text.normalizeVisibleText('safe\u0000\u0007 text\ufffe'), 'safe text');
    assert.equal(text.attachmentLabel(1), '[Attachment]');
    assert.equal(text.attachmentLabel(3), '[3 Attachments]');
    assert.equal(text.buildVisibleUserInput([
        { kind: 'text', text: 'Review' },
        { kind: 'attachment' },
        { kind: 'attachment' },
        { kind: 'text', text: 'then explain' },
    ]), 'Review [2 Attachments] then explain');
    assert.equal(types.CONVERSATION_LIMITS.previewGraphemes, 160);
    assert.equal(types.CONVERSATION_LIMITS.maxPageInteractions, 20);
    assert.equal(types.CONVERSATION_LIMITS.maxOutlineInteractions, 2000);
    assert.equal(types.CONVERSATION_LIMITS.autoScrollThresholdPx, 8);
    assert.equal(types.CONVERSATION_LIMITS.minRequestId, 1);
    assert.equal(types.CONVERSATION_LIMITS.inactiveIndexLimitPerProvider, 8);
    let cancelled = 0;
    const controller = new types.ConversationAbortController();
    controller.signal.onAbort(() => { cancelled += 1; });
    controller.abort();
    controller.abort();
    assert.equal(cancelled, 1);
});
