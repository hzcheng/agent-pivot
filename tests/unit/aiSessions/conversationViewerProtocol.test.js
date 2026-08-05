'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseConversationViewerMessage,
} = require('../../../out/aiSessions/conversation/viewerProtocol');

const target = Object.freeze({
    requestId: 'request-1',
    subscriptionGeneration: 1,
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
});

test('CONVERSATION-PROTOCOL-VALIDATOR-001 accepts every exact version-1 viewer intent', () => {
    const messages = [{
        type: 'conversation-viewer-previous',
        version: 1,
    }, {
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-1',
    }, {
        type: 'conversation-viewer-open-link',
        version: 1,
        href: 'https://example.test',
    }, {
        type: 'conversation-viewer-open-worktree',
        version: 1,
        worktreeRoot: '/repo/.worktree/feature-x',
    }, {
        type: 'conversation-viewer-send-selection',
        version: 1,
        text: 'quoted selection',
    }, {
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'previous',
    }, {
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'next',
    }, {
        type: 'conversation-viewer-locate-comment',
        version: 1,
        ...target,
        commentId: 'comment-1',
    }, {
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        ...target,
        operation: 'set',
        expectedRevision: 2,
        payload: {
            interactionId: 'input-1',
            bookmarked: true,
        },
    }, {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        ...target,
        operation: 'clearDone',
        expectedRevision: 2,
        payload: {},
    }, {
        type: 'conversation-viewer-send-comments',
        version: 1,
        ...target,
        operation: 'sendComments',
        expectedRevision: 2,
        payload: {},
    }, {
        type: 'conversation-viewer-send-comments',
        version: 1,
        ...target,
        operation: 'sendComment',
        expectedRevision: 2,
        payload: { commentId: 'comment-1' },
    }];

    assert.deepEqual(
        messages.map(message => parseConversationViewerMessage(message)),
        messages
    );
});

test('CONVERSATION-PROTOCOL-VALIDATOR-001 rejects malformed, inherited, and over-posted viewer intents', () => {
    const inheritedNavigation = Object.create({
        type: 'conversation-viewer-next',
        version: 1,
    });
    const malformed = [
        null,
        [],
        inheritedNavigation,
        {
            type: 'conversation-viewer-latest',
            version: 1,
            extra: true,
        },
        {
            type: 'conversation-viewer-select-interaction',
            version: 1,
            interactionId: 'input\u0000private',
        },
        {
            type: 'conversation-viewer-open-worktree',
            version: 1,
        },
        {
            type: 'conversation-viewer-open-worktree',
            version: 1,
            worktreeRoot: '/repo\u0000private',
        },
        {
            type: 'conversation-viewer-open-worktree',
            version: 1,
            worktreeRoot: '/repo',
            extra: true,
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: '   ',
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'x'.repeat(4001),
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'quoted selection',
            extra: true,
        },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
        },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'up',
        },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'next',
            extra: true,
        },
        {
            type: 'conversation-viewer-bookmark-mutation',
            version: 1,
            ...target,
            operation: 'set',
            expectedRevision: 2,
            payload: {
                interactionId: 'input-1',
                bookmarked: 'yes',
            },
        },
        {
            type: 'conversation-viewer-comment-mutation',
            version: 1,
            ...target,
            operation: 'resolve',
            expectedRevision: 2,
            payload: { commentId: 'comment-1' },
        },
        {
            type: 'conversation-viewer-comment-mutation',
            version: 1,
            ...target,
            operation: 'reopen',
            expectedRevision: 2,
            payload: { commentId: 'comment-1' },
        },
        {
            type: 'conversation-viewer-comment-mutation',
            version: 1,
            ...target,
            operation: 'clearSent',
            expectedRevision: 2,
            payload: {},
        },
        {
            type: 'conversation-viewer-comment-mutation',
            version: 1,
            ...target,
            operation: 'clearResolved',
            expectedRevision: 2,
            payload: {},
        },
        {
            type: 'conversation-viewer-send-comments',
            version: 1,
            ...target,
            operation: 'sendComments',
            expectedRevision: 2,
            payload: { submit: true },
        },
        {
            type: 'conversation-viewer-send-comments',
            version: 1,
            ...target,
            operation: 'sendComments',
            expectedRevision: 2,
            payload: { commentId: 'comment-1' },
        },
        {
            type: 'conversation-viewer-send-comments',
            version: 1,
            ...target,
            operation: 'sendComment',
            expectedRevision: 2,
            payload: {},
        },
        {
            type: 'conversation-viewer-send-comments',
            version: 1,
            ...target,
            operation: 'sendComment',
            expectedRevision: 2,
            payload: { commentId: 7 },
        },
        {
            type: 'conversation-viewer-send-comments',
            version: 1,
            ...target,
            operation: 'sendComment',
            expectedRevision: 2,
            payload: { commentId: 'comment-1', submit: true },
        },
    ];

    malformed.forEach(message => {
        assert.equal(parseConversationViewerMessage(message), undefined);
    });
});
