'use strict';

/**
 * Bounded idempotency cache for webview mutation settlements (PRD §6.4
 * protocol rules): a recognized request must settle exactly once. Entries
 * hold the *promise* of the terminal settlement, so a replay that arrives
 * while the first execution is still in flight awaits and re-receives the
 * same outcome instead of re-executing the mutation.
 */
export interface SettlementReplayCache<T> {
    /** The in-flight or settled terminal settlement, when present. */
    get(requestId: string): Promise<T> | undefined;
    remember(requestId: string, settlement: Promise<T>): void;
}

export function createSettlementReplayCache<T>(limit = 64): SettlementReplayCache<T> {
    const entries = new Map<string, Promise<T>>();
    return {
        get: requestId => entries.get(requestId),
        remember: (requestId, settlement) => {
            // A rejected promise must never surface as an unhandled
            // rejection when no replay ever awaits it.
            settlement.catch(() => undefined);
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
