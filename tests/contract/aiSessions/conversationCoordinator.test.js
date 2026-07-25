'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConversationCoordinator } = require(
    '../../../out/aiSessions/conversation/coordinator'
);
const {
    ConversationHostController,
} = require('../../../out/aiSessions/conversation/conversationHostController');

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

function makeOutlineRequest(overrides = {}) {
    return {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        ...overrides,
    };
}

function makeCancelRequest(overrides = {}) {
    return {
        type: 'cancel-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 2,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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

function createControllerHarness(overrides = {}) {
    const clock = createClock();
    const calls = { codex: 0, kimi: 0, claude: 0 };
    const outlineResults = [...(overrides.outlineResults || [])];
    const adapters = {
        codex: adapterReturning(calls, 'codex', {
            readOutline: outlineResults.length
                ? async sessionId => {
                    const result = outlineResults.shift();
                    return await result || makeOutline('codex', sessionId);
                }
                : overrides.readOutline,
        }),
        kimi: adapterReturning(calls, 'kimi'),
        claude: adapterReturning(calls, 'claude'),
    };
    const coordinator = new ConversationCoordinator({
        adapters,
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        createCursorId: (() => {
            let next = 0;
            return () => `cursor-${++next}`;
        })(),
    });
    const publications = [];
    const opened = [];
    let resolveCalls = 0;
    const resolveTarget = overrides.resolveTarget || (
        (projectId, provider, sessionId) => {
            resolveCalls += 1;
            return {
                projectId,
                provider,
                sessionId,
                focused: true,
                executionState: 'running',
                name: 'Conversation fixture',
            };
        }
    );
    const controller = new ConversationHostController({
        coordinator,
        resolveTarget,
        publish: overrides.publish || (message => publications.push(message)),
        openViewer: (target, authoritativeTarget) => {
            opened.push([target, authoritativeTarget]);
        },
    });
    return {
        adapters,
        calls,
        clock,
        controller,
        coordinator,
        get resolveCalls() {
            return resolveCalls;
        },
        invalidate(provider = 'codex', sessionId = 'session-a') {
            adapters[provider].invalidate(sessionId);
        },
        opened,
        publications,
        releaseSubscription(cancel = makeCancelRequest()) {
            controller.cancel(cancel);
        },
    };
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

test('SESSION-CONVERSATION-COORDINATOR-002 replaces native revisions and cursors with scoped opaque tokens', async t => {
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

test('SESSION-CONVERSATION-COORDINATOR-004 coalesces invalidations and applies the later debounce/rate-floor deadline', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest());
    harness.publications.length = 0;
    const readsBeforeInvalidation = harness.calls.codex;

    for (let index = 0; index < 10; index += 1) {
        harness.invalidate();
    }
    harness.clock.advanceTo(249);
    await settle();
    assert.equal(harness.publications.length, 0);
    harness.clock.advanceTo(250);
    await settle();
    assert.equal(harness.publications.length, 1);
    assert.equal(harness.calls.codex, readsBeforeInvalidation + 1);

    harness.clock.advanceTo(1050);
    harness.invalidate();
    harness.clock.advanceTo(1249);
    await settle();
    assert.equal(harness.publications.length, 1);
    harness.clock.advanceTo(1299);
    await settle();
    assert.equal(harness.publications.length, 1);
    harness.clock.advanceTo(1300);
    await settle();
    assert.equal(harness.publications.length, 2);
});

test('SESSION-CONVERSATION-COORDINATOR-005 releases only the exact opaque watch ownership', () => {
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

    assert.deepEqual(calls, ['kimi']);
    assert.deepEqual(adapters.codex.disposedWatches, ['same-session']);
    assert.deepEqual(adapters.kimi.disposedWatches, []);
    coordinator.releaseSubscription(kimiSubscription);
    coordinator.dispose();
});

test('SESSION-CONVERSATION-HOST-001 rejects invalid request IDs before target resolution', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());

    for (const requestId of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        await harness.controller.handleOutline(makeOutlineRequest({ requestId }));
    }
    for (const subscriptionGeneration of [
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        await harness.controller.handleOutline(makeOutlineRequest({
            subscriptionGeneration,
        }));
    }

    assert.equal(harness.resolveCalls, 0);
    assert.equal(harness.calls.codex, 0);
    assert.deepEqual(harness.publications, []);
});

test('SESSION-CONVERSATION-HOST-002 fails unsupported identities closed without adapter access', async t => {
    let resolveCalls = 0;
    const harness = createControllerHarness({
        resolveTarget: () => {
            resolveCalls += 1;
            return null;
        },
    });
    t.after(() => harness.controller.dispose());

    await harness.controller.handleOutline(makeOutlineRequest({
        projectId: 'missing-project',
    }));
    await harness.controller.handleOutline(makeOutlineRequest({
        sessionId: 'missing-session',
        requestId: 2,
    }));
    await harness.controller.handleOutline(makeOutlineRequest({
        provider: 'unsupported-provider',
        requestId: 3,
    }));

    assert.equal(resolveCalls, 2);
    assert.deepEqual(harness.calls, { codex: 0, kimi: 0, claude: 0 });
    assert.deepEqual(
        harness.publications.map(message => message.error?.code),
        ['unavailable', 'unavailable']
    );
});

test('SESSION-CONVERSATION-HOST-003 requires a target to remain focused through outline publication', async t => {
    const pending = deferred();
    let focused = true;
    const harness = createControllerHarness({
        outlineResults: [pending.promise],
        resolveTarget: (projectId, provider, sessionId) => ({
            projectId,
            provider,
            sessionId,
            focused,
            executionState: 'running',
        }),
    });
    t.after(() => harness.controller.dispose());

    const request = harness.controller.handleOutline(makeOutlineRequest());
    focused = false;
    pending.resolve(makeOutline('codex', 'session-a'));
    await request;

    assert.equal(harness.calls.codex, 1);
    assert.deepEqual(harness.publications, []);
});

test('SESSION-CONVERSATION-HOST-004 suppresses request 9 after request 10 completes', async t => {
    const first = deferred();
    const second = deferred();
    const published = [];
    const harness = createControllerHarness({
        outlineResults: [first.promise, second.promise],
        publish: message => published.push(message),
    });
    t.after(() => harness.controller.dispose());

    const request9 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 9,
        subscriptionGeneration: 3,
    }));
    const request10 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 10,
        subscriptionGeneration: 3,
    }));
    second.resolve(makeOutline('codex', 'session-a', 'native-b'));
    await request10;
    first.resolve(makeOutline('codex', 'session-a', 'native-a'));
    await request9;

    assert.deepEqual(published.map(message => message.requestId), [10]);
});

