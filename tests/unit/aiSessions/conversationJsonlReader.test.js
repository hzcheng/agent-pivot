'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const reader = require('../../../out/aiSessions/conversation/jsonlReader');
const { CONVERSATION_LIMITS, ConversationAbortController } = require('../../../out/aiSessions/conversation/types');

async function createJsonlFixture(t, lines) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'conversation-jsonl-'));
    const sourcePath = path.join(directory, 'history.jsonl');
    await fs.promises.writeFile(sourcePath, lines.join(''));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    return {
        async open() {
            const handle = await fs.promises.open(sourcePath, 'r');
            const stat = await handle.stat();
            return {
                canonicalProviderHome: directory,
                canonicalPath: sourcePath,
                handle,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                identity: `fixture:${stat.size}:${stat.mtimeMs}`,
            };
        },
        append(contents) {
            return fs.promises.appendFile(sourcePath, contents);
        },
    };
}

test('SESSION-AI-SESSION-CONVERSATION-JSONL-001 bounds, resumes, and resets JSONL reads', async t => {
    const fixture = await createJsonlFixture(t, [
        '{"kind":"one"}\n',
        'malformed\n',
        '{"kind":"two"}\n',
    ]);
    const opened = await fixture.open();
    const activeController = new ConversationAbortController();
    const first = await reader.readConversationJsonl(opened, {
        startOffset: 0,
        signal: activeController.signal,
    });
    assert.deepEqual(first.records.map(record => record.value.kind), ['one', 'two']);
    assert.equal(first.malformedLines, 1);
    assert.equal(first.nextOffset, opened.size);
    await opened.handle.close();

    await fixture.append('{"kind":"three"}\n');
    const reopened = await fixture.open();
    const appended = await reader.readConversationJsonl(reopened, {
        startOffset: first.nextOffset,
    });
    assert.deepEqual(appended.records.map(record => record.value.kind), ['three']);

    const abortedController = new ConversationAbortController();
    abortedController.abort();
    await assert.rejects(
        reader.readConversationJsonl(reopened, { signal: abortedController.signal }),
        error => error.name === 'AbortError'
    );
    await reopened.handle.close();
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-002 keeps byte offsets across UTF-8 chunk boundaries and rejects oversized physical lines', async t => {
    const longPrefix = 'a'.repeat(CONVERSATION_LIMITS.readChunkBytes - 4);
    const oversized = 'b'.repeat(CONVERSATION_LIMITS.maxLineBytes + 1);
    const fixture = await createJsonlFixture(t, [
        `${longPrefix}{"kind":"first"}\n`,
        `${oversized}\n`,
        '{"kind":"last","emoji":"😀"}\n',
    ]);
    const source = await fixture.open();
    const result = await reader.readConversationJsonl(source, { startOffset: 0 });
    assert.deepEqual(result.records.map(record => record.value.kind), ['last']);
    assert.equal(result.oversizedLines, 1);
    assert.equal(result.records[0].offset, Buffer.byteLength(longPrefix) + Buffer.byteLength('{"kind":"first"}\n') + CONVERSATION_LIMITS.maxLineBytes + 2);
    await source.handle.close();
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-003 uses the exact 64 MiB boundary and discards only a bounded-start partial line', async t => {
    const fixture = await createJsonlFixture(t, ['x'.repeat(CONVERSATION_LIMITS.maxSourceBytes)]);
    const exact = await fixture.open();
    try {
        assert.equal(await reader.getConversationReadStart(exact), 0);
        const exactResult = await reader.readConversationJsonl(exact);
        assert.equal(exactResult.partial, false);
        assert.equal(exactResult.nextOffset, exact.size);
    } finally {
        await exact.handle.close();
    }

    await fixture.append('\n');
    const over = await fixture.open();
    try {
        assert.equal(await reader.getConversationReadStart(over), 1);
        const overResult = await reader.readConversationJsonl(over);
        assert.equal(overResult.partial, true);
        assert.deepEqual(overResult.records, []);
    } finally {
        await over.handle.close();
    }
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-005 resumes only a verified bounded continuation', async () => {
    const priorContents = 'a'.repeat(10);
    const priorHash = crypto.createHash('sha256').update(priorContents).digest('hex');
    const previous = {
        canonicalPath: '/provider/history.jsonl',
        size: 10,
        portableFirstHash: priorHash,
        portableLastHash: priorHash,
        handle: { async read() { return { bytesRead: 0 }; } },
    };
    const current = {
        ...previous,
        size: 20,
        handle: {
            async read(buffer, offset, length, position) {
                return { bytesRead: length, buffer: buffer.fill(position < 10 ? 'a' : 'b', offset, offset + length) };
            },
        },
    };
    assert.equal(await reader.getConversationReadStart(current, {
        source: previous,
        nextOffset: 10,
    }), 10);
    assert.equal(await reader.getConversationReadStart({ ...current, canonicalPath: '/provider/replaced.jsonl' }, {
        source: previous,
        nextOffset: 10,
    }), 0);
    assert.equal(await reader.getConversationReadStart(current, {
        source: previous,
        nextOffset: 21,
    }), 0);
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-006 rejects a checkpoint beyond the previous source', async () => {
    const priorContents = 'a'.repeat(10);
    const priorHash = crypto.createHash('sha256').update(priorContents).digest('hex');
    let continuationReads = 0;
    const previous = {
        canonicalPath: '/provider/history.jsonl',
        size: 10,
        portableFirstHash: priorHash,
        portableLastHash: priorHash,
        handle: { async read() { return { bytesRead: 0 }; } },
    };
    const current = {
        ...previous,
        size: 20,
        handle: {
            async read(buffer, offset, length) {
                continuationReads += 1;
                return { bytesRead: length, buffer: buffer.fill('a', offset, offset + length) };
            },
        },
    };
    assert.equal(await reader.getConversationReadStart(current, {
        source: previous,
        nextOffset: 11,
    }), 0);
    assert.equal(continuationReads, 0);
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-007 rejects a checkpoint below the current cold start', async () => {
    const edge = Buffer.alloc(64 * 1024, 'a');
    const edgeHash = crypto.createHash('sha256').update(edge).digest('hex');
    const previous = {
        canonicalPath: '/provider/history.jsonl',
        size: CONVERSATION_LIMITS.maxSourceBytes + 5,
        portableFirstHash: edgeHash,
        portableLastHash: edgeHash,
        handle: { async read() { return { bytesRead: 0 }; } },
    };
    let continuationReads = 0;
    const current = {
        ...previous,
        size: CONVERSATION_LIMITS.maxSourceBytes + 10,
        handle: {
            async read(buffer, offset, length) {
                continuationReads += 1;
                return { bytesRead: length, buffer: buffer.fill('a', offset, offset + length) };
            },
        },
    };
    const coldStart = 10;
    assert.equal(await reader.getConversationReadStart(current, {
        source: previous,
        nextOffset: coldStart - 1,
    }), coldStart);
    assert.equal(continuationReads, 0);
    assert.equal(await reader.getConversationReadStart(current, {
        source: previous,
        nextOffset: coldStart,
    }), coldStart);
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-004 reports timeout from the injected monotonic clock without an ambient timer', async () => {
    let clock = 0;
    const source = {
        size: Buffer.byteLength('{"kind":"late"}\n'),
        handle: {
            async read(buffer) {
                clock = CONVERSATION_LIMITS.jsonlScanTimeoutMs;
                return { bytesRead: buffer.length, buffer };
            },
        },
    };
    await assert.rejects(
        reader.readConversationJsonl(source, { now: () => clock }),
        error => error.name === 'ConversationError' && error.code === 'timeout'
    );
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-008 reports valid records to an internal callback in source order', async t => {
    const fixture = await createJsonlFixture(t, [
        '{"kind":"first"}\n',
        'malformed\n',
        '{"kind":"second"}\n',
    ]);
    const source = await fixture.open();
    const seen = [];
    try {
        const result = await reader.readConversationJsonl(source, {
            startOffset: 0,
            onRecord(record) {
                seen.push([record.offset, record.value.kind]);
            },
        });
        assert.deepEqual(seen, [
            [0, 'first'],
            [Buffer.byteLength('{"kind":"first"}\nmalformed\n'), 'second'],
        ]);
        assert.equal(result.malformedLines, 1);
    } finally {
        await source.handle.close();
    }
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-009 bounds inactive indexes while retaining viewed entries', () => {
    let now = 0;
    const disposed = [];
    const cache = new reader.ConversationIndexCache(() => now);
    const value = key => ({
        dispose() {
            disposed.push(key);
        },
    });
    cache.set('retained', value('retained'));
    const retained = cache.retain('retained');
    for (let index = 0; index < CONVERSATION_LIMITS.inactiveIndexLimitPerProvider + 1; index++) {
        now += 1;
        cache.set(`inactive-${index}`, value(`inactive-${index}`));
    }
    assert.deepEqual(disposed, ['inactive-0']);
    assert.ok(cache.get('retained'));

    retained.dispose();
    now += CONVERSATION_LIMITS.inactiveIndexTtlMs + 1;
    cache.set('fresh', value('fresh'));
    assert.equal(cache.get('retained'), undefined);
    assert.equal(disposed.includes('retained'), true);
    cache.clear();
    assert.equal(disposed.includes('fresh'), true);
});

