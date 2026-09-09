'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    MarkdownSuggestionStateFileStore,
} = require('../../../out/aiSessions/conversation/markdownSuggestionState');

const target = Object.freeze({
    projectId: 'project-a',
    workspaceRootId: 'root-a',
    relativePath: 'docs/architecture-plan.md',
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 persists bounded suggestion decisions by document identity', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-markdown-suggestions-');
    const snapshot = {
        revision: 3,
        suggestions: [{
            provider: 'codex',
            sessionId: 'session-a',
            messageId: 'assistant-message-a',
            disposition: 'outdated',
            updatedAt: 1234,
        }],
    };
    const store = new MarkdownSuggestionStateFileStore(root);
    await store.save(target, snapshot);
    assert.deepEqual(await new MarkdownSuggestionStateFileStore(root).load(target), snapshot);
    assert.deepEqual(await store.load({ ...target, relativePath: 'docs/other.md' }), {
        revision: 0,
        suggestions: [],
    });
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 rejects a stale suggestion decision snapshot from another window', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-markdown-suggestions-cas-');
    const first = new MarkdownSuggestionStateFileStore(root);
    const second = new MarkdownSuggestionStateFileStore(root);
    const snapshot = {
        revision: 1,
        suggestions: [{
            provider: 'codex', sessionId: 'session-a', messageId: 'assistant-message-a',
            disposition: 'dismissed', updatedAt: 1234,
        }],
    };
    await first.save(target, snapshot);
    await assert.rejects(() => second.save(target, {
        revision: 1, suggestions: [],
    }), /changed in another window/);
    assert.deepEqual(await first.load(target), snapshot);
});
