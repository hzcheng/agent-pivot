'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ProjectCommentController,
} = require('../../../out/aiSessions/conversation/projectCommentController');

const TARGET = Object.freeze({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
});

function createHarness(overrides = {}) {
    const posted = [];
    const saved = [];
    const submitted = [];
    const focused = [];
    let now = 1000;
    const store = {
        load: async () => ({ revision: 0, comments: [] }),
        save: async (target, snapshot) => {
            saved.push({ target, snapshot });
        },
    };
    const controller = new ProjectCommentController({
        projectCommentStore: store,
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
        ...overrides,
    });
    return {
        controller,
        posted,
        saved,
        submitted,
        focused,
        setNow(value) {
            now = value;
        },
    };
}

function mutation(requestId, operation, payload, expectedRevision) {
    return {
        type: 'conversation-viewer-project-comment-mutation',
        version: 1,
        requestId,
        subscriptionGeneration: 7,
        ...TARGET,
        operation,
        expectedRevision,
        payload,
    };
}

test('PROJECT-COMMENTS-CONTROLLER-001 applies mutations host-side with revision bumps and idempotent settlements', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-add', 'add', {
        text: 'Fix the overflow.',
        tags: ['bug'],
    }, 0));
    assert.equal(controller.snapshot.revision, 1);
    assert.equal(controller.snapshot.comments.length, 1);
    const added = controller.snapshot.comments[0];
    assert.equal(added.text, 'Fix the overflow.');
    assert.deepEqual(added.tags, ['bug']);
    assert.equal(added.status, 'open');
    assert.equal(added.createdAt, 1000);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].target, { projectId: 'project-a' });

    const settled = posted.at(-1);
    assert.equal(settled.type, 'conversation-viewer-project-comments-result');
    assert.equal(settled.operation, 'add');
    assert.equal(settled.success, true);
    assert.equal(settled.revision, 1);

    // Replaying the same request id returns the recorded settlement instead
    // of applying the mutation twice.
    await controller.enqueue(mutation('req-add', 'add', {
        text: 'Fix the overflow.',
        tags: ['bug'],
    }, 0));
    assert.equal(controller.snapshot.comments.length, 1);
    assert.equal(posted.at(-1).requestId, 'req-add');
    assert.equal(posted.at(-1).success, true);

    await controller.enqueue(mutation('req-tag', 'addTag', {
        commentId: added.id,
        tag: 'ui',
    }, 1));
    assert.deepEqual(controller.snapshot.comments[0].tags, ['bug', 'ui']);

    await controller.enqueue(mutation('req-done', 'setStatus', {
        commentId: added.id,
        status: 'done',
    }, 2));
    assert.equal(controller.snapshot.comments[0].status, 'done');
    assert.equal(controller.snapshot.comments[0].doneAt, 1000);

    // A stale expectedRevision is rejected without touching the snapshot.
    await controller.enqueue(mutation('req-stale', 'delete', {
        commentId: added.id,
    }, 0));
    const staleSettlement = posted.at(-1);
    assert.equal(staleSettlement.success, false);
    assert.equal(staleSettlement.error, 'stale');
    assert.equal(controller.snapshot.comments.length, 1);
});

test('PROJECT-COMMENTS-CONTROLLER-001 keeps newest notes on top and persists manual reorder', async () => {
    const { controller } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        text: 'first',
    }, 0));
    await controller.enqueue(mutation('req-add-2', 'add', {
        text: 'second',
    }, 1));
    assert.deepEqual(
        controller.snapshot.comments.map(comment => comment.text),
        ['second', 'first']
    );
    const secondId = controller.snapshot.comments[0].id;
    const firstId = controller.snapshot.comments[1].id;

    await controller.enqueue(mutation('req-reorder', 'reorder', {
        orderedCommentIds: [firstId, secondId],
    }, 2));
    assert.deepEqual(
        controller.snapshot.comments.map(comment => comment.text),
        ['first', 'second']
    );
    assert.equal(controller.snapshot.revision, 3);

    // A no-op reorder settles successfully without bumping the revision.
    await controller.enqueue(mutation('req-reorder-same', 'reorder', {
        orderedCommentIds: [firstId, secondId],
    }, 3));
    assert.equal(controller.snapshot.revision, 3);

    // Malformed permutations are rejected.
    await controller.enqueue(mutation('req-reorder-bad', 'reorder', {
        orderedCommentIds: [firstId],
    }, 3));
    assert.equal(controller.snapshot.revision, 3);
});

test('PROJECT-COMMENTS-CONTROLLER-001 restores the project snapshot for any session of the project', async () => {
    const stored = {
        revision: 5,
        comments: [{
            id: 'note-a',
            text: 'Shared across sessions.',
            tags: ['idea'],
            status: 'open',
            createdAt: 1,
            dispatches: [],
        }],
    };
    const otherSession = {
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-other',
    };
    const restored = new ProjectCommentController({
        projectCommentStore: { load: async () => stored },
        submitPrompt: async () => undefined,
        getTarget: () => otherSession,
        getSubscriptionGeneration: () => 3,
        getPanel: () => undefined,
        rebuildLatestDocument: () => undefined,
    });
    await restored.restore(otherSession, 3);
    assert.equal(restored.snapshot.revision, 5);
    assert.equal(restored.snapshot.comments[0].text, 'Shared across sessions.');
});

