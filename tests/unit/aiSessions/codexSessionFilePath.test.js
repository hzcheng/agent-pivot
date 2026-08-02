'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CodexSessionService = require('../../../out/services/codexSessionService').default;

test('CONVERSATION-TELEMETRY-001 resolveSessionFilePath locates rollout files by session id', async t => {
    // The AiSessionService contract module is type-only; load it once so
    // changed-line coverage sees the instrumented module.
    assert.doesNotThrow(() => require('../../../out/aiSessions/types'));

    const home = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-home-')
    );
    t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
    const sessionsDir = path.join(home, 'sessions', '2026', '08', '02');
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const rolloutPath = path.join(
        sessionsDir,
        `rollout-2026-08-02T00-00-00-${sessionId}.jsonl`
    );
    await fs.promises.writeFile(rolloutPath, '{}\n');

    process.env.CODEX_HOME = home;
    t.after(() => {
        delete process.env.CODEX_HOME;
    });
    const service = new CodexSessionService();
    assert.equal(service.resolveSessionFilePath(sessionId), rolloutPath);
    assert.equal(service.resolveSessionFilePath('missing-session'), null);
    assert.equal(service.resolveSessionFilePath(''), null);
});


test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 listSubagentThreads discovers depth-1 spawn threads by parent id', async t => {
    const home = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-subagent-home-')
    );
    t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
    const sessionsDir = path.join(home, 'sessions', '2026', '08', '02');
    await fs.promises.mkdir(sessionsDir, { recursive: true });

    const parentId = '11111111-1111-4111-8111-111111111111';
    const childId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nestedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const otherParentChildId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    async function writeRollout(id, payload, eventTypes = []) {
        const filePath = path.join(
            sessionsDir,
            `rollout-2026-08-02T00-00-00-${id}.jsonl`
        );
        await fs.promises.writeFile(
            filePath,
            [
                JSON.stringify({
                    timestamp: '2026-08-02T00:00:00.000Z',
                    type: 'session_meta',
                    payload,
                }),
                ...eventTypes.map(eventType => JSON.stringify({
                    timestamp: '2026-08-02T00:00:01.000Z',
                    type: 'event_msg',
                    payload: { type: eventType },
                })),
                '',
            ].join('\n')
        );
        return filePath;
    }

    await writeRollout(parentId, {
        id: parentId,
        session_id: parentId,
        timestamp: '2026-08-02T00:00:00.000Z',
    });
    const childPath = await writeRollout(childId, {
        id: childId,
        session_id: parentId,
        timestamp: '2026-08-02T00:01:00.000Z',
        source: {
            subagent: {
                thread_spawn: {
                    parent_thread_id: parentId,
                    depth: 1,
                    agent_path: '/root/implement_webview_mutation_skill',
                    agent_nickname: 'Zeno',
                    agent_role: null,
                },
            },
        },
    }, ['task_started', 'task_complete']);
    await writeRollout(nestedId, {
        id: nestedId,
        session_id: parentId,
        timestamp: '2026-08-02T00:02:00.000Z',
        source: {
            subagent: {
                thread_spawn: {
                    parent_thread_id: parentId,
                    depth: 2,
                    agent_path: '/root/nested',
                },
            },
        },
    });
    await writeRollout(otherParentChildId, {
        id: otherParentChildId,
        session_id: otherParentChildId,
        timestamp: '2026-08-02T00:03:00.000Z',
        source: {
            subagent: {
                thread_spawn: {
                    parent_thread_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    depth: 1,
                },
            },
        },
    }, ['task_started', 'token_count']);

    process.env.CODEX_HOME = home;
    t.after(() => {
        delete process.env.CODEX_HOME;
    });
    const service = new CodexSessionService();

    const threads = service.listSubagentThreads(parentId);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, childId);
    assert.equal(threads[0].filePath, childPath);
    assert.equal(threads[0].agentNickname, 'Zeno');
    assert.equal(threads[0].agentPath, '/root/implement_webview_mutation_skill');
    assert.equal(threads[0].agentRole, null);
    assert.equal(threads[0].createdAt, Date.parse('2026-08-02T00:01:00.000Z'));
    assert.ok(threads[0].fileMtimeMs > 0);
    assert.equal(threads[0].completed, true);

    assert.deepEqual(service.listSubagentThreads(''), []);
    const otherThreads = service.listSubagentThreads(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    );
    assert.deepEqual(otherThreads.map(thread => thread.id), [otherParentChildId]);
    assert.equal(otherThreads[0].completed, false);
});
