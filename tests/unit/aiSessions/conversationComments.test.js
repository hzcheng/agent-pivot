'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildConversationCommentsPrompt,
    clearConversationComments,
    ConversationCommentError,
    createConversationComment,
    createConversationSessionComment,
    markConversationCommentsSent,
    reopenConversationComment,
    resolveConversationComment,
    updateConversationComment,
} = require('../../../out/aiSessions/conversation/comments');

const message = Object.freeze({
    id: 'message-a',
    interactionId: 'interaction-a',
    role: 'assistant',
    markdown: 'The original response.',
});

test('CONVERSATION-COMMENTS-001 CONVERSATION-COMMENTS-REVIEW-001 creates bounded host-authoritative drafts and review states', () => {
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
        status: 'open',
    });
    assert.equal(
        updateConversationComment(draft, '  Add a test.  ').comment,
        'Add a test.'
    );
    assert.equal(resolveConversationComment(draft).status, 'resolved');
    assert.equal(
        reopenConversationComment(resolveConversationComment(draft)).status,
        'open'
    );
    assert.deepEqual(
        markConversationCommentsSent([
            draft,
            resolveConversationComment(draft),
        ]).map(comment => comment.status),
        ['sent', 'resolved']
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

test('CONVERSATION-COMMENTS-001 creates a session-wide note without a selected message', () => {
    const draft = createConversationSessionComment(
        'comment-session',
        ' Remember this decision. '
    );
    assert.deepEqual(draft, {
        id: 'comment-session',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Remember this decision.',
        status: 'open',
    });

    const prompt = buildConversationCommentsPrompt([draft]);
    assert.match(prompt, /\[批注 1\]/);
    assert.match(prompt, /范围：当前 Session/);
    assert.match(prompt, /Remember this decision\./);
    assert.doesNotMatch(prompt, /选中原文|对话角色/);
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
        status: 'open',
    }, {
        id: 'comment-b',
        messageId: 'message-b',
        interactionId: 'interaction-b',
        role: 'user',
        quote: 'Second quote',
        prefix: '',
        suffix: '',
        comment: 'Implement this.',
        status: 'open',
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
            status: 'open',
        }]),
        error => error instanceof ConversationCommentError
            && error.code === 'invalid'
    );
});

test('CONVERSATION-COMMENTS-BULK-001 clears sent, resolved, or all comments without mutating the input', () => {
    const comments = [{
        id: 'comment-open',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Open quote',
        prefix: '',
        suffix: '',
        comment: 'Open question.',
        status: 'open',
    }, {
        id: 'comment-sent',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Sent quote',
        prefix: '',
        suffix: '',
        comment: 'Sent question.',
        status: 'sent',
    }, {
        id: 'comment-resolved',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Resolved quote',
        prefix: '',
        suffix: '',
        comment: 'Resolved question.',
        status: 'resolved',
    }];

    assert.deepEqual(
        clearConversationComments(comments, 'clearSent').map(
            comment => comment.id
        ),
        ['comment-open', 'comment-resolved']
    );
    assert.deepEqual(
        clearConversationComments(comments, 'clearResolved').map(
            comment => comment.id
        ),
        ['comment-open', 'comment-sent']
    );
    assert.deepEqual(clearConversationComments(comments, 'clearAll'), []);
    assert.deepEqual(
        comments.map(comment => comment.id),
        ['comment-open', 'comment-sent', 'comment-resolved']
    );
});
