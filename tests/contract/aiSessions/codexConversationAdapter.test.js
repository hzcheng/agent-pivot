'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    CodexConversationAdapter,
} = require('../../../out/aiSessions/conversation/codexAdapter');
const {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationAbortError,
    ConversationError,
} = require('../../../out/aiSessions/conversation/types');

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/conversations/codex/thread-read.json'
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const timedFixture = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '../../fixtures/conversations/codex/thread-read-timed.json'
), 'utf8'));
const sessionId = '33333333-3333-4333-8333-333333333333';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createAdapter(result = fixture, overrides = {}) {
    const requests = [];
    let clientDisposeCount = 0;
    const client = overrides.client || {
        async request(method, params, signal) {
            requests.push({ method, params, signal });
            return typeof result === 'function' ? result() : result;
        },
        dispose() {
            clientDisposeCount += 1;
        },
    };
    const adapter = new CodexConversationAdapter({
        client,
        watchSessionChanges: overrides.watchSessionChanges
            || (() => ({ dispose() {} })),
        setTimeout: overrides.setTimeout || (callback => {
            callback();
            return 1;
        }),
        clearTimeout: overrides.clearTimeout || (() => undefined),
        resolveWorktree: overrides.resolveWorktree,
        readRolloutTelemetry: overrides.readRolloutTelemetry,
        readLifecycleSignal: overrides.readLifecycleSignal,
        readContentSignature: overrides.readContentSignature,
        readSourceBytes: overrides.readSourceBytes,
        listSubagentThreads: overrides.listSubagentThreads,
        getSessionProfileContextWindow: overrides.getSessionProfileContextWindow,
        now: overrides.now,
    });
    return {
        adapter,
        requests,
        getClientDisposeCount: () => clientDisposeCount,
    };
}

function createLargeThread(threadId = sessionId) {
    return {
        thread: {
            id: threadId,
            turns: Array.from({ length: 12 }, (_, index) => ({
                id: `turn-${index}`,
                status: 'completed',
                items: [{
                    id: `user-${index}`,
                    type: 'userMessage',
                    content: [{ type: 'text', text: `request ${index}` }],
                }, {
                    id: `agent-${index}`,
                    type: 'agentMessage',
                    text: 'x'.repeat(60 * 1024),
                }],
            })),
        },
    };
}

test('CONVERSATION-WORKING-INDICATOR-001 Codex rollout lifecycle promotes an externally running interrupted turn', async t => {
    const interrupted = clone(fixture);
    interrupted.thread.turns.at(-1).status = 'interrupted';
    let executionState = 'running';
    const harness = createAdapter(interrupted, {
        readLifecycleSignal: () => ({
            token: `codex:lifecycle:1:${executionState}`,
            phase: executionState === 'running' ? 'running' : 'idle',
            executionState,
            occurredAtMs: 1,
        }),
    });
    t.after(() => harness.adapter.dispose());

    const { outline, page } = await readWholeConversation(harness.adapter);

    assert.equal(outline.interactions.at(-1).responseState, 'inProgress');
    assert.equal(
        page.interactionStates.at(-1).responseState,
        'inProgress'
    );

    executionState = 'stopped';
    const stopped = await harness.adapter.readOutline(sessionId);
    assert.equal(stopped.interactions.at(-1).responseState, 'interrupted');
    assert.equal(stopped.sourceRevision, outline.sourceRevision);
});

async function readWholeConversation(adapter) {
    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
    });
    return { outline, page };
}

test('CONVERSATION-WORKLOG-COLLAPSE-001 Codex preserves app-server turn timing for the Worked-for row', async t => {
    const harness = createAdapter(timedFixture);
    t.after(() => harness.adapter.dispose());

    const { outline, page } = await readWholeConversation(harness.adapter);

    assert.equal(outline.interactions[0].timestamp, 1_786_113_121_000);
    assert.deepEqual(page.interactionStates[0], {
        interactionId: 'user-timed',
        responseState: 'complete',
        timestamp: 1_786_113_121_000,
        completedAt: 1_786_113_197_803,
    });
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 Codex falls back to completedAt and times only the first visible input in a turn', async t => {
    const result = clone(timedFixture);
    const turn = result.thread.turns[0];
    turn.startedAt = 1_000.125;
    turn.completedAt = 1_002.75;
    turn.durationMs = -1;
    turn.items.splice(1, 0, {
        id: 'user-timed-second',
        type: 'userMessage',
        content: [{ type: 'text', text: 'A second visible input' }],
    });
    const harness = createAdapter(result);
    t.after(() => harness.adapter.dispose());

    const { page } = await readWholeConversation(harness.adapter);

    assert.deepEqual(page.interactionStates, [
        {
            interactionId: 'user-timed',
            responseState: 'complete',
            timestamp: 1_000_125,
            completedAt: 1_002_750,
        },
        {
            interactionId: 'user-timed-second',
            responseState: 'complete',
        },
    ]);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 Codex sums timed subagent turns into one dispatch duration', async t => {
    const result = createThreadReadResult(childThreadId, sessionId, {
        turns: [
            {
                id: 'turn-timed-1',
                status: 'completed',
                startedAt: 1_700_000_010,
                completedAt: 1_700_000_020,
                durationMs: 10_000,
                items: [{
                    id: 'agent-timed-1',
                    type: 'agentMessage',
                    text: 'First timed result',
                }],
            },
            {
                id: 'turn-timed-2',
                status: 'completed',
                startedAt: 1_700_000_100,
                completedAt: 1_700_000_120,
                durationMs: 20_000,
                items: [{
                    id: 'agent-timed-2',
                    type: 'agentMessage',
                    text: 'Second timed result',
                }],
            },
        ],
    });
    const harness = createAdapter(result);
    t.after(() => harness.adapter.dispose());
    const encodedId = `${sessionId}#agent:${childThreadId}`;

    const outline = await harness.adapter.readOutline(encodedId);
    const page = await harness.adapter.readPage({
        provider: 'codex',
        sessionId: encodedId,
        anchorInteractionId: `${childThreadId}-dispatch`,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });

    assert.deepEqual(page.interactionStates, [{
        interactionId: `${childThreadId}-dispatch`,
        responseState: 'complete',
        timestamp: 1_700_000_000_000,
        completedAt: 1_700_000_030_000,
    }]);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 Codex never reports a partial subagent duration as the total', async t => {
    const timedTurn = {
        id: 'turn-valid',
        status: 'completed',
        startedAt: 1_700_000_100,
        durationMs: 20_000,
        items: [{
            id: 'agent-valid',
            type: 'agentMessage',
            text: 'Timed result',
        }],
    };
    const untimedTurn = {
        id: 'turn-untimed',
        status: 'completed',
        items: [{
            id: 'agent-untimed',
            type: 'agentMessage',
            text: 'Untimed result',
        }],
    };
    const cases = [
        ['untimed then timed', [untimedTurn, timedTurn]],
        ['timed then untimed', [timedTurn, untimedTurn]],
        ['overflow', [{
            ...timedTurn,
            id: 'turn-overflow',
            durationMs: Number.MAX_SAFE_INTEGER,
        }]],
    ];

    for (const [name, turns] of cases) {
        await t.test(name, async subtest => {
            const result = createThreadReadResult(childThreadId, sessionId, {
                turns: clone(turns),
            });
            const harness = createAdapter(result);
            subtest.after(() => harness.adapter.dispose());
            const encodedId = `${sessionId}#agent:${childThreadId}`;
            const outline = await harness.adapter.readOutline(encodedId);
            const page = await harness.adapter.readPage({
                provider: 'codex',
                sessionId: encodedId,
                anchorInteractionId: `${childThreadId}-dispatch`,
                direction: 'around',
                expectedRevision: outline.sourceRevision,
            });

            assert.equal(page.interactionStates[0].completedAt, undefined);
        });
    }
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 Codex returns one correlated outline and page from one provider read', async t => {
    const harness = createAdapter();
    t.after(() => harness.adapter.dispose());

    const snapshot = await harness.adapter.readSnapshot(sessionId);

    assert.equal(harness.requests.length, 1);
    assert.equal(snapshot.page.sourceRevision, snapshot.outline.sourceRevision);
    assert.equal(
        snapshot.page.anchorInteractionId,
        snapshot.outline.interactions.at(-1).id
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 serves a large Codex thread from cache while its rollout stat is unchanged', async t => {
    const large = createLargeThread();
    let signature = 'stat-1';
    const probedIds = [];
    const harness = createAdapter(large, {
        readContentSignature: id => {
            probedIds.push(id);
            return signature;
        },
    });
    t.after(() => harness.adapter.dispose());

    const first = await harness.adapter.readOutline(sessionId);
    const cached = await harness.adapter.readOutline(sessionId);
    assert.equal(cached.sourceRevision, first.sourceRevision);
    assert.equal(harness.requests.length, 1);
    assert.ok(probedIds.length > 0
        && probedIds.every(id => id === sessionId));

    // There is no expiry: an unchanged rollout stat keeps the normalized
    // conversation authoritative indefinitely. The harness timer fires
    // synchronously, so any scheduled expiry would have run by now.
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);

    // A changed rollout stat forces the next read back to the provider.
    signature = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 invalidates a large Codex thread before publishing a provider change', async t => {
    const large = createLargeThread();
    let current = large;
    let signature = 'stat-1';
    let providerCallback;
    const harness = createAdapter(() => current, {
        readContentSignature: () => signature,
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() {} };
        },
    });
    t.after(() => harness.adapter.dispose());
    const subscription = harness.adapter.watch(sessionId, () => undefined);
    t.after(() => subscription.dispose());

    const first = await harness.adapter.readOutline(sessionId);
    current = clone(large);
    current.thread.turns.at(-1).items.at(-1).text =
        `${'x'.repeat(60 * 1024)} changed`;
    signature = 'stat-2';
    providerCallback();
    const updated = await harness.adapter.readOutline(sessionId);

    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps stat-validated large Codex cache entries across provider invalidations', async t => {
    const large = createLargeThread();
    let signature = 'stat-1';
    let providerCallback;
    let debounceCallback;
    const harness = createAdapter(() => large, {
        readContentSignature: () => signature,
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() {} };
        },
        setTimeout(callback) {
            debounceCallback = callback;
            return 7;
        },
    });
    t.after(() => harness.adapter.dispose());
    const subscription = harness.adapter.watch(sessionId, () => undefined);
    t.after(() => subscription.dispose());

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    // Provider invalidations no longer discard entries: while the rollout
    // stat is unchanged, the cached normalized conversation stays
    // authoritative, so back-to-back reads (switch, revalidation, warmup)
    // share one thread/read across the whole invalidation cycle.
    providerCallback();
    await harness.adapter.readOutline(sessionId);
    debounceCallback();
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);

    // A changed rollout stat is what actually forces a fresh thread/read.
    signature = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 retains stat-validated large Codex cache entries when the watch is released', async t => {
    const large = createLargeThread();
    let signature = 'stat-1';
    let providerCallback;
    const harness = createAdapter(() => large, {
        readContentSignature: () => signature,
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() {} };
        },
        setTimeout() {
            return 7;
        },
    });
    t.after(() => harness.adapter.dispose());
    const subscription = harness.adapter.watch(sessionId, () => undefined);

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    providerCallback();
    // Releasing the last subscription cancels the pending debounce; the
    // invalidation still lands (guarding in-flight reads), but the
    // stat-validated entry survives.
    subscription.dispose();
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);

    signature = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 bypasses the large Codex cache while the rollout stat is unreadable', async t => {
    const unreadable = createAdapter(createLargeThread(), {
        readContentSignature: () => undefined,
    });
    t.after(() => unreadable.adapter.dispose());

    await unreadable.adapter.readOutline(sessionId);
    await unreadable.adapter.readOutline(sessionId);
    assert.equal(unreadable.requests.length, 2);
    assert.equal(unreadable.adapter.loadedConversationCache.size, 0);

    // A failing probe must never break or poison a read either.
    const throwing = createAdapter(createLargeThread(), {
        readContentSignature() {
            throw new Error('stat gone');
        },
    });
    t.after(() => throwing.adapter.dispose());

    await throwing.adapter.readOutline(sessionId);
    await throwing.adapter.readOutline(sessionId);
    assert.equal(throwing.requests.length, 2);
    assert.equal(throwing.adapter.loadedConversationCache.size, 0);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 bounds the stat-validated large Codex cache to two entries', async t => {
    const ids = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ];
    const requests = [];
    const harness = createAdapter(undefined, {
        client: {
            async request(method, params) {
                requests.push({ method, params });
                return createLargeThread(params.threadId);
            },
            dispose() {},
        },
        readContentSignature: id => `stat-${id}`,
    });
    t.after(() => harness.adapter.dispose());

    for (const id of ids) {
        await harness.adapter.readOutline(id);
    }
    assert.equal(harness.adapter.loadedConversationCache.size, 2);
    assert.deepEqual(
        [...harness.adapter.loadedConversationCache.keys()],
        ids.slice(1)
    );

    await harness.adapter.readOutline(ids[1]);
    assert.equal(requests.length, 3,
        'a stat-validated hit skips the provider entirely');
    await harness.adapter.readOutline(ids[0]);
    assert.equal(requests.length, 4,
        'the evicted oldest entry reads from the provider again');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 releases a large Codex cache entry as soon as its rollout stat moves on', async t => {
    const large = createLargeThread();
    let signature = 'stat-1';
    const harness = createAdapter(() => large, {
        readContentSignature: () => signature,
    });
    t.after(() => harness.adapter.dispose());

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    // A changed stat releases the stale entry immediately rather than
    // letting it linger next to its fresh replacement.
    signature = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    // An unreadable stat releases it too: the entry can no longer prove
    // its content is current, and the bypassed read leaves nothing behind.
    signature = undefined;
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 3);
    assert.equal(harness.adapter.loadedConversationCache.size, 0);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 caches a Codex conversation whose read was expensive even when its visible text is small', async t => {
    // Many tool records with little visible text stay below the 512KiB
    // character gate, yet each thread/read still costs real transfer and
    // normalize time: a slow read is eligibility enough.
    const smallButSlow = {
        thread: {
            id: sessionId,
            turns: [{
                id: 'turn-1',
                status: 'completed',
                items: [{
                    id: 'user-1',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'request' }],
                }, {
                    id: 'agent-1',
                    type: 'agentMessage',
                    text: 'short answer',
                }],
            }],
        },
    };
    let now = 1_000;
    const requests = [];
    const harness = createAdapter(smallButSlow, {
        client: {
            async request(method, params) {
                requests.push({ method, params });
                now += 400;
                return clone(smallButSlow);
            },
            dispose() {},
        },
        readContentSignature: () => 'stat-1',
        now: () => now,
    });
    t.after(() => harness.adapter.dispose());

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.adapter.loadedConversationCache.size, 1,
        'a >=100ms read is cached even below the character gate');
    await harness.adapter.readOutline(sessionId);
    assert.equal(requests.length, 1);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 evicts a large Codex cache entry after ten idle minutes', async t => {
    const large = createLargeThread();
    let now = 1_000_000;
    const harness = createAdapter(() => large, {
        readContentSignature: () => 'stat-1',
        now: () => now,
    });
    t.after(() => harness.adapter.dispose());

    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.adapter.loadedConversationCache.size, 1);

    // Repeated use keeps the entry alive.
    now += 9 * 60 * 1000;
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);

    // Ten idle minutes release it; the next read pays a fresh thread/read.
    now += 10 * 60 * 1000 + 1;
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 bounds the total cached Codex conversation characters', async t => {
    // Two ~4.3M-character conversations fit the entry count but not the
    // total byte budget: caching the second evicts the first.
    const bigThread = threadId => ({
        thread: {
            id: threadId,
            turns: Array.from({ length: 72 }, (_unused, index) => ({
                id: `turn-${index}`,
                status: 'completed',
                items: [{
                    id: `user-${index}`,
                    type: 'userMessage',
                    content: [{ type: 'text', text: `request ${index}` }],
                }, {
                    id: `agent-${index}`,
                    type: 'agentMessage',
                    text: 'x'.repeat(60 * 1024),
                }],
            })),
        },
    });
    const ids = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    const requests = [];
    const harness = createAdapter(undefined, {
        client: {
            async request(method, params) {
                requests.push({ method, params });
                return bigThread(params.threadId);
            },
            dispose() {},
        },
        readContentSignature: id => `stat-${id}`,
    });
    t.after(() => harness.adapter.dispose());

    await harness.adapter.readOutline(ids[0]);
    await harness.adapter.readOutline(ids[1]);
    assert.equal(harness.adapter.loadedConversationCache.size, 1,
        'the byte budget evicts the older entry even below the count cap');
    assert.deepEqual(
        [...harness.adapter.loadedConversationCache.keys()],
        [ids[1]]
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 does not cache a large Codex read invalidated while pending', async t => {
    const large = createLargeThread();
    let resolveRead;
    let providerCallback;
    const harness = createAdapter(large, {
        client: {
            request() {
                return new Promise(resolve => {
                    resolveRead = resolve;
                });
            },
            dispose() {},
        },
        readContentSignature: () => 'stat-1',
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() {} };
        },
    });
    t.after(() => harness.adapter.dispose());
    const subscription = harness.adapter.watch(sessionId, () => undefined);
    t.after(() => subscription.dispose());

    const pending = harness.adapter.readOutline(sessionId);
    providerCallback();
    // The read reaches the provider asynchronously (cold-start probing may
    // add microtasks before the first request); wait for it to start.
    while (!resolveRead) {
        await new Promise(resolve => setImmediate(resolve));
    }
    resolveRead(large);
    await pending;

    assert.equal(harness.adapter.loadedConversationCache.size, 0);
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Codex normalizes only stable visible user and agent items', async t => {
    const harness = createAdapter();
    t.after(() => harness.adapter.dispose());
    const { outline, page } = await readWholeConversation(harness.adapter);

    assert.deepEqual(outline.interactions.map(item => item.id), [
        'user-item-1',
        'user-item-2',
        'user-item-3',
    ]);
    assert.deepEqual(outline.interactions.map(item => item.providerTurnId), [
        'turn-1',
        'turn-1',
        'turn-2',
    ]);
    assert.deepEqual(outline.interactions.map(item => item.responseState), [
        'complete',
        'complete',
        'inProgress',
    ]);
    assert.deepEqual(
        page.messages.filter(message =>
            message.role === 'progress' || message.role === 'assistant'
        )
            .map(message => [message.interactionId, message.markdown]),
        [
            ['user-item-1', 'Visible response'],
            ['user-item-2', 'Second visible response'],
            ['user-item-3', 'Streaming visible response'],
        ]
    );
    assert.deepEqual(
        page.messages.filter(message => message.role === 'thinking')
            .map(message => [message.interactionId, message.thinking.text]),
        [[
            'user-item-1',
            'Inspect the request.\n\nChoose a safe response.',
        ]]
    );
    assert.deepEqual(
        page.messages.filter(message =>
            message.interactionId === 'user-item-1'
        ).map(message => message.role),
        ['user', 'thinking', 'progress', 'tool', 'tool', 'plan']
    );
    assert.deepEqual(
        page.messages.filter(message => message.role === 'plan')
            .map(message => [
                message.interactionId,
                message.plan.markdown,
            ]),
        [[
            'user-item-1',
            '1. Inspect the request\n2. Choose a safe response',
        ]]
    );
    assert.equal(JSON.stringify(page).includes('raw-reasoning-secret'), false);
    assert.equal(
        JSON.stringify(page).includes('legacy-reasoning-secret'),
        false
    );
    assert.deepEqual(
        page.messages.filter(message => message.role === 'tool')
            .map(message => [
                message.interactionId,
                message.tool.name,
                message.tool.summary,
                message.tool.detail,
            ]),
        [
            ['user-item-1', 'commandExecution', 'commandExecution print-secret', 'command-output'],
            ['user-item-1', 'fileChange', 'fileChange update /private/changed-file.txt', undefined],
        ]
    );
    assert.equal(JSON.stringify(page).includes('mcp-secret'), false);
    assert.equal(JSON.stringify(page).includes('dynamic-secret'), false);
    assert.equal(JSON.stringify(page).includes('collab-secret'), false);
    assert.equal(JSON.stringify(page).includes('subagent-secret'), false);
    assert.equal(
        JSON.stringify(page).includes('/private/local-image.png'),
        false
    );
    assert.equal(JSON.stringify(page).includes('unknown-input-secret'), false);
    assert.match(page.messages[0].markdown, /\[Attachment\]/);
    assert.match(
        page.messages.find(message =>
            message.interactionId === 'user-item-2'
            && message.role === 'user'
        ).markdown,
        /Inspect these \[3 Attachments\] and summarize/
    );
    assert.deepEqual(harness.requests.map(request => ({
        method: request.method,
        params: request.params,
    })), [
        {
            method: 'thread/read',
            params: { threadId: sessionId, includeTurns: true },
        },
        {
            method: 'thread/read',
            params: { threadId: sessionId, includeTurns: true },
        },
    ]);
    assert.equal(outline.sourceRevision, page.sourceRevision);
});

