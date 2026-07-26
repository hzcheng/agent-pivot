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
} = require('../../../out/aiSessions/conversation/types');

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/conversations/codex/thread-read.json'
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
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
    });
    return {
        adapter,
        requests,
        getClientDisposeCount: () => clientDisposeCount,
    };
}

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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Codex normalizes only stable visible user and agent items', async t => {
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
        page.messages.filter(message => message.role === 'assistant')
            .map(message => [message.interactionId, message.markdown]),
        [
            ['user-item-1', 'Visible response'],
            ['user-item-2', 'Second visible response'],
            ['user-item-3', 'Streaming visible response'],
        ]
    );
    assert.equal(JSON.stringify(page).includes('reasoning-secret'), false);
    assert.equal(JSON.stringify(page).includes('command-output'), false);
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
