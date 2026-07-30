'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    submitConversationPrompt,
} = require('../../../out/aiSessions/conversation/submission');

const target = Object.freeze({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
});

function workspace(executionState = 'stopped', overrides = {}) {
    return {
        sessions: {
            activeSessions: [{
                provider: 'codex',
                sessionId: 'session-a',
                executionState,
                status: 'focused',
                primaryRootId: 'root-a',
                ...overrides,
            }],
        },
    };
}

function activeRuntime(terminal) {
    return {
        state: 'active',
        backend: 'vscode',
        terminal,
    };
}

test('CONVERSATION-COMMENTS-SUBMIT-001 writes one batch to an idle attached runtime', async () => {
    const writes = [];
    let resumes = 0;
    await submitConversationPrompt({
        getWorkspaceTarget: () => workspace(),
        getRuntime: () => activeRuntime({
            sendText: (text, newline) => writes.push({ text, newline }),
        }),
        resume: async () => {
            resumes += 1;
            return { status: 'started' };
        },
    }, target, 'Batch prompt');

    assert.deepEqual(writes, [{ text: 'Batch prompt', newline: true }]);
    assert.equal(resumes, 0);
});

test('CONVERSATION-COMMENTS-SUBMIT-002 resumes a stopped runtime with the prompt in its launch', async () => {
    const resumes = [];
    await submitConversationPrompt({
        getWorkspaceTarget: () => workspace(),
        getRuntime: () => null,
        resume: async (...args) => {
            resumes.push(args);
            return { status: 'started' };
        },
    }, target, 'Resume prompt');

    assert.deepEqual(resumes, [[
        'project-a', 'codex', 'session-a', 'root-a', 'Resume prompt',
    ]]);
});

test('CONVERSATION-COMMENTS-SUBMIT-003 sends after an existing detached runtime is focused', async () => {
    const writes = [];
    let runtimeRead = 0;
    await submitConversationPrompt({
        getWorkspaceTarget: () => workspace(),
        getRuntime: () => {
            runtimeRead += 1;
            return runtimeRead === 1
                ? activeRuntime(undefined)
                : activeRuntime({
                    sendText: (text, newline) => writes.push({ text, newline }),
                });
        },
        resume: async () => ({ status: 'focused' }),
    }, target, 'Focused prompt');

    assert.deepEqual(writes, [{ text: 'Focused prompt', newline: true }]);
});

test('CONVERSATION-COMMENTS-SUBMIT-004 rejects busy and conflicting targets before dispatch', async () => {
    for (const [session, expected] of [
        [workspace('running'), 'busy'],
        [workspace('stopped', { conflict: true }), 'conflict'],
    ]) {
        let dispatched = false;
        await assert.rejects(
            submitConversationPrompt({
                getWorkspaceTarget: () => session,
                getRuntime: () => null,
                resume: async () => {
                    dispatched = true;
                    return { status: 'started' };
                },
            }, target, 'Prompt'),
            error => error.code === expected
        );
        assert.equal(dispatched, false);
    }
});
