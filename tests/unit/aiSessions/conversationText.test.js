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

test('SESSION-AI-SESSION-CONVERSATION-TEXT-002 does not materialize every grapheme while enforcing limits', () => {
    const value = '😀'.repeat(128 * 1024);
    const originalFrom = Array.from;
    const segmenterPrototype = Intl.Segmenter?.prototype;
    const originalSegment = segmenterPrototype?.segment;
    let arrayFromCalls = 0;
    let segmentCalls = 0;
    Array.from = function measuredFrom(...args) {
        arrayFromCalls += 1;
        return originalFrom(...args);
    };
    if (segmenterPrototype && originalSegment) {
        segmenterPrototype.segment = function measuredSegment(...args) {
            segmentCalls += 1;
            return originalSegment.apply(this, args);
        };
    }
    try {
        assert.equal(text.countGraphemes(value), 128 * 1024);
        assert.equal(
            text.truncateGraphemes(value, 160),
            `${'😀'.repeat(160)}…`
        );
        const ordinary = `${'普通文本'.repeat(64 * 1024)}${'x'.repeat(64 * 1024)}`;
        assert.equal(text.hasAtMostGraphemes(ordinary, 160), false);
        assert.equal(text.truncateGraphemes(ordinary, 3), '普通文…');
    } finally {
        Array.from = originalFrom;
        if (segmenterPrototype && originalSegment) {
            segmenterPrototype.segment = originalSegment;
        }
    }
    assert.equal(arrayFromCalls, 0);
    assert.equal(segmentCalls, 0);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 formats worked durations in compact English', () => {
    assert.equal(text.formatWorkedDuration(1_000), '1s');
    assert.equal(text.formatWorkedDuration(45_000), '45s');
    assert.equal(text.formatWorkedDuration(59_999), '59s');
    assert.equal(text.formatWorkedDuration(60_000), '1m 00s');
    assert.equal(text.formatWorkedDuration(80_000), '1m 20s');
    assert.equal(text.formatWorkedDuration(125_000), '2m 05s');
    assert.equal(text.formatWorkedDuration(3_600_000), '1h 00m');
    assert.equal(text.formatWorkedDuration(3_780_000), '1h 03m');
    assert.equal(text.formatWorkedDuration(7_320_000), '2h 02m');
});
