'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationCommandRunner,
    resolveConversationCommandLocation,
} = require('../../../out/aiSessions/conversation/commandRunner');

function terminal({ failSend = false } = {}) {
    return {
        sent: [],
        shown: 0,
        sendText(command, addNewLine) {
            if (failSend) throw new Error('send failed');
            this.sent.push({ command, addNewLine });
        },
        show() {
            this.shown += 1;
        },
    };
}

test('CONVERSATION-RUN-COMMAND-001 reuses a worktree runner, isolates keys, and recreates closed runners', () => {
    const created = [];
    const runner = new ConversationCommandRunner(cwd => {
        const createdTerminal = terminal();
        created.push({ cwd, terminal: createdTerminal });
        return createdTerminal;
    });
    const first = runner.run({ key: '/worktree-a', cwd: '/worktree-a', command: 'pwd' });
    const reused = runner.run({ key: '/worktree-a', cwd: '/worktree-a', command: 'git status' });
    const other = runner.run({ key: '/worktree-b', cwd: '/worktree-b', command: 'pwd' });

    assert.equal(reused, first);
    assert.notEqual(other, first);
    assert.deepEqual(created.map(entry => entry.cwd), ['/worktree-a', '/worktree-b']);
    assert.deepEqual(first.sent, [
        { command: 'pwd', addNewLine: true },
        { command: 'git status', addNewLine: true },
    ]);

    runner.forget(first);
    const replacement = runner.run({ key: '/worktree-a', cwd: '/worktree-a', command: 'git log -1' });
    assert.notEqual(replacement, first);
    assert.deepEqual(created.map(entry => entry.cwd), [
        '/worktree-a', '/worktree-b', '/worktree-a',
    ]);
});

test('CONVERSATION-RUN-COMMAND-001 forgets a runner whose send fails', () => {
    const failed = terminal({ failSend: true });
    const replacement = terminal();
    let calls = 0;
    const runner = new ConversationCommandRunner(() => {
        calls += 1;
        return calls === 1 ? failed : replacement;
    });

    assert.throws(
        () => runner.run({ key: '/worktree-a', cwd: '/worktree-a', command: 'bad' }),
        /send failed/
    );
    assert.equal(
        runner.run({ key: '/worktree-a', cwd: '/worktree-a', command: 'retry' }),
        replacement
    );
    assert.equal(calls, 2);
    assert.deepEqual(replacement.sent, [{ command: 'retry', addNewLine: true }]);
});

test('CONVERSATION-RUN-COMMAND-001 prefers the current target and rejects a conflicting runtime cwd', () => {
    assert.deepEqual(resolveConversationCommandLocation({
        workspaceScopeIdentity: 'workspace-a',
        activeWorktreePath: '/worktree-a',
        activeConflict: false,
        historyWorktreePath: undefined,
        historyCwd: undefined,
        historyWorkDir: undefined,
        runtime: {
            state: 'conflict',
            workspaceScopeIdentity: 'workspace-a',
            worktreePath: '/wrong-worktree',
            cwd: '/wrong-worktree',
        },
    }), { key: '/worktree-a', cwd: '/worktree-a' });
    assert.equal(resolveConversationCommandLocation({
        workspaceScopeIdentity: 'workspace-a',
        activeWorktreePath: undefined,
        activeConflict: false,
        historyWorktreePath: undefined,
        historyCwd: undefined,
        historyWorkDir: undefined,
        runtime: {
            state: 'conflict',
            workspaceScopeIdentity: 'workspace-a',
            worktreePath: '/wrong-worktree',
            cwd: '/wrong-worktree',
        },
    }), undefined);
    assert.deepEqual(resolveConversationCommandLocation({
        workspaceScopeIdentity: 'workspace-a',
        activeWorktreePath: undefined,
        activeConflict: false,
        historyWorktreePath: undefined,
        historyCwd: undefined,
        historyWorkDir: undefined,
        runtime: {
            state: 'active',
            workspaceScopeIdentity: 'workspace-a',
            worktreePath: '/worktree-a',
            cwd: '/worktree-a/subdirectory',
        },
    }), { key: '/worktree-a', cwd: '/worktree-a' });
    assert.deepEqual(resolveConversationCommandLocation({
        workspaceScopeIdentity: 'workspace-a',
        activeWorktreePath: '/ambiguous-worktree',
        activeConflict: true,
        historyWorktreePath: '/history-worktree',
        historyCwd: undefined,
        historyWorkDir: undefined,
        runtime: {
            state: 'conflict',
            workspaceScopeIdentity: 'workspace-a',
            worktreePath: '/ambiguous-worktree',
            cwd: '/ambiguous-worktree',
        },
    }), { key: '/history-worktree', cwd: '/history-worktree' });
});
