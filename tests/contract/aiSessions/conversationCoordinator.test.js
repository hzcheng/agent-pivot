'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ClaudeConversationAdapter,
} = require('../../../out/aiSessions/conversation/claudeAdapter');
const {
    CodexConversationAdapter,
} = require('../../../out/aiSessions/conversation/codexAdapter');
const { ConversationCoordinator } = require(
    '../../../out/aiSessions/conversation/coordinator'
);
const {
    KimiConversationAdapter,
} = require('../../../out/aiSessions/conversation/kimiAdapter');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function makeOutline(provider, sessionId, sourceRevision = 'native-a', overrides = {}) {
    return {
        provider,
        sessionId,
        sourceRevision,
        totalInteractions: 2,
        partial: false,
        interactions: [
            {
                id: 'input-a',
                userPreview: 'First',
                userGraphemeCount: 5,
                responseState: 'complete',
            },
            {
                id: 'input-b',
                userPreview: 'Second',
                userGraphemeCount: 6,
                responseState: 'inProgress',
            },
        ],
        ...overrides,
    };
}

function makePage(provider, sessionId, sourceRevision = 'native-a', overrides = {}) {
    return {
        provider,
        sessionId,
        sourceRevision,
        anchorInteractionId: 'input-a',
        messages: [{
            id: 'input-a:user',
            interactionId: 'input-a',
            role: 'user',
            markdown: 'Visible prompt',
        }],
        interactionStates: [
            { interactionId: 'input-a', responseState: 'complete' },
            { interactionId: 'input-b', responseState: 'inProgress' },
        ],
        previousCursor: '/private/provider/path.jsonl#offset=12',
        nextCursor: 'native-content-hash',
        isStart: false,
        isEnd: false,
        ...overrides,
    };
}

function createClock(startMs = 0) {
    let nowMs = startMs;
    let nextHandle = 1;
    const timers = new Map();
    const clock = {
        now: () => nowMs,
        setTimeout(callback, delayMs) {
            const handle = nextHandle++;
            timers.set(handle, {
                callback,
                dueAt: nowMs + Math.max(0, delayMs),
                order: handle,
            });
            return handle;
        },
        clearTimeout(handle) {
            timers.delete(handle);
        },
        advanceBy(durationMs) {
            clock.advanceTo(nowMs + durationMs);
        },
        advanceTo(targetMs) {
            if (targetMs < nowMs) {
                throw new Error('clock cannot move backwards');
            }
            while (true) {
                const next = Array.from(timers.entries())
                    .filter(([, timer]) => timer.dueAt <= targetMs)
                    .sort((left, right) => (
                        left[1].dueAt - right[1].dueAt
                        || left[1].order - right[1].order
                    ))[0];
                if (!next) {
                    break;
                }
                const [handle, timer] = next;
                timers.delete(handle);
                nowMs = timer.dueAt;
                timer.callback();
            }
            nowMs = targetMs;
        },
        get pendingCount() {
            return timers.size;
        },
    };
    return clock;
}

async function settle() {
    for (let turn = 0; turn < 12; turn += 1) {
        await Promise.resolve();
    }
}

function adapterReturning(calls, provider, overrides = {}) {
    const invalidations = new Map();
    const disposedWatches = [];
    const adapter = {
        async readOutline(sessionId) {
            calls[provider] += 1;
            return overrides.readOutline
                ? await overrides.readOutline(sessionId)
                : makeOutline(provider, sessionId, overrides.sourceRevision || 'native-a');
        },
        async readPage(request) {
            return overrides.readPage
                ? await overrides.readPage(request)
                : makePage(provider, request.sessionId, overrides.sourceRevision || 'native-a');
        },
        watch(sessionId, onChange) {
            invalidations.set(sessionId, onChange);
            let active = true;
            return {
                dispose() {
                    if (!active) return;
                    active = false;
                    disposedWatches.push(sessionId);
                    if (invalidations.get(sessionId) === onChange) {
                        invalidations.delete(sessionId);
                    }
                },
            };
        },
        invalidate(sessionId) {
            invalidations.get(sessionId)?.();
        },
        disposedWatches,
        dispose() {},
    };
    return adapter;
}

