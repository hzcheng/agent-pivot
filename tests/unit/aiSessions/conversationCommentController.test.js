'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationCommentError,
} = require('../../../out/aiSessions/conversation/comments');
const {
    ConversationCommentController,
} = require('../../../out/aiSessions/conversation/commentController');

const TARGET = Object.freeze({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
});

const MESSAGES = Object.freeze([Object.freeze({
    id: 'message-a',
    interactionId: 'interaction-a',
    role: 'assistant',
    markdown: 'The original response.',
})]);

const selectionPayload = Object.freeze({
    messageId: 'message-a',
    interactionId: 'interaction-a',
    quote: 'original response',
    prefix: 'The ',
    suffix: '.',
    comment: 'Explain this.',
});

function createHarness(overrides = {}) {
    const posted = [];
    const saved = [];
    const submitted = [];
    const focused = [];
    const navigated = [];
    let now = 1000;
    const store = {
        load: async () => ({ revision: 0, comments: [] }),
        save: async (target, snapshot) => {
            saved.push({ target, snapshot });
        },
    };
    const controller = new ConversationCommentController({
        commentStore: store,
        now: () => now,
        submitPrompt: async (target, prompt) => {
            submitted.push({ target, prompt });
        },
        focusSession: async target => {
            focused.push(target);
        },
        getTarget: () => TARGET,
        getSubscriptionGeneration: () => 7,
        getPanel: () => ({
            webview: {
                postMessage: async message => {
                    posted.push(message);
                    return true;
                },
            },
        }),
        rebuildLatestDocument: () => undefined,
        getMessages: () => MESSAGES,
        navigateToInteraction: async interactionId => {
            navigated.push(interactionId);
            return true;
        },
        ...overrides,
    });
    return {
        controller,
        posted,
        saved,
        submitted,
        focused,
        navigated,
        setNow(value) {
            now = value;
        },
    };
}

function mutation(requestId, operation, payload, expectedRevision) {
    return {
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        requestId,
        subscriptionGeneration: 7,
        ...TARGET,
        operation,
        expectedRevision,
        payload,
    };
}

function send(requestId, operation, payload, expectedRevision) {
    return {
        type: 'conversation-viewer-send-comments',
        version: 1,
        requestId,
        subscriptionGeneration: 7,
        ...TARGET,
        operation,
        expectedRevision,
        payload,
    };
}

function locateRequest(requestId, commentId, subscriptionGeneration = 7) {
    return {
        type: 'conversation-viewer-locate-comment',
        version: 1,
        requestId,
        subscriptionGeneration,
        ...TARGET,
        commentId,
    };
}

test('CONVERSATION-COMMENTS-001 applies session and selection mutations host-side with revision bumps', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-add-session', 'add', {
        scope: 'session',
        comment: 'Remember the rollout plan.',
    }, 0));
    assert.equal(controller.snapshot.revision, 1);
    assert.equal(controller.snapshot.comments.length, 1);
    const sessionNote = controller.snapshot.comments[0];
    assert.equal(sessionNote.scope, 'session');
    assert.equal(sessionNote.status, 'open');
    assert.equal(sessionNote.createdAt, 1000);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].target, { ...TARGET });

    const settled = posted.at(-1);
    assert.equal(settled.type, 'conversation-viewer-comments-result');
    assert.equal(settled.requestId, 'req-add-session');
    assert.equal(settled.subscriptionGeneration, 7);
    assert.equal(settled.projectId, TARGET.projectId);
    assert.equal(settled.provider, TARGET.provider);
    assert.equal(settled.sessionId, TARGET.sessionId);
    assert.equal(settled.operation, 'add');
    assert.equal(settled.success, true);
    assert.equal(settled.revision, 1);
    assert.equal(settled.comments.length, 1);

    await controller.enqueue(mutation(
        'req-add-selection',
        'add',
        selectionPayload,
        1
    ));
    assert.equal(controller.snapshot.revision, 2);
    const selectionNote = controller.snapshot.comments[1];
    assert.equal(selectionNote.messageId, 'message-a');
    assert.equal(selectionNote.interactionId, 'interaction-a');
    assert.equal(selectionNote.role, 'assistant');
    assert.equal(selectionNote.quote, 'original response');

    // A selection whose message is gone settles as stale without a save.
    await controller.enqueue(mutation('req-add-missing', 'add', {
        ...selectionPayload,
        messageId: 'message-missing',
    }, 2));
    const missing = posted.at(-1);
    assert.equal(missing.success, false);
    assert.equal(missing.error, 'stale');
    assert.equal(controller.snapshot.revision, 2);
    assert.equal(controller.snapshot.comments.length, 2);
    assert.equal(saved.length, 2);

    await controller.enqueue(mutation('req-update', 'update', {
        commentId: selectionNote.id,
        comment: 'Explain this in more depth.',
    }, 2));
    assert.equal(controller.snapshot.revision, 3);
    assert.equal(
        controller.snapshot.comments[1].comment,
        'Explain this in more depth.'
    );

    await controller.enqueue(mutation('req-delete', 'delete', {
        commentId: sessionNote.id,
    }, 3));
    assert.equal(controller.snapshot.revision, 4);
    assert.deepEqual(
        controller.snapshot.comments.map(comment => comment.id),
        [selectionNote.id]
    );
});

