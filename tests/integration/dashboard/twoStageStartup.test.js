'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardBootstrapController } = require('../../../out/dashboard/bootstrapController');
const { AgentPivotViewProvider } = require('../../../out/dashboard/viewProvider');

function makeVisibleView() {
    let receiveMessage;
    let visibilityChanged;
    let disposed;
    const assignedHtml = [];
    const assignedOptions = [];
    const postedMessages = [];
    let html = '';
    let options = {};
    const view = {
        visible: true,
        webview: {
            get options() {
                return options;
            },
            set options(value) {
                options = value;
                assignedOptions.push(value);
            },
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
        assignedOptions,
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

function bootProvider(events, getWebviewOptions = () => ({ enableScripts: true })) {
    return new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions,
            renderBootContent: (_webview, generation) => `<main>boot ${generation}</main>`,
            renderBootError: (_webview, generation) => `<main>failed ${generation}</main>`,
            onBootShellAssigned: generation => events.push(['shell', generation]),
            onRetry: () => events.push(['retry']),
            onFirstPaint: generation => events.push(['paint', generation]),
            logError: () => undefined,
        },
    });
}

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
    let resolve;
    const promise = new Promise(settle => {
        resolve = settle;
    });
    return { promise, resolve };
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

test('WEBVIEW-TWO-STAGE-STARTUP-001 reports shell assignment before one current first-paint acknowledgement', async () => {
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

    assert.deepEqual(events, [
        ['shell', 1],
        ['paint', 1],
    ]);
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

test('WEBVIEW-TWO-STAGE-STARTUP-001 applies ready webview options before ready rendering and preparation', async () => {
    const events = [];
    const bootWebviewOptions = { enableScripts: true };
    const readyWebviewOptions = { enableScripts: false };
    const provider = bootProvider(events, () => bootWebviewOptions);
    const fake = makeVisibleView();
    const order = [];
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});

    const options = {
        ...readyOptions(events),
        getWebviewOptions: () => readyWebviewOptions,
        renderContent: () => {
            order.push(['render', fake.view.webview.options]);
            return '<main>ready dashboard</main>';
        },
        onVisibleChanged: async () => {
            order.push(['visible', fake.view.webview.options]);
        },
    };
    assert.equal(provider.completeBootstrap(1, options), true);

    assert.deepEqual(fake.assignedOptions, [bootWebviewOptions, readyWebviewOptions]);
    assert.deepEqual(order, [
        ['render', readyWebviewOptions],
        ['visible', readyWebviewOptions],
    ]);
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

test('WEBVIEW-TWO-STAGE-STARTUP-001 ignores stale first paint after a new generation and deduplicates the current generation', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    assert.equal(provider.beginBootstrap(2), true);

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
    await fake.receiveMessage({
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 2,
    });

    assert.deepEqual(events, [
        ['shell', 1],
        ['shell', 2],
        ['paint', 2],
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

test('WEBVIEW-TWO-STAGE-STARTUP-001 two exact Retry messages start one pending generation-two flight', async () => {
    const events = [];
    const runs = [];
    const retryFlight = deferred();
    let controller;
    const provider = new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions: () => ({ enableScripts: true }),
            renderBootContent: (_webview, generation) => `<main>boot ${generation}</main>`,
            renderBootError: (_webview, generation) => `<main>failed ${generation}</main>`,
            onBootShellAssigned: generation => events.push(['shell', generation]),
            onRetry: () => controller.retry(),
            onFirstPaint: generation => events.push(['paint', generation]),
            logError: () => undefined,
        },
    });
    controller = new DashboardBootstrapController({
        begin: generation => provider.beginBootstrap(generation),
        run: async generation => {
            runs.push(generation);
            if (generation === 1) throw new Error('controlled bootstrap failure');
            return retryFlight.promise;
        },
        complete: (generation, options) => provider.completeBootstrap(generation, options),
        fail: generation => provider.failBootstrap(generation),
        transfer: resources => resources.dispose(),
        logDiagnostic: () => undefined,
    });
    const fake = makeVisibleView();
    await provider.resolveWebviewView(fake.view, {}, {});
    controller.start();
    await nextTurn();

    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });

    assert.deepEqual(runs, [1, 2]);
    assert.equal(fake.view.webview.html, '<main>boot 2</main>');
    controller.dispose();
    retryFlight.resolve(readyOptions(events));
    await nextTurn();
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 Retry in ready does not rerender or launch bootstrap', async () => {
    const events = [];
    const runs = [];
    let controller;
    const provider = new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions: () => ({ enableScripts: true }),
            renderBootContent: (_webview, generation) => `<main>boot ${generation}</main>`,
            renderBootError: (_webview, generation) => `<main>failed ${generation}</main>`,
            onBootShellAssigned: generation => events.push(['shell', generation]),
            onRetry: () => controller.retry(),
            onFirstPaint: generation => events.push(['paint', generation]),
            logError: () => undefined,
        },
    });
    controller = new DashboardBootstrapController({
        begin: generation => provider.beginBootstrap(generation),
        run: async generation => {
            runs.push(generation);
            if (generation === 1) throw new Error('controlled bootstrap failure');
            return readyOptions(events);
        },
        complete: (generation, options) => provider.completeBootstrap(generation, options),
        fail: generation => provider.failBootstrap(generation),
        transfer: resources => resources.dispose(),
        logDiagnostic: () => undefined,
    });
    const fake = makeVisibleView();
    await provider.resolveWebviewView(fake.view, {}, {});
    controller.start();
    await nextTurn();
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    await nextTurn();
    const assignedHtmlBeforeReadyRetry = fake.assignedHtml.slice();

    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    await nextTurn();

    assert.deepEqual(runs, [1, 2]);
    assert.deepEqual(fake.assignedHtml, assignedHtmlBeforeReadyRetry);
    assert.equal(fake.view.webview.html, '<main>ready dashboard</main>');
    controller.dispose();
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 disposal during Retry rejects late ready assignment and disposes its generation scope', async () => {
    const events = [];
    const retryFlight = deferred();
    const disposedGenerations = [];
    let controller;
    const provider = new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions: () => ({ enableScripts: true }),
            renderBootContent: (_webview, generation) => `<main>boot ${generation}</main>`,
            renderBootError: (_webview, generation) => `<main>failed ${generation}</main>`,
            onBootShellAssigned: generation => events.push(['shell', generation]),
            onRetry: () => controller.retry(),
            onFirstPaint: generation => events.push(['paint', generation]),
            logError: () => undefined,
        },
    });
    controller = new DashboardBootstrapController({
        begin: generation => provider.beginBootstrap(generation),
        run: async (generation, resources) => {
            resources.own({
                dispose: () => disposedGenerations.push(generation),
            });
            if (generation === 1) throw new Error('controlled bootstrap failure');
            return retryFlight.promise;
        },
        complete: (generation, options) => provider.completeBootstrap(generation, options),
        fail: generation => provider.failBootstrap(generation),
        transfer: () => undefined,
        logDiagnostic: () => undefined,
    });
    const fake = makeVisibleView();
    await provider.resolveWebviewView(fake.view, {}, {});
    controller.start();
    await nextTurn();
    await fake.receiveMessage({ type: 'retry-agent-pivot-bootstrap', version: 1 });
    assert.equal(fake.view.webview.html, '<main>boot 2</main>');

    controller.dispose();
    await fake.fireDispose();
    retryFlight.resolve(readyOptions(events));
    await nextTurn();

    assert.equal(fake.assignedHtml.includes('<main>ready dashboard</main>'), false);
    assert.deepEqual(disposedGenerations, [1, 2]);
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

