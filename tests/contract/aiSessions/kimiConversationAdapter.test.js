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

async function createKimiCodeFixture(t) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-code-conversation-')
    );
    const sessionId = 'session_22222222-2222-4222-8222-222222222222';
    const cwd = '/fixtures/kimi-code-project';
    const sessionDir = path.join(
        providerHome,
        'sessions',
        'wd_kimi-code-project_0123456789ab',
        sessionId
    );
    const sourcePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(path.join(providerHome, 'session_index.jsonl'),
        `${JSON.stringify({ sessionId, sessionDir, workDir: cwd })}\n`);
    await fs.promises.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify({
        id: sessionId,
        cwd,
        title: 'Kimi Code conversation',
        archived: false,
    }));
    await fs.promises.writeFile(sourcePath, [
        {
            type: 'turn.prompt',
            agentId: 'main',
            input: [{ type: 'text', text: 'Show the Kimi Code conversation.' }],
            origin: { kind: 'user' },
            time: 1_784_073_611_000,
        },
        {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: { type: 'step.begin', uuid: 'step-start', turnId: '1', step: 1 },
            time: 1_784_073_611_001,
        },
        {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: {
                type: 'content.part',
                uuid: 'text-part',
                turnId: '1',
                step: 1,
                stepUuid: 'step-start',
                part: { type: 'text', text: 'Kimi Code response.' },
            },
            time: 1_784_073_611_002,
        },
        {
            type: 'context.append_loop_event',
            agentId: 'main',
            event: {
                type: 'step.end',
                uuid: 'step-end',
                turnId: '1',
                step: 1,
                finishReason: 'stop',
            },
            time: 1_784_073_611_003,
        },
        {
            type: 'turn.ended',
            agentId: 'main',
            turnId: 1,
            reason: 'completed',
            time: 1_784_073_611_004,
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    return { providerHome, sessionId, cwd, sourcePath };
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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Kimi Code discovers and renders its main-agent wire transcript', async t => {
    const fixture = await createKimiCodeFixture(t);
    const previousHome = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = fixture.providerHome;
    t.after(() => {
        if (previousHome === undefined) delete process.env.KIMI_SHARE_DIR;
        else process.env.KIMI_SHARE_DIR = previousHome;
    });
    const service = new KimiSessionService();
    const sessions = service.getSessions({ forceRefresh: true, candidatePaths: [fixture.cwd] });
    assert.equal(sessions.available, true);
    assert.deepEqual(sessions.sessions.map(session => ({
        id: session.id,
        name: session.name,
        cwd: session.cwd,
    })), [{
        id: fixture.sessionId,
        name: 'Kimi Code conversation',
        cwd: fixture.cwd,
    }]);
    const source = service.resolveConversationSource(fixture.sessionId);
    assert.equal(source?.sourcePath, fixture.sourcePath);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const outline = await adapter.readOutline(fixture.sessionId);
    assert.equal(outline.interactions.length, 1);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId: fixture.sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(page.messages.map(message => message.markdown), [
        'Show the Kimi Code conversation.',
        'Kimi Code response.',
    ]);
});

async function restartSuffix(t, sourcePath, offset) {
    const bytes = await fs.promises.readFile(sourcePath);
    const suffixPath = path.join(path.dirname(sourcePath), 'restart-suffix.jsonl');
    // JSONL offsets are byte offsets. Newlines preserve each later record's
    // original offset while remaining harmless malformed blank records.
    await fs.promises.writeFile(suffixPath, Buffer.concat([
        Buffer.alloc(offset, 0x0a),
        bytes.subarray(offset),
    ]));
    t.after(() => fs.promises.rm(suffixPath, { force: true }));
    return suffixPath;
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

test('CONVERSATION-HISTORY-RESTART-POINT-001 Kimi restart points replay their interaction suffix from empty state', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const full = await readWholeConversation(adapter);
    const restartSnapshot = await adapter.getHistoryRestartPoints(sessionId);
    assert.ok(restartSnapshot);
    const { points } = restartSnapshot;
    assert.ok(points.length >= 2);
    for (const point of points) {
        const start = full.outline.interactions.findIndex(
            item => item.id === point.interactionId
        );
        assert.ok(start >= 0);
        const suffixPath = await restartSuffix(t, source.sourcePath, point.offset);
        const suffixAdapter = createAdapter({
            providerHome: source.providerHome,
            sourcePath: suffixPath,
        });
        t.after(() => suffixAdapter.dispose());
        const suffix = await readWholeConversation(suffixAdapter);
        const suffixInteractionIds = new Set(
            full.outline.interactions.slice(start).map(item => item.id)
        );
        assert.deepEqual(
            suffix.outline.interactions,
            full.outline.interactions.slice(start)
        );
        assert.deepEqual(
            {
                messages: suffix.page.messages,
                interactionStates: suffix.page.interactionStates,
            },
            {
                messages: full.page.messages.filter(message =>
                    suffixInteractionIds.has(message.interactionId)
                ),
                interactionStates: full.page.interactionStates.filter(state =>
                    suffixInteractionIds.has(state.interactionId)
                ),
            }
        );
    }
});

test('CONVERSATION-HISTORY-INDEX-SLICE-001 Kimi advances immutable history slices only between proven restart points', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const full = await readWholeConversation(adapter);
    const snapshot = await adapter.getHistoryRestartPoints(sessionId);
    assert.ok(snapshot);

    const interactionIds = [];
    let startOffset = 0;
    for (;;) {
        const slice = await adapter.readHistoryIndexSlice(sessionId, {
            ...snapshot,
            startOffset,
        });
        assert.ok(slice);
        interactionIds.push(...slice.interactions.map(item => item.id));
        if (slice.complete) {
            assert.equal(slice.nextOffset, undefined);
            break;
        }
        assert.ok(Number.isSafeInteger(slice.nextOffset));
        assert.ok(slice.nextOffset > startOffset);
        startOffset = slice.nextOffset;
    }
    assert.deepEqual(interactionIds, full.outline.interactions.map(item => item.id));
    assert.deepEqual(
        (await adapter.readOutline(sessionId)).interactions,
        full.outline.interactions,
        'background replay must not mutate the foreground cache'
    );
    await fs.promises.appendFile(source.sourcePath, '\n');
    assert.equal(await adapter.readHistoryIndexSlice(sessionId, {
        ...snapshot,
        startOffset: 0,
    }), undefined, 'a changed source snapshot must reject a late slice');
});