test('CONVERSATION-DIFF-VISIBILITY-001 Codex renders every changed file with parsed diffs and keeps unparseable payloads raw', async t => {
    const result = {
        thread: {
            id: sessionId,
            turns: [{
                id: 'turn-1',
                status: 'completed',
                items: [
                    {
                        id: 'user-1',
                        type: 'userMessage',
                        content: [{ type: 'text', text: 'apply the patch' }],
                    },
                    {
                        id: 'file-1',
                        type: 'fileChange',
                        changes: [
                            {
                                path: 'src/a.ts',
                                kind: 'update',
                                diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context',
                            },
                            { path: 'src/b.ts', kind: { type: 'add' } },
                            { path: 'src/c.ts', kind: 'update', diff: 'not a diff at all' },
                        ],
                    },
                    { id: 'agent-1', type: 'agentMessage', text: 'Applied.' },
                ],
            }],
        },
    };
    const harness = createAdapter(result);
    t.after(() => harness.adapter.dispose());

    const { page } = await readWholeConversation(harness.adapter);
    const tool = page.messages.find(message => message.role === 'tool');
    assert.equal(tool.tool.name, 'fileChange');
    assert.equal(
        tool.tool.summary,
        'fileChange update src/a.ts (+2 more)'
    );
    assert.deepEqual(tool.tool.diffs, [
        {
            path: 'src/a.ts',
            kind: 'update',
            additions: 1,
            deletions: 1,
            hunks: [{
                oldStart: 1,
                newStart: 1,
                lines: [
                    { type: 'del', text: 'old' },
                    { type: 'add', text: 'new' },
                    { type: 'context', text: 'context' },
                ],
            }],
        },
        {
            path: 'src/b.ts',
            kind: 'add',
            additions: 0,
            deletions: 0,
            hunks: [],
        },
    ]);
    assert.equal(tool.tool.detail, 'not a diff at all');
});

test('CONVERSATION-TELEMETRY-001 reads model, context, and quota windows from Codex rollout and protocol data', async t => {
    const harness = createAdapter(fixture, {
        client: {
            async request(method) {
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return {
                    rateLimits: {
                        limitId: 'codex',
                        primary: {
                            usedPercent: 25,
                            windowDurationMins: 300,
                            resetsAt: 2_000_000_000,
                        },
                        secondary: {
                            usedPercent: 40,
                            windowDurationMins: 10_080,
                            resetsAt: 2_000_100_000,
                        },
                    },
                    rateLimitsByLimitId: null,
                };
            },
            dispose() {},
        },
        readRolloutTelemetry: () => ({
            model: 'gpt-5.6-sol',
            context: {
                usedTokens: 32_000,
                maxTokens: 128_000,
            },
        }),
    });
    t.after(() => harness.adapter.dispose());

    assert.deepEqual(await harness.adapter.readTelemetry(sessionId), {
        provider: 'codex',
        sessionId,
        model: 'gpt-5.6-sol',
        context: {
            usedTokens: 32_000,
            maxTokens: 128_000,
        },
        rateLimits: [{
            id: 'codex:primary',
            label: '5h',
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 2_000_000_000,
        }, {
            id: 'codex:secondary',
            label: 'Week',
            usedPercent: 40,
            windowDurationMins: 10_080,
            resetsAt: 2_000_100_000,
        }],
    });
});