test('CONVERSATION-COMMENTS-001 rejects a stale expectedRevision without touching the snapshot', async () => {
    const { controller, posted, saved } = createHarness();
    await controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'first',
    }, 0));

    await controller.enqueue(mutation('req-stale', 'delete', {
        commentId: controller.snapshot.comments[0].id,
    }, 0));
    const settlement = posted.at(-1);
    assert.equal(settlement.success, false);
    assert.equal(settlement.error, 'stale');
    assert.equal(settlement.revision, 1);
    assert.equal(controller.snapshot.comments.length, 1);
    assert.equal(saved.length, 1);
});

test('CONVERSATION-COMMENTS-001 applies tag, reorder, and clear mutations through the same queue', async () => {
    const { controller, posted } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        scope: 'session',
        comment: 'first',
    }, 0));
    await controller.enqueue(mutation('req-add-2', 'add', {
        scope: 'session',
        comment: 'second',
    }, 1));
    const [first, second] = controller.snapshot.comments;

    await controller.enqueue(mutation('req-tag', 'addTag', {
        commentId: first.id,
        tag: 'convention',
    }, 2));
    assert.deepEqual(controller.snapshot.comments[0].tags, ['convention']);
    assert.equal(controller.snapshot.revision, 3);

    await controller.enqueue(mutation('req-untag', 'removeTag', {
        commentId: first.id,
        tag: 'convention',
    }, 3));
    assert.deepEqual(controller.snapshot.comments[0].tags, []);
    assert.equal(controller.snapshot.revision, 4);

    await controller.enqueue(mutation('req-reorder', 'reorder', {
        orderedCommentIds: [second.id, first.id],
    }, 4));
    assert.deepEqual(
        controller.snapshot.comments.map(comment => comment.comment),
        ['second', 'first']
    );
    assert.equal(controller.snapshot.revision, 5);

    // A no-op reorder settles successfully without bumping the revision.
    await controller.enqueue(mutation('req-reorder-same', 'reorder', {
        orderedCommentIds: [second.id, first.id],
    }, 5));
    assert.equal(controller.snapshot.revision, 5);
    assert.equal(posted.at(-1).success, true);

    // Nothing is done yet: no revision bump, still a successful settle.
    await controller.enqueue(mutation('req-clear-done', 'clearDone', {}, 5));
    assert.equal(controller.snapshot.revision, 5);
    assert.equal(controller.snapshot.comments.length, 2);

    await controller.enqueue(mutation('req-clear-all', 'clearAll', {}, 5));
    assert.equal(controller.snapshot.comments.length, 0);
    assert.equal(controller.snapshot.revision, 6);
});