test('WEBVIEW-TWO-STAGE-STARTUP-001 ready option failure leaves adoption rejectable as failed', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    const options = {
        ...readyOptions(events),
        getWebviewOptions() {
            throw new Error('private ready options failure');
        },
    };

    assert.throws(
        () => provider.completeBootstrap(1, options),
        /private ready options failure/
    );
    assert.equal(provider.failBootstrap(1), true);
    assert.equal(fake.view.webview.html, '<main>failed 1</main>');
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 post-adoption render failures cannot escape completion', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    const options = {
        ...readyOptions(events),
        renderContent() {
            throw new Error('private render failure');
        },
        renderError() {
            throw new Error('private fallback failure');
        },
        logError() {
            throw new Error('private logger failure');
        },
    };

    assert.equal(provider.completeBootstrap(1, options), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(provider.failBootstrap(1), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 nested completion cannot steal an in-progress adoption', async () => {
    const events = [];
    const provider = bootProvider(events);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    let nestedAccepted;
    const outerOptions = {
        ...readyOptions(events),
        getWebviewOptions() {
            nestedAccepted = provider.completeBootstrap(1, {
                ...readyOptions(events),
                renderContent: () => '<main>nested dashboard</main>',
            });
            return { enableScripts: false };
        },
        renderContent: () => '<main>outer dashboard</main>',
    };

    assert.equal(provider.completeBootstrap(1, outerOptions), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(nestedAccepted, false);
    assert.equal(fake.view.webview.html, '<main>outer dashboard</main>');
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 nested begin cannot steal ready-option preflight ownership', async () => {
    const events = [];
    const bootWebviewOptions = { enableScripts: true };
    const readyWebviewOptions = { enableScripts: false };
    const provider = bootProvider(events, () => bootWebviewOptions);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    let nestedAccepted;
    const options = {
        ...readyOptions(events),
        getWebviewOptions() {
            nestedAccepted = provider.beginBootstrap(2);
            return readyWebviewOptions;
        },
    };

    assert.equal(provider.completeBootstrap(1, options), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(nestedAccepted, false);
    assert.deepEqual(fake.assignedOptions, [
        bootWebviewOptions,
        readyWebviewOptions,
    ]);
    assert.equal(fake.view.webview.html, '<main>ready dashboard</main>');
    assert.equal(provider.failBootstrap(1), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 nested failure cannot steal ready-option preflight ownership', async () => {
    const events = [];
    const bootWebviewOptions = { enableScripts: true };
    const readyWebviewOptions = { enableScripts: false };
    const provider = bootProvider(events, () => bootWebviewOptions);
    const fake = makeVisibleView();
    provider.beginBootstrap(1);
    await provider.resolveWebviewView(fake.view, {}, {});
    let nestedAccepted;
    const options = {
        ...readyOptions(events),
        getWebviewOptions() {
            nestedAccepted = provider.failBootstrap(1);
            return readyWebviewOptions;
        },
    };

    assert.equal(provider.completeBootstrap(1, options), true);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(nestedAccepted, false);
    assert.deepEqual(fake.assignedOptions, [
        bootWebviewOptions,
        readyWebviewOptions,
    ]);
    assert.equal(fake.view.webview.html, '<main>ready dashboard</main>');
    assert.equal(provider.failBootstrap(1), false);
});
