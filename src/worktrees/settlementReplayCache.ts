'use strict';

/**
 * Bounded idempotency cache for webview mutation settlements (PRD §6.4
 * protocol rules): a recognized request must settle exactly once. Entries
 * hold the *promise* of the terminal settlement, so a replay that arrives
 * while the first execution is still in flight awaits and re-receives the
 * same outcome instead of re-executing the mutation.
 *
 * Evicted request ids move to a bounded tombstone set: a replay of an
 * expired id is refused fail-closed, never re-executed.
 */
export interface SettlementReplayCache<T> {
    /** The in-flight or settled terminal settlement, when present. */
    get(requestId: string): Promise<T> | undefined;
    remember(requestId: string, settlement: Promise<T>): void;
    /** True for ids evicted past the bound — replays must not re-execute. */
    isExpired(requestId: string): boolean;
}

const MAX_TOMBSTONES = 1024;

export function createSettlementReplayCache<T>(limit = 64): SettlementReplayCache<T> {
    const entries = new Map<string, Promise<T>>();
    const tombstones: string[] = [];
    let tombstoneSet = new Set<string>();
    return {
        get: requestId => entries.get(requestId),
        remember: (requestId, settlement) => {
            // A rejected promise must never surface as an unhandled
            // rejection when no replay ever awaits it.
            settlement.catch(() => undefined);
            if (entries.has(requestId)) {
                entries.delete(requestId);
            } else if (entries.size >= limit) {
                const oldest = entries.keys().next();
                if (!oldest.done) {
                    entries.delete(oldest.value);
                    tombstones.push(oldest.value);
                    tombstoneSet.add(oldest.value);
                    if (tombstones.length > MAX_TOMBSTONES) {
                        const dropped = tombstones.splice(
                            0, tombstones.length - MAX_TOMBSTONES);
                        tombstoneSet = new Set(tombstones);
                        void dropped;
                    }
                }
            }
            entries.set(requestId, settlement);
        },
        isExpired: requestId => tombstoneSet.has(requestId),
    };
}
