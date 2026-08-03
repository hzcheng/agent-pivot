'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
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

const fakeVscode = {
    ViewColumn: { Active: 1, Beside: 2 },
    Uri: { parse: value => fakeUri(value) },
};

function loadConversationViewer() {
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
const {
    ConversationError,
} = require('../../../out/aiSessions/conversation/types');
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

function decodeInitialPublication(html) {
    const match = html.match(/data-initial-page="([^"]+)"/);
    assert.ok(match, 'Host document must contain an initial publication');
    return JSON.parse(match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'));
}

function decodeInitialBookmarks(html) {
    const match = html.match(/data-initial-bookmarks="([^"]+)"/);
    assert.ok(match, 'Host document must contain bookmark state');
    return JSON.parse(match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'));
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

function fakePanel(options = {}) {
    const disposeListeners = new Set();
    const messageListeners = new Set();
    const viewStateListeners = new Set();
    let disposed = false;
    const panel = {
        createCount: 0,
        revealCount: 0,
        revealColumns: [],
        postedMessages: [],
        createArguments: undefined,
        visible: true,
        get viewStateListenerCount() {
            return viewStateListeners.size;
        },
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
                const delivered = typeof options.postMessageResult === 'function'
                    ? options.postMessageResult(message, panel)
                    : options.postMessageResult ?? true;
                return Promise.resolve(delivered);
            },
            asWebviewUri(uri) {
                return fakeUri(uri.toString().replace(
                    'file://',
                    'webview://fixture/'
                ));
            },
        },
        reveal(column) {
            panel.revealCount += 1;
            panel.revealColumns.push(column);
        },
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
        async setVisible(visible) {
            panel.visible = visible;
            await Promise.all(Array.from(viewStateListeners).map(listener =>
                listener({ webviewPanel: panel })
            ));
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
        readSubagents: options.readSubagents,
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
        bookmarkStore: options.bookmarkStore,
    });
    return { viewer, panel, watchDisposals, restoredTargets, openedUris };
}

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 opens and reuses one viewer in the active editor group', async () => {
    const { viewer, panel } = createViewer();

    await viewer.open(target('session-a', 'input-1'));
    await viewer.open(target('session-b', 'input-1'));

    assert.equal(panel.createCount, 1);
    assert.equal(panel.createArguments[2], fakeVscode.ViewColumn.Active);
    assert.deepEqual(panel.revealColumns, [
        fakeVscode.ViewColumn.Active,
        fakeVscode.ViewColumn.Active,
    ]);
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 follows another Session only when the viewer is open and does not reveal it again', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            [sessionId === 'session-a' ? 'input-a' : 'input-b']
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });

    assert.equal(viewer.isOpen(), false);
    assert.equal(await viewer.follow(target('session-b', 'input-b')), false);
    assert.equal(panel.createCount, 0);

    await viewer.open(target('session-a', 'input-a'));
    assert.equal(viewer.isOpen(), true);
    assert.equal(await viewer.follow(target('session-b', 'input-b')), true);
    assert.equal(panel.webview.html.includes('visible-session-b'), true);
    assert.equal(panel.webview.html.includes('visible-session-a'), false);
    assert.deepEqual(panel.revealColumns, [fakeVscode.ViewColumn.Active]);
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 opens a subagent transcript in place and returns to the conversation', async () => {
    const subagentEntries = [
        {
            id: 'a11111111',
            label: 'Explore the parser',
            agentType: 'explore',
            status: 'running',
            createdAt: 1,
            updatedAt: 2,
        },
    ];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => sessionId.includes('#agent:')
            ? outline(sessionId, ['sub-input-1'])
            : outline(sessionId, ['input-a', 'input-b']),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            request.sessionId.includes('#agent:')
                ? 'subagent-visible'
                : 'main-visible'
        ),
        readSubagents: async () => subagentEntries,
    });

    await viewer.open(target('session-a', 'input-a'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.deepEqual(
        initial.subagents.map(entry => [entry.id, entry.status]),
        [['a11111111', 'running']]
    );
    assert.equal(initial.activeSubagent, null);

    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: 'a11111111',
    });
    // The switch applies in place: no document rebuild, and the publication
    // keeps the subscription generation baked into the current document.
    const initialGeneration = Number(panel.webview.html.match(
        /data-subscription-generation="(\d+)"/
    )[1]);
    assert.equal(panel.webview.html.includes('subagent-visible'), false);
    let publication = panel.postedMessages.at(-1);
    assert.equal(publication.activeSubagent.id, 'a11111111');
    assert.equal(publication.activeSubagent.label, 'Explore the parser');
    assert.ok(publication.html.includes('subagent-visible'));
    assert.equal(
        publication.subscriptionGeneration,
        initialGeneration,
        'an in-place switch must keep the document-baked generation'
    );
    assert.deepEqual(
        publication.outline.map(entry => entry.interactionId),
        ['sub-input-1']
    );
    assert.deepEqual(
        publication.subagents.map(entry => entry.id),
        ['a11111111']
    );

    // Unknown or malformed subagent targets are ignored without a new page.
    const settledCount = panel.postedMessages.length;
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: 'a99999999',
    });
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: '..',
    });
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
    });
    assert.equal(panel.postedMessages.length, settledCount);

    // A dashboard follow for the same session preserves the subagent view.
    const beforeFollow = panel.postedMessages.length;
    assert.equal(await viewer.follow(target('session-a', 'input-b')), true);
    assert.equal(panel.postedMessages.length, beforeFollow);
    assert.equal(panel.postedMessages.at(-1).activeSubagent.id, 'a11111111');

    await panel.receive({
        type: 'conversation-viewer-close-subagent',
        version: 1,
    });
    publication = panel.postedMessages.at(-1);
    assert.equal(publication.activeSubagent, null);
    assert.ok(publication.html.includes('main-visible'));
    assert.equal(publication.subscriptionGeneration, initialGeneration);
    assert.deepEqual(
        publication.outline.map(entry => entry.interactionId),
        ['input-a', 'input-b']
    );
});

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
            interactionIds
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
    assert.equal(publication.totalInputs, 12);
    assert.equal(publication.partial, false);

    await panel.receive({ type: 'conversation-viewer-latest', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-12');
    assert.equal(reads, 1);
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 CONVERSATION-OUTLINE-CONTROLLER-001 publishes the current Session outline and loads an exact selected input', async () => {
    const requests = [];
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            requests.push(request);
            return Promise.resolve(page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${request.anchorInteractionId}`
            ));
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.deepEqual(initial.outline, interactionIds.map(interactionId => ({
        interactionId,
        userPreview: interactionId,
        responseState: 'complete',
    })));

    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-3',
    });
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.html.includes('visible-input-3'), true);
    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
    })), [{
        anchorInteractionId: 'input-1',
        direction: 'around',
    }, {
        anchorInteractionId: 'input-3',
        direction: 'around',
    }]);

    const publicationsBeforeInvalid = panel.postedMessages.length;
    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-2',
        extra: 'rejected',
    });
    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'missing-input',
    });
    assert.equal(panel.postedMessages.length, publicationsBeforeInvalid);
    assert.equal(requests.length, 2);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 restores and Host-settles bookmarks without changing outline order', async () => {
    const saved = [];
    const bookmarkStore = {
        async load() {
            return { revision: 4, interactionIds: ['input-3'] };
        },
        async save(storeTarget, snapshot) {
            saved.push({
                target: { ...storeTarget },
                snapshot: {
                    revision: snapshot.revision,
                    interactionIds: [...snapshot.interactionIds],
                },
            });
        },
    };
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { viewer, panel } = createViewer({
        bookmarkStore,
        readOutline: async (_provider, sessionId) =>
            outline(sessionId, interactionIds),
    });

    await viewer.open(target('session-a', 'input-2'));
    assert.deepEqual(decodeInitialBookmarks(panel.webview.html), {
        revision: 4,
        interactionIds: ['input-3'],
    });
    const before = decodeInitialPublication(panel.webview.html)
        .outline.map(entry => entry.interactionId);

    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-1',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 4,
        payload: {
            interactionId: 'input-1',
            bookmarked: true,
        },
    });

    assert.deepEqual(saved, [{
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
        },
        snapshot: {
            revision: 5,
            interactionIds: ['input-3', 'input-1'],
        },
    }]);
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-bookmarks-result',
        version: 1,
        requestId: 'bookmark-1',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        success: true,
        revision: 5,
        interactionIds: ['input-3', 'input-1'],
    });
    assert.deepEqual(
        decodeInitialPublication(panel.webview.html)
            .outline.map(entry => entry.interactionId),
        before
    );
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 rejects stale or unknown input bookmark intents without persisting', async () => {
    let saves = 0;
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 2, interactionIds: [] };
            },
            async save() {
                saves += 1;
            },
        },
        readOutline: async (_provider, sessionId) =>
            outline(sessionId, ['input-1', 'input-2']),
    });
    await viewer.open(target('session-a'));

    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-stale',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 1,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-unknown',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 2,
        payload: { interactionId: 'missing', bookmarked: true },
    });

    assert.equal(saves, 0);
    assert.deepEqual(
        panel.postedMessages.slice(-2).map(message => message.error),
        ['stale', 'stale']
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 evicts above 100 interactions while retaining the selected anchor and a reload cursor', async () => {
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
    assert.match(panel.webview.html, /img-src https: blob:;/);
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
        /data-mermaid-src="webview:\/\/fixture\/\/extension\/media\/mermaid\.min\.js"/
    );
    assert.match(
        panel.webview.html,
        /href="webview:\/\/fixture\/\/extension\/media\/conversationViewer\.css"/
    );
    const purifyIndex = panel.webview.html.indexOf('purify.min.js');
    const readingAnchorIndex = panel.webview.html.indexOf(
        'conversationReadingAnchorScripts.js'
    );
    const mermaidControllerIndex = panel.webview.html.indexOf(
        'conversationMermaidScripts.js'
    );
    const outlineControllerIndex = panel.webview.html.indexOf(
        'conversationOutlineScripts.js'
    );
    const telemetryControllerIndex = panel.webview.html.indexOf(
        'conversationTelemetryScripts.js'
    );
    const commentsControllerIndex = panel.webview.html.indexOf(
        'conversationCommentsScripts.js'
    );
    const sidebarControllerIndex = panel.webview.html.indexOf(
        'conversationSidebarScripts.js'
    );
    const reconcileControllerIndex = panel.webview.html.indexOf(
        'conversationReconcileScripts.js'
    );
    const viewerIndex = panel.webview.html.indexOf(
        'conversationViewerScripts.js'
    );
    assert.ok(purifyIndex >= 0 && purifyIndex < readingAnchorIndex);
    assert.ok(readingAnchorIndex < mermaidControllerIndex);
    assert.ok(mermaidControllerIndex < outlineControllerIndex);
    assert.ok(outlineControllerIndex < telemetryControllerIndex);
    assert.ok(telemetryControllerIndex < commentsControllerIndex);
    assert.ok(commentsControllerIndex < sidebarControllerIndex);
    assert.ok(sidebarControllerIndex < reconcileControllerIndex);
    assert.ok(reconcileControllerIndex < viewerIndex);

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

test('CONVERSATION-READING-FOCUS-001 keeps modular Webview controllers byte-identical in packaged media', () => {
    for (const fileName of [
        'conversationReadingAnchorScripts.js',
        'conversationMermaidScripts.js',
        'conversationOutlineScripts.js',
        'conversationTelemetryScripts.js',
        'conversationCommentsScripts.js',
        'conversationSidebarScripts.js',
        'conversationReconcileScripts.js',
        'conversationViewerScripts.js',
    ]) {
        assert.equal(
            fs.readFileSync(path.join('media', fileName), 'utf8'),
            fs.readFileSync(path.join('src', 'webview', fileName), 'utf8'),
            `${fileName} is stale in media`
        );
    }
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
                {
                    sourceRevision: outlineCount === 1 ? 'r1' : 'r2',
                    ...(outlineCount < 3
                        ? {}
                        : { totalInteractions: 2_001, partial: true }),
                }
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
                readCount === 1 ? 'visible-initial' : 'visible-recovered',
                { sourceRevision: request.expectedRevision }
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

test('CONVERSATION-THINKING-VISIBILITY-001 preserves thinking content across an authoritative refresh', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => ({
            ...page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-response',
                { sourceRevision: request.expectedRevision }
            ),
            messages: [{
                id: 'input-1:thinking:0',
                interactionId: 'input-1',
                role: 'thinking',
                markdown: '',
                thinking: { text: `thinking revision ${revision}` },
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        decodeInitialPublication(panel.webview.html).html
            .includes('thinking revision 1'),
        true
    );

    revision = 2;
    await viewer.refresh();
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('thinking revision 2'), true);
});

test('CONVERSATION-READING-FOCUS-001 ignores watched refreshes when the authoritative source revision is unchanged', async () => {
    let onChange;
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1'], { sourceRevision: 'stable-r1' });
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').length, 0);
    assert.equal(panel.webview.html.includes('visible-1'), true);
});

test('CONVERSATION-VIEWER-LOADING-001 coalesces watched invalidations without starving the initial publication', async t => {
    let onChange;
    let outlineReads = 0;
    let initialSignal;
    const initialOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId, signal) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                initialSignal = signal;
                return initialOutline.promise;
            }
            return outline(sessionId, ['input-1'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.expectedRevision}`,
            { sourceRevision: request.expectedRevision }
        ),
    });
    t.after(() => viewer.dispose());

    const opening = viewer.open(target('session-a', 'input-1'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 1);

    onChange();
    onChange();
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    const initialWasAborted = initialSignal.aborted;
    const readsBeforeInitialSettled = outlineReads;

    initialOutline.resolve(outline('session-a', ['input-1'], {
        sourceRevision: 'r1',
    }));
    await opening;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(initialWasAborted, false);
    assert.equal(readsBeforeInitialSettled, 1);
    assert.equal(outlineReads, 2);
    const publications = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page');
    assert.equal(panel.webview.html.includes('visible-r1'), true);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].updateKind, 'refresh');
    assert.equal(publications[0].html.includes('visible-r2'), true);
    assert.equal(panel.webview.html.includes('Loading conversation…'), false);
});

