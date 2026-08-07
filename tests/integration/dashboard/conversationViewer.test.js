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
    formatConversationClockTime,
} = require('../../../out/aiSessions/conversation/text');
const {
    KimiConversationAdapter,
} = require('../../../out/aiSessions/conversation/kimiAdapter');
const {
    CodexConversationAdapter,
} = require('../../../out/aiSessions/conversation/codexAdapter');

const timedCodexFixture = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '../../fixtures/conversations/codex/thread-read-timed.json'
), 'utf8'));

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
            responseState: options.responseStates?.[id] || 'complete',
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
            responseState: options.responseStates?.[id] || 'complete',
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
        revealPreserveFocus: [],
        postedMessages: [],
        createArguments: undefined,
        visible: true,
        active: options.active !== false,
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
        reveal(column, preserveFocus) {
            panel.revealCount += 1;
            panel.revealColumns.push(column);
            panel.revealPreserveFocus.push(preserveFocus);
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
        async setActive(active) {
            panel.active = active;
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
        readSnapshot: options.readSnapshot,
        readPage: options.readPage || (async request =>
            page(request.sessionId, request.anchorInteractionId)),
        readSubagents: options.readSubagents,
        readTelemetry: options.readTelemetry,
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
        openLocalFile: options.openLocalFile,
        insertIntoActiveTerminal: options.insertIntoActiveTerminal,
        writeClipboardText: options.writeClipboardText,
        followAdjacentConversation: options.followAdjacentConversation,
        setKeyboardFocus: options.setKeyboardFocus,
        mediaUri: fileName => fakeUri(`file:///extension/media/${fileName}`),
        showThinking: options.showThinking,
        commentStore: options.commentStore,
        bookmarkStore: options.bookmarkStore,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
    });
    return { viewer, panel, watchDisposals, restoredTargets, openedUris };
}

test('CONVERSATION-TELEMETRY-CONTROLLER-001 refreshes telemetry while the visible conversation is otherwise idle', async () => {
    const timers = new Map();
    let nextTimer = 1;
    let telemetryReads = 0;
    const { viewer, panel } = createViewer({
        readTelemetry: async (_provider, sessionId) => ({
            provider: 'codex',
            sessionId,
            context: {
                usedTokens: ++telemetryReads * 100,
                maxTokens: 1_000,
            },
            rateLimits: [],
        }),
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, {
                callback: () => {
                    timers.delete(handle);
                    return callback();
                },
                delayMs,
            });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
    });

    await viewer.open(target('session-idle'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(telemetryReads, 1, 'initial publication reads telemetry');
    const scheduled = Array.from(timers.values()).at(-1);
    assert.ok(scheduled, 'visible conversation must schedule a telemetry refresh');
    assert.equal(scheduled.delayMs, 5_000);

    await scheduled.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(telemetryReads, 2);
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-telemetry'
        ).at(-1).telemetry.context.usedTokens,
        200
    );
    assert.equal(timers.size, 1, 'the next visible refresh is scheduled');

    await panel.setVisible(false);
    assert.equal(timers.size, 0, 'hidden conversations stop telemetry work');
    await panel.setVisible(true);
    assert.equal(timers.size, 1, 'showing the conversation resumes telemetry');

    panel.dispose();
    assert.equal(timers.size, 0, 'disposing the viewer cancels telemetry work');
});

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

test('CONVERSATION-SESSION-REBIND-001 retargets an open viewer from the exact old Session to the new Session', async () => {
    const outlineReads = [];
    const { viewer, panel, watchDisposals } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads.push(sessionId);
            return outline(
                sessionId,
                sessionId === 'old-root'
                    ? ['old-input']
                    : ['new-input-a', 'new-input-b']
            );
        },
    });
    await viewer.open(target('old-root', 'old-input'));

    assert.equal(await viewer.rebindSession(
        { projectId: 'project-a', provider: 'codex', sessionId: 'old-root' },
        { projectId: 'project-a', provider: 'codex', sessionId: 'new-root' }
    ), true);

    assert.deepEqual(outlineReads, ['old-root', 'new-root', 'new-root']);
    assert.deepEqual(watchDisposals, ['old-root']);
    assert.equal(panel.createCount, 1);
    assert.match(panel.postedMessages.at(-1).html, /new-input-b/);
    await viewer.reconcileAuthority(() => ({
        displayName: 'New root display',
        duplicateDisplayName: false,
    }));
    assert.equal(panel.postedMessages.at(-1).displayName, 'New root display');
});

test('CONVERSATION-SESSION-REBIND-001 keeps an initial rebound load current while display metadata reconciles', async () => {
    const reboundInitialStarted = deferred();
    const releaseReboundInitial = deferred();
    let newRootReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'new-root') {
                newRootReads += 1;
                if (newRootReads === 2) {
                    reboundInitialStarted.resolve();
                    await releaseReboundInitial.promise;
                }
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('old-root', 'old-root-input'));

    const rebind = viewer.rebindSession(
        { projectId: 'project-a', provider: 'codex', sessionId: 'old-root' },
        { projectId: 'project-a', provider: 'codex', sessionId: 'new-root' }
    );
    await reboundInitialStarted.promise;
    const reconcile = viewer.reconcileAuthority(() => ({
        displayName: 'Current root',
        duplicateDisplayName: false,
    }));
    releaseReboundInitial.resolve();

    assert.equal(await rebind, true);
    await reconcile;
    assert.match(panel.postedMessages.at(-1).html, /new-root-input/);
    assert.match(panel.postedMessages.at(-1).displayName, /Current root/);
});

test('CONVERSATION-SESSION-REBIND-001 bounds reconciled display metadata before publishing it', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-a'));

    await viewer.reconcileAuthority(() => ({
        displayName: '🧭'.repeat(1_000),
        duplicateDisplayName: true,
    }));

    const publication = panel.postedMessages.at(-1);
    assert.equal(publication.type, 'conversation-viewer-page');
    assert.ok(publication.displayName.length <= 640);
    assert.match(publication.displayName, / · session-/);
});

