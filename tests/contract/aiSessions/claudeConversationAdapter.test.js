'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClaudeConversationAdapter } = require('../../../out/aiSessions/conversation/claudeAdapter');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/conversations/claude/session.jsonl'
);
const providerFixturePath = path.resolve(
    __dirname,
    '../../fixtures/providers/claude/home/projects/-fixtures-project/'
        + '11111111-1111-4111-8111-111111111111.jsonl'
);
const sessionId = '22222222-2222-4222-8222-222222222222';

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
        path.join(os.tmpdir(), 'steward-claude-conversation-')
    );
    const sourcePath = path.join(providerHome, 'session.jsonl');
    await fs.promises.copyFile(fixturePath, sourcePath);
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    return { providerHome, sourcePath };
}

function createAdapter(source, overrides = {}) {
    return new ClaudeConversationAdapter({
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
        provider: 'claude',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
    });
    return { outline, page };
}

async function restartSuffix(t, sourcePath, offset) {
    const bytes = await fs.promises.readFile(sourcePath);
    const suffixPath = path.join(path.dirname(sourcePath), 'restart-suffix.jsonl');
    await fs.promises.writeFile(suffixPath, Buffer.concat([
        Buffer.alloc(offset, 0x0a),
        bytes.subarray(offset),
    ]));
    t.after(() => fs.promises.rm(suffixPath, { force: true }));
    return suffixPath;
}

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 Claude returns one correlated outline and page snapshot', async t => {
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

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude normalizes only top-level visible user and assistant text', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(outline.interactions.map(item => item.userPreview), [
        'Explain the parser',
        'Review [Attachment]',
        '[2 Attachments]',
    ]);
    assert.deepEqual(
        outline.interactions.map(item => item.id),
        ['claude-user-1', 'claude-user-2', 'claude-user-3']
    );
    assert.equal(page.messages.filter(message => message.role === 'progress').length, 1);
    assert.equal(page.messages.filter(message => message.role === 'assistant').length, 2);
    assert.equal(
        page.messages.some(message =>
            /tool_result|secret-thought|local\/path|private\.invalid/.test(message.markdown)
        ),
        false
    );
});

