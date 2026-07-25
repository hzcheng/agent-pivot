'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function fakeUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

function loadConversationViewer() {
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: { parse: value => fakeUri(value) },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/conversation/viewer');
    } finally {
        Module._load = previousLoad;
    }
}

const { ConversationViewer } = loadConversationViewer();

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function target(sessionId, interactionId = 'input-1', overrides = {}) {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        interactionId,
        expectedRevision: 'r1',
        displayName: `Conversation ${sessionId}`,
        duplicateDisplayName: false,
        ...overrides,
    };
}

function page(
    sessionId,
    interactionId = 'input-1',
    visible = 'visible',
    options = {}
) {
    const count = options.count || 1;
    const interactionOffset = options.interactionOffset || 0;
    const padding = options.padding || '';
    const interactionIds = options.interactionIds || Array.from(
        { length: count },
        (_item, index) => index === 0
            ? interactionId
            : `${interactionId}-${interactionOffset + index}`
    );
    return {
        provider: 'codex',
        sessionId,
        sourceRevision: options.sourceRevision || 'r1',
        anchorInteractionId: options.anchorInteractionId || interactionIds[0],
        messages: interactionIds.map((id, index) => ({
            id: `${id}:user`,
            interactionId: id,
            role: 'user',
            markdown: `${visible}-${index}${padding}`,
        })),
        interactionStates: interactionIds.map(id => ({
            interactionId: id,
            responseState: 'complete',
        })),
        previousCursor: options.previousCursor,
        nextCursor: options.nextCursor,
        isStart: options.previousCursor === undefined,
        isEnd: options.nextCursor === undefined,
    };
}

function outline(sessionId, interactionIds, options = {}) {
    return {
        provider: 'codex',
        sessionId,
        sourceRevision: options.sourceRevision || 'r1',
        interactions: interactionIds.map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: 'complete',
        })),
        totalInteractions: options.totalInteractions || interactionIds.length,
        partial: options.partial || false,
    };
}

function retainedPageInteractionIds(pageIndex, pageSize, prefix) {
    const first = pageIndex === 0 ? 'selected-anchor' : `${prefix}-${pageIndex}`;
    return Array.from(
        { length: pageSize },
        (_item, index) => index === 0
            ? first
            : `${first}-${pageIndex * pageSize + index}`
    );
}

function fakePanel() {
    const disposeListeners = new Set();
    const messageListeners = new Set();
    let disposed = false;
    const panel = {
        createCount: 0,
        revealCount: 0,
        postedMessages: [],
        createArguments: undefined,
        webview: {
            html: '',
            cspSource: 'fixture-csp',
            options: {},
            onDidReceiveMessage(listener) {
                messageListeners.add(listener);
                return { dispose: () => messageListeners.delete(listener) };
            },
            postMessage(message) {
                panel.postedMessages.push(message);
                return Promise.resolve(true);
            },
            asWebviewUri(uri) {
                return fakeUri(uri.toString().replace(
                    'file://',
                    'webview://fixture/'
                ));
            },
        },
        reveal() {
            panel.revealCount += 1;
        },
        onDidDispose(listener) {
            disposeListeners.add(listener);
            return { dispose: () => disposeListeners.delete(listener) };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            Array.from(disposeListeners).forEach(listener => listener());
        },
        async receive(message) {
            await Promise.all(Array.from(messageListeners).map(listener => listener(message)));
        },
    };
    return panel;
}

function createViewer(options = {}) {
    const panel = options.panel || fakePanel();
    const watchDisposals = [];
    const restoredTargets = [];
    const openedUris = [];
    const viewer = new ConversationViewer({
        createPanel: (..._args) => {
            panel.createCount += 1;
            panel.createArguments = _args;
            return panel;
        },
        readOutline: options.readOutline || (async (_provider, sessionId) =>
            outline(sessionId, ['input-1'])),
        readPage: options.readPage || (async request =>
            page(request.sessionId, request.anchorInteractionId)),
        watch: options.watch || ((_provider, sessionId) => ({
            dispose() {
                watchDisposals.push(sessionId);
            },
        })),
        restoreFocus: restoreTarget => {
            restoredTargets.push(restoreTarget);
        },
        openExternal: async uri => {
            openedUris.push(uri.toString());
            return true;
        },
        mediaUri: fileName => fakeUri(`file:///extension/media/${fileName}`),
    });
    return { viewer, panel, watchDisposals, restoredTargets, openedUris };
}

