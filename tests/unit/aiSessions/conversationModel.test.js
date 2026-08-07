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
    const outline = model.buildConversationOutline('kimi', 'session', 'r1', interactions, false);
    assert.equal(outline.totalInteractions, CONVERSATION_LIMITS.maxOutlineInteractions + 1);
    assert.equal(outline.interactions.length, CONVERSATION_LIMITS.maxOutlineInteractions);
    assert.equal(outline.interactions[0].id, 'i-2');
    assert.equal(outline.partial, true);
    assert.equal('userMarkdown' in outline.interactions[0], false);
    assert.equal('assistantMarkdown' in outline.interactions[0], false);
    assert.equal(model.applyStoppedLifecycleToResponseState('inProgress', true), 'interrupted');
    assert.equal(model.applyStoppedLifecycleToResponseState('complete', true), 'complete');
    assert.equal(
        model.applyActiveLifecycleToResponseState('interrupted', true, true),
        'inProgress'
    );
    assert.equal(
        model.applyActiveLifecycleToResponseState('interrupted', true, false),
        'interrupted'
    );
    assert.equal(
        model.applyActiveLifecycleToResponseState('complete', true, true),
        'inProgress'
    );
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

test('SESSION-AI-SESSION-CONVERSATION-MODEL-004 bounds serialization work while shrinking a large page', () => {
    const interactions = makeInteractions(20).map(interaction => ({
        ...interaction,
        userMarkdown: 'u'.repeat(60 * 1024),
        assistantMarkdown: ['a'.repeat(60 * 1024)],
    }));
    const sourceCharacters = interactions.length * 120 * 1024;
    const originalStringify = JSON.stringify;
    let serializedCharacters = 0;
    JSON.stringify = function measuredStringify(...args) {
        const result = originalStringify(...args);
        serializedCharacters += result?.length || 0;
        return result;
    };
    let page;
    try {
        page = model.buildConversationPage(interactions, {
            provider: 'codex',
            sessionId: 'session',
            anchorInteractionId: 'i-20',
            direction: 'around',
            limit: 20,
        }, 'r1');
    } finally {
        JSON.stringify = originalStringify;
    }
    assert.ok(
        serializedCharacters <= sourceCharacters * 3,
        `serialized ${serializedCharacters} characters for ${sourceCharacters} source characters`
    );
    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 CONVERSATION-PROGRESS-VISIBILITY-001 interleaves tool calls with progress and final assistant text by position', () => {
    const interactions = [{
        id: 'i-1',
        providerTurnId: 'turn-1',
        timestamp: 1,
        userMarkdown: 'Run the tests',
        userPreview: 'Run the tests',
        userGraphemeCount: 13,
        assistantMarkdown: ['first chunk', 'second chunk'],
        assistantPhases: ['progress', 'answer'],
        toolCalls: [
            { position: 0, name: 'Shell', summary: 'Shell npm test' },
            { position: 1, name: 'ReadFile', summary: 'ReadFile a.ts', detail: 'file body' },
            { position: 2, name: 'Write', summary: 'Write b.ts' },
        ],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(
        page.messages.map(message => [message.role, message.id]),
        [
            ['user', 'i-1:user'],
            ['tool', 'i-1:tool:0'],
            ['progress', 'i-1:progress:0'],
            ['tool', 'i-1:tool:1'],
            ['assistant', 'i-1:assistant:1'],
            ['tool', 'i-1:tool:2'],
        ]
    );
    assert.deepEqual(page.messages[3].tool, {
        name: 'ReadFile',
        summary: 'ReadFile a.ts',
        detail: 'file body',
    });
    assert.equal(page.messages[1].markdown, '');
});

test('CONVERSATION-THINKING-VISIBILITY-001 interleaves thinking blocks with tool calls and assistant text by position', () => {
    const interactions = [{
        id: 'i-1',
        providerTurnId: 'turn-1',
        timestamp: 1,
        userMarkdown: 'Fix the bug',
        userPreview: 'Fix the bug',
        userGraphemeCount: 11,
        assistantMarkdown: ['first chunk', 'second chunk'],
        toolCalls: [
            { position: 1, name: 'Shell', summary: 'Shell npm test' },
        ],
        thinking: [
            { position: 0, text: 'Let me think.' },
            { position: 2, text: 'One more check.' },
        ],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'claude',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(
        page.messages.map(message => [message.role, message.id]),
        [
            ['user', 'i-1:user'],
            ['thinking', 'i-1:thinking:0'],
            ['progress', 'i-1:progress:0'],
            ['tool', 'i-1:tool:0'],
            ['assistant', 'i-1:assistant:1'],
            ['thinking', 'i-1:thinking:1'],
        ]
    );
    assert.deepEqual(page.messages[1].thinking, { text: 'Let me think.' });
    assert.equal(page.messages[1].markdown, '');
});
