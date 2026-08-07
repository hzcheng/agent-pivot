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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 Kimi returns one correlated outline and page snapshot', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const snapshot = await adapter.readSnapshot(sessionId);

    assert.equal(snapshot.page.sourceRevision, snapshot.outline.sourceRevision);
    assert.equal(
        snapshot.page.anchorInteractionId,
        snapshot.outline.interactions.at(-1).id
    );
});

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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 CONVERSATION-PROGRESS-VISIBILITY-001 Kimi surfaces PlanDisplay markdown as progress', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Draft a rollout plan' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'PlanDisplay',
                payload: { content: '# Rollout Plan\n\n## v1 steps' },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'I revised the plan.' },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'PlanDisplay',
                payload: { content: '# Rollout Plan\n\n## v2 steps' },
            },
        },
        {
            timestamp: 1004,
            message: { type: 'TurnEnd', payload: {} },
        },
        {
            timestamp: 1005,
            message: {
                type: 'PlanDisplay',
                payload: { content: '# Orphan plan without an open turn' },
            },
        },
        {
            timestamp: 1006,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Ignore malformed plan payloads' },
            },
        },
        {
            timestamp: 1007,
            message: {
                type: 'PlanDisplay',
                payload: { content: 42 },
            },
        },
        {
            timestamp: 1008,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    assert.deepEqual(
        outline.interactions.map(interaction => interaction.userPreview),
        ['Draft a rollout plan', 'Ignore malformed plan payloads']
    );
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Draft a rollout plan'],
            ['progress', '# Rollout Plan\n\n## v1 steps'],
            ['assistant', 'I revised the plan.'],
            ['progress', '# Rollout Plan\n\n## v2 steps'],
            ['user', 'Ignore malformed plan payloads'],
        ]
    );
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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Kimi normalizes epoch seconds to milliseconds and preserves millisecond timestamps', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1_784_073_611,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Seconds timestamp' },
            },
        },
        {
            timestamp: 1_784_073_611,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'Seconds response' },
            },
        },
        {
            timestamp: 1_784_073_611,
            message: { type: 'TurnEnd', payload: {} },
        },
        {
            timestamp: 1_784_073_612_345,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Milliseconds timestamp' },
            },
        },
        {
            timestamp: 1_784_073_612_345,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    assert.deepEqual(
        outline.interactions.map(interaction => interaction.timestamp),
        [1_784_073_611_000, 1_784_073_612_345]
    );
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => [message.markdown, message.timestamp]),
        [
            ['Seconds timestamp', 1_784_073_611_000],
            ['Seconds response', 1_784_073_611_000],
            ['Milliseconds timestamp', 1_784_073_612_345],
        ]
    );
});

async function writeSubagentFixture(source, id, meta, records) {
    const directory = path.join(
        path.dirname(source.sourcePath),
        'subagents',
        id
    );
    await fs.promises.mkdir(directory, { recursive: true });
    if (meta) {
        await fs.promises.writeFile(
            path.join(directory, 'meta.json'),
            JSON.stringify(meta)
        );
    }
    const wirePath = path.join(directory, 'wire.jsonl');
    await fs.promises.writeFile(
        wirePath,
        records.map(record => JSON.stringify(record)).join('\n') + '\n'
    );
    return { directory, wirePath };
}