test('CONVERSATION-HISTORY-RESTART-POINT-001 Claude restart points replay their interaction suffix from empty state', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const full = await adapter.readOutline(sessionId);
    const points = adapter.getHistoryRestartPoints(sessionId);
    assert.ok(points.length >= 2);
    const point = points[1];
    const start = full.interactions.findIndex(item => item.id === point.interactionId);
    assert.ok(start >= 0);

    const suffixPath = await restartSuffix(t, source.sourcePath, point.offset);
    const suffixAdapter = createAdapter({
        providerHome: source.providerHome,
        sourcePath: suffixPath,
    });
    t.after(() => suffixAdapter.dispose());
    const suffix = await suffixAdapter.readOutline(sessionId);
    assert.deepEqual(suffix.interactions, full.interactions.slice(start));
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude accepts canonical string content without exposing hidden records', async t => {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-claude-string-conversation-')
    );
    const sourcePath = path.join(providerHome, 'session.jsonl');
    const canonical = await fs.promises.readFile(providerFixturePath, 'utf8');
    await fs.promises.writeFile(sourcePath, canonical + [
        {
            type: 'assistant',
            uuid: 'fixture-alpha-assistant',
            message: {
                role: 'assistant',
                content: 'Visible string response',
            },
        },
        {
            type: 'assistant',
            uuid: 'fixture-sidechain-assistant',
            isSidechain: true,
            message: {
                role: 'assistant',
                content: 'secret-thought',
            },
        },
        {
            type: 'user',
            uuid: 'fixture-tool-result',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', content: 'local/path' }],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    t.after(() => fs.promises.rm(
        providerHome,
        { recursive: true, force: true }
    ));
    const adapter = createAdapter({ providerHome, sourcePath });
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(
        outline.interactions.map(item => item.userPreview),
        ['Fixture alpha request']
    );
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Fixture alpha request'],
            ['assistant', 'Visible string response'],
        ]
    );
    assert.equal(
        JSON.stringify({ outline, page })
            .includes('secret-thought')
            || JSON.stringify({ outline, page }).includes('local/path'),
        false
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude excludes meta injections and background task notifications from User prompts', async t => {
    const source = await createFixture(t);
    const records = [{
        type: 'user',
        uuid: 'real-human-request',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: {
            role: 'user',
            content: 'Review the active-active design.',
        },
    }, {
        type: 'user',
        uuid: 'skill-injection',
        isMeta: true,
        sourceToolUseID: 'tool-skill',
        message: {
            role: 'user',
            content: [{
                type: 'text',
                text: 'Base directory for this skill: /private/skill',
            }],
        },
    }, {
        type: 'assistant',
        uuid: 'visible-progress',
        message: {
            role: 'assistant',
            content: [{
                type: 'text',
                text: 'I started the background reviews.',
            }],
        },
    }, {
        type: 'user',
        uuid: 'background-task-notification',
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: {
            role: 'user',
            content: '<task-notification>private agent output</task-notification>',
        },
    }, {
        type: 'assistant',
        uuid: 'visible-final',
        message: {
            role: 'assistant',
            content: [{
                type: 'text',
                text: 'The consolidated review is ready.',
            }],
        },
    }];
    await fs.promises.writeFile(
        source.sourcePath,
        `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(
        outline.interactions.map(item => item.userPreview),
        ['Review the active-active design.']
    );
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Review the active-active design.'],
            ['assistant', 'I started the background reviews.'],
            ['assistant', 'The consolidated review is ready.'],
        ]
    );
    assert.equal(
        JSON.stringify({ outline, page }).includes('task-notification')
            || JSON.stringify({ outline, page }).includes('private/skill'),
        false
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude treats string and array interrupt sentinels as interaction state only', async t => {
    const source = await createFixture(t);
    const records = [
        {
            type: 'user',
            uuid: 'real-request-string',
            timestamp: '2026-07-26T01:00:00.000Z',
            message: { role: 'user', content: 'Keep this string request' },
        },
        {
            type: 'assistant',
            uuid: 'real-response-string',
            message: { role: 'assistant', content: 'Visible first response' },
        },
        {
            type: 'user',
            uuid: 'interrupt-string',
            message: {
                role: 'user',
                content: ' [Request interrupted by user] ',
            },
        },
        {
            type: 'user',
            uuid: 'real-request-array',
            timestamp: '2026-07-26T01:01:00.000Z',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Keep this array request' }],
            },
        },
        {
            type: 'assistant',
            uuid: 'real-response-array',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Visible second response' }],
            },
        },
        {
            type: 'user',
            uuid: 'interrupt-array',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', content: 'private tool output' },
                    { type: 'text', text: '[Request interrupted by user]' },
                ],
            },
        },
    ];
    await fs.promises.writeFile(
        source.sourcePath,
        `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(
        outline.interactions.map(interaction => [
            interaction.id,
            interaction.userPreview,
            interaction.responseState,
        ]),
        [
            [
                'real-request-string',
                'Keep this string request',
                'interrupted',
            ],
            [
                'real-request-array',
                'Keep this array request',
                'interrupted',
            ],
        ]
    );
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Keep this string request'],
            ['assistant', 'Visible first response'],
            ['user', 'Keep this array request'],
            ['assistant', 'Visible second response'],
        ]
    );
    assert.equal(
        JSON.stringify({ outline, page }).includes('Request interrupted by user')
            || JSON.stringify({ outline, page }).includes('private tool output'),
        false
    );
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude treats the tool-use interrupt sentinel variant as interaction state only', async t => {
    const source = await createFixture(t);
    const records = [
        {
            type: 'user',
            uuid: 'real-request',
            timestamp: '2026-08-01T02:00:00.000Z',
            message: { role: 'user', content: 'Run the lint checks' },
        },
        {
            type: 'assistant',
            uuid: 'real-response',
            message: { role: 'assistant', content: 'Running them now.' },
        },
        {
            type: 'user',
            uuid: 'interrupt-tool-use',
            message: {
                role: 'user',
                content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
            },
        },
    ];
    await fs.promises.writeFile(
        source.sourcePath,
        `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(
        outline.interactions.map(interaction => [
            interaction.id,
            interaction.userPreview,
            interaction.responseState,
        ]),
        [
            [
                'real-request',
                'Run the lint checks',
                'interrupted',
            ],
        ]
    );
    assert.deepEqual(
        page.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Run the lint checks'],
            ['assistant', 'Running them now.'],
        ]
    );
    assert.equal(
        JSON.stringify({ outline, page }).includes('Request interrupted by user'),
        false
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-002 excludes assistant tool blocks and synthetic user-role tool results', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.equal(
        outline.interactions.some(item => item.id.startsWith('synthetic-')),
        false
    );
    assert.equal(page.messages.filter(message => message.role === 'progress').length, 1);
    assert.equal(page.messages.filter(message => message.role === 'assistant').length, 2);
    assert.equal(
        page.messages.some(message => /read_file|search/.test(message.markdown)),
        false
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-003 parses append-only suffixes without changing prior UUID identities', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const first = await adapter.readOutline(sessionId);
    const unchanged = await adapter.readOutline(sessionId);
    assert.equal(unchanged.sourceRevision, first.sourceRevision);
    const originalIds = first.interactions.map(item => item.id);
    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'user',
            uuid: 'claude-user-4',
            message: { role: 'user', content: [{ type: 'text', text: 'Describe the suffix' }] },
        })}\n`
    );
    const appended = await adapter.readOutline(sessionId);
    assert.notEqual(appended.sourceRevision, first.sourceRevision);
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
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-004 surfaces timeout when no interaction was completed', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        Buffer.alloc(CONVERSATION_LIMITS.readChunkBytes + 1, 0x20)
    );
    let clockReads = 0;
    const adapter = createAdapter(source, {
        now() {
            clockReads += 1;
            return clockReads <= 3 ? 0 : CONVERSATION_LIMITS.jsonlScanTimeoutMs;
        },
    });
    t.after(() => adapter.dispose());

    await assert.rejects(
        adapter.readOutline(sessionId),
        error => error.name === 'ConversationError' && error.code === 'timeout'
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-005 keeps provider caches and watches independently disposable', async t => {
    const source = await createFixture(t);
    let providerCallback;
    let providerDisposeCount = 0;
    const adapter = createAdapter(source, {
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    await adapter.readOutline(sessionId);
    let changes = 0;
    const watched = adapter.watch(sessionId, () => { changes += 1; });
    providerCallback();
    assert.equal(changes, 1);
    watched.dispose();
    assert.equal(providerDisposeCount, 1);
    adapter.dispose();
    assert.equal(providerDisposeCount, 1);
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-005 keeps duplicate callback registrations independent', async t => {
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

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-005 rolls back a failed provider watch before a clean retry', async t => {
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

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-006 attaches a later assistant suffix to the completed EOF interaction', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'user',
            uuid: 'claude-live-user',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Follow the response' }],
            },
        })}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const first = await adapter.readOutline(sessionId);
    assert.equal(first.interactions[0].responseState, 'complete');

    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'assistant',
            uuid: 'claude-live-assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Visible suffix response' }],
            },
        })}\n`
    );
    const second = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: 'claude-live-user',
        direction: 'around',
    });
    assert.deepEqual(
        second.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Follow the response'],
            ['assistant', 'Visible suffix response'],
        ]
    );
    assert.notEqual(second.sourceRevision, first.sourceRevision);
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-007 changes revision after a same-size same-mtime source rewrite', async t => {
    const source = await createFixture(t);
    const firstRecord = {
        type: 'user',
        uuid: 'claude-rewritten-user',
        message: {
            role: 'user',
            content: [{ type: 'text', text: 'Alpha' }],
        },
    };
    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify(firstRecord)}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const first = await adapter.readOutline(sessionId);
    const statBeforeReset = await fs.promises.stat(source.sourcePath);

    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify({
            ...firstRecord,
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Bravo' }],
            },
        })}\n`
    );
    await fs.promises.utimes(
        source.sourcePath,
        statBeforeReset.atimeMs / 1000,
        statBeforeReset.mtimeMs / 1000
    );
    const rebuilt = await adapter.readOutline(sessionId);
    assert.equal(rebuilt.interactions[0].userPreview, 'Bravo');
    assert.notEqual(rebuilt.sourceRevision, first.sourceRevision);
});

