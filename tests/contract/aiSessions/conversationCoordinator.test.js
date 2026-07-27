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
    ConversationHostController,
} = require('../../../out/aiSessions/conversation/conversationHostController');
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
            readPage: overrides.readPage,
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

test('SESSION-CONVERSATION-HOST-009 hide and dispose release established watches and pending debounce timers', async () => {
    for (const action of ['hide', 'dispose']) {
        const harness = createControllerHarness();
        await harness.controller.handleOutline(makeOutlineRequest());
        harness.publications.length = 0;
        const readsBeforeInvalidation = harness.calls.codex;
        harness.invalidate();
        assert.equal(harness.clock.pendingCount, 1);

        if (action === 'hide') {
            harness.controller.setVisible(false);
        } else {
            harness.controller.dispose();
        }
        assert.equal(harness.clock.pendingCount, 0);
        assert.deepEqual(
            harness.adapters.codex.disposedWatches,
            ['session-a']
        );
        harness.clock.advanceBy(2_000);
        await settle();

        assert.equal(harness.calls.codex, readsBeforeInvalidation, action);
        assert.deepEqual(harness.publications, [], action);
        harness.controller.dispose();
    }
});

test('SESSION-CONVERSATION-HOST-LIFECYCLE-001 reconcile republishes the exact running outline with stopped projection', async t => {
    let executionState = 'running';
    const harness = createControllerHarness({
        resolveTarget: (projectId, provider, sessionId) => ({
            projectId,
            provider,
            sessionId,
            focused: true,
            executionState,
        }),
    });
    t.after(() => harness.controller.dispose());

    await harness.controller.handleOutline(makeOutlineRequest());
    assert.equal(
        harness.publications.at(-1).payload.interactions.at(-1).responseState,
        'inProgress'
    );
    const readsBeforeReconcile = harness.calls.codex;

    executionState = 'stopped';
    harness.controller.reconcile();
    await settle();

    assert.equal(harness.calls.codex, readsBeforeReconcile + 1);
    assert.equal(harness.publications.length, 2);
    assert.equal(
        harness.publications.at(-1).payload.interactions.at(-1).responseState,
        'interrupted'
    );
    assert.equal(
        harness.publications.at(-1).subscriptionGeneration,
        makeOutlineRequest().subscriptionGeneration
    );
});

test('SESSION-CONVERSATION-HOST-LIFECYCLE-002 a later reconcile suppresses an older lifecycle read', async t => {
    const stoppedRead = deferred();
    const runningRead = deferred();
    let executionState = 'running';
    const harness = createControllerHarness({
        outlineResults: [
            makeOutline('codex', 'session-a'),
            stoppedRead.promise,
            runningRead.promise,
        ],
        resolveTarget: (projectId, provider, sessionId) => ({
            projectId,
            provider,
            sessionId,
            focused: true,
            executionState,
        }),
    });
    t.after(() => harness.controller.dispose());

    await harness.controller.handleOutline(makeOutlineRequest());
    harness.publications.length = 0;
    executionState = 'stopped';
    harness.controller.reconcile();
    executionState = 'running';
    harness.controller.reconcile();
    runningRead.resolve(makeOutline('codex', 'session-a', 'native-running'));
    await settle();
    stoppedRead.resolve(makeOutline('codex', 'session-a', 'native-stopped'));
    await settle();

    assert.equal(harness.calls.codex, 3);
    assert.equal(harness.publications.length, 1);
    assert.equal(
        harness.publications[0].payload.interactions.at(-1).responseState,
        'inProgress'
    );
});

test('SESSION-CONVERSATION-LOADING-001 coalesces repeated reconciliation behind the in-flight initial outline', async t => {
    const pendingReads = [];
    const harness = createControllerHarness({
        readOutline: async (_sessionId) => {
            const pending = deferred();
            pendingReads.push(pending);
            return pending.promise;
        },
    });
    t.after(() => harness.controller.dispose());

    const initialRequest = harness.controller.handleOutline(
        makeOutlineRequest()
    );
    await settle();
    assert.equal(pendingReads.length, 1);

    for (let refresh = 0; refresh < 10; refresh += 1) {
        harness.controller.reconcile();
    }
    await settle();

    assert.equal(
        pendingReads.length,
        1,
        'reconcile must not restart and starve the initial outline'
    );
    pendingReads[0].resolve(makeOutline(
        'codex',
        'session-a',
        'native-initial'
    ));
    await initialRequest;
    await settle();

    assert.equal(harness.publications.length, 1);
    assert.equal(
        harness.publications[0].payload.sourceRevision,
        'r1'
    );
    assert.equal(
        pendingReads.length,
        2,
        'the reconciliations must coalesce into one follow-up read'
    );

    pendingReads[1].resolve(makeOutline(
        'codex',
        'session-a',
        'native-follow-up'
    ));
    await settle();

    assert.equal(harness.publications.length, 2);
    assert.equal(
        harness.publications[1].payload.sourceRevision,
        'r2'
    );
});