test('CONVERSATION-VIEWER-AUTHORITY-003 suspends exact authority without clearing the snapshot and resumes with a fresh watch/read', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    let watchCreates = 0;
    const watchDisposals = [];
    const pendingOutline = deferred();
    let pendingSignal;
    const { viewer, panel } = createViewer({
        watch: (_provider, sessionId) => {
            watchCreates += 1;
            let active = true;
            return {
                dispose() {
                    if (!active) return;
                    active = false;
                    watchDisposals.push(sessionId);
                },
            };
        },
        readOutline: async (_provider, sessionId, signal) => {
            outlineReads += 1;
            if (outlineReads === 2) {
                pendingSignal = signal;
                return pendingOutline.promise;
            }
            return outline(sessionId, ['input-1', 'input-2']);
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                {
                    sourceRevision: request.expectedRevision,
                    nextCursor: request.anchorInteractionId === 'input-1'
                        ? 'next-input'
                        : undefined,
                }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    const inFlightRefresh = viewer.refresh();
    await new Promise(resolve => setImmediate(resolve));
    let authorityCalls = 0;
    await viewer.reconcileAuthority(candidate => {
        authorityCalls += 1;
        assert.deepEqual(candidate, target('session-a', 'input-1'));
        return false;
    });

    assert.equal(authorityCalls, 1);
    assert.equal(pendingSignal.aborted, true);
    assert.equal(watchCreates, 1);
    assert.deepEqual(watchDisposals, ['session-a']);
    assert.equal(viewer.snapshotSize, 1);
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(publication.html.includes('visible-1'), true);

    const readsWhileSuspended = pageReads;
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    assert.equal(pageReads, readsWhileSuspended);
    pendingOutline.resolve(outline('session-a', ['input-1', 'input-2']));
    await inFlightRefresh;

    await viewer.reconcileAuthority(() => true);
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(watchCreates, 2);
    assert.equal(outlineReads, 3);
    assert.equal(pageReads, readsWhileSuspended + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);
});

test('CONVERSATION-VIEWER-AUTHORITY-005 keeps a failed watch rebuild suspended and retries it on later authority', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    let watchCreates = 0;
    let liveInvalidation;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCreates += 1;
            if (watchCreates === 2) {
                throw new Error([
                    '/private/watch/rebuild',
                    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    'private prompt',
                ].join(' '));
            }
            liveInvalidation = onChange;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1', 'input-2']);
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                {
                    sourceRevision: request.expectedRevision,
                    nextCursor: 'next-input',
                }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.reconcileAuthority(() => false);
    const stalePublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(stalePublication.stale, true);
    const readsBeforeFailedResume = {
        outline: outlineReads,
        page: pageReads,
    };

    await assert.doesNotReject(
        viewer.reconcileAuthority(() => true)
    );
    assert.equal(watchCreates, 2);
    assert.deepEqual({
        outline: outlineReads,
        page: pageReads,
    }, readsBeforeFailedResume);
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    assert.equal(pageReads, readsBeforeFailedResume.page);
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1).stale,
        true
    );

    await viewer.reconcileAuthority(() => true);
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(watchCreates, 3);
    assert.equal(outlineReads, readsBeforeFailedResume.outline + 1);
    assert.equal(pageReads, readsBeforeFailedResume.page + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);

    liveInvalidation();
    await new Promise(resolve => setImmediate(resolve));
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(outlineReads, readsBeforeFailedResume.outline + 2);
    assert.equal(pageReads, readsBeforeFailedResume.page + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);
});