test('CONVERSATION-TELEMETRY-001 keeps live branch and context telemetry without resuming an active-writer thread', async t => {
    const requests = [];
    const harness = createAdapter(fixture, {
        client: {
            async request(method, params) {
                requests.push([method, params]);
                if (method === 'thread/read') {
                    return { thread: { cwd: '/launch/repo' } };
                }
                if (method === 'account/rateLimits/read') {
                    return { rateLimits: null, rateLimitsByLimitId: null };
                }
                if (method === 'thread/resume') {
                    throw new Error(`thread ${sessionId} already has an active writer`);
                }
                throw new Error(`unexpected method ${method}`);
            },
            dispose() {},
        },
        readRolloutTelemetry: () => ({
            model: 'gpt-5.6-sol',
            context: {
                usedTokens: 54_297,
                maxTokens: 258_400,
            },
        }),
        resolveWorktree: async candidate => candidate === '/launch/repo'
            ? {
                branch: 'main',
                worktreeRoot: candidate,
                repoRoot: candidate,
            }
            : undefined,
    });
    t.after(() => harness.adapter.dispose());

    assert.deepEqual(await harness.adapter.readTelemetry(sessionId), {
        provider: 'codex',
        sessionId,
        model: 'gpt-5.6-sol',
        context: {
            usedTokens: 54_297,
            maxTokens: 258_400,
        },
        worktree: {
            branch: 'main',
            worktreeRoot: '/launch/repo',
            repoRoot: '/launch/repo',
        },
        rateLimits: [],
    });
    assert.deepEqual(requests, [[
        'thread/read',
        { threadId: sessionId, includeTurns: false },
    ], [
        'account/rateLimits/read',
        undefined,
    ]]);
});

test('CONVERSATION-TELEMETRY-001 prefers the canonical Codex quota over same-window named limits', async t => {
    const canonical = {
        limitId: 'codex',
        primary: {
            usedPercent: 73,
            windowDurationMins: 10_080,
            resetsAt: 2_000_000_000,
        },
        secondary: null,
    };
    const harness = createAdapter(fixture, {
        client: {
            async request(method) {
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return {
                    rateLimits: canonical,
                    rateLimitsByLimitId: {
                        codex_bengalfox: {
                            limitId: 'codex_bengalfox',
                            limitName: 'GPT-5.3-Codex-Spark',
                            primary: {
                                usedPercent: 0,
                                windowDurationMins: 10_080,
                                resetsAt: 2_100_000_000,
                            },
                            secondary: null,
                        },
                        codex: canonical,
                    },
                };
            },
            dispose() {},
        },
    });
    t.after(() => harness.adapter.dispose());

    const telemetry = await harness.adapter.readTelemetry(sessionId);

    assert.deepEqual(telemetry.rateLimits, [{
        id: 'codex:primary',
        label: 'Week',
        usedPercent: 73,
        windowDurationMins: 10_080,
        resetsAt: 2_000_000_000,
    }]);
});

test('CONVERSATION-TELEMETRY-001 refreshes cached model and context from the newest rollout tail', async t => {
    let rollout = {
        model: 'gpt-5.5',
        context: { usedTokens: 12_000, maxTokens: 128_000 },
    };
    let requestCount = 0;
    const harness = createAdapter(fixture, {
        client: {
            async request(method) {
                requestCount += 1;
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return { rateLimits: null, rateLimitsByLimitId: null };
            },
            dispose() {},
        },
        readRolloutTelemetry: () => rollout,
    });
    t.after(() => harness.adapter.dispose());

    const initial = await harness.adapter.readTelemetry(sessionId);
    assert.equal(initial.model, 'gpt-5.5');
    assert.deepEqual(initial.context, {
        usedTokens: 12_000,
        maxTokens: 128_000,
    });

    rollout = {
        model: 'gpt-5.6-sol',
        context: { usedTokens: 48_000, maxTokens: 258_400 },
    };
    const refreshed = await harness.adapter.readTelemetry(sessionId);

    assert.equal(refreshed.model, 'gpt-5.6-sol');
    assert.deepEqual(refreshed.context, {
        usedTokens: 48_000,
        maxTokens: 258_400,
    });
    assert.equal(requestCount, 2,
        'rollout-only refreshes must reuse cached app-server telemetry');
});

test('CONVERSATION-TELEMETRY-001 keeps an observed token notification when the rollout tail is unavailable', async t => {
    let notificationListener;
    const harness = createAdapter(fixture, {
        client: {
            watchNotifications(listener) {
                notificationListener = listener;
                return { dispose() {} };
            },
            async request(method) {
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return { rateLimits: null, rateLimitsByLimitId: null };
            },
            dispose() {},
        },
    });
    t.after(() => harness.adapter.dispose());

    notificationListener('thread/tokenUsage/updated', {
        threadId: sessionId,
        tokenUsage: {
            last: { totalTokens: 33_000 },
            modelContextWindow: 128_000,
        },
    });

    const telemetry = await harness.adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.context, {
        usedTokens: 33_000,
        maxTokens: 128_000,
    });
});

test('CONVERSATION-TELEMETRY-001 a declared profile context window overrides the under-reported server window', async t => {
    const harness = createAdapter(fixture, {
        readRolloutTelemetry: () => ({
            model: 'codewiz:deepseek-pro',
            context: { usedTokens: 48_000, maxTokens: 258_400 },
        }),
        getSessionProfileContextWindow: id => id === sessionId ? 1_000_000 : undefined,
    });
    t.after(() => harness.adapter.dispose());

    const telemetry = await harness.adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.context, {
        usedTokens: 48_000,
        maxTokens: 1_000_000,
    }, 'the profile-declared window replaces the server default for custom models');
    assert.equal(telemetry.model, 'codewiz:deepseek-pro');
});

test('CONVERSATION-TELEMETRY-001 the profile window also overrides live token notifications', async t => {
    let notificationListener;
    const harness = createAdapter(fixture, {
        client: {
            watchNotifications(listener) {
                notificationListener = listener;
                return { dispose() {} };
            },
            async request(method) {
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return { rateLimits: null, rateLimitsByLimitId: null };
            },
            dispose() {},
        },
        getSessionProfileContextWindow: () => 1_000_000,
    });
    t.after(() => harness.adapter.dispose());

    notificationListener('thread/tokenUsage/updated', {
        threadId: sessionId,
        tokenUsage: {
            last: { totalTokens: 33_000 },
            modelContextWindow: 258_400,
        },
    });

    const telemetry = await harness.adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.context, {
        usedTokens: 33_000,
        maxTokens: 1_000_000,
    }, 'a live notification must not revert the display to the server default');
});

test('CONVERSATION-TELEMETRY-001 without a valid declared window the server report stands', async t => {
    for (const override of [undefined, 0, -5, 1.5, Number.NaN]) {
        const harness = createAdapter(fixture, {
            readRolloutTelemetry: () => ({
                context: { usedTokens: 48_000, maxTokens: 258_400 },
            }),
            getSessionProfileContextWindow: () => override,
        });
        t.after(() => harness.adapter.dispose());

        const telemetry = await harness.adapter.readTelemetry(sessionId);
        assert.deepEqual(telemetry.context, {
            usedTokens: 48_000,
            maxTokens: 258_400,
        }, `override ${String(override)} must not touch the server value`);
    }
});

test('CONVERSATION-TELEMETRY-001 isolates rollout telemetry reads by session', async t => {
    const secondSessionId = '44444444-4444-4444-8444-444444444444';
    const harness = createAdapter(fixture, {
        client: {
            async request(method) {
                if (method === 'thread/read') {
                    return { thread: { cwd: '/repo' } };
                }
                assert.equal(method, 'account/rateLimits/read');
                return { rateLimits: null, rateLimitsByLimitId: null };
            },
            dispose() {},
        },
        readRolloutTelemetry: id => ({
            model: `model-${id}`,
            context: {
                usedTokens: id === sessionId ? 11_000 : 22_000,
                maxTokens: 64_000,
            },
        }),
    });
    t.after(() => harness.adapter.dispose());

    const [first, second] = await Promise.all([
        harness.adapter.readTelemetry(sessionId),
        harness.adapter.readTelemetry(secondSessionId),
    ]);
    assert.equal(first.model, `model-${sessionId}`);
    assert.equal(second.model, `model-${secondSessionId}`);
    assert.equal(first.context.usedTokens, 11_000);
    assert.equal(second.context.usedTokens, 22_000);
});

test('CONVERSATION-TELEMETRY-001 dispose prevents a pending read-only telemetry request from repopulating caches', async () => {
    let resolveThreadRead;
    const harness = createAdapter(fixture, {
        client: {
            async request(method) {
                if (method === 'thread/read') {
                    return new Promise(resolve => {
                        resolveThreadRead = resolve;
                    });
                }
                assert.equal(method, 'account/rateLimits/read');
                return { rateLimits: null, rateLimitsByLimitId: null };
            },
            dispose() {},
        },
        readRolloutTelemetry: () => ({ model: 'gpt-5.6-sol' }),
    });

    const read = harness.adapter.readTelemetry(sessionId);
    await new Promise(resolve => setImmediate(resolve));
    harness.adapter.dispose();
    resolveThreadRead({ thread: { cwd: '/repo' } });
    const telemetry = await read;

    assert.equal(telemetry.model, 'gpt-5.6-sol');
    assert.equal(harness.adapter.telemetryCache.size, 0);
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-002 starts one interaction per userMessage and attaches agents only to the latest qualifying input', async t => {
    const native = {
        thread: {
            id: sessionId,
            turns: [{
                id: 'turn-many-inputs',
                status: 'completed',
                items: [
                    {
                        id: 'orphan-agent',
                        type: 'agentMessage',
                        text: 'must stay hidden',
                    },
                    {
                        id: 'unknown-only-user',
                        type: 'userMessage',
                        content: [{ type: 'futureInput', text: 'hidden' }],
                    },
                    {
                        id: 'first-user',
                        type: 'userMessage',
                        content: [{ type: 'text', text: 'First' }],
                    },
                    {
                        id: 'first-agent',
                        type: 'agentMessage',
                        text: 'First answer',
                    },
                    {
                        id: 'second-user',
                        type: 'userMessage',
                        content: [{ type: 'image', url: 'private.invalid' }],
                    },
                    {
                        id: 'second-agent-a',
                        type: 'agentMessage',
                        text: 'Second answer A',
                    },
                    {
                        id: 'second-agent-b',
                        type: 'agentMessage',
                        text: 'Second answer B',
                    },
                ],
            }],
        },
    };
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const { outline, page } = await readWholeConversation(harness.adapter);

    assert.deepEqual(outline.interactions.map(item => item.id), [
        'first-user',
        'second-user',
    ]);
    assert.deepEqual(page.messages.map(message => [
        message.interactionId,
        message.role,
        message.markdown,
    ]), [
        ['first-user', 'user', 'First'],
        ['first-user', 'assistant', 'First answer'],
        ['second-user', 'user', '[Attachment]'],
        ['second-user', 'assistant', 'Second answer A'],
        ['second-user', 'assistant', 'Second answer B'],
    ]);
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-003 maps completed, active, failed, and cancelled native turn states', async t => {
    const statuses = ['completed', 'active', 'inProgress', 'failed', 'cancelled'];
    const native = {
        thread: {
            id: sessionId,
            turns: statuses.map((status, index) => ({
                id: `turn-${status}`,
                status,
                items: [{
                    id: `user-${index}`,
                    type: 'userMessage',
                    content: [{ type: 'text', text: status }],
                }],
            })),
        },
    };
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const outline = await harness.adapter.readOutline(sessionId);
    assert.deepEqual(
        outline.interactions.map(item => item.responseState),
        ['complete', 'inProgress', 'inProgress', 'interrupted', 'interrupted']
    );
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-004 fails closed on malformed stable protocol shapes without raw leakage', async t => {
    const malformed = [
        {
            name: 'thread id',
            mutate(value) {
                value.thread.id = 'RAW-THREAD-ID-SECRET';
            },
        },
        {
            name: 'turn id',
            mutate(value) {
                value.thread.turns[0].id = 42;
            },
        },
        {
            name: 'turn items',
            mutate(value) {
                value.thread.turns[0].items = {};
            },
        },
        {
            name: 'item id',
            mutate(value) {
                delete value.thread.turns[0].items[0].id;
            },
        },
        {
            name: 'userMessage content',
            mutate(value) {
                value.thread.turns[0].items[0].content = 'RAW-CONTENT-SECRET';
            },
        },
        {
            name: 'text input',
            mutate(value) {
                value.thread.turns[0].items[0].content[0].text = {
                    raw: 'RAW-TEXT-SECRET',
                };
            },
        },
        {
            name: 'agentMessage text',
            mutate(value) {
                value.thread.turns[0].items[2].text = {
                    raw: 'RAW-AGENT-SECRET',
                };
            },
        },
        {
            name: 'remote attachment URL',
            mutate(value) {
                value.thread.turns[0].items[0].content[1].url = {
                    raw: 'RAW-URL-SECRET',
                };
            },
        },
        {
            name: 'local attachment path',
            mutate(value) {
                value.thread.turns[0].items[12].content[1].path = {
                    raw: 'RAW-PATH-SECRET',
                };
            },
        },
    ];
    for (const invalid of malformed) {
        await t.test(invalid.name, async () => {
            const value = clone(fixture);
            invalid.mutate(value);
            const harness = createAdapter(value);
            await assert.rejects(
                harness.adapter.readOutline(sessionId),
                error => error.name === 'ConversationError'
                    && error.code === 'unsupportedVersion'
                    && error.reason === 'unsupportedCodexProtocol'
                    && error.message === 'unsupportedVersion'
                    && !JSON.stringify(error).includes('RAW-')
            );
            harness.adapter.dispose();
        });
    }
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-005 applies shared message and page bounds', async t => {
    const longText = '🙂'.repeat(CONVERSATION_LIMITS.maxMessageGraphemes + 50);
    const native = {
        thread: {
            id: sessionId,
            turns: Array.from({ length: 20 }, (_, index) => ({
                id: `turn-${index}`,
                status: 'completed',
                items: [
                    {
                        id: `user-${index}`,
                        type: 'userMessage',
                        content: [{ type: 'text', text: longText }],
                    },
                    {
                        id: `agent-${index}`,
                        type: 'agentMessage',
                        text: longText,
                    },
                ],
            })),
        },
    };
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const outline = await harness.adapter.readOutline(sessionId);
    const page = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'user-10',
        direction: 'around',
    });

    assert.equal(outline.totalInteractions, 20);
    assert.equal(
        outline.interactions.every(item =>
            item.userGraphemeCount <= CONVERSATION_LIMITS.maxMessageGraphemes
        ),
        true
    );
    assert.equal(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes,
        true
    );
});

