'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    MarkdownDocumentCommentFileStore,
} = require('../../../out/aiSessions/conversation/documentCommentStore');

const target = {
    projectId: 'project-a',
    workspaceRootId: 'root-a',
    relativePath: 'docs/architecture-plan.md',
};

function snapshot() {
    return {
        revision: 3,
        comments: [{
            id: 'comment-a',
            documentVersion: 'sha256:a',
            anchor: {
                selectedText: 'The migration runs before restart.',
                prefix: 'Rollback strategy',
                suffix: 'Verify the database state.',
                headingPath: ['Operations', 'Rollback strategy'],
                rangeHint: { startLine: 42, endLine: 42 },
            },
            text: 'Explain recovery.',
            status: 'sent',
            createdAt: 1000,
            sentAt: 2000,
            conversationRef: { provider: 'codex', sessionId: 'session-a' },
        }],
    };
}

test('MARKDOWN-DOCUMENT-COMMENTS-PERSISTENCE-001 isolates snapshots by root and relative path', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-document-comments-');
    const store = new MarkdownDocumentCommentFileStore(root);
    await store.save(target, snapshot());
    assert.deepEqual(await new MarkdownDocumentCommentFileStore(root).load(target), snapshot());
    assert.deepEqual(await store.load({ ...target, workspaceRootId: 'root-b' }), {
        revision: 0, comments: [],
    });
    assert.deepEqual(await store.load({ ...target, relativePath: 'docs/other.md' }), {
        revision: 0, comments: [],
    });
    await store.save(target, { revision: 4, comments: [] });
    assert.deepEqual(await store.load(target), { revision: 0, comments: [] });
});

test('MARKDOWN-DOCUMENT-COMMENTS-PERSISTENCE-001 degrades corrupt persisted records to an empty snapshot', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-document-comments-corrupt-');
    const store = new MarkdownDocumentCommentFileStore(root);
    await store.save(target, snapshot());
    const directory = path.join(root, 'markdown-document-comments', 'v1');
    const [fileName] = await fs.promises.readdir(directory);
    await fs.promises.writeFile(path.join(directory, fileName), JSON.stringify({
        version: 1, target, revision: 1, updatedAt: new Date().toISOString(),
        comments: [{ id: 'broken' }],
    }), 'utf8');
    assert.deepEqual(await store.load(target), { revision: 0, comments: [] });
});
