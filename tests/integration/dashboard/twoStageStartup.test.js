'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentPivotViewProvider } = require('../../../out/dashboard/viewProvider');

function makeVisibleView() {
    let receiveMessage;
    let visibilityChanged;
    let disposed;
    const assignedHtml = [];
    const postedMessages = [];
    let html = '';
    const view = {
        visible: true,
        webview: {
            options: {},
            get html() {
                return html;
            },
            set html(value) {
                html = value;
                assignedHtml.push(value);
            },
            onDidReceiveMessage(callback) {
                receiveMessage = callback;
                return { dispose() {} };
            },
            postMessage: async message => {
                postedMessages.push(message);
                return true;
            },
        },
        onDidChangeVisibility(callback) {
            visibilityChanged = callback;
            return { dispose() {} };
        },
        onDidDispose(callback) {
            disposed = callback;
            return { dispose() {} };
        },
    };
    return {
        assignedHtml,
        postedMessages,
        receiveMessage: message => receiveMessage(message),
        fireVisibility: () => visibilityChanged(),
        fireDispose: () => disposed(),
        view,
    };
}

function readyOptions(events) {
    return {
        getWebviewOptions: () => ({ enableScripts: true }),
        renderContent: () => '<main>ready dashboard</main>',
        renderError: () => '<main>safe dashboard failure</main>',
        onMessage: async message => events.push(['dashboard-message', message]),
        onVisibleChanged: async visible => events.push(['visible', visible]),
        onVisiblePrepared: async () => events.push(['prepared']),
        onDisposed: () => events.push(['disposed']),
        logError: () => undefined,
    };
}

function bootProvider(events) {
    return new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions: () => ({ enableScripts: true }),
            renderBootContent: (_webview, generation) => `<main>boot ${generation}</main>`,
            renderBootError: (_webview, generation) => `<main>failed ${generation}</main>`,
            onBootShellAssigned: generation => events.push(['shell', generation]),
            onRetry: () => events.push(['retry']),
            onFirstPaint: generation => events.push(['paint', generation]),
            logError: () => undefined,
        },
    });
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 keeps generation zero non-renderable before bootstrap begins', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();

    await provider.resolveWebviewView(fake.view, {}, {});

    assert.deepEqual(fake.assignedHtml, []);
    assert.deepEqual(events, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 rejects generation zero completion before bootstrap begins', () => {
    const events = [];
    const provider = bootProvider(events);

    assert.equal(provider.completeBootstrap(0, readyOptions(events)), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 resolves the current view with boot HTML before ready callbacks exist', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();

    assert.equal(provider.beginBootstrap(1), true);
    await provider.resolveWebviewView(fake.view, {}, {});

    assert.deepEqual(fake.assignedHtml, ['<main>boot 1</main>']);
    assert.deepEqual(events, [['shell', 1]]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 adopts ready callbacks once and prepares the same visible view', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});

    assert.equal(provider.completeBootstrap(1, readyOptions(events)), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(fake.assignedHtml, [
        '<main>boot 1</main>',
        '<main>ready dashboard</main>',
    ]);
    assert.deepEqual(events, [
        ['shell', 1],
        ['visible', true],
        ['prepared'],
    ]);
    assert.equal(provider.completeBootstrap(1, readyOptions(events)), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 ignores stale completion and stale first-paint acknowledgements', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});

    await fake.receiveMessage({
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 1,
    });
    await fake.receiveMessage({
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 1,
    });
    assert.equal(provider.beginBootstrap(2), true);
    assert.equal(provider.completeBootstrap(1, readyOptions(events)), false);
    await fake.receiveMessage({
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 1,
    });
    await fake.receiveMessage({
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 2,
    });

    assert.deepEqual(events, [
        ['shell', 1],
        ['paint', 1],
        ['shell', 2],
        ['paint', 2],
    ]);
    assert.deepEqual(fake.assignedHtml, [
        '<main>boot 1</main>',
        '<main>boot 2</main>',
    ]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 routes only exact failed-state Retry messages', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});

    for (const message of [
        null,
        {},
        { type: 'retry-agent-pivot-bootstrap' },
        { type: 'retry-agent-pivot-bootstrap', version: 1, generation: 1 },
        { type: 'retry-agent-pivot-bootstrap', version: 2 },
    ]) {
        await fake.receiveMessage(message);
    }
    assert.deepEqual(events, [['shell', 1]]);

    assert.equal(provider.failBootstrap(1), true);
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    assert.deepEqual(events, [['shell', 1], ['retry']]);

    provider.beginBootstrap(2);
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    assert.equal(provider.completeBootstrap(2, readyOptions(events)), true);
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    assert.deepEqual(events, [
        ['shell', 1],
        ['retry'],
        ['shell', 2],
        ['visible', true],
        ['dashboard-message', { type: 'retry-agent-pivot-bootstrap', version: 1 }],
        ['prepared'],
    ]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 never replaces a healthy ready dashboard with failure HTML', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    assert.equal(provider.completeBootstrap(1, readyOptions(events)), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(provider.failBootstrap(1), false);
    assert.equal(fake.view.webview.html, '<main>ready dashboard</main>');
    assert.equal(fake.assignedHtml.includes('<main>failed 1</main>'), false);
});