test('CONVERSATION-VIEWER-AUTHORITY-004 reconciliation after panel close is an idempotent no-op', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-a'));
    panel.dispose();
    let authorityCalls = 0;

    await viewer.reconcileAuthority(() => {
        authorityCalls += 1;
        return true;
    });
    await viewer.reconcileAuthority(() => {
        authorityCalls += 1;
        return false;
    });

    assert.equal(authorityCalls, 0);
    assert.equal(viewer.snapshotSize, 0);
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

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 preserves the selected interaction when a refresh adds a new last input', async () => {
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
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.selectedInput, 1);
    assert.equal(publication.totalInputs, 2);
    assert.equal(publication.atLatest, false);
});

test('CONVERSATION-VIEWER-DELIVERY-001 rebuilds the latest hidden publication when the panel becomes visible and disposes its listener', async () => {
    let onChange;
    let revision = 1;
    const panel = fakePanel({
        postMessageResult: (_message, currentPanel) => currentPanel.visible,
    });
    const { viewer } = createViewer({
        panel,
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? ['input-1'] : ['input-1', 'input-2'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-r${revision}`,
            { sourceRevision: request.expectedRevision }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(panel.viewStateListenerCount, 1);
    await panel.setVisible(false);
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.webview.html.includes('visible-r2'), true);
    panel.webview.html = 'simulated destroyed hidden document';
    await panel.setVisible(true);

    assert.equal(panel.webview.html.includes('visible-r2'), true);
    assert.equal(panel.webview.html.includes('&quot;selectedInput&quot;:1'), true);
    assert.equal(panel.webview.html.includes('&quot;subscriptionGeneration&quot;:1'), true);

    panel.dispose();
    assert.equal(panel.viewStateListenerCount, 0);
});

test('CONVERSATION-VIEWER-STALE-001 retries an initial stale revision once against a fresh outline', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 1) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-current',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 2);
    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
        expectedRevision: request.expectedRevision,
        cursor: request.cursor,
    })), [
        {
            anchorInteractionId: 'input-1',
            direction: 'around',
            expectedRevision: 'r1',
            cursor: undefined,
        },
        {
            anchorInteractionId: 'input-1',
            direction: 'around',
            expectedRevision: 'r2',
            cursor: undefined,
        },
    ]);
    assert.equal(panel.webview.html.includes('visible-current'), true);
});

test('CONVERSATION-VIEWER-STALE-004 fails an initial stale retry closed when the exact interaction disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                [outlineReads === 1 ? 'input-1' : 'input-2'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 1) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'must-not-publish-input-2',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    assert.equal(viewer.snapshotSize, 0);
    assert.equal(
        panel.webview.html.includes('Conversation history unavailable.'),
        true
    );
    assert.equal(panel.webview.html.includes('must-not-publish-input-2'), false);
});

test('CONVERSATION-VIEWER-STALE-002 recovers expired navigation cursors through one fresh authoritative around read', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                outlineReads === 1
                    ? ['input-1', 'input-2']
                    : ['input-1', 'input-2', 'input-3'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 1) {
                return page('session-a', 'input-1', 'visible-initial', {
                    nextCursor: 'expired-cursor',
                });
            }
            if (pageReads === 2) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-retried',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 3);
    assert.deepEqual({
        anchorInteractionId: requests[2].anchorInteractionId,
        direction: requests[2].direction,
        expectedRevision: requests[2].expectedRevision,
        cursor: requests[2].cursor,
    }, {
        anchorInteractionId: 'input-2',
        direction: 'around',
        expectedRevision: 'r2',
        cursor: undefined,
    });
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.html.includes('visible-retried'), true);
});

test('CONVERSATION-VIEWER-STALE-003 bounds persistent stale revision recovery to one retry and retains stale content', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1', 'input-2'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 1) {
                return page('session-a', 'input-1', 'visible-retained', {
                    nextCursor: 'expired-cursor',
                });
            }
            throw new ConversationError('staleRevision');
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(publication.html.includes('visible-retained'), true);
});

test('CONVERSATION-VIEWER-AUTHORITY-002 retains stale content when the established exact selection disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                [outlineReads === 1 ? 'input-1' : 'input-2'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                pageReads === 1
                    ? 'visible-established'
                    : 'must-not-replace-established',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.refresh();

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.stale, true);
    assert.equal(publication.html.includes('visible-established'), true);
    assert.equal(
        publication.html.includes('must-not-replace-established'),
        false
    );
});

test('CONVERSATION-VIEWER-REFRESH-003 CONVERSATION-READING-FOCUS-001 merges a new tail page without advancing the selected interaction', async () => {
    let onChange;
    let revision = 1;
    const firstIds = Array.from(
        { length: 20 },
        (_item, index) => `input-${index + 1}`
    );
    const secondIds = Array.from(
        { length: 20 },
        (_item, index) => `input-${index + 2}`
    );
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? firstIds : firstIds.concat('input-21'),
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            revision === 1 ? 'initial' : 'refreshed',
            {
                interactionIds: revision === 1 ? firstIds : secondIds,
                anchorInteractionId: request.anchorInteractionId,
                sourceRevision: request.expectedRevision,
                previousCursor: revision === 1 ? undefined : 'r2-before',
            }
        ),
    });

    await viewer.open(target('session-a', 'input-20'));
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-20');
    assert.equal(publication.html.includes('data-interaction-id="input-1"'), true);
    assert.equal(publication.html.includes('data-interaction-id="input-21"'), true);
    assert.equal(
        publication.html.match(/data-interaction-id="input-2"/g).length,
        1
    );
    assert.equal(viewer.snapshotSize, 21);
});

test('CONVERSATION-VIEWER-PARTIAL-001 offsets capped-tail positions by omitted authoritative interactions', async () => {
    const interactionIds = Array.from(
        { length: 2_000 },
        (_item, index) => `input-${index + 2}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds,
            { totalInteractions: 2_001, partial: true }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            'visible-tail',
            {
                interactionIds: ['input-2000', 'input-2001'],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
    });

    await viewer.open(target('session-a', 'input-2001'));
    const initialPublicationMatch =
        panel.webview.html.match(/data-initial-page="([^"]+)"/);
    assert.ok(initialPublicationMatch, panel.webview.html);
    let publication = JSON.parse(
        initialPublicationMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&')
    );
    assert.equal(publication.selectedInput, 2_001);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);

    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2000');
    assert.equal(publication.selectedInput, 2_000);

    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2001');
    assert.equal(publication.selectedInput, 2_001);
    assert.equal(publication.totalInputs, 2_000);
});