test('CONVERSATION-HISTORY-INDEX-SLICE-003 Kimi proves a multi-slice prefix from the parsed bytes', async t => {
    const source = await createFixture(t);
    const filler = index => ({
        timestamp: index,
        message: { type: 'StatusUpdate', payload: { text: 'x'.repeat(4096) } },
    });
    await fs.promises.writeFile(source.sourcePath, [
        { timestamp: 1, message: { type: 'TurnBegin', payload: { user_input: 'first' } } },
        ...Array.from({ length: 1_100 }, (_value, index) => filler(index)),
        { timestamp: 2, message: { type: 'TurnBegin', payload: { user_input: 'second' } } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    await adapter.readOutline(sessionId);
    const snapshot = await adapter.getHistoryRestartPoints(sessionId);
    const first = await adapter.readHistoryIndexSlice(sessionId, {
        ...snapshot,
        startOffset: 0,
    });
    assert.equal(first.complete, false);
    assert.ok(first.restartRecordEndOffset > first.nextOffset, JSON.stringify(first));
    assert.ok(first.restartRecordDigest);
    assert.ok(first.restartSegmentDigest);
    const second = await adapter.readHistoryIndexSlice(sessionId, {
        ...snapshot,
        startOffset: first.nextOffset,
    });
    assert.equal(second.complete, true);
    assert.deepEqual(
        [...first.interactions, ...second.interactions].map(item => item.userMarkdown),
        ['first', 'second']
    );
    // Exercise the real low-priority scheduler as well as the slice protocol:
    // a completed index must replace the bounded foreground source atomically.
    adapter.startHistoryIndex(sessionId, {
        interactions: [],
        sourceRevision: (await adapter.readOutline(sessionId)).sourceRevision,
        partial: true,
        telemetryPaths: [],
    }, true);
    for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (adapter.historyIndex.state(sessionId)?.complete) {
            break;
        }
    }
    assert.equal(adapter.historyIndex.state(sessionId)?.complete, true,
        JSON.stringify(adapter.historyIndex.state(sessionId)));
    assert.deepEqual((await adapter.readOutline(sessionId)).interactions
        .map(item => item.userPreview), ['first', 'second']);
    await fs.promises.appendFile(source.sourcePath, '\n');
    await adapter.readOutline(sessionId);
    assert.ok((await adapter.getHistoryRestartPoints(
        sessionId,
        adapter.historyIndex.state(sessionId)
    ))?.continuationOf, 'a complete final proof must continue after an append');
});

test('CONVERSATION-HISTORY-INDEX-SLICE-002 Kimi preserves an active EOF interaction while indexing', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Still working' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'Partial answer' },
            },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    await adapter.readOutline(sessionId);
    const snapshot = await adapter.getHistoryRestartPoints(sessionId);
    const slice = await adapter.readHistoryIndexSlice(sessionId, {
        ...snapshot,
        startOffset: 0,
    });
    assert.equal(slice.complete, true);
    assert.equal(slice.interactions.at(-1).responseState, 'inProgress');
    assert.deepEqual(slice.interactions.at(-1).assistantMarkdown, ['Partial answer']);
});

test('CONVERSATION-HISTORY-RESTART-POINT-003 Kimi seals an unsettled tool call before a later turn', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Start the tool call' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'pending-tool',
                    function: { name: 'Shell', arguments: '{"command":"pwd"}' },
                },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'pending-question',
                    function: {
                        name: 'AskUserQuestion',
                        arguments: JSON.stringify({
                            questions: [{ question: 'Continue?' }],
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ApprovalRequest',
                payload: {
                    id: 'pending-approval',
                    tool_call_id: 'pending-tool',
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Must replay from before the tool' },
            },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    await adapter.readOutline(sessionId);
    const points = (await adapter.getHistoryRestartPoints(sessionId)).points;
    assert.equal(points.length, 2);
    assert.equal(points[0].offset, 0);
    assert.ok(points[1].offset > points[0].offset);
});

test('CONVERSATION-HISTORY-RESTART-POINT-004 Kimi keeps restart points across a verified non-turn append', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    await adapter.readOutline(sessionId);
    const before = await adapter.getHistoryRestartPoints(sessionId);
    assert.ok(before?.points.length);
    await fs.promises.appendFile(source.sourcePath, `${JSON.stringify({
        timestamp: 9999,
        message: { type: 'StatusUpdate', payload: {} },
    })}\n`);
    await adapter.readOutline(sessionId);
    const after = await adapter.getHistoryRestartPoints(sessionId);
    assert.ok(after);
    assert.notEqual(after.sourceIdentity, before.sourceIdentity);
    assert.deepEqual(after.points, before.points);
});

