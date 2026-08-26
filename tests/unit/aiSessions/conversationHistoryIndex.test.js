'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ConversationHistoryIndex,
} = require('../../../out/aiSessions/conversation/historyIndex');
const {
    ConversationAbortController,
} = require('../../../out/aiSessions/conversation/types');

const source = Object.freeze({
    sourceIdentity: 'source-a',
    sourceSize: 100,
    sourceRevision: 'r1',
    reducerVersion: 1,
    sourceEpoch: 'inode-a',
    sourceFirstHash: 'first-a',
    sourceLastHash: 'last-a',
    points: [],
});

function interaction(id) {
    return {
        id,
        userMarkdown: id,
        userPreview: id,
        userGraphemeCount: id.length,
        assistantMarkdown: [],
        responseState: 'complete',
    };
}

function slice(request, interactions, options = {}) {
    return {
        ...request,
        interactions,
        complete: options.complete === true,
        ...(options.complete === true ? {
            completeSegmentDigest: options.completeSegmentDigest || 'complete-segment',
        } : {
            nextOffset: options.nextOffset,
        }),
    };
}

test('CONVERSATION-HISTORY-INDEX-001 commits only monotonic restart-safe slices', async () => {
    const index = new ConversationHistoryIndex();
    const first = await index.advance('kimi:s1', source, async request => ({
            ...slice(request, [interaction('first')], { nextOffset: 40 }),
            restartInteractionId: 'second',
            restartRecordEndOffset: 50,
            restartRecordDigest: 'record-second',
            restartSegmentDigest: 'segment-first',
        })
    );
    assert.deepEqual(first.interactions.map(item => item.id), ['first']);
    assert.equal(first.nextOffset, 40);
    const complete = await index.advance('kimi:s1', source, async request =>
        slice(request, [interaction('second')], { complete: true })
    );
    assert.deepEqual(complete.interactions.map(item => item.id), ['first', 'second']);
    assert.equal(complete.complete, true);
    assert.equal(complete.nextOffset, 100);
});

test('CONVERSATION-HISTORY-INDEX-002 a cancelled or invalidated late slice cannot publish', async () => {
    const index = new ConversationHistoryIndex();
    let resolve;
    const pending = index.advance('claude:s1', source, async request =>
        new Promise(done => { resolve = () => done(slice(
            request,
            [interaction('late')],
            { complete: true }
        )); })
    );
    index.invalidate('claude:s1');
    resolve();
    assert.equal(await pending, undefined);
    assert.equal(index.state('claude:s1'), undefined);

    const controller = new ConversationAbortController();
    const aborted = index.advance('claude:s2', source, async request => {
        controller.abort();
        return slice(request, [interaction('aborted')], { complete: true });
    }, controller.signal);
    assert.equal(await aborted, undefined);
    assert.deepEqual(index.state('claude:s2').interactions, []);
});

test('CONVERSATION-HISTORY-INDEX-003 a replacement source wins over an older in-flight epoch', async () => {
    const index = new ConversationHistoryIndex();
    let resolve;
    const old = index.advance('kimi:s1', source, async request =>
        new Promise(done => { resolve = () => done(slice(
            request,
            [interaction('old')],
            { complete: true }
        )); })
    );
    const replacement = {
        ...source,
        sourceIdentity: 'source-b',
        sourceSize: 120,
        sourceRevision: 'r2',
    };
    const current = await index.advance('kimi:s1', replacement, async request =>
        slice(request, [interaction('new')], { complete: true })
    );
    resolve();
    assert.equal(await old, undefined);
    assert.deepEqual(current.interactions.map(item => item.id), ['new']);
    assert.deepEqual(index.state('kimi:s1').interactions.map(item => item.id), ['new']);
});

test('CONVERSATION-HISTORY-INDEX-004 capacity never publishes a non-contiguous paging source', async () => {
    const index = new ConversationHistoryIndex();
    const interactions = Array.from({ length: 10_001 }, (_, index) =>
        interaction(`turn-${index}`));
    const state = await index.advance('kimi:bounded', source, async request =>
        slice(request, interactions, { complete: true })
    );
    assert.equal(state.complete, false);
    assert.equal(state.saturated, true);
    assert.deepEqual(state.interactions, []);

    let called = false;
    const repeated = await index.advance('kimi:bounded', source, async () => {
        called = true;
        throw new Error('a saturated index must not retry its dropped slice');
    });
    assert.equal(called, false);
    assert.equal(repeated.saturated, true);
});