test('CONVERSATION-TELEMETRY-001 Claude surfaces the latest assistant model and context window usage', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    assert.equal(await adapter.readTelemetry(sessionId), undefined);

    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            type: 'assistant',
            uuid: 'telemetry-assistant-1',
            message: {
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Working on it.' }],
                usage: {
                    input_tokens: 3,
                    cache_creation_input_tokens: 1513,
                    cache_read_input_tokens: 98000,
                    output_tokens: 119,
                },
            },
        }),
        JSON.stringify({
            type: 'assistant',
            uuid: 'telemetry-sidechain-assistant',
            isSidechain: true,
            message: {
                role: 'assistant',
                model: 'claude-haiku-4-5',
                content: [{ type: 'text', text: 'subagent' }],
                usage: { input_tokens: 10, output_tokens: 5 },
            },
        }),
        JSON.stringify({
            type: 'assistant',
            uuid: 'telemetry-assistant-2',
            message: {
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Done.' }],
                usage: {
                    input_tokens: 5,
                    cache_read_input_tokens: 120000,
                    output_tokens: 42,
                },
            },
        }),
        '',
    ].join('\n'));

    assert.deepEqual(await adapter.readTelemetry(sessionId), {
        provider: 'claude',
        sessionId,
        model: 'claude-sonnet-4-6',
        context: { usedTokens: 120047, maxTokens: 1_000_000 },
        rateLimits: [],
    });

    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'assistant',
            uuid: 'telemetry-assistant-3',
            message: {
                role: 'assistant',
                model: 'claude-opus-4-6',
                content: [{ type: 'text', text: 'Switched models.' }],
                usage: {
                    input_tokens: 7,
                    cache_read_input_tokens: 131000,
                    output_tokens: 65,
                },
            },
        })}\n`
    );
    assert.deepEqual(await adapter.readTelemetry(sessionId), {
        provider: 'claude',
        sessionId,
        model: 'claude-opus-4-6',
        context: { usedTokens: 131072, maxTokens: 1_000_000 },
        rateLimits: [],
    });
});

test('CONVERSATION-TELEMETRY-001 Claude uses model-specific context windows', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const millionTokenModels = [
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-mythos-5',
        'claude-mythos-preview',
        'us.anthropic.claude-opus-5-v1:0',
    ];
    for (const [index, model] of millionTokenModels.entries()) {
        await fs.promises.appendFile(
            source.sourcePath,
            `${JSON.stringify({
                type: 'assistant',
                uuid: `telemetry-million-${index}`,
                message: {
                    role: 'assistant',
                    model,
                    content: [{ type: 'text', text: 'Continuing a long session.' }],
                    usage: {
                        input_tokens: 2,
                        cache_creation_input_tokens: 3873,
                        cache_read_input_tokens: 352883,
                        output_tokens: 2026,
                    },
                },
            })}\n`
        );

        assert.deepEqual(await adapter.readTelemetry(sessionId), {
            provider: 'claude',
            sessionId,
            model,
            context: { usedTokens: 358784, maxTokens: 1_000_000 },
            rateLimits: [],
        });
    }

    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'assistant',
            uuid: 'telemetry-haiku-4-5',
            message: {
                role: 'assistant',
                model: 'claude-haiku-4-5-20251001',
                content: [{ type: 'text', text: 'Using a smaller window.' }],
                usage: {
                    input_tokens: 3,
                    cache_creation_input_tokens: 1200,
                    cache_read_input_tokens: 48000,
                    output_tokens: 300,
                },
            },
        })}\n`
    );

    assert.deepEqual(await adapter.readTelemetry(sessionId), {
        provider: 'claude',
        sessionId,
        model: 'claude-haiku-4-5-20251001',
        context: { usedTokens: 49503, maxTokens: 200_000 },
        rateLimits: [],
    });
});

