'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { KimiConversationAdapter } = require('../../../out/aiSessions/conversation/kimiAdapter');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/conversations/kimi/wire.jsonl'
);
const sessionId = '11111111-1111-4111-8111-111111111111';

function immediateTimers() {
    return {
        setTimeout(callback) {
            callback();
            return 1;
        },
        clearTimeout() {},
    };
}

async function createFixture(t) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-conversation-')
    );
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    await fs.promises.copyFile(fixturePath, sourcePath);
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    return { providerHome, sourcePath };
}

function createAdapter(source, overrides = {}) {
    return new KimiConversationAdapter({
        resolveSource: () => source,
        watchSessionChanges: () => ({ dispose() {} }),
        now: Date.now,
        ...immediateTimers(),
        ...overrides,
    });
}

async function readWholeConversation(adapter) {
    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
    });
    return { outline, page };
}

test('SESSION-AI-SESSION-KIMI-CONVERSATION-001 normalizes only visible turns and preserves suffix identities', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const first = await readWholeConversation(adapter);
    assert.deepEqual(first.outline.interactions.map(item => item.userPreview), [
        'Explain the parser',
        'Review [Attachment]',
        '[2 Attachments]',
    ]);
    assert.deepEqual(
        first.outline.interactions.map(item => item.responseState),
        ['complete', 'interrupted', 'complete']
    );
    assert.equal(first.page.messages.filter(message => message.role === 'assistant').length, 3);
    assert.equal(
        first.page.messages.some(message =>
            /tool_result|secret-thought|local\/path|private\.invalid/.test(message.markdown)
        ),
        false
    );

    const originalIds = first.outline.interactions.map(item => item.id);
    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'TurnBegin',
            timestamp: 4000,
            payload: { user_input: 'Describe the suffix' },
        })}\n`
    );
    const appended = await adapter.readOutline(sessionId);
    assert.deepEqual(
        appended.interactions.slice(0, originalIds.length).map(item => item.id),
        originalIds
    );
    assert.deepEqual(
        appended.interactions.map(item => item.userPreview),
        [
            'Explain the parser',
            'Review [Attachment]',
            '[2 Attachments]',
            'Describe the suffix',
        ]
    );
    assert.equal(new Set(appended.interactions.map(item => item.id)).size, 4);
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-002 deduplicates a reread and changes offset identity after source reset', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const first = await adapter.readOutline(sessionId);
    const duplicate = await adapter.readOutline(sessionId);
    assert.equal(duplicate.totalInteractions, first.totalInteractions);
    assert.deepEqual(
        duplicate.interactions.map(item => item.id),
        first.interactions.map(item => item.id)
    );

    const reset = (await fs.promises.readFile(source.sourcePath, 'utf8'))
        .replace('"timestamp":1000', '"timestamp":1001');
    await fs.promises.writeFile(source.sourcePath, reset);
    const rebuilt = await adapter.readOutline(sessionId);
    assert.notEqual(rebuilt.interactions[0].id, first.interactions[0].id);
    assert.equal(new Set(rebuilt.interactions.map(item => item.id)).size, 3);
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-003 shares the service poller and disposes logical watches deterministically', async t => {
    const source = await createFixture(t);
    let subscribeCount = 0;
    let providerCallback;
    let providerDisposeCount = 0;
    const adapter = createAdapter(source, {
        watchSessionChanges(callback) {
            subscribeCount += 1;
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    t.after(() => adapter.dispose());
    await adapter.readOutline(sessionId);

    let firstChanges = 0;
    let secondChanges = 0;
    const first = adapter.watch(sessionId, () => { firstChanges += 1; });
    const second = adapter.watch(sessionId, () => { secondChanges += 1; });
    assert.equal(subscribeCount, 1);
    providerCallback();
    assert.deepEqual([firstChanges, secondChanges], [1, 1]);
    first.dispose();
    providerCallback();
    assert.deepEqual([firstChanges, secondChanges], [1, 2]);
    second.dispose();
    assert.equal(providerDisposeCount, 1);
    adapter.dispose();
    adapter.dispose();
    assert.equal(providerDisposeCount, 1);
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-004 returns completed prefix as partial when the JSONL deadline fires', async t => {
    const source = await createFixture(t);
    const completePrefix = await fs.promises.readFile(source.sourcePath);
    await fs.promises.writeFile(source.sourcePath, Buffer.concat([
        completePrefix,
        Buffer.alloc(CONVERSATION_LIMITS.readChunkBytes, 0x20),
    ]));
    let clockReads = 0;
    const adapter = createAdapter(source, {
        now() {
            clockReads += 1;
            return clockReads <= 3 ? 0 : CONVERSATION_LIMITS.jsonlScanTimeoutMs;
        },
    });
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    assert.equal(outline.partial, true);
    assert.equal(outline.totalInteractions > 0, true);
});
