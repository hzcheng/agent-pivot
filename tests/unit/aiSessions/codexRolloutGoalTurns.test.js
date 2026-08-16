'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CodexRolloutGoalTurnsReader = require(
    '../../../out/aiSessions/codexRolloutGoalTurns'
).default;

function taskStarted(turnId) {
    return JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: turnId },
    });
}

function goalPrompt(objective) {
    return JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'user',
            content: [{
                type: 'input_text',
                text: '<codex_internal_context source="goal">\n'
                    + 'Continue working toward the active thread goal.\n\n'
                    + '<objective>\n' + objective + '\n</objective>\n',
            }],
        },
    });
}

function userMessage(text) {
    return JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
        },
    });
}

test('MAIN-AI-SESSION-CONVERSATION-OUTLINE goal turns reader maps continuation turns to their objective', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-goal-turns-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const reader = new CodexRolloutGoalTurnsReader();

    assert.equal(reader.read(rolloutPath), undefined);

    await fs.promises.writeFile(rolloutPath, [
        taskStarted('turn-1'),
        userMessage('regular prompt'),
        taskStarted('turn-goal-1'),
        goalPrompt('finish the milestone'),
        taskStarted('turn-2'),
        userMessage('another regular prompt'),
        '',
    ].join('\n'));
    let goals = reader.read(rolloutPath);
    assert.deepEqual([...goals.entries()], [[
        'turn-goal-1',
        'finish the milestone',
    ]]);

    // Incremental: appended goal turns join without re-reading the prefix,
    // and a replaced goal yields a second turn with its own objective.
    await fs.promises.appendFile(rolloutPath, [
        taskStarted('turn-goal-2'),
        goalPrompt('second objective\nspanning two lines'),
        '',
    ].join('\n'));
    goals = reader.read(rolloutPath);
    assert.deepEqual([...goals.entries()], [
        ['turn-goal-1', 'finish the milestone'],
        ['turn-goal-2', 'second objective\nspanning two lines'],
    ]);
});

test('MAIN-AI-SESSION-CONVERSATION-OUTLINE goal turns reader ignores malformed and partial records', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-goal-turns-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const reader = new CodexRolloutGoalTurnsReader();

    await fs.promises.writeFile(rolloutPath, [
        '{"broken task_started',
        goalPrompt('orphan without a turn'),
        taskStarted('turn-a'),
        userMessage('<codex_internal_context source="goal">no tags here'),
        JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'assistant' },
        }),
        '',
    ].join('\n'));
    assert.deepEqual([...reader.read(rolloutPath).entries()], []);
});

test('MAIN-AI-SESSION-CONVERSATION-OUTLINE goal turns reader rescans a replaced rollout from scratch', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-goal-turns-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const reader = new CodexRolloutGoalTurnsReader();

    await fs.promises.writeFile(
        rolloutPath,
        `${taskStarted('turn-old')}\n${goalPrompt('old objective')}\n`
    );
    assert.equal(reader.read(rolloutPath).get('turn-old'), 'old objective');

    // A truncated rewrite (compaction replaces the file) restarts the scan.
    await fs.promises.writeFile(rolloutPath, `${taskStarted('turn-x')}\n`);
    const goals = reader.read(rolloutPath);
    assert.equal(goals.get('turn-old'), undefined);
    assert.equal(goals.size, 0);
});
