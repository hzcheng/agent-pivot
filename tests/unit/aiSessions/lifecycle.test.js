'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const lifecycle = require('../../../out/aiSessions/lifecycle');

// PERSIST-LIFECYCLE-PARSER-001

const fixturesRoot = path.resolve(__dirname, '../../fixtures/providers');
const runStartedAtMs = Date.parse('2026-07-20T00:00:00.000Z');
const providers = [{
    id: 'codex',
    parser: lifecycle.parseCodexLifecycleLines,
    stoppedPhase: 'idle',
}, {
    id: 'kimi',
    parser: lifecycle.parseKimiLifecycleLines,
    stoppedPhase: 'idle',
}, {
    id: 'claude',
    parser: lifecycle.parseClaudeLifecycleLines,
    stoppedPhase: 'needsAttention',
    stoppedReason: 'failed',
}];

function readLines(providerId, state) {
    return fs.readFileSync(
        path.join(fixturesRoot, providerId, 'lifecycle', `${state}.jsonl`),
        'utf8'
    ).split(/\r?\n/g);
}

for (const provider of providers) {
    const cases = [{
        state: 'running',
        expected: { phase: 'running', executionState: 'running' },
    }, {
        state: 'waiting',
        expected: { phase: 'needsAttention', reason: 'input-required', executionState: 'stopped' },
    }, {
        state: 'completed',
        expected: { phase: 'needsAttention', reason: 'completed', executionState: 'stopped' },
    }, {
        state: 'stopped',
        expected: {
            phase: provider.stoppedPhase,
            reason: provider.stoppedReason,
            executionState: 'stopped',
        },
    }];

    for (const fixtureCase of cases) {
        test(`PERSIST-LIFECYCLE-PARSER-001 [${provider.id}] maps ${fixtureCase.state} lifecycle signals`, () => {
            const signal = provider.parser(readLines(provider.id, fixtureCase.state), runStartedAtMs);
            assert.ok(signal, `${provider.id} ${fixtureCase.state} fixture must produce a signal`);
            for (const [key, value] of Object.entries(fixtureCase.expected)) {
                assert.equal(signal[key], value);
            }
            assert.match(signal.token, new RegExp(`^${provider.id}:`));
            assert.ok(signal.occurredAtMs >= runStartedAtMs);
        });
    }

    test(`PERSIST-LIFECYCLE-PARSER-001 [${provider.id}] isolates malformed and pre-run fixture lines`, () => {
        const signal = provider.parser(readLines(provider.id, 'malformed'), runStartedAtMs);
        assert.ok(signal);
        assert.equal(signal.phase, 'running');
        assert.equal(signal.executionState, 'running');
        assert.ok(signal.occurredAtMs >= runStartedAtMs);
    });
}

test('PERSIST-LIFECYCLE-PARSER-001 [kimi] treats subagent progress events as running', () => {
    const signal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:00.000Z') / 1000,
            message: { type: 'ToolCall', payload: { id: 'Agent_25', name: 'Agent' } },
        }),
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:52:00.000Z') / 1000,
            message: {
                type: 'SubagentEvent',
                payload: {
                    parent_tool_call_id: 'Agent_25',
                    agent_id: 'ab654f447',
                    subagent_type: 'coder',
                    event: { type: 'ToolResult', payload: { tool_call_id: 'call-1' } },
                },
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'running');
    assert.equal(signal.executionState, 'running');
    assert.match(signal.token, /^kimi:SubagentEvent:/);
});