test('CONVERSATION-THINKING-VISIBILITY-001 Codex bounds readable reasoning summaries without exposing raw content', async t => {
    const longSummary = '🙂'.repeat(
        CONVERSATION_LIMITS.maxMessageGraphemes + 50
    );
    const native = {
        thread: {
            id: sessionId,
            turns: [{
                id: 'reasoning-turn',
                status: 'completed',
                items: [
                    {
                        id: 'reasoning-user',
                        type: 'userMessage',
                        content: [{ type: 'text', text: 'Explain the change' }],
                    },
                    {
                        id: 'reasoning-item',
                        type: 'reasoning',
                        summary: [longSummary],
                        content: ['RAW-REASONING-CONTENT'],
                        text: 'LEGACY-REASONING-CONTENT',
                    },
                    {
                        id: 'reasoning-answer',
                        type: 'agentMessage',
                        text: 'Visible answer',
                    },
                ],
            }],
        },
    };
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const { page } = await readWholeConversation(harness.adapter);
    const thinking = page.messages.find(message =>
        message.role === 'thinking'
    );

    assert.ok(thinking);
    assert.equal(
        Array.from(thinking.thinking.text).length,
        CONVERSATION_LIMITS.maxMessageGraphemes
    );
    assert.equal(JSON.stringify(page).includes('RAW-REASONING-CONTENT'), false);
    assert.equal(
        JSON.stringify(page).includes('LEGACY-REASONING-CONTENT'),
        false
    );
});

test('CONVERSATION-THINKING-VISIBILITY-001 Codex never falls back to raw reasoning fields when a summary is unavailable', async t => {
    const native = clone(fixture);
    delete native.thread.turns[0].items[1].summary;
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const { page } = await readWholeConversation(harness.adapter);
    const serialized = JSON.stringify(page);

    assert.equal(
        page.messages.some(message => message.role === 'thinking'),
        false
    );
    assert.equal(serialized.includes('raw-reasoning-secret'), false);
    assert.equal(serialized.includes('legacy-reasoning-secret'), false);
});

test('CONVERSATION-PROGRESS-VISIBILITY-001 Codex renders commentary as progress and final answers as assistant output', async t => {
    const native = {
        thread: {
            id: sessionId,
            turns: [{
                id: 'phased-agent-turn',
                status: 'completed',
                items: [
                    {
                        id: 'phased-agent-user',
                        type: 'userMessage',
                        content: [{ type: 'text', text: 'Inspect the failure' }],
                    },
                    {
                        id: 'phased-agent-commentary',
                        type: 'agentMessage',
                        phase: 'commentary',
                        text: 'Comparing the two runs.',
                    },
                    {
                        id: 'phased-agent-answer',
                        type: 'agentMessage',
                        phase: 'final_answer',
                        text: 'The parser dropped the event.',
                    },
                ],
            }],
        },
    };
    const harness = createAdapter(native);
    t.after(() => harness.adapter.dispose());
    const { page } = await readWholeConversation(harness.adapter);

    assert.deepEqual(
        page.messages.map(message => [
            message.role,
            message.markdown,
        ]),
        [
            ['user', 'Inspect the failure'],
            ['progress', 'Comparing the two runs.'],
            ['assistant', 'The parser dropped the event.'],
        ]
    );
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-006 shares the service watcher and disposes lifecycle ownership once', async () => {
    let subscribeCount = 0;
    let providerCallback;
    let providerDisposeCount = 0;
    const harness = createAdapter(fixture, {
        watchSessionChanges(callback) {
            subscribeCount += 1;
            providerCallback = callback;
            return {
                dispose() {
                    providerDisposeCount += 1;
                },
            };
        },
    });
    let firstChanges = 0;
    let secondChanges = 0;
    const first = harness.adapter.watch(sessionId, () => {
        firstChanges += 1;
    });
    const second = harness.adapter.watch(sessionId, () => {
        secondChanges += 1;
    });
    assert.equal(subscribeCount, 1);
    providerCallback();
    assert.deepEqual([firstChanges, secondChanges], [1, 1]);
    first.dispose();
    providerCallback();
    assert.deepEqual([firstChanges, secondChanges], [1, 2]);
    second.dispose();
    assert.equal(providerDisposeCount, 1);
    harness.adapter.dispose();
    harness.adapter.dispose();
    assert.equal(providerDisposeCount, 1);
    assert.equal(harness.getClientDisposeCount(), 1);
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-006 keeps duplicate callback registrations independent', async () => {
    let providerCallback;
    let providerDisposeCount = 0;
    const harness = createAdapter([], {
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    const { adapter } = harness;
    let changes = 0;
    const callback = () => { changes += 1; };
    const first = adapter.watch(sessionId, callback);
    const second = adapter.watch(sessionId, callback);

    providerCallback();
    assert.equal(changes, 2);
    first.dispose();
    providerCallback();
    assert.equal(changes, 3);
    assert.equal(providerDisposeCount, 0);
    second.dispose();
    assert.equal(providerDisposeCount, 1);
    adapter.dispose();
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-006 rolls back a failed provider watch before a clean retry', () => {
    let attempts = 0;
    let providerCallback;
    let providerDisposeCount = 0;
    const harness = createAdapter([], {
        watchSessionChanges(callback) {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('watch unavailable');
            }
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    const failedChanges = [];
    assert.throws(
        () => harness.adapter.watch(sessionId, () =>
            failedChanges.push('failed')),
        /watch unavailable/
    );
    const recoveredChanges = [];
    const recovered = harness.adapter.watch(sessionId, () =>
        recoveredChanges.push('recovered'));
    assert.equal(attempts, 2);
    providerCallback();
    assert.deepEqual(failedChanges, []);
    assert.deepEqual(recoveredChanges, ['recovered']);
    recovered.dispose();
    assert.equal(providerDisposeCount, 1);
    harness.adapter.dispose();
});

test('SESSION-AI-SESSION-CODEX-CONVERSATION-007 keeps revisions stable until normalized content changes', async t => {
    let current = clone(fixture);
    const harness = createAdapter(() => current);
    t.after(() => harness.adapter.dispose());
    const first = await harness.adapter.readOutline(sessionId);
    const unchanged = await harness.adapter.readOutline(sessionId);
    assert.equal(unchanged.sourceRevision, first.sourceRevision);
    current = clone(fixture);
    current.thread.turns[0].items[2].text = 'Changed visible response';
    const changed = await harness.adapter.readOutline(sessionId);
    assert.notEqual(changed.sourceRevision, first.sourceRevision);
});

test('CONVERSATION-TELEMETRY-001 Codex prefers the latest exec workdir and falls back to the launch cwd', async t => {
    const telemetryClient = {
        async request(method) {
            if (method === 'thread/read') {
                return { thread: { cwd: '/launch/repo' } };
            }
            return {};
        },
        dispose() {},
    };
    const rolloutAdapter = createAdapter(fixture, {
        client: telemetryClient,
        readRolloutTelemetry: id => id === sessionId
            ? {
                model: 'gpt-5.6-sol',
                currentWorkdir: '/launch/repo/.worktree/feature-x',
            }
            : undefined,
        resolveWorktree: async candidate => {
            if (candidate === '/launch/repo/.worktree/feature-x') {
                return {
                    branch: 'feature-x',
                    worktreeRoot: candidate,
                    repoRoot: '/launch/repo',
                };
            }
            if (candidate === '/launch/repo') {
                return {
                    branch: 'main',
                    worktreeRoot: candidate,
                    repoRoot: candidate,
                };
            }
            return undefined;
        },
    });
    t.after(() => rolloutAdapter.adapter.dispose());

    const telemetry = await rolloutAdapter.adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.worktree, {
        branch: 'feature-x',
        worktreeRoot: '/launch/repo/.worktree/feature-x',
        repoRoot: '/launch/repo',
    });

    const fallbackAdapter = createAdapter(fixture, {
        client: telemetryClient,
        readRolloutTelemetry: () => ({ model: 'gpt-5.6-sol' }),
        resolveWorktree: async candidate =>
            candidate === '/launch/repo'
                ? {
                    branch: 'main',
                    worktreeRoot: candidate,
                    repoRoot: candidate,
                }
                : undefined,
    });
    t.after(() => fallbackAdapter.adapter.dispose());

    const fallback = await fallbackAdapter.adapter.readTelemetry(sessionId);
    assert.deepEqual(fallback.worktree, {
        branch: 'main',
        worktreeRoot: '/launch/repo',
        repoRoot: '/launch/repo',
    });
});

test('CONVERSATION-TELEMETRY-001 Codex refreshes the latest exec workdir inside the telemetry cache window', async t => {
    let currentWorkdir;
    let requestCount = 0;
    const telemetryClient = {
        async request(method) {
            requestCount += 1;
            if (method === 'thread/read') {
                return { thread: { cwd: '/launch/repo' } };
            }
            return {};
        },
        dispose() {},
    };
    const harness = createAdapter(fixture, {
        client: telemetryClient,
        readRolloutTelemetry: () => ({
            model: 'gpt-5.6-sol',
            currentWorkdir,
        }),
        resolveWorktree: async candidate => ({
            branch: candidate.endsWith('/feature-x') ? 'feature-x' : 'main',
            worktreeRoot: candidate,
            repoRoot: '/launch/repo',
        }),
    });
    t.after(() => harness.adapter.dispose());

    const initial = await harness.adapter.readTelemetry(sessionId);
    assert.equal(initial.worktree.branch, 'main');
    currentWorkdir = '/launch/repo/.worktree/feature-x';

    const refreshed = await harness.adapter.readTelemetry(sessionId);
    assert.deepEqual(refreshed.worktree, {
        branch: 'feature-x',
        worktreeRoot: '/launch/repo/.worktree/feature-x',
        repoRoot: '/launch/repo',
    });
    assert.equal(requestCount, 2,
        'a worktree-only refresh must reuse cached app-server telemetry');
});

test('CONVERSATION-TELEMETRY-001 Codex discovers a worktree after an empty telemetry result was cached', async t => {
    let currentWorkdir;
    let requestCount = 0;
    const harness = createAdapter(fixture, {
        client: {
            async request() {
                requestCount += 1;
                throw new Error('telemetry unavailable');
            },
            dispose() {},
        },
        readRolloutTelemetry: () => currentWorkdir
            ? { currentWorkdir }
            : undefined,
        resolveWorktree: async candidate => ({
            branch: 'feature-x',
            worktreeRoot: candidate,
            repoRoot: '/launch/repo',
        }),
    });
    t.after(() => harness.adapter.dispose());

    assert.equal(await harness.adapter.readTelemetry(sessionId), undefined);
    currentWorkdir = '/launch/repo/.worktree/feature-x';

    assert.deepEqual(await harness.adapter.readTelemetry(sessionId), {
        provider: 'codex',
        sessionId,
        worktree: {
            branch: 'feature-x',
            worktreeRoot: '/launch/repo/.worktree/feature-x',
            repoRoot: '/launch/repo',
        },
        rateLimits: [],
    });
    assert.equal(requestCount, 2,
        'discovering the worktree must not repeat failed app-server reads');
});

const childThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherChildThreadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdChildThreadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function createThreadReadResult(threadId, parentThreadId, overrides = {}) {
    return {
        thread: {
            id: threadId,
            parentThreadId,
            agentNickname: 'Zeno',
            createdAt: 1_700_000_000,
            source: {
                subAgent: {
                    thread_spawn: {
                        parent_thread_id: parentThreadId,
                        depth: 1,
                        agent_path: '/root/implement_webview_mutation_skill',
                        agent_nickname: 'Zeno',
                        agent_role: null,
                    },
                },
            },
            turns: [
                {
                    id: 'turn-1',
                    status: 'completed',
                    items: [
                        { id: 'agent-item-1', type: 'agentMessage', text: 'First progress note' },
                        {
                            id: 'file-item-1',
                            type: 'fileChange',
                            changes: [{ path: '/repo/x.ts', kind: 'update' }],
                        },
                        { id: 'agent-item-2', type: 'agentMessage', text: 'status: complete' },
                    ],
                },
            ],
            ...overrides,
        },
    };
}

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Codex lists depth-1 subagent threads with inferred statuses and labels', async t => {
    const now = Date.now();
    const { adapter } = createAdapter(fixture, {
        listSubagentThreads: () => [
            {
                id: childThreadId,
                filePath: '/codex/sessions/2026/08/02/rollout-child.jsonl',
                agentNickname: 'Zeno',
                agentPath: '/root/implement_webview_mutation_skill',
                createdAt: 1_700_000_000_000,
                fileMtimeMs: now,
                completed: true,
            },
            {
                id: otherChildThreadId,
                filePath: '/codex/sessions/2026/08/02/rollout-running.jsonl',
                agentPath: '/root/review_fix_loop',
                createdAt: 1_699_000_000_000,
                fileMtimeMs: now,
                completed: false,
            },
            {
                id: thirdChildThreadId,
                filePath: '/codex/sessions/2026/08/02/rollout-stale.jsonl',
                createdAt: 1_698_000_000_000,
                fileMtimeMs: now - 10 * 60 * 1000,
                completed: false,
            },
        ],
    });
    t.after(() => adapter.dispose());

    const entries = await adapter.readSubagents(sessionId);
    assert.deepEqual(
        entries.map(entry => [entry.id, entry.status, entry.agentType]),
        [
            [thirdChildThreadId, 'quiet', undefined],
            [otherChildThreadId, 'running', 'review_fix_loop'],
            [childThreadId, 'idle', 'implement_webview_mutation_skill'],
        ]
    );
    assert.equal(entries[2].label, 'Zeno · implement_webview_mutation_skill');
    assert.equal(entries[1].label, 'review_fix_loop');
    assert.equal(entries[0].label, thirdChildThreadId);
    assert.equal(entries[2].createdAt, 1_700_000_000_000);

    // Encoded subagent ids never list nested subagents.
    assert.deepEqual(
        await adapter.readSubagents(`${sessionId}#agent:${childThreadId}`),
        []
    );
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Codex reads a subagent thread as its own conversation', async t => {
    const childResult = createThreadReadResult(childThreadId, sessionId);
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (params && params.threadId === childThreadId) {
                return childResult;
            }
            return fixture;
        },
        dispose() {},
    };
    const { adapter } = createAdapter(fixture, {
        client,
        listSubagentThreads: () => [],
    });
    t.after(() => adapter.dispose());

    const encodedId = `${sessionId}#agent:${childThreadId}`;
    const outline = await adapter.readOutline(encodedId);
    assert.equal(outline.sessionId, encodedId);
    assert.equal(outline.totalInteractions, 1);
    assert.equal(
        outline.interactions[0].userPreview,
        'Zeno · implement_webview_mutation_skill'
    );
    assert.deepEqual(
        requests.map(entry => [entry.method, entry.params.threadId]),
        [['thread/read', childThreadId]]
    );
    const page = await adapter.readPage({
        provider: 'codex',
        sessionId: encodedId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => [message.role, message.role === 'tool' ? message.tool.summary : message.markdown]),
        [
            ['user', 'Zeno · implement_webview_mutation_skill'],
            ['progress', 'First progress note'],
            ['tool', 'fileChange update /repo/x.ts'],
            ['assistant', 'status: complete'],
        ]
    );

    // The parent session conversation is unaffected.
    const parent = await adapter.readOutline(sessionId);
    assert.equal(parent.totalInteractions, 3);
    assert.equal(parent.interactions[0].userPreview, 'Visible request [Attachment]');
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Codex rejects malformed and mismatched subagent targets', async t => {
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (params && params.threadId === childThreadId) {
                // Thread exists but belongs to a different parent.
                return createThreadReadResult(
                    childThreadId,
                    otherChildThreadId
                );
            }
            throw new Error('thread not found');
        },
        dispose() {},
    };
    const { adapter } = createAdapter(fixture, {
        client,
        listSubagentThreads: () => [],
    });
    t.after(() => adapter.dispose());

    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:..`),
        error => error?.code === 'unavailable'
    );
    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:${childThreadId}`),
        error => error?.code === 'unavailable'
    );
    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:${otherChildThreadId}`),
        error => error?.code === 'unavailable'
    );
    await assert.rejects(
        () => adapter.readOutline(
            `${sessionId}#agent:${childThreadId}#agent:${otherChildThreadId}`
        ),
        error => error?.code === 'unavailable'
    );
    // A main-session protocol failure still reports the protocol reason.
    await assert.rejects(
        () => adapter.readOutline(sessionId),
        error => error?.code === 'unsupportedVersion'
    );
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 Codex renders command executions and file changes as tool messages', async t => {
    const harness = createAdapter();
    t.after(() => harness.adapter.dispose());

    const outline = await harness.adapter.readOutline(sessionId);
    const page = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
    });
    assert.deepEqual(
        page.messages.filter(message => message.role === 'tool')
            .map(message => [
                message.interactionId,
                message.tool.name,
                message.tool.summary,
                message.tool.detail,
            ]),
        [
            ['user-item-1', 'commandExecution', 'commandExecution print-secret', 'command-output'],
            ['user-item-1', 'fileChange', 'fileChange update /private/changed-file.txt', undefined],
        ]
    );
});

