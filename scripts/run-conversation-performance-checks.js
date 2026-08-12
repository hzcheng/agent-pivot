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
    CodexConversationAdapter,
} = require('../out/aiSessions/conversation/codexAdapter');
const {
    getConversationReadStart,
    readConversationJsonl,
} = require('../out/aiSessions/conversation/jsonlReader');
const {
    openValidatedConversationSource,
} = require('../out/aiSessions/conversation/source');
const {
    CONVERSATION_LIMITS,
} = require('../out/aiSessions/conversation/types');

const MIB = 1024 * 1024;
const sessionId = '11111111-1111-4111-8111-111111111111';
const PERFORMANCE_BUDGETS = JSON.parse(fs.readFileSync(path.join(
    __dirname,
    '..',
    '.ci',
    'conversation-performance.json'
), 'utf8'));
const canonicalKimiFixturePath = path.join(
    __dirname,
    '..',
    'tests',
    'fixtures',
    'providers',
    'kimi',
    'home',
    'sessions',
    '7bbd38310db600bd89c814e224a73d44',
    '33333333-3333-4333-8333-333333333333',
    'wire.jsonl'
);

function elapsedMs(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function createCodexPerfThread(threadId, turns, textBytes) {
    return {
        thread: {
            id: threadId,
            turns: Array.from({ length: turns }, (_unused, index) => ({
                id: `perf-turn-${index}`,
                status: 'completed',
                items: [{
                    id: `perf-user-${index}`,
                    type: 'userMessage',
                    content: [{
                        type: 'text',
                        text: `Performance request ${index}`,
                    }],
                }, {
                    id: `perf-agent-${index}`,
                    type: 'agentMessage',
                    text: 'a'.repeat(textBytes),
                }],
            })),
        },
    };
}

async function measureCodexStatValidatedReload() {
    const threadId = '99999999-9999-4999-8999-999999999999';
    // ~12 MiB of normalized agent text across 205 turns mirrors the large
    // real thread/read payloads that dominate Codex switch latency.
    const payload = createCodexPerfThread(threadId, 205, 60 * 1024);
    let requests = 0;
    let signature = 'stat-1';
    const adapter = new CodexConversationAdapter({
        client: {
            async request(method, params) {
                requests += 1;
                assert.equal(method, 'thread/read');
                assert.equal(params.threadId, threadId);
                // Re-serialize per call so each full read pays a realistic
                // transport-shaped parse cost.
                return JSON.parse(JSON.stringify(payload));
            },
            dispose() {},
        },
        watchSessionChanges: () => ({ dispose() {} }),
        setTimeout: callback => {
            callback();
            return 1;
        },
        clearTimeout: () => undefined,
        readContentSignature: () => signature,
    });
    try {
        let startedAt = process.hrtime.bigint();
        const outline = await adapter.readOutline(threadId);
        const fullReadMs = elapsedMs(startedAt);
        assert.equal(outline.totalInteractions, 205);
        assert.equal(requests, 1);

        startedAt = process.hrtime.bigint();
        const cached = await adapter.readOutline(threadId);
        const statValidatedReloadMs = elapsedMs(startedAt);
        assert.equal(cached.sourceRevision, outline.sourceRevision);
        assert.equal(requests, 1,
            'an unchanged rollout stat must skip the provider read');
        assertBudget('codex stat-validated reload', statValidatedReloadMs,
            PERFORMANCE_BUDGETS.codexStatValidatedReloadMs);

        signature = 'stat-2';
        await adapter.readOutline(threadId);
        assert.equal(requests, 2,
            'a changed rollout stat forces a fresh thread/read');
        return { fullReadMs, statValidatedReloadMs };
    } finally {
        adapter.dispose();
    }
}

function eventLine(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function canonicalKimiTemplates() {
    const records = fs.readFileSync(canonicalKimiFixturePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map(line => JSON.parse(line));
    const byType = type => records.find(record =>
        record?.message?.type === type
        && (type !== 'ContentPart'
            || record.message.payload?.type === 'text'));
    const templates = {
        turnBegin: byType('TurnBegin'),
        contentPart: byType('ContentPart'),
        turnEnd: byType('TurnEnd'),
    };
    assert.ok(Object.values(templates).every(Boolean),
        'canonical Kimi provider fixture must contain visible turn records');
    return templates;
}

function canonicalEvent(template, timestamp, payload) {
    return {
        ...template,
        timestamp,
        message: {
            ...template.message,
            payload,
        },
    };
}

function interactionBytes(templates, index, assistantBytes = 32) {
    return Buffer.concat([
        eventLine(canonicalEvent(
            templates.turnBegin,
            index,
            { user_input: `Performance input ${index}` }
        )),
        eventLine(canonicalEvent(
            templates.contentPart,
            index,
            { type: 'text', text: 'a'.repeat(assistantBytes) }
        )),
        eventLine(canonicalEvent(templates.turnEnd, index, {})),
    ]);
}

function paddedFixture(buffers, targetBytes) {
    const size = buffers.reduce((total, buffer) => total + buffer.length, 0);
    assert.ok(size <= targetBytes, 'synthetic conversation must fit its target');
    let remaining = targetBytes - size;
    while (remaining) {
        let lineBytes = Math.min(remaining, 900 * 1024);
        if (remaining - lineBytes === 1) {
            lineBytes -= 1;
        }
        assert.ok(lineBytes >= 2,
            'padding must be expressible as a complete JSONL record');
        buffers.push(lineBytes === 2
            ? Buffer.from('0\n', 'utf8')
            : Buffer.from(`"${'p'.repeat(lineBytes - 3)}"\n`, 'utf8'));
        remaining -= lineBytes;
    }
    return Buffer.concat(buffers);
}

function createKimiAdapter(providerHome, sourcePath) {
    return new KimiConversationAdapter({
        resolveSource: () => ({ providerHome, sourcePath }),
        watchSessionChanges: () => ({ dispose() {} }),
        now: Date.now,
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout,
    });
}

function loadConversationViewer() {
    const fakeVscode = {
        ViewColumn: { Active: 1, Beside: 2 },
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
    const retainedInteractionIds = Array.from(
        { length: 101 },
        (_item, index) => `retained-${index}`
    );
    assert.equal(viewer.outlineController.replace({
        provider: 'kimi',
        sessionId,
        sourceRevision: 'r1',
        interactions: retainedInteractionIds.map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: 'complete',
        })),
        totalInteractions: retainedInteractionIds.length,
        partial: false,
    }, 'retained-100'), true);
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
        retainedAnchor: viewer.interactionIds().includes('retained-100'),
    };
}

