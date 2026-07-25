'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDashboardMessageRouter } = require(
    '../../../out/dashboard/messageRouter'
);
const {
    ConversationCoordinator,
} = require('../../../out/aiSessions/conversation/coordinator');

function fakeUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

function loadConversationComposition() {
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: {
            file: value => fakeUri(`file://${value}`),
            parse: value => fakeUri(value),
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/conversation/composition');
    } finally {
        Module._load = previousLoad;
    }
}

const {
    createConversationCapability,
} = loadConversationComposition();

function makeOutlineRequest(overrides = {}) {
    return {
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 0,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        ...overrides,
    };
}

function makeOpenRequest(overrides = {}) {
    return {
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 0,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
        expectedRevision: 'r1',
        ...overrides,
    };
}

function makeService(provider, options = {}) {
    return {
        getSessions: () => ({
            available: true,
            sessions: [],
            scannedFiles: 0,
            parsedFiles: 0,
        }),
        getLifecycleSignals: () => ({}),
        watchSessionChanges: options.watchSessionChanges
            || (() => ({ dispose() {} })),
        archiveSession: () => false,
        invalidateCache() {},
        resolveConversationSource: options.resolveConversationSource,
        provider,
    };
}

function fakePanel() {
    const disposeListeners = new Set();
    const messageListeners = new Set();
    const viewStateListeners = new Set();
    let disposed = false;
    const panel = {
        title: '',
        visible: true,
        webview: {
            html: '',
            cspSource: 'fixture-csp',
            onDidReceiveMessage(listener) {
                messageListeners.add(listener);
                return { dispose: () => messageListeners.delete(listener) };
            },
            postMessage: async () => true,
            asWebviewUri: uri => fakeUri(
                uri.toString().replace('file://', 'webview://fixture/')
            ),
        },
        reveal() {},
        onDidDispose(listener) {
            disposeListeners.add(listener);
            return { dispose: () => disposeListeners.delete(listener) };
        },
        onDidChangeViewState(listener) {
            viewStateListeners.add(listener);
            return { dispose: () => viewStateListeners.delete(listener) };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            Array.from(disposeListeners).forEach(listener => listener());
        },
    };
    return panel;
}

function createFakeCodexChild(onSpawn) {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    stdin.writable = true;
    stdin.write = bytes => {
        const message = JSON.parse(bytes.toString('utf8').trim());
        if (Number.isSafeInteger(message.id)) {
            const result = message.method === 'initialize'
                ? { serverInfo: { name: 'codex', version: '1.2.3' } }
                : {};
            queueMicrotask(() => stdout.emit(
                'data',
                Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)
            ));
        }
        return true;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;
    onSpawn();
    return child;
}

function fakeConversationOutline(provider, sessionId) {
    return {
        provider,
        sessionId,
        sourceRevision: 'native-1',
        interactions: ['input-a', 'input-b'].map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: 'inProgress',
        })),
        totalInteractions: 2,
        partial: false,
    };
}

function fakeConversationPage(provider, sessionId, interactionId) {
    return {
        provider,
        sessionId,
        sourceRevision: 'native-1',
        anchorInteractionId: interactionId,
        messages: [{
            id: `${interactionId}:user`,
            interactionId,
            role: 'user',
            markdown: interactionId,
        }],
        interactionStates: [{
            interactionId,
            responseState: 'complete',
        }],
        isStart: true,
        isEnd: true,
    };
}

function createFakeAdapter(provider, options, events) {
    let disposed = false;
    let codexConnected = false;
    return {
        async readOutline(sessionId) {
            if (provider === 'codex' && !codexConnected) {
                codexConnected = true;
                await options.client.request('thread/read', {
                    threadId: sessionId,
                    includeTurns: true,
                });
            }
            return fakeConversationOutline(provider, sessionId);
        },
        async readPage(request) {
            return fakeConversationPage(
                provider,
                request.sessionId,
                request.anchorInteractionId
            );
        },
        watch() {
            let active = true;
            return {
                dispose() {
                    if (!active) return;
                    active = false;
                    events.push(`watch-dispose:${provider}`);
                },
            };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            options.client?.dispose();
            events.push(`dispose:${provider}`);
        },
    };
}