test('CONVERSATION-HISTORY-INDEX-008 exposes completed data without cloning and releases unusable payloads', async () => {
    const index = new ConversationHistoryIndex();
    await index.advance('kimi:complete', source, async request =>
        slice(request, [interaction('complete')], { complete: true })
    );
    assert.deepEqual(index.status('kimi:complete'), {
        sourceRevision: 'r1',
        complete: true,
        saturated: false,
        blocked: false,
    });
    assert.deepEqual(index.completedInteractions('kimi:complete', 'r1')
        .map(item => item.id), ['complete']);
    assert.equal(index.completedInteractions('kimi:complete', 'r2'), undefined);

    const blocked = await index.advance('kimi:blocked-payload', source, async request => ({
        ...request,
        interactions: [],
        complete: false,
        blocked: true,
    }));
    assert.deepEqual(blocked.interactions, []);
    assert.deepEqual(blocked.prefixSegments, []);
});

test('CONVERSATION-HISTORY-INDEX-005 a proven append replays only from the last safe boundary', async () => {
    const index = new ConversationHistoryIndex();
    const first = await index.advance('kimi:append', source, async request =>
        ({
            ...slice(request, [interaction('old-prefix')], { nextOffset: 80 }),
            restartInteractionId: 'old-tail',
            restartRecordEndOffset: 90,
            restartRecordDigest: 'record-old-tail',
            restartSegmentDigest: 'segment-old-prefix',
        })
    );
    assert.equal(first.restartOffset, 80);
    assert.deepEqual(first.prefixSegments, [{
        startOffset: 0,
        endOffset: 80,
        digest: 'segment-old-prefix',
    }]);
    const complete = await index.advance('kimi:append', source, async request =>
        slice(request, [interaction('old-tail')], { complete: true })
    );
    assert.equal(complete.complete, true);
    const appended = {
        ...source,
        sourceIdentity: 'source-a-appended',
        sourceSize: 120,
        sourceRevision: 'r2',
        sourceLastHash: 'last-b',
        continuationOf: {
            sourceIdentity: source.sourceIdentity,
            sourceSize: source.sourceSize,
            sourceRevision: source.sourceRevision,
            reducerVersion: 1,
        },
    };
    const resumed = await index.advance('kimi:append', appended, async request => {
        assert.equal(request.startOffset, 80);
        return slice(request, [interaction('new-tail')], { complete: true });
    });
    assert.deepEqual(resumed.interactions.map(item => item.id), [
        'old-prefix', 'new-tail',
    ]);
    assert.equal(resumed.complete, true);
});

test('CONVERSATION-HISTORY-INDEX-007 refuses a slice without a whole-prefix segment proof', async () => {
    const index = new ConversationHistoryIndex();
    const state = await index.advance('kimi:unproven', source, async request => ({
        ...slice(request, [interaction('unproven')], { nextOffset: 40 }),
        restartInteractionId: 'tail',
        restartRecordEndOffset: 50,
        restartRecordDigest: 'tail-record',
    }));
    assert.equal(state, undefined);
    assert.deepEqual(index.state('kimi:unproven').interactions, []);

    const unprovenComplete = await index.advance(
        'kimi:unproven-complete',
        source,
        async request => ({
            ...request,
            interactions: [interaction('unproven-complete')],
            complete: true,
        })
    );
    assert.equal(unprovenComplete, undefined);
    assert.deepEqual(index.state('kimi:unproven-complete').interactions, []);
});

test('CONVERSATION-HISTORY-INDEX-006 a range without a safe boundary stays blocked', async () => {
    const index = new ConversationHistoryIndex();
    const state = await index.advance('claude:blocked', source, async request => ({
        ...request,
        interactions: [],
        complete: false,
        blocked: true,
    }));
    assert.equal(state.blocked, true);
    assert.equal(state.complete, false);
});
