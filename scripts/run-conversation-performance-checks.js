'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const {
    KimiConversationAdapter,
} = require('../out/aiSessions/conversation/kimiAdapter');
const {
    getConversationReadStart,
} = require('../out/aiSessions/conversation/jsonlReader');
const {
    buildConversationOutline,
} = require('../out/aiSessions/conversation/model');
const {
    openValidatedConversationSource,
} = require('../out/aiSessions/conversation/source');
const {
    CONVERSATION_LIMITS,
} = require('../out/aiSessions/conversation/types');

const MIB = 1024 * 1024;
const sessionId = '11111111-1111-4111-8111-111111111111';

function elapsedMs(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function eventLine(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function interactionBytes(index, assistantBytes = 32) {
    return Buffer.concat([
        eventLine({
            type: 'TurnBegin',
            timestamp: index,
            payload: { user_input: `Performance input ${index}` },
        }),
        eventLine({
            type: 'ContentPart',
            timestamp: index,
            payload: { type: 'text', text: 'a'.repeat(assistantBytes) },
        }),
        eventLine({ type: 'TurnEnd', timestamp: index }),
    ]);
}

function paddedFixture(buffers, targetBytes) {
    const size = buffers.reduce((total, buffer) => total + buffer.length, 0);
    assert.ok(size <= targetBytes, 'synthetic conversation must fit its target');
    let remaining = targetBytes - size;
    const emptyPaddingLine = eventLine({ type: 'Ignored', padding: '' });
    while (remaining >= emptyPaddingLine.length) {
        const lineBytes = Math.min(remaining, 900 * 1024);
        const paddingBytes = lineBytes - emptyPaddingLine.length;
        buffers.push(eventLine({
            type: 'Ignored',
            padding: 'p'.repeat(paddingBytes),
        }));
        remaining -= lineBytes;
    }
    if (remaining) {
        buffers.push(Buffer.alloc(remaining, 0x20));
    }
    return Buffer.concat(buffers);
}

function loadConversationViewer() {
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: { parse: value => ({ scheme: 'https', toString: () => value }) },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../out/aiSessions/conversation/viewer')
            .ConversationViewer;
    } finally {
        Module._load = previousLoad;
    }
}

function retainedViewerSnapshot() {
    const ConversationViewer = loadConversationViewer();
    const viewer = new ConversationViewer({});
    const padding = 'v'.repeat(48_000);
    viewer.selectedInteractionId = 'retained-100';
    viewer.pages = Array.from({ length: 101 }, (_item, index) => ({
        page: {
            provider: 'kimi',
            sessionId,
            sourceRevision: 'r1',
            anchorInteractionId: `retained-${index}`,
            messages: [{
                id: `retained-${index}:user`,
                interactionId: `retained-${index}`,
                role: 'user',
                markdown: padding,
            }],
            interactionStates: [{
                interactionId: `retained-${index}`,
                responseState: 'complete',
            }],
            isStart: index === 0,
            isEnd: index === 100,
        },
    }));
    viewer.evict();
    return {
        retainedInteractions: viewer.snapshotSize,
        retainedBytes: viewer.snapshotBytes(),
    };
}

async function run() {
    const root = await fs.promises.mkdtemp(path.join(
        os.tmpdir(),
        'steward-conversation-performance-'
    ));
    const providerHome = path.join(root, 'provider-home');
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    const boundaryPath = path.join(providerHome, 'boundary.jsonl');
    await fs.promises.mkdir(providerHome, { recursive: true });
    try {
        const fixture = paddedFixture(
            Array.from({ length: 1_000 }, (_item, index) =>
                interactionBytes(index)),
            10 * MIB
        );
        assert.equal(fixture.length, 10 * MIB);
        await fs.promises.writeFile(sourcePath, fixture);

        const adapter = new KimiConversationAdapter({
            resolveSource: () => ({ providerHome, sourcePath }),
            watchSessionChanges: () => ({ dispose() {} }),
            now: Date.now,
            setTimeout: global.setTimeout,
            clearTimeout: global.clearTimeout,
        });
        try {
            let startedAt = process.hrtime.bigint();
            let outline = await adapter.readOutline(sessionId);
            const coldMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_000);
            assert.ok(coldMs <= 1500,
                `cold outline ${coldMs}ms exceeds 1500ms`);

            startedAt = process.hrtime.bigint();
            outline = await adapter.readOutline(sessionId);
            const cachedMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_000);
            assert.ok(cachedMs <= 100,
                `cached outline ${cachedMs}ms exceeds 100ms`);

            const append = paddedFixture([
                interactionBytes(1_000, 60_000),
            ], MIB);
            assert.equal(append.length, MIB);
            await fs.promises.appendFile(sourcePath, append);
            startedAt = process.hrtime.bigint();
            outline = await adapter.readOutline(sessionId);
            const appendMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_001);
            assert.ok(appendMs <= 250,
                `append ${appendMs}ms exceeds 250ms`);
            assert.ok(outline.interactions.length <= 2000);

            const page = await adapter.readPage({
                provider: 'kimi',
                sessionId,
                anchorInteractionId: outline.interactions.at(-1).id,
                direction: 'around',
                expectedRevision: outline.sourceRevision,
            });
            const serializedPageBytes =
                Buffer.byteLength(JSON.stringify(page), 'utf8');
            assert.ok(serializedPageBytes <= 512 * 1024);

            const oversizedOutline = buildConversationOutline(
                'kimi',
                sessionId,
                'r-boundary',
                Array.from({ length: 2_001 }, (_item, index) => ({
                    id: `outline-${index}`,
                    userMarkdown: `input-${index}`,
                    userPreview: `input-${index}`,
                    userGraphemeCount: 10,
                    assistantMarkdown: [],
                    responseState: 'complete',
                })),
                false
            );
            assert.equal(oversizedOutline.totalInteractions, 2_001);
            assert.ok(oversizedOutline.interactions.length <= 2000);

            await fs.promises.writeFile(
                boundaryPath,
                Buffer.alloc(CONVERSATION_LIMITS.maxSourceBytes)
            );
            const boundary = await openValidatedConversationSource({
                providerHome,
                sourcePath: boundaryPath,
            });
            assert.ok(boundary);
            assert.equal(await getConversationReadStart(boundary), 0);
            await boundary.handle.close();
            await fs.promises.appendFile(boundaryPath, Buffer.from('\n'));
            const overBoundary = await openValidatedConversationSource({
                providerHome,
                sourcePath: boundaryPath,
            });
            assert.ok(overBoundary);
            assert.equal(await getConversationReadStart(overBoundary), 1);
            await overBoundary.handle.close();

            const retention = retainedViewerSnapshot();
            assert.ok(retention.retainedInteractions <= 100);
            assert.ok(retention.retainedBytes <= 4 * 1024 * 1024);

            console.log(JSON.stringify({
                coldMs: Number(coldMs.toFixed(3)),
                appendMs: Number(appendMs.toFixed(3)),
                cachedMs: Number(cachedMs.toFixed(3)),
                outlineInteractions: outline.interactions.length,
                serializedPageBytes,
                ...retention,
            }));
        } finally {
            adapter.dispose();
        }
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