test('SESSION-AI-SESSION-CONVERSATION-JSONL-010 expires inactive entries before get or retain can touch them', () => {
    let now = 0;
    const disposed = [];
    const cache = new reader.ConversationIndexCache(() => now);
    const value = key => ({
        dispose() {
            disposed.push(key);
        },
    });

    cache.set('get-expired', value('get-expired'));
    now += CONVERSATION_LIMITS.inactiveIndexTtlMs + 1;
    assert.equal(cache.get('get-expired'), undefined);
    assert.deepEqual(disposed, ['get-expired']);

    cache.set('retain-expired', value('retain-expired'));
    now += CONVERSATION_LIMITS.inactiveIndexTtlMs + 1;
    const expiredRetain = cache.retain('retain-expired');
    assert.equal(cache.get('retain-expired'), undefined);
    assert.deepEqual(disposed, ['get-expired', 'retain-expired']);
    expiredRetain.dispose();

    cache.set('active', value('active'));
    const retained = cache.retain('active');
    now += CONVERSATION_LIMITS.inactiveIndexTtlMs + 1;
    assert.ok(cache.get('active'));
    retained.dispose();
    now += CONVERSATION_LIMITS.inactiveIndexTtlMs + 1;
    assert.equal(cache.get('active'), undefined);
    assert.equal(disposed.includes('active'), true);
});