test('CONVERSATION-SESSION-REBIND-001 lets the newest live rebind win while an older outline read is pending', async () => {
    const oldRebind = deferred();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'new-root-a') {
                await oldRebind.promise;
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('old-root', 'old-root-input'));
    const previous = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    };
    const first = viewer.rebindSession(previous, {
        ...previous,
        sessionId: 'new-root-a',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await viewer.rebindSession(previous, {
        ...previous,
        sessionId: 'new-root-b',
    }), true);
    oldRebind.resolve();
    assert.equal(await first, false);
    assert.match(panel.postedMessages.at(-1).html, /new-root-b-input/);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 restores a retained panel without revealing it and resumes live updates', async () => {
    const panel = fakePanel();
    let onChange;
    let revision = 1;
    const { viewer } = createViewer({
        panel,
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `revision-${revision}`,
            { sourceRevision: `r${revision}` }
        ),
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
    });

    await viewer.restore(panel, target('session-a', 'input-1'));

    assert.equal(panel.createCount, 0, 'VS Code already owns the retained panel');
    assert.equal(panel.revealCount, 0, 'restoration must not steal editor focus');
    assert.equal(panel.webview.options.enableScripts, true);
    assert.match(panel.webview.html, /revision-1/);

    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    const refresh = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(refresh, 'the restored watcher must publish new transcript data');
    assert.match(refresh.html, /revision-2/);
    viewer.dispose();
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
    const retainedDocument = panel.webview.html;
    assert.equal(viewer.isOpen(), true);
    assert.equal(await viewer.follow(target('session-b', 'input-b')), true);
    assert.equal(
        panel.webview.html,
        retainedDocument,
        'following a Session must update the retained Webview in place'
    );
    assert.equal(
        panel.postedMessages.at(-1).html.includes('visible-session-b'),
        true
    );
    assert.deepEqual(panel.revealColumns, [fakeVscode.ViewColumn.Active]);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 retains one Webview document while switching Codex, Kimi, and Claude Sessions and while hidden', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (provider, sessionId) => ({
            ...outline(sessionId, [`${sessionId}-input`]),
            provider,
        }),
        readPage: async request => ({
            ...page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${request.provider}`
            ),
            provider: request.provider,
        }),
    });

    await viewer.open(target('codex-session', 'codex-session-input'));
    assert.equal(
        panel.createArguments[3].retainContextWhenHidden,
        true,
        'the singleton Conversation panel must retain its Webview context'
    );
    const retainedDocument = panel.webview.html;

    for (const provider of ['kimi', 'claude']) {
        const sessionId = `${provider}-session`;
        assert.equal(await viewer.follow(target(
            sessionId,
            `${sessionId}-input`,
            { provider }
        )), true);
        assert.equal(panel.webview.html, retainedDocument);
        const publication = panel.postedMessages.at(-1);
        assert.equal(publication.target.provider, provider);
        assert.equal(publication.target.sessionId, sessionId);
        assert.match(publication.html, new RegExp(`visible-${provider}`));
    }

    await panel.setVisible(false);
    await panel.setVisible(true);
    assert.equal(
        panel.webview.html,
        retainedDocument,
        'showing a retained panel must not rebuild its document'
    );
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 distinguishes the current target from the focused Conversation target', async () => {
    const focusStates = [];
    const { viewer, panel } = createViewer({
        setKeyboardFocus: focused => focusStates.push(focused),
    });
    assert.equal(viewer.getCurrentTarget(), undefined);
    assert.equal(viewer.getFocusedSessionTarget(), undefined);

    await viewer.open(target('session-a', 'input-a'));
    assert.deepEqual(viewer.getCurrentTarget(), target('session-a', 'input-a'));
    assert.equal(viewer.getFocusedTarget(), undefined);
    await panel.receive({
        type: 'conversation-viewer-focus',
        version: 1,
        focused: true,
    });
    assert.deepEqual(viewer.getFocusedTarget(), target('session-a', 'input-a'));
    assert.deepEqual(viewer.getFocusedSessionTarget(), {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });

    await panel.receive({
        type: 'conversation-viewer-focus',
        version: 1,
        focused: false,
    });
    assert.deepEqual(viewer.getCurrentTarget(), target('session-a', 'input-a'));
    assert.equal(viewer.getFocusedTarget(), undefined);
    assert.equal(viewer.getFocusedSessionTarget(), undefined);
    assert.deepEqual(focusStates, [false, true, false]);
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 explicitly restores focus to an open Conversation panel', async () => {
    const { viewer, panel } = createViewer();
    assert.equal(viewer.focus(), false);

    await viewer.open(target('session-a', 'input-a'));
    await panel.setActive(false);
    assert.equal(viewer.focus(), true);
    assert.deepEqual(panel.revealColumns, [
        fakeVscode.ViewColumn.Active,
        fakeVscode.ViewColumn.Active,
    ]);
    assert.deepEqual(panel.revealPreserveFocus, [undefined, false]);
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 reports a superseded in-viewer Session load as not followed', async () => {
    const slowOutlineStarted = deferred();
    const releaseSlowOutline = deferred();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'session-b') {
                slowOutlineStarted.resolve();
                await releaseSlowOutline.promise;
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('session-a', 'session-a-input'));

    const first = viewer.follow(target('session-b', 'session-b-input'));
    await slowOutlineStarted.promise;
    assert.equal(
        await viewer.follow(target('session-c', 'session-c-input')),
        true
    );
    releaseSlowOutline.resolve();
    assert.equal(await first, false);
    assert.match(panel.postedMessages.at(-1).html, /session-c-input/);
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
    await new Promise(resolve => setImmediate(resolve));
    const initial = panel.postedMessages.at(-1)
        || decodeInitialPublication(panel.webview.html);
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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 publishes readable content before optional subagent discovery settles for every provider', async () => {
    for (const provider of ['codex', 'kimi', 'claude']) {
        const subagents = deferred();
        let openSettled = false;
        const sessionId = `${provider}-nonblocking-subagents`;
        const { viewer, panel } = createViewer({
            readOutline: async () => ({
                ...outline(sessionId, ['input-1']),
                provider,
            }),
            readPage: async request => ({
                ...page(sessionId, request.anchorInteractionId, `${provider}-visible`),
                provider,
            }),
            readSubagents: async () => subagents.promise,
        });

        const opening = viewer.open(target(sessionId, 'input-1', { provider }))
            .then(() => { openSettled = true; });
        await new Promise(resolve => setImmediate(resolve));
        const settledBeforeSubagents = openSettled;
        const readableBeforeSubagents = panel.webview.html.includes(
            `${provider}-visible`
        ) || panel.postedMessages.some(message =>
            message.html?.includes(`${provider}-visible`)
        );

        subagents.resolve([{
            id: 'a11111111',
            label: `${provider} worker`,
            status: 'running',
        }]);
        await opening;

        assert.equal(settledBeforeSubagents, true,
            `${provider} content publication must not await subagents`);
        assert.equal(readableBeforeSubagents, true,
            `${provider} readable content must precede subagents`);
        viewer.dispose();
    }
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps late subagents after same-session navigation supersedes the page request', async () => {
    const subagents = deferred();
    const sessionId = 'navigated-while-discovering';
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(
            sessionId,
            ['input-1', 'input-2']
        ),
        readPage: async request => page(
            sessionId,
            request.anchorInteractionId,
            'readable',
            {
                interactionIds: ['input-1', 'input-2'],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
        readSubagents: async () => subagents.promise,
    });

    await viewer.open(target(sessionId, 'input-2'));
    await panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');

    subagents.resolve([{
        id: 'a11111111',
        label: 'Late worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['a11111111']
    );
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 prevents an older subagent result from superseding a newer authoritative refresh', async () => {
    const sessionId = 'refresh-while-discovering';
    const refreshedOutline = deferred();
    const firstSubagents = deferred();
    const secondSubagents = deferred();
    let outlineReads = 0;
    let subagentReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => {
            outlineReads += 1;
            if (outlineReads === 2) {
                return refreshedOutline.promise;
            }
            return outline(sessionId, ['input-1']);
        },
        readPage: async request => page(
            sessionId,
            request.anchorInteractionId,
            request.expectedRevision,
            { sourceRevision: request.expectedRevision }
        ),
        readSubagents: async () => (
            ++subagentReads === 1
                ? firstSubagents.promise
                : secondSubagents.promise
        ),
    });

    await viewer.open(target(sessionId, 'input-1'));
    const refreshing = viewer.refresh();
    await new Promise(resolve => setImmediate(resolve));
    firstSubagents.resolve([{
        id: 'stale-worker',
        label: 'Stale worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    refreshedOutline.resolve(outline(
        sessionId,
        ['input-1'],
        { sourceRevision: 'r2' }
    ));
    await refreshing;
    secondSubagents.resolve([{
        id: 'current-worker',
        label: 'Current worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['current-worker']
    );
    assert.match(panel.postedMessages.at(-1).html, /r2/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 prevents an older subagent result from cancelling cross-page navigation', async () => {
    const sessionId = 'cross-page-while-discovering';
    const navigationPage = deferred();
    const firstSubagents = deferred();
    const secondSubagents = deferred();
    let pageReads = 0;
    let subagentReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(
            sessionId,
            ['input-1', 'input-2']
        ),
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 2) {
                return navigationPage.promise;
            }
            return page(sessionId, 'input-2', 'initial', {
                interactionIds: ['input-2'],
                anchorInteractionId: 'input-2',
                previousCursor: 'before-input-2',
            });
        },
        readSubagents: async () => (
            ++subagentReads === 1
                ? firstSubagents.promise
                : secondSubagents.promise
        ),
    });

    await viewer.open(target(sessionId, 'input-2'));
    const navigating = panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    await new Promise(resolve => setImmediate(resolve));
    firstSubagents.resolve([{
        id: 'stale-worker',
        label: 'Stale worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    navigationPage.resolve(page(sessionId, 'input-1', 'navigated', {
        interactionIds: ['input-1'],
        anchorInteractionId: 'input-1',
        nextCursor: 'after-input-1',
    }));
    await navigating;
    secondSubagents.resolve([{
        id: 'current-worker',
        label: 'Current worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    assert.match(panel.postedMessages.at(-1).html, /navigated/);
    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['current-worker']
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 revalidates a warm latest snapshot without overriding later user navigation', async () => {
    const sessionId = 'warm-latest';
    let authoritativeReads = 0;
    const snapshot = {
        outline: outline(sessionId, ['input-1', 'input-2']),
        page: page(sessionId, 'input-2', 'warm', {
            interactionIds: ['input-1', 'input-2'],
            anchorInteractionId: 'input-2',
        }),
    };
    const { viewer, panel } = createViewer({
        readSnapshot: async () => {
            authoritativeReads += 1;
            return {
                outline: outline(
                    sessionId,
                    ['input-1', 'input-2', 'input-3'],
                    { sourceRevision: 'r2' }
                ),
                page: page(sessionId, 'input-3', 'authoritative', {
                    interactionIds: ['input-1', 'input-2', 'input-3'],
                    anchorInteractionId: 'input-3',
                    sourceRevision: 'r2',
                }),
            };
        },
    });

    await viewer.open(target(sessionId, 'input-2'), snapshot);
    await viewer.revalidateLatest('input-2');
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-3');
    assert.equal(authoritativeReads, 1);

    await viewer.open(target(sessionId, 'input-2'), snapshot);
    await panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    await viewer.revalidateLatest('input-2');
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    assert.equal(authoritativeReads, 1,
        'manual navigation must cancel the automatic latest revalidation');
    viewer.dispose();
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

    assert.equal(panel.postedMessages.at(-1).html.includes('visible-b'), true);
    assert.equal(panel.postedMessages.at(-1).html.includes('visible-a'), false);
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

test('CONVERSATION-OUTLINE-BOOKMARKS-001 restores and Host-settles bookmarks without changing authoritative outline order', async () => {
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

test('CONVERSATION-SESSION-REBIND-001 freezes and drains old-root metadata mutations before copying', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 0, interactionIds: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({ storeTarget, snapshot });
                saveStarted.resolve();
                await releaseSave.promise;
            },
        },
    });
    await viewer.open(target('old-root'));
    const firstMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'before-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await saveStarted.promise;

    let drainSettled = false;
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    }).then(result => {
        drainSettled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(drainSettled, false, 'copy barrier must await active saves');
    const frozenMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'after-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: false },
    });
    releaseSave.resolve();

    await firstMutation;
    assert.equal(await drain, true);
    await frozenMutation;
    assert.equal(saved.length, 1, 'a frozen mutation must not write old storage');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-bookmarks-result',
        version: 1,
        requestId: 'after-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        success: false,
        revision: 1,
        interactionIds: ['input-1'],
        error: 'stale',
    });
});

test('CONVERSATION-SESSION-REBIND-001 drains an old-root mutation after the viewer has already switched', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 0, interactionIds: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({
                    target: { ...storeTarget },
                    snapshot: {
                        revision: snapshot.revision,
                        interactionIds: [...snapshot.interactionIds],
                    },
                });
                if (saved.length === 1) {
                    saveStarted.resolve();
                    await releaseSave.promise;
                }
            },
        },
    });
    await viewer.open(target('old-root'));
    const oldMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'old-pending',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await saveStarted.promise;
    assert.equal(await viewer.follow(target('other-root')), true);

    let drainSettled = false;
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    }).then(result => {
        drainSettled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(drainSettled, false);
    releaseSave.resolve();

    await oldMutation;
    assert.equal(await drain, false, 'the current target must stay unfrozen');
    assert.deepEqual(saved, [{
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 1, interactionIds: ['input-1'] },
    }, {
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 0, interactionIds: [] },
    }], 'the stale old write must finish its rollback before copying');
});

test('CONVERSATION-SESSION-REBIND-001 rolls back a stale old-root comment before the copy barrier settles', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        commentStore: {
            async load() {
                return { revision: 0, comments: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({
                    target: { ...storeTarget },
                    snapshot: {
                        revision: snapshot.revision,
                        comments: snapshot.comments.map(comment => ({
                            ...comment,
                        })),
                    },
                });
                if (saved.length === 1) {
                    saveStarted.resolve();
                    await releaseSave.promise;
                }
            },
        },
    });
    await viewer.open(target('old-root'));
    const oldMutation = panel.receive({
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        requestId: 'old-comment-pending',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'add',
        expectedRevision: 0,
        payload: {
            scope: 'session',
            comment: 'Do not migrate a failed comment.',
        },
    });
    await saveStarted.promise;
    assert.equal(await viewer.follow(target('other-root')), true);
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    });
    releaseSave.resolve();

    await oldMutation;
    assert.equal(await drain, false);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].snapshot.revision, 1);
    assert.equal(saved[0].snapshot.comments.length, 1);
    assert.deepEqual(saved[1], {
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 0, comments: [] },
    });
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
    const findControllerIndex = panel.webview.html.indexOf(
        'conversationFindScripts.js'
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
    assert.ok(reconcileControllerIndex < findControllerIndex);
    assert.ok(findControllerIndex < viewerIndex);

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

test('CONVERSATION-LOCAL-FILE-LINKS-001 renders absolute file links and opens their exact line', async () => {
    const openedFiles = [];
    const filePath = '/home/example/project/src/localStore.ts';
    const { viewer, panel } = createViewer({
        openLocalFile: async targetFile => {
            openedFiles.push(targetFile);
        },
        readPage: async request => ({
            ...page(request.sessionId, request.anchorInteractionId),
            messages: [{
                id: `${request.anchorInteractionId}:assistant`,
                interactionId: request.anchorInteractionId,
                role: 'assistant',
                markdown: `[localStore.ts](${filePath}:17)`,
            }],
        }),
    });

    await viewer.open(target('session-a'));

    assert.match(
        decodeInitialPublication(panel.webview.html).html,
        /<a href="\/home\/example\/project\/src\/localStore\.ts:17">localStore\.ts<\/a>/
    );
    await panel.receive({
        type: 'conversation-viewer-open-link',
        version: 1,
        href: `${filePath}:17`,
    });
    assert.deepEqual(openedFiles, [{ fsPath: filePath, line: 17, column: 1 }]);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 routes one exact selection send to the active terminal inserter', async () => {
    const inserted = [];
    const { viewer, panel } = createViewer({
        insertIntoActiveTerminal: async text => {
            inserted.push(text);
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive({
        type: 'conversation-viewer-send-selection',
        version: 1,
        text: 'beta quote',
    });
    assert.deepEqual(inserted, ['beta quote']);

    for (const message of [
        { type: 'conversation-viewer-send-selection', version: 1 },
        { type: 'conversation-viewer-send-selection', version: 1, text: '   ' },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'x'.repeat(4001),
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'ok',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.deepEqual(inserted, ['beta quote']);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 routes adjacent session switches with the authoritative current target', async () => {
    const switches = [];
    const { viewer, panel } = createViewer({
        followAdjacentConversation: async (direction, currentTarget) => {
            switches.push({ direction, currentTarget });
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive({
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'next',
    });
    assert.deepEqual(switches, [{
        direction: 'next',
        currentTarget: target('session-a', 'input-1'),
    }]);

    for (const message of [
        { type: 'conversation-viewer-switch-session', version: 1 },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'up',
        },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'previous',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.equal(switches.length, 1);
});

test('CONVERSATION-WORKING-INDICATOR-001 includes one polite hidden Working status in the Host document', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-working'));

    assert.equal(
        (panel.webview.html.match(/data-conversation-working/g) || []).length,
        1
    );
    assert.match(
        panel.webview.html,
        /data-conversation-working[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*hidden/
    );
    assert.match(panel.webview.html, />Working<\/span>/);
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
        showThinking: () => true,
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

test('CONVERSATION-THINKING-VISIBILITY-001 hides Thinking by default and republishes it only when enabled', async () => {
    let showThinking = false;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readPage: async request => {
            pageReads += 1;
            return {
                ...page(request.sessionId, request.anchorInteractionId),
                messages: [
                    {
                        id: 'input-1:thinking:0',
                        interactionId: 'input-1',
                        role: 'thinking',
                        markdown: '',
                        thinking: { text: 'private working notes' },
                    },
                    {
                        id: 'input-1:assistant:0',
                        interactionId: 'input-1',
                        role: 'assistant',
                        markdown: 'public answer',
                    },
                ],
            };
        },
        showThinking: () => showThinking,
    });

    await viewer.open(target('session-a', 'input-1'));
    let publication = decodeInitialPublication(panel.webview.html);
    assert.equal(publication.html.includes('private working notes'), false);
    assert.equal(publication.html.includes('public answer'), true);

    showThinking = true;
    await viewer.refreshPresentation();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('private working notes'), true);
    assert.equal(publication.html.includes('public answer'), true);

    showThinking = false;
    await viewer.refreshPresentation();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('private working notes'), false);
    assert.equal(publication.html.includes('public answer'), true);
    assert.equal(pageReads, 1, 'presentation changes must reuse retained data');
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

test('CONVERSATION-WORKING-INDICATOR-001 republishes lifecycle state when content revision is unchanged', async () => {
    let onChange;
    let responseState = 'complete';
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[0].responseState = responseState;
            return value;
        },
        readPage: async request => {
            pageReads += 1;
            return page(request.sessionId, request.anchorInteractionId, 'visible', {
                sourceRevision: request.expectedRevision,
            });
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    responseState = 'inProgress';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publications = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page');
    assert.equal(pageReads, 2,
        'lifecycle-only refresh reprojects response state and message roles');
    assert.equal(publications.length, 1);
    assert.equal(publications[0].outline[0].responseState, 'inProgress');
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

test('CONVERSATION-VIEWER-LOADING-001 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 keeps following newly appended running inputs across coalesced watcher refreshes', async t => {
    let onChange;
    let outlineReads = 0;
    const secondOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                return outline(sessionId, ['input-1'], {
                    sourceRevision: 'r1',
                    responseStates: { 'input-1': 'inProgress' },
                });
            }
            if (outlineReads === 2) {
                return secondOutline.promise;
            }
            return outline(sessionId, ['input-1', 'input-2', 'input-3'], {
                sourceRevision: 'r3',
                responseStates: { 'input-3': 'inProgress' },
            });
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
        ),
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-a', 'input-1'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 2);
    onChange();
    secondOutline.resolve(outline('session-a', ['input-1', 'input-2'], {
        sourceRevision: 'r2',
        responseStates: { 'input-2': 'inProgress' },
    }));
    for (let turn = 0; turn < 4; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(outlineReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-LOADING-001 CONVERSATION-READING-FOCUS-001 keeps a historical selection made during coalesced watcher refreshes', async t => {
    let onChange;
    let outlineReads = 0;
    const secondOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                return outline(sessionId, ['input-1', 'input-2'], {
                    sourceRevision: 'r1',
                });
            }
            if (outlineReads === 2) {
                return secondOutline.promise;
            }
            return outline(
                sessionId,
                ['input-1', 'input-2', 'input-3', 'input-4'],
                { sourceRevision: 'r3' }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                interactionIds: request.anchorInteractionId === 'input-2'
                    ? ['input-1', 'input-2']
                    : [request.anchorInteractionId],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-a', 'input-2'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 2);
    onChange();
    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    secondOutline.resolve(outline(
        'session-a',
        ['input-1', 'input-2', 'input-3'],
        { sourceRevision: 'r2' }
    ));
    for (let turn = 0; turn < 4; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(outlineReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.atLatest, false);
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

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 follows a newly appended running input when the previous selection was latest', async () => {
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
                {
                    sourceRevision: outlineRead === 1 ? 'r1' : 'r2',
                    responseStates: outlineRead === 1
                        ? { 'input-1': 'inProgress' }
                        : { 'input-1': 'complete', 'input-2': 'inProgress' },
                }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
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
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 preserves a historical selection when a refresh adds a new last input', async () => {
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
                outlineRead === 1
                    ? ['input-1', 'input-2']
                    : ['input-1', 'input-2', 'input-3'],
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
    assert.equal(publication.totalInputs, 3);
    assert.equal(publication.atLatest, false);
});

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 follows a new running input when authority reconciliation arrives before the provider watch', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? ['input-1'] : ['input-1', 'input-2'],
            {
                sourceRevision: `r${revision}`,
                responseStates: revision === 1
                    ? { 'input-1': 'inProgress' }
                    : { 'input-1': 'complete', 'input-2': 'inProgress' },
            }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    revision = 2;
    await viewer.reconcileAuthority(() => true);

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-DELIVERY-001 retains hidden Webview context without rebuilding it on visibility changes', async () => {
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
    assert.equal(panel.createArguments[3].retainContextWhenHidden, true);
    await panel.setVisible(false);
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.webview.html.includes('visible-r2'), true);
    const retainedDocument = panel.webview.html;
    await panel.setVisible(true);

    assert.equal(panel.webview.html, retainedDocument);

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

test('CONVERSATION-VIEWER-STALE-004 fails a follow-latest refresh retry closed when the prior latest interaction disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            const interactionIds = outlineReads === 1
                ? ['input-1']
                : outlineReads === 2
                    ? ['input-1', 'input-2']
                    : ['input-2', 'input-3'];
            return outline(sessionId, interactionIds, {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 2) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                pageReads === 1 ? 'visible-established' : 'must-not-follow',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.refresh();

    assert.equal(outlineReads, 3);
    assert.equal(pageReads, 2);
    assert.deepEqual(
        requests.map(request => request.anchorInteractionId),
        ['input-1', 'input-2']
    );
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.stale, true);
    assert.equal(publication.html.includes('visible-established'), true);
    assert.equal(publication.html.includes('must-not-follow'), false);
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

test('CONVERSATION-VIEWER-REFRESH-003 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 merges a new tail page and advances from the prior latest interaction', async () => {
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
    assert.equal(publication.selectedInteractionId, 'input-21');
    assert.equal(publication.atLatest, true);
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

function worklogPage(sessionId, options = {}) {
    const state = {
        interactionId: 'input-1',
        responseState: options.responseState || 'complete',
        ...(options.timestamp !== undefined
            ? { timestamp: options.timestamp } : {}),
        ...(options.completedAt !== undefined
            ? { completedAt: options.completedAt } : {}),
    };
    const messages = [{
        id: 'input-1:user',
        interactionId: 'input-1',
        role: 'user',
        markdown: 'Run the tests',
    }];
    if (options.withWork !== false) {
        messages.push({
            id: 'input-1:tool:0',
            interactionId: 'input-1',
            role: 'tool',
            markdown: '',
            tool: { name: 'Shell', summary: 'Shell npm test', detail: '9 passing' },
        });
    }
    if (options.withAnswer !== false) {
        messages.push({
            id: 'input-1:assistant:0',
            interactionId: 'input-1',
            role: 'assistant',
            markdown: 'All pass.',
        });
    }
    return {
        ...page(sessionId, 'input-1', 'visible'),
        messages,
        interactionStates: [state],
    };
}

function lifecycleProjectionPage(
    sessionId,
    sourceRevision,
    anchorInteractionId,
    latestState,
    options = {}
) {
    const messages = [];
    const interactionStates = [];
    if (options.includeEarlier !== false) {
        messages.push({
            id: 'input-1:user',
            interactionId: 'input-1',
            role: 'user',
            markdown: 'Read the earlier turn',
        });
        interactionStates.push({
            interactionId: 'input-1',
            responseState: 'complete',
        });
    }
    if (options.includeLatest !== false) {
        messages.push(
            {
                id: 'input-2:user',
                interactionId: 'input-2',
                role: 'user',
                markdown: 'Run the tests',
            },
            {
                id: 'input-2:tool:0',
                interactionId: 'input-2',
                role: 'tool',
                markdown: '',
                tool: { name: 'Shell', summary: 'Shell npm test' },
            },
            {
                id: `input-2:${latestState === 'inProgress'
                    ? 'progress'
                    : 'assistant'}:0`,
                interactionId: 'input-2',
                role: latestState === 'inProgress'
                    ? 'progress'
                    : 'assistant',
                markdown: latestState === 'inProgress'
                    ? 'Still running.'
                    : 'All pass.',
            }
        );
        interactionStates.push({
            interactionId: 'input-2',
            responseState: latestState,
            timestamp: 1_000,
            completedAt: 81_000,
        });
    }
    return {
        provider: 'codex',
        sessionId,
        sourceRevision,
        anchorInteractionId,
        messages,
        interactionStates,
        isStart: true,
        isEnd: true,
    };
}

test('CONVERSATION-WORKLOG-COLLAPSE-001 publishes a Worked-for row between work entries and the answer', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            timestamp: 1_000,
            completedAt: 81_000,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-message-worklog'), true);
    assert.equal(html.includes('Worked for 1m 20s'), true);
    const userIndex = html.indexOf('conversation-message-user');
    const worklogIndex = html.indexOf('conversation-message-worklog');
    const toolIndex = html.indexOf('conversation-message-tool');
    const answerIndex = html.indexOf('All pass.');
    assert.ok(userIndex >= 0 && worklogIndex > userIndex
        && toolIndex > worklogIndex && answerIndex > toolIndex,
        'worklog row heads the work group so expanding never moves the toggle:'
            + ` ${userIndex}/${worklogIndex}/${toolIndex}/${answerIndex}`);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 renders Codex app-server duration in the Worked-for row', async t => {
    const adapter = new CodexConversationAdapter({
        client: {
            async request() {
                return timedCodexFixture;
            },
            dispose() {},
        },
        watchSessionChanges: () => ({ dispose() {} }),
        setTimeout: callback => {
            callback();
            return 1;
        },
        clearTimeout() {},
        setCacheTimeout: () => 2,
        clearCacheTimeout() {},
    });
    t.after(() => adapter.dispose());
    const { viewer, panel } = createViewer({
        readOutline: (_provider, sessionId) => adapter.readOutline(sessionId),
        readSnapshot: (_provider, sessionId, preferredInteractionId) =>
            adapter.readSnapshot(sessionId, preferredInteractionId),
        readPage: request => adapter.readPage(request),
    });

    await viewer.open(target(
        timedCodexFixture.thread.id,
        'user-timed',
        { expectedRevision: undefined }
    ));

    assert.equal(panel.webview.html.includes('Worked for 1m 16s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 renders the sum of Codex subagent turn durations', async t => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const timedTurns = [
        {
            id: 'turn-subagent-1',
            status: 'completed',
            startedAt: 1_700_000_010,
            durationMs: 10_000,
            items: [
                { id: 'progress-subagent-1', type: 'agentMessage', text: 'First progress', phase: 'commentary' },
            ],
        },
        {
            id: 'turn-subagent-2',
            status: 'completed',
            startedAt: 1_700_000_100,
            durationMs: 20_000,
            items: [
                { id: 'answer-subagent-2', type: 'agentMessage', text: 'Finished' },
            ],
        },
    ];
    const childFixture = turns => ({
        thread: {
            id: childId,
            parentThreadId: rootId,
            agentNickname: 'Zeno',
            createdAt: 1_700_000_000,
            turns,
        },
    });
    const render = async result => {
        const adapter = new CodexConversationAdapter({
            client: {
                async request() {
                    return result;
                },
                dispose() {},
            },
            watchSessionChanges: () => ({ dispose() {} }),
            setTimeout: callback => {
                callback();
                return 1;
            },
            clearTimeout() {},
            setCacheTimeout: () => 2,
            clearCacheTimeout() {},
        });
        t.after(() => adapter.dispose());
        const { viewer, panel } = createViewer({
            readOutline: (_provider, sessionId) =>
                adapter.readOutline(sessionId),
            readSnapshot: (_provider, sessionId, preferredInteractionId) =>
                adapter.readSnapshot(sessionId, preferredInteractionId),
            readPage: request => adapter.readPage(request),
        });
        await viewer.open(target(rootId, `${childId}-dispatch`, {
            expectedRevision: undefined,
            subagent: { id: childId, label: 'Zeno' },
        }));
        return decodeInitialPublication(panel.webview.html).html;
    };

    const timedHtml = await render(childFixture(timedTurns));
    assert.equal(timedHtml.includes('Worked for 30s'), true);

    const untimedHtml = await render(childFixture([{
        id: 'turn-subagent-untimed',
        status: 'completed',
        items: [{
            id: 'progress-subagent-untimed',
            type: 'agentMessage',
            text: 'Untimed progress',
            phase: 'commentary',
        }],
    }, timedTurns[1]]));
    assert.equal(untimedHtml.includes('Worked for 20s'), false);
    assert.equal(
        untimedHtml.includes('conversation-worklog-label">Worked</span>'),
        true
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 omits the row while in progress and falls back without timing', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            responseState: 'inProgress',
            timestamp: 1_000,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        panel.webview.html.includes('conversation-message-worklog'),
        false,
        'in-progress turns keep their work expanded without a row'
    );

    const { viewer: fallbackViewer, panel: fallbackPanel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId),
    });
    await fallbackViewer.open(target('session-b', 'input-1'));
    const html = fallbackPanel.webview.html;
    assert.equal(html.includes('conversation-message-worklog'), true);
    assert.equal(html.includes('&gt;Worked&lt;/span'), true,
        'turns without timing fall back to a plain Worked label');
    assert.equal(html.includes('Worked for'), false);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 collapses on a lifecycle-only completion refresh', async () => {
    let onChange;
    let responseState = 'inProgress';
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[0].responseState = responseState;
            return value;
        },
        readPage: async request => {
            pageReads += 1;
            const value = worklogPage(request.sessionId, {
                responseState,
                timestamp: 1_000,
                completedAt: 81_000,
            });
            if (responseState === 'inProgress') {
                value.messages = value.messages.map(message => ({
                    ...message,
                    role: message.role === 'assistant'
                        ? 'progress'
                        : message.role,
                }));
            }
            return {
                ...value,
                sourceRevision: request.expectedRevision,
            };
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    responseState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.outline[0].responseState, 'complete');
    assert.equal(pageReads, 2,
        'completion must reproject progress back to the final answer');
    assert.equal(
        publication.html.includes('conversation-message-worklog'),
        true,
        'the same lifecycle refresh must collapse retained work'
    );
    assert.equal(publication.html.includes('Worked for 1m 20s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 reprojects the changed turn without moving a historical selection', async () => {
    let onChange;
    let latestState = 'inProgress';
    const pageAnchors = [];
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1', 'input-2'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[1].responseState = latestState;
            return value;
        },
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return {
                provider: 'codex',
                sessionId: request.sessionId,
                sourceRevision: request.expectedRevision,
                anchorInteractionId: request.anchorInteractionId,
                messages: [
                    {
                        id: 'input-1:user',
                        interactionId: 'input-1',
                        role: 'user',
                        markdown: 'Read the earlier turn',
                    },
                    {
                        id: 'input-2:user',
                        interactionId: 'input-2',
                        role: 'user',
                        markdown: 'Run the tests',
                    },
                    {
                        id: 'input-2:tool:0',
                        interactionId: 'input-2',
                        role: 'tool',
                        markdown: '',
                        tool: { name: 'Shell', summary: 'Shell npm test' },
                    },
                    {
                        id: `input-2:${latestState === 'inProgress'
                            ? 'progress'
                            : 'assistant'}:0`,
                        interactionId: 'input-2',
                        role: latestState === 'inProgress'
                            ? 'progress'
                            : 'assistant',
                        markdown: latestState === 'inProgress'
                            ? 'Still running.'
                            : 'All pass.',
                    },
                ],
                interactionStates: [
                    {
                        interactionId: 'input-1',
                        responseState: 'complete',
                    },
                    {
                        interactionId: 'input-2',
                        responseState: latestState,
                        timestamp: 1_000,
                        completedAt: 81_000,
                    },
                ],
                isStart: true,
                isEnd: true,
            };
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-1', 'input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 bypasses a snapshot page that misses the changed turn', async () => {
    let onChange;
    let latestState = 'inProgress';
    let snapshotReads = 0;
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: 'stable-r1',
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readSnapshot: async (_provider, sessionId, preferredInteractionId) => {
            snapshotReads += 1;
            return {
                outline: currentOutline(sessionId),
                page: lifecycleProjectionPage(
                    sessionId,
                    'stable-r1',
                    preferredInteractionId || 'input-1',
                    latestState,
                    { includeLatest: snapshotReads === 1 }
                ),
            };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                { includeEarlier: false }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 merges a historical snapshot and the completed turn across revisions', async () => {
    let onChange;
    let latestState = 'inProgress';
    let revision = 'r1';
    let snapshotReads = 0;
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: revision,
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readSnapshot: async (_provider, sessionId, preferredInteractionId) => {
            snapshotReads += 1;
            const snapshotPage = lifecycleProjectionPage(
                sessionId,
                revision,
                preferredInteractionId || 'input-1',
                latestState,
                { includeLatest: snapshotReads === 1 }
            );
            if (snapshotReads > 1) {
                snapshotPage.messages[0].markdown = 'Updated earlier turn';
            }
            return {
                outline: currentOutline(sessionId),
                page: snapshotPage,
            };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                { includeEarlier: false }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'r1',
    }));
    latestState = 'complete';
    revision = 'r2';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('Updated earlier turn'), true,
        'the selected historical page must retain its content refresh');
    assert.equal(publication.html.includes('conversation-message-worklog'), true,
        'the retained completed turn must receive its final projection');
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 retries a stale changed-turn projection without falling back to history', async () => {
    let onChange;
    let latestState = 'inProgress';
    let revision = 'r1';
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: revision,
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            if (request.anchorInteractionId === 'input-2'
                && request.expectedRevision === 'r1') {
                revision = 'r2';
                throw new ConversationError('staleRevision');
            }
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                request.anchorInteractionId === 'input-2'
                    ? { includeEarlier: false }
                    : { includeLatest: pageAnchors.length === 1 }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-1', 'input-2', 'input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 keeps timing after a content refresh merge', async () => {
    let onChange;
    let revision = 'r1';
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: revision }
        ),
        readPage: async request => ({
            ...worklogPage(request.sessionId, {
                timestamp: 1_000,
                completedAt: 81_000,
            }),
            sourceRevision: request.expectedRevision,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    revision = 'r2';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('Worked for 1m 20s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 falls back safely when finite timestamps overflow', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            timestamp: -1e308,
            completedAt: 1e308,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('&gt;Worked&lt;/span'), true);
    assert.equal(html.includes('Infinity'), false);
    assert.equal(html.includes('NaN'), false);
});

test('CONVERSATION-MESSAGE-BOOKMARK-001 renders a bookmark toggle inside each user input card only', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    const userIndex = html.indexOf('conversation-message-user');
    const bookmarkIndex = html.indexOf('conversation-message-bookmark');
    const markdownIndex = html.indexOf('Run the tests');
    assert.ok(userIndex >= 0 && bookmarkIndex > userIndex
        && bookmarkIndex < markdownIndex,
        'the bookmark toggle lives inside the user input card:'
            + ` ${userIndex}/${bookmarkIndex}/${markdownIndex}`);
    assert.equal(html.includes('Bookmark this input'), true);
    assert.equal(
        html.indexOf('conversation-message-bookmark', bookmarkIndex + 1),
        -1,
        'work entries and the answer carry no bookmark toggle'
    );
});

function copyPage(sessionId) {
    return {
        ...page(sessionId, 'input-1', 'visible'),
        messages: [{
            id: 'input-1:user',
            interactionId: 'input-1',
            role: 'user',
            markdown: 'Add tests for the parser',
        }, {
            id: 'input-1:assistant:0',
            interactionId: 'input-1',
            role: 'assistant',
            markdown: 'Like this:\n\n```ts\nconst answer = 42;\n```',
        }],
        interactionStates: [{
            interactionId: 'input-1',
            responseState: 'complete',
        }],
    };
}

function copyRequest(requestId, payload, overrides = {}) {
    return {
        type: 'conversation-viewer-copy',
        version: 1,
        requestId,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'copy',
        payload,
        ...overrides,
    };
}

test('CONVERSATION-COPY-ACTIONS-001 renders code block chrome and message copy controls', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => copyPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-code-block'), true,
        'fenced code renders inside a copyable block wrapper');
    assert.equal(html.includes('conversation-code-header'), true,
        'the block chrome sits on its own header strip');
    const headerIndex = html.indexOf('conversation-code-header');
    const langIndex = html.indexOf('conversation-code-lang');
    const codeCopyIndex = html.indexOf('conversation-code-copy');
    const codeIndex = html.indexOf('language-ts');
    assert.ok(headerIndex >= 0 && langIndex > headerIndex
        && codeCopyIndex > headerIndex && codeIndex > codeCopyIndex,
        'the header strip carries the label and copy control above the code');
    const userIndex = html.indexOf('conversation-message-user');
    const userTextIndex = html.indexOf('Add tests for the parser');
    const starIndex = html.indexOf('conversation-message-bookmark');
    const userCornerIndex = html.indexOf('conversation-message-corner');
    assert.ok(userIndex >= 0 && starIndex > userIndex
        && userCornerIndex > starIndex && userCornerIndex < userTextIndex,
        'the user card corner cluster sits with the star above its content');
    const userCopyIndex = html.indexOf('conversation-message-copy');
    assert.ok(userCopyIndex > userCornerIndex
        && userCopyIndex < userTextIndex,
        'the user copy control lives in the corner cluster');
    const assistantIndex = html.indexOf('conversation-message-assistant');
    const answerTextIndex = html.indexOf('Like this:');
    const answerActionsIndex = html.indexOf(
        'conversation-message-actions'
    );
    assert.ok(assistantIndex >= 0 && answerTextIndex > assistantIndex
        && answerActionsIndex > answerTextIndex,
        'the assistant action row sits below its content');
    assert.equal(
        html.indexOf('conversation-message-actions', answerActionsIndex + 1),
        -1,
        'only the assistant answer carries a bottom action row'
    );
    assert.equal(
        html.includes('conversation-message-time'),
        false,
        'providers without timing expose no clock on the action row'
    );
});

test('CONVERSATION-FIND-001 renders a hidden find bar wired for in-page search', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => copyPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.match(
        html,
        /<div class="conversation-find" data-conversation-find hidden>/,
        'the find bar ships hidden until the webview opens it'
    );
    const workspaceIndex = html.indexOf('conversation-workspace');
    const findIndex = html.indexOf('data-conversation-find');
    const inputIndex = html.indexOf('data-find-input');
    const countIndex = html.indexOf('data-find-count');
    const previousIndex = html.indexOf('data-find-previous');
    const nextIndex = html.indexOf('data-find-next');
    const closeIndex = html.indexOf('data-find-close');
    assert.ok(workspaceIndex >= 0 && findIndex > workspaceIndex,
        'the find bar lives inside the conversation workspace overlay');
    assert.ok(inputIndex > findIndex && countIndex > inputIndex
        && previousIndex > countIndex && nextIndex > previousIndex
        && closeIndex > nextIndex,
        'the bar pairs the query input and match count with previous, next, and close controls');
    assert.equal(
        html.indexOf('data-conversation-find', findIndex + 1),
        -1,
        'exactly one find bar renders'
    );
    assert.match(html, /type="search"[^>]*data-find-input/);
    assert.equal(html.includes('Find in conversation'), true);
    assert.equal(html.includes('Previous match'), true);
    assert.equal(html.includes('Next match'), true);
    assert.ok(
        findIndex < html.indexOf('conversationFindScripts.js'),
        'the find bar markup ships before its controller script tag'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 clocks the answer action row when the provider exposes timing', async () => {
    const timestamp = Date.now() - 120_000;
    const completedAt = Date.now();
    const { viewer, panel } = createViewer({
        readPage: async request => ({
            ...copyPage(request.sessionId),
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
                timestamp,
                completedAt,
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    const matches = [...html.matchAll(
        /conversation-message-time\\&quot; title=\\&quot;([^\\]+?)\\&quot;&gt;(\d{2}:\d{2})/g
    )];
    assert.equal(matches.length, 2,
        'the user corner and the answer row both carry a clock');
    assert.equal(
        matches[0][1],
        formatConversationClockTime(timestamp, Date.now()).title,
        'the user corner clocks the input time'
    );
    assert.equal(
        matches[1][1],
        formatConversationClockTime(completedAt, Date.now()).title,
        'the answer row clocks the completion time'
    );
    const copyIndex = html.indexOf('conversation-message-copy');
    const timeIndex = html.indexOf('conversation-message-time');
    assert.ok(
        timeIndex >= 0 && timeIndex < copyIndex,
        'the user clock sits left of the copy control'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 omits the clock when timing overflows the Date range', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => ({
            ...copyPage(request.sessionId),
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
                completedAt: 1e308,
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        panel.webview.html.includes('conversation-message-time'),
        false,
        'finite-but-invalid timestamps render no clock'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 settles copies through the Host clipboard', async () => {
    const clips = [];
    const { viewer, panel } = createViewer({
        writeClipboardText: async text => {
            clips.push(text);
        },
        readPage: async request => copyPage(request.sessionId),
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive(copyRequest('copy-1', {
        kind: 'message',
        messageId: 'input-1:assistant:0',
    }));
    assert.deepEqual(clips, ['Like this:\n\n```ts\nconst answer = 42;\n```'],
        'message copies resolve the raw markdown from Host state');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-1',
        success: true,
    });

    await panel.receive(copyRequest('copy-2', {
        kind: 'code',
        text: 'const answer = 42;\n',
    }));
    assert.deepEqual(clips.at(-1), 'const answer = 42;\n');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-2',
        success: true,
    });

    await panel.receive(copyRequest('copy-3', {
        kind: 'message',
        messageId: 'input-9:user',
    }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-3',
        success: false,
        error: 'invalid',
    }, 'unknown messages settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);

    await panel.receive(copyRequest('copy-4', {
        kind: 'code',
        text: 'stale',
    }, { subscriptionGeneration: 2 }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-4',
        success: false,
        error: 'invalid',
    }, 'stale generations settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);

    await panel.receive(copyRequest('copy-5', {
        kind: 'message',
        messageId: 'input-1:user',
    }, { sessionId: 'session-b' }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-5',
        success: false,
        error: 'invalid',
    }, 'wrong-target copies settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);
});