test('CONVERSATION-COMMENTS-001 replays a recorded settlement instead of re-applying the mutation', async () => {
    const { controller, posted, saved } = createHarness();
    await controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'exactly once',
    }, 0));
    assert.equal(saved.length, 1);
    const first = posted.at(-1);

    await controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'exactly once',
    }, 0));
    assert.equal(controller.snapshot.comments.length, 1);
    assert.equal(saved.length, 1);
    const replayed = posted.at(-1);
    assert.equal(replayed.requestId, 'req-add');
    assert.equal(replayed.success, true);
    assert.equal(replayed.revision, first.revision);

    // The same request id carrying a different operation is rejected.
    await controller.enqueue(mutation('req-add', 'delete', {
        commentId: controller.snapshot.comments[0].id,
    }, 1));
    const mismatched = posted.at(-1);
    assert.equal(mismatched.operation, 'delete');
    assert.equal(mismatched.success, false);
    assert.equal(mismatched.error, 'invalid');
    assert.equal(controller.snapshot.comments.length, 1);
    assert.equal(saved.length, 1);
});

test('CONVERSATION-COMMENTS-SUBMIT-001 sends every open comment as one numbered batch prompt', async () => {
    const { controller, posted, submitted, focused, setNow } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        scope: 'session',
        comment: 'First question.',
    }, 0));
    await controller.enqueue(mutation(
        'req-add-2',
        'add',
        selectionPayload,
        1
    ));

    setNow(2000);
    await controller.enqueue(send('req-send-all', 'sendComments', {}, 2));

    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].target, { ...TARGET });
    assert.match(submitted[0].prompt, /\[批注 1\]/);
    assert.match(submitted[0].prompt, /\[批注 2\]/);
    assert.match(submitted[0].prompt, /First question\./);
    assert.match(submitted[0].prompt, /Explain this\./);

    const snapshot = controller.snapshot;
    assert.equal(snapshot.revision, 3);
    snapshot.comments.forEach(comment => {
        assert.equal(comment.status, 'done');
        assert.equal(comment.sentAt, 2000);
    });
    const settled = posted.at(-1);
    assert.equal(settled.operation, 'sendComments');
    assert.equal(settled.success, true);
    assert.equal(settled.revision, 3);
    assert.deepEqual(focused, [{ ...TARGET }]);
});

test('CONVERSATION-COMMENTS-SUBMIT-002 sends one selected comment and leaves every other draft open', async () => {
    const { controller, posted, submitted, focused } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        scope: 'session',
        comment: 'First question.',
    }, 0));
    await controller.enqueue(mutation('req-add-2', 'add', {
        scope: 'session',
        comment: 'Second question.',
    }, 1));
    const targetId = controller.snapshot.comments[0].id;

    await controller.enqueue(send('req-send-one', 'sendComment', {
        commentId: targetId,
    }, 2));

    assert.equal(submitted.length, 1);
    assert.match(submitted[0].prompt, /\[批注 1\]/);
    assert.match(submitted[0].prompt, /First question\./);
    assert.doesNotMatch(submitted[0].prompt, /批注 2/);
    assert.doesNotMatch(submitted[0].prompt, /Second question\./);

    const snapshot = controller.snapshot;
    assert.equal(snapshot.comments[0].status, 'done');
    assert.equal(snapshot.comments[1].status, 'open');
    assert.equal(snapshot.revision, 3);
    assert.equal(posted.at(-1).success, true);
    assert.equal(posted.at(-1).operation, 'sendComment');
    assert.deepEqual(focused, [{ ...TARGET }]);
});

test('CONVERSATION-COMMENTS-SUBMIT-001 rolls back the staged batch when prompt staging fails', async () => {
    const attempted = [];
    const { controller, posted, saved, focused } = createHarness({
        submitPrompt: async (target, prompt) => {
            attempted.push(prompt);
            throw new ConversationCommentError('busy');
        },
    });
    await controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'Do not lose me.',
    }, 0));

    await controller.enqueue(send('req-send', 'sendComments', {}, 1));

    assert.equal(attempted.length, 1);
    const settlement = posted.at(-1);
    assert.equal(settlement.success, false);
    assert.equal(settlement.error, 'busy');
    assert.equal(controller.snapshot.revision, 1);
    assert.equal(controller.snapshot.comments[0].status, 'open');
    // The optimistic snapshot was persisted, then rolled back host-side.
    assert.equal(saved.length, 3);
    assert.equal(saved.at(-1).snapshot.revision, 1);
    assert.equal(saved.at(-1).snapshot.comments[0].status, 'open');
    assert.deepEqual(focused, []);
});

