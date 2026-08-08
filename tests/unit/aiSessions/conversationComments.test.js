'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    addConversationCommentTag,
    buildConversationCommentsPrompt,
    clearConversationComments,
    ConversationCommentError,
    createConversationComment,
    createConversationSessionComment,
    markConversationCommentsDone,
    removeConversationCommentTag,
    reorderConversationComments,
    updateConversationComment,
    validateConversationComments,
} = require('../../../out/aiSessions/conversation/comments');

const message = Object.freeze({
    id: 'message-a',
    interactionId: 'interaction-a',
    role: 'assistant',
    markdown: 'The original response.',
});

test('CONVERSATION-COMMENTS-001 adds and removes bounded tags on comment drafts', () => {
    const draft = createConversationSessionComment(
        'comment-tags',
        'Remember this.'
    );
    assert.equal(draft.tags, undefined);

    const tagged = addConversationCommentTag(draft, ' Convention ');
    assert.deepEqual(tagged.tags, ['Convention']);
    assert.equal(draft.tags, undefined);

    const duplicate = addConversationCommentTag(tagged, 'convention');
    assert.deepEqual(duplicate.tags, ['Convention']);

    validateConversationComments([tagged]);
    assert.throws(
        () => validateConversationComments([
            { ...tagged, tags: ['a', 'A'] },
        ]),
        /invalid/
    );
    assert.throws(
        () => validateConversationComments([
            { ...tagged, tags: ['ok', '  '] },
        ]),
        /invalid/
    );

    let full = tagged;
    ['b', 'c', 'd', 'e'].forEach(tag => {
        full = addConversationCommentTag(full, tag);
    });
    assert.throws(
        () => addConversationCommentTag(full, 'overflow'),
        /limit/
    );

    const removed = removeConversationCommentTag(full, 'CONVENTION');
    assert.deepEqual(removed.tags, ['b', 'c', 'd', 'e']);
    const noop = removeConversationCommentTag(full, 'missing');
    assert.deepEqual(noop.tags, full.tags);
});

test('CONVERSATION-COMMENTS-001 creates bounded host-authoritative drafts and open/done states', () => {
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
    const editedOpen = updateConversationComment(draft, '  Add a test.  ');
    assert.equal(editedOpen.comment, 'Add a test.');
    assert.equal(editedOpen.status, 'open');
    assert.equal('sentAt' in editedOpen, false);

    const doneDraft = {
        ...draft,
        status: 'done',
        createdAt: 1_700_000_000_000,
        sentAt: 1_700_000_000_100,
    };
    const editedDone = updateConversationComment(doneDraft, 'Rephrase this.');
    assert.equal(editedDone.comment, 'Rephrase this.');
    assert.equal(editedDone.status, 'open');
    assert.equal(editedDone.createdAt, 1_700_000_000_000);
    assert.equal('sentAt' in editedDone, false);

    const marked = markConversationCommentsDone(
        [draft, doneDraft],
        1_700_000_000_200
    );
    assert.deepEqual(
        marked.map(comment => comment.status),
        ['done', 'done']
    );
    assert.equal(marked[0].sentAt, 1_700_000_000_200);
    assert.equal(marked[0].createdAt, undefined);
    assert.equal(
        marked[1].sentAt,
        1_700_000_000_100,
        'a done comment keeps its original send timestamp'
    );
    assert.equal(marked[1].createdAt, 1_700_000_000_000);

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

test('CONVERSATION-PROGRESS-VISIBILITY-001 treats selected progress text as assistant-authored feedback', () => {
    const draft = createConversationComment('comment-progress', {
        messageId: 'message-progress',
        interactionId: 'interaction-progress',
        quote: 'Checking the implementation.',
        prefix: '',
        suffix: '',
        comment: 'Please explain this step.',
    }, {
        id: 'message-progress',
        interactionId: 'interaction-progress',
        role: 'progress',
        markdown: 'Checking the implementation.',
    });

    assert.equal(draft.role, 'assistant');
    assert.doesNotThrow(
        () => markConversationCommentsDone([draft], 1_700_000_000_000)
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

test('CONVERSATION-COMMENTS-001 validates optional timestamps and rejects legacy statuses', () => {
    const base = {
        id: 'comment-a',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Original answer',
        prefix: '',
        suffix: '',
        comment: 'Please clarify this.',
        status: 'open',
    };

    assert.doesNotThrow(() => validateConversationComments([base]));
    assert.doesNotThrow(() => validateConversationComments([{
        ...base,
        status: 'done',
        createdAt: 1_700_000_000_000,
        sentAt: 0,
    }]));

    ['sent', 'resolved'].forEach(status => {
        assert.throws(
            () => validateConversationComments([{ ...base, status }]),
            error => error instanceof ConversationCommentError
                && error.code === 'invalid'
        );
    });
    [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'yesterday'].forEach(value => {
        assert.throws(
            () => validateConversationComments([{ ...base, createdAt: value }]),
            error => error instanceof ConversationCommentError
                && error.code === 'invalid'
        );
        assert.throws(
            () => validateConversationComments([{
                ...base,
                status: 'done',
                sentAt: value,
            }]),
            error => error instanceof ConversationCommentError
                && error.code === 'invalid'
        );
    });
});

test('CONVERSATION-COMMENTS-BULK-001 clears done or all comments without mutating the input', () => {
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
        id: 'comment-done',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Done quote',
        prefix: '',
        suffix: '',
        comment: 'Done question.',
        status: 'done',
        createdAt: 1_700_000_000_000,
        sentAt: 1_700_000_000_100,
    }, {
        id: 'comment-done-later',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'Later done quote',
        prefix: '',
        suffix: '',
        comment: 'Later done question.',
        status: 'done',
    }];

    assert.deepEqual(
        clearConversationComments(comments, 'clearDone').map(
            comment => comment.id
        ),
        ['comment-open']
    );
    assert.deepEqual(clearConversationComments(comments, 'clearAll'), []);
    assert.deepEqual(
        comments.map(comment => comment.id),
        ['comment-open', 'comment-done', 'comment-done-later']
    );
    ['clearSent', 'clearResolved'].forEach(operation => {
        assert.throws(
            () => clearConversationComments(comments, operation),
            error => error instanceof ConversationCommentError
                && error.code === 'invalid'
        );
    });
});

test('CONVERSATION-COMMENTS-ORDERING-001 accepts only an exact comment ID permutation without mutating drafts', () => {
    const comments = [{
        id: 'comment-a',
        messageId: 'message-a',
        interactionId: 'interaction-a',
        role: 'assistant',
        quote: 'First quote',
        prefix: '',
        suffix: '',
        comment: 'First question.',
        status: 'open',
    }, {
        id: 'comment-b',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Second question.',
        status: 'open',
    }];

    const reordered = reorderConversationComments(
        comments,
        ['comment-b', 'comment-a']
    );
    assert.deepEqual(
        reordered.map(comment => comment.id),
        ['comment-b', 'comment-a']
    );
    assert.deepEqual(
        comments.map(comment => comment.id),
        ['comment-a', 'comment-b']
    );
    assert.notEqual(reordered[0], comments[1]);

    [
        ['comment-a'],
        ['comment-a', 'comment-a'],
        ['comment-a', 'comment-missing'],
        ['comment-a', 7],
    ].forEach(ids => {
        assert.throws(
            () => reorderConversationComments(comments, ids),
            error => error instanceof ConversationCommentError
                && error.code === 'invalid'
        );
    });
});
