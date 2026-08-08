'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    ProjectCommentFileStore,
} = require('../../../out/aiSessions/conversation/projectCommentStore');

function snapshot() {
    return {
        revision: 3,
        comments: [{
            id: 'note-a',
            text: 'Fix the telemetry overflow.',
            tags: ['bug'],
            status: 'open',
            createdAt: 1723000000000,
            source: {
                provider: 'codex',
                sessionId: 'session-a',
                quote: 'overflowed horizontally at 400px',
            },
            dispatches: [{
                provider: 'kimi',
                sessionId: 'session-b',
                at: 1723000001000,
            }],
        }, {
            id: 'note-b',
            text: 'Spawn a session from a note.',
            tags: [],
            status: 'done',
            createdAt: 1723000000000,
            doneAt: 1723000002000,
            dispatches: [],
        }],
    };
}

test('PROJECT-COMMENTS-PERSISTENCE-001 stores isolated, validated snapshots per project and removes empty projects', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-project-comments-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ProjectCommentFileStore(
        root,
        () => Date.parse('2026-08-08T00:00:00.000Z')
    );

    await store.save({ projectId: 'project-a' }, snapshot());
    const restored = await new ProjectCommentFileStore(root).load(
        { projectId: 'project-a' }
    );
    assert.deepEqual(restored, snapshot());
    restored.comments[0].text = 'mutated by caller';
    restored.comments[0].dispatches[0].sessionId = 'mutated';
    assert.deepEqual(await store.load({ projectId: 'project-a' }), snapshot());
    assert.deepEqual(
        await store.load({ projectId: 'project-b' }),
        { revision: 0, comments: [] }
    );

    await store.save({ projectId: 'project-a' }, { revision: 4, comments: [] });
    assert.deepEqual(
        await store.load({ projectId: 'project-a' }),
        { revision: 0, comments: [] }
    );
    const directory = path.join(root, 'project-comments', 'v1');
    assert.deepEqual(await fs.promises.readdir(directory), []);
});

test('PROJECT-COMMENTS-PERSISTENCE-001 ignores malformed snapshots without blocking the viewer', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-project-comments-corrupt-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ProjectCommentFileStore(root);
    await store.save({ projectId: 'project-a' }, snapshot());
    const directory = path.join(root, 'project-comments', 'v1');
    const [fileName] = await fs.promises.readdir(directory);
    const filePath = path.join(directory, fileName);

    await fs.promises.writeFile(
        filePath,
        '{"version":1,"comments":"not-an-array"}',
        'utf8'
    );
    assert.deepEqual(await store.load({ projectId: 'project-a' }), {
        revision: 0,
        comments: [],
    });

    // A structurally valid snapshot with an invalid note is rejected whole.
    await fs.promises.writeFile(filePath, JSON.stringify({
        version: 1,
        target: { projectId: 'project-a' },
        revision: 2,
        updatedAt: '2026-08-08T00:00:00.000Z',
        comments: [{ id: 'broken' }],
    }), 'utf8');
    assert.deepEqual(await store.load({ projectId: 'project-a' }), {
        revision: 0,
        comments: [],
    });

    // A snapshot belonging to another project never leaks across keys.
    await fs.promises.writeFile(filePath, JSON.stringify({
        version: 1,
        target: { projectId: 'project-b' },
        revision: 2,
        updatedAt: '2026-08-08T00:00:00.000Z',
        comments: snapshot().comments,
    }), 'utf8');
    assert.deepEqual(await store.load({ projectId: 'project-a' }), {
        revision: 0,
        comments: [],
    });
});

test('PROJECT-COMMENTS-PERSISTENCE-001 rejects invalid saves instead of writing them', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-project-comments-invalid-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const store = new ProjectCommentFileStore(root);

    await assert.rejects(
        () => store.save({ projectId: '' }, snapshot()),
        /Invalid project comment snapshot/
    );
    await assert.rejects(
        () => store.save({ projectId: 'project-a' }, {
            revision: -1,
            comments: [],
        }),
        /Invalid project comment snapshot/
    );
    await assert.rejects(
        () => store.save({ projectId: 'project-a' }, {
            revision: 1,
            comments: [{ id: 'broken' }],
        }),
        /invalid/
    );
    assert.equal(
        fs.existsSync(path.join(root, 'project-comments', 'v1')),
        false
    );
});