test('CONVERSATION-VIEWER-OWNERSHIP-001 reuses one panel, rejects an old session generation, and clears sensitive state on disposal', async () => {
    const panel = fakePanel();
    const pages = new Map([
        ['session-a', deferred()],
        ['session-b', deferred()],
    ]);
    const { viewer, watchDisposals, restoredTargets } = createViewer({
        panel,
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            [sessionId === 'session-a' ? 'input-a' : 'input-b']
        ),
        readPage: request => pages.get(request.sessionId).promise,
    });

    const openA = viewer.open(target('session-a', 'input-a'));
    await new Promise(resolve => setImmediate(resolve));
    const openB = viewer.open(target('session-b', 'input-b'));
    pages.get('session-b').resolve(page('session-b', 'input-b', 'visible-b'));
    await openB;
    pages.get('session-a').resolve(page('session-a', 'input-a', 'visible-a'));
    await openA;

    assert.equal(panel.webview.html.includes('visible-b'), true);
    assert.equal(panel.webview.html.includes('visible-a'), false);
    assert.equal(panel.createCount, 1);
    assert.deepEqual(watchDisposals, ['session-a']);
    assert.equal(viewer.snapshotSize, 1);

    panel.dispose();
    assert.deepEqual(restoredTargets, [target('session-b', 'input-b')]);
    assert.deepEqual(watchDisposals, ['session-a', 'session-b']);
    assert.equal(viewer.snapshotSize, 0);
});

test('CONVERSATION-VIEWER-OWNERSHIP-002 lets navigation request 5 win when request 4 resolves late', async () => {
    const fourth = deferred();
    const fifth = deferred();
    let requestCount = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2', 'input-3', 'input-4', 'input-5']
        ),
        readPage: request => {
            requestCount += 1;
            if (requestCount === 4) return fourth.promise;
            if (requestCount === 5) return fifth.promise;
            return Promise.resolve(page(
                request.sessionId,
                `input-${requestCount}`,
                `visible-${requestCount}`,
                { nextCursor: `cursor-${requestCount}` }
            ));
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    const requestFour = panel.receive({
        type: 'conversation-viewer-next',
        version: 1,
    });
    const requestFive = panel.receive({
        type: 'conversation-viewer-latest',
        version: 1,
    });

    fifth.resolve(page(
        'session-a',
        'input-5',
        'visible-5'
    ));
    await requestFive;
    fourth.resolve(page(
        'session-a',
        'input-4',
        'visible-4',
        { nextCursor: 'cursor-4' }
    ));
    await requestFour;

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('visible-5'), true);
    assert.equal(publication.html.includes('visible-4'), false);
});

test('CONVERSATION-VIEWER-NAVIGATION-001 follows Latest through bounded pages and selects the final interaction', async () => {
    const requests = [];
    const responses = [
        page('session-a', 'input-1', 'visible-1', {
            nextCursor: 'cursor-1',
        }),
        page('session-a', 'input-3', 'visible-3', {
            previousCursor: 'back-3',
        }),
    ];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2', 'input-3']
        ),
        readPage: request => {
            requests.push(request);
            return Promise.resolve(responses.shift());
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-latest', version: 1 });

    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
        cursor: request.cursor,
    })), [
        { anchorInteractionId: 'input-1', direction: 'around', cursor: undefined },
        { anchorInteractionId: 'input-3', direction: 'around', cursor: undefined },
    ]);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.html.includes('visible-3'), true);
});

test('CONVERSATION-VIEWER-NAVIGATION-002 moves within a loaded page without reading and publishes authoritative position metadata', async () => {
    let reads = 0;
    const interactionIds = Array.from(
        { length: 12 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds,
            { totalInteractions: 2_001, partial: true }
        ),
        readPage: request => {
            reads += 1;
            return Promise.resolve(page(
                request.sessionId,
                'input-4',
                'visible-input',
                {
                    count: 12,
                    interactionIds,
                    anchorInteractionId: 'input-4',
                }
            ));
        },
    });

    await viewer.open(target('session-a', 'input-4'));
    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');

    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-4');
    assert.equal(publication.selectedInput, 4);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);

    await panel.receive({ type: 'conversation-viewer-latest', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-12');
    assert.equal(reads, 1);
});

test('CONVERSATION-VIEWER-BOUNDS-001 evicts above 100 interactions while retaining the selected anchor and a reload cursor', async () => {
    let readIndex = 0;
    const interactionIds = Array.from(
        { length: 6 },
        (_page, pageIndex) => retainedPageInteractionIds(pageIndex, 20, 'page')
    ).flat();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            const current = readIndex;
            readIndex += 1;
            return Promise.resolve(page(
                request.sessionId,
                current === 0 ? 'selected-anchor' : `page-${current}`,
                `visible-page-${current}`,
                {
                    count: 20,
                    interactionOffset: current * 20,
                    previousCursor: current > 0
                        ? `back-cursor-${current}`
                        : undefined,
                    nextCursor: current < 5 ? `cursor-${current}` : undefined,
                }
            ));
        },
    });

    await viewer.open(target('session-a', 'selected-anchor'));
    for (let index = 0; index < 119; index++) {
        await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    }

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(viewer.snapshotSize, 100);
    assert.equal(publication.html.includes('selected-anchor'), false);
    assert.equal(publication.html.includes('visible-page-5'), true);
    assert.equal(publication.selectedInteractionId, 'page-5-119');
    assert.equal(publication.previousCursor, 'back-cursor-1');
    assert.ok(Buffer.byteLength(publication.html, 'utf8') <= 4 * 1024 * 1024);
});

