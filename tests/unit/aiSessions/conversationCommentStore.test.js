'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ConversationCommentFileStore,
} = require('../../../out/aiSessions/conversation/commentStore');

function target(sessionId = 'session-a') {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
    };
}

function snapshot() {
    return {
        revision: 4,
        comments: [{
            id: 'comment-a',
            messageId: 'message-a',
            interactionId: 'interaction-a',
            role: 'assistant',
            quote: 'Original answer',
            prefix: '',
            suffix: '',
            comment: 'Please clarify this.',
            status: 'open',
        }, {
            id: 'comment-session',
            scope: 'session',
            messageId: '',
            interactionId: '',
            role: 'user',
            quote: '',
            prefix: '',
            suffix: '',
            comment: 'Remember this Session note.',
            status: 'open',
        }],
    };
}

test('CONVERSATION-COMMENTS-PERSISTENCE-001 stores isolated, validated snapshots and removes empty sessions', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-comments-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationCommentFileStore(
        root,
        () => Date.parse('2026-07-31T00:00:00.000Z')
    );

    await store.save(target(), snapshot());
    const restored = await new ConversationCommentFileStore(root).load(
        target()
    );
    assert.deepEqual(restored, snapshot());
    restored.comments[0].comment = 'mutated by caller';
    assert.deepEqual(await store.load(target()), snapshot());
    assert.deepEqual(
        await store.load(target('different-session')),
        { revision: 0, comments: [] }
    );

    await store.save(target(), { revision: 5, comments: [] });
    assert.deepEqual(
        await store.load(target()),
        { revision: 0, comments: [] }
    );
    const directory = path.join(root, 'conversation-comments', 'v1');
    assert.deepEqual(await fs.promises.readdir(directory), []);
});

test('CONVERSATION-COMMENTS-PERSISTENCE-001 normalizes legacy sent and resolved statuses to done on load', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-comments-legacy-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationCommentFileStore(root);
    await store.save(target(), snapshot());
    const directory = path.join(root, 'conversation-comments', 'v1');
    const [fileName] = await fs.promises.readdir(directory);
    const filePath = path.join(directory, fileName);
    const persisted = JSON.parse(
        await fs.promises.readFile(filePath, 'utf8')
    );
    persisted.comments[0].status = 'sent';
    persisted.comments[1].status = 'resolved';
    await fs.promises.writeFile(filePath, JSON.stringify(persisted), 'utf8');

    const restored = await store.load(target());
    assert.equal(restored.revision, 4);
    assert.deepEqual(
        restored.comments.map(comment => comment.status),
        ['done', 'done']
    );
    assert.equal(restored.comments[0].createdAt, undefined);
    assert.equal(restored.comments[0].sentAt, undefined);
    assert.equal(restored.comments[1].createdAt, undefined);
    assert.equal(restored.comments[1].sentAt, undefined);
});

test('CONVERSATION-COMMENTS-PERSISTENCE-001 ignores malformed private snapshots without blocking Conversation', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-comments-corrupt-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationCommentFileStore(root);
    await store.save(target(), snapshot());
    const directory = path.join(root, 'conversation-comments', 'v1');
    const [fileName] = await fs.promises.readdir(directory);
    await fs.promises.writeFile(
        path.join(directory, fileName),
        '{"version":1,"comments":"not-an-array"}',
        'utf8'
    );

    assert.deepEqual(
        await store.load(target()),
        { revision: 0, comments: [] }
    );
});