function assertBudget(name, measuredMs, budgetMs) {
    assert.ok(Number.isFinite(budgetMs) && budgetMs > 0,
        `${name} budget must be a positive finite number`);
    assert.ok(measuredMs <= budgetMs,
        `${name} ${measuredMs.toFixed(3)}ms exceeds ${budgetMs}ms`);
}

function viewerTarget(targetSessionId) {
    return {
        projectId: 'performance-project',
        provider: 'kimi',
        sessionId: targetSessionId,
        interactionId: `${targetSessionId}-1999`,
        expectedRevision: 'r1',
        displayName: 'Performance Session',
        duplicateDisplayName: false,
    };
}

function performanceOutline(targetSessionId, revision) {
    return {
        provider: 'kimi',
        sessionId: targetSessionId,
        sourceRevision: revision,
        interactions: Array.from({ length: 2_000 }, (_item, index) => ({
            id: `${targetSessionId}-${index}`,
            userPreview: `Performance prompt ${index}`,
            userGraphemeCount: 23,
            responseState: index === 1_999 ? 'inProgress' : 'complete',
        })),
        totalInteractions: 2_000,
        partial: false,
    };
}

function performancePage(request, revision) {
    const firstIndex = 1_980;
    const interactionIds = Array.from(
        { length: CONVERSATION_LIMITS.maxPageInteractions },
        (_item, index) => `${request.sessionId}-${firstIndex + index}`
    );
    return {
        provider: 'kimi',
        sessionId: request.sessionId,
        sourceRevision: revision,
        anchorInteractionId: request.anchorInteractionId,
        messages: interactionIds.flatMap((interactionId, index) => [{
            id: `${interactionId}:user`,
            interactionId,
            role: 'user',
            markdown: `Performance prompt ${firstIndex + index}`,
        }, {
            id: `${interactionId}:assistant`,
            interactionId,
            role: 'assistant',
            markdown: `Performance response ${firstIndex + index} ${'x'.repeat(2_000)}`,
        }]),
        interactionStates: interactionIds.map(interactionId => ({
            interactionId,
            responseState: interactionId === request.anchorInteractionId
                ? 'inProgress'
                : 'complete',
        })),
        isStart: false,
        isEnd: true,
    };
}

