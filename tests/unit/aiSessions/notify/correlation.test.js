'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCorrelationId } = require('../../../../out/aiSessions/notify/correlation');

// ATTENTION-NOTIFY-CORRELATION-001

test('产生 6 位 base32 短码', () => {
    const id = createCorrelationId('claude:018f:completed:abcdef');
    assert.match(id, /^[A-Z2-7]{6}$/u);
});

test('同一 eventId 始终产生同一短码', () => {
    const eventId = 'claude:018f:completed:abcdef';
    assert.equal(createCorrelationId(eventId), createCorrelationId(eventId));
});

test('不同 eventId 产生不同短码', () => {
    assert.notEqual(createCorrelationId('a'), createCorrelationId('b'));
});
