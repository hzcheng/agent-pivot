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
        resolveWorktree: overrides.resolveWorktree,
        readCurrentWorkdir: overrides.readCurrentWorkdir,
        readLifecycleSignal: overrides.readLifecycleSignal,
        listSubagentThreads: overrides.listSubagentThreads,
    });
    return {
        adapter,
        requests,
        getClientDisposeCount: () => clientDisposeCount,
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
        ['user', 'thinking', 'progress', 'tool', 'tool']
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

test('CONVERSATION-TELEMETRY-001 reads model, context, and quota windows from structured Codex protocol data', async t => {
    let notificationListener;
    const harness = createAdapter(fixture, {
        client: {
            watchNotifications(listener) {
                notificationListener = listener;
                return { dispose() {} };
            },
            async request(method) {
                if (method === 'thread/resume') {
                    notificationListener('thread/tokenUsage/updated', {
                        threadId: sessionId,
                        turnId: 'turn-telemetry',
                        tokenUsage: {
                            total: { totalTokens: 88_000 },
                            last: { totalTokens: 32_000 },
                            modelContextWindow: 128_000,
                        },
                    });
                    return {
                        model: 'gpt-5.6-sol',
                        modelProvider: 'openai',
                    };
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
            if (method === 'thread/resume') {
                return { model: 'gpt-5.6-sol', cwd: '/launch/repo' };
            }
            return {};
        },
        dispose() {},
    };
    const rolloutAdapter = createAdapter(fixture, {
        client: telemetryClient,
        readCurrentWorkdir: id =>
            id === sessionId ? '/launch/repo/.worktree/feature-x' : undefined,
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
        readCurrentWorkdir: () => undefined,
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
