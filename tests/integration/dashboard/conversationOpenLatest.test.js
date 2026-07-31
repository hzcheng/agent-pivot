'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function fakeUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(next => {
        resolve = next;
    });
    return { promise, resolve };
}

function loadConversationComposition() {
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: {
            file: value => fakeUri(`file://${value}`),
            parse: value => fakeUri(value),
        },
        commands: {
            async executeCommand() {},
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

function makeService(provider) {
    return {
        getSessions: () => ({
            available: true,
            sessions: [],
            scannedFiles: 0,
            parsedFiles: 0,
        }),
        getLifecycleSignals: () => ({}),
        watchSessionChanges: () => ({ dispose() {} }),
        archiveSession: () => false,
        invalidateCache() {},
        resolveConversationSource: () => null,
        provider,
    };
}

function makeOutline(provider, sessionId, interactionIds) {
    return {
        provider,
        sessionId,
        sourceRevision: 'native-1',
        interactions: interactionIds.map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: 'complete',
        })),
        totalInteractions: interactionIds.length,
        partial: false,
    };
}

function makeSession(overrides = {}) {
    return {
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
        ...overrides,
    };
}

function createHarness(options = {}) {
    const viewerTargets = [];
    const followedViewerTargets = [];
    let outlineReads = 0;
    const session = 'session' in options ? options.session : makeSession({
        conversationDisplayName: options.conversationDisplayName,
        duplicateConversationDisplayName:
            options.duplicateConversationDisplayName,
    });
    const fakeAdapter = provider => () => ({
        async readOutline(sessionId) {
            outlineReads += 1;
            if (options.readOutline) {
                return options.readOutline(provider, sessionId);
            }
            if (options.readOutlineError) {
                throw options.readOutlineError;
            }
            return makeOutline(
                provider,
                sessionId,
                options.interactionIds || ['input-a', 'input-b']
            );
        },
        async readPage() {
            throw new Error('readPage is not used by openLatestConversation');
        },
        watch() {
            return { dispose() {} };
        },
        dispose() {},
    });
    const capability = createConversationCapability({
        services: {
            codex: makeService('codex'),
            kimi: makeService('kimi'),
            claude: makeService('claude'),
        },
        resolveTarget: options.resolveTarget || (() => session),
        publish: async () => true,
        createPanel: () => {
            throw new Error('createPanel is not used by openLatestConversation');
        },
        openExternal: async () => true,
        spawnCodex: () => {
            throw new Error('spawnCodex is not used by openLatestConversation');
        },
        now: () => Date.now(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
        onDiagnostic: () => {},
    }, {
        createCodexClient: options.createCodexClient || (() => ({ dispose() {} })),
        createCodexAdapter: fakeAdapter('codex'),
        createKimiAdapter: fakeAdapter('kimi'),
        createClaudeAdapter: fakeAdapter('claude'),
        createViewer: () => ({
            isOpen: () => options.viewerOpen === true,
            open: async target => {
                viewerTargets.push(target);
            },
            follow: async target => {
                followedViewerTargets.push(target);
                return true;
            },
            refresh: async () => undefined,
            reconcileAuthority: async () => undefined,
            dispose() {},
        }),
    });
    return {
        capability,
        viewerTargets,
        followedViewerTargets,
        get outlineReads() {
            return outlineReads;
        },
    };
}

test('CONVERSATION-OPEN-LATEST-001 opens the latest interaction of the resolved session', async () => {
    const { capability, viewerTargets } = createHarness();
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'opened');
    assert.deepEqual(viewerTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    }]);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 prefers conversation display metadata for the viewer target', async () => {
    const { capability, viewerTargets } = createHarness({
        conversationDisplayName: 'Renamed session',
        duplicateConversationDisplayName: true,
    });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'opened');
    assert.equal(viewerTargets.length, 1);
    assert.equal(viewerTargets[0].displayName, 'Renamed session');
    assert.equal(viewerTargets[0].duplicateDisplayName, true);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports empty when the conversation has no interactions', async () => {
    const { capability, viewerTargets } = createHarness({ interactionIds: [] });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'empty');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports unavailable when the outline cannot be read', async () => {
    const { capability, viewerTargets } = createHarness({
        readOutlineError: new Error('boom'),
    });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unavailable');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports unknownSession when the target is not authoritative', async () => {
    const { capability, viewerTargets } = createHarness({ session: null });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unknownSession');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 unavailable capability rejects openLatestConversation', async () => {
    const { capability, viewerTargets } = createHarness({
        createCodexClient: () => {
            throw new Error('construction failed');
        },
    });
    assert.equal(capability.availability, 'unavailable');
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unavailable');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 follows the latest interaction only while AI Conversation is already open', async () => {
    const openHarness = createHarness({ viewerOpen: true });
    assert.equal(await openHarness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(openHarness.followedViewerTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    }]);
    assert.deepEqual(openHarness.viewerTargets, []);

    const closedHarness = createHarness({
        viewerOpen: false,
        readOutlineError: new Error('must not read while closed'),
    });
    assert.equal(await closedHarness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'closed');
    assert.equal(closedHarness.outlineReads, 0);
    assert.deepEqual(closedHarness.followedViewerTargets, []);
    openHarness.capability.dispose();
    closedHarness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 routes a successful Active Session card focus into Conversation following', () => {
    const dashboardSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );
    const handler = dashboardSource.match(
        /'focus-ai-session-terminal': async e => \{[\s\S]*?\n\s*\},\n\s*'focus-pending-ai-session'/
    );
    assert.ok(handler, 'Active Session focus handler must remain inspectable');
    assert.match(handler[0], /focusActive\(/);
    assert.match(
        handler[0],
        /if \(focused\) \{[\s\S]*followActiveConversation\(/
    );
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 lets the newest Session follow intent win when an older outline resolves late', async () => {
    const slowOutline = deferred();
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) => makeSession({
            key: `${provider}:${sessionId}`,
            provider,
            sessionId,
            name: sessionId,
        }),
        readOutline: (provider, sessionId) => sessionId === 'session-a'
            ? slowOutline.promise
            : makeOutline(provider, sessionId, ['input-b']),
    });
    const first = harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    }), 'opened');
    slowOutline.resolve(makeOutline('codex', 'session-a', ['input-a']));
    assert.equal(await first, 'superseded');
    assert.deepEqual(
        harness.followedViewerTargets.map(target => target.sessionId),
        ['session-b']
    );
    harness.capability.dispose();
});
