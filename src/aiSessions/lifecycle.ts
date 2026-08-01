'use strict';

export type AiSessionAttentionReason = 'completed' | 'aborted' | 'failed' | 'input-required';
export type AiSessionExecutionState = 'running' | 'stopped';
export type AiSessionLifecyclePhase = 'running' | 'idle' | 'needsAttention';

export interface AiSessionLifecycleRequest {
    sessionId: string;
    runStartedAtMs: number;
}

export interface AiSessionLifecycleSignal {
    token: string;
    phase: AiSessionLifecyclePhase;
    reason?: AiSessionAttentionReason;
    executionState: AiSessionExecutionState;
    occurredAtMs: number;
}

export interface AiSessionLifecycleAccumulator {
    addLines(lines: readonly string[]): void;
    getSignal(): AiSessionLifecycleSignal | null;
}

type JsonRecord = Record<string, any>;

function createAccumulator(
    runStartedAtMs: number,
    parseEvent: (event: JsonRecord, occurredAtMs: number) => AiSessionLifecycleSignal | null
): AiSessionLifecycleAccumulator {
    let latest: AiSessionLifecycleSignal | null = null;
    return {
        addLines(lines) {
            for (let line of lines || []) {
                let event: JsonRecord;
                try {
                    event = JSON.parse(line);
                } catch (e) {
                    continue;
                }

                let occurredAtMs = getOccurredAtMs(event?.timestamp);
                if (!Number.isFinite(occurredAtMs) || occurredAtMs < runStartedAtMs
                    || (latest && occurredAtMs < latest.occurredAtMs)) {
                    continue;
                }

                let signal = parseEvent(event, occurredAtMs);
                if (signal && (!latest || signal.occurredAtMs >= latest.occurredAtMs)) {
                    latest = signal;
                }
            }
        },
        getSignal: () => latest,
    };
}

function getOccurredAtMs(value: unknown): number {
    if (typeof value === 'number') {
        return value < 10_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
        return Date.parse(value);
    }
    return NaN;
}

function getToken(provider: string, eventType: string, occurredAtMs: number, id: unknown): string {
    let safeId = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
    return [provider, eventType, occurredAtMs, safeId].join(':');
}

function running(provider: string, eventType: string, occurredAtMs: number, id?: unknown): AiSessionLifecycleSignal {
    return { token: getToken(provider, eventType, occurredAtMs, id), phase: 'running', executionState: 'running', occurredAtMs };
}

function idle(provider: string, eventType: string, occurredAtMs: number, id?: unknown): AiSessionLifecycleSignal {
    return { token: getToken(provider, eventType, occurredAtMs, id), phase: 'idle', executionState: 'stopped', occurredAtMs };
}

function attention(
    provider: string,
    eventType: string,
    occurredAtMs: number,
    reason: AiSessionAttentionReason,
    id?: unknown
): AiSessionLifecycleSignal {
    return { token: getToken(provider, eventType, occurredAtMs, id), phase: 'needsAttention', reason, executionState: 'stopped', occurredAtMs };
}

export function createCodexLifecycleAccumulator(runStartedAtMs: number): AiSessionLifecycleAccumulator {
    let pendingInputCallIds = new Set<string>();
    return createAccumulator(runStartedAtMs, (event, occurredAtMs) => {
        let payload = event?.payload || {};
        if (event?.type === 'event_msg') {
            switch (payload.type) {
                case 'task_started':
                    pendingInputCallIds.clear();
                    return running('codex', payload.type, occurredAtMs, payload.turn_id);
                case 'task_complete':
                    pendingInputCallIds.clear();
                    return attention('codex', payload.type, occurredAtMs, 'completed', payload.turn_id);
                case 'turn_aborted':
                    pendingInputCallIds.clear();
                    return idle('codex', payload.type, occurredAtMs, payload.turn_id);
                default:
                    return null;
            }
        }
        if (event?.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name === 'request_user_input') {
            if (typeof payload.call_id === 'string' && payload.call_id) {
                pendingInputCallIds.add(payload.call_id);
            }
            return attention('codex', 'request_user_input', occurredAtMs, 'input-required', payload.call_id || payload.id);
        }
        if (event?.type === 'response_item' && payload.type === 'custom_tool_call_output'
            && typeof payload.call_id === 'string' && pendingInputCallIds.has(payload.call_id)) {
            pendingInputCallIds.delete(payload.call_id);
            return running('codex', payload.type, occurredAtMs, payload.call_id);
        }
        return null;
    });
}

export function parseCodexLifecycleLines(lines: readonly string[], runStartedAtMs: number): AiSessionLifecycleSignal | null {
    let accumulator = createCodexLifecycleAccumulator(runStartedAtMs);
    accumulator.addLines(lines);
    return accumulator.getSignal();
}

