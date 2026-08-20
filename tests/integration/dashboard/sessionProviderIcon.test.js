'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

const root = path.resolve(__dirname, '../../..');
const generatedStyles = fs.readFileSync(path.join(root, 'media/styles.css'), 'utf8');

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

const content = loadWebviewContent();
const icons = require('../../../out/webviewIcons');

const brandIcons = {
    codex: icons.openAiLogo,
    kimi: icons.kimiLogo,
    claude: icons.claudeLogo,
};

function rowHtml(html, sessionId) {
    const start = html.search(new RegExp(
        `<div class="codex-session-row[^"]*"[^>]*data-session-id="${sessionId}"`
    ));
    assert.notEqual(start, -1, `AI-SESSION-PROVIDER-ICON-001 missing row for ${sessionId}`);
    const rest = html.slice(start + 1);
    const next = rest.search(/<div class="codex-session-row/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

function iconBadgeHtml(html, sessionId) {
    const match = rowHtml(html, sessionId).match(/<span class="codex-session-icon">([\s\S]*?)<\/span>/);
    assert.ok(match, `AI-SESSION-PROVIDER-ICON-001 missing icon badge for ${sessionId}`);
    return match[1];
}

test('AI-SESSION-PROVIDER-ICON-001 renders native brand icons on active and history session rows', () => {
    const surface = {
        id: 'provider-icons',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'sessions',
        selectedAiSessionProviders: ['codex', 'kimi', 'claude'],
        codexSessions: [{ id: 'codex-history', name: 'Codex History' }],
        kimiSessions: [{ id: 'kimi-history', name: 'Kimi History' }],
        claudeSessions: [{ id: 'claude-history', name: 'Claude History' }],
        activeAiSessions: [
            {
                key: 'codex:active', provider: 'codex', sessionId: 'codex-active', name: 'Codex Active',
                executionState: 'running', backend: 'vscode', attached: true,
            },
            {
                key: 'kimi:active', provider: 'kimi', sessionId: 'kimi-active', name: 'Kimi Active',
                executionState: 'stopped', backend: 'vscode', attached: false,
            },
            {
                key: 'claude:active', provider: 'claude', sessionId: 'claude-active', name: 'Claude Active',
                executionState: 'stopped', backend: 'vscode', attached: false,
            },
        ],
    };
    const html = content.getAiSessionsDiv(surface, {});

    assert.notEqual(brandIcons.codex, brandIcons.kimi, 'brand icons must be distinct');
    assert.notEqual(brandIcons.codex, brandIcons.claude, 'brand icons must be distinct');
    assert.notEqual(brandIcons.kimi, brandIcons.claude, 'brand icons must be distinct');
    for (const icon of Object.values(brandIcons)) {
        assert.notEqual(icon, icons.terminalLine, 'brand icon must not be the terminal glyph');
    }

    for (const [provider, sessions] of Object.entries({
        codex: ['codex-active', 'codex-history'],
        kimi: ['kimi-active', 'kimi-history'],
        claude: ['claude-active', 'claude-history'],
    })) {
        for (const sessionId of sessions) {
            const badge = iconBadgeHtml(html, sessionId);
            assert.ok(badge.includes(brandIcons[provider]),
                `AI-SESSION-PROVIDER-ICON-001 ${sessionId} must render the ${provider} brand icon`);
            for (const [otherProvider, otherIcon] of Object.entries(brandIcons)) {
                if (otherProvider !== provider) {
                    assert.ok(!badge.includes(otherIcon),
                        `AI-SESSION-PROVIDER-ICON-001 ${sessionId} must not render the ${otherProvider} brand icon`);
                }
            }
            assert.ok(!badge.includes(icons.terminalLine),
                `AI-SESSION-PROVIDER-ICON-001 ${sessionId} must not render the terminal glyph`);
        }
    }
});

test('AI-SESSION-PROVIDER-ICON-001 keeps native brand colors on the session icon badge', () => {
    assert.match(generatedStyles,
        /\.codex-session-icon\{color:var\(--vscode-foreground\);width:26px/,
        'monochrome brand marks must follow the theme foreground');
    assert.match(generatedStyles,
        /\[data-session-provider=kimi\] \.codex-session-icon\{color:var\(--vscode-foreground\)/,
        'Kimi mark must follow the theme foreground');
    assert.match(generatedStyles,
        /\[data-session-provider=claude\] \.codex-session-icon\{color:#d97757/,
        'Claude mark must use the brand orange');
    assert.match(generatedStyles,
        /\[data-session-provider=kimi\]\{--steward-ai-accent:var\(--vscode-terminal-ansiMagenta/,
        'row accent colors must stay provider-specific');
});
