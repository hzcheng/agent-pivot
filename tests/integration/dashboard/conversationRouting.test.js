'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDashboardMessageRouter } = require(
    '../../../out/dashboard/messageRouter'
);

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