function performancePanel() {
    const disposeListeners = new Set();
    return {
        visible: true,
        title: '',
        webview: {
            html: '',
            cspSource: 'performance-csp',
            onDidReceiveMessage() {
                return { dispose() {} };
            },
            postMessage() {
                return Promise.resolve(true);
            },
            asWebviewUri(uri) {
                return uri;
            },
        },
        reveal() {},
        onDidChangeViewState() {
            return { dispose() {} };
        },
        onDidDispose(listener) {
            disposeListeners.add(listener);
            return { dispose: () => disposeListeners.delete(listener) };
        },
        dispose() {
            Array.from(disposeListeners).forEach(listener => listener());
            disposeListeners.clear();
        },
    };
}

async function measureViewerPublicationBudgets() {
    // CONVERSATION-LARGE-SESSION-PERFORMANCE-001
    const ConversationViewer = loadConversationViewer();
    const panel = performancePanel();
    const revisions = new Map([
        ['large-session-a', 'r1'],
        ['large-session-b', 'r1'],
    ]);
    const viewer = new ConversationViewer({
        createPanel: () => panel,
        readOutline: async (_provider, targetSessionId) =>
            performanceOutline(targetSessionId, revisions.get(targetSessionId)),
        readPage: async request => performancePage(
            request,
            revisions.get(request.sessionId)
        ),
        watch: () => ({ dispose() {} }),
        restoreFocus() {},
        openExternal: async () => true,
        mediaUri: fileName => ({
            toString: () => `file:///performance/${fileName}`,
        }),
        submitPrompt: async () => {},
    });
    try {
        let startedAt = process.hrtime.bigint();
        await viewer.open(viewerTarget('large-session-a'));
        const hostInitialPublicationMs = elapsedMs(startedAt);
        assertBudget(
            'host initial publication',
            hostInitialPublicationMs,
            PERFORMANCE_BUDGETS.hostInitialPublicationMs
        );

        revisions.set('large-session-a', 'r2');
        startedAt = process.hrtime.bigint();
        await viewer.refresh();
        const hostIncrementalRefreshMs = elapsedMs(startedAt);
        assertBudget(
            'host incremental refresh',
            hostIncrementalRefreshMs,
            PERFORMANCE_BUDGETS.hostIncrementalRefreshMs
        );

        startedAt = process.hrtime.bigint();
        assert.equal(await viewer.follow(viewerTarget('large-session-b')), true);
        const hostSessionSwitchMs = elapsedMs(startedAt);
        assertBudget(
            'host Session switch',
            hostSessionSwitchMs,
            PERFORMANCE_BUDGETS.hostSessionSwitchMs
        );
        return {
            hostInitialPublicationMs,
            hostIncrementalRefreshMs,
            hostSessionSwitchMs,
        };
    } finally {
        viewer.dispose();
    }
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
        const templates = canonicalKimiTemplates();
        const fixture = paddedFixture(
            Array.from({ length: 1_000 }, (_item, index) =>
                interactionBytes(templates, index)),
            10 * MIB
        );
        assert.equal(fixture.length, 10 * MIB);
        await fs.promises.writeFile(sourcePath, fixture);

        const adapter = createKimiAdapter(providerHome, sourcePath);
        try {
            let startedAt = process.hrtime.bigint();
            let outline = await adapter.readOutline(sessionId);
            const coldMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_000);
            assertBudget('cold outline', coldMs,
                PERFORMANCE_BUDGETS.adapterColdOutlineMs);

            startedAt = process.hrtime.bigint();
            outline = await adapter.readOutline(sessionId);
            const cachedOutlineReadMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_000);
            assertBudget('cached adapter outline read', cachedOutlineReadMs,
                PERFORMANCE_BUDGETS.adapterCachedOutlineMs);

            const append = paddedFixture([
                interactionBytes(templates, 1_000, 60_000),
            ], MIB);
            assert.equal(append.length, MIB);
            await fs.promises.appendFile(sourcePath, append);
            startedAt = process.hrtime.bigint();
            outline = await adapter.readOutline(sessionId);
            const appendMs = elapsedMs(startedAt);
            assert.equal(outline.totalInteractions, 1_001);
            assertBudget('append', appendMs,
                PERFORMANCE_BUDGETS.adapterAppendMs);
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

            const boundaryFixture = paddedFixture(
                Array.from({ length: 2_001 }, (_item, index) =>
                    interactionBytes(templates, 10_000 + index)),
                CONVERSATION_LIMITS.maxSourceBytes
            );
            assert.equal(
                boundaryFixture.length,
                CONVERSATION_LIMITS.maxSourceBytes
            );
            await fs.promises.writeFile(boundaryPath, boundaryFixture);

            let boundary = await openValidatedConversationSource({
                providerHome,
                sourcePath: boundaryPath,
            });
            assert.ok(boundary);
            assert.equal(await getConversationReadStart(boundary), 0);
            startedAt = process.hrtime.bigint();
            let boundaryRead = await readConversationJsonl(boundary);
            const boundaryReaderMs = elapsedMs(startedAt);
            assert.equal(boundaryRead.malformedLines, 0);
            assert.equal(boundaryRead.oversizedLines, 0);
            assert.equal(boundaryRead.partial, false);
            assert.equal(
                boundaryRead.nextOffset,
                CONVERSATION_LIMITS.maxSourceBytes
            );
            assert.ok(boundaryRead.records.length >= 2_001 * 3);
            const boundaryRecords = boundaryRead.records.length;
            boundaryRead.records.length = 0;
            boundaryRead = undefined;
            await boundary.handle.close();

            const boundaryAdapter = createKimiAdapter(
                providerHome,
                boundaryPath
            );
            startedAt = process.hrtime.bigint();
            const boundaryOutline = await boundaryAdapter.readOutline(sessionId);
            const boundaryAdapterMs = elapsedMs(startedAt);
            assert.equal(boundaryOutline.partial, true);
            assert.equal(boundaryOutline.totalInteractions, 2_001);
            assert.equal(
                boundaryOutline.interactions.length,
                CONVERSATION_LIMITS.maxOutlineInteractions
            );
            boundaryAdapter.dispose();

            await fs.promises.appendFile(boundaryPath, Buffer.from('\n'));
            boundary = await openValidatedConversationSource({
                providerHome,
                sourcePath: boundaryPath,
            });
            assert.ok(boundary);
            assert.equal(
                boundary.size,
                CONVERSATION_LIMITS.maxSourceBytes + 1
            );
            assert.equal(await getConversationReadStart(boundary), 1);
            await boundary.handle.close();

            const oversizedAdapter = createKimiAdapter(
                providerHome,
                boundaryPath
            );
            startedAt = process.hrtime.bigint();
            const oversizedOutline =
                await oversizedAdapter.readOutline(sessionId);
            const oversizedAdapterMs = elapsedMs(startedAt);
            assert.equal(oversizedOutline.partial, true);
            assert.equal(oversizedOutline.totalInteractions, 2_000);
            assert.equal(
                oversizedOutline.interactions.length,
                CONVERSATION_LIMITS.maxOutlineInteractions
            );
            oversizedAdapter.dispose();

            const retention = retainedViewerSnapshot();
            assert.ok(retention.retainedInteractions <= 100);
            assert.ok(retention.retainedBytes <= 4 * 1024 * 1024);
            assert.equal(retention.retainedAnchor, true);
            const viewerBudgets = await measureViewerPublicationBudgets();
            const codexBudgets = await measureCodexStatValidatedReload();

            console.log(JSON.stringify({
                coldMs: Number(coldMs.toFixed(3)),
                appendMs: Number(appendMs.toFixed(3)),
                cachedOutlineReadMs:
                    Number(cachedOutlineReadMs.toFixed(3)),
                outlineInteractions: outline.interactions.length,
                serializedPageBytes,
                boundaryBytes: boundaryFixture.length,
                boundaryRecords,
                boundaryReaderMs: Number(boundaryReaderMs.toFixed(3)),
                boundaryAdapterMs: Number(boundaryAdapterMs.toFixed(3)),
                oversizedAdapterMs:
                    Number(oversizedAdapterMs.toFixed(3)),
                boundaryOutlineInteractions:
                    boundaryOutline.totalInteractions,
                oversizedOutlineInteractions:
                    oversizedOutline.totalInteractions,
                hostInitialPublicationMs: Number(
                    viewerBudgets.hostInitialPublicationMs.toFixed(3)
                ),
                hostIncrementalRefreshMs: Number(
                    viewerBudgets.hostIncrementalRefreshMs.toFixed(3)
                ),
                hostSessionSwitchMs: Number(
                    viewerBudgets.hostSessionSwitchMs.toFixed(3)
                ),
                codexFullReadMs: Number(codexBudgets.fullReadMs.toFixed(3)),
                codexStatValidatedReloadMs: Number(
                    codexBudgets.statValidatedReloadMs.toFixed(3)
                ),
                ...retention,
            }));
        } finally {
            adapter.dispose();
        }
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}

module.exports = {
    assertBudget,
    measureViewerPublicationBudgets,
    retainedViewerSnapshot,
};