test('CONVERSATION-HISTORY-RESTART-POINT-005 Kimi drops a rewritten middle-record point before an append promotion', async t => {
    const source = await createFixture(t);
    const filler = index => ({
        timestamp: 1000 + index,
        message: {
            type: 'StatusUpdate',
            payload: { filler: 'x'.repeat(2048) },
        },
    });
    const records = [
        {
            timestamp: 1,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'First restart point' },
            },
        },
        ...Array.from({ length: 40 }, (_value, index) => filler(index)),
        {
            timestamp: 2,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Rewrite me' },
            },
        },
        ...Array.from({ length: 40 }, (_value, index) => filler(index + 40)),
    ];
    const initial = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
    assert.ok(Buffer.byteLength(initial) > 128 * 1024);
    await fs.promises.writeFile(source.sourcePath, initial);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    await adapter.readOutline(sessionId);
    const before = await adapter.getHistoryRestartPoints(sessionId);
    assert.equal(before?.points.length, 2);
    const rewritten = initial.replace('Rewrite me', 'Changed!!!');
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(initial));
    await fs.promises.writeFile(source.sourcePath, rewritten);
    await fs.promises.appendFile(source.sourcePath, `${JSON.stringify(filler(99))}\n`);
    await adapter.readOutline(sessionId);
    const after = await adapter.getHistoryRestartPoints(sessionId);
    assert.ok(after);
    assert.notEqual(after.sourceIdentity, before.sourceIdentity);
    assert.deepEqual(after.points, [before.points[0]]);
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Kimi merges streamed text deltas into one block across incremental loads', async t => {
    const source = await createFixture(t);
    // The Kimi wire streams token-sized text deltas interleaved with empty
    // think parts; each delta must not become its own rendered line.
    const deltaRecords = chunks => chunks.flatMap(chunk => [
        JSON.stringify({
            timestamp: 4000,
            message: { type: 'ContentPart', payload: { type: 'think', think: '' } },
        }),
        JSON.stringify({
            timestamp: 4000,
            message: { type: 'ContentPart', payload: { type: 'text', text: chunk } },
        }),
    ]);
    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            timestamp: 4000,
            message: { type: 'TurnBegin', payload: { user_input: 'stream' } },
        }),
        ...deltaRecords(['**', '3', 'c']),
        '',
    ].join('\n'));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const readLastPage = async () => {
        const outline = await adapter.readOutline(sessionId);
        const page = await adapter.readPage({
            provider: 'kimi',
            sessionId,
            anchorInteractionId: outline.interactions.at(-1).id,
            direction: 'around',
        });
        const lastId = outline.interactions.at(-1).id;
        return page.messages.filter(message => message.interactionId === lastId);
    };
    const firstMessages = await readLastPage();
    assert.deepEqual(
        firstMessages.filter(message => message.role === 'assistant')
            .map(message => message.markdown),
        ['**3c'],
        'a partial delta run still renders as one block'
    );

    await fs.promises.appendFile(source.sourcePath, [
        ...deltaRecords([' ', '完成', '**']),
        JSON.stringify({
            timestamp: 4001,
            message: { type: 'TurnEnd', payload: {} },
        }),
        '',
    ].join('\n'));
    const secondMessages = await readLastPage();
    assert.deepEqual(
        secondMessages.filter(message => message.role === 'assistant')
            .map(message => message.markdown),
        ['**3c 完成**'],
        'deltas merge across incremental loads and whitespace-only deltas survive'
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Kimi surfaces PlanDisplay markdown as plan blocks', async t => {
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
                payload: {
                    content: '# Rollout Plan\n\n## v1 steps',
                    file_path: '/home/user/.kimi/plans/rollout.md',
                },
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
        page.messages.map(message => message.role),
        ['user', 'plan', 'assistant', 'plan', 'user']
    );
    assert.deepEqual(page.messages[1].plan, {
        markdown: '# Rollout Plan\n\n## v1 steps',
        filePath: '/home/user/.kimi/plans/rollout.md',
    });
    assert.deepEqual(page.messages[3].plan, {
        markdown: '# Rollout Plan\n\n## v2 steps',
    });
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Kimi replays ExitPlanMode plan approval with the settled option', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Refactor the parser' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'ExitPlanMode_7',
                    function: {
                        name: 'ExitPlanMode',
                        arguments: JSON.stringify({
                            options: [
                                { label: 'OptionA' },
                                { label: 'OptionB' },
                            ],
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'PlanDisplay',
                payload: { content: '# Parser Refactor Plan' },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'QuestionRequest',
                payload: {
                    id: 'req-1',
                    tool_call_id: 'ExitPlanMode_7',
                    questions: [{
                        question: 'Approve this plan',
                        header: 'Plan',
                        options: [
                            { label: 'OptionA', description: 'All at once' },
                            { label: 'OptionB', description: 'Staged' },
                        ],
                        multi_select: false,
                        other_label: 'Revise',
                        other_description: 'Stay in plan mode',
                    }],
                },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'ExitPlanMode_7',
                    return_value: {
                        is_error: false,
                        output: 'Plan approved by user. Selected approach: "OptionA"\nPlan mode deactivated.',
                    },
                },
            },
        },
        {
            timestamp: 1005,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => message.role),
        ['user', 'plan', 'question']
    );
    assert.deepEqual(page.messages[1].plan, {
        markdown: '# Parser Refactor Plan',
    });
    assert.deepEqual(page.messages[2].question, {
        source: 'ExitPlanMode',
        questions: [{
            question: 'Approve this plan',
            header: 'Plan',
            options: [
                { label: 'OptionA', description: 'All at once' },
                { label: 'OptionB', description: 'Staged' },
            ],
            multiSelect: false,
            otherLabel: 'Revise',
            answers: ['OptionA'],
        }],
        outcome: 'approved',
    });
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Kimi replays AskUserQuestion answers including multi-select splits', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Ask me things' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'QuestionRequest',
                payload: {
                    id: 'req-2',
                    tool_call_id: 'AskUserQuestion_3',
                    questions: [
                        {
                            question: 'Pick one',
                            header: 'Choice',
                            options: [{ label: 'A' }, { label: 'B' }],
                            multi_select: false,
                        },
                        {
                            question: 'Pick many',
                            header: '',
                            options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
                            multi_select: true,
                        },
                    ],
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'AskUserQuestion_3',
                    return_value: {
                        is_error: false,
                        output: JSON.stringify({
                            answers: {
                                'Pick one': 'B',
                                'Pick many': 'X, Y',
                            },
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1003,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => message.role),
        ['user', 'question']
    );
    assert.deepEqual(page.messages[1].question, {
        source: 'AskUserQuestion',
        questions: [
            {
                question: 'Pick one',
                header: 'Choice',
                options: [{ label: 'A' }, { label: 'B' }],
                multiSelect: false,
                answers: ['B'],
            },
            {
                question: 'Pick many',
                options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
                multiSelect: true,
                answers: ['X', 'Y'],
            },
        ],
        outcome: 'answered',
    });
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Kimi settles a question when the ToolResult lands in a later incremental load', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Refactor the parser' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'ExitPlanMode_9',
                    function: {
                        name: 'ExitPlanMode',
                        arguments: JSON.stringify({
                            options: [{ label: 'OptionA' }, { label: 'OptionB' }],
                        }),
                    },
                },
            },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const first = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        first.messages.map(message => message.role),
        ['user', 'question']
    );
    assert.equal(first.messages[1].question.outcome, undefined);
    assert.deepEqual(first.messages[1].question.questions, [{
        question: 'Approve this plan',
        options: [{ label: 'OptionA' }, { label: 'OptionB' }],
        multiSelect: false,
    }]);

    await fs.promises.appendFile(source.sourcePath, [
        {
            timestamp: 1002,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'ExitPlanMode_9',
                    return_value: {
                        is_error: false,
                        output: 'User wants to revise the plan: narrow the scope.',
                    },
                },
            },
        },
        {
            timestamp: 1003,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const updated = await adapter.readOutline(sessionId);
    const second = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: updated.interactions[0].id,
        direction: 'around',
        expectedRevision: updated.sourceRevision,
    });
    assert.deepEqual(
        second.messages.map(message => message.role),
        ['user', 'question']
    );
    assert.equal(second.messages[1].question.outcome, 'revised');
    assert.equal(
        second.messages[1].question.questions[0].answers,
        undefined
    );
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Kimi keeps a generic tool call when arguments carry no question data and drops orphan QuestionRequests', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'QuestionRequest',
                payload: {
                    id: 'req-orphan',
                    tool_call_id: 'AskUserQuestion_1',
                    questions: [{
                        question: 'Orphan question',
                        options: [{ label: 'A' }],
                        multi_select: false,
                    }],
                },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Plan something' },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'ExitPlanMode_11',
                    function: { name: 'ExitPlanMode', arguments: '{}' },
                },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'QuestionRequest',
                payload: {
                    id: 'req-3',
                    tool_call_id: 'ExitPlanMode_11',
                    questions: [{
                        question: 'Approve this plan',
                        options: [{ label: 'Go' }, { label: 'Stop' }],
                        multi_select: false,
                    }],
                },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'ExitPlanMode_11',
                    return_value: {
                        is_error: false,
                        output: 'User dismissed without choosing an option.',
                    },
                },
            },
        },
        {
            timestamp: 1005,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    assert.equal(outline.interactions.length, 1);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.deepEqual(
        page.messages.map(message => message.role),
        ['user', 'tool', 'question']
    );
    assert.equal(page.messages[1].tool.name, 'ExitPlanMode');
    assert.deepEqual(page.messages[2].question, {
        source: 'ExitPlanMode',
        questions: [{
            question: 'Approve this plan',
            options: [{ label: 'Go' }, { label: 'Stop' }],
            multiSelect: false,
        }],
        outcome: 'dismissed',
    });
});