test('CONVERSATION-VIEWER-PARTIAL-001 derives first and latest capped positions from a real Kimi adapter', async t => {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-real-kimi-viewer-cap-')
    );
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const records = [];
    for (let number = 1; number <= 2_001; number += 1) {
        records.push(JSON.stringify({
            timestamp: number,
            message: {
                type: 'TurnBegin',
                payload: { user_input: `Viewer cap input ${number}` },
            },
        }));
        records.push(JSON.stringify({
            timestamp: number,
            message: { type: 'TurnEnd', payload: {} },
        }));
    }
    await fs.promises.writeFile(sourcePath, `${records.join('\n')}\n`);
    t.after(() => fs.promises.rm(providerHome, {
        recursive: true,
        force: true,
    }));
    const adapter = new KimiConversationAdapter({
        resolveSource: () => ({ providerHome, sourcePath }),
        watchSessionChanges: () => ({ dispose() {} }),
        now: Date.now,
        setTimeout(callback) {
            callback();
            return 1;
        },
        clearTimeout() {},
    });
    t.after(() => adapter.dispose());
    const capped = await adapter.readOutline(sessionId);
    const { viewer, panel } = createViewer({
        readOutline: (_provider, id, signal) =>
            adapter.readOutline(id, signal),
        readPage: (request, signal) =>
            adapter.readPage(request, signal),
        watch: (_provider, id, callback) =>
            adapter.watch(id, callback),
    });

    await viewer.open(target(
        sessionId,
        capped.interactions[0].id,
        {
            provider: 'kimi',
            expectedRevision: capped.sourceRevision,
        }
    ));
    const realInitialPublicationMatch =
        panel.webview.html.match(/data-initial-page="([^"]+)"/);
    assert.ok(
        realInitialPublicationMatch,
        panel.webview.html
    );
    let publication = JSON.parse(
        realInitialPublicationMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&')
    );
    assert.equal(publication.selectedInput, 2);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
    assert.equal(publication.html.includes('Viewer cap input 2'), true);

    await panel.receive({
        type: 'conversation-viewer-latest',
        version: 1,
    });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInput, 2_001);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
    assert.equal(
        publication.html.includes('Viewer cap input 2001'),
        true
    );
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 publishes collapsible tool-call markup', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => ({
            ...page(request.sessionId, 'input-1', 'visible'),
            messages: [
                {
                    id: 'input-1:user',
                    interactionId: 'input-1',
                    role: 'user',
                    markdown: 'Run the tests',
                },
                {
                    id: 'input-1:tool:0',
                    interactionId: 'input-1',
                    role: 'tool',
                    markdown: '',
                    tool: {
                        name: 'Shell',
                        summary: 'Shell npm test',
                        detail: '9 passing',
                    },
                },
                {
                    id: 'input-1:assistant:0',
                    interactionId: 'input-1',
                    role: 'assistant',
                    markdown: 'All pass.',
                },
            ],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-tool-call'), true);
    assert.equal(html.includes('Shell npm test'), true);
    assert.equal(html.includes('9 passing'), true);
    assert.equal(html.includes('conversation-message-tool'), true);
});