function adapterThrowing(calls, provider, error) {
    return {
        async readOutline() {
            calls[provider] += 1;
            throw error;
        },
        async readPage() {
            throw error;
        },
        watch() {
            return { dispose() {} };
        },
        dispose() {},
    };
}

function createCoordinatorHarness(adapterOverrides = {}) {
    const clock = createClock();
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const adapters = {
        codex: adapterOverrides.codex || adapterReturning(calls, 'codex'),
        kimi: adapterOverrides.kimi || adapterReturning(calls, 'kimi'),
        claude: adapterOverrides.claude || adapterReturning(calls, 'claude'),
    };
    let cursorNumber = 0;
    const diagnostics = [];
    const coordinator = new ConversationCoordinator({
        adapters,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        createCursorId: () => `cursor-${++cursorNumber}`,
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });
    return { adapters, calls, clock, coordinator, diagnostics };
}

test('SESSION-CONVERSATION-COORDINATOR-001 isolates adapter failures and removes private details', async t => {
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const coordinator = new ConversationCoordinator({
        adapters: {
            codex: adapterReturning(calls, 'codex'),
            kimi: adapterThrowing(
                calls,
                'kimi',
                new Error('private provider detail /home/person/transcript')
            ),
            claude: adapterReturning(calls, 'claude'),
        },
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(
        coordinator.readOutline('kimi', 'kimi-session'),
        error => error.code === 'unavailable'
            && !JSON.stringify(error).includes('private provider detail')
            && !JSON.stringify(error).includes('/home/person')
    );
    await coordinator.readOutline('codex', 'codex-session');
    await coordinator.readOutline('claude', 'claude-session');

    assert.deepEqual(calls, { codex: 1, kimi: 1, claude: 1 });
});

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-001 replaces native revisions and cursors with scoped opaque tokens', async t => {
    const nativeRevision = '/private/provider/path.jsonl#offset=12:hash=secret';
    let revisions = {
        'session-a': nativeRevision,
        'session-b': nativeRevision,
    };
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const codex = adapterReturning(calls, 'codex', {
        readOutline: async sessionId => makeOutline('codex', sessionId, revisions[sessionId]),
        readPage: async request => makePage('codex', request.sessionId, revisions[request.sessionId]),
    });
    const { coordinator } = createCoordinatorHarness({ codex });
    t.after(() => coordinator.dispose());

    const first = await coordinator.readOutline('codex', 'session-a');
    const other = await coordinator.readOutline('codex', 'session-b');
    assert.equal(first.sourceRevision, 'r1');
    assert.equal(other.sourceRevision, 'r1');
    assert.equal(JSON.stringify([first, other]).includes(nativeRevision), false);

    const page = await coordinator.readPage({
        provider: 'codex',
        sessionId: 'session-a',
        anchorInteractionId: 'input-a',
        direction: 'around',
        expectedRevision: first.sourceRevision,
    });
    assert.equal(page.sourceRevision, 'r1');
    assert.match(page.previousCursor, /^cursor-\d+$/);
    assert.match(page.nextCursor, /^cursor-\d+$/);
    assert.equal(JSON.stringify(page).includes('/private/provider'), false);
    assert.equal(JSON.stringify(page).includes('offset'), false);
    assert.equal(JSON.stringify(page).includes('hash'), false);

    await assert.rejects(
        coordinator.readPage({
            provider: 'codex',
            sessionId: 'session-a',
            anchorInteractionId: 'input-a',
            direction: 'after',
            expectedRevision: 'r1',
            cursor: '/private/provider/path.jsonl#offset=12',
        }),
        error => error.code === 'staleRevision'
    );
    await assert.rejects(
        coordinator.readPage({
            provider: 'codex',
            sessionId: 'session-b',
            anchorInteractionId: 'input-b',
            direction: 'after',
            expectedRevision: 'r1',
            cursor: page.nextCursor,
        }),
        error => error.code === 'staleRevision'
    );

    revisions['session-a'] = 'different-native-secret';
    const changed = await coordinator.readOutline('codex', 'session-a');
    assert.equal(changed.sourceRevision, 'r2');
    assert.equal((await coordinator.readOutline('codex', 'session-b')).sourceRevision, 'r1');
    await assert.rejects(
        coordinator.readPage({
            provider: 'codex',
            sessionId: 'session-a',
            anchorInteractionId: 'input-b',
            direction: 'after',
            expectedRevision: 'r1',
            cursor: page.nextCursor,
        }),
        error => error.code === 'staleRevision'
    );
});

