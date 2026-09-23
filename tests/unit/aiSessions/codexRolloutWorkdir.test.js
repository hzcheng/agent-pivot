'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    readCodexRolloutTelemetry,
    readCodexRolloutWorkdir,
} = require('../../../out/aiSessions/codexRolloutWorkdir');

function execLine(workdir) {
    return JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'custom_tool_call',
            name: 'exec',
            input: `const r = await tools.exec_command(${JSON.stringify({
                cmd: 'git status',
                workdir,
            })})`,
        },
    });
}

test('CONVERSATION-TELEMETRY-001 rollout probe reads the newest exec workdir from the transcript tail', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-rollout-probe-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');

    await assert.rejects(readCodexRolloutWorkdir(rolloutPath), { code: 'ENOENT' });

    await fs.promises.writeFile(rolloutPath, [
        execLine('/launch/repo'),
        JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
        '{"malformed workdir',
        execLine('/launch/repo/.worktree/feature-x'),
        '',
    ].join('\n'));
    assert.equal(
        await readCodexRolloutWorkdir(rolloutPath),
        '/launch/repo/.worktree/feature-x'
    );

    await fs.promises.writeFile(rolloutPath, `${execLine('/launch/repo')}\n`);
    assert.equal(await readCodexRolloutWorkdir(rolloutPath), '/launch/repo');

    await fs.promises.writeFile(
        rolloutPath,
        `${JSON.stringify({ type: 'response_item', payload: { type: 'message' } })}\n`
    );
    assert.equal(await readCodexRolloutWorkdir(rolloutPath), undefined);
});

test('CONVERSATION-TELEMETRY-001 rollout probe keeps the latest workdir across a large trailing record', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-rollout-large-tail-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const largeAssistantRecord = JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'message',
            content: 'x'.repeat(300 * 1024),
        },
    });

    await fs.promises.writeFile(rolloutPath, [
        execLine('/repo/.worktree/telemetry-fix'),
        largeAssistantRecord,
        '',
    ].join('\n'));

    assert.equal(
        await readCodexRolloutWorkdir(rolloutPath),
        '/repo/.worktree/telemetry-fix'
    );
});

test('CONVERSATION-TELEMETRY-001 rollout probe reads current model and context usage from real Codex record shapes', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-rollout-telemetry-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');

    await fs.promises.writeFile(rolloutPath, [
        JSON.stringify({
            type: 'turn_context',
            payload: { model: 'gpt-5.5' },
        }),
        JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    last_token_usage: { total_tokens: 12_000 },
                    model_context_window: 128_000,
                },
            },
        }),
        '{"type":"event_msg","payload":',
        JSON.stringify({
            type: 'turn_context',
            payload: { model: 'gpt-5.6-sol' },
        }),
        JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    total_token_usage: { total_tokens: 226_194 },
                    last_token_usage: { total_tokens: 54_297 },
                    model_context_window: 258_400,
                },
            },
        }),
        '',
    ].join('\n'));

    assert.deepEqual(await readCodexRolloutTelemetry(rolloutPath), {
        model: 'gpt-5.6-sol',
        context: {
            usedTokens: 54_297,
            maxTokens: 258_400,
        },
    });
});