function subagentWireRecords() {
    return [
        {
            timestamp: 2000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Explore the parser and report back' },
            },
        },
        {
            timestamp: 2001,
            message: {
                type: 'ContentPart',
                payload: { type: 'think', text: 'subagent-secret-thought' },
            },
        },
        {
            timestamp: 2002,
            message: {
                type: 'PlanDisplay',
                payload: { content: '# Subagent Plan\n\n- inspect files' },
            },
        },
        {
            timestamp: 2003,
            message: {
                type: 'ContentPart',
                payload: {
                    type: 'text',
                    text: 'The parser normalizes visible text.',
                },
            },
        },
        {
            timestamp: 2004,
            message: { type: 'TurnEnd', payload: {} },
        },
    ];
}

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Kimi lists subagents with mapped statuses and labels', async t => {
    const source = await createFixture(t);
    const fresh = await writeSubagentFixture(
        source,
        'a11111111',
        {
            description: 'Explore the parser',
            subagent_type: 'explore',
            status: 'running_foreground',
            created_at: 1_700_000_000,
        },
        subagentWireRecords()
    );
    const stale = await writeSubagentFixture(
        source,
        'a22222222',
        {
            subagent_type: 'coder',
            status: 'running_background',
            created_at: 1_699_000_000,
        },
        subagentWireRecords()
    );
    const tenMinutesAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    await fs.promises.utimes(stale.wirePath, tenMinutesAgo, tenMinutesAgo);
    await writeSubagentFixture(
        source,
        'a33333333',
        { status: 'killed', created_at: 1_698_000_000 },
        subagentWireRecords()
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const entries = await adapter.readSubagents(sessionId);
    assert.deepEqual(
        entries.map(entry => [entry.id, entry.status, entry.agentType]),
        [
            ['a33333333', 'killed', undefined],
            ['a22222222', 'quiet', 'coder'],
            ['a11111111', 'running', 'explore'],
        ]
    );
    assert.equal(entries[2].label, 'Explore the parser');
    assert.equal(entries[1].label, 'coder · a22222222');
    assert.equal(entries[2].createdAt, 1_700_000_000_000);
    assert.ok(Number.isSafeInteger(entries[0].updatedAt));

    const stat = await fs.promises.stat(fresh.wirePath);
    assert.equal(entries[2].updatedAt, Math.floor(stat.mtimeMs));
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Kimi reads a subagent transcript as its own conversation', async t => {
    const source = await createFixture(t);
    await writeSubagentFixture(
        source,
        'a11111111',
        { description: 'Explore the parser', status: 'idle' },
        subagentWireRecords()
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const encodedId = `${sessionId}#agent:a11111111`;
    const outline = await adapter.readOutline(encodedId);
    assert.equal(outline.sessionId, encodedId);
    assert.equal(outline.totalInteractions, 1);
    assert.equal(
        outline.interactions[0].userPreview,
        'Explore the parser and report back'
    );
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId: encodedId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Explore the parser and report back'],
            ['thinking', ''],
            ['progress', '# Subagent Plan\n\n- inspect files'],
            ['assistant', 'The parser normalizes visible text.'],
        ]
    );
    assert.deepEqual(
        page.messages.filter(message => message.role === 'thinking')
            .map(message => message.thinking.text),
        ['subagent-secret-thought']
    );

    // The parent session conversation is unaffected by the subagent files.
    const parent = await adapter.readOutline(sessionId);
    assert.equal(parent.totalInteractions, 3);
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Kimi rejects malformed and missing subagent targets', async t => {
    const source = await createFixture(t);
    await writeSubagentFixture(
        source,
        'a11111111',
        { status: 'idle' },
        subagentWireRecords()
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:..`),
        error => error?.code === 'unavailable'
    );
    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:a99999999`),
        error => error?.code === 'unavailable'
    );
    await assert.rejects(
        () => adapter.readOutline(`${sessionId}#agent:a11111111#agent:a22222222`),
        error => error?.code === 'unavailable'
    );
});