test('SESSION-CONVERSATION-COORDINATOR-003 projects stopped in-progress states without changing the public revision', async t => {
    const { coordinator } = createCoordinatorHarness();
    t.after(() => coordinator.dispose());

    const running = await coordinator.readOutline('codex', 'session-a');
    coordinator.setSessionStopped('codex', 'session-a', true);
    const stopped = await coordinator.readOutline('codex', 'session-a');

    assert.equal(running.sourceRevision, stopped.sourceRevision);
    assert.equal(running.interactions.at(-1).responseState, 'inProgress');
    assert.equal(stopped.interactions.at(-1).responseState, 'interrupted');
});

test('CONVERSATION-WORKING-INDICATOR-001 projects only the latest interrupted provider response as in progress while the runtime is running', async t => {
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const codex = adapterReturning(calls, 'codex', {
        readOutline: async sessionId => makeOutline(
            'codex',
            sessionId,
            'native-running',
            {
                interactions: [
                    {
                        id: 'input-a',
                        userPreview: 'Earlier interrupted response',
                        userGraphemeCount: 28,
                        responseState: 'interrupted',
                    },
                    {
                        id: 'input-b',
                        userPreview: 'Current response',
                        userGraphemeCount: 16,
                        responseState: 'interrupted',
                    },
                ],
            }
        ),
        readPage: async request => makePage(
            'codex',
            request.sessionId,
            'native-running',
            {
                interactionStates: [
                    { interactionId: 'input-a', responseState: 'interrupted' },
                    { interactionId: 'input-b', responseState: 'interrupted' },
                ],
                nextCursor: undefined,
                isEnd: true,
            }
        ),
    });
    const { coordinator } = createCoordinatorHarness({ codex });
    t.after(() => coordinator.dispose());

    coordinator.setSessionStopped('codex', 'session-a', false);
    const outline = await coordinator.readOutline('codex', 'session-a');

    assert.equal(outline.interactions[0].responseState, 'interrupted');
    assert.equal(outline.interactions[1].responseState, 'inProgress');

    const page = await coordinator.readPage({
        provider: 'codex',
        sessionId: 'session-a',
        anchorInteractionId: 'input-a',
        direction: 'around',
        expectedRevision: outline.sourceRevision,
    });
    assert.equal(page.interactionStates[0].responseState, 'interrupted');
    assert.equal(page.interactionStates[1].responseState, 'inProgress');
});

test('SESSION-CONVERSATION-COORDINATOR-005 releases only the exact opaque watch ownership', async () => {
    const { adapters, clock, coordinator } = createCoordinatorHarness();
    const calls = [];
    const codexSubscription = coordinator.watch(
        'codex',
        'same-session',
        () => calls.push('codex')
    );
    const kimiSubscription = coordinator.watch(
        'kimi',
        'same-session',
        () => calls.push('kimi')
    );

    coordinator.releaseSubscription(codexSubscription);
    coordinator.releaseSubscription(codexSubscription);
    adapters.codex.invalidate('same-session');
    adapters.kimi.invalidate('same-session');
    clock.advanceBy(250);
    await settle();

    assert.deepEqual(calls, ['kimi']);
    assert.deepEqual(adapters.codex.disposedWatches, ['same-session']);
    assert.deepEqual(adapters.kimi.disposedWatches, []);
    coordinator.releaseSubscription(kimiSubscription);
    coordinator.dispose();
});


