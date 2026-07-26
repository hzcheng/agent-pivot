'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { KimiConversationAdapter } = require('../../../out/aiSessions/conversation/kimiAdapter');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');
const KimiSessionService = require('../../../out/services/kimiSessionService').default;

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/providers/kimi/home/sessions/'
        + '7bbd38310db600bd89c814e224a73d44/'
        + '33333333-3333-4333-8333-333333333333/wire.jsonl'
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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Kimi normalizes only visible turns and preserves suffix identities', async t => {
    const source = await createFixture(t);
    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            type: 'TurnBegin',
            timestamp: 3500,
            payload: { user_input: 'legacy-secret' },
        }),
        JSON.stringify({
            type: 'ContentPart',
            payload: { type: 'text', text: 'legacy-secret' },
        }),
        '',
    ].join('\n'));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const first = await readWholeConversation(adapter);
    const unchanged = await adapter.readOutline(sessionId);
    assert.equal(unchanged.sourceRevision, first.outline.sourceRevision);
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
            /tool_result|secret-thought|legacy-secret|local\/path|private\.invalid/.test(message.markdown)
        ),
        false
    );

    const originalIds = first.outline.interactions.map(item => item.id);
    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            timestamp: 4000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Describe the suffix' },
            },
        })}\n`
    );
    const appended = await adapter.readOutline(sessionId);
    assert.notEqual(appended.sourceRevision, first.outline.sourceRevision);
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
    assert.equal(duplicate.sourceRevision, first.sourceRevision);
    assert.equal(duplicate.totalInteractions, first.totalInteractions);
    assert.deepEqual(
        duplicate.interactions.map(item => item.id),
        first.interactions.map(item => item.id)
    );

    const statBeforeReset = await fs.promises.stat(source.sourcePath);
    const reset = (await fs.promises.readFile(source.sourcePath, 'utf8'))
        .replace('"timestamp":1000', '"timestamp":1001');
    await fs.promises.writeFile(source.sourcePath, reset);
    await fs.promises.utimes(
        source.sourcePath,
        statBeforeReset.atimeMs / 1000,
        statBeforeReset.mtimeMs / 1000
    );
    const rebuilt = await adapter.readOutline(sessionId);
    assert.notEqual(rebuilt.interactions[0].id, first.interactions[0].id);
    assert.notEqual(rebuilt.sourceRevision, first.sourceRevision);
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

test('SESSION-AI-SESSION-KIMI-CONVERSATION-003 keeps duplicate callback registrations independent', async t => {
    const source = await createFixture(t);
    let providerCallback;
    let providerDisposeCount = 0;
    const adapter = createAdapter(source, {
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    t.after(() => adapter.dispose());
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
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-003 rolls back a failed provider watch before a clean retry', async t => {
    const source = await createFixture(t);
    let attempts = 0;
    let providerCallback;
    let providerDisposeCount = 0;
    const adapter = createAdapter(source, {
        watchSessionChanges(callback) {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('watch unavailable');
            }
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    t.after(() => adapter.dispose());
    const failedChanges = [];
    assert.throws(
        () => adapter.watch(sessionId, () => failedChanges.push('failed')),
        /watch unavailable/
    );
    const recoveredChanges = [];
    const recovered = adapter.watch(
        sessionId,
        () => recoveredChanges.push('recovered')
    );
    assert.equal(attempts, 2);
    providerCallback();
    assert.deepEqual(failedChanges, []);
    assert.deepEqual(recoveredChanges, ['recovered']);
    recovered.dispose();
    assert.equal(providerDisposeCount, 1);
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-004 returns completed prefix as partial when the JSONL deadline fires', async t => {
    const source = await createFixture(t);
    const completePrefix = await fs.promises.readFile(source.sourcePath);
    await fs.promises.writeFile(source.sourcePath, Buffer.concat([
        completePrefix,
        Buffer.from(`${JSON.stringify({
            timestamp: 5000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Discard this open input' },
            },
        })}\n`),
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
    assert.equal(
        outline.interactions.some(item =>
            item.userPreview === 'Discard this open input'
        ),
        false
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 real Kimi polling invalidates an appended canonical input and exposes its page', async t => {
    const sandbox = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-live-conversation-')
    );
    const providerHome = path.join(sandbox, 'provider-home');
    await fs.promises.cp(
        path.resolve(__dirname, '../../fixtures/providers/kimi/home'),
        providerHome,
        { recursive: true }
    );
    t.after(() => fs.promises.rm(sandbox, {
        recursive: true,
        force: true,
    }));
    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = providerHome;
    t.after(() => {
        if (previousKimiHome === undefined) {
            delete process.env.KIMI_SHARE_DIR;
        } else {
            process.env.KIMI_SHARE_DIR = previousKimiHome;
        }
    });

    const liveSessionId = '33333333-3333-4333-8333-333333333333';
    const sourcePath = path.join(
        providerHome,
        'sessions',
        '7bbd38310db600bd89c814e224a73d44',
        liveSessionId,
        'wire.jsonl'
    );
    const service = new KimiSessionService();
    service.changePollIntervalMs = 10;
    const adapter = new KimiConversationAdapter({
        resolveSource: id => service.resolveConversationSource(id),
        watchSessionChanges: callback =>
            service.watchSessionChanges(callback),
        now: Date.now,
        ...immediateTimers(),
    });
    t.after(() => adapter.dispose());

    const initial = await adapter.readOutline(liveSessionId);
    assert.equal(initial.totalInteractions, 3);
    const invalidated = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('Kimi append was not invalidated')),
            1_000
        );
        const subscription = adapter.watch(liveSessionId, () => {
            clearTimeout(timeout);
            subscription.dispose();
            resolve();
        });
    });
    await fs.promises.appendFile(sourcePath, `${JSON.stringify({
        timestamp: 4000,
        message: {
            type: 'TurnBegin',
            payload: { user_input: 'Visible live suffix' },
        },
    })}\n`);
    await invalidated;

    const updated = await adapter.readOutline(liveSessionId);
    assert.equal(updated.totalInteractions, 4);
    assert.equal(
        updated.interactions.at(-1).userPreview,
        'Visible live suffix'
    );
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId: liveSessionId,
        anchorInteractionId: updated.interactions.at(-1).id,
        direction: 'around',
        expectedRevision: updated.sourceRevision,
    });
    assert.deepEqual(
        page.messages.filter(message =>
            message.interactionId === updated.interactions.at(-1).id
        ).map(message => [message.role, message.markdown]),
        [['user', 'Visible live suffix']]
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 real Kimi cap keeps newest 2,000 inputs and marks the outline partial', async t => {
    const source = await createFixture(t);
    const records = [];
    for (let number = 1;
        number <= CONVERSATION_LIMITS.maxOutlineInteractions + 1;
        number += 1) {
        records.push(JSON.stringify({
            timestamp: number,
            message: {
                type: 'TurnBegin',
                payload: { user_input: `Cap input ${number}` },
            },
        }));
        records.push(JSON.stringify({
            timestamp: number,
            message: { type: 'TurnEnd', payload: {} },
        }));
    }
    await fs.promises.writeFile(
        source.sourcePath,
        `${records.join('\n')}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    assert.equal(
        outline.totalInteractions,
        CONVERSATION_LIMITS.maxOutlineInteractions + 1
    );
    assert.equal(
        outline.interactions.length,
        CONVERSATION_LIMITS.maxOutlineInteractions
    );
    assert.equal(outline.partial, true);
    assert.equal(outline.interactions[0].userPreview, 'Cap input 2');
    assert.equal(outline.interactions.at(-1).userPreview, 'Cap input 2001');

    const firstPage = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        limit: 1,
        expectedRevision: outline.sourceRevision,
    });
    const latestPage = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions.at(-1).id,
        direction: 'around',
        limit: 1,
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        firstPage.messages.map(message => message.markdown),
        ['Cap input 2']
    );
    assert.deepEqual(
        latestPage.messages.map(message => message.markdown),
        ['Cap input 2001']
    );
});
