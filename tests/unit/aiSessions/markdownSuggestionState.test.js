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