test('SESSION-CONVERSATION-COORDINATOR-001 accepts bounded long-prompt previews from every production adapter', async t => {
    const providerRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-coordinator-preview-')
    );
    t.after(() => fs.promises.rm(providerRoot, {
        recursive: true,
        force: true,
    }));
    const prompt = '🙂'.repeat(161);
    const expectedPreview = `${'🙂'.repeat(159)}…`;
    const kimiSourcePath = path.join(providerRoot, 'kimi.jsonl');
    const claudeSourcePath = path.join(providerRoot, 'claude.jsonl');
    await fs.promises.writeFile(kimiSourcePath, [
        JSON.stringify({
            timestamp: 1,
            message: {
                type: 'TurnBegin',
                payload: { user_input: prompt },
            },
        }),
        JSON.stringify({
            timestamp: 2,
            message: { type: 'TurnEnd', payload: {} },
        }),
        '',
    ].join('\n'));
    await fs.promises.writeFile(claudeSourcePath, [
        JSON.stringify({
            type: 'user',
            uuid: 'claude-long-user',
            message: {
                role: 'user',
                content: [{ type: 'text', text: prompt }],
            },
        }),
        '',
    ].join('\n'));
    const noWatch = () => ({ dispose() {} });
    const immediateTimer = callback => {
        callback();
        return 1;
    };
    const coordinator = new ConversationCoordinator({
        adapters: {
            codex: new CodexConversationAdapter({
                client: {
                    async request(_method, params) {
                        return {
                            thread: {
                                id: params.threadId,
                                turns: [{
                                    id: 'codex-long-turn',
                                    status: 'completed',
                                    items: [{
                                        id: 'codex-long-user',
                                        type: 'userMessage',
                                        content: [{
                                            type: 'text',
                                            text: prompt,
                                        }],
                                    }],
                                }],
                            },
                        };
                    },
                    dispose() {},
                },
                watchSessionChanges: noWatch,
                setTimeout: immediateTimer,
                clearTimeout() {},
            }),
            kimi: new KimiConversationAdapter({
                resolveSource: () => ({
                    providerHome: providerRoot,
                    sourcePath: kimiSourcePath,
                }),
                watchSessionChanges: noWatch,
                now: Date.now,
                setTimeout: immediateTimer,
                clearTimeout() {},
            }),
            claude: new ClaudeConversationAdapter({
                resolveSource: () => ({
                    providerHome: providerRoot,
                    sourcePath: claudeSourcePath,
                }),
                watchSessionChanges: noWatch,
                now: Date.now,
                setTimeout: immediateTimer,
                clearTimeout() {},
            }),
        },
    });
    t.after(() => coordinator.dispose());

    const results = await Promise.all([
        ['codex', 'codex-long-session'],
        ['kimi', 'kimi-long-session'],
        ['claude', 'claude-long-session'],
    ].map(async ([provider, sessionId]) => {
        try {
            const outline = await coordinator.readOutline(provider, sessionId);
            return [provider, outline.interactions[0].userPreview];
        } catch (error) {
            return [provider, error.code];
        }
    }));

    assert.deepEqual(results, [
        ['codex', expectedPreview],
        ['kimi', expectedPreview],
        ['claude', expectedPreview],
    ]);
});
test('SESSION-CONVERSATION-COORDINATOR-001 rate floor starts when a slow refresh publication completes', async t => {
    const firstPublication = deferred();
    const harness = createCoordinatorHarness();
    t.after(() => harness.coordinator.dispose());
    const publicationTimes = [];
    let refreshes = 0;
    harness.coordinator.watch('codex', 'session-a', async () => {
        refreshes += 1;
        if (refreshes === 1) {
            await firstPublication.promise;
        }
        publicationTimes.push(harness.clock.now());
        return true;
    });

    harness.adapters.codex.invalidate('session-a');
    harness.clock.advanceTo(250);
    await settle();
    assert.equal(refreshes, 1);
    harness.clock.advanceTo(1050);
    harness.adapters.codex.invalidate('session-a');
    harness.clock.advanceTo(1299);
    firstPublication.resolve();
    await settle();
    assert.deepEqual(publicationTimes, [1299]);
    harness.clock.advanceTo(1300);
    await settle();
    assert.deepEqual(publicationTimes, [1299]);
    harness.clock.advanceTo(2298);
    await settle();
    assert.deepEqual(publicationTimes, [1299]);
    harness.clock.advanceTo(2299);
    await settle();
    assert.deepEqual(publicationTimes, [1299, 2299]);
});