test('CONVERSATION-TELEMETRY-001 Claude resolves the current worktree from the latest event cwd and degrades to the logged branch', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source, {
        resolveWorktree: async candidate =>
            candidate === '/repo/.worktree/feat'
                ? {
                    branch: 'feat',
                    worktreeRoot: candidate,
                    repoRoot: '/repo',
                }
                : undefined,
    });
    t.after(() => adapter.dispose());

    assert.equal(await adapter.readTelemetry(sessionId), undefined);

    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            type: 'user',
            uuid: 'worktree-user-1',
            cwd: '/repo',
            gitBranch: 'main',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Start in the main checkout' }],
            },
        }),
        JSON.stringify({
            type: 'assistant',
            uuid: 'worktree-assistant-1',
            cwd: '/repo/.worktree/feat',
            gitBranch: 'feat',
            message: {
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'Now working in the worktree.' }],
                usage: { input_tokens: 5, output_tokens: 7 },
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

    const missingAdapter = createAdapter(source, {
        resolveWorktree: async () => undefined,
    });
    t.after(() => missingAdapter.dispose());
    const missing = await missingAdapter.readTelemetry(sessionId);
    assert.deepEqual(missing.worktree, {
        branch: 'feat',
        worktreeRoot: '/repo/.worktree/feat',
        repoRoot: '/repo/.worktree/feat',
        missing: true,
    });
});

async function writeSubagentFixture(source, id, meta, records) {
    // Real layout: <dir>/<session>.jsonl -> <dir>/<session>/subagents/.
    const base = path.basename(source.sourcePath, path.extname(source.sourcePath));
    const directory = path.join(path.dirname(source.sourcePath), base, 'subagents');
    await fs.promises.mkdir(directory, { recursive: true });
    if (meta) {
        await fs.promises.writeFile(
            path.join(directory, `agent-${id}.meta.json`),
            JSON.stringify(meta)
        );
    }
    const transcriptPath = path.join(directory, `agent-${id}.jsonl`);
    await fs.promises.writeFile(
        transcriptPath,
        records.map(record => JSON.stringify(record)).join('\n') + '\n'
    );
    return { directory, transcriptPath };
}

