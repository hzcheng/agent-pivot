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
    });
    assert.match(html, /&lt;unsafe&gt;/);
    assert.match(html, /data-telemetry-context-value>25%/);
    assert.match(html, /Context window · 25% used\s+1\.5k \/ 6\.0k tokens/);
    assert.match(html, /Weekly &lt;quota&gt; · 25% used/);
    assert.match(html, /data-telemetry-limit-value>25%/);
    assert.doesNotMatch(html, />Model</);
    assert.doesNotMatch(html, />Context</);
    assert.doesNotMatch(html, /Weekly <quota>/);
});