test('SESSION-CONVERSATION-COORDINATOR-001 synchronously reentrant invalidation is merged behind the completed floor', async t => {
    const harness = createCoordinatorHarness();
    t.after(() => harness.coordinator.dispose());
    const publicationTimes = [];
    harness.coordinator.watch('codex', 'session-a', () => {
        publicationTimes.push(harness.clock.now());
        if (publicationTimes.length === 1) {
            harness.adapters.codex.invalidate('session-a');
        }
        return true;
    });

    harness.adapters.codex.invalidate('session-a');
    harness.clock.advanceTo(250);
    await settle();
    assert.deepEqual(publicationTimes, [250]);
    harness.clock.advanceTo(1249);
    await settle();
    assert.deepEqual(publicationTimes, [250]);
    harness.clock.advanceTo(1250);
    await settle();
    assert.deepEqual(publicationTimes, [250, 1250]);
});

test('SESSION-CONVERSATION-COORDINATOR-001 rejects sparse or inherited response array elements', async t => {
    const validInteraction = makeOutline(
        'codex',
        'session-a'
    ).interactions[0];
    const sparseInteractions = new Array(1);
    const inheritedInteractions = [];
    inheritedInteractions.length = 1;
    const inheritedPrototype = Object.create(Array.prototype);
    inheritedPrototype[0] = validInteraction;
    Object.setPrototypeOf(inheritedInteractions, inheritedPrototype);

    await t.test('outline interactions', async () => {
        let result = makeOutline('codex', 'session-a', 'native-a', {
            interactions: sparseInteractions,
            totalInteractions: 1,
        });
        const harness = createCoordinatorHarness({
            codex: {
                readOutline: async () => result,
                readPage: async request => makePage('codex', request.sessionId),
                watch: () => ({ dispose() {} }),
                dispose() {},
            },
        });
        t.after(() => harness.coordinator.dispose());
        await assert.rejects(
            harness.coordinator.readOutline('codex', 'session-a'),
            error => error.code === 'unavailable'
        );
        result = makeOutline('codex', 'session-a', 'native-a', {
            interactions: inheritedInteractions,
            totalInteractions: 1,
        });
        await assert.rejects(
            harness.coordinator.readOutline('codex', 'session-a'),
            error => error.code === 'unavailable'
        );
    });

    for (const [name, pageOverrides] of [
        ['page messages', { messages: new Array(1) }],
        ['page interaction states', {
            interactionStates: new Array(1),
            previousCursor: undefined,
            nextCursor: undefined,
        }],
    ]) {
        await t.test(name, async () => {
            const harness = createCoordinatorHarness({
                codex: {
                    readOutline: async sessionId => makeOutline(
                        'codex',
                        sessionId
                    ),
                    readPage: async () => makePage(
                        'codex',
                        'session-a',
                        'native-a',
                        pageOverrides
                    ),
                    watch: () => ({ dispose() {} }),
                    dispose() {},
                },
            });
            t.after(() => harness.coordinator.dispose());
            const outline = await harness.coordinator.readOutline(
                'codex',
                'session-a'
            );
            await assert.rejects(
                harness.coordinator.readPage({
                    provider: 'codex',
                    sessionId: 'session-a',
                    anchorInteractionId: 'input-a',
                    direction: 'around',
                    expectedRevision: outline.sourceRevision,
                }),
                error => error.code === 'unavailable'
            );
        });
    }
});