function subagentTranscriptRecords(id, options = {}) {
    const startedAt = options.startedAt || '2025-01-02T03:04:05.000Z';
    const finalContent = options.midTurn === 'toolUse'
        ? [{
            type: 'tool_use',
            id: 'toolu_fixture_1',
            name: 'Bash',
            input: { command: 'npm test' },
        }]
        : [{ type: 'text', text: 'The parser normalizes visible text.' }];
    return [
        {
            type: 'user',
            uuid: `${id}-user-1`,
            isSidechain: true,
            agentId: id,
            promptId: `${id}-prompt-1`,
            timestamp: startedAt,
            message: {
                role: 'user',
                content: 'Explore the parser and report back',
            },
        },
        {
            type: 'assistant',
            uuid: `${id}-assistant-1`,
            isSidechain: true,
            agentId: id,
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                model: 'claude-haiku-4-5-20251001',
                content: [{ type: 'thinking', thinking: 'subagent-secret' }],
            },
        },
        {
            type: 'user',
            uuid: `${id}-user-2`,
            isSidechain: true,
            agentId: id,
            timestamp: '2025-01-02T03:04:07.000Z',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', content: 'local/path' }],
            },
        },
        ...(options.midTurn === 'toolResult'
            ? []
            : [{
                type: 'assistant',
                uuid: `${id}-assistant-2`,
                isSidechain: true,
                agentId: id,
                timestamp: '2025-01-02T03:04:08.000Z',
                message: { role: 'assistant', content: finalContent },
            }]),
    ];
}

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Claude lists depth-1 subagents with inferred statuses and labels', async t => {
    const source = await createFixture(t);
    const fresh = await writeSubagentFixture(
        source,
        'a11111111',
        {
            description: 'Explore the parser',
            agentType: 'Explore',
            spawnDepth: 1,
            toolUseId: 'toolu_fixture_alpha',
        },
        subagentTranscriptRecords('a11111111')
    );
    await writeSubagentFixture(
        source,
        'a22222222',
        { agentType: 'general-purpose', spawnDepth: 1 },
        subagentTranscriptRecords('a22222222', {
            startedAt: '2025-01-02T02:04:05.000Z',
            midTurn: 'toolUse',
        })
    );
    const stale = await writeSubagentFixture(
        source,
        'a33333333',
        { description: 'Stale worker', spawnDepth: 1 },
        subagentTranscriptRecords('a33333333', {
            startedAt: '2025-01-02T01:04:05.000Z',
            midTurn: 'toolResult',
        })
    );
    const tenMinutesAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    await fs.promises.utimes(
        stale.transcriptPath,
        tenMinutesAgo,
        tenMinutesAgo
    );
    await writeSubagentFixture(
        source,
        'a44444444',
        { description: 'Nested grandchild', spawnDepth: 2 },
        subagentTranscriptRecords('a44444444')
    );
    await writeSubagentFixture(
        source,
        'a55555555',
        null,
        subagentTranscriptRecords('a55555555', {
            startedAt: '2025-01-02T04:04:05.000Z',
        })
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const entries = await adapter.readSubagents(sessionId);
    assert.deepEqual(
        entries.map(entry => [entry.id, entry.status, entry.agentType]),
        [
            ['a33333333', 'quiet', undefined],
            ['a22222222', 'running', 'general-purpose'],
            ['a11111111', 'idle', 'Explore'],
            ['a55555555', 'idle', undefined],
        ]
    );
    assert.equal(entries[2].label, 'Explore the parser');
    assert.equal(entries[1].label, 'general-purpose · a22222222');
    assert.equal(entries[3].label, 'a55555555');
    assert.equal(entries[2].createdAt, Date.parse('2025-01-02T03:04:05.000Z'));
    assert.ok(Number.isSafeInteger(entries[0].updatedAt));

    const stat = await fs.promises.stat(fresh.transcriptPath);
    assert.equal(entries[2].updatedAt, Math.floor(stat.mtimeMs));
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Claude reads a subagent transcript as its own conversation', async t => {
    const source = await createFixture(t);
    await writeSubagentFixture(
        source,
        'a11111111',
        { description: 'Explore the parser', spawnDepth: 1 },
        subagentTranscriptRecords('a11111111')
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
        provider: 'claude',
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
            ['assistant', 'The parser normalizes visible text.'],
        ]
    );
    assert.deepEqual(
        page.messages.filter(message => message.role === 'thinking')
            .map(message => message.thinking.text),
        ['subagent-secret']
    );

    // A resumed subagent (SendMessage) grows a second interaction round.
    await writeSubagentFixture(
        source,
        'a66666666',
        { description: 'Resumed worker', spawnDepth: 1 },
        [
            ...subagentTranscriptRecords('a66666666'),
            {
                type: 'user',
                uuid: 'a66666666-user-3',
                isSidechain: true,
                isMeta: true,
                origin: { kind: 'coordinator' },
                agentId: 'a66666666',
                promptId: 'a66666666-prompt-2',
                timestamp: '2025-01-02T03:05:00.000Z',
                message: { role: 'user', content: 'One more check please' },
            },
            {
                type: 'assistant',
                uuid: 'a66666666-assistant-3',
                isSidechain: true,
                agentId: 'a66666666',
                timestamp: '2025-01-02T03:05:01.000Z',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Follow-up done.' }],
                },
            },
        ]
    );
    const resumed = await adapter.readOutline(`${sessionId}#agent:a66666666`);
    assert.equal(resumed.totalInteractions, 2);
    assert.deepEqual(
        resumed.interactions.map(item => item.userPreview),
        ['Explore the parser and report back', 'One more check please']
    );

    // The parent session conversation is unaffected by the subagent files.
    const parent = await adapter.readOutline(sessionId);
    assert.equal(parent.totalInteractions, 3);
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 Claude rejects malformed and missing subagent targets', async t => {
    const source = await createFixture(t);
    await writeSubagentFixture(
        source,
        'a11111111',
        { spawnDepth: 1 },
        subagentTranscriptRecords('a11111111')
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

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 CONVERSATION-PROGRESS-VISIBILITY-001 Claude treats a tool preamble as progress and preserves the final answer', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'tool-user-1',
            timestamp: '2025-01-02T03:04:05.000Z',
            message: { role: 'user', content: 'Run the tests' },
        },
        {
            type: 'assistant',
            uuid: 'tool-assistant-1',
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me run them.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'Bash',
                        input: { command: 'npm test' },
                    },
                ],
            },
        },
        {
            type: 'user',
            uuid: 'tool-user-2',
            timestamp: '2025-01-02T03:04:07.000Z',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        content: '9 passing',
                    },
                ],
            },
        },
        {
            type: 'assistant',
            uuid: 'tool-assistant-2',
            timestamp: '2025-01-02T03:04:08.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'All tests pass.' }],
            },
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
            ['progress', 'Let me run them.'],
            ['tool', 'Bash npm test'],
            ['assistant', 'All tests pass.'],
        ]
    );
    const tool = page.messages[2].tool;
    assert.equal(tool.name, 'Bash');
    assert.match(tool.detail, /"command": "npm test"/);
    assert.match(tool.detail, /9 passing/);
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Claude replays AskUserQuestion options and settles answers from a later tool_result', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'ask-user-1',
            timestamp: '2025-01-02T03:04:05.000Z',
            message: { role: 'user', content: 'Ask me things' },
        },
        {
            type: 'assistant',
            uuid: 'ask-assistant-1',
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_ask_1',
                        name: 'AskUserQuestion',
                        input: {
                            questions: [
                                {
                                    question: 'Pick one',
                                    header: 'Choice',
                                    multiSelect: false,
                                    options: [
                                        { label: 'A', description: 'first' },
                                        { label: 'B', description: 'second' },
                                    ],
                                },
                                {
                                    question: 'Pick many',
                                    header: 'Multi',
                                    multiSelect: true,
                                    options: [
                                        { label: 'X' },
                                        { label: 'Y' },
                                        { label: 'Z' },
                                    ],
                                },
                            ],
                        },
                    },
                ],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const firstOutline = await adapter.readOutline(sessionId);
    const first = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: firstOutline.interactions[0].id,
        direction: 'around',
        expectedRevision: firstOutline.sourceRevision,
    });
    assert.deepEqual(
        first.messages.map(message => message.role),
        ['user', 'question']
    );
    assert.equal(first.messages[1].question.outcome, undefined);
    assert.deepEqual(first.messages[1].question.questions, [
        {
            question: 'Pick one',
            header: 'Choice',
            options: [
                { label: 'A', description: 'first' },
                { label: 'B', description: 'second' },
            ],
            multiSelect: false,
        },
        {
            question: 'Pick many',
            header: 'Multi',
            options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
            multiSelect: true,
        },
    ]);

    await fs.promises.appendFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'ask-user-2',
            timestamp: '2025-01-02T03:04:07.000Z',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_ask_1',
                        content: 'Your questions have been answered: "Pick one"="B", "Pick many"="X, Y". You can now continue with these answers in mind.',
                    },
                ],
            },
        },
        {
            type: 'assistant',
            uuid: 'ask-assistant-2',
            timestamp: '2025-01-02T03:04:08.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Thanks, continuing.' }],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const updatedOutline = await adapter.readOutline(sessionId);
    const second = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: updatedOutline.interactions[0].id,
        direction: 'around',
        expectedRevision: updatedOutline.sourceRevision,
    });
    assert.deepEqual(
        second.messages.map(message => message.role),
        ['user', 'question', 'assistant']
    );
    assert.deepEqual(second.messages[1].question, {
        source: 'AskUserQuestion',
        questions: [
            {
                question: 'Pick one',
                header: 'Choice',
                options: [
                    { label: 'A', description: 'first' },
                    { label: 'B', description: 'second' },
                ],
                multiSelect: false,
                answers: ['B'],
            },
            {
                question: 'Pick many',
                header: 'Multi',
                options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
                multiSelect: true,
                answers: ['X', 'Y'],
            },
        ],
        outcome: 'answered',
    });
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 Claude marks a dismissed AskUserQuestion rejected and keeps questionless calls as plain tool entries', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'reject-user-1',
            timestamp: '2025-01-02T03:04:05.000Z',
            message: { role: 'user', content: 'Ask me things' },
        },
        {
            type: 'assistant',
            uuid: 'reject-assistant-1',
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_reject_1',
                        name: 'AskUserQuestion',
                        input: {
                            questions: [{
                                question: 'Proceed?',
                                header: 'Confirm',
                                multiSelect: false,
                                options: [{ label: 'Yes' }, { label: 'No' }],
                            }],
                        },
                    },
                    {
                        type: 'tool_use',
                        id: 'toolu_plain_1',
                        name: 'AskUserQuestion',
                        input: {},
                    },
                ],
            },
        },
        {
            type: 'user',
            uuid: 'reject-user-2',
            timestamp: '2025-01-02T03:04:07.000Z',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_reject_1',
                        content: "The user doesn't want to proceed with this tool use.",
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_plain_1',
                        content: 'plain result',
                    },
                ],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    assert.deepEqual(
        page.messages.map(message => message.role),
        ['user', 'tool', 'question']
    );
    assert.equal(page.messages[1].tool.name, 'AskUserQuestion');
    assert.match(page.messages[1].tool.detail, /plain result/);
    assert.deepEqual(page.messages[2].question, {
        source: 'AskUserQuestion',
        questions: [{
            question: 'Proceed?',
            header: 'Confirm',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiSelect: false,
        }],
        outcome: 'rejected',
    });
});

