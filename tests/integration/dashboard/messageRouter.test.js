'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDashboardMessageRouter } = require('../../../out/dashboard/messageRouter');

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 routes a valid generic message once and ignores non-object or typeless messages', async () => {
    const calls = [];
    const router = createDashboardMessageRouter({
        handlers: {
            'request-projects-panel': message => calls.push(message.requestId),
        },
    });

    await router(null);
    await router({});
    await router({ type: 'request-projects-panel', requestId: 7 });

    assert.deepEqual(calls, [7]);
});

test('WEBVIEW-AI-DASHBOARD-001 SESSION-AI-PROMPT-TERMINAL-INSERTION-001 routes AI panel loads, Prompt commands, and terminal inserts once', async () => {
    const calls = [];
    const router = createDashboardMessageRouter({
        handlers: {
            'request-ai-panel': message => calls.push(['panel', message.requestId]),
            'prompt-command': message => calls.push(['command', message.requestId]),
            'prompt-insert-terminal': message => calls.push(['insert', message.requestId]),
        },
    });

    await router({
        type: 'request-ai-panel',
        version: 1,
        requestId: 'ai-load-1',
        target: 'global-prompt-library',
    });
    await router({
        type: 'prompt-command',
        version: 1,
        requestId: 'prompt-command-1',
        target: 'global-prompt-library',
        expectedRevision: 0,
        operation: 'create',
        payload: { name: 'Review', text: 'Review this.' },
    });
    await router({
        type: 'prompt-insert-terminal',
        version: 1,
        requestId: 'prompt-insert-1',
        target: 'global-prompt-library',
        promptId: 'prompt-a',
    });

    assert.deepEqual(calls, [
        ['panel', 'ai-load-1'],
        ['command', 'prompt-command-1'],
        ['insert', 'prompt-insert-1'],
    ]);
});
