'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createAttentionEventId } = require('../../../../out/aiSessions/notify/eventIdentity');

// ATTENTION-NOTIFY-EVENT-IDENTITY-001

test('event id 由 eventKey、reason 与 token 的 sha256 拼成', () => {
    const token = 'claude:end_turn:1753948800000:uuid-1';
    const expected = `claude:018f:completed:${crypto.createHash('sha256').update(token).digest('hex')}`;
    assert.equal(createAttentionEventId('claude:018f', 'completed', token), expected);
});

test('token 不同则 event id 不同', () => {
    const left = createAttentionEventId('claude:018f', 'completed', 'a');
    const right = createAttentionEventId('claude:018f', 'completed', 'b');
    assert.notEqual(left, right);
});

test('相同输入始终产生相同 event id', () => {
    const first = createAttentionEventId('codex:7', 'input-required', 'codex:request_user_input:1:call-9');
    const second = createAttentionEventId('codex:7', 'input-required', 'codex:request_user_input:1:call-9');
    assert.equal(first, second);
});