test('SESSION-AI-SESSION-KIMI-CONVERSATION-003 shares the service poller and disposes logical watches deterministically', async t => {    const source = await createFixture(t);
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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 shares one Kimi filesystem poll across subscribers', () => {
    const service = new KimiSessionService();
    let fingerprintReads = 0;
    service.getSessionFingerprint = () => `revision-${++fingerprintReads}`;

    const first = service.watchSessionChanges(() => undefined);
    const second = service.watchSessionChanges(() => undefined);
    try {
        assert.equal(fingerprintReads, 1);
    } finally {
        first.dispose();
        second.dispose();
    }
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 isolates Kimi subscriber failures during a shared poll', () => {
    const service = new KimiSessionService();
    let fingerprintReads = 0;
    service.getSessionFingerprint = () => `revision-${++fingerprintReads}`;
    let delivered = 0;
    const failing = service.watchSessionChanges(() => {
        throw new Error('subscriber failed');
    });
    const healthy = service.watchSessionChanges(() => {
        delivered += 1;
    });
    try {
        assert.doesNotThrow(() => service.changePoll._onTimeout());
        assert.equal(delivered, 1);
    } finally {
        failing.dispose();
        healthy.dispose();
    }
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

test('CONVERSATION-TELEMETRY-001 Kimi surfaces the latest StatusUpdate context window usage', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    assert.equal(await adapter.readTelemetry(sessionId), undefined);

    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            timestamp: 5000,
            message: {
                type: 'StatusUpdate',
                payload: {
                    context_tokens: 107253.9,
                    max_context_tokens: 262144,
                },
            },
        }),
        JSON.stringify({
            timestamp: 6000,
            message: {
                type: 'StatusUpdate',
                payload: { context_usage: 0.5 },
            },
        }),
        JSON.stringify({
            timestamp: 7000,
            message: {
                type: 'StatusUpdate',
                payload: {
                    context_tokens: 120000,
                    max_context_tokens: 262144,
                },
            },
        }),
        '',
    ].join('\n'));

    assert.deepEqual(await adapter.readTelemetry(sessionId), {
        provider: 'kimi',
        sessionId,
        context: { usedTokens: 120000, maxTokens: 262144 },
        rateLimits: [],
    });

    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            timestamp: 8000,
            message: {
                type: 'StatusUpdate',
                payload: {
                    context_tokens: 131072,
                    max_context_tokens: 262144,
                },
            },
        })}\n`
    );
    assert.deepEqual(await adapter.readTelemetry(sessionId), {
        provider: 'kimi',
        sessionId,
        context: { usedTokens: 131072, maxTokens: 262144 },
        rateLimits: [],
    });
});

test('CONVERSATION-TELEMETRY-001 Kimi resolves the worktree from the newest Shell tool paths', async t => {
    const source = await createFixture(t);
    const calls = [];
    const adapter = createAdapter(source, {
        resolveWorktree: async candidate => {
            calls.push(candidate);
            return candidate === '/repo/.worktree/feat'
                ? {
                    branch: 'feat',
                    worktreeRoot: candidate,
                    repoRoot: '/repo',
                }
                : undefined;
        },
    });
    t.after(() => adapter.dispose());

    assert.equal(await adapter.readTelemetry(sessionId), undefined);

    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            timestamp: 5000,
            message: {
                type: 'ToolCall',
                payload: {
                    type: 'function',
                    id: 'Shell_1',
                    function: {
                        name: 'Shell',
                        arguments: JSON.stringify({
                            command: 'cd /repo && git status',
                        }),
                    },
                },
            },
        }),
        JSON.stringify({
            timestamp: 6000,
            message: {
                type: 'ToolCall',
                payload: {
                    type: 'function',
                    id: 'Shell_2',
                    function: {
                        name: 'Shell',
                        arguments: JSON.stringify({
                            command: 'cd /repo/.worktree/feat && ls /tmp',
                        }),
                    },
                },
            },
        }),
        JSON.stringify({
            timestamp: 7000,
            message: {
                type: 'ToolCall',
                payload: {
                    type: 'function',
                    id: 'Shell_3',
                    function: {
                        name: 'Shell',
                        arguments: '{malformed',
                    },
                },
            },
        }),
        '',
    ].join('\n'));

    const telemetry = await adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.worktree, {
        branch: 'feat',
        worktreeRoot: '/repo/.worktree/feat',
        repoRoot: '/repo',
    });
    assert.deepEqual(calls.slice(0, 2), ['/tmp', '/repo/.worktree/feat']);
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 CONVERSATION-PROGRESS-VISIBILITY-001 Kimi treats a tool preamble as progress and preserves the final answer', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Run the tests' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'I will run the tests.' },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ToolCall',
                payload: {
                    type: 'function',
                    id: 'Shell_0',
                    function: {
                        name: 'Shell',
                        arguments: JSON.stringify({ command: 'npm test' }),
                    },
                },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'Shell_0',
                    return_value: { is_error: false, output: '9 passing' },
                },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'All tests pass.' },
            },
        },
        {
            timestamp: 1005,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.equal(outline.totalInteractions, 1);
    assert.deepEqual(
        page.messages.map(message => [
            message.role,
            message.role === 'tool' ? message.tool.summary : message.markdown,
        ]),
        [
            ['user', 'Run the tests'],
            ['progress', 'I will run the tests.'],
            ['tool', 'Shell npm test'],
            ['assistant', 'All tests pass.'],
        ]
    );
    const tool = page.messages[2].tool;
    assert.equal(tool.name, 'Shell');
    assert.match(tool.detail, /"command":"npm test"/);
    assert.match(tool.detail, /9 passing/);
});

test('CONVERSATION-THINKING-VISIBILITY-001 Kimi merges streamed think deltas into one positioned thinking block', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Investigate the failure' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ContentPart',
                payload: { type: 'think', think: 'The user ' },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ContentPart',
                payload: { type: 'think', think: 'reported a failure.' },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'Let me look.' },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ContentPart',
                payload: { type: 'think', text: 'Second thought run.' },
            },
        },
        {
            timestamp: 1005,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'Found it.' },
            },
        },
        {
            timestamp: 1006,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    assert.deepEqual(
        page.messages.map(message => [
            message.role,
            message.role === 'thinking'
                ? message.thinking.text
                : message.markdown,
        ]),
        [
            ['user', 'Investigate the failure'],
            ['thinking', 'The user reported a failure.'],
            ['assistant', 'Let me look.'],
            ['thinking', 'Second thought run.'],
            ['assistant', 'Found it.'],
        ]
    );
});
