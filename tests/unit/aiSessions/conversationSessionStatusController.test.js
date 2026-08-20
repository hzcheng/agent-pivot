'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ConversationSessionStatusController,
    formatConversationSessionStatusLabel,
    sanitizeConversationSessionStatus,
} = require('../../../out/aiSessions/conversation/sessionStatusController');

function createHarness(options = {}) {
    const posted = [];
    const state = {
        generation: options.generation ?? 2,
        requestId: options.requestId ?? 7,
        suspended: false,
        rebuilds: 0,
        panel: {
            webview: {
                postMessage: async message => {
                    posted.push(message);
                    if (options.onPostMessage) {
                        options.onPostMessage(state);
                    }
                    return options.delivered ?? true;
                },
            },
        },
    };
    const controller = new ConversationSessionStatusController({
        readStatus: options.readStatus,
        getPanel: () => options.noPanel ? undefined : state.panel,
        getSubscriptionGeneration: () => state.generation,
        getCurrentRequestId: () => state.requestId,
        isSuspended: () => state.suspended,
        rebuildLatestDocument: () => {
            state.rebuilds += 1;
        },
    });
    return { controller, posted, state };
}

test('CONVERSATION-SESSION-STATUS-001 publishes only changed correlated statuses', async () => {
    let status = { runningSessions: 2, attentionSessions: 1, runningSessionsLocal: 1, attentionSessionsLocal: 1, idleSessionsLocal: 4 };
    const { controller, posted } = createHarness({
        readStatus: () => status,
    });

    await controller.publish();
    assert.deepEqual(posted, [{
        type: 'conversation-viewer-session-status',
        version: 1,
        requestId: 7,
        subscriptionGeneration: 2,
        status: { runningSessions: 2, attentionSessions: 1, runningSessionsLocal: 1, attentionSessionsLocal: 1, idleSessionsLocal: 4 },
    }]);

    await controller.publish();
    assert.equal(posted.length, 1, 'unchanged status must not be reposted');

    status = { runningSessions: 3, attentionSessions: 0, runningSessionsLocal: 0, attentionSessionsLocal: 0, idleSessionsLocal: 4 };
    await controller.publish();
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1].status, {
        runningSessions: 3,
        attentionSessions: 0,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 4,
    });

    status = { ...status, idleSessionsLocal: 5 };
    await controller.publish();
    assert.equal(posted.length, 3,
        'an idle-only change must still republish');
    assert.deepEqual(posted[2].status, {
        runningSessions: 3,
        attentionSessions: 0,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 5,
    });
});

test('CONVERSATION-SESSION-STATUS-001 retries after delivery failure and rebuilds only when current', async () => {
    const status = { runningSessions: 1, attentionSessions: 1, runningSessionsLocal: 1, attentionSessionsLocal: 0 };
    const current = createHarness({
        readStatus: () => status,
        delivered: false,
    });
    await current.controller.publish();
    assert.equal(current.state.rebuilds, 1);
    await current.controller.publish();
    assert.equal(current.posted.length, 2,
        'a failed delivery must not be deduplicated away');
    assert.equal(current.state.rebuilds, 2);

    const stale = createHarness({
        readStatus: () => status,
        delivered: false,
        onPostMessage: harnessState => {
            harnessState.generation = 99;
        },
    });
    await stale.controller.publish();
    assert.equal(stale.state.rebuilds, 0,
        'a superseded generation must not trigger a rebuild');
});

test('CONVERSATION-SESSION-STATUS-001 skips publishing without a panel, reader, or while suspended', async () => {
    const status = { runningSessions: 1, attentionSessions: 0, runningSessionsLocal: 1, attentionSessionsLocal: 0 };
    const noPanel = createHarness({ readStatus: () => status, noPanel: true });
    await noPanel.controller.publish();
    assert.equal(noPanel.posted.length, 0);

    const noReader = createHarness({ readStatus: undefined });
    await noReader.controller.publish();
    assert.equal(noReader.posted.length, 0);
    assert.equal(noReader.controller.snapshot, undefined);

    const suspended = createHarness({ readStatus: () => status });
    suspended.state.suspended = true;
    await suspended.controller.publish();
    assert.equal(suspended.posted.length, 0);
});

