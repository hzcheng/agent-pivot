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

test('CONVERSATION-SESSION-REBIND-001 copies bookmarks only along an explicit Session rebind', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-bookmarks-rebind-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ConversationBookmarkFileStore(root);
    const previous = target('old-root');
    const next = target('new-root');
    const source = { revision: 3, interactionIds: ['input-1', 'input-3'] };

    await store.save(previous, source);
    assert.equal(await store.copyForRebind(previous, next), 'copied');
    assert.deepEqual(await store.load(next), source);
    assert.deepEqual(await store.load(previous), source);

    const destination = { revision: 7, interactionIds: ['input-2'] };
    await store.save(target('occupied-root'), destination);
    assert.equal(
        await store.copyForRebind(previous, target('occupied-root')),
        'destination-exists'
    );
    assert.deepEqual(await store.load(target('occupied-root')), destination);

    await assert.rejects(
        store.copyForRebind(previous, { ...next, provider: 'claude' }),
        /Invalid conversation bookmark rebind/
    );

    await store.save(target('race-source-a'), {
        revision: 10,
        interactionIds: ['input-a'],
    });
    await store.save(target('race-source-b'), {
        revision: 11,
        interactionIds: ['input-b'],
    });
    const raceTarget = target('race-destination');
    const raceResults = await Promise.all([
        store.copyForRebind(target('race-source-a'), raceTarget),
        store.copyForRebind(target('race-source-b'), raceTarget),
    ]);
    assert.deepEqual(raceResults.sort(), ['copied', 'destination-exists']);
    assert.ok([10, 11].includes((await store.load(raceTarget)).revision));

    await store.save(target('corrupt-source'), {
        revision: 12,
        interactionIds: ['input-corrupt'],
    });
    const directory = path.join(root, 'conversation-bookmarks', 'v1');
    for (const fileName of await fs.promises.readdir(directory)) {
        const filePath = path.join(directory, fileName);
        const persisted = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (persisted.target?.sessionId === 'corrupt-source') {
            await fs.promises.writeFile(filePath, '{"invalid":true}', 'utf8');
        }
    }
    await assert.rejects(
        store.copyForRebind(
            target('corrupt-source'),
            target('corrupt-destination')
        ),
        /Invalid persisted conversation bookmark snapshot/
    );
});
