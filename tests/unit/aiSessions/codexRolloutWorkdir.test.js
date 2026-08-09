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

    assert.equal(readCodexRolloutWorkdir(rolloutPath), undefined);

    await fs.promises.writeFile(rolloutPath, [
        execLine('/launch/repo'),
        JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
        '{"malformed workdir',
        execLine('/launch/repo/.worktree/feature-x'),
        '',
    ].join('\n'));
    assert.equal(
        readCodexRolloutWorkdir(rolloutPath),
        '/launch/repo/.worktree/feature-x'
    );

    await fs.promises.writeFile(rolloutPath, `${execLine('/launch/repo')}\n`);
    assert.equal(readCodexRolloutWorkdir(rolloutPath), '/launch/repo');

    await fs.promises.writeFile(
        rolloutPath,
        `${JSON.stringify({ type: 'response_item', payload: { type: 'message' } })}\n`
    );
    assert.equal(readCodexRolloutWorkdir(rolloutPath), undefined);
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
        readCodexRolloutWorkdir(rolloutPath),
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

    assert.deepEqual(readCodexRolloutTelemetry(rolloutPath), {
        model: 'gpt-5.6-sol',
        context: {
            usedTokens: 54_297,
            maxTokens: 258_400,
        },
    });
});
