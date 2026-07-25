'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');
const model = require('../../../out/aiSessions/conversation/model');

function makeInteractions(count) {
    return Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        return {
            id: `i-${number}`,
            providerTurnId: `turn-${number}`,
            timestamp: number,
            userMarkdown: `user ${number}`,
            userPreview: `user ${number}`,
            userGraphemeCount: 6,
            assistantMarkdown: [`assistant ${number}`],
            responseState: number === count ? 'inProgress' : 'complete',
        };
    });
}

test('SESSION-AI-SESSION-CONVERSATION-PAGE-001 clamps pages and rejects stale revisions', () => {
    const interactions = makeInteractions(30);
    const request = {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-25',
        direction: 'around',
        limit: 99,
        expectedRevision: 'r1',
    };
    const page = model.buildConversationPage(interactions, request, 'r1');
    assert.equal(new Set(page.messages.map(message => message.interactionId)).size, 20);
    assert.throws(
        () => model.buildConversationPage(interactions, { ...request, expectedRevision: 'r1' }, 'r2'),
        /staleRevision/
    );
});

test('SESSION-AI-SESSION-CONVERSATION-MODEL-002 projects immutable bounded summaries and stopped state', () => {
    const interactions = makeInteractions(CONVERSATION_LIMITS.maxOutlineInteractions + 1);
    const outline = model.buildConversationOutline('kimi', 'session', 'r1', interactions, true);
    assert.equal(outline.totalInteractions, CONVERSATION_LIMITS.maxOutlineInteractions + 1);
    assert.equal(outline.interactions.length, CONVERSATION_LIMITS.maxOutlineInteractions);
    assert.equal(outline.interactions[0].id, 'i-2');
    assert.equal('userMarkdown' in outline.interactions[0], false);
    assert.equal('assistantMarkdown' in outline.interactions[0], false);
    assert.equal(model.applyStoppedLifecycleToResponseState('inProgress', true), 'interrupted');
    assert.equal(model.applyStoppedLifecycleToResponseState('complete', true), 'complete');
});

test('SESSION-AI-SESSION-CONVERSATION-MODEL-003 removes complete interactions until an UTF-8 page fits', () => {
    const interactions = makeInteractions(3).map(interaction => ({
        ...interaction,
        userMarkdown: '😀'.repeat(60000),
        assistantMarkdown: ['😀'.repeat(60000)],
    }));
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-2',
        direction: 'around',
        limit: 3,
    }, 'r1', (id, direction) => `${direction}:${id}`);
    assert.equal(new Set(page.messages.map(message => message.interactionId)).size, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= CONVERSATION_LIMITS.maxPageBytes);
});