function createDashboardConversationHarness(options = {}) {
    const events = [];
    const publications = [];
    const diagnostics = [];
    const panels = [];
    const viewerTargets = [];
    const authorityCalls = [];
    const focusedSession = options.focusedSession || {
        key: 'codex:session-a',
        provider: 'codex',
        sessionId: 'session-a',
        name: 'Focused session',
        executionState: 'stopped',
        status: 'focused',
        focused: true,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
    };
    const providerHomes = options.providerHomes || {};
    const services = {
        codex: makeService('codex'),
        kimi: makeService('kimi', {
            resolveConversationSource: sessionId => (
                providerHomes.kimi && sessionId === focusedSession.sessionId
                    ? {
                        providerHome: providerHomes.kimi,
                        sourcePath: path.join(providerHomes.kimi, 'wire.jsonl'),
                    }
                    : null
            ),
        }),
        claude: makeService('claude'),
    };
    let capability;
    let router;
    const createAdapter = provider => adapterOptions => {
        events.push(`adapter:${provider}`);
        return createFakeAdapter(provider, adapterOptions, events);
    };
    const internalFactories = {
        ...(!options.useConcreteKimi
            ? { createKimiAdapter: createAdapter('kimi') }
            : {}),
        createCodexAdapter: createAdapter('codex'),
        createClaudeAdapter: createAdapter('claude'),
        createCoordinator: coordinatorOptions => {
            events.push('coordinator');
            const coordinator = new ConversationCoordinator(coordinatorOptions);
            const dispose = coordinator.dispose.bind(coordinator);
            let disposed = false;
            coordinator.dispose = () => {
                if (disposed) return;
                disposed = true;
                events.push('dispose:coordinator');
                dispose();
            };
            return coordinator;
        },
        ...(options.useConcreteViewer
            ? {}
            : {
                createViewer: () => {
                    let disposed = false;
                    return {
                        open: async target => {
                            viewerTargets.push(target);
                        },
                        refresh: async () => undefined,
                        dispose() {
                            if (disposed) return;
                            disposed = true;
                            events.push('dispose:viewer');
                        },
                    };
                },
            }),
    };

    return {
        events,
        publications,
        diagnostics,
        panels,
        viewerTargets,
        authorityCalls,
        get capability() {
            return capability;
        },
        async activate() {
            capability = createConversationCapability({
                services,
                resolveTarget(projectId, provider, sessionId) {
                    authorityCalls.push({ projectId, provider, sessionId });
                    return projectId === 'project-a'
                        && provider === focusedSession.provider
                        && sessionId === focusedSession.sessionId
                        ? focusedSession
                        : null;
                },
                publish: async message => {
                    publications.push(message);
                    return true;
                },
                createPanel: (...args) => {
                    const panel = fakePanel();
                    panel.createArguments = args;
                    panels.push(panel);
                    return panel;
                },
                openExternal: async () => true,
                spawnCodex: () => createFakeCodexChild(
                    () => events.push('codex-child')
                ),
                now: () => Date.now(),
                setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
                clearTimer: handle => clearTimeout(handle),
                onDiagnostic: event => diagnostics.push(event),
            }, internalFactories);
            router = createDashboardMessageRouter({
                handlers: {
                    'request-ai-session-conversation-outline': message =>
                        capability.controller.handleOutline(message),
                    'open-ai-session-conversation': message =>
                        capability.controller.handleOpen(message),
                    'cancel-ai-session-conversation': message =>
                        capability.controller.cancel(message),
                },
            });
        },
        route(message) {
            return router(message);
        },
        async requestOutline(session = focusedSession) {
            await router(makeOutlineRequest({
                provider: session.provider,
                sessionId: session.sessionId,
            }));
            return publications.at(-1);
        },
        async openInteraction(session, interactionId, expectedRevision) {
            await router(makeOpenRequest({
                provider: session.provider,
                sessionId: session.sessionId,
                interactionId,
                expectedRevision,
            }));
        },
        setVisible(visible) {
            capability.controller.setVisible(visible);
        },
        async dispose() {
            capability.dispose();
        },
    };
}