test('CONVERSATION-DIFF-VISIBILITY-001 Claude synthesizes fragment diffs for Edit and Write tool calls', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'edit-user-1',
            timestamp: '2025-01-02T03:04:05.000Z',
            message: { role: 'user', content: 'Patch the files' },
        },
        {
            type: 'assistant',
            uuid: 'edit-assistant-1',
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_edit_1',
                        name: 'Edit',
                        input: {
                            replace_all: false,
                            file_path: '/work/src/a.ts',
                            old_string: 'const a = 1;\nconst b = 2;',
                            new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;',
                        },
                    },
                    {
                        type: 'tool_use',
                        id: 'toolu_write_1',
                        name: 'Write',
                        input: {
                            file_path: '/work/src/new.ts',
                            content: 'export const x = 1;\nexport const y = 2;\n',
                        },
                    },
                    {
                        type: 'tool_use',
                        id: 'toolu_edit_bad',
                        name: 'Edit',
                        input: { file_path: '/work/src/b.ts' },
                    },
                ],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    const tools = page.messages.filter(message => message.role === 'tool');
    assert.equal(tools.length, 3);

    assert.equal(tools[0].tool.name, 'Edit');
    assert.equal(tools[0].tool.detail, undefined);
    assert.deepEqual(tools[0].tool.diffs, [{
        path: '/work/src/a.ts',
        kind: 'update',
        additions: 2,
        deletions: 1,
        hunks: [{
            lines: [
                { type: 'context', text: 'const a = 1;' },
                { type: 'del', text: 'const b = 2;' },
                { type: 'add', text: 'const b = 3;' },
                { type: 'add', text: 'const c = 4;' },
            ],
        }],
    }]);

    assert.equal(tools[1].tool.name, 'Write');
    assert.deepEqual(tools[1].tool.diffs, [{
        path: '/work/src/new.ts',
        kind: 'add',
        additions: 2,
        deletions: 0,
        hunks: [{
            lines: [
                { type: 'add', text: 'export const x = 1;' },
                { type: 'add', text: 'export const y = 2;' },
            ],
        }],
    }]);

    // Shape mismatch keeps the generic raw-JSON rendering.
    assert.equal(tools[2].tool.name, 'Edit');
    assert.equal(tools[2].tool.diffs, undefined);
    assert.match(tools[2].tool.detail, /src\/b\.ts/);
});