test('PERSIST-LIFECYCLE-PARSER-001 [codex] treats ordinary turn progress as a running lease renewal', () => {
    const signal = lifecycle.parseCodexLifecycleLines([
        JSON.stringify({
            timestamp: '2026-07-24T08:00:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'turn-long' },
        }),
        JSON.stringify({
            timestamp: '2026-07-24T08:31:00.000Z',
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'wait',
                call_id: 'call-still-running',
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'running');
    assert.equal(signal.executionState, 'running');
    assert.equal(signal.occurredAtMs, Date.parse('2026-07-24T08:31:00.000Z'));
    assert.match(signal.token, /^codex:function_call:/);
});

test('PERSIST-LIFECYCLE-PARSER-001 [codex] does not let unrelated progress answer a pending question', () => {
    const signal = lifecycle.parseCodexLifecycleLines([
        JSON.stringify({
            timestamp: '2026-07-24T08:00:00.000Z',
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name: 'request_user_input',
                call_id: 'question-call',
            },
        }),
        JSON.stringify({
            timestamp: '2026-07-24T08:01:00.000Z',
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'unrelated-call',
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'needsAttention');
    assert.equal(signal.reason, 'input-required');
    assert.equal(signal.executionState, 'stopped');
});

test('PERSIST-LIFECYCLE-PARSER-001 [codex] ignores delayed progress after a terminal event until a new task starts', () => {
    const signal = lifecycle.parseCodexLifecycleLines([
        JSON.stringify({
            timestamp: '2026-07-24T08:00:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'turn-complete' },
        }),
        JSON.stringify({
            timestamp: '2026-07-24T08:01:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-complete' },
        }),
        JSON.stringify({
            timestamp: '2026-07-24T08:02:00.000Z',
            type: 'response_item',
            payload: {
                type: 'custom_tool_call_output',
                call_id: 'delayed-output',
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'needsAttention');
    assert.equal(signal.reason, 'completed');
    assert.equal(signal.executionState, 'stopped');
});

test('PERSIST-LIFECYCLE-PARSER-001 [kimi] treats a TurnEnd trailing a StepInterrupted as interruption, not completion', () => {
    const signal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:00.000Z') / 1000,
            message: { type: 'StepInterrupted', payload: {} },
        }),
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:01.000Z') / 1000,
            message: { type: 'TurnEnd', payload: {} },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'idle');
    assert.equal(signal.reason, undefined);
    assert.equal(signal.executionState, 'stopped');
    assert.match(signal.token, /^kimi:TurnEndAfterInterrupt:/);
});

test('PERSIST-LIFECYCLE-PARSER-001 [kimi] a new turn clears the trailing interrupt marker', () => {
    const signal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:00.000Z') / 1000,
            message: { type: 'StepInterrupted', payload: {} },
        }),
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:43:00.000Z') / 1000,
            message: { type: 'TurnBegin', payload: {} },
        }),
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:43:30.000Z') / 1000,
            message: { type: 'TurnEnd', payload: {} },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'needsAttention');
    assert.equal(signal.reason, 'completed');
    assert.equal(signal.executionState, 'stopped');
});

test('PERSIST-LIFECYCLE-PARSER-001 [kimi] treats streaming tool call parts as running', () => {
    const signal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:00.000Z') / 1000,
            message: { type: 'ToolCallPart', payload: { arguments_part: '{}' } },
        }),
    ], runStartedAtMs);
    assert.ok(signal, 'ToolCallPart must produce a signal');
    assert.equal(signal.phase, 'running');
    assert.equal(signal.executionState, 'running');
    assert.match(signal.token, /^kimi:ToolCallPart:/);
});

test('PERSIST-LIFECYCLE-PARSER-001 [kimi] status updates stay invisible to execution state', () => {
    const signal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:00.000Z') / 1000,
            message: { type: 'QuestionRequest', payload: { id: 'question-1' } },
        }),
        JSON.stringify({
            timestamp: Date.parse('2026-07-24T08:42:01.000Z') / 1000,
            message: { type: 'StatusUpdate', payload: { message_id: 'status-1', context_usage: 0.5 } },
        }),
    ], runStartedAtMs);
    assert.ok(signal);
    assert.equal(signal.phase, 'needsAttention');
    assert.equal(signal.reason, 'input-required');
    assert.equal(signal.executionState, 'stopped');
});

test('PERSIST-LIFECYCLE-PARSER-001 [claude] treats the explicit user interrupt marker as stopped', () => {
    const signal = lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({
            type: 'assistant',
            timestamp: '2026-07-24T08:42:19.029Z',
            uuid: 'assistant-before-interrupt',
            message: {
                role: 'assistant',
                stop_reason: null,
                content: [{ type: 'text', text: 'Partial response before interruption' }],
            },
        }),
        JSON.stringify({
            type: 'user',
            timestamp: '2026-07-24T08:42:19.030Z',
            uuid: 'user-interrupt',
            message: {
                role: 'user',
                content: [{ type: 'text', text: '[Request interrupted by user]' }],
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'idle');
    assert.equal(signal.reason, undefined);
    assert.equal(signal.executionState, 'stopped');
    assert.match(signal.token, /^claude:user_interrupt:/);
});

test('PERSIST-LIFECYCLE-PARSER-001 [claude] treats the tool-use interrupt marker variant as stopped', () => {
    const signal = lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({
            type: 'assistant',
            timestamp: '2026-08-01T02:35:56.958Z',
            uuid: 'assistant-tool-use',
            message: {
                role: 'assistant',
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
            },
        }),
        JSON.stringify({
            type: 'user',
            timestamp: '2026-08-01T02:36:41.919Z',
            uuid: 'user-tool-result-rejected',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: "The user doesn't want to proceed with this tool use.",
                }],
            },
        }),
        JSON.stringify({
            type: 'user',
            timestamp: '2026-08-01T02:36:41.920Z',
            uuid: 'user-interrupt-tool-use',
            message: {
                role: 'user',
                content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
            },
        }),
    ], runStartedAtMs);

    assert.ok(signal);
    assert.equal(signal.phase, 'idle');
    assert.equal(signal.reason, undefined);
    assert.equal(signal.executionState, 'stopped');
    assert.match(signal.token, /^claude:user_interrupt:/);
});