async function createKimiConversationFixture(t, exchanges) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-composed-')
    );
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    const records = exchanges.flatMap((exchange, index) => [
        {
            type: 'TurnBegin',
            timestamp: 1000 + index,
            payload: { user_input: exchange.user },
        },
        {
            type: 'ContentPart',
            payload: { type: 'text', text: exchange.assistant },
        },
        { type: 'TurnEnd', payload: {} },
    ]);
    await fs.promises.writeFile(
        sourcePath,
        `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    );
    t.after(() => fs.promises.rm(
        providerHome,
        { recursive: true, force: true }
    ));
    return {
        providerHome,
        session: {
            key: 'kimi:22222222-2222-4222-8222-222222222222',
            provider: 'kimi',
            sessionId: '22222222-2222-4222-8222-222222222222',
            name: 'Composed Kimi session',
            executionState: 'running',
            status: 'focused',
            focused: true,
            needsAttention: false,
            pending: false,
            backend: 'vscode',
            attached: true,
        },
    };
}

test('WEBVIEW-CONVERSATION-ROUTING-001 routes the three conversation messages through exact ordinary handler keys', async () => {
    const calls = [];
    const controller = {
        handleOutline: message => calls.push(['outline', message.requestId]),
        handleOpen: message => calls.push(['open', message.requestId]),
        cancel: message => calls.push(['cancel', message.requestId]),
    };
    const router = createDashboardMessageRouter({
        handlers: {
            'request-ai-session-conversation-outline': message =>
                controller.handleOutline(message),
            'open-ai-session-conversation': message =>
                controller.handleOpen(message),
            'cancel-ai-session-conversation': message =>
                controller.cancel(message),
        },
        getAiSessionProviderIds: () => ['codex', 'kimi', 'claude'],
    });

    await router({
        type: 'request-ai-session-conversation-outline',
        requestId: 1,
    });
    await router({
        type: 'open-ai-session-conversation',
        requestId: 2,
    });
    await router({
        type: 'cancel-ai-session-conversation',
        requestId: 3,
    });
    await router({
        type: 'request-codex-session-conversation-outline',
        requestId: 4,
    });
    await router({
        type: 'open-kimi-session-conversation',
        requestId: 5,
    });
    await router({
        type: 'cancel-claude-session-conversation',
        requestId: 6,
    });

    assert.deepEqual(calls, [
        ['outline', 1],
        ['open', 2],
        ['cancel', 3],
    ]);
});

test('WEBVIEW-CONVERSATION-ROUTING-002 rejects non-string message types without coercing attacker-controlled values', async () => {
    let coerced = false;
    let routed = false;
    const router = createDashboardMessageRouter({
        handlers: {
            'request-ai-session-conversation-outline': () => {
                routed = true;
            },
        },
    });

    await router({
        type: {
            toString() {
                coerced = true;
                return 'request-ai-session-conversation-outline';
            },
        },
    });

    assert.equal(coerced, false);
    assert.equal(routed, false);
});

test('WEBVIEW-CONVERSATION-ROUTING-003 does not route inherited handler properties', async () => {
    let routed = false;
    const handlers = Object.create({
        'request-ai-session-conversation-outline': () => {
            routed = true;
        },
    });
    const router = createDashboardMessageRouter({ handlers });

    await router({
        type: 'request-ai-session-conversation-outline',
        requestId: 1,
    });

    assert.equal(routed, false);
});

test('PRODUCTION-CONVERSATION-COMPOSITION-001 creates one provider graph and disposes it once', async () => {
    const harness = createDashboardConversationHarness();
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest({
        interactionId: 'input-a',
        requestId: 2,
    }));
    await harness.route(makeOpenRequest({
        interactionId: 'input-b',
        requestId: 3,
    }));

    assert.deepEqual(
        harness.events.filter(event => event.startsWith('adapter:')),
        ['adapter:codex', 'adapter:kimi', 'adapter:claude']
    );
    assert.equal(
        harness.events.filter(event => event === 'coordinator').length,
        1
    );
    assert.equal(
        harness.events.filter(event => event === 'codex-child').length,
        1
    );
    assert.deepEqual(harness.viewerTargets.map(target => target.interactionId), [
        'input-a',
        'input-b',
    ]);
    assert.deepEqual(harness.authorityCalls[0], {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(
        harness.publications[0].payload.interactions[0].responseState,
        'interrupted'
    );

    harness.setVisible(false);
    assert.ok(harness.events.includes('watch-dispose:codex'));
    assert.equal(harness.events.includes('dispose:viewer'), false);
    await harness.dispose();
    await harness.dispose();
    assert.deepEqual(
        new Set(harness.events.filter(event => event.startsWith('dispose:'))),
        new Set([
            'dispose:viewer',
            'dispose:coordinator',
            'dispose:codex',
            'dispose:kimi',
            'dispose:claude',
        ])
    );
    assert.equal(
        harness.events.filter(event => event === 'dispose:viewer').length,
        1
    );
});

test('PRODUCTION-CONVERSATION-COMPOSITION-002 keeps exact current-workspace authority for focused outlines', async () => {
    const harness = createDashboardConversationHarness();
    await harness.activate();
    await harness.route(makeOutlineRequest({
        requestId: 9,
        projectId: 'navigation-project',
    }));

    assert.deepEqual(harness.authorityCalls.at(-1), {
        projectId: 'navigation-project',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.deepEqual(harness.publications.at(-1).error, {
        code: 'unavailable',
        reason: undefined,
        retryAfterMs: undefined,
    });
    await harness.dispose();
});

test('opens one read-only AI Conversation panel through the composed Kimi flow', async t => {
    const fixture = await createKimiConversationFixture(t, [
        {
            user: 'extension-host-private-prompt',
            assistant: 'visible response',
        },
    ]);
    const harness = createDashboardConversationHarness({
        providerHomes: { kimi: fixture.providerHome },
        focusedSession: fixture.session,
        useConcreteKimi: true,
        useConcreteViewer: true,
    });
    await harness.activate();
    t.after(() => harness.dispose());

    const outline = await harness.requestOutline(fixture.session);
    assert.equal(outline.payload.interactions.length, 1);
    await harness.openInteraction(
        fixture.session,
        outline.payload.interactions[0].id,
        outline.payload.sourceRevision
    );
    assert.equal(
        harness.panels.filter(panel => panel.title === 'AI Conversation').length,
        1
    );
    harness.panels[0].dispose();
    assert.equal(
        JSON.stringify(harness.diagnostics)
            .includes('extension-host-private-prompt'),
        false
    );
});
