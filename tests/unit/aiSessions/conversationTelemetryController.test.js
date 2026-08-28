'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadController() {
    const modulePath = '../../../out/aiSessions/conversation/conversationTelemetryController';
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve(modulePath)];
        return require(modulePath);
    } finally {
        Module._load = previousLoad;
    }
}

const {
    ConversationTelemetryController,
    renderConversationTelemetry,
} = loadController();

function target(sessionId = 'session-telemetry') {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        interactionId: 'input-1',
        expectedRevision: 'r1',
        displayName: 'Telemetry',
        duplicateDisplayName: false,
    };
}

test('CONVERSATION-TELEMETRY-CONTROLLER-001 publishes only current correlated reads', async () => {
    const posted = [];
    const published = [];
    const activeTarget = target();
    let resolveRead;
    let generation = 2;
    let requestId = 7;
    const controller = new ConversationTelemetryController({
        readTelemetry: () => new Promise(resolve => {
            resolveRead = resolve;
        }),
        getPanel: () => ({
            webview: {
                postMessage: async message => {
                    posted.push(message);
                    return true;
                },
            },
        }),
        getTarget: () => activeTarget,
        getSubscriptionGeneration: () => generation,
        getCurrentRequestId: () => requestId,
        isSuspended: () => false,
        rebuildLatestDocument() {},
        onDidPublish: (publishedTarget, telemetry) => {
            published.push({ publishedTarget, telemetry });
        },
    });
    const refresh = controller.refresh(activeTarget, generation);
    requestId = 8;
    resolveRead({
        provider: 'codex',
        sessionId: activeTarget.sessionId,
        model: 'gpt-current',
        context: { usedTokens: 1200, maxTokens: 8000 },
        rateLimits: [],
    });
    await refresh;
    assert.equal(controller.snapshot.model, 'gpt-current');
    assert.deepEqual(posted, [{
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 8,
        subscriptionGeneration: 2,
        telemetry: controller.snapshot,
    }]);
    assert.deepEqual(published, [{
        publishedTarget: activeTarget,
        telemetry: controller.snapshot,
    }], 'consumers receive the resolved telemetry worktree with the refresh');

    generation = 3;
    controller.reset();
    assert.equal(controller.snapshot, undefined);
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 ignores stale reads and rebuilds only after a current delivery failure', async () => {
    let activeTarget = target();
    let rebuilds = 0;
    const controller = new ConversationTelemetryController({
        readTelemetry: async (_provider, sessionId) => ({
            provider: 'codex',
            sessionId,
            rateLimits: [],
        }),
        getPanel: () => ({
            webview: { postMessage: async () => false },
        }),
        getTarget: () => activeTarget,
        getSubscriptionGeneration: () => 4,
        getCurrentRequestId: () => 11,
        isSuspended: () => false,
        rebuildLatestDocument: () => {
            rebuilds += 1;
        },
    });
    const staleTarget = activeTarget;
    activeTarget = target('new-session');
    await controller.refresh(staleTarget, 4);
    assert.equal(rebuilds, 0);
    assert.equal(controller.snapshot, undefined);

    await controller.refresh(activeTarget, 4);
    assert.equal(rebuilds, 1);
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 schedules the next sample after the current read completes', async () => {
    const activeTarget = target();
    const timers = new Map();
    let nextTimer = 1;
    let resolveRead;
    const controller = new ConversationTelemetryController({
        readTelemetry: () => new Promise(resolve => {
            resolveRead = resolve;
        }),
        getPanel: () => ({
            visible: true,
            webview: { postMessage: async () => true },
        }),
        getTarget: () => activeTarget,
        getSubscriptionGeneration: () => 2,
        getCurrentRequestId: () => 7,
        isSuspended: () => false,
        rebuildLatestDocument() {},
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
    });

    const refresh = controller.refresh(activeTarget, 2);
    controller.activate(activeTarget, 2);
    assert.equal(
        timers.size,
        0,
        'an in-flight provider read must finish before its cache interval starts'
    );

    resolveRead({
        provider: 'codex',
        sessionId: activeTarget.sessionId,
        rateLimits: [],
    });
    await refresh;
    assert.equal(timers.size, 1);
    assert.equal(Array.from(timers.values())[0].delayMs, 5_000);
    controller.pause();
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 renders escaped model and quota markup for initial documents', () => {
    const html = renderConversationTelemetry({
        provider: 'codex',
        sessionId: 'session-telemetry',
        model: '<unsafe>',
        context: { usedTokens: 1500, maxTokens: 6000 },
        rateLimits: [{
            id: 'weekly',
            label: 'Weekly <quota>',
            usedPercent: 25,
        }],
    }, 'codex');
    assert.match(html, /&lt;unsafe&gt;/);
    assert.match(html, /data-telemetry-context-value>25%/);
    assert.match(html, /Context window · 25% used\s+1\.5k \/ 6\.0k tokens/);
    assert.match(html, /Weekly &lt;quota&gt; · 25% used/);
    assert.match(html, /data-telemetry-limit-value>25%/);
    assert.doesNotMatch(html, />Model</);
    assert.doesNotMatch(html, />Context</);
    assert.doesNotMatch(html, /Weekly <quota>/);
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 leads the telemetry bar with a provider icon pill', () => {
    const html = renderConversationTelemetry(undefined, 'kimi');
    assert.match(html, /data-telemetry-provider/);
    assert.match(html, /data-provider="kimi"/);
    assert.match(html, /Provider · Kimi/);
    assert.match(html, /data-provider-icon="codex"/);
    assert.match(html, /data-provider-icon="kimi"/);
    assert.match(html, /data-provider-icon="claude"/);
    // The pill reuses the dashboard Session card brand logos.
    assert.match(html, /M22\.2819 9\.8211/);
    assert.match(html, /M21\.765\.351/);
    assert.match(html, /m4\.7144 15\.9555/);
    assert.ok(
        html.indexOf('data-telemetry-provider')
            < html.indexOf('data-telemetry-model'),
        'provider pill must precede the model chip'
    );
    const claude = renderConversationTelemetry(undefined, 'claude');
    assert.match(claude, /data-provider="claude"/);
    assert.match(claude, /Provider · Claude/);
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 renders the comments pill with dual session · workspace open counts', () => {
    const html = renderConversationTelemetry(undefined, 'kimi');
    assert.match(html, /data-telemetry-comments-value>0 · 0</);
    assert.match(
        html,
        /0 open session comments · 0 open workspace notes — click to review/
    );
});


test('CONVERSATION-SESSION-STATUS-002 renders the viewed session state on the provider pill', () => {
    const attention = renderConversationTelemetry(undefined, 'codex', 'attention');
    assert.match(attention, /data-session-state="attention"/);
    assert.match(attention, /role="button"/,
        'attention state is exposed as an actionable button');
    assert.match(
        attention,
        /Provider · Codex · Needs attention — click to clear/
    );

    const running = renderConversationTelemetry(undefined, 'kimi', 'running');
    assert.match(running, /data-session-state="running"/);
    assert.doesNotMatch(running, /role="button"/,
        'inert states are not buttons');
    assert.match(running, /Provider · Kimi · Running/);

    const idle = renderConversationTelemetry(undefined, 'claude', 'idle');
    assert.match(idle, /data-session-state="idle"/);
    assert.match(idle, /Provider · Claude · Idle/);

    const plain = renderConversationTelemetry(undefined, 'kimi');
    assert.doesNotMatch(plain, /data-session-state/);
    assert.match(plain, /Provider · Kimi/);
});