const KIMI_RUNNING_EVENTS = new Set([
    'TurnBegin', 'StepBegin', 'ContentPart', 'ToolCall', 'ToolResult',
    'StepRetry', 'ApprovalResponse',
]);

export function createKimiLifecycleAccumulator(runStartedAtMs: number): AiSessionLifecycleAccumulator {
    // Kimi emits a trailing TurnEnd when a turn exits via a fatal step error
    // (StepInterrupted then TurnEnd) so the wire log stays balanced, not only
    // on clean completion. A TurnEnd immediately following a StepInterrupted
    // therefore means "interrupted", not "completed".
    let interruptedTurnPending = false;
    return createAccumulator(runStartedAtMs, (event, occurredAtMs) => {
        let message = event?.message || {};
        let payload = message.payload || {};
        if (KIMI_RUNNING_EVENTS.has(message.type)) {
            interruptedTurnPending = false;
            return running('kimi', message.type, occurredAtMs, payload.id || payload.tool_call_id || payload.message_id);
        }
        // SubagentEvent relays a live subagent's progress and ToolCallPart is
        // only emitted while a turn is actively streaming. Neither appears
        // while a session is idle, so each one is proof of life that must
        // keep the execution state alive; otherwise a long subagent run (the
        // main loop only sees SubagentEvent entries until the Agent
        // ToolResult lands) trips the stale-running backstop and the
        // dashboard shows a working session as stopped. StatusUpdate is NOT
        // proof of life: it keeps flowing while a question is pending and
        // must not answer it.
        if (message.type === 'SubagentEvent') {
            let inner = payload.event || {};
            return running('kimi', message.type, occurredAtMs,
                [payload.parent_tool_call_id, payload.agent_id, inner.type].filter(Boolean).join(':'));
        }
        if (message.type === 'ToolCallPart') {
            return running('kimi', message.type, occurredAtMs, payload.tool_call_id);
        }
        if (message.type === 'TurnEnd') {
            if (interruptedTurnPending) {
                interruptedTurnPending = false;
                return idle('kimi', 'TurnEndAfterInterrupt', occurredAtMs);
            }
            return attention('kimi', message.type, occurredAtMs, 'completed');
        }
        if (message.type === 'StepInterrupted') {
            interruptedTurnPending = true;
            return idle('kimi', message.type, occurredAtMs);
        }
        if (message.type === 'ApprovalRequest' || message.type === 'QuestionRequest') {
            return attention('kimi', message.type, occurredAtMs, 'input-required', payload.id || payload.tool_call_id);
        }
        return null;
    });
}

export function parseKimiLifecycleLines(lines: readonly string[], runStartedAtMs: number): AiSessionLifecycleSignal | null {
    let accumulator = createKimiLifecycleAccumulator(runStartedAtMs);
    accumulator.addLines(lines);
    return accumulator.getSignal();
}

function isClaudeUserInterrupt(event: JsonRecord): boolean {
    let content = event?.message?.content;
    let textParts = Array.isArray(content)
        ? content.map((part: unknown) => {
            if (typeof part === 'string') {
                return part;
            }
            return typeof (part as JsonRecord)?.text === 'string' ? (part as JsonRecord).text : '';
        })
        : [typeof content === 'string' ? content : ''];
    // Claude Code emits marker variants such as '[Request interrupted by user
    // for tool use]' when a tool call is interrupted, so match the prefix.
    return textParts.some(text => text.trim().startsWith('[Request interrupted by user'));
}

export function createClaudeLifecycleAccumulator(runStartedAtMs: number): AiSessionLifecycleAccumulator {
    return createAccumulator(runStartedAtMs, (event, occurredAtMs) => {
        if (event?.type === 'system' && event?.subtype === 'api_error') {
            return attention('claude', 'api_error', occurredAtMs, 'failed');
        }
        if (event?.type === 'user') {
            if (isClaudeUserInterrupt(event)) {
                return idle('claude', 'user_interrupt', occurredAtMs, event.uuid);
            }
            return running('claude', 'user', occurredAtMs, event.uuid);
        }
        if (event?.type !== 'assistant') {
            return null;
        }

        let message = event.message || {};
        let ask = Array.isArray(message.content)
            ? message.content.find((part: JsonRecord) => part?.type === 'tool_use' && part?.name === 'AskUserQuestion')
            : null;
        if (ask) {
            return attention('claude', 'AskUserQuestion', occurredAtMs, 'input-required', ask.id);
        }
        if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
            return attention('claude', message.stop_reason, occurredAtMs, 'completed', event.uuid);
        }
        return running('claude', message.stop_reason || 'assistant', occurredAtMs, event.uuid);
    });
}

export function parseClaudeLifecycleLines(lines: readonly string[], runStartedAtMs: number): AiSessionLifecycleSignal | null {
    let accumulator = createClaudeLifecycleAccumulator(runStartedAtMs);
    accumulator.addLines(lines);
    return accumulator.getSignal();
}
