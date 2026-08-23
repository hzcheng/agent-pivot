'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hydrateWorkspaceAiSessions } = require('../../../out/workspaces/sessionHydration');
const { getAiSessionsDiv } = require('../../../out/webview/webviewAiSessionContent');

// SESSION-CODEX-PROFILE-BADGE-001

const workspace = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'singleFolder',
    displayName: 'App',
    navigationUri: 'file:///work',
    environment: 'local',
    roots: [{
        id: 'root:fixture', name: 'work', uri: 'file:///work',
        hostPath: '/work', ordinal: 0,
    }],
};

function hydrate(overrides = {}) {
    return hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: {
            codex: {
                available: true,
                sessions: [
                    { id: 's-profile', name: 'Profiled', cwd: '/work', updatedAt: '2026-08-01T00:00:00Z' },
                    { id: 's-base', name: 'Base', cwd: '/work', updatedAt: '2026-07-31T00:00:00Z' },
                    { id: 's-gone', name: 'Gone', cwd: '/work', updatedAt: '2026-07-30T00:00:00Z' },
                ],
            },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(),
        aliases: {},
        profiles: {
            'codex:s-profile': { kind: 'profile', name: 'deepseek' },
            'codex:s-base': { kind: 'base' },
            'codex:s-gone': { kind: 'profile', name: 'deleted-profile' },
        },
        profileAvailability: { deepseek: true, 'deleted-profile': false },
        ...overrides,
    });
}

test('SESSION-CODEX-PROFILE-BADGE-001 history sessions carry profile metadata', () => {
    const result = hydrate();
    const byId = new Map(result.sessionsByProvider.codex.map(session => [session.id, session]));
    assert.deepEqual(
        { profile: byId.get('s-profile').profile, unavailable: byId.get('s-profile').profileUnavailable },
        { profile: 'deepseek', unavailable: undefined }
    );
    assert.equal(byId.get('s-base').profile, undefined, 'explicit base decisions render no badge');
    assert.deepEqual(
        { profile: byId.get('s-gone').profile, unavailable: byId.get('s-gone').profileUnavailable },
        { profile: 'deleted-profile', unavailable: true },
        'a deleted profile file is flagged unavailable'
    );
});

test('SESSION-CODEX-PROFILE-BADGE-001 active and pending runtimes carry profile metadata', () => {
    const result = hydrate({
        profiles: {
            'codex:s-profile': { kind: 'profile', name: 'deepseek' },
            'codex:s-base': { kind: 'base' },
            'codex:s-gone': { kind: 'profile', name: 'deleted-profile' },
        },
        pendingProfiles: { 'pending-1': { kind: 'profile', name: 'kimi 2.5' } },
        profileAvailability: { deepseek: true, 'deleted-profile': false, 'kimi 2.5': true },
        activeRuntimes: [{
            identity: {
                provider: 'codex',
                sessionId: 's-profile',
                workspaceScopeIdentity: workspace.scopeIdentity,
                workspaceNavigationIdentity: workspace.navigationIdentity,
                workspaceRootHostPaths: ['/work'],
                cwd: '/work',
            },
            backend: 'vscode',
            state: 'active',
            markerPath: '/tmp/active.done',
            runStartedAtMs: 1,
            attached: true,
        }],
        pendingRuntimes: [{
            identity: {
                provider: 'codex',
                pendingId: 'pending-1',
                workspaceScopeIdentity: workspace.scopeIdentity,
                workspaceNavigationIdentity: workspace.navigationIdentity,
                workspaceRootHostPaths: ['/work'],
                cwd: '/work',
            },
            backend: 'vscode',
            state: 'pending',
            createdAt: '2026-08-01T01:00:00Z',
            excludedSessionIds: [],
            markerPath: '/tmp/pending.done',
            attached: true,
        }],
    });
    const active = result.activeSessions.find(session => session.sessionId === 's-profile');
    assert.equal(active.profile, 'deepseek');
    assert.equal(active.profileUnavailable, undefined);
    const pending = result.activeSessions.find(session => session.pendingId === 'pending-1');
    assert.equal(pending.profile, 'kimi 2.5', 'a pending runtime shows the chosen profile immediately');
});

test('SESSION-CODEX-PROFILE-BADGE-001 rows render badges with tooltips and aria labels', () => {
    const hydrated = hydrate();
    const html = getAiSessionsDiv({
        id: 'p',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'sessions',
        codexSessions: hydrated.sessionsByProvider.codex,
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
    });
    assert.match(html, /ai-session-profile-badge[^>]*data-tooltip="Profile: deepseek"/);
    assert.match(html, /ai-session-profile-badge[^>]*aria-label="Profile: deepseek"/);
    assert.match(html, /Codex session Profiled, Profile: deepseek/);
    assert.match(html, /ai-session-primary-action[^>]*data-tooltip="[^"]*Provider: Codex\nProfile: deepseek/);
    assert.match(html, /ai-session-profile-unavailable/);
    assert.match(html, /deleted-profile · unavailable/);
    assert.doesNotMatch(html, /Base configuration \(no profile\)/, 'base decisions render no badge');

    const activeHtml = getAiSessionsDiv({
        id: 'p',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'active',
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [{
            key: 'codex:s1',
            provider: 'codex',
            sessionId: 's1',
            name: 'Active run',
            profile: 'deepseek',
            executionState: 'running',
            focused: false,
            needsAttention: false,
            pending: false,
            backend: 'vscode',
            attached: true,
        }],
    });
    assert.match(activeHtml, /ai-session-profile-badge[^>]*data-tooltip="Profile: deepseek"/);
    assert.match(activeHtml, /Codex session Active run, Profile: deepseek/);
    assert.match(activeHtml, /ai-session-primary-action[^>]*data-tooltip="[^"]*Provider: Codex\nProfile: deepseek/);
});

test('SESSION-CODEX-PROFILE-BADGE-001 profile names are HTML-escaped in badges', () => {
    const html = getAiSessionsDiv({
        id: 'p',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'sessions',
        codexSessions: [{
            id: 's-xss',
            name: 'XSS',
            provider: 'codex',
            cwd: '/work',
            profile: '<img src=x onerror=alert(1)>',
        }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
    });
    assert.ok(!html.includes('<img src=x'), 'the badge escapes profile names');
    assert.match(html, /&lt;img src=x/);
});
