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
const {
    withConversationDisplayMetadata,
} = require('../../../out/aiSessions/conversation/conversationHostController');
const ClaudeSessionService = require(
    '../../../out/services/claudeSessionService'
).default;

const executedCommands = [];
let focusCommandFailure = null;

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
        commands: {
            async executeCommand(command) {
                executedCommands.push(command);
                if (focusCommandFailure) {
                    throw focusCommandFailure;
                }
            },
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
        postMessageResult: true,
        postedMessages: [],
        webview: {
            html: '',
            cspSource: 'fixture-csp',
            onDidReceiveMessage(listener) {
                messageListeners.add(listener);
                return { dispose: () => messageListeners.delete(listener) };
            },
            postMessage: async message => {
                panel.postedMessages.push(message);
                return panel.postMessageResult;
            },
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
        async receiveMessage(message) {
            await Promise.all(
                Array.from(messageListeners).map(listener => listener(message))
            );
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
            events.push(`read-outline:${provider}`);
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
            events.push(`read-page:${provider}`);
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
    const sessionFocusTargets = [];
    const authorityCalls = [];
    const kimiSourceCalls = [];
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
        codex: options.codexService || makeService('codex'),
        kimi: options.kimiService || makeService('kimi', {
            resolveConversationSource: (sessionId, ...candidateArgs) => {
                kimiSourceCalls.push([sessionId, ...candidateArgs]);
                return providerHomes.kimi && sessionId === focusedSession.sessionId
                    ? {
                        providerHome: providerHomes.kimi,
                        sourcePath: path.join(providerHomes.kimi, 'wire.jsonl'),
                    }
                    : null;
            },
        }),
        claude: options.claudeService || makeService('claude'),
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
        ...(!options.useConcreteClaude
            ? { createClaudeAdapter: createAdapter('claude') }
            : {}),
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
                        reconcileAuthority:
                            options.viewerReconcileAuthority
                            || (async () => undefined),
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
        sessionFocusTargets,
        authorityCalls,
        kimiSourceCalls,
        get capability() {
            return capability;
        },
        async activate() {
            capability = createConversationCapability({
                services,
                resolveTarget(projectId, provider, sessionId) {
                    authorityCalls.push({ projectId, provider, sessionId });
                    return (options.isTargetAvailable?.() ?? true)
                        && projectId === 'project-a'
                        && provider === focusedSession.provider
                        && sessionId === focusedSession.sessionId
                        ? focusedSession
                        : null;
                },
                publish: async message => {
                    publications.push(message);
                    return options.publishResult ?? true;
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
                getWorkspaceRootHostPaths:
                    options.getWorkspaceRootHostPaths,
                submitPrompt: options.submitPrompt || (async () => undefined),
                focusSession: target => {
                    sessionFocusTargets.push(target);
                },
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
        async requestOutline(session = focusedSession, overrides = {}) {
            await router(makeOutlineRequest({
                provider: session.provider,
                sessionId: session.sessionId,
                ...overrides,
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
        resetView() {
            capability.controller.resetView();
        },
        reconcile() {
            return capability.reconcile();
        },
        async dispose() {
            capability.dispose();
        },
    };
}

async function createKimiConversationFixture(t) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-kimi-composed-')
    );
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    await fs.promises.copyFile(
        path.join(
            __dirname,
            '..',
            '..',
            'fixtures',
            'providers',
            'kimi',
            'home',
            'sessions',
            '7bbd38310db600bd89c814e224a73d44',
            '33333333-3333-4333-8333-333333333333',
            'wire.jsonl'
        ),
        sourcePath
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

async function createScopedClaudeDuplicateFixture(t) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-claude-composed-')
    );
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const roots = {
        a: path.join(providerHome, 'workspace-a'),
        b: path.join(providerHome, 'workspace-b'),
        wrong: path.join(providerHome, 'workspace-wrong'),
    };
    await Promise.all(Object.values(roots).map(root =>
        fs.promises.mkdir(root, { recursive: true })
    ));
    for (const [key, root] of Object.entries({ a: roots.a, b: roots.b })) {
        const projectDirectory = path.join(providerHome, 'projects', key);
        await fs.promises.mkdir(projectDirectory, { recursive: true });
        const records = [
            { sessionId, cwd: root },
            {
                type: 'user',
                uuid: `claude-user-${key}`,
                message: {
                    role: 'user',
                    content: [{
                        type: 'text',
                        text: `Visible ${key.toUpperCase()} prompt`,
                    }],
                },
            },
            {
                type: 'assistant',
                uuid: `claude-assistant-${key}`,
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'text',
                        text: `Visible ${key.toUpperCase()} response`,
                    }],
                },
            },
        ];
        await fs.promises.writeFile(
            path.join(projectDirectory, `${sessionId}.jsonl`),
            `${records.map(record => JSON.stringify(record)).join('\n')}\n`
        );
    }
    t.after(() => fs.promises.rm(
        providerHome,
        { recursive: true, force: true }
    ));
    const service = new ClaudeSessionService();
    service.getClaudeHome = () => providerHome;
    return {
        roots,
        service,
        session: {
            key: `claude:${sessionId}`,
            provider: 'claude',
            sessionId,
            name: 'Scoped Claude session',
            executionState: 'stopped',
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

test('PRODUCTION-CONVERSATION-LIFECYCLE-001 hidden sidebar keeps the exact viewer authority lifecycle live', async () => {
    let targetAvailable = true;
    const focusedSession = {
        key: 'codex:session-a',
        provider: 'codex',
        sessionId: 'session-a',
        name: 'Focused session',
        executionState: 'running',
        status: 'focused',
        focused: true,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
    };
    const harness = createDashboardConversationHarness({
        focusedSession,
        isTargetAvailable: () => targetAvailable,
        useConcreteViewer: true,
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    const readsBeforeLifecycle = harness.events.filter(event =>
        event === 'read-outline:codex' || event === 'read-page:codex'
    ).length;

    harness.setVisible(false);
    focusedSession.executionState = 'stopped';
    await harness.reconcile();
    const readsAfterStopped = harness.events.filter(event =>
        event === 'read-outline:codex' || event === 'read-page:codex'
    ).length;
    assert.equal(readsAfterStopped, readsBeforeLifecycle + 2);
    assert.equal(harness.panels.length, 1);

    targetAvailable = false;
    await harness.reconcile();
    assert.ok(harness.events.includes('watch-dispose:codex'));
    const stale = harness.panels[0].postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(stale.stale, true);
    const readsWhileUnavailable = harness.events.filter(event =>
        event === 'read-outline:codex' || event === 'read-page:codex'
    ).length;

    targetAvailable = true;
    await harness.reconcile();
    assert.equal(
        harness.events.filter(event =>
            event === 'read-outline:codex' || event === 'read-page:codex'
        ).length,
        readsWhileUnavailable + 2
    );
    assert.equal(
        harness.panels[0].postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1).stale,
        false
    );
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-LIFECYCLE-002 fire-and-forget reconcile isolates viewer failures to one sanitized diagnostic', async () => {
    const secret = [
        '/private/viewer/reconcile',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'private prompt',
    ].join(' ');
    const harness = createDashboardConversationHarness({
        viewerReconcileAuthority: async () => {
            throw new Error(secret);
        },
    });
    await harness.activate();

    await assert.doesNotReject(harness.capability.reconcile());
    assert.deepEqual(harness.diagnostics, [{
        event: 'conversation-read',
        category: 'unavailable',
    }]);
    assert.equal(
        JSON.stringify(harness.diagnostics).includes(secret),
        false
    );
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-LIFECYCLE-003 accepts a fresh Webview generation after replacement teardown', async () => {
    const harness = createDashboardConversationHarness();
    await harness.activate();
    await harness.route(makeOutlineRequest({
        requestId: 9,
        subscriptionGeneration: 7,
    }));
    const publicationsBeforeReplacement = harness.publications.length;

    harness.resetView();
    harness.setVisible(true);
    await harness.route(makeOutlineRequest({
        requestId: 1,
        subscriptionGeneration: 1,
    }));

    assert.equal(
        harness.publications.length,
        publicationsBeforeReplacement + 1
    );
    assert.deepEqual(
        {
            requestId: harness.publications.at(-1).requestId,
            subscriptionGeneration:
                harness.publications.at(-1).subscriptionGeneration,
        },
        {
            requestId: 1,
            subscriptionGeneration: 1,
        }
    );
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-COMMENTS-001 CONVERSATION-COMMENTS-REVIEW-001 settles review mutations, cross-page location, and one host-owned batch', async () => {
    const prompts = [];
    const harness = createDashboardConversationHarness({
        useConcreteViewer: true,
        submitPrompt: async (_target, prompt) => {
            prompts.push(prompt);
        },
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    const panel = harness.panels[0];
    const base = {
        version: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };

    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: 'comment:add:1',
        operation: 'add',
        expectedRevision: 0,
        payload: {
            messageId: 'input-a:user',
            interactionId: 'input-a',
            quote: 'input-a',
            prefix: '',
            suffix: '',
            comment: 'Explain this behavior.',
        },
    });
    const added = panel.postedMessages.at(-1);
    assert.equal(added.type, 'conversation-viewer-comments-result');
    assert.equal(added.success, true);
    assert.equal(added.revision, 1);
    assert.equal(added.comments.length, 1);
    assert.equal(added.comments[0].status, 'open');

    await panel.receiveMessage({
        type: 'conversation-viewer-next',
        version: 1,
    });
    assert.equal(
        panel.postedMessages.at(-1).selectedInteractionId,
        'input-b'
    );
    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-locate-comment',
        requestId: 'comment:locate:2',
        commentId: added.comments[0].id,
    });
    const located = panel.postedMessages.at(-1);
    assert.equal(located.type, 'conversation-viewer-locate-comment-result');
    assert.equal(located.success, true);
    assert.equal(located.commentId, added.comments[0].id);
    assert.equal(
        panel.postedMessages.at(-2).selectedInteractionId,
        'input-a'
    );

    const htmlBeforeUndeliveredLocate = panel.webview.html;
    panel.postMessageResult = false;
    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-locate-comment',
        requestId: 'comment:locate:undelivered',
        commentId: added.comments[0].id,
    });
    assert.notEqual(panel.webview.html, htmlBeforeUndeliveredLocate);
    panel.postMessageResult = true;

    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: 'comment:update:3',
        operation: 'update',
        expectedRevision: 1,
        payload: {
            commentId: added.comments[0].id,
            comment: 'Explain and test this behavior.',
        },
    });
    const updated = panel.postedMessages.at(-1);
    assert.equal(updated.revision, 2);
    assert.equal(
        updated.comments[0].comment,
        'Explain and test this behavior.'
    );

    const send = {
        ...base,
        type: 'conversation-viewer-send-comments',
        requestId: 'comment:send:4',
        operation: 'sendComments',
        expectedRevision: 2,
        payload: {},
    };
    await panel.receiveMessage(send);
    const sent = panel.postedMessages.at(-1);
    assert.equal(sent.success, true);
    assert.equal(sent.revision, 3);
    assert.equal(sent.comments.length, 1);
    assert.equal(sent.comments[0].status, 'sent');
    assert.equal(prompts.length, 1);
    assert.deepEqual(harness.sessionFocusTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }]);
    assert.match(prompts[0], /\[批注 1\]/);
    assert.match(prompts[0], /Explain and test this behavior\./);

    await panel.receiveMessage(send);
    assert.equal(prompts.length, 1, 'a duplicate send request must not resubmit');
    assert.equal(
        harness.sessionFocusTargets.length,
        1,
        'a duplicate send request must not refocus the session'
    );
    assert.deepEqual(panel.postedMessages.at(-1), sent);
    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: send.requestId,
        operation: 'delete',
        expectedRevision: 3,
        payload: { commentId: added.comments[0].id },
    });
    const collision = panel.postedMessages.at(-1);
    assert.equal(collision.operation, 'delete');
    assert.equal(collision.success, false);
    assert.equal(collision.error, 'invalid');
    assert.equal(prompts.length, 1);

    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: 'comment:resolve:5',
        operation: 'resolve',
        expectedRevision: 3,
        payload: { commentId: added.comments[0].id },
    });
    const resolved = panel.postedMessages.at(-1);
    assert.equal(resolved.success, true);
    assert.equal(resolved.revision, 4);
    assert.equal(resolved.comments[0].status, 'resolved');

    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: 'comment:reopen:6',
        operation: 'reopen',
        expectedRevision: 4,
        payload: { commentId: added.comments[0].id },
    });
    const reopened = panel.postedMessages.at(-1);
    assert.equal(reopened.success, true);
    assert.equal(reopened.revision, 5);
    assert.equal(reopened.comments[0].status, 'open');
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-COMMENTS-002 keeps authoritative drafts after submission failure', async () => {
    const harness = createDashboardConversationHarness({
        useConcreteViewer: true,
        submitPrompt: async () => {
            throw new Error('private provider failure');
        },
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    const panel = harness.panels[0];
    const base = {
        version: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-comment-mutation',
        requestId: 'failure:add:1',
        operation: 'add',
        expectedRevision: 0,
        payload: {
            messageId: 'input-a:user',
            interactionId: 'input-a',
            quote: 'input-a',
            prefix: '',
            suffix: '',
            comment: 'Keep this draft.',
        },
    });
    await panel.receiveMessage({
        ...base,
        type: 'conversation-viewer-send-comments',
        requestId: 'failure:send:2',
        operation: 'sendComments',
        expectedRevision: 1,
        payload: {},
    });

    const failure = panel.postedMessages.at(-1);
    assert.equal(failure.success, false);
    assert.equal(failure.error, 'failed');
    assert.equal(failure.revision, 1);
    assert.equal(failure.comments.length, 1);
    assert.equal(
        JSON.stringify(failure).includes('private provider failure'),
        false
    );
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-DISPLAY-001 derives duplicate metadata only from normalized same-provider active names', async () => {
    const focused = {
        key: 'codex:session-a',
        provider: 'codex',
        sessionId: 'session-a',
        name: '  Shared Name  ',
        executionState: 'running',
        status: 'focused',
        focused: true,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
    };
    const sameProviderDuplicate = {
        ...focused,
        key: 'codex:session-b',
        sessionId: 'session-b',
        name: 'shared name',
        focused: false,
    };
    const crossProviderDuplicate = {
        ...focused,
        key: 'kimi:session-c',
        provider: 'kimi',
        sessionId: 'session-c',
        name: 'SHARED NAME',
        focused: false,
    };
    const different = {
        ...focused,
        key: 'codex:session-d',
        sessionId: 'session-d',
        name: 'Different',
        focused: false,
    };
    const activeSessions = [
        focused,
        sameProviderDuplicate,
        crossProviderDuplicate,
        different,
    ];

    assert.deepEqual(
        withConversationDisplayMetadata(focused, activeSessions),
        {
            ...focused,
            conversationDisplayName: 'Shared Name',
            duplicateConversationDisplayName: true,
        }
    );
    assert.equal(
        withConversationDisplayMetadata(different, activeSessions)
            .duplicateConversationDisplayName,
        false
    );
    assert.equal(
        withConversationDisplayMetadata(crossProviderDuplicate, [
            crossProviderDuplicate,
            focused,
        ]).duplicateConversationDisplayName,
        false
    );

    const authoritative = withConversationDisplayMetadata(
        focused,
        activeSessions
    );
    const harness = createDashboardConversationHarness({
        focusedSession: authoritative,
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    assert.deepEqual(harness.viewerTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
        expectedRevision: 'r1',
        displayName: 'Shared Name',
        duplicateDisplayName: true,
    }]);
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-CLAUDE-SCOPE-001 dynamically resolves duplicate UUID sources only from current workspace roots', async t => {
    const fixture = await createScopedClaudeDuplicateFixture(t);
    let currentRoots = [fixture.roots.a];
    const harness = createDashboardConversationHarness({
        claudeService: fixture.service,
        focusedSession: fixture.session,
        getWorkspaceRootHostPaths: () => currentRoots,
        useConcreteClaude: true,
    });
    await harness.activate();
    t.after(() => harness.dispose());

    const outlineA = await harness.requestOutline(fixture.session);
    assert.equal(outlineA.error, undefined);
    assert.equal(outlineA.payload.interactions[0].userPreview, 'Visible A prompt');

    currentRoots = [fixture.roots.b];
    const outlineB = await harness.requestOutline(fixture.session, {
        requestId: 2,
        subscriptionGeneration: 1,
    });
    assert.equal(outlineB.error, undefined);
    assert.equal(outlineB.payload.interactions[0].userPreview, 'Visible B prompt');

    currentRoots = [fixture.roots.wrong];
    const unavailable = await harness.requestOutline(fixture.session, {
        requestId: 3,
        subscriptionGeneration: 2,
    });
    assert.equal(unavailable.error.code, 'unavailable');
    assert.equal(unavailable.payload, undefined);
});