test('CONVERSATION-DIFF-VISIBILITY-001 Claude marks replace-all edits in the tool summary', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, [
        {
            type: 'user',
            uuid: 'replace-user-1',
            timestamp: '2025-01-02T03:04:05.000Z',
            message: { role: 'user', content: 'Rename everywhere' },
        },
        {
            type: 'assistant',
            uuid: 'replace-assistant-1',
            timestamp: '2025-01-02T03:04:06.000Z',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'toolu_replace_1',
                    name: 'Edit',
                    input: {
                        replace_all: true,
                        file_path: '/work/src/c.ts',
                        old_string: 'foo',
                        new_string: 'bar',
                    },
                }],
            },
        },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    const tool = page.messages.find(message => message.role === 'tool');
    assert.match(tool.tool.summary, /\(replace all\)$/);
    assert.deepEqual(tool.tool.diffs[0].hunks[0].lines, [
        { type: 'del', text: 'foo' },
        { type: 'add', text: 'bar' },
    ]);
});

test('CONVERSATION-THINKING-VISIBILITY-001 Claude interleaves thinking blocks with text in arrival order', async t => {
    const source = await createFixture(t);
    await fs.promises.appendFile(source.sourcePath, [
        JSON.stringify({
            type: 'user',
            uuid: 'thinking-user',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Explain the regression' }],
            },
        }),
        JSON.stringify({
            type: 'assistant',
            uuid: 'thinking-assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Compare the two runs.' },
                    { type: 'text', text: 'The regression is in the parser.' },
                    { type: 'thinking', thinking: 'Offer the fix next.' },
                    { type: 'text', text: 'Patch attached.' },
                ],
            },
        }),
        '',
    ].join('\n'));
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: 'thinking-user',
        direction: 'around',
        limit: 1,
        expectedRevision: outline.sourceRevision,
    });
    const start = page.messages.findIndex(
        message => message.interactionId === 'thinking-user'
    );
    assert.deepEqual(
        page.messages.slice(start).map(message => [
            message.role,
            message.role === 'thinking'
                ? message.thinking.text
                : message.markdown,
        ]),
        [
            ['user', 'Explain the regression'],
            ['thinking', 'Compare the two runs.'],
            ['assistant', 'The regression is in the parser.'],
            ['thinking', 'Offer the fix next.'],
            ['assistant', 'Patch attached.'],
        ]
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 Claude stamps completedAt from the last contributing event', async t => {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-claude-worklog-')
    );
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    const sourcePath = path.join(providerHome, 'session.jsonl');
    const lines = [
        { type: 'user', uuid: 'worklog-user-1', timestamp: '2026-08-01T10:00:00.000Z',
            message: { role: 'user', content: [{ type: 'text', text: 'Run the tests' }] } },
        { type: 'assistant', uuid: 'worklog-assistant-1', timestamp: '2026-08-01T10:00:40.000Z',
            message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'tool-1', name: 'Shell', input: { command: 'npm test' } },
            ] } },
        { type: 'user', uuid: 'worklog-tool-result-1', timestamp: '2026-08-01T10:00:50.000Z',
            message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'tool-1', content: '9 passing' },
            ] } },
        { type: 'assistant', uuid: 'worklog-assistant-2', timestamp: '2026-08-01T10:01:20.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'All pass.' }] } },
        { type: 'user', uuid: 'worklog-user-2', timestamp: '2026-08-01T10:05:00.000Z',
            message: { role: 'user', content: [{ type: 'text', text: 'Thanks' }] } },
        { type: 'assistant', uuid: 'worklog-assistant-3', timestamp: '2026-08-01T10:05:03.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Anytime.' }] } },
    ];
    await fs.promises.writeFile(
        sourcePath,
        lines.map(line => JSON.stringify(line)).join('\n') + '\n'
    );
    const adapter = createAdapter({ providerHome, sourcePath });
    t.after(() => adapter.dispose());

    const { page } = await readWholeConversation(adapter);
    assert.equal(page.interactionStates.length, 2);
    assert.equal(
        page.interactionStates[0].completedAt,
        Date.parse('2026-08-01T10:01:20.000Z'),
        'first turn ends at its last assistant event, not the next user input'
    );
    assert.equal(page.interactionStates[0].timestamp, Date.parse('2026-08-01T10:00:00.000Z'));
    assert.equal(
        page.interactionStates[1].completedAt,
        Date.parse('2026-08-01T10:05:03.000Z')
    );
});

