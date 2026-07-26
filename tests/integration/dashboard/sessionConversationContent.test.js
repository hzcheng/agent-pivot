'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getAiSessionsDiv } = loadWebviewContent();

function activeSession(overrides) {
    return {
        key: 'codex:session-a',
        provider: 'codex',
        sessionId: 'session-a',
        name: 'Session A',
        executionState: 'running',
        status: 'running',
        focused: false,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
        ...overrides,
    };
}

function renderActiveSessions(activeAiSessions) {
    return getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'active',
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions,
    });
}

function rowMarkup(html, provider, sessionId) {
    const identity = `data-session-id="${sessionId}"`;
    const rows = Array.from(html.matchAll(
        /<div class="codex-session-row active-ai-session-row"[\s\S]*?(?=<div class="codex-session-row active-ai-session-row"|$)/g
    )).map(match => match[0]);
    const row = rows.find(candidate =>
        candidate.includes(`data-session-provider="${provider}"`)
        && candidate.includes(identity)
    );
    assert.ok(row, `missing ${provider}:${sessionId}`);
    return row;
}

test('ACTIVE-SESSION-CONVERSATION-EXPANSION-001 renders a closed shell only for a focused non-pending row', () => {
    const html = renderActiveSessions([
        activeSession({ focused: true }),
        activeSession({
            key: 'kimi:session-b',
            provider: 'kimi',
            sessionId: 'session-b',
            name: 'Session B',
        }),
        activeSession({
            key: 'claude:pending',
            provider: 'claude',
            sessionId: '',
            name: 'Pending',
            focused: true,
            pending: true,
            executionState: 'starting',
            createdAt: '2026-07-26T00:00:00.000Z',
        }),
    ]);
    const focused = rowMarkup(html, 'codex', 'session-a');
    const nonFocused = rowMarkup(html, 'kimi', 'session-b');
    const pendingStart = html.indexOf('data-session-provider="claude"');
    const pending = html.slice(
        html.lastIndexOf('<div class="codex-session-row active-ai-session-row"', pendingStart)
    );

    assert.match(focused, /class="ai-session-conversation-chevron"[^>]*>›<\/span>/);
    assert.match(focused, /aria-expanded="false"/);
    const controls = focused.match(/aria-controls="([^"]+)"/);
    assert.ok(controls);
    assert.match(
        focused,
        new RegExp(`<section[^>]*id="${controls[1]}"[^>]*data-ai-session-conversation-panel`)
    );
    assert.match(focused, /data-ai-session-conversation-panel[^>]*aria-label="Conversation"[^>]*hidden/);
    assert.match(focused, /data-ai-session-conversation-count>0<\/span>/);
    assert.match(focused, /class="ai-session-conversation-loading" role="status">Loading conversation…/);
    assert.match(
        focused,
        /data-ai-session-conversation-rail[^>]*data-auto-scroll-threshold="8"[^>]*role="listbox"[^>]*aria-label="User inputs"[^>]*hidden/
    );
    assert.doesNotMatch(nonFocused, /ai-session-conversation-chevron|data-ai-session-conversation-panel|aria-expanded/);
    assert.doesNotMatch(pending, /ai-session-conversation-chevron|data-ai-session-conversation-panel/);
    assert.doesNotMatch(
        pending.match(/<button[^>]*data-action="activate-ai-session"[^>]*>/)[0],
        /aria-expanded/
    );
    assert.equal((html.match(/data-ai-session-conversation-panel/g) || []).length, 1);
});