test('CONVERSATION-COMMENTS-001 freezes mutations into stale settlements until reset', async () => {
    const { controller, posted } = createHarness();
    await controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'before freeze',
    }, 0));

    await controller.freezeMutations();
    await controller.enqueue(mutation('req-frozen', 'add', {
        scope: 'session',
        comment: 'during freeze',
    }, 1));
    const frozen = posted.at(-1);
    assert.equal(frozen.success, false);
    assert.equal(frozen.error, 'stale');
    assert.equal(controller.snapshot.comments.length, 1);
    assert.equal(controller.snapshot.revision, 1);

    controller.reset();
    assert.equal(controller.snapshot.revision, 0);
    assert.equal(controller.snapshot.comments.length, 0);
    await controller.enqueue(mutation('req-after-reset', 'add', {
        scope: 'session',
        comment: 'after reset',
    }, 0));
    assert.equal(posted.at(-1).success, true);
    assert.equal(controller.snapshot.comments.length, 1);
});

test('CONVERSATION-COMMENTS-001 drains the mutation queue before resolving', async () => {
    const { controller, posted } = createHarness();
    const pending = controller.enqueue(mutation('req-add', 'add', {
        scope: 'session',
        comment: 'queued',
    }, 0));
    await controller.drainMutations();
    assert.equal(controller.snapshot.revision, 1);
    await pending;
    assert.equal(posted.at(-1).success, true);
});

test('CONVERSATION-COMMENTS-001 navigates to a located comment and rejects stale locate requests', async () => {
    const { controller, posted, navigated } = createHarness();
    await controller.enqueue(mutation(
        'req-add',
        'add',
        selectionPayload,
        0
    ));
    const commentId = controller.snapshot.comments[0].id;

    await controller.locate(locateRequest('req-locate', commentId));
    assert.deepEqual(navigated, ['interaction-a']);
    const located = posted.at(-1);
    assert.equal(located.type, 'conversation-viewer-locate-comment-result');
    assert.equal(located.requestId, 'req-locate');
    assert.equal(located.commentId, commentId);
    assert.equal(located.success, true);
    assert.equal('error' in located, false);

    await controller.locate(locateRequest('req-locate-stale', commentId, 999));
    const stale = posted.at(-1);
    assert.equal(stale.success, false);
    assert.equal(stale.error, 'stale');
    assert.deepEqual(navigated, ['interaction-a']);
});

test('CONVERSATION-COMMENTS-PERSISTENCE-001 restores the stored snapshot only for the live target and generation', async () => {
    const stored = {
        revision: 5,
        comments: [{
            id: 'comment-a',
            messageId: 'message-a',
            interactionId: 'interaction-a',
            role: 'assistant',
            quote: 'Original answer',
            prefix: '',
            suffix: '',
            comment: 'Please clarify this.',
            status: 'open',
        }],
    };
    const store = {
        load: async () => stored,
        save: async () => undefined,
    };
    const live = createHarness({ commentStore: store });
    await live.controller.restore(TARGET, 7);
    assert.equal(live.controller.snapshot.revision, 5);
    assert.equal(
        live.controller.snapshot.comments[0].comment,
        'Please clarify this.'
    );

    const staleGeneration = createHarness({
        commentStore: store,
        getSubscriptionGeneration: () => 3,
    });
    await staleGeneration.controller.restore(TARGET, 7);
    assert.equal(staleGeneration.controller.snapshot.revision, 0);
    assert.equal(staleGeneration.controller.snapshot.comments.length, 0);
});