function claudeWireTurn(index, input) {
    const base = new Date(1_800_000_000_000 + index * 10_000).toISOString();
    return [
        JSON.stringify({ type: 'user', uuid: `race-user-${index}`,
            timestamp: base,
            message: { role: 'user', content: input || `turn ${index}` } }),
        JSON.stringify({ type: 'assistant', uuid: `race-assistant-${index}`,
            timestamp: base,
            message: { role: 'assistant', content: `answer ${index}` } }),
        '',
    ].join('\n');
}

test('CONVERSATION-CACHE-CONVERGENCE-001 Claude racing incremental reads never truncate the cached outline', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1, 2].map(index => claudeWireTurn(index)).join('')
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
            claudeWireTurn(100 + round)
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

test('CONVERSATION-CACHE-CONVERGENCE-001 Claude an empty source picks up appended turns on the next read', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(source.sourcePath, '');
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const empty = await adapter.readOutline(sessionId);
    assert.equal(empty.interactions.length, 0);

    await fs.promises.appendFile(
        source.sourcePath,
        claudeWireTurn(1, 'first turn')
    );
    const grown = await adapter.readOutline(sessionId);
    assert.deepEqual(
        grown.interactions.map(item => item.userPreview),
        ['first turn']
    );
});

test('CONVERSATION-CACHE-CONVERGENCE-001 Claude replaced or truncated sources are cold re-read', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1, 2].map(index => claudeWireTurn(index)).join('')
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    assert.equal((await adapter.readOutline(sessionId)).interactions.length, 3);

    // Atomic replacement swaps the inode: the cache must cold re-read.
    const replacementPath = path.join(source.providerHome, 'session.jsonl.next');
    await fs.promises.writeFile(
        replacementPath,
        claudeWireTurn(7, 'replacement turn')
    );
    await fs.promises.rename(replacementPath, source.sourcePath);
    const replaced = await adapter.readOutline(sessionId);
    assert.deepEqual(
        replaced.interactions.map(item => item.userPreview),
        ['replacement turn']
    );

    // Truncation shrinks the file in place: the cache must cold re-read too.
    await fs.promises.writeFile(
        source.sourcePath,
        claudeWireTurn(9, 'truncated turn')
    );
    const truncated = await adapter.readOutline(sessionId);
    assert.deepEqual(
        truncated.interactions.map(item => item.userPreview),
        ['truncated turn']
    );
});

test('CONVERSATION-FOLLOW-DIAGNOSTICS-001 Claude exposes sanitized cache diagnostics for empty follows', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        [0, 1].map(index => claudeWireTurn(index)).join('')
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

    await fs.promises.appendFile(source.sourcePath, claudeWireTurn(2));
    await adapter.readOutline(sessionId);
    const incremental = adapter.getCacheDiagnostics(sessionId);
    assert.equal(incremental.continuation, true);
    assert.equal(incremental.cachedInteractions, 3);
    assert.equal(incremental.cachedNextOffset, fs.statSync(source.sourcePath).size);
});
