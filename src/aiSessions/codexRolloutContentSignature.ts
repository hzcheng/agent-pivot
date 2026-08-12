'use strict';

import { statSync } from 'fs';

// Conversation content remains app-server-only; this signature never feeds
// messages or outline data. It is only the validity signal for the Codex
// normalized-conversation cache — the same size+mtime assurance level the
// session watch already polls to detect provider-side changes.
export function readCodexRolloutContentSignature(
    rolloutPath: string
): string | undefined {
    if (!rolloutPath) {
        return undefined;
    }
    try {
        const stat = statSync(rolloutPath);
        if (!stat.isFile()) {
            return undefined;
        }
        return `${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
        // An unreadable rollout must degrade to an always-fresh full read,
        // never to a poisoned cache entry.
        return undefined;
    }
}

// Byte size of the rollout backing a session. This is purely an
// optimization-choosing heuristic (is a windowed cold start worth it for
// this session): the framed app-server response size and duration cannot
// be inferred from the source size, so it must never feed correctness or
// fallback-feasibility decisions.
export function readCodexRolloutSourceBytes(
    rolloutPath: string
): number | undefined {
    if (!rolloutPath) {
        return undefined;
    }
    try {
        const stat = statSync(rolloutPath);
        return stat.isFile() ? stat.size : undefined;
    } catch (_error) {
        return undefined;
    }
}