test('SESSION-CONVERSATION-HOST-005 suppresses generation 3 after generation 4 completes', async t => {
    const first = deferred();
    const second = deferred();
    const published = [];
    const harness = createControllerHarness({
        outlineResults: [first.promise, second.promise],
        publish: message => published.push(message),
    });
    t.after(() => harness.controller.dispose());

    const generation3 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 9,
        subscriptionGeneration: 3,
    }));
    const generation4 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 10,
        subscriptionGeneration: 4,
    }));
    second.resolve(makeOutline('codex', 'session-a', 'native-b'));
    await generation4;
    first.resolve(makeOutline('codex', 'session-a', 'native-a'));
    await generation3;

    assert.deepEqual(published.map(message => [
        message.requestId,
        message.subscriptionGeneration,
    ]), [[10, 4]]);
});

test('SESSION-CONVERSATION-HOST-006 cancels debounce and deferred publication on collapse', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest({
        subscriptionGeneration: 1,
    }));
    harness.publications.length = 0;
    const readsBeforeRelease = harness.calls.codex;

    harness.invalidate();
    harness.releaseSubscription();
    harness.releaseSubscription();
    harness.clock.advanceBy(250);
    await settle();

    assert.equal(harness.calls.codex, readsBeforeRelease);
    assert.equal(harness.publications.length, 0);
});