test('CONVERSATION-DIFF-VISIBILITY-001 Kimi attaches approval preview diffs to the gated tool call and records the decision', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Patch the config' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_edit_1',
                    function: {
                        name: 'WriteFile',
                        arguments: JSON.stringify({ path: '/work/config.toml' }),
                    },
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ApprovalRequest',
                payload: {
                    id: 'approval-1',
                    tool_call_id: 'tool_edit_1',
                    sender: 'WriteFile',
                    action: 'edit file',
                    description: 'Edit /work/config.toml',
                    display: [{
                        type: 'diff',
                        path: '/work/config.toml',
                        old_text: 'level = "info"',
                        new_text: 'level = "debug"',
                    }],
                },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'ApprovalResponse',
                payload: {
                    request_id: 'approval-1',
                    response: 'approve_for_session',
                },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: 'tool_edit_1',
                    return_value: { is_error: false, output: 'written' },
                },
            },
        },
        {
            timestamp: 1005,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    const tools = page.messages.filter(message => message.role === 'tool');
    assert.equal(tools.length, 1, 'approval must not duplicate the gated call');
    assert.equal(tools[0].tool.name, 'WriteFile');
    assert.deepEqual(tools[0].tool.diffs, [{
        path: '/work/config.toml',
        kind: 'update',
        additions: 1,
        deletions: 1,
        hunks: [{
            lines: [
                { type: 'del', text: 'level = "info"' },
                { type: 'add', text: 'level = "debug"' },
            ],
        }],
    }]);
    assert.match(tools[0].tool.detail, /Approval: approve_for_session/);
    assert.match(tools[0].tool.detail, /written/);
});