test('SESSION-CONVERSATION-HOST-LIFECYCLE-001 reconcile retries a missing state watch without duplicating recovery', async t => {
    let watchAttempts = 0;
    let activeInvalidation;
    let outlineReads = 0;
    let releaseCount = 0;
    const publications = [];
    const coordinator = {
        setSessionStopped() {},
        watch(_provider, _sessionId, onChange) {
            watchAttempts += 1;
            if (watchAttempts === 1) {
                throw new Error('provider watch unavailable');
            }
            activeInvalidation = onChange;
            return { id: 'recovered-watch' };
        },
        async readOutline(provider, sessionId) {
            outlineReads += 1;
            return makeOutline(provider, sessionId, `native-${outlineReads}`);
        },
        releaseSubscription(subscription) {
            assert.equal(subscription.id, 'recovered-watch');
            releaseCount += 1;
            activeInvalidation = undefined;
        },
    };
    const controller = new ConversationHostController({
        coordinator,
        resolveTarget: (projectId, provider, sessionId) => ({
            projectId,
            provider,
            sessionId,
            focused: true,
            executionState: 'running',
        }),
        publish: message => publications.push(message),
        openViewer: async () => undefined,
    });
    t.after(() => controller.dispose());

    await controller.handleOutline(makeOutlineRequest());
    assert.equal(watchAttempts, 1);
    assert.equal(outlineReads, 1);
    assert.equal(publications.length, 1);

    controller.reconcile();
    await settle();
    assert.equal(watchAttempts, 2);
    assert.equal(outlineReads, 2);
    assert.equal(publications.length, 2);

    controller.reconcile();
    await settle();
    assert.equal(watchAttempts, 2);
    activeInvalidation();
    await settle();
    assert.equal(outlineReads, 4);
    controller.dispose();
    assert.equal(releaseCount, 1);
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

test('SESSION-CONVERSATION-COORDINATOR-001 a superseded late outline cannot invalidate its published revision', async t => {
    const first = deferred();
    const second = deferred();
    const harness = createControllerHarness({
        outlineResults: [first.promise, second.promise],
        readPage: async request => makePage(
            'codex',
            request.sessionId,
            'native-b'
        ),
    });
    t.after(() => harness.controller.dispose());

    const request9 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 9,
        subscriptionGeneration: 3,
    }));
    const request10 = harness.controller.handleOutline(makeOutlineRequest({
        requestId: 10,
        subscriptionGeneration: 4,
    }));
    second.resolve(makeOutline('codex', 'session-a', 'native-b'));
    await request10;
    const publishedRevision = harness.publications[0].payload.sourceRevision;
    first.resolve(makeOutline('codex', 'session-a', 'native-a'));
    await request9;

    const page = await harness.coordinator.readPage({
        provider: 'codex',
        sessionId: 'session-a',
        anchorInteractionId: 'input-a',
        direction: 'around',
        expectedRevision: publishedRevision,
    });
    assert.equal(page.sourceRevision, publishedRevision);
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

test('SESSION-CONVERSATION-COORDINATOR-001 invalidation during initial publication triggers a second revision read', async t => {
    const firstPublication = deferred();
    const publications = [];
    const harness = createControllerHarness({
        outlineResults: [
            makeOutline('codex', 'session-a', 'native-a'),
            makeOutline('codex', 'session-a', 'native-b'),
        ],
        publish: message => {
            publications.push(message);
            return publications.length === 1
                ? firstPublication.promise
                : Promise.resolve();
        },
    });
    t.after(() => harness.controller.dispose());

    const request = harness.controller.handleOutline(makeOutlineRequest());
    await settle();
    assert.equal(publications.length, 1);
    harness.invalidate();
    harness.clock.advanceTo(250);
    await settle();
    firstPublication.resolve();
    await request;
    await settle();

    assert.equal(harness.calls.codex, 2);
    assert.deepEqual(
        publications.map(message => message.payload.sourceRevision),
        ['r1', 'r2']
    );
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