test('CONVERSATION-TELEMETRY-001 cold and incremental reads retain telemetry beyond the former tail window', async t => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'telemetry-large-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'rollout.jsonl');
    const record = value => JSON.stringify(value) + '\n';
    const model = name => record({ type: 'turn_context', payload: { model: name } });
    const context = record({ type: 'event_msg', payload: {
        type: 'token_count', info: {
            last_token_usage: { total_tokens: 1234 }, model_context_window: 8000,
        },
    } });
    const large = record({ type: 'response_item', payload: { text: 'x'.repeat(3 * 1024 * 1024) } });
    await fs.promises.writeFile(file, model('old-model') + context + large);
    const expected = { model: 'old-model', context: { usedTokens: 1234, maxTokens: 8000 } };
    assert.deepEqual(await readCodexRolloutTelemetry(file), expected);
    await fs.promises.appendFile(file, large);
    assert.deepEqual(await readCodexRolloutTelemetry(file), expected);
    const next = model('new-model');
    await fs.promises.appendFile(file, next.slice(0, -3));
    assert.deepEqual(await readCodexRolloutTelemetry(file), expected, 'partial records are retried');
    await fs.promises.appendFile(file, next.slice(-3));
    const results = await Promise.all(Array.from({ length: 4 }, () => readCodexRolloutTelemetry(file)));
    for (const result of results) assert.equal(result.model, 'new-model');
    results[0].context.usedTokens = 999;
    assert.equal((await readCodexRolloutTelemetry(file)).context.usedTokens, 1234);
    await fs.promises.writeFile(file, model('replaced'));
    assert.deepEqual(await readCodexRolloutTelemetry(file), { model: 'replaced' }, 'truncation resets context');
    await fs.promises.rename(file, file + '.old');
    await fs.promises.writeFile(file, model('replacement-inode') + large);
    assert.deepEqual(await readCodexRolloutTelemetry(file), { model: 'replacement-inode' });
});

function directExec(args, name = 'exec_command') {
    return JSON.stringify({ type: 'response_item', payload: {
        type: 'function_call', name, arguments: JSON.stringify(args),
    } }) + '\n';
}

test('CONVERSATION-TELEMETRY-001 direct exec follows workdir and leading cd without carrying cwd between commands', async t => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-direct-cwd-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'rollout.jsonl');
    await fs.promises.writeFile(file, JSON.stringify({ type: 'session_meta', payload: {
        cwd: '/repo/.worktrees/A',
    } }) + '\n' + directExec({ cmd: 'cd /repo/.worktrees/B/core && git status' }));
    assert.equal(await readCodexRolloutWorkdir(file), '/repo/.worktrees/B/core');
    for (const [args, expected] of [
        [{ cmd: 'git status', workdir: '/repo/.worktrees/C' }, '/repo/.worktrees/C'],
        [{ cmd: 'cd "../B with spaces" && cd core && git status' }, '/repo/.worktrees/B with spaces/core'],
        [{ cmd: 'cd -- ../D && git status', workdir: '/repo/.worktrees/C' }, '/repo/.worktrees/D'],
        [{ cmd: 'git status' }, '/repo/.worktrees/A'],
        [{ cmd: "printf 'cd /wrong'" }, '/repo/.worktrees/A'],
    ]) {
        await fs.promises.appendFile(file, directExec(args));
        assert.equal(await readCodexRolloutWorkdir(file), expected);
    }
    for (const cmd of ['cd "$TARGET" && git status', 'cd $(pwd) && git status', 'cd /wrong || pwd', "cd '/repo'/child && pwd"]) {
        await fs.promises.appendFile(file, directExec({ cmd }));
        assert.equal(await readCodexRolloutWorkdir(file), '/repo/.worktrees/A');
    }
    await fs.promises.appendFile(file, directExec({ cmd: 'cd /wrong && pwd' }, 'spawn_agent'));
    assert.equal(await readCodexRolloutWorkdir(file), '/repo/.worktrees/A');
    await fs.promises.appendFile(file, JSON.stringify({ type: 'turn_context', payload: {
        cwd: '/repo/.worktrees/resumed',
    } }) + '\n' + directExec({ cmd: 'cd subdir && pwd' }, 'functions.exec_command'));
    assert.equal(await readCodexRolloutWorkdir(file), '/repo/.worktrees/resumed/subdir');
    await fs.promises.writeFile(file, directExec({ cmd: 'cd ../relative && pwd' }));
    assert.equal(await readCodexRolloutWorkdir(file), undefined, 'truncation clears the launch cwd');
});
