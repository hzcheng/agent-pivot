'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildConversationCommentsPrompt,
    ConversationCommentError,
    createConversationComment,
    updateConversationComment,
} = require('../../../out/aiSessions/conversation/comments');

const message = Object.freeze({
    id: 'message-a',
    interactionId: 'interaction-a',
    role: 'assistant',
    markdown: 'The original response.',
});

test('CONVERSATION-COMMENTS-001 creates bounded host-authoritative drafts', () => {
    const draft = createConversationComment('comment-a', {
        messageId: 'message-a',
        interactionId: 'interaction-a',
        quote: ' original response ',
        prefix: 'The ',
        suffix: '.',
        comment: ' Explain this. ',
    }, message);

    assert.deepEqual(draft, {
        id: 'comment-a',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'original response',
        prefix: 'The ',
        suffix: '.',
        comment: 'Explain this.',
    });
    assert.equal(
        updateConversationComment(draft, '  Add a test.  ').comment,
        'Add a test.'
    );
    assert.throws(
        () => createConversationComment('comment-b', {
            messageId: 'other-message',
            interactionId: 'interaction-a',
            quote: 'text',
            prefix: '',
            suffix: '',
            comment: 'question',
        }, message),
        error => error instanceof ConversationCommentError
            && error.code === 'invalid'
    );
});

test('CONVERSATION-COMMENTS-002 builds one numbered prompt and expands quote fences safely', () => {
    const prompt = buildConversationCommentsPrompt([{
        id: 'comment-a',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Use ``` here',
        prefix: '',
        suffix: '',
        comment: 'Explain it.',
    }, {
        id: 'comment-b',
        messageId: 'message-b',
        interactionId: 'interaction-b',
        role: 'user',
        quote: 'Second quote',
        prefix: '',
        suffix: '',
        comment: 'Implement this.',
    }]);

    assert.match(prompt, /\[批注 1\]/);
    assert.match(prompt, /\[批注 2\]/);
    assert.match(prompt, /````text\nUse ``` here\n````/);
    assert.match(prompt, /请逐项回应/);
});

test('CONVERSATION-COMMENTS-003 rejects empty and oversized batches', () => {
    assert.throws(
        () => buildConversationCommentsPrompt([]),
        error => error instanceof ConversationCommentError
            && error.code === 'invalid'
    );
    assert.throws(
        () => buildConversationCommentsPrompt([{
            id: 'comment-a',
            messageId: 'message-a',
            interactionId: 'interaction-a',
            role: 'assistant',
            quote: 'q',
            prefix: '',
            suffix: '',
            comment: 'x'.repeat(4_001),
        }]),
        error => error instanceof ConversationCommentError
            && error.code === 'invalid'
    );
});
