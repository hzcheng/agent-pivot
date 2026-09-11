'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
    assert.deepEqual(await store.load(target), { revision: 4, comments: [] },
        'an empty snapshot retains its revision so another window cannot resurrect deleted comments');
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

test('MARKDOWN-DOCUMENT-COMMENTS-PERSISTENCE-001 rejects a stale concurrent snapshot instead of losing comments', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-document-comments-cas-');
    const first = new MarkdownDocumentCommentFileStore(root);
    const second = new MarkdownDocumentCommentFileStore(root);
    await first.save(target, snapshot());
    await assert.rejects(() => second.save(target, {
        revision: 3,
        comments: [{ ...snapshot().comments[0], id: 'comment-b' }],
    }), /changed in another window/);
    assert.deepEqual(await first.load(target), snapshot());
});

test('MARKDOWN-DOCUMENT-COMMENTS-PERSISTENCE-001 recovers a lock abandoned by a reloaded extension host', async t => {
    const root = makeTempDirectory(t, 'agent-pivot-document-comments-abandoned-lock-');
    const directory = path.join(root, 'markdown-document-comments', 'v1');
    await fs.promises.mkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(JSON.stringify([
        target.projectId, target.workspaceRootId, target.relativePath,
    ])).digest('hex');
    const lockPath = path.join(directory, `${digest}.json.lock`);
    await fs.promises.writeFile(lockPath, '', 'utf8');
    const abandonedAt = new Date(Date.now() - 3_000);
    await fs.promises.utimes(lockPath, abandonedAt, abandonedAt);

    const store = new MarkdownDocumentCommentFileStore(root);
    await store.save(target, snapshot());

    assert.deepEqual(await store.load(target), snapshot(),
        'Reload must not leave comments unsavable behind a lock owned by the dead Host');
});