test('PROJECT-COMMENTS-CONTROLLER-001 dispatches a note into the current session without closing it', async () => {
    const { controller, submitted, focused, posted, saved, setNow } =
        createHarness();
    await controller.enqueue(mutation('req-add', 'add', {
        text: 'Handle the layout regression.',
        tags: ['bug'],
        source: {
            provider: 'kimi',
            sessionId: 'session-z',
            quote: '292 > 281 at 281px',
        },
    }, 0));
    const noteId = controller.snapshot.comments[0].id;

    setNow(2000);
    await controller.enqueue({
        type: 'conversation-viewer-send-project-comment',
        version: 1,
        requestId: 'req-send',
        subscriptionGeneration: 7,
        ...TARGET,
        operation: 'sendProjectComment',
        expectedRevision: 1,
        payload: { commentId: noteId },
    });

    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].target, { ...TARGET });
    assert.match(submitted[0].prompt, /请处理下面这条项目笔记/);
    assert.match(submitted[0].prompt, /标签：bug/);
    assert.match(submitted[0].prompt, /Handle the layout regression\./);
    assert.match(submitted[0].prompt, /292 > 281 at 281px/);

    const note = controller.snapshot.comments[0];
    assert.equal(note.status, 'open');
    assert.deepEqual(note.dispatches, [{
        provider: 'codex',
        sessionId: 'session-a',
        at: 2000,
    }]);
    assert.equal(controller.snapshot.revision, 2);
    assert.equal(posted.at(-1).success, true);
    assert.equal(posted.at(-1).operation, 'sendProjectComment');
    assert.deepEqual(focused, [{ ...TARGET }]);
    assert.equal(saved.at(-1).snapshot.comments[0].dispatches.length, 1);
});

test('PROJECT-COMMENTS-CONTROLLER-001 sweeps done notes and clears all through header actions', async () => {
    const { controller } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        text: 'keep me',
    }, 0));
    await controller.enqueue(mutation('req-add-2', 'add', {
        text: 'done note',
    }, 1));
    const doneId = controller.snapshot.comments[0].id;
    await controller.enqueue(mutation('req-done', 'setStatus', {
        commentId: doneId,
        status: 'done',
    }, 2));

    await controller.enqueue(mutation('req-clear-done', 'clearDone', {}, 3));
    assert.deepEqual(
        controller.snapshot.comments.map(comment => comment.text),
        ['keep me']
    );
    assert.equal(controller.snapshot.revision, 4);

    // Nothing left to clear: no revision bump, still a successful settle.
    await controller.enqueue(mutation('req-clear-done-2', 'clearDone', {}, 4));
    assert.equal(controller.snapshot.revision, 4);

    await controller.enqueue(mutation('req-clear-all', 'clearAll', {}, 4));
    assert.equal(controller.snapshot.comments.length, 0);
    assert.equal(controller.snapshot.revision, 5);
});

test('PROJECT-COMMENTS-CONTROLLER-001 sends every open note as one batch prompt', async () => {
    const { controller, submitted } = createHarness();
    await controller.enqueue(mutation('req-add-1', 'add', {
        text: 'first note',
        tags: ['bug'],
    }, 0));
    await controller.enqueue(mutation('req-add-2', 'add', {
        text: 'second note',
    }, 1));

    await controller.enqueue({
        type: 'conversation-viewer-send-project-comment',
        version: 1,
        requestId: 'req-send-all',
        subscriptionGeneration: 7,
        ...TARGET,
        operation: 'sendProjectComments',
        expectedRevision: 2,
        payload: {},
    });

    assert.equal(submitted.length, 1);
    assert.match(submitted[0].prompt, /请处理下面这些项目笔记/);
    // Newest notes lead the batch, matching the panel order.
    assert.match(submitted[0].prompt, /\[项目笔记 1\]\nsecond note/);
    assert.match(
        submitted[0].prompt,
        /\[项目笔记 2\]（标签：bug）\nfirst note/
    );

    const snapshot = controller.snapshot;
    assert.equal(snapshot.revision, 3);
    // Every open note records the dispatch and stays open.
    snapshot.comments.forEach(comment => {
        assert.equal(comment.status, 'open');
        assert.equal(comment.dispatches.length, 1);
        assert.equal(comment.dispatches[0].sessionId, 'session-a');
    });
});

test('PROJECT-COMMENTS-CONTROLLER-001 rolls back the dispatch record when staging fails', async () => {
    const { controller, posted } = createHarness({
        submitPrompt: async () => {
            const error = new Error('busy');
            error.code = 'busy';
            throw error;
        },
    });
    await controller.enqueue(mutation('req-add', 'add', {
        text: 'Note',
    }, 0));
    const noteId = controller.snapshot.comments[0].id;
    await controller.enqueue({
        type: 'conversation-viewer-send-project-comment',
        version: 1,
        requestId: 'req-send',
        subscriptionGeneration: 7,
        ...TARGET,
        operation: 'sendProjectComment',
        expectedRevision: 1,
        payload: { commentId: noteId },
    });
    const settlement = posted.at(-1);
    assert.equal(settlement.success, false);
    assert.equal(settlement.error, 'busy');
    assert.equal(controller.snapshot.revision, 1);
    assert.deepEqual(controller.snapshot.comments[0].dispatches, []);
});