test('SESSION-CONVERSATION-COORDINATOR-001 rejects deep outline and page bound violations', async t => {
    async function rejectOutline(interactionOverrides) {
        const baseInteraction = makeOutline(
            'codex',
            'session-a'
        ).interactions[0];
        const harness = createCoordinatorHarness({
            codex: {
                readOutline: async () => makeOutline(
                    'codex',
                    'session-a',
                    'native-a',
                    {
                        interactions: [{
                            ...baseInteraction,
                            ...interactionOverrides,
                        }],
                        totalInteractions: 1,
                    }
                ),
                readPage: async request => makePage('codex', request.sessionId),
                watch: () => ({ dispose() {} }),
                dispose() {},
            },
        });
        t.after(() => harness.coordinator.dispose());
        await assert.rejects(
            harness.coordinator.readOutline('codex', 'session-a'),
            error => error.code === 'unavailable'
        );
    }

    await t.test('preview exceeds 160 graphemes', async () => {
        await rejectOutline({ userPreview: '🙂'.repeat(161) });
    });
    await t.test('user count exceeds the visible-message bound', async () => {
        await rejectOutline({ userGraphemeCount: 64_001 });
    });

    async function rejectPage(pageOverrides) {
        const harness = createCoordinatorHarness({
            codex: {
                readOutline: async sessionId => makeOutline(
                    'codex',
                    sessionId
                ),
                readPage: async () => makePage(
                    'codex',
                    'session-a',
                    'native-a',
                    pageOverrides
                ),
                watch: () => ({ dispose() {} }),
                dispose() {},
            },
        });
        t.after(() => harness.coordinator.dispose());
        const outline = await harness.coordinator.readOutline(
            'codex',
            'session-a'
        );
        await assert.rejects(
            harness.coordinator.readPage({
                provider: 'codex',
                sessionId: 'session-a',
                anchorInteractionId: 'input-a',
                direction: 'around',
                expectedRevision: outline.sourceRevision,
            }),
            error => error.code === 'unavailable'
                || error.code === 'tooLarge'
        );
    }

    await t.test('message exceeds 64,000 graphemes', async () => {
        await rejectPage({
            messages: [{
                id: 'input-a:user',
                interactionId: 'input-a',
                role: 'user',
                markdown: '🙂'.repeat(64_001),
            }],
        });
    });
    await t.test('message references an interaction outside the page', async () => {
        await rejectPage({
            messages: [{
                id: 'unknown:user',
                interactionId: 'unknown',
                role: 'user',
                markdown: 'Unknown',
            }],
        });
    });
    await t.test('page anchor is outside the interaction states', async () => {
        await rejectPage({ anchorInteractionId: 'unknown' });
    });
    await t.test('duplicate interaction state IDs are rejected', async () => {
        await rejectPage({
            interactionStates: [
                { interactionId: 'input-a', responseState: 'complete' },
                { interactionId: 'input-a', responseState: 'complete' },
            ],
        });
    });
    await t.test('cursor presence must agree with page boundaries', async () => {
        await rejectPage({
            isStart: true,
            previousCursor: 'native-before',
        });
    });
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 coordinator preserves tool messages through validation and publication', async t => {
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const codex = adapterReturning(calls, 'codex', {
        readOutline: async sessionId => makeOutline('codex', sessionId),
        readPage: async request => makePage(
            'codex',
            request.sessionId,
            'native-a',
            {
                messages: [
                    {
                        id: 'input-a:user',
                        interactionId: 'input-a',
                        role: 'user',
                        markdown: 'Run the tests',
                    },
                    {
                        id: 'input-a:tool:0',
                        interactionId: 'input-a',
                        role: 'tool',
                        markdown: '',
                        tool: {
                            name: 'Shell',
                            summary: 'Shell npm test',
                            detail: '9 passing',
                        },
                    },
                    {
                        id: 'input-a:assistant:0',
                        interactionId: 'input-a',
                        role: 'assistant',
                        markdown: 'All pass.',
                    },
                ],
            }
        ),
    });
    const { coordinator } = createCoordinatorHarness({ codex });
    t.after(() => coordinator.dispose());

    const outlineResult = await coordinator.readOutline('codex', 'session-a');
    const page = await coordinator.readPage({
        provider: 'codex',
        sessionId: 'session-a',
        anchorInteractionId: 'input-a',
        direction: 'around',
        expectedRevision: outlineResult.sourceRevision,
    });
    const toolMessage = page.messages.find(message => message.role === 'tool');
    assert.ok(
        toolMessage,
        'coordinator must not reject a page containing tool messages'
    );
    assert.deepEqual(toolMessage.tool, {
        name: 'Shell',
        summary: 'Shell npm test',
        detail: '9 passing',
    });
});

