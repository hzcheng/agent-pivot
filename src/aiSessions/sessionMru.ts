'use strict';

import type { AiSessionProviderId } from '../models';
import { getAiSessionKey } from './sessionHelpers';

export interface AiSessionMruEntry {
    key: string;
    provider: AiSessionProviderId;
    sessionId: string;
    recordedAtMs: number;
}

export interface AiSessionMruTracker {
    record(provider: AiSessionProviderId, sessionId: string): void;
    entries(): readonly AiSessionMruEntry[];
    mostRecentKey(excludeKey?: string | null): string | null;
    prune(validKeys: ReadonlySet<string>): void;
}

export const AI_SESSION_MRU_MAX_ENTRIES = 20;

/**
 * Bounded most-recently-used list of focused AI sessions, newest first. The
 * tracker is fed by terminal focus events, so every host-initiated jump and
 * every manual terminal click contributes without instrumenting each call
 * site. Keys use the canonical `provider:sessionId` shape.
 */
export function createAiSessionMruTracker(options: {
    now: () => number;
    maxEntries?: number;
}): AiSessionMruTracker {
    const maxEntries = options.maxEntries && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : AI_SESSION_MRU_MAX_ENTRIES;
    let entries: AiSessionMruEntry[] = [];
    return {
        record(provider, sessionId) {
            if (typeof provider !== 'string' || !provider
                || typeof sessionId !== 'string' || !sessionId) {
                return;
            }
            const key = getAiSessionKey(provider, sessionId);
            entries = [
                {
                    key,
                    provider,
                    sessionId,
                    recordedAtMs: options.now(),
                },
                ...entries.filter(entry => entry.key !== key),
            ].slice(0, maxEntries);
        },
        entries() {
            return entries.slice();
        },
        mostRecentKey(excludeKey) {
            const found = entries.find(entry => entry.key !== excludeKey);
            return found ? found.key : null;
        },
        prune(validKeys) {
            entries = entries.filter(entry => validKeys.has(entry.key));
        },
    };
}
