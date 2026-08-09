'use strict';

import { readJsonlTailLines } from './jsonlTail';

// A single assistant/tool result record may itself exceed the former 256 KiB
// window. Keep enough trailing data to reach the preceding exec record while
// remaining bounded for very long rollouts.
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const WORKDIR_PATTERN = /\bworkdir\b"?\s*:\s*"([^"]+)"/;

export interface CodexRolloutTelemetry {
    model?: string;
    context?: {
        usedTokens: number;
        maxTokens: number;
    };
    currentWorkdir?: string;
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

export function readCodexRolloutTelemetry(
    rolloutPath: string
): CodexRolloutTelemetry | undefined {
    if (!rolloutPath) {
        return undefined;
    }
    const lines = readJsonlTailLines(rolloutPath, ROLLOUT_TAIL_BYTES);
    let model: string | undefined;
    let context: CodexRolloutTelemetry['context'];
    let currentWorkdir: string | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
        let record: Record<string, any> | undefined;
        try {
            record = asRecord(JSON.parse(lines[index]));
        } catch (_error) {
            continue;
        }
        const payload = asRecord(record?.payload);
        if (!model && record?.type === 'turn_context'
            && typeof payload?.model === 'string'
            && payload.model.trim()) {
            model = payload.model.trim().slice(0, 128);
        }
        if (!context && record?.type === 'event_msg'
            && payload?.type === 'token_count') {
            const info = asRecord(payload.info);
            const last = asRecord(info?.last_token_usage);
            if (Number.isSafeInteger(last?.total_tokens)
                && last.total_tokens >= 0
                && Number.isSafeInteger(info?.model_context_window)
                && info.model_context_window > 0) {
                context = {
                    usedTokens: last.total_tokens,
                    maxTokens: info.model_context_window,
                };
            }
        }
        if (!currentWorkdir && typeof payload?.input === 'string') {
            const match = WORKDIR_PATTERN.exec(payload.input);
            if (match?.[1]) {
                currentWorkdir = match[1];
            }
        }
        if (model && context && currentWorkdir) {
            break;
        }
    }
    return model || context || currentWorkdir
        ? {
            ...(model ? { model } : {}),
            ...(context ? { context } : {}),
            ...(currentWorkdir ? { currentWorkdir } : {}),
        }
        : undefined;
}

/**
 * Telemetry-only probe: app-server does not expose exec items, so the latest
 * exec workdir is read from the rollout transcript tail. Conversation content
 * remains app-server-only; this probe never feeds messages or outline data.
 */
export function readCodexRolloutWorkdir(
    rolloutPath: string
): string | undefined {
    return readCodexRolloutTelemetry(rolloutPath)?.currentWorkdir;
}
