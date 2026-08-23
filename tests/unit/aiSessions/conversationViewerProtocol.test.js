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
        type: 'conversation-viewer-switch-window',
        version: 1,
        direction: 'previous',
    }, {
        type: 'conversation-viewer-switch-window',
        version: 1,
        direction: 'next',
    }, {
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 4,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }, {
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: 3,
        requestId: 7,
        htmlSignature: 'c42',
    }, {
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: 3,
        requestId: 7,
        htmlSignature: 'c42',
        frames: [],
    }, {
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: 3,
        requestId: 7,
        htmlSignature: 'c42',
        frames: [{
            projectId: 'project-a',
            provider: 'kimi',
            sessionId: 'session-a',
            token: 'c17',
        }],
    }, {
        type: 'conversation-viewer-focus',
        version: 1,
        focused: true,
    }, {
        type: 'conversation-viewer-focus',
        version: 1,
        focused: false,
    }, {
        type: 'conversation-viewer-rename-session',
        version: 1,
    }, {
        type: 'conversation-viewer-acknowledge-attention',
        version: 1,
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
        type: 'conversation-viewer-copy',
        version: 1,
        ...target,
        operation: 'copy',
        payload: {
            kind: 'code',
            text: 'const answer = 42;',
        },
    }, {
        type: 'conversation-viewer-copy',
        version: 1,
        ...target,
        operation: 'copy',
        payload: {
            kind: 'message',
            messageId: 'input-1:user',
        },
    }, {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        ...target,
        operation: 'reorder',
        expectedRevision: 2,
        payload: {
            orderedCommentIds: ['comment-2', 'comment-1'],
        },
    }, {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        ...target,
        operation: 'clearDone',
        expectedRevision: 2,
        payload: {},
    }, {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        ...target,
        operation: 'addTag',
        expectedRevision: 2,
        payload: { commentId: 'comment-1', tag: 'ux' },
    }, {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        ...target,
        operation: 'removeTag',
        expectedRevision: 2,
        payload: { commentId: 'comment-1', tag: 'ux' },
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
    }, {
        type: 'conversation-viewer-project-comment-mutation',
        version: 1,
        ...target,
        operation: 'add',
        expectedRevision: 0,
        payload: { text: 'note', tags: ['bug'] },
    }, {
        type: 'conversation-viewer-project-comment-mutation',
        version: 1,
        ...target,
        operation: 'setStatus',
        expectedRevision: 3,
        payload: { commentId: 'note-1', status: 'done' },
    }, {
        type: 'conversation-viewer-project-comment-mutation',
        version: 1,
        ...target,
        operation: 'addTag',
        expectedRevision: 3,
        payload: { commentId: 'note-1', tag: 'ux' },
    }, {
        type: 'conversation-viewer-project-comment-mutation',
        version: 1,
        ...target,
        operation: 'reorder',
        expectedRevision: 3,
        payload: { orderedCommentIds: ['note-2', 'note-1'] },
    }, {
        type: 'conversation-viewer-send-project-comment',
        version: 1,
        ...target,
        operation: 'sendProjectComment',
        expectedRevision: 3,
        payload: { commentId: 'note-1' },
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
        // The rename intent carries no payload: a spoofed session identity
        // must never parse (the Host derives the target from the viewer).
        {
            type: 'conversation-viewer-rename-session',
            version: 1,
            sessionId: 'session-spoofed',
        },
        {
            type: 'conversation-viewer-rename-session',
            version: 2,
        },
        // The acknowledge-attention intent is likewise target-less: the
        // Host resolves the viewer's current session authoritatively.
        {
            type: 'conversation-viewer-acknowledge-attention',
            version: 1,
            sessionId: 'session-spoofed',
        },
        {
            type: 'conversation-viewer-acknowledge-attention',
            version: 2,
        },
        {
            type: 'conversation-viewer-select-interaction',
            version: 1,
            interactionId: 'input\u0000private',
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
            type: 'conversation-viewer-switch-window',
            version: 1,
        },
        {
            type: 'conversation-viewer-switch-window',
            version: 1,
            direction: 'up',
        },
        {
            type: 'conversation-viewer-switch-window',
            version: 1,
            direction: 'previous',
            extra: true,
        },
        {
            type: 'conversation-viewer-request-sync',
        },
        {
            type: 'conversation-viewer-request-sync',
            version: 1,
            subscriptionGeneration: 4,
            projectId: 'project-a',
            provider: 'codex',
        },
        {
            type: 'conversation-viewer-request-sync',
            version: 1,
            subscriptionGeneration: 0,
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
        },
        {
            type: 'conversation-viewer-request-sync',
            version: 1,
            subscriptionGeneration: 4,
            projectId: 'project-a',
            provider: 'other',
            sessionId: 'session-a',
        },
        {
            type: 'conversation-viewer-request-sync',
            version: 1,
            subscriptionGeneration: 4,
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
            extra: true,
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 0,
            requestId: 7,
            htmlSignature: 'c42',
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
            htmlSignature: '',
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
            htmlSignature: 'c42',
            extra: true,
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
            htmlSignature: 'c42',
            frames: 'session-a',
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
            htmlSignature: 'c42',
            frames: [{
                projectId: 'project-a',
                provider: 'kimi',
                sessionId: 'session-a',
                token: 'c17',
                extra: true,
            }],
        },
        {
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: 3,
            requestId: 7,
            htmlSignature: 'c42',
            frames: [{
                projectId: 'project-a',
                provider: 'unknown-provider',
                sessionId: 'session-a',
                token: 'c17',
            }],
        },
        {
            type: 'conversation-viewer-focus',
            version: 1,
            focused: 'yes',
        },
        {
            type: 'conversation-viewer-focus',
            version: 1,
            focused: true,
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
            type: 'conversation-viewer-copy',
            version: 1,
            ...target,
            operation: 'copy',
            payload: {
                kind: 'code',
            },
        },
        {
            type: 'conversation-viewer-copy',
            version: 1,
            ...target,
            operation: 'copy',
            payload: {
                kind: 'snippet',
                text: 'x',
            },
        },
        {
            type: 'conversation-viewer-copy',
            version: 1,
            ...target,
            operation: 'copy',
            payload: {
                kind: 'code',
                text: 'x'.repeat(1_000_001),
            },
        },
        {
            type: 'conversation-viewer-copy',
            version: 1,
            ...target,
            operation: 'copy',
            expectedRevision: 2,
            payload: {
                kind: 'code',
                text: 'x',
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
        {
            type: 'conversation-viewer-project-comment-mutation',
            version: 1,
            ...target,
            operation: 'sendProjectComment',
            expectedRevision: 2,
            payload: { commentId: 'note-1' },
        },
        {
            type: 'conversation-viewer-project-comment-mutation',
            version: 1,
            ...target,
            operation: 'add',
            expectedRevision: 2,
            payload: { text: 'note' },
            extra: true,
        },
        {
            type: 'conversation-viewer-send-project-comment',
            version: 1,
            ...target,
            operation: 'sendProjectComment',
            expectedRevision: 2,
            payload: {},
        },
        {
            type: 'conversation-viewer-send-project-comment',
            version: 1,
            ...target,
            operation: 'sendProjectComment',
            expectedRevision: 2,
            payload: { commentId: 'note-1', submit: true },
        },
    ];

    malformed.forEach(message => {
        assert.equal(parseConversationViewerMessage(message), undefined);
    });
});

