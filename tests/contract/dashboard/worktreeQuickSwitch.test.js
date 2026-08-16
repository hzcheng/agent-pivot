'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildWorktreeOrSessionSwitchItems,
    createWorktreeOrSessionSwitchHandler,
} = require('../../../out/dashboard/worktreeQuickSwitch');

const attentionKey = {
    repositoryKey: '/repos/app/.git',
    canonicalWorktreePath: '/managed/attention',
};
const idleKey = {
    repositoryKey: '/repos/app/.git',
    canonicalWorktreePath: '/managed/idle',
};

function workspaceTarget() {
    return {
        cardId: 'workspace-card',
        workspace: {
            navigationIdentity: 'navigation-1',
            scopeIdentity: 'scope-1',
            roots: [],
        },
        sessions: {
            activeSessions: [{
                key: 'codex:active', provider: 'codex', sessionId: 'active',
                name: 'Active task', executionState: 'running', focused: false,
                needsAttention: true, pending: false, backend: 'vscode', attached: true,
                worktreeKey: attentionKey,
            }],
            sessionsByProvider: {
                codex: [
                    { id: 'ended', name: 'Recent ended', provider: 'codex', updatedAt: '2026-08-13T10:00:00.000Z', worktreeKey: idleKey },
                    { id: 'active', name: 'Active task', provider: 'codex', updatedAt: '2026-08-12T10:00:00.000Z', worktreeKey: attentionKey },
                ],
            },
            worktrees: [
                { kind: 'ready', git: { key: idleKey, branchRef: 'refs/heads/idle', head: 'b'.repeat(40) }, activity: 'idle', sessions: [], authority: {} },
                { kind: 'ready', git: { key: attentionKey, branchRef: 'refs/heads/attention', head: 'a'.repeat(40) }, activity: 'attention', sessions: [], authority: {} },
            ],
        },
    };
}

test('WORKTREE-QUICK-SWITCH-001 freezes attention-first and recent ordering across worktrees and sessions', () => {
    const items = buildWorktreeOrSessionSwitchItems(workspaceTarget());
    assert.deepEqual(items.map(item => [item.label, item.description, item.target.kind]), [
        ['$(bell) attention', 'Worktree · Needs attention', 'worktree'],
        ['$(terminal) Active task', 'Codex · Active · Needs attention · attention', 'session'],
        ['$(comment-discussion) Recent ended', 'Codex · Recent · idle', 'session'],
        ['$(git-branch) idle', 'Worktree · Idle', 'worktree'],
    ]);
});

test('WORKTREE-QUICK-SWITCH-001 includes an active session before history discovery catches up', () => {
    const target = workspaceTarget();
    target.sessions.activeSessions.push({
        key: 'claude:live-only', provider: 'claude', sessionId: 'live-only',
        name: 'Live only', executionState: 'running', focused: false,
        needsAttention: false, pending: false, backend: 'vscode', attached: true,
        updatedAt: '2026-08-13T11:00:00.000Z', worktreeKey: idleKey,
    });

    const items = buildWorktreeOrSessionSwitchItems(target);
    assert.deepEqual(
        items.filter(item => item.target.kind === 'session').map(item => item.label),
        ['$(terminal) Active task', '$(terminal) Live only', '$(comment-discussion) Recent ended']
    );
});

test('WORKTREE-QUICK-SWITCH-001 focuses active sessions, resumes ended sessions, and reveals worktrees', async () => {
    const effects = [];
    let pickedIndex = 1;
    const handler = createWorktreeOrSessionSwitchHandler({
        getWorkspaceTarget: workspaceTarget,
        showPick: async items => items[pickedIndex],
        focusSession: async (projectId, provider, sessionId) => {
            effects.push(['focus', projectId, provider, sessionId]);
            return true;
        },
        resumeSession: async (projectId, provider, sessionId) => {
            effects.push(['resume', projectId, provider, sessionId]);
        },
        revealWorktree: async (navigationIdentity, key) => {
            effects.push(['reveal', navigationIdentity, key]);
        },
        showInformationMessage: message => effects.push(['info', message]),
        showWarningMessage: message => effects.push(['warning', message]),
    });

    await handler();
    pickedIndex = 2;
    await handler();
    pickedIndex = 0;
    await handler();
    assert.deepEqual(effects, [
        ['focus', 'workspace-card', 'codex', 'active'],
        ['resume', 'workspace-card', 'codex', 'ended'],
        ['reveal', 'navigation-1', attentionKey],
    ]);
});

test('WORKTREE-QUICK-SWITCH-001 excludes bare worktrees and keeps branchless linked worktrees addressable', () => {
    const target = workspaceTarget();
    target.sessions.sessionsByProvider.codex = [];
    target.sessions.activeSessions = [];
    target.sessions.worktrees.push({
        kind: 'ready',
        git: {
            key: {
                repositoryKey: '/repos/bare.git',
                canonicalWorktreePath: '/repos/bare.git',
            },
            isBare: true,
            head: '',
        },
        activity: 'idle', sessions: [], authority: {},
    }, {
        kind: 'ready',
        git: {
            key: {
                repositoryKey: '/repos/app/.git',
                canonicalWorktreePath: '/managed/detached-topic',
            },
            isBare: false,
            head: 'c'.repeat(40),
        },
        activity: 'active', sessions: [], authority: {},
    });

    const items = buildWorktreeOrSessionSwitchItems(target);
    assert.equal(items.some(item => item.label.includes('bare.git')), false);
    assert.ok(items.some(item => item.label === '$(git-branch) detached-topic'));
});

test('WORKTREE-QUICK-SWITCH-001 handles empty, cancelled, and stale-active picks without side effects', async () => {
    const effects = [];
    let target = null;
    let cancel = false;
    let focusResult = false;
    const handler = createWorktreeOrSessionSwitchHandler({
        getWorkspaceTarget: () => target,
        showPick: async items => cancel ? undefined : items[1],
        focusSession: async () => focusResult,
        resumeSession: async () => effects.push(['resume']),
        revealWorktree: async () => effects.push(['reveal']),
        showInformationMessage: message => effects.push(['info', message]),
        showWarningMessage: message => effects.push(['warning', message]),
    });

    await handler();
    target = workspaceTarget();
    cancel = true;
    await handler();
    cancel = false;
    await handler();
    focusResult = true;
    await handler();

    assert.deepEqual(effects, [
        ['info', 'Agent Pivot: no worktrees or AI sessions are available.'],
        ['warning', 'Agent Pivot: the selected AI session is no longer active.'],
    ]);
});