test('CONVERSATION-THINKING-VISIBILITY-001 coordinator preserves thinking messages through validation and publication', async t => {
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const kimi = adapterReturning(calls, 'kimi', {
        readOutline: async sessionId => makeOutline('kimi', sessionId),
        readPage: async request => makePage(
            'kimi',
            request.sessionId,
            'native-a',
            {
                messages: [
                    {
                        id: 'input-a:user',
                        interactionId: 'input-a',
                        role: 'user',
                        markdown: 'Solve this carefully',
                    },
                    {
                        id: 'input-a:thinking:0',
                        interactionId: 'input-a',
                        role: 'thinking',
                        markdown: '',
                        thinking: {
                            text: 'I should inspect the coordinator boundary.',
                        },
                    },
                    {
                        id: 'input-a:assistant:0',
                        interactionId: 'input-a',
                        role: 'assistant',
                        markdown: 'Done.',
                    },
                ],
            }
        ),
    });
    const { coordinator } = createCoordinatorHarness({ kimi });
    t.after(() => coordinator.dispose());

    const outlineResult = await coordinator.readOutline('kimi', 'session-a');
    const page = await coordinator.readPage({
        provider: 'kimi',
        sessionId: 'session-a',
        anchorInteractionId: 'input-a',
        direction: 'around',
        expectedRevision: outlineResult.sourceRevision,
    });
    const thinkingMessage = page.messages.find(
        message => message.role === 'thinking'
    );
    assert.ok(
        thinkingMessage,
        'coordinator must not reject a page containing thinking messages'
    );
    assert.deepEqual(thinkingMessage.thinking, {
        text: 'I should inspect the coordinator boundary.',
    });
});

test('CONVERSATION-PROGRESS-VISIBILITY-001 coordinator preserves progress and projects active Claude and Kimi responses as in progress', async () => {
    for (const provider of ['claude', 'kimi']) {
        const calls = { codex: 0, kimi: 0, claude: 0 };
        const adapter = adapterReturning(calls, provider, {
            readOutline: async sessionId => makeOutline(
                provider,
                sessionId,
                `native-${provider}`,
                {
                    interactions: [{
                        id: 'input-a',
                        userPreview: 'Current request',
                        userGraphemeCount: 15,
                        responseState: 'complete',
                    }],
                    totalInteractions: 1,
                }
            ),
            readPage: async request => makePage(
                provider,
                request.sessionId,
                `native-${provider}`,
                {
                    messages: [
                        {
                            id: 'input-a:user',
                            interactionId: 'input-a',
                            role: 'user',
                            markdown: 'Current request',
                        },
                        {
                            id: 'input-a:progress:0',
                            interactionId: 'input-a',
                            role: 'progress',
                            markdown: 'Running checks.',
                        },
                        {
                            id: 'input-a:assistant:0',
                            interactionId: 'input-a',
                            role: 'assistant',
                            markdown: 'Still processing.',
                        },
                    ],
                    interactionStates: [{
                        interactionId: 'input-a',
                        responseState: 'complete',
                    }],
                    previousCursor: undefined,
                    nextCursor: undefined,
                    isStart: true,
                    isEnd: true,
                }
            ),
        });
        const { coordinator } = createCoordinatorHarness({ [provider]: adapter });
        coordinator.setSessionStopped(provider, 'session-a', false);
        const outline = await coordinator.readOutline(provider, 'session-a');
        const page = await coordinator.readPage({
            provider,
            sessionId: 'session-a',
            anchorInteractionId: 'input-a',
            direction: 'around',
            expectedRevision: outline.sourceRevision,
        });

        assert.equal(outline.interactions[0].responseState, 'inProgress');
        assert.equal(page.interactionStates[0].responseState, 'inProgress');
        assert.equal(page.messages[1].role, 'progress');
        assert.equal(page.messages[2].role, 'progress');
        coordinator.dispose();
    }
});
