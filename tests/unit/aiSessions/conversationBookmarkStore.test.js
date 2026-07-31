'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ConversationBookmarkFileStore,
} = require('../../../out/aiSessions/conversation/bookmarkStore');

function target(sessionId = 'session-a') {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
    };
}

test('CONVERSATION-OUTLINE-BOOKMARKS-001 stores isolated bookmark order without reordering the outline', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-bookmarks-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationBookmarkFileStore(
        root,
        () => Date.parse('2026-07-31T00:00:00.000Z')
    );
    const snapshot = {
        revision: 2,
        interactionIds: ['input-3', 'input-1'],
    };

    await store.save(target(), snapshot);
    const restored = await new ConversationBookmarkFileStore(root).load(
        target()
    );
    assert.deepEqual(restored, snapshot);
    restored.interactionIds.push('caller-mutation');
    assert.deepEqual(await store.load(target()), snapshot);
    assert.deepEqual(
        await store.load(target('different-session')),
        { revision: 0, interactionIds: [] }
    );

    await store.save(target(), { revision: 3, interactionIds: [] });
    assert.deepEqual(
        await store.load(target()),
        { revision: 0, interactionIds: [] }
    );
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 rejects duplicate bookmark identities and ignores corrupt snapshots', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-bookmarks-corrupt-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationBookmarkFileStore(root);

    await assert.rejects(
        store.save(target(), {
            revision: 1,
            interactionIds: ['input-1', 'input-1'],
        }),
        /Invalid conversation bookmark snapshot/
    );
    await store.save(target(), {
        revision: 1,
        interactionIds: ['input-1'],
    });
    const directory = path.join(root, 'conversation-bookmarks', 'v1');
    const [fileName] = await fs.promises.readdir(directory);
    await fs.promises.writeFile(
        path.join(directory, fileName),
        '{"version":1,"interactionIds":"invalid"}',
        'utf8'
    );
    assert.deepEqual(
        await store.load(target()),
        { revision: 0, interactionIds: [] }
    );
});
