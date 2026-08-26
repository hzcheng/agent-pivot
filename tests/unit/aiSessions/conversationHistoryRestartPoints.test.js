'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');
const {
    appendConversationHistoryRestartPoint,
} = require('../../../out/aiSessions/conversation/historyRestartPoints');

test('CONVERSATION-HISTORY-RESTART-POINT-002 bounds the in-memory restart discovery window', () => {
    const points = [];
    for (let index = 0;
        index < CONVERSATION_LIMITS.maxOutlineInteractions + 2;
        index++) {
        appendConversationHistoryRestartPoint(points, {
            offset: index,
            interactionId: `interaction-${index}`,
        });
    }
    assert.equal(points.length, CONVERSATION_LIMITS.maxOutlineInteractions);
    assert.deepEqual(points[0], {
        offset: 2,
        interactionId: 'interaction-2',
    });
    appendConversationHistoryRestartPoint(points, { offset: 2_001, interactionId: 'duplicate-offset' });
    assert.equal(points.at(-1).interactionId, `interaction-${CONVERSATION_LIMITS.maxOutlineInteractions + 1}`);
});