test('CONVERSATION-VIEWER-BOUNDS-002 evicts above 4 MiB using individually valid page envelopes', async () => {
    let readIndex = 0;
    const padding = 'x'.repeat(47_000);
    const interactionIds = Array.from(
        { length: 10 },
        (_page, pageIndex) => retainedPageInteractionIds(
            pageIndex,
            10,
            'byte-page'
        )
    ).flat();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            const current = readIndex;
            readIndex += 1;
            const result = page(
                request.sessionId,
                current === 0 ? 'selected-anchor' : `byte-page-${current}`,
                `visible-byte-page-${current}`,
                {
                    count: 10,
                    interactionOffset: current * 10,
                    previousCursor: current > 0
                        ? `byte-back-cursor-${current}`
                        : undefined,
                    padding,
                    nextCursor: current < 9
                        ? `byte-cursor-${current}`
                        : undefined,
                }
            );
            assert.ok(
                Buffer.byteLength(JSON.stringify(result), 'utf8') <= 512 * 1024,
                'fixture pages must respect the coordinator page bound'
            );
            return Promise.resolve(result);
        },
    });

    await viewer.open(target('session-a', 'selected-anchor'));
    for (let index = 0; index < 99; index++) {
        await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    }

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('selected-anchor'), false);
    assert.equal(publication.html.includes('visible-byte-page-9'), true);
    assert.equal(publication.selectedInteractionId, 'byte-page-9-99');
    assert.equal(publication.previousCursor, 'byte-back-cursor-2');
    assert.equal(publication.nextCursor, undefined);
    assert.ok(viewer.snapshotSize < 100);
    assert.ok(Buffer.byteLength(publication.html, 'utf8') <= 4 * 1024 * 1024);
});

test('CONVERSATION-VIEWER-SECURITY-001 emits a nonce-only CSP and opens only HTTPS links', async () => {
    const { viewer, panel, openedUris } = createViewer();
    await viewer.open(target('session-a'));

    assert.match(panel.webview.html, /default-src 'none';/);
    assert.match(panel.webview.html, /style-src fixture-csp;/);
    assert.match(panel.webview.html, /script-src 'nonce-[^']+';/);
    assert.equal(panel.webview.html.includes("'unsafe-inline'"), false);
    assert.match(panel.webview.html, /data-auto-scroll-threshold="8"/);
    assert.equal(
        panel.createArguments[3].localResourceRoots[0].toString(),
        'file:///extension/media/'
    );
    assert.match(
        panel.webview.html,
        /src="webview:\/\/fixture\/\/extension\/media\/purify\.min\.js"/
    );
    assert.match(
        panel.webview.html,
        /href="webview:\/\/fixture\/\/extension\/media\/conversationViewer\.css"/
    );

    for (const href of [
        'javascript:alert(1)',
        'data:text/html,unsafe',
        'file:///tmp/private',
        'command:workbench.action.reloadWindow',
        'http://example.test/insecure',
        'https://example.test/safe',
    ]) {
        await panel.receive({
            type: 'conversation-viewer-open-link',
            version: 1,
            href,
        });
    }

    assert.deepEqual(openedUris, ['https://example.test/safe']);
});

test('CONVERSATION-VIEWER-REFRESH-001 retains stale content after a watched failure and clears stale after recovery', async () => {
    let onChange;
    let readCount = 0;
    let outlineCount = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineCount += 1;
            return outline(
                sessionId,
                outlineCount < 3 ? ['input-1'] : ['input-1', 'input-2'],
                outlineCount < 3
                    ? {}
                    : { totalInteractions: 2_001, partial: true }
            );
        },
        readPage: request => {
            readCount += 1;
            if (readCount === 2) {
                return Promise.reject(new Error('private source failure'));
            }
            return Promise.resolve(page(
                request.sessionId,
                request.anchorInteractionId,
                readCount === 1 ? 'visible-initial' : 'visible-recovered'
            ));
        },
    });

    await viewer.open(target('session-a'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(publication.updateKind, 'refresh');
    assert.equal(publication.html.includes('visible-initial'), true);
    assert.equal(publication.html.includes('private source failure'), false);

    await viewer.refresh();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-recovered'), true);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
});

test('CONVERSATION-VIEWER-AUTHORITY-001 fails closed when an initial marker no longer exists', async () => {
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-2'],
            { sourceRevision: 'r2' }
        ),
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'wrong-interaction',
                { sourceRevision: 'r2' }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(pageReads, 0);
    assert.equal(viewer.snapshotSize, 0);
    assert.equal(panel.webview.html.includes('Conversation history unavailable.'), true);
    assert.equal(panel.webview.html.includes('wrong-interaction'), false);
});

test('CONVERSATION-VIEWER-REFRESH-002 follows a new authoritative last input only when selection was latest', async () => {
    let onChange;
    let outlineRead = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineRead += 1;
            return outline(
                sessionId,
                outlineRead === 1 ? ['input-1'] : ['input-1', 'input-2'],
                { sourceRevision: outlineRead === 1 ? 'r1' : 'r2' }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            { sourceRevision: request.expectedRevision }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.selectedInput, 2);
    assert.equal(publication.totalInputs, 2);
    assert.equal(publication.atLatest, true);
});
