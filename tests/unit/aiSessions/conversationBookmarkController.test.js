'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationBookmarkController,
} = require('../../../out/aiSessions/conversation/bookmarkController');
const {
    MAX_CONVERSATION_BOOKMARKS,
} = require('../../../out/aiSessions/conversation/bookmarkStore');

const TARGET = Object.freeze({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
});

const OUTLINE = Object.freeze({
    interactions: [
        Object.freeze({ id: 'interaction-a' }),
        Object.freeze({ id: 'interaction-b' }),
        Object.freeze({ id: 'interaction-extra' }),
    ],
});

function createHarness(overrides = {}) {
    const posted = [];
    const saved = [];
    const store = {
        load: async () => ({ revision: 0, interactionIds: [] }),
        save: async (target, snapshot) => {
            saved.push({ target, snapshot });
        },
    };
    const controller = new ConversationBookmarkController({
        bookmarkStore: store,
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
        getOutline: () => OUTLINE,
        rebuildLatestDocument: () => undefined,
        ...overrides,
    });
    return { controller, posted, saved };
}

function mutation(requestId, interactionId, bookmarked, expectedRevision, generation = 7) {
    return {
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId,
        subscriptionGeneration: generation,
        ...TARGET,
        operation: 'set',
        expectedRevision,
        payload: { interactionId, bookmarked },
    };
}

test('CONVERSATION-OUTLINE-BOOKMARKS-001 toggles bookmarks host-side with revision bumps', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-add', 'interaction-a', true, 0));
    let settlement = posted.at(-1);
    assert.equal(settlement.type, 'conversation-viewer-bookmarks-result');
    assert.equal(settlement.operation, 'set');
    assert.equal(settlement.requestId, 'req-add');
    assert.equal(settlement.subscriptionGeneration, 7);
    assert.equal(settlement.projectId, TARGET.projectId);
    assert.equal(settlement.success, true);
    assert.equal(settlement.revision, 1);
    assert.deepEqual(settlement.interactionIds, ['interaction-a']);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].snapshot, {
        revision: 1,
        interactionIds: ['interaction-a'],
    });

    await controller.enqueue(mutation('req-add-2', 'interaction-b', true, 1));
    assert.equal(posted.at(-1).revision, 2);
    assert.deepEqual(controller.snapshot.interactionIds.sort(), [
        'interaction-a',
        'interaction-b',
    ]);

    await controller.enqueue(mutation('req-remove', 'interaction-a', false, 2));
    settlement = posted.at(-1);
    assert.equal(settlement.success, true);
    assert.equal(settlement.revision, 3);
    assert.deepEqual(settlement.interactionIds, ['interaction-b']);
    assert.equal(saved.length, 3);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 rejects stale revisions and unknown interactions without persisting', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-stale', 'interaction-a', true, 4));
    assert.deepEqual(
        {
            success: posted.at(-1).success,
            error: posted.at(-1).error,
        },
        { success: false, error: 'stale' }
    );
    assert.equal(saved.length, 0);
    assert.equal(controller.snapshot.revision, 0);

    await controller.enqueue(mutation('req-unknown', 'interaction-missing', true, 0));
    assert.equal(posted.at(-1).success, false);
    assert.equal(posted.at(-1).error, 'stale');
    assert.equal(saved.length, 0);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 replays the cached settlement for a repeated request', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-once', 'interaction-a', true, 0));
    assert.equal(saved.length, 1);

    await controller.enqueue(mutation('req-once', 'interaction-a', true, 0));
    assert.equal(saved.length, 1);
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1], posted[0]);
    assert.equal(controller.snapshot.revision, 1);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 replays the true outcome for a cross-generation repeat', async () => {
    // Settlement keys ignore the subscription generation: a retried request
    // gets the result of the work that actually ran, and the webview drops
    // stale-generation messages on its own.
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-retry', 'interaction-a', true, 0));
    await controller.enqueue(mutation('req-retry', 'interaction-a', true, 0, 8));
    assert.equal(saved.length, 1);
    assert.equal(posted.length, 2);
    assert.equal(posted[1].success, true);
    assert.equal(posted[1].subscriptionGeneration, 7);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 enforces the bookmark budget', async () => {
    const existing = Array.from(
        { length: MAX_CONVERSATION_BOOKMARKS },
        (_unused, index) => `interaction-${index}`
    );
    const { controller, posted, saved } = createHarness({
        bookmarkStore: {
            load: async () => ({
                revision: 3,
                interactionIds: existing,
            }),
            save: async () => undefined,
        },
    });

    await controller.restore(TARGET, 7);
    assert.equal(controller.snapshot.revision, 3);
    assert.equal(
        controller.snapshot.interactionIds.length,
        MAX_CONVERSATION_BOOKMARKS
    );

    await controller.enqueue(
        mutation('req-overflow', 'interaction-extra', true, 3)
    );
    assert.equal(posted.at(-1).success, false);
    assert.equal(posted.at(-1).error, 'limit');
    assert.equal(saved.length, 0);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 settles frozen mutations as stale until reset', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.freezeMutations();
    await controller.enqueue(mutation('req-frozen', 'interaction-a', true, 0));
    assert.equal(posted.at(-1).success, false);
    assert.equal(posted.at(-1).error, 'stale');
    assert.equal(saved.length, 0);

    controller.reset();
    await controller.enqueue(mutation('req-thawed', 'interaction-a', true, 0));
    assert.equal(posted.at(-1).success, true);
    assert.equal(controller.snapshot.revision, 1);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 restores only for the live target and generation', async () => {
    const stored = { revision: 5, interactionIds: ['interaction-a'] };
    const { controller } = createHarness({
        bookmarkStore: {
            load: async () => stored,
            save: async () => undefined,
        },
    });

    await controller.restore(TARGET, 8);
    assert.equal(controller.snapshot.revision, 0);

    await controller.restore(TARGET, 7);
    assert.equal(controller.snapshot.revision, 5);
    assert.deepEqual(controller.snapshot.interactionIds, ['interaction-a']);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 settles redundant toggles without persisting', async () => {
    const { controller, posted, saved } = createHarness();

    await controller.enqueue(mutation('req-add', 'interaction-a', true, 0));
    assert.equal(saved.length, 1);

    await controller.enqueue(mutation('req-again', 'interaction-a', true, 1));
    const settlement = posted.at(-1);
    assert.equal(settlement.success, true);
    assert.equal(settlement.revision, 1);
    assert.equal(saved.length, 1);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 maps persistence failures to failed without touching state', async () => {
    const { controller, posted } = createHarness({
        bookmarkStore: {
            load: async () => ({ revision: 0, interactionIds: [] }),
            save: async () => {
                throw new Error('disk full');
            },
        },
    });

    await controller.enqueue(mutation('req-io', 'interaction-a', true, 0));
    assert.equal(posted.at(-1).success, false);
    assert.equal(posted.at(-1).error, 'failed');
    assert.equal(controller.snapshot.revision, 0);
    assert.deepEqual(controller.snapshot.interactionIds, []);
});