test('CONVERSATION-COPY-ACTIONS-001 validates code and message copy payloads', () => {
    const codeCopy = {
        type: 'conversation-viewer-copy',
        version: 1,
        ...target,
        operation: 'copy',
        payload: {
            kind: 'code',
            text: 'const answer = 42;',
        },
    };
    const messageCopy = {
        type: 'conversation-viewer-copy',
        version: 1,
        ...target,
        operation: 'copy',
        payload: {
            kind: 'message',
            messageId: 'input-1:user',
        },
    };
    assert.deepEqual(parseConversationViewerMessage(codeCopy), codeCopy);
    assert.deepEqual(parseConversationViewerMessage(messageCopy), messageCopy);
    assert.equal(parseConversationViewerMessage({
        ...codeCopy,
        payload: { kind: 'code', text: 42 },
    }), undefined);
    assert.equal(parseConversationViewerMessage({
        ...messageCopy,
        payload: { kind: 'message', messageId: '' },
    }), undefined);
});

test('WORKTREE-CHANGES-PANEL-001 parses open-file intents with every porcelain XY shape', () => {
    const binding = {
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const base = {
        type: 'conversation-viewer-changes-open-file',
        version: 1,
        ...binding,
        memberId: 'member-1',
        group: 'changes',
        path: 'src/a.ts',
    };
    // Space-bearing XY codes are the common case (' M', 'M ', ' D'):
    for (const xy of [' M', 'M ', ' D', 'MM', 'A ', 'R ']) {
        const message = { ...base, xy };
        assert.deepEqual(parseConversationViewerMessage(message), message,
            `xy '${xy}' must parse`);
    }
    const renamed = { ...base, xy: 'R ', originalPath: 'src/old.ts' };
    assert.deepEqual(parseConversationViewerMessage(renamed), renamed);
    assert.equal(parseConversationViewerMessage({ ...base, xy: 'bad' }), undefined);
    assert.equal(parseConversationViewerMessage({ ...base, xy: '' }), undefined);
    assert.equal(parseConversationViewerMessage({ ...base, group: 'weird' }), undefined);
    assert.equal(parseConversationViewerMessage({ ...base, memberId: '../evil' }),
        undefined);
});

test('WORKTREE-CHANGES-PANEL-001 binds every changes action to generation and session identity', () => {
    const binding = {
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const intents = [{
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...binding,
        memberId: 'member-1',
    }, {
        type: 'conversation-viewer-changes-refresh',
        version: 1,
        ...binding,
    }, {
        type: 'conversation-viewer-changes-review',
        version: 1,
        ...binding,
        memberId: 'member-1',
    }, {
        type: 'conversation-viewer-changes-open-scm',
        version: 1,
        ...binding,
        memberId: 'member-1',
    }, {
        type: 'conversation-viewer-changes-open-file',
        version: 1,
        ...binding,
        memberId: 'member-1',
        group: 'staged',
        xy: 'M ',
        path: 'src/a.ts',
    }];
    for (const intent of intents) {
        assert.deepEqual(parseConversationViewerMessage(intent), intent,
            `${intent.type} must parse with its binding`);
        // A stray binding field invalidates the whole intent.
        assert.equal(parseConversationViewerMessage(
            { ...intent, subscriptionGeneration: 0 }), undefined);
        assert.equal(parseConversationViewerMessage(
            { ...intent, subscriptionGeneration: 1.5 }), undefined);
        assert.equal(parseConversationViewerMessage(
            { ...intent, projectId: '' }), undefined);
        assert.equal(parseConversationViewerMessage(
            { ...intent, provider: 'not-a-provider' }), undefined);
        assert.equal(parseConversationViewerMessage(
            { ...intent, sessionId: '' }), undefined);
        // An unknown extra key invalidates the intent (exact-key
        // discipline), and a missing binding key fails closed.
        assert.equal(parseConversationViewerMessage(
            { ...intent, stray: true }), undefined);
        const { sessionId: _dropped, ...unbound } = intent;
        assert.equal(parseConversationViewerMessage(unbound), undefined,
            `${intent.type} without sessionId must not parse`);
    }
});

test('WORKTREE-CHANGES-COMMITS-001 parses commits requests with binding and request correlation', () => {
    const binding = {
        requestId: 'req-1',
        subscriptionGeneration: 3,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const sha = 'a'.repeat(40);
    const list = {
        type: 'conversation-viewer-commits-list',
        version: 1,
        ...binding,
        memberId: 'member-1',
        scope: 'since-start',
        offset: 0,
    };
    assert.deepEqual(parseConversationViewerMessage(list), list);
    assert.deepEqual(parseConversationViewerMessage(
        { ...list, historyHead: sha }),
        { ...list, historyHead: sha },
        'later pages echo the frozen history head');
    const detail = {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        ...binding,
        memberId: 'member-1',
        sha,
    };
    assert.deepEqual(parseConversationViewerMessage(detail), detail);
    const review = {
        ...detail,
        type: 'conversation-viewer-commit-review',
    };
    assert.deepEqual(parseConversationViewerMessage(review), review);
    const openFile = {
        type: 'conversation-viewer-commit-open-file',
        version: 1,
        ...binding,
        memberId: 'member-1',
        sha,
        path: 'src/a.ts',
        oldPath: 'src/old.ts',
    };
    assert.deepEqual(parseConversationViewerMessage(openFile), openFile);

    // Fail closed on bad shapes, bounds, enumerations, and stray keys.
    assert.equal(parseConversationViewerMessage(
        { ...list, scope: 'everything' }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...list, offset: -1 }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...list, offset: 1_000_001 }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...list, historyHead: 'short' }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...detail, sha: 'short' }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...openFile, path: '' }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...openFile, oldPath: 'a\0b' }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...list, stray: true }), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...detail, requestId: '' }), undefined);
    // Commits requests keep the changes-action binding discipline: an
    // intent without session identity must not parse.
    const { sessionId: _dropped, ...unbound } = list;
    assert.equal(parseConversationViewerMessage(unbound), undefined);
    assert.equal(parseConversationViewerMessage(
        { ...list, subscriptionGeneration: 0 }), undefined);
});