function createPaginatedTurn(index, prefix = 'turn') {
    return {
        id: `${prefix}-${index}`,
        status: 'completed',
        items: [{
            id: `${prefix}-user-${index}`,
            type: 'userMessage',
            content: [{ type: 'text', text: `request ${index}` }],
        }, {
            id: `${prefix}-agent-${index}`,
            type: 'agentMessage',
            text: 'x'.repeat(60 * 1024),
        }],
    };
}

// Emulates the verified 0.147 app-server pagination semantics: descending
// by default, an opaque inclusive cursor that continues strictly after it,
// and nextCursor present only while older turns remain.
function serveTurnsListPage(turns, params) {
    const ordered = params.sortDirection === 'asc'
        ? [...turns]
        : [...turns].reverse();
    let start = 0;
    if (typeof params.cursor === 'string') {
        const at = ordered.findIndex(turn => turn.id === params.cursor);
        if (at < 0) {
            throw new Error(`unknown cursor ${params.cursor}`);
        }
        start = at + 1;
    }
    const limit = params.limit || ordered.length;
    const data = ordered.slice(start, start + limit);
    const more = start + data.length < ordered.length;
    return clone({
        data,
        nextCursor: more && data.length ? data[data.length - 1].id : null,
        backwardsCursor: data.length ? data[0].id : null,
    });
}

function createPaginatedHarness(t, options = {}) {
    const state = {
        turns: Array.from(
            { length: options.initialTurns || 12 },
            (_, index) => createPaginatedTurn(index)
        ),
        signature: 'stat-1',
        turnsListFailure: undefined,
    };
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (method === 'thread/read') {
                return clone({
                    thread: { id: params.threadId, turns: state.turns },
                });
            }
            if (method === 'thread/turns/list') {
                if (state.turnsListFailure === 'error') {
                    throw new Error(
                        'thread/turns/list requires experimentalApi capability'
                    );
                }
                if (state.turnsListFailure === 'transient') {
                    throw new ConversationError(
                        'unavailable',
                        'reconnectingCodex'
                    );
                }
                if (state.turnsListFailure === 'malformed') {
                    return { data: [{ id: 'broken' }] };
                }
                if (state.turnsListFailure === 'empty-page-with-cursor'
                    && typeof params.cursor === 'string') {
                    return { data: [], nextCursor: 'ghost' };
                }
                return serveTurnsListPage(state.turns, params);
            }
            throw new Error(`unexpected method ${method}`);
        },
        getServerVersion: () => options.serverVersion === undefined
            ? '0.147'
            : options.serverVersion,
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: () => state.signature,
    });
    t.after(() => harness.adapter.dispose());
    return {
        adapter: harness.adapter,
        requests,
        state,
        methods: () => requests.map(entry => entry.method),
    };
}