test('CONVERSATION-DIFF-VISIBILITY-001 Kimi renders an orphan approval as its own entry and settles it in a later incremental load', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Delete the cache' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ApprovalRequest',
                payload: {
                    id: 'approval-2',
                    tool_call_id: 'tool_shell_9',
                    sender: 'Shell',
                    action: 'run command',
                    description: 'Run command `rm -rf .cache`',
                    display: [{
                        type: 'diff',
                        path: '/work/.cache/entries',
                        old_text: 'a\nb',
                        new_text: '',
                    }],
                },
            },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const first = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    const orphan = first.messages.find(message => message.role === 'tool');
    assert.equal(orphan.tool.name, 'Shell');
    assert.match(orphan.tool.summary, /rm -rf \.cache/);
    assert.equal(orphan.tool.diffs.length, 1);
    assert.equal(orphan.tool.diffs[0].deletions, 2);
    assert.equal(orphan.tool.detail, undefined);

    await fs.promises.appendFile(source.sourcePath, [
        {
            timestamp: 1002,
            message: {
                type: 'ApprovalResponse',
                payload: { request_id: 'approval-2', response: 'reject', feedback: 'too risky' },
            },
        },
        {
            timestamp: 1003,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const updated = await adapter.readOutline(sessionId);
    const second = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: updated.interactions[0].id,
        direction: 'around',
        expectedRevision: updated.sourceRevision,
    });
    const settled = second.messages.find(message => message.role === 'tool');
    assert.match(settled.tool.detail, /Approval: reject — too risky/);
});