test('SESSION-CONVERSATION-HOST-007 ignores an old cancel for a newer exact subscription', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest({
        requestId: 10,
        subscriptionGeneration: 4,
    }));
    harness.publications.length = 0;

    harness.releaseSubscription(makeCancelRequest({
        requestId: 9,
        subscriptionGeneration: 3,
    }));
    harness.invalidate();
    harness.clock.advanceBy(250);
    await settle();

    assert.equal(harness.publications.length, 1);
});

test('SESSION-CONVERSATION-HOST-008 cancel affects only the exact provider/session identity', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest({
        provider: 'codex',
        sessionId: 'same-session',
        requestId: 1,
    }));
    await harness.controller.handleOutline(makeOutlineRequest({
        provider: 'kimi',
        sessionId: 'same-session',
        requestId: 2,
    }));
    harness.publications.length = 0;

    harness.releaseSubscription(makeCancelRequest({
        provider: 'codex',
        sessionId: 'same-session',
        requestId: 3,
        subscriptionGeneration: 2,
    }));
    harness.invalidate('codex', 'same-session');
    harness.invalidate('kimi', 'same-session');
    harness.clock.advanceBy(250);
    await settle();

    assert.deepEqual(
        harness.publications.map(message => message.provider),
        ['kimi']
    );
});

test('SESSION-CONVERSATION-HOST-009 hide and dispose cancel timers, watches, and deferred reads', async () => {
    for (const action of ['hide', 'dispose']) {
        const pending = deferred();
        const harness = createControllerHarness({
            outlineResults: [pending.promise],
        });
        const request = harness.controller.handleOutline(makeOutlineRequest());
        if (action === 'hide') {
            harness.controller.setVisible(false);
        } else {
            harness.controller.dispose();
        }
        pending.resolve(makeOutline('codex', 'session-a'));
        await request;
        harness.clock.advanceBy(2_000);
        await settle();

        assert.deepEqual(harness.publications, [], action);
        harness.controller.dispose();
    }
});

test('SESSION-CONVERSATION-HOST-010 opens only an authoritative known interaction', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest());
    const result = harness.publications[0];

    await harness.controller.handleOpen({
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'unknown',
        expectedRevision: result.payload.sourceRevision,
    });
    await harness.controller.handleOpen({
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: 3,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: result.payload.sourceRevision,
    });

    assert.equal(harness.opened.length, 1);
    assert.deepEqual(harness.opened[0][0], {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
    });
});

test('SESSION-CONVERSATION-HOST-011 suppresses a stale adapter failure after focus changes', async t => {
    const pending = deferred();
    let focused = true;
    const harness = createControllerHarness({
        outlineResults: [pending.promise],
        resolveTarget: (projectId, provider, sessionId) => ({
            projectId,
            provider,
            sessionId,
            focused,
            executionState: 'running',
        }),
    });
    t.after(() => harness.controller.dispose());

    const request = harness.controller.handleOutline(makeOutlineRequest());
    focused = false;
    pending.reject(new Error('private failure after focus moved'));
    await request;

    assert.deepEqual(harness.publications, []);
});

test('SESSION-CONVERSATION-HOST-012 a newer cancel suppresses the exact deferred old publication', async t => {
    const pending = deferred();
    const harness = createControllerHarness({
        outlineResults: [pending.promise],
    });
    t.after(() => harness.controller.dispose());

    const request = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 8,
        subscriptionGeneration: 3,
    }));
    harness.releaseSubscription(makeCancelRequest({
        requestId: 9,
        subscriptionGeneration: 4,
    }));
    pending.resolve(makeOutline('codex', 'session-a'));
    await request;

    assert.deepEqual(harness.publications, []);
});

test('SESSION-CONVERSATION-HOST-013 malformed cancel envelopes cannot release a current subscription', async t => {
    const harness = createControllerHarness();
    t.after(() => harness.controller.dispose());
    await harness.controller.handleOutline(makeOutlineRequest({
        requestId: 8,
        subscriptionGeneration: 3,
    }));
    harness.publications.length = 0;

    for (const requestId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        harness.releaseSubscription(makeCancelRequest({
            requestId,
            subscriptionGeneration: 4,
        }));
    }
    harness.invalidate();
    harness.clock.advanceBy(250);
    await settle();

    assert.equal(harness.publications.length, 1);
});
