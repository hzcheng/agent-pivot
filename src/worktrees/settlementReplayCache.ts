'use strict';

/**
 * Bounded idempotency cache for webview mutation settlements (PRD §6.4
 * protocol rules): a recognized request must settle exactly once, so a
 * replayed request id receives the recorded terminal settlement instead of
 * re-executing the mutation.
 */
export interface SettlementReplayCache<T> {
    get(requestId: string): T | undefined;
    remember(requestId: string, settlement: T): void;
}

export function createSettlementReplayCache<T>(limit = 64): SettlementReplayCache<T> {
    const entries = new Map<string, T>();
    return {
        get: requestId => entries.get(requestId),
        remember: (requestId, settlement) => {
            if (entries.has(requestId)) {
                entries.delete(requestId);
            } else if (entries.size >= limit) {
                // FIFO eviction: the oldest settlement is the least likely
                // to be replayed against.
                const oldest = entries.keys().next();
                if (!oldest.done) {
                    entries.delete(oldest.value);
                }
            }
            entries.set(requestId, settlement);
        },
    };
}
