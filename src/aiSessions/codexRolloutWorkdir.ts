'use strict';

import { readJsonlTailLines } from './jsonlTail';

// A single assistant/tool result record may itself exceed the former 256 KiB
// window. Keep enough trailing data to reach the preceding exec record while
// remaining bounded for very long rollouts.
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const WORKDIR_PATTERN = /\bworkdir\s*:\s*"([^"]+)"/;

/**
 * Telemetry-only probe: app-server does not expose exec items, so the latest
 * exec workdir is read from the rollout transcript tail. Conversation content
 * remains app-server-only; this probe never feeds messages or outline data.
 */
export function readCodexRolloutWorkdir(
    rolloutPath: string
): string | undefined {
    if (!rolloutPath) {
        return undefined;
    }
    const lines = readJsonlTailLines(rolloutPath, ROLLOUT_TAIL_BYTES);
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line.includes('workdir')) {
            continue;
        }
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch (_error) {
            continue;
        }
        const payload = (record as { payload?: unknown })?.payload;
        const input = payload
            && typeof payload === 'object'
            && !Array.isArray(payload)
            && typeof (payload as { input?: unknown }).input === 'string'
            ? (payload as { input: string }).input
            : '';
        const match = WORKDIR_PATTERN.exec(input);
        if (match?.[1]) {
            return match[1];
        }
    }
    return undefined;
}