// Ground truth: the same content loaded through the stable full-read path
// (no server version → the paginated accelerator never engages).
function createFullReadProof(t, state) {
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (method === 'thread/read') {
                return clone({
                    thread: { id: params.threadId, turns: state.turns },
                });
            }
            throw new Error(`unexpected method ${method}`);
        },
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: () => state.signature,
    });
    t.after(() => harness.adapter.dispose());
    return harness.adapter;
}

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 reloads an appended large Codex thread through thread/turns/list only', async t => {
    const harness = createPaginatedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);
    assert.deepEqual(harness.methods(), ['thread/read']);

    harness.state.turns.push(createPaginatedTurn(12));
    harness.state.signature = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(harness.methods().slice(1), ['thread/turns/list']);
    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    assert.equal(updated.totalInteractions, 13);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(updated, expected);

    // The re-anchored entry serves the next read without any RPC.
    const again = await harness.adapter.readOutline(sessionId);
    assert.equal(again.sourceRevision, updated.sourceRevision);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-reads a grown in-flight anchor turn of a large Codex thread incrementally', async t => {
    const harness = createPaginatedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    harness.state.turns.at(-1).items.push({
        id: 'turn-11-agent-late',
        type: 'agentMessage',
        text: 'late tail output',
    });
    harness.state.signature = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(harness.methods().slice(1), ['thread/turns/list']);
    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(updated, expected);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-anchors the cache when the stat moves but the content does not', async t => {
    const harness = createPaginatedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    harness.state.signature = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(harness.methods().slice(1), ['thread/turns/list']);
    assert.equal(updated.sourceRevision, first.sourceRevision);

    // The false alarm is healed: the entry now validates against stat-2, so
    // the next read needs no RPC at all.
    const again = await harness.adapter.readOutline(sessionId);
    assert.equal(again.sourceRevision, first.sourceRevision);
    assert.equal(harness.requests.length, 2);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 rebuilds a compacted large Codex thread from fast paginated pages', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    harness.state.turns = Array.from(
        { length: 12 },
        (_, index) => createPaginatedTurn(index, 'rewritten')
    );
    harness.state.signature = 'stat-2';
    const compacted = await harness.adapter.readOutline(sessionId);

    // The anchor is gone, but the indexed backend serves pages cheaply, so
    // the walk runs to the end of the thread and rebuilds from the pages
    // — a full read of a huge paginated session could never finish within
    // the request timeout.
    assert.deepEqual(harness.methods(), [
        'thread/read',
        'thread/turns/list',
        'thread/turns/list',
        'thread/turns/list',
    ]);
    assert.equal(compacted.totalInteractions, 12);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(compacted, expected);

    // Incremental reloads resume from the rebuilt anchor.
    harness.state.turns.push(createPaginatedTurn(12, 'rewritten'));
    harness.state.signature = 'stat-3';
    const requestCount = harness.requests.length;
    const appended = await harness.adapter.readOutline(sessionId);
    assert.deepEqual(
        harness.methods().slice(requestCount),
        ['thread/turns/list']
    );
    const expectedAppended = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(appended, expectedAppended);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 falls back to a full read after one slow legacy page', async t => {
    // The legacy rollout-replay backend needs hundreds of ms per page, so
    // the walk exits after the first page: further paging costs as much as
    // the full read that settles the load anyway.
    let now = 1_000_000;
    const state = {
        turns: Array.from(
            { length: 12 },
            (_, index) => createPaginatedTurn(index)
        ),
        signature: 'stat-1',
    };
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (method === 'thread/read') {
                return clone({
                    thread: { id: params.threadId, turns: state.turns },
                });
            }
            now += 600;
            return serveTurnsListPage(state.turns, params);
        },
        getServerVersion: () => '0.147',
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: () => state.signature,
        now: () => now,
    });
    t.after(() => harness.adapter.dispose());

    await harness.adapter.readOutline(sessionId);
    state.turns = Array.from(
        { length: 12 },
        (_, index) => createPaginatedTurn(index, 'rewritten')
    );
    state.signature = 'stat-2';
    const compacted = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(
        requests.map(entry => entry.method),
        ['thread/read', 'thread/turns/list', 'thread/read']
    );
    assert.equal(compacted.totalInteractions, 12);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 falls back to a full read on an empty page with a live cursor', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    harness.state.turns = Array.from(
        { length: 12 },
        (_, index) => createPaginatedTurn(index, 'rewritten')
    );
    harness.state.signature = 'stat-2';
    // Outside the verified semantics: an empty page that still claims more
    // turns. The adapter must not rebuild from a truncated walk.
    harness.state.turnsListFailure = 'empty-page-with-cursor';
    const recovered = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(
        harness.methods(),
        ['thread/read', 'thread/turns/list', 'thread/turns/list', 'thread/read']
    );
    assert.equal(recovered.totalInteractions, 12);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 walks deep append bursts on the fast paginated backend', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    for (let index = 12; index < 112; index += 1) {
        harness.state.turns.push(createPaginatedTurn(index));
    }
    harness.state.signature = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);

    const methods = harness.methods();
    assert.equal(methods[0], 'thread/read');
    assert.equal(
        methods.filter(method => method === 'thread/turns/list').length,
        26
    );
    assert.ok(!methods.slice(1).includes('thread/read'));
    assert.equal(updated.totalInteractions, 112);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(updated, expected);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 disables paginated reloads after the server rejects thread/turns/list', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    harness.state.turns.push(createPaginatedTurn(12));
    harness.state.signature = 'stat-2';
    harness.state.turnsListFailure = 'error';
    const recovered = await harness.adapter.readOutline(sessionId);
    assert.equal(recovered.totalInteractions, 13);
    assert.deepEqual(
        harness.methods(),
        ['thread/read', 'thread/turns/list', 'thread/read']
    );

    // The circuit breaker sticks: later reloads use the stable path
    // directly without probing the rejected method again.
    harness.state.turnsListFailure = undefined;
    harness.state.turns.push(createPaginatedTurn(13));
    harness.state.signature = 'stat-3';
    const reloaded = await harness.adapter.readOutline(sessionId);
    assert.equal(reloaded.totalInteractions, 14);
    assert.deepEqual(harness.methods().slice(3), ['thread/read']);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 falls back without disabling paginated reloads on transient transport errors', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    // A child restart rejects the in-flight tail page with a transient
    // 'unavailable': the load falls back to a full read, but the
    // accelerator stays enabled.
    harness.state.turns.push(createPaginatedTurn(12));
    harness.state.signature = 'stat-2';
    harness.state.turnsListFailure = 'transient';
    const recovered = await harness.adapter.readOutline(sessionId);
    assert.equal(recovered.totalInteractions, 13);
    assert.deepEqual(
        harness.methods(),
        ['thread/read', 'thread/turns/list', 'thread/read']
    );

    harness.state.turnsListFailure = undefined;
    harness.state.turns.push(createPaginatedTurn(13));
    harness.state.signature = 'stat-3';
    const reloaded = await harness.adapter.readOutline(sessionId);
    assert.equal(reloaded.totalInteractions, 14);
    assert.deepEqual(harness.methods().slice(3), ['thread/turns/list']);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 disables paginated reloads after a malformed thread/turns/list page', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    harness.state.turns.push(createPaginatedTurn(12));
    harness.state.signature = 'stat-2';
    harness.state.turnsListFailure = 'malformed';
    const recovered = await harness.adapter.readOutline(sessionId);
    assert.equal(recovered.totalInteractions, 13);
    assert.deepEqual(
        harness.methods(),
        ['thread/read', 'thread/turns/list', 'thread/read']
    );

    harness.state.turnsListFailure = undefined;
    harness.state.turns.push(createPaginatedTurn(13));
    harness.state.signature = 'stat-3';
    await harness.adapter.readOutline(sessionId);
    assert.deepEqual(harness.methods().slice(3), ['thread/read']);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 never calls thread/turns/list on an unverified server version', async t => {
    for (const serverVersion of ['0.148', undefined, null]) {
        const requests = [];
        const client = {
            async request(method, params) {
                requests.push({ method, params });
                return clone(createLargeThread(params.threadId));
            },
            getServerVersion: () => serverVersion,
            dispose() {},
        };
        let signature = 'stat-1';
        const harness = createAdapter(undefined, {
            client,
            readContentSignature: () => signature,
        });
        const adapter = harness.adapter;
        await adapter.readOutline(sessionId);
        signature = 'stat-2';
        await adapter.readOutline(sessionId);
        assert.deepEqual(
            requests.map(entry => entry.method),
            ['thread/read', 'thread/read'],
            `server version ${serverVersion}`
        );
        adapter.dispose();
    }
    t.after(() => undefined);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 walks older pages when many turns appended at once', async t => {
    const harness = createPaginatedHarness(t);
    await harness.adapter.readOutline(sessionId);

    for (let index = 12; index < 18; index += 1) {
        harness.state.turns.push(createPaginatedTurn(index));
    }
    harness.state.signature = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);

    assert.deepEqual(
        harness.methods().slice(1),
        ['thread/turns/list', 'thread/turns/list']
    );
    assert.deepEqual(harness.requests[1].params, {
        threadId: sessionId,
        cursor: undefined,
        limit: 4,
        sortDirection: 'desc',
        itemsView: 'full',
    });
    assert.equal(harness.requests[2].params.cursor, 'turn-14');
    assert.equal(updated.totalInteractions, 18);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(updated, expected);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-applies the rollout lifecycle when an unchanged tail re-anchors the cache', async t => {
    let executionState = 'running';
    const state = {
        turns: Array.from({ length: 12 }, (_, index) => {
            const turn = createPaginatedTurn(index);
            turn.status = 'interrupted';
            return turn;
        }),
        signature: 'stat-1',
        turnsListFailure: undefined,
    };
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (method === 'thread/read') {
                return clone({
                    thread: { id: params.threadId, turns: state.turns },
                });
            }
            return serveTurnsListPage(state.turns, params);
        },
        getServerVersion: () => '0.147',
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: () => state.signature,
        readLifecycleSignal: () => ({
            token: `codex:lifecycle:1:${executionState}`,
            phase: executionState === 'running' ? 'running' : 'idle',
            executionState,
            occurredAtMs: 1,
        }),
    });
    t.after(() => harness.adapter.dispose());

    // A running rollout promotes the externally interrupted tail turn.
    const running = await harness.adapter.readOutline(sessionId);
    assert.equal(running.interactions.at(-1).responseState, 'inProgress');

    // The rollout stops: the stat moves but the visible content does not,
    // so the tail page re-anchors the cache. The lifecycle must still be
    // re-evaluated — the cached 'inProgress' must not stick.
    executionState = 'stopped';
    state.signature = 'stat-2';
    const stopped = await harness.adapter.readOutline(sessionId);
    assert.equal(requests.filter(entry => entry.method === 'thread/turns/list').length, 1);
    assert.equal(stopped.sourceRevision, running.sourceRevision);
    assert.equal(stopped.interactions.at(-1).responseState, 'interrupted');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-applies the rollout lifecycle on stat-validated cache hits', async t => {
    let executionState = 'running';
    const large = createLargeThread();
    large.thread.turns.forEach(turn => {
        turn.status = 'interrupted';
    });
    const harness = createAdapter(large, {
        readContentSignature: () => 'stat-1',
        readLifecycleSignal: () => ({
            token: `codex:lifecycle:1:${executionState}`,
            phase: executionState === 'running' ? 'running' : 'idle',
            executionState,
            occurredAtMs: 1,
        }),
    });
    t.after(() => harness.adapter.dispose());

    const running = await harness.adapter.readOutline(sessionId);
    assert.equal(running.interactions.at(-1).responseState, 'inProgress');

    // Same stat, pure cache hit — the lifecycle is still re-read, so a
    // stopped session settles even while its bytes are untouched.
    executionState = 'stopped';
    const stopped = await harness.adapter.readOutline(sessionId);
    assert.equal(harness.requests.length, 1);
    assert.equal(stopped.sourceRevision, running.sourceRevision);
    assert.equal(stopped.interactions.at(-1).responseState, 'interrupted');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps subagent thread reloads on the stable full-read path', async t => {
    const childTurns = Array.from(
        { length: 12 },
        (_, index) => ({
            id: `child-turn-${index}`,
            status: 'completed',
            items: [{
                id: `child-agent-${index}`,
                type: 'agentMessage',
                text: 'y'.repeat(60 * 1024),
            }],
        })
    );
    const signatures = { [childThreadId]: 'child-stat-1' };
    const requests = [];
    const client = {
        async request(method, params) {
            requests.push({ method, params });
            if (method !== 'thread/read' || params.threadId !== childThreadId) {
                throw new Error(`unexpected ${method} for ${params.threadId}`);
            }
            return clone(createThreadReadResult(childThreadId, sessionId, {
                turns: childTurns,
            }));
        },
        getServerVersion: () => '0.147',
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: id => signatures[id],
        listSubagentThreads: () => [],
    });
    t.after(() => harness.adapter.dispose());

    const encodedId = `${sessionId}#agent:${childThreadId}`;
    const first = await harness.adapter.readOutline(encodedId);
    assert.equal(first.totalInteractions, 1);

    childTurns.push({
        id: 'child-turn-12',
        status: 'completed',
        items: [{
            id: 'child-agent-12',
            type: 'agentMessage',
            text: 'z'.repeat(60 * 1024),
        }],
    });
    signatures[childThreadId] = 'child-stat-2';
    const updated = await harness.adapter.readOutline(encodedId);

    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    assert.deepEqual(
        requests.map(entry => entry.method),
        ['thread/read', 'thread/read']
    );
});

// --- Windowed cold start (spikes/codex-cold-start) -----------------------

// The summary view keeps the first userMessage and the final agentMessage
// per turn (schema-verified server projection rule).
function toSummaryTurn(turn) {
    const items = [];
    const user = turn.items.find(item => item.type === 'userMessage');
    const agents = turn.items.filter(item => item.type === 'agentMessage');
    if (user) {
        items.push(user);
    }
    if (agents.length) {
        items.push(agents[agents.length - 1]);
    }
    const summary = { id: turn.id, status: turn.status, items };
    for (const key of ['startedAt', 'completedAt', 'durationMs', 'error']) {
        if (turn[key] !== undefined) {
            summary[key] = turn[key];
        }
    }
    return summary;
}

// Strips the (intentionally basis-dependent) revision so windowed results
// can be compared with the full-read ground truth field by field.
function stripRevision(value) {
    if (Array.isArray(value)) {
        return value.map(stripRevision);
    }
    if (value && typeof value === 'object') {
        const copy = {};
        for (const [key, entry] of Object.entries(value)) {
            copy[key] = key === 'sourceRevision' ? '' : stripRevision(entry);
        }
        return copy;
    }
    return value;
}