test('PRODUCTION-CONVERSATION-FOCUS-001 panel close reveals the sidebar before publishing one exact focus origin', async () => {
    executedCommands.length = 0;
    focusCommandFailure = null;
    const harness = createDashboardConversationHarness({
        useConcreteViewer: true,
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    harness.panels[0].dispose();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(executedCommands, ['agentPivot.dashboard.focus']);
    const focusMessage = harness.publications.at(-1);
    assert.deepEqual(focusMessage, {
        type: 'focus-ai-session-conversation-origin',
        version: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
    });
    assert.deepEqual(Object.keys(focusMessage).sort(), [
        'interactionId',
        'projectId',
        'provider',
        'sessionId',
        'type',
        'version',
    ]);
    await harness.dispose();
});

test('PRODUCTION-CONVERSATION-FOCUS-002 rejected reveal and hidden delivery remain isolated while publishing the fallback', async t => {
    executedCommands.length = 0;
    focusCommandFailure = new Error([
        '/private/focus/path',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'private prompt',
    ].join(' '));
    t.after(() => {
        focusCommandFailure = null;
    });
    const harness = createDashboardConversationHarness({
        publishResult: false,
        useConcreteViewer: true,
    });
    await harness.activate();
    await harness.route(makeOutlineRequest());
    await harness.route(makeOpenRequest());
    harness.setVisible(false);
    harness.panels[0].dispose();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(executedCommands, ['agentPivot.dashboard.focus']);
    assert.deepEqual(harness.publications.at(-1), {
        type: 'focus-ai-session-conversation-origin',
        version: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
    });
    assert.equal(
        JSON.stringify(harness.diagnostics)
            .includes('private prompt'),
        false
    );
    await harness.dispose();
});

test('opens one comment-enabled AI Conversation panel through the composed Kimi flow', async t => {
    const fixture = await createKimiConversationFixture(t);
    const harness = createDashboardConversationHarness({
        providerHomes: { kimi: fixture.providerHome },
        focusedSession: fixture.session,
        useConcreteKimi: true,
        useConcreteViewer: true,
    });
    await harness.activate();
    t.after(() => harness.dispose());

    const outline = await harness.requestOutline(fixture.session);
    assert.equal(outline.payload.interactions.length, 3);
    await harness.openInteraction(
        fixture.session,
        outline.payload.interactions[0].id,
        outline.payload.sourceRevision
    );
    assert.equal(
        harness.panels.filter(panel => panel.title === 'AI Conversation').length,
        1
    );
    const panelHtml = harness.panels[0].webview.html;
    assert.equal(panelHtml.includes('The parser reads visible tokens.'), true);
    assert.equal(panelHtml.includes('Explain the parser'), true);
    assert.equal(
        panelHtml.includes(outline.payload.interactions[0].id),
        true
    );
    assert.equal(panelHtml.includes('contenteditable'), false);
    assert.equal(panelHtml.includes('data-comment-input'), true);
    assert.equal(panelHtml.includes('secret-thought'), false);
    assert.equal(panelHtml.includes('local/path'), false);
    assert.ok(harness.kimiSourceCalls.length >= 1);
    assert.equal(
        harness.kimiSourceCalls.every(call =>
            call.length === 1 && call[0] === fixture.session.sessionId
        ),
        true
    );
    harness.panels[0].dispose();
    assert.equal(
        JSON.stringify(harness.diagnostics)
            .includes('secret-thought'),
        false
    );
});