test('CONVERSATION-SESSION-STATUS-001 republishes after target transitions even when unchanged', async () => {
    const status = { runningSessions: 1, attentionSessions: 1, runningSessionsLocal: 1, attentionSessionsLocal: 0, idleSessionsLocal: 0 };
    const { controller, posted } = createHarness({
        readStatus: () => status,
    });
    await controller.publish();
    await controller.publish();
    assert.equal(posted.length, 1, 'unchanged status must not be reposted');

    await controller.republish();
    assert.equal(posted.length, 2,
        'a transition republish must bypass the delivery dedup');
    assert.deepEqual(posted[1].status, status);
});

test('CONVERSATION-SESSION-STATUS-001 does not rebuild when the panel changed during a failed delivery', async () => {
    const status = { runningSessions: 1, attentionSessions: 1, runningSessionsLocal: 1, attentionSessionsLocal: 0 };
    const harness = createHarness({
        readStatus: () => status,
        delivered: false,
        onPostMessage: harnessState => {
            harnessState.panel = {
                webview: { postMessage: async () => true },
            };
        },
    });
    await harness.controller.publish();
    assert.equal(harness.state.rebuilds, 0,
        'a stale panel must not trigger a rebuild');
});

test('CONVERSATION-SESSION-STATUS-001 sanitizes counts and formats labels', () => {
    assert.deepEqual(sanitizeConversationSessionStatus(undefined), {
        runningSessions: 0,
        attentionSessions: 0,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    });
    assert.deepEqual(sanitizeConversationSessionStatus({
        runningSessions: 1.9,
        attentionSessions: -2,
    }), {
        runningSessions: 1,
        attentionSessions: 0,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    });
    assert.deepEqual(sanitizeConversationSessionStatus({
        runningSessions: 2,
        attentionSessions: 3,
        runningSessionsLocal: 1.9,
        attentionSessionsLocal: 1,
        idleSessionsLocal: 6.8,
    }), {
        runningSessions: 2,
        attentionSessions: 3,
        runningSessionsLocal: 1,
        attentionSessionsLocal: 1,
        idleSessionsLocal: 6,
    });
    assert.deepEqual(sanitizeConversationSessionStatus({
        runningSessions: 2,
        attentionSessions: 3,
        runningSessionsLocal: 5,
        attentionSessionsLocal: 4,
    }), {
        runningSessions: 2,
        attentionSessions: 3,
        runningSessionsLocal: 2,
        attentionSessionsLocal: 3,
        idleSessionsLocal: 0,
    }, 'local counts clamp to the total — a window can never exceed it');
    assert.deepEqual(sanitizeConversationSessionStatus({
        runningSessions: Number.NaN,
        attentionSessions: Number.POSITIVE_INFINITY,
        idleSessionsLocal: Number.NaN,
    }), {
        runningSessions: 0,
        attentionSessions: 0,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    });
    assert.deepEqual(sanitizeConversationSessionStatus({
        runningSessions: 100001,
        attentionSessions: 250000.8,
        idleSessionsLocal: 150000,
    }), {
        runningSessions: 100000,
        attentionSessions: 100000,
        runningSessionsLocal: 0,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 100000,
    },
    'counts must clamp to the Webview validator bound');

    const throwing = createHarness({
        readStatus: () => {
            throw new Error('unavailable');
        },
    });
    assert.equal(throwing.controller.snapshot, undefined);

    const fractional = createHarness({
        readStatus: () => ({
            runningSessions: 2.7,
            attentionSessions: -1,
            runningSessionsLocal: 1.2,
            attentionSessionsLocal: 0,
        }),
    });
    assert.deepEqual(fractional.controller.snapshot, {
        runningSessions: 2,
        attentionSessions: 0,
        runningSessionsLocal: 1,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    });

    assert.equal(formatConversationSessionStatusLabel('running', 0),
        'No AI sessions running in this window');
    assert.equal(formatConversationSessionStatusLabel('running', 3),
        '3 running in this window · click to switch to the next');
    assert.equal(formatConversationSessionStatusLabel('attention', 0),
        'No AI sessions need attention in this window');
    assert.equal(formatConversationSessionStatusLabel('attention', 2),
        '2 need attention in this window · click to switch to the next');
    assert.equal(formatConversationSessionStatusLabel('idle', 0),
        'No idle AI sessions in this window');
    assert.equal(formatConversationSessionStatusLabel('idle', 5),
        '5 idle in this window · click to switch to the next');
    assert.equal(formatConversationSessionStatusLabel('idle', 5.9),
        '5 idle in this window · click to switch to the next',
        'labels sanitize fractional counts');
});