function createWindowedHarness(t, options = {}) {
    const state = {
        turns: options.turns || Array.from(
            { length: options.initialTurns ?? 120 },
            (_item, index) => createPaginatedTurn(index)
        ),
        signature: 'stat-1',
        sourceBytes: options.sourceBytes ?? 8 * 1024 * 1024,
        turnsListFailure: undefined,
        readFailure: undefined,
        // Per-request artificial latency (ms) for thread/turns/list.
        pageLatencies: options.pageLatencies
            ? [...options.pageLatencies] : [],
        onRequest: undefined,
        ensureReadyFailure: undefined,
    };
    let now = 1_000;
    const requests = [];
    const client = {
        async ensureReady(signal) {
            requests.push({ method: 'ensureReady' });
            if (signal?.aborted) {
                throw new ConversationAbortError();
            }
            if (state.ensureReadyFailure) {
                throw new ConversationError('unavailable', 'reconnectingCodex');
            }
            return options.serverVersion === undefined
                ? '0.147'
                : options.serverVersion;
        },
        async request(method, params, signal) {
            requests.push({ method, params });
            if (typeof state.onRequest === 'function') {
                state.onRequest(method, params);
            }
            if (signal?.aborted) {
                throw new ConversationAbortError();
            }
            if (method === 'thread/turns/list') {
                now += state.pageLatencies.length
                    ? state.pageLatencies.shift() : 0;
            }
            if (method === 'thread/read') {
                if (state.readFailure === 'timeout') {
                    throw new ConversationError('timeout');
                }
                if (state.readFailure === 'tooLarge') {
                    throw new ConversationError('tooLarge');
                }
                return clone({
                    thread: { id: params.threadId, turns: state.turns },
                });
            }
            if (method === 'thread/turns/list') {
                if (state.turnsListFailure === 'capability') {
                    throw new ConversationError(
                        'unsupportedVersion',
                        'unsupportedCodexProtocol'
                    );
                }
                if (state.turnsListFailure === 'transient') {
                    state.turnsListFailure = undefined;
                    throw new ConversationError(
                        'unavailable',
                        'reconnectingCodex'
                    );
                }
                if (state.turnsListFailure === 'malformed') {
                    return { data: [{ id: 'broken' }] };
                }
                if (state.turnsListFailure === 'empty-page-with-cursor'
                    && typeof params.cursor === 'string') {
                    return { data: [], nextCursor: 'ghost' };
                }
                const served = serveTurnsListPage(state.turns, params);
                if (params.itemsView === 'summary') {
                    served.data = served.data.map(toSummaryTurn);
                }
                return served;
            }
            throw new Error(`unexpected method ${method}`);
        },
        getServerVersion: () => options.serverVersion === undefined
            ? '0.147'
            : options.serverVersion,
        dispose() {},
    };
    const signatures = options.signatures || { [sessionId]: state.signature };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: id => signatures[id],
        readSourceBytes: id => (
            id === sessionId ? state.sourceBytes : 8 * 1024 * 1024
        ),
        now: () => now,
    });
    t.after(() => harness.adapter.dispose());
    return {
        adapter: harness.adapter,
        requests,
        state,
        signatures,
        methods: () => requests.map(entry => entry.method),
        turnsListCalls: () => requests
            .filter(entry => entry.method === 'thread/turns/list'),
    };
}

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 windowed cold start handshakes first and never calls thread/read', async t => {
    const harness = createWindowedHarness(t);
    const outline = await harness.adapter.readOutline(sessionId);
    const methods = harness.methods();
    assert.equal(methods[0], 'ensureReady',
        'the handshake must settle before any version-gated call');
    assert.equal(methods.includes('thread/read'), false);
    const listCalls = harness.turnsListCalls();
    const firstFull = listCalls.findIndex(
        entry => entry.params.itemsView === 'full'
    );
    assert.ok(firstFull > 0, 'summary walk pages come first');
    assert.ok(listCalls.slice(0, firstFull).every(
        entry => entry.params.itemsView === 'summary'
            && entry.params.sortDirection === 'desc'
    ));

    const proof = createFullReadProof(t, harness.state);
    const expectedOutline = await proof.readOutline(sessionId);
    assert.deepEqual(stripRevision(outline), stripRevision(expectedOutline));

    const snapshot = await harness.adapter.readSnapshot(sessionId);
    const expectedSnapshot = await proof.readSnapshot(sessionId);
    assert.deepEqual(
        stripRevision(snapshot.page),
        stripRevision(expectedSnapshot.page)
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps small rollouts on the plain full read', async t => {
    const harness = createWindowedHarness(t, {
        sourceBytes: 1024 * 1024,
    });
    await harness.adapter.readOutline(sessionId);
    assert.deepEqual(harness.methods(), ['ensureReady', 'thread/read']);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 disables windowing without a content signature and keeps revisions stable', async t => {
    const state = { turns: Array.from(
        { length: 30 },
        (_item, index) => createPaginatedTurn(index)
    ) };
    const requests = [];
    const client = {
        async ensureReady() {
            return '0.147';
        },
        async request(method, params) {
            requests.push({ method, params });
            if (method !== 'thread/read') {
                throw new Error(`unexpected method ${method}`);
            }
            return clone({
                thread: { id: params.threadId, turns: state.turns },
            });
        },
        getServerVersion: () => '0.147',
        dispose() {},
    };
    const harness = createAdapter(undefined, {
        client,
        readContentSignature: () => undefined,
        readSourceBytes: () => 8 * 1024 * 1024,
    });
    t.after(() => harness.adapter.dispose());

    const first = await harness.adapter.readOutline(sessionId);
    const snapshot = await harness.adapter.readSnapshot(sessionId);
    const anchor = snapshot.page.interactionStates[0].interactionId;
    // The outline revision must stay valid for paging even though every
    // load re-reads the provider.
    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: anchor,
        direction: 'before',
        limit: 5,
        expectedRevision: first.sourceRevision,
    });
    assert.equal(paged.sourceRevision, first.sourceRevision);
    const refreshed = await harness.adapter.readOutline(sessionId);
    assert.equal(refreshed.sourceRevision, first.sourceRevision);
    assert.equal(
        requests.filter(entry => entry.method === 'thread/turns/list').length,
        0
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 verdicts legacy after two slow pages and falls back to the full read', async t => {
    const harness = createWindowedHarness(t, {
        pageLatencies: [400, 400, 400, 400],
    });
    const outline = await harness.adapter.readOutline(sessionId);
    assert.deepEqual(harness.methods(), [
        'ensureReady',
        'thread/turns/list',
        'thread/turns/list',
        'thread/read',
    ]);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(stripRevision(outline), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 tolerates a single jittery page without a legacy verdict', async t => {
    const harness = createWindowedHarness(t, {
        pageLatencies: [400, 20, 20, 20, 20, 20, 20, 20],
    });
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.methods().includes('thread/read'), false);
    assert.equal(harness.adapter.paginatedReadsDisabled, false);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 walks a many-page session to the true start', async t => {
    const turns = Array.from({ length: 10_250 }, (_item, index) => ({
        id: `turn-${index}`,
        status: 'completed',
        items: [{
            id: `turn-${index}-user`,
            type: 'userMessage',
            content: [{ type: 'text', text: `request ${index}` }],
        }, {
            id: `turn-${index}-agent`,
            type: 'agentMessage',
            text: `response ${index}`,
        }],
    }));
    const harness = createWindowedHarness(t, { turns });
    const outline = await harness.adapter.readOutline(sessionId);
    assert.equal(outline.totalInteractions, 10_250);
    assert.equal(harness.methods().includes('thread/read'), false);

    // The oldest history is reachable and matches the ground truth page.
    // (outline.interactions is clipped to the newest 2000 entries, so the
    // anchor id is addressed directly.)
    const anchor = 'turn-20-user';
    const [paged, expected] = await Promise.all([
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: anchor,
            direction: 'before',
            limit: 20,
        }),
        createFullReadProof(t, harness.state).readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: anchor,
            direction: 'before',
            limit: 20,
        }),
    ]);
    assert.deepEqual(stripRevision(paged), stripRevision(expected));
    assert.equal(paged.isStart, true, 'the true first page marks isStart');
    assert.equal(paged.interactionStates[0].interactionId, 'turn-0-user');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 materializes skeleton windows through recorded cursors without moving the revision', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);
    const fullCallsAtOpen = harness.turnsListCalls().filter(
        entry => entry.params.itemsView === 'full'
    ).length;

    const anchor = first.interactions[40].id;
    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: anchor,
        direction: 'before',
        limit: 20,
    });
    // The seek replays the walk's recorded boundary cursor in full view.
    const seekCalls = harness.turnsListCalls().filter(
        entry => entry.params.itemsView === 'full'
            && entry.params.cursor === 'turn-70'
    );
    assert.equal(seekCalls.length, 1,
        'page 1 of the walk is re-fetched from its boundary cursor');
    const expected = await createFullReadProof(t, harness.state).readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: anchor,
        direction: 'before',
        limit: 20,
    });
    assert.deepEqual(stripRevision(paged), stripRevision(expected));
    assert.ok(harness.turnsListCalls().filter(
        entry => entry.params.itemsView === 'full'
    ).length > fullCallsAtOpen);

    // Pure hydration must not move the revision.
    const after = await harness.adapter.readOutline(sessionId);
    assert.equal(after.sourceRevision, first.sourceRevision);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 expands a multi-user-message turn on materialization and moves the revision', async t => {
    const harness = createWindowedHarness(t);
    harness.state.turns[30] = {
        id: 'turn-30',
        status: 'completed',
        items: [
            {
                id: 'turn-30-user-a',
                type: 'userMessage',
                content: [{ type: 'text', text: 'first question' }],
            },
            { id: 'turn-30-agent-1', type: 'agentMessage', text: 'answer one' },
            {
                id: 'turn-30-user-b',
                type: 'userMessage',
                content: [{ type: 'text', text: 'steering' }],
            },
            { id: 'turn-30-agent-2', type: 'agentMessage', text: 'ack' },
            {
                id: 'turn-30-user-c',
                type: 'userMessage',
                content: [{ type: 'text', text: 'progress?' }],
            },
            { id: 'turn-30-agent-3', type: 'agentMessage', text: 'status' },
        ],
    };
    const first = await harness.adapter.readOutline(sessionId);
    // The skeleton folds the turn to its first user message.
    assert.equal(first.interactions.filter(
        interaction => interaction.providerTurnId === 'turn-30'
    ).length, 1);
    assert.equal(first.totalInteractions, 120);

    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-30-user-a',
        direction: 'around',
        limit: 20,
    });
    const ids = paged.interactionStates.map(state => state.interactionId);
    assert.ok(ids.includes('turn-30-user-b'));
    assert.ok(ids.includes('turn-30-user-c'));

    // The expansion changed the interaction-id set: the revision moved.
    const after = await harness.adapter.readOutline(sessionId);
    assert.notEqual(after.sourceRevision, first.sourceRevision);
    assert.equal(after.interactions.filter(
        interaction => interaction.providerTurnId === 'turn-30'
    ).length, 3);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(stripRevision(after), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 moves the revision when a live tail turn gains only tool items', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    // Tool-only growth: user/agent texts (the summary projection) stay
    // identical; only the stat moves.
    harness.state.turns[119].items.push({
        id: 'turn-119-tool-1',
        type: 'commandExecution',
        command: 'ls',
        aggregatedOutput: 'ok',
    });
    harness.signatures[sessionId] = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);
    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    assert.equal(harness.methods().includes('thread/read'), false);

    const snapshot = await harness.adapter.readSnapshot(sessionId);
    assert.ok(snapshot.page.messages.some(message => message.role === 'tool'),
        'the new tool item must render');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 materializes in-place skeleton updates fresh after invalidation', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    // An in-place update to an unmaterized turn's tool content: invisible
    // to the summary projection; the stat still moves. The moved stat
    // also demotes the materialized tail (unverified content), so the
    // revision moves even though the outline projection is unchanged.
    harness.state.turns[40].items.push({
        id: 'turn-40-tool-1',
        type: 'commandExecution',
        command: 'make test',
        aggregatedOutput: 'fresh output',
    });
    harness.signatures[sessionId] = 'stat-2';
    const refreshed = await harness.adapter.readOutline(sessionId);
    assert.notEqual(refreshed.sourceRevision, first.sourceRevision,
        'unverifiable materialized content demotes and moves the revision');
    assert.deepEqual(
        stripRevision(refreshed).interactions,
        stripRevision(first).interactions,
        'the outline projection itself is unchanged'
    );

    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-40',
        direction: 'around',
        limit: 10,
    });
    assert.ok(paged.messages.some(message =>
        message.role === 'tool' && message.tool?.detail === 'fresh output'),
        'materialization fetches the current server state');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 demotes unverified materialized chunks on a stat move and re-materializes identical content', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);
    const requestsAtOpen = harness.requests.length;

    // Stat fake-out with a materialized tail: the anchor walk cannot
    // re-verify the kept full chunks, so they demote to skeletons and the
    // revision moves — the viewer re-reads visible pages, which
    // re-materialize live and render byte-identical HTML.
    harness.signatures[sessionId] = 'stat-2';
    const reanchored = await harness.adapter.readOutline(sessionId);
    assert.notEqual(reanchored.sourceRevision, first.sourceRevision);
    const entry = harness.adapter.loadedConversationCache.get(sessionId);
    const skeletonCount = entry.turns.filter(
        chunk => chunk.kind === 'skeleton'
    ).length;
    assert.ok(skeletonCount >= 119,
        'all but the re-verified anchor turn demote back to skeletons');

    // A second fake-out right away keeps the revision stable: the kept
    // chunks are all skeletons now, and the anchor walk re-verifies the
    // single materialized tail turn. Zero-churn is preserved exactly
    // when nothing unverified remains materialized.
    harness.signatures[sessionId] = 'stat-3';
    const settled = await harness.adapter.readOutline(sessionId);
    assert.equal(settled.sourceRevision, reanchored.sourceRevision);

    const snapshot = await harness.adapter.readSnapshot(sessionId);
    const expected = await createFullReadProof(t, harness.state)
        .readSnapshot(sessionId);
    assert.deepEqual(
        stripRevision(snapshot.page),
        stripRevision(expected.page),
        're-materialized tail content is identical'
    );
    assert.ok(harness.requests.length - requestsAtOpen < 24,
        'the whole cycle stays on cheap paginated calls');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 reloads an appended windowed entry incrementally and keeps deep seeks correct', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    harness.state.turns.push(createPaginatedTurn(120));
    harness.signatures[sessionId] = 'stat-2';
    const updated = await harness.adapter.readOutline(sessionId);
    assert.notEqual(updated.sourceRevision, first.sourceRevision);
    assert.equal(updated.totalInteractions, 121);
    assert.equal(harness.methods().includes('thread/read'), false);

    // The append shifts newest-first indexes: deep seeks must rebase.
    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-30',
        direction: 'around',
        limit: 10,
    });
    assert.ok(paged.interactionStates.some(
        state => state.interactionId === 'turn-user-30'
    ));
    assert.ok(paged.messages.some(message =>
        message.role === 'assistant' && message.markdown.length > 1000),
        'the sought window renders its assistant content');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 rebuilds a windowed entry through a fresh summary walk after compaction', async t => {
    const harness = createWindowedHarness(t);
    const first = await harness.adapter.readOutline(sessionId);

    harness.state.turns = Array.from(
        { length: 10 },
        (_item, index) => createPaginatedTurn(index, 'new-turn')
    );
    harness.signatures[sessionId] = 'stat-2';
    const rebuilt = await harness.adapter.readOutline(sessionId);
    assert.notEqual(rebuilt.sourceRevision, first.sourceRevision);
    assert.equal(rebuilt.totalInteractions, 10);
    assert.equal(harness.methods().includes('thread/read'), false);
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(stripRevision(rebuilt), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 serializes concurrent materialization of different windows', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);

    const proof = createFullReadProof(t, harness.state);
    const [pageA, pageB] = await Promise.all([
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-30',
            direction: 'around',
            limit: 10,
        }),
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-80',
            direction: 'around',
            limit: 10,
        }),
    ]);
    const [expectedA, expectedB] = await Promise.all([
        proof.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-30',
            direction: 'around',
            limit: 10,
        }),
        proof.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-80',
            direction: 'around',
            limit: 10,
        }),
    ]);
    assert.deepEqual(stripRevision(pageA), stripRevision(expectedA));
    assert.deepEqual(stripRevision(pageB), stripRevision(expectedB));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 an aborted materialization does not disturb the queued request', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);
    const controller = new ConversationAbortController();
    harness.state.onRequest = (method, params) => {
        if (method === 'thread/turns/list'
            && params.itemsView === 'full'
            && params.cursor === 'turn-20') {
            controller.abort();
        }
    };
    const aborted = harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-10',
        direction: 'around',
        limit: 10,
    }, controller.signal);
    await assert.rejects(aborted, error => error.name === 'AbortError');

    harness.state.onRequest = undefined;
    const surviving = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-60',
        direction: 'around',
        limit: 10,
    });
    const expected = await createFullReadProof(t, harness.state).readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-60',
        direction: 'around',
        limit: 10,
    });
    assert.deepEqual(stripRevision(surviving), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 discards in-flight materialization when the source moves', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);
    let fullPages = 0;
    harness.state.onRequest = (method, params) => {
        if (method === 'thread/turns/list'
            && params.itemsView === 'full'
            && params.cursor !== undefined) {
            fullPages += 1;
            if (fullPages === 2) {
                harness.signatures[sessionId] = 'stat-2';
            }
        }
    };
    await assert.rejects(
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-10',
            direction: 'around',
            limit: 10,
        }),
        error => error.name === 'ConversationError'
            && error.code === 'staleRevision'
    );

    // The next read re-anchors through the incremental path and completes.
    harness.state.onRequest = undefined;
    const recovered = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-10',
        direction: 'around',
        limit: 10,
    });
    const expected = await createFullReadProof(t, harness.state).readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-10',
        direction: 'around',
        limit: 10,
    });
    assert.deepEqual(stripRevision(recovered), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 another session moving does not disturb an in-flight materialization', async t => {
    const otherSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const harness = createWindowedHarness(t, {
        signatures: {
            [sessionId]: 'stat-a1',
            [otherSession]: 'stat-b1',
        },
    });
    await harness.adapter.readOutline(sessionId);
    let fullPages = 0;
    harness.state.onRequest = (method, params) => {
        if (params.threadId === sessionId
            && params.itemsView === 'full'
            && params.cursor !== undefined) {
            fullPages += 1;
            if (fullPages === 1) {
                harness.signatures[otherSession] = 'stat-b2';
            }
        }
    };
    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-10',
        direction: 'around',
        limit: 10,
    });
    const expected = await createFullReadProof(t, harness.state).readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-10',
        direction: 'around',
        limit: 10,
    });
    assert.deepEqual(stripRevision(paged), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 falls back from a failing full read to the forced slow walk', async t => {
    const harness = createWindowedHarness(t, {
        pageLatencies: [400, 400],
    });
    harness.state.readFailure = 'timeout';
    const outline = await harness.adapter.readOutline(sessionId);
    const methods = harness.methods();
    assert.ok(methods.includes('thread/read'),
        'the legacy verdict tries the stable read first');
    const readIndex = methods.indexOf('thread/read');
    assert.ok(methods.slice(readIndex + 1).some(
        method => method === 'thread/turns/list'
    ), 'the failed read re-enters the forced windowed walk');
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(stripRevision(outline), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 circuit-breaks the walk on capability rejection and stays on the stable path', async t => {
    const harness = createWindowedHarness(t);
    harness.state.turnsListFailure = 'capability';
    const outline = await harness.adapter.readOutline(sessionId);
    assert.equal(outline.totalInteractions, 120);
    assert.equal(harness.adapter.paginatedReadsDisabled, true);

    harness.signatures[sessionId] = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.deepEqual(
        harness.methods().filter(method => method === 'thread/turns/list')
            .length,
        1,
        'no further paginated calls after the circuit broke'
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 a transient walk failure falls back without retiring the accelerator', async t => {
    const harness = createWindowedHarness(t);
    harness.state.turnsListFailure = 'transient';
    const outline = await harness.adapter.readOutline(sessionId);
    assert.equal(outline.totalInteractions, 120);
    assert.equal(harness.adapter.paginatedReadsDisabled, false);

    harness.signatures[sessionId] = 'stat-2';
    await harness.adapter.readOutline(sessionId);
    assert.equal(harness.methods().includes('thread/turns/list'), true,
        'the next load retries the paginated path');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 circuit-breaks on malformed and empty summary pages', async t => {
    const malformed = createWindowedHarness(t);
    malformed.state.turnsListFailure = 'malformed';
    await malformed.adapter.readOutline(sessionId);
    assert.equal(malformed.adapter.paginatedReadsDisabled, true);

    const emptyPage = createWindowedHarness(t);
    emptyPage.state.turnsListFailure = 'empty-page-with-cursor';
    await emptyPage.adapter.readOutline(sessionId);
    assert.equal(emptyPage.adapter.paginatedReadsDisabled, true);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 falls back to the full read when the handshake fails transiently', async t => {
    const harness = createWindowedHarness(t);
    harness.state.ensureReadyFailure = 'unavailable';
    const outline = await harness.adapter.readOutline(sessionId);
    assert.equal(outline.totalInteractions, 120);
    assert.deepEqual(harness.methods(), ['ensureReady', 'thread/read']);
    assert.equal(harness.adapter.paginatedReadsDisabled, false);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-reads edited history after a stat move instead of serving the old materialized content', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);

    // Materialize a historical window, then edit one of its turns in
    // place (tool output revision): the summary projection is unchanged.
    const before = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-79',
        direction: 'around',
        limit: 10,
    });
    assert.ok(before.messages.some(message =>
        message.role === 'assistant'));
    harness.state.turns[79].items.push({
        id: 'turn-79-tool-late',
        type: 'commandExecution',
        command: 'late edit',
        aggregatedOutput: 'NEW-79',
    });
    harness.signatures[sessionId] = 'stat-2';

    // The refresh demotes every unverified full chunk and moves the
    // revision; re-reading the window re-materializes the fresh content.
    const refreshed = await harness.adapter.readOutline(sessionId);
    const entry = harness.adapter.loadedConversationCache.get(sessionId);
    assert.equal(entry.turns[79].kind, 'skeleton',
        'the edited historical chunk demotes back to a skeleton');
    const after = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-79',
        direction: 'around',
        limit: 10,
    });
    assert.ok(after.messages.some(message =>
        message.role === 'tool' && message.tool?.detail === 'NEW-79'),
        'the re-materialized window shows the edited content');
    assert.notEqual(after.sourceRevision, before.sourceRevision);
    void refreshed;
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 rejects a materialization page whose RPC outlived the entry signature', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);
    const entry = harness.adapter.loadedConversationCache.get(sessionId);

    // The source moves while the LAST page of the window is in flight:
    // the post-RPC check must refuse the commit.
    let fullSeeks = 0;
    harness.state.onRequest = (method, params) => {
        if (method === 'thread/turns/list'
            && params.itemsView === 'full'
            && params.cursor !== undefined) {
            fullSeeks += 1;
            const isLast = params.cursor === 'turn-22';
            if (isLast) {
                harness.signatures[sessionId] = 'stat-2';
            }
        }
    };
    await assert.rejects(
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-25',
            direction: 'before',
            limit: 20,
        }),
        error => error.name === 'ConversationError'
            && error.code === 'staleRevision'
    );
    assert.ok(fullSeeks >= 2, 'the window took multiple pages');
    assert.equal(entry.turns[20].kind, 'skeleton',
        'the out-of-epoch page is never committed');
    assert.equal(entry.turns[10].kind, 'full',
        'pages committed while the signature was valid stay');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 verdicts legacy when only the first page is fast', async t => {
    const harness = createWindowedHarness(t, {
        pageLatencies: [20, 600, 600, 600, 600],
    });
    const outline = await harness.adapter.readOutline(sessionId);
    assert.deepEqual(harness.methods(), [
        'ensureReady',
        'thread/turns/list',
        'thread/turns/list',
        'thread/turns/list',
        'thread/read',
    ], 'the rolling median verdicts on the third page');
    const expected = await createFullReadProof(t, harness.state)
        .readOutline(sessionId);
    assert.deepEqual(stripRevision(outline), stripRevision(expected));
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 demotes least-recently-viewed full chunks beyond the materialized-window budget', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);
    const entry = harness.adapter.loadedConversationCache.get(sessionId);

    // Window A (~51 chunks × 60KB) then window B (~30 more chunks): the
    // sum crosses the 4Mi per-entry materialized budget.
    await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-25',
        direction: 'around',
        limit: 20,
    });
    const afterA = entry.characters;
    await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-65',
        direction: 'around',
        limit: 20,
    });
    assert.ok(entry.characters < afterA + 31 * 60 * 1024,
        'demotion offsets most of window B');
    assert.equal(entry.turns[10].kind, 'skeleton',
        'the oldest window demotes back to skeletons');
    assert.equal(entry.turns[65].kind, 'full',
        'the served window stays materialized');
    assert.equal(entry.turns[119].kind, 'full',
        'the tail zone stays materialized');
    assert.ok(entry.characters > 0);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 treats a cross-epoch item collision as staleness, never as a protocol failure', async t => {
    const harness = createWindowedHarness(t);
    await harness.adapter.readOutline(sessionId);

    // A response-spanning item projected into different turns at
    // different fetch times: the tail fetch (cold start) recorded it in
    // turn 119's full chunk, but the live full fetch now returns the same
    // item inside turn 60.
    const migrated = {
        id: 'shared-reasoning-1',
        type: 'reasoning',
        summary: ['migrated reasoning'],
    };
    harness.state.turns[60].items.push(migrated);
    const entry = harness.adapter.loadedConversationCache.get(sessionId);
    assert.equal(entry.turns[119].kind, 'full',
        'the tail chunk is materialized at cold start');
    entry.turns[119].itemIds.push('shared-reasoning-1');

    await assert.rejects(
        harness.adapter.readPage({
            provider: 'codex',
            sessionId,
            anchorInteractionId: 'turn-user-60',
            direction: 'around',
            limit: 10,
        }),
        error => error.name === 'ConversationError'
            && error.code === 'staleRevision'
    );
    assert.equal(harness.adapter.paginatedReadsDisabled, false,
        'a transient collision must not circuit-break the accelerator');
    assert.equal(
        harness.adapter.loadedConversationCache.has(sessionId),
        false,
        'the mixed-epoch entry is invalidated'
    );

    // The next read re-walks a consistent snapshot and succeeds.
    const outline = await harness.adapter.readOutline(sessionId);
    assert.equal(outline.totalInteractions, 120);
    const paged = await harness.adapter.readPage({
        provider: 'codex',
        sessionId,
        anchorInteractionId: 'turn-user-60',
        direction: 'around',
        limit: 10,
    });
    assert.ok(paged.interactionStates.some(
        state => state.interactionId === 'turn-user-60'
    ));
});