test('CONVERSATION-DIFF-VISIBILITY-001 Kimi synthesizes diffs from WriteFile and StrReplaceFile arguments', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Edit some files' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_write_1',
                    function: {
                        name: 'WriteFile',
                        arguments: JSON.stringify({
                            path: '/work/notes.md',
                            content: '# Notes\n\nfirst line\n',
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_append_1',
                    function: {
                        name: 'WriteFile',
                        arguments: JSON.stringify({
                            path: '/work/notes.md',
                            content: 'appended line\n',
                            mode: 'append',
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1003,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_edit_1',
                    function: {
                        name: 'StrReplaceFile',
                        arguments: JSON.stringify({
                            path: '/work/config.toml',
                            edit: [
                                { old: 'a = 1', new: 'a = 2' },
                                { old: 'b = 1', new: 'b = 2' },
                            ],
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1004,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_edit_2',
                    function: {
                        name: 'StrReplaceFile',
                        arguments: JSON.stringify({
                            path: '/work/single.toml',
                            edit: { old: 'x', new: 'y' },
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1005,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_edit_3',
                    function: {
                        name: 'StrReplaceFile',
                        arguments: JSON.stringify({ path: '/work/broken.toml' }),
                    },
                },
            },
        },
        {
            timestamp: 1006,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    const tools = page.messages.filter(message => message.role === 'tool');
    assert.equal(tools.length, 5);

    assert.deepEqual(tools[0].tool.diffs, [{
        path: '/work/notes.md',
        kind: 'add',
        additions: 3,
        deletions: 0,
        hunks: [{
            lines: [
                { type: 'add', text: '# Notes' },
                { type: 'add', text: '' },
                { type: 'add', text: 'first line' },
            ],
        }],
    }]);
    assert.equal(tools[0].tool.detail, undefined);

    assert.equal(tools[1].tool.diffs[0].kind, 'update');
    assert.deepEqual(tools[1].tool.diffs[0].hunks[0].lines, [
        { type: 'add', text: 'appended line' },
    ]);

    assert.equal(tools[2].tool.diffs.length, 1);
    assert.equal(tools[2].tool.diffs[0].hunks.length, 2);
    assert.deepEqual(tools[2].tool.diffs[0].hunks[0].lines, [
        { type: 'del', text: 'a = 1' },
        { type: 'add', text: 'a = 2' },
    ]);
    assert.deepEqual(tools[2].tool.diffs[0].hunks[1].lines, [
        { type: 'del', text: 'b = 1' },
        { type: 'add', text: 'b = 2' },
    ]);
    assert.equal(tools[2].tool.diffs[0].additions, 2);
    assert.equal(tools[2].tool.diffs[0].deletions, 2);

    assert.deepEqual(tools[3].tool.diffs[0].hunks[0].lines, [
        { type: 'del', text: 'x' },
        { type: 'add', text: 'y' },
    ]);

    // No usable edit pairs: generic raw-JSON rendering survives.
    assert.equal(tools[4].tool.diffs, undefined);
    assert.match(tools[4].tool.detail, /broken\.toml/);
});

test('CONVERSATION-DIFF-VISIBILITY-001 Kimi approval preview diffs supersede argument-synthesized ones', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: 'Write with approval' },
            },
        },
        {
            timestamp: 1001,
            message: {
                type: 'ToolCall',
                payload: {
                    id: 'tool_write_9',
                    function: {
                        name: 'WriteFile',
                        arguments: JSON.stringify({
                            path: '/work/doc.md',
                            content: 'from arguments',
                        }),
                    },
                },
            },
        },
        {
            timestamp: 1002,
            message: {
                type: 'ApprovalRequest',
                payload: {
                    id: 'approval-9',
                    tool_call_id: 'tool_write_9',
                    sender: 'WriteFile',
                    action: 'edit file',
                    description: 'Edit /work/doc.md',
                    display: [{
                        type: 'diff',
                        path: '/work/doc.md',
                        old_text: 'original line',
                        new_text: 'from approval preview',
                    }],
                },
            },
        },
        {
            timestamp: 1003,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    const tool = page.messages.find(message => message.role === 'tool');
    assert.deepEqual(tool.tool.diffs, [{
        path: '/work/doc.md',
        kind: 'update',
        additions: 1,
        deletions: 1,
        hunks: [{
            lines: [
                { type: 'del', text: 'original line' },
                { type: 'add', text: 'from approval preview' },
            ],
        }],
    }]);
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
            ['plan', ''],
            ['assistant', 'The parser normalizes visible text.'],
        ]
    );
    assert.equal(
        page.messages[2].plan.markdown,
        '# Subagent Plan\n\n- inspect files'
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
    assert.equal(
        service.resolveConversationSource(liveSessionId).cwd,
        '/fixtures/other',
        'the real Kimi work-dir hash must resolve back to its Session cwd'
    );
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

test('CONVERSATION-TELEMETRY-001 Kimi resolves the worktree from Shell cwd signals without mistaking referenced files for cwd', async t => {
    const source = await createFixture(t);
    const calls = [];
    const adapter = createAdapter(source, {
        resolveWorktree: async candidate => {
            calls.push(candidate);
            return candidate.startsWith('/repo/.worktree/feat')
                ? {
                    branch: 'feat',
                    worktreeRoot: '/repo/.worktree/feat',
                    repoRoot: '/repo',
                }
                : candidate.startsWith('/repo')
                    ? {
                        branch: 'main',
                        worktreeRoot: '/repo',
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
                            command: 'cd /repo/.worktree/feat && cat /repo/README.md && ls /tmp',
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
    assert.deepEqual(calls, ['/repo/.worktree/feat']);
});

test('CONVERSATION-TELEMETRY-001 Kimi resolves relative Shell cd targets against the session working directory', async t => {
    const source = await createFixture(t);
    source.cwd = '/repo';
    const calls = [];
    const adapter = createAdapter(source, {
        resolveWorktree: async candidate => {
            calls.push(candidate);
            return candidate === '/repo/.worktree/feat-x'
                ? {
                    branch: 'feat-x',
                    worktreeRoot: candidate,
                    repoRoot: '/repo',
                }
                : candidate === '/repo'
                    ? {
                        branch: 'main',
                        worktreeRoot: '/repo',
                        repoRoot: '/repo',
                    }
                    : undefined;
        },
    });
    t.after(() => adapter.dispose());

    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            timestamp: 5000,
            message: {
                type: 'ToolCall',
                payload: {
                    type: 'function',
                    id: 'Shell_rel_1',
                    function: {
                        name: 'Shell',
                        arguments: JSON.stringify({
                            command: 'cd .worktree/feat-x && npm test',
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
                    id: 'Shell_rel_2',
                    function: {
                        name: 'Shell',
                        arguments: JSON.stringify({
                            // Unresolvable forms must not corrupt the base.
                            command: 'cd ~ && cd "$SOME_DIR" && cd .worktree/feat-y',
                        }),
                    },
                },
            },
        }),
        '',
    ].join('\n'));

    const telemetry = await adapter.readTelemetry(sessionId);
    assert.equal(
        telemetry.worktree?.branch,
        'feat-x',
        'the newest resolvable relative-cd worktree wins'
    );
    assert.deepEqual(calls.filter(candidate => candidate.includes('feat')), [
        '/repo/.worktree/feat-y',
        '/repo/.worktree/feat-x',
    ]);
});

test('CONVERSATION-TELEMETRY-001 Kimi falls back to the Session working directory when no Shell command changes cwd', async t => {
    const source = await createFixture(t);
    source.cwd = '/repo/.worktree/session-cwd';
    const calls = [];
    const adapter = createAdapter(source, {
        resolveWorktree: async candidate => {
            calls.push(candidate);
            return {
                branch: 'session-cwd',
                worktreeRoot: candidate,
                repoRoot: '/repo',
            };
        },
    });
    t.after(() => adapter.dispose());

    await fs.promises.appendFile(source.sourcePath, `${JSON.stringify({
        timestamp: 5000,
        message: {
            type: 'ToolCall',
            payload: {
                type: 'function',
                id: 'Shell_cwd_fallback',
                function: {
                    name: 'Shell',
                    arguments: JSON.stringify({
                        command: 'cat /repo/README.md',
                    }),
                },
            },
        },
    })}\n`);

    const telemetry = await adapter.readTelemetry(sessionId);
    assert.deepEqual(telemetry.worktree, {
        branch: 'session-cwd',
        worktreeRoot: '/repo/.worktree/session-cwd',
        repoRoot: '/repo',
    });
    assert.deepEqual(calls, ['/repo/.worktree/session-cwd']);
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

test('CONVERSATION-WORKLOG-COLLAPSE-001 Kimi stamps completedAt from the last turn event', async t => {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-worklog-')
    );
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    const lines = [
        { timestamp: 1_784_505_600, message: { type: 'TurnBegin',
            payload: { id: 'turn-1', user_input: 'Run the tests' } } },
        { timestamp: 1_784_505_605, message: { type: 'ToolCall',
            payload: { id: 'call-1', function: {
                name: 'shell', arguments: '{"command":"npm test"}' } } } },
        { timestamp: 1_784_505_607, message: { type: 'ToolResult',
            payload: { tool_call_id: 'call-1', return_value: { output: '9 passing' } } } },
        { timestamp: 1_784_505_620, message: { type: 'ContentPart',
            payload: { type: 'text', text: 'All pass.' } } },
        { timestamp: 1_784_505_625, message: { type: 'TurnEnd', payload: {} } },
    ];
    await fs.promises.writeFile(
        sourcePath,
        lines.map(line => JSON.stringify(line)).join('\n') + '\n'
    );
    const adapter = createAdapter({ providerHome, sourcePath });
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    assert.equal(page.interactionStates.length, 1);
    assert.equal(page.interactionStates[0].timestamp, 1_784_505_600_000);
    assert.equal(page.interactionStates[0].completedAt, 1_784_505_625_000);
});

function wireTurn(index, input) {
    const base = 20_000 + index * 10;
    return [
        JSON.stringify({ timestamp: base, message: { type: 'TurnBegin',
            payload: { user_input: input || `turn ${index}` } } }),
        JSON.stringify({ timestamp: base + 1, message: { type: 'ContentPart',
            payload: { type: 'text', text: `answer ${index}` } } }),
        JSON.stringify({ timestamp: base + 2, message: { type: 'TurnEnd',
            payload: {} } }),
        '',
    ].join('\n');
}

test('CONVERSATION-CACHE-CONVERGENCE-001 racing incremental reads never truncate the cached outline', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1, 2].map(index => wireTurn(index)).join('')
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const initial = await adapter.readOutline(sessionId);
    assert.equal(initial.interactions.length, 3);

    const tick = () => new Promise(resolve => setImmediate(resolve));
    let expected = 3;
    for (let round = 0; round < 12; round += 1) {
        expected += 1;
        await fs.promises.appendFile(
            source.sourcePath,
            wireTurn(100 + round)
        );
        // Warmup, telemetry polls, watch refreshes, and authoritative clicks
        // all share the per-session cache. Stagger a wave of reads so some
        // of them commit while others are mid-read.
        const wave = [];
        for (let stagger = 0; stagger < 5; stagger += 1) {
            wave.push((async () => {
                for (let pause = 0; pause < stagger; pause += 1) {
                    await tick();
                }
                return stagger % 2 === 0
                    ? adapter.readOutline(sessionId)
                    : adapter.readSnapshot(sessionId);
            })());
        }
        const results = await Promise.all(wave);
        for (const result of results) {
            const outline = result.outline || result;
            assert.equal(
                outline.interactions.length,
                expected,
                `round ${round} returned a truncated outline`
            );
        }
    }

    const truth = createAdapter(source);
    t.after(() => truth.dispose());
    const expectedOutline = await truth.readOutline(sessionId);
    const converged = await adapter.readOutline(sessionId);
    assert.deepEqual(
        converged.interactions.map(item => item.id),
        expectedOutline.interactions.map(item => item.id)
    );
});

test('CONVERSATION-CACHE-CONVERGENCE-001 an empty source picks up appended turns on the next read', async t => {
    const source = await createFixture(t);
    // A brand-new Kimi session starts with only the metadata record.
    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify({ type: 'metadata', protocol_version: '1.10' })}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const empty = await adapter.readOutline(sessionId);
    assert.equal(empty.interactions.length, 0);

    await fs.promises.appendFile(source.sourcePath, wireTurn(1, 'first turn'));
    const grown = await adapter.readOutline(sessionId);
    assert.deepEqual(
        grown.interactions.map(item => item.userPreview),
        ['first turn']
    );
});

test('CONVERSATION-CACHE-CONVERGENCE-001 replaced or truncated sources are cold re-read', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1, 2].map(index => wireTurn(index)).join('')
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    assert.equal((await adapter.readOutline(sessionId)).interactions.length, 3);

    // Atomic replacement swaps the inode: the cache must cold re-read.
    const replacementPath = path.join(source.providerHome, 'wire.jsonl.next');
    await fs.promises.writeFile(
        replacementPath,
        wireTurn(7, 'replacement turn')
    );
    await fs.promises.rename(replacementPath, source.sourcePath);
    const replaced = await adapter.readOutline(sessionId);
    assert.deepEqual(
        replaced.interactions.map(item => item.userPreview),
        ['replacement turn']
    );

    // Truncation shrinks the file in place: the cache must cold re-read too.
    await fs.promises.writeFile(source.sourcePath, wireTurn(9, 'truncated turn'));
    const truncated = await adapter.readOutline(sessionId);
    assert.deepEqual(
        truncated.interactions.map(item => item.userPreview),
        ['truncated turn']
    );
});

test('CONVERSATION-FOLLOW-DIAGNOSTICS-001 Kimi exposes sanitized cache diagnostics for empty follows', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1].map(index => wireTurn(index)).join('')
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    assert.equal(adapter.getCacheDiagnostics(sessionId), undefined);

    await adapter.readOutline(sessionId);
    const cold = adapter.getCacheDiagnostics(sessionId);
    assert.deepEqual(Object.keys(cold).sort(), [
        'cachedInteractions',
        'cachedNextOffset',
        'continuation',
        'partial',
        'sourceSize',
    ]);
    assert.equal(cold.cachedInteractions, 2);
    assert.equal(cold.cachedNextOffset, fs.statSync(source.sourcePath).size);
    assert.equal(cold.sourceSize, fs.statSync(source.sourcePath).size);
    assert.equal(cold.continuation, false);
    assert.equal(cold.partial, false);

    await fs.promises.appendFile(source.sourcePath, wireTurn(2));
    await adapter.readOutline(sessionId);
    const incremental = adapter.getCacheDiagnostics(sessionId);
    assert.equal(incremental.continuation, true);
    assert.equal(incremental.cachedInteractions, 3);
    assert.equal(incremental.cachedNextOffset, fs.statSync(source.sourcePath).size);
});

test('CONVERSATION-OVERSIZED-TURN-001 Kimi bounds one oversized tool-heavy turn without hiding its conversation', async t => {
    const source = await createFixture(t);
    const toolCalls = Array.from({ length: 160 }, (_item, index) => ({
        timestamp: 1_001 + index,
        message: {
            type: 'ToolCall',
            payload: {
                id: `call-${index}`,
                function: {
                    name: 'Shell',
                    arguments: JSON.stringify({
                        command: `printf ${'x'.repeat(3_900)}`,
                    }),
                },
            },
        },
    }));
    await fs.promises.writeFile(source.sourcePath, [
        {
            timestamp: 1_000,
            message: {
                type: 'TurnBegin',
                payload: { user_input: [{ type: 'text', text: 'Inspect the large run' }] },
            },
        },
        ...toolCalls,
        {
            timestamp: 2_000,
            message: {
                type: 'ContentPart',
                payload: { type: 'text', text: 'Final bounded answer.' },
            },
        },
        {
            timestamp: 2_001,
            message: { type: 'TurnEnd', payload: {} },
        },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const snapshot = await adapter.readSnapshot(sessionId);

    assert.ok(
        Buffer.byteLength(JSON.stringify(snapshot.page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    assert.equal(snapshot.outline.interactions.length, 1);
    assert.equal(snapshot.page.messages[0].markdown, 'Inspect the large run');
    assert.equal(snapshot.page.messages.at(-1).markdown, 'Final bounded answer.');
    assert.equal(
        snapshot.page.messages.some(message =>
            message.markdown === 'Work was omitted to keep this turn within the conversation size limit.'
        ),
        true
    );
    assert.ok(
        snapshot.page.messages.filter(message => message.role === 'tool').length
            < toolCalls.length
    );
});

// Shape measured from a real incident session (70ce2ce2-…, turn #2):
// one turn with 100+ tool calls, ~255KB of streamed thinking, ~278KB of
// tool output (including very large ReadFile results), and ~100KB of
// arguments — individually capped fields still sum past 512KB.
test('CONVERSATION-OVERSIZED-TURN-001 Kimi bounds a real-shaped oversized turn and keeps the outline intact', async t => {
    const source = await createFixture(t);
    const records = [{
        timestamp: 1_000,
        message: {
            type: 'TurnBegin',
            payload: { user_input: 'Review the oversized turn' },
        },
    }];
    for (let index = 0; index < 20; index += 1) {
        records.push({
            timestamp: 1_001 + index,
            message: {
                type: 'ContentPart',
                payload: { type: 'think', think: `thought ${index} ${'t'.repeat(12 * 1024)}` },
            },
        });
    }
    for (let index = 0; index < 160; index += 1) {
        const big = index < 2;
        records.push({
            timestamp: 1_100 + index * 2,
            message: {
                type: 'ToolCall',
                payload: {
                    id: `read-${index}`,
                    function: {
                        name: 'ReadFile',
                        arguments: JSON.stringify({
                            path: `/repo/src/module-${index}.ts`,
                        }),
                    },
                },
            },
        }, {
            timestamp: 1_101 + index * 2,
            message: {
                type: 'ToolResult',
                payload: {
                    tool_call_id: `read-${index}`,
                    return_value: {
                        output: `file ${index}\n${'r'.repeat(big ? 80 * 1024 : 3 * 1024)}`,
                    },
                },
            },
        });
    }
    records.push({
        timestamp: 2_000,
        message: {
            type: 'ContentPart',
            payload: { type: 'text', text: 'Final review verdict.' },
        },
    }, {
        timestamp: 2_001,
        message: { type: 'TurnEnd', payload: {} },
    }, {
        timestamp: 3_000,
        message: {
            type: 'TurnBegin',
            payload: { user_input: 'A normal follow-up turn' },
        },
    }, {
        timestamp: 3_001,
        message: { type: 'TurnEnd', payload: {} },
    });
    await fs.promises.writeFile(
        source.sourcePath,
        records.map(record => JSON.stringify(record)).join('\n') + '\n'
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const snapshot = await adapter.readSnapshot(sessionId);
    assert.deepEqual(
        snapshot.outline.interactions.map(item => item.userPreview),
        ['Review the oversized turn', 'A normal follow-up turn']
    );

    const oversizedId = snapshot.outline.interactions[0].id;
    const page = await adapter.readPage({
        provider: 'kimi',
        sessionId,
        anchorInteractionId: oversizedId,
        direction: 'around',
    });
    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    const oversizedMessages = page.messages.filter(
        message => message.interactionId === oversizedId
    );
    assert.equal(oversizedMessages[0].markdown, 'Review the oversized turn');
    assert.equal(
        oversizedMessages.some(message =>
            message.markdown === 'Final review verdict.'),
        true
    );
    assert.equal(
        oversizedMessages.some(message =>
            message.markdown === 'Work was omitted to keep this turn within the conversation size limit.'
        ),
        true
    );

    const outline = await adapter.readOutline(sessionId);
    assert.equal(outline.interactions.length, 2);
});
