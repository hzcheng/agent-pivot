'use strict';

import type { AiSessionLifecycleSignal } from './lifecycle';

export interface AcceptedLifecycleSignal {
    lastSignalToken?: string;
    lastOccurredAtMs?: number;
}

/**
 * Whether a monitor should act on a lifecycle signal.
 *
 * Both status surfaces read the same signal, so they have to agree on which
 * ones count. A signal is new when its token differs from the last accepted
 * one, and current when it is no older than the last accepted one. The second
 * rule matters because a provider cursor rebuilt from the start of a transcript
 * replays earlier events: without it the attention dot could be raised again by
 * a completion the running animation had already moved past.
 */
export function acceptsLifecycleSignal(
    entry: AcceptedLifecycleSignal,
    signal: AiSessionLifecycleSignal | undefined
): signal is AiSessionLifecycleSignal {
    return Boolean(signal?.token)
        && signal.token !== entry.lastSignalToken
        && (entry.lastOccurredAtMs === undefined || signal.occurredAtMs >= entry.lastOccurredAtMs);
}

/** Records a signal the caller accepted, so later replays are rejected. */
export function recordAcceptedLifecycleSignal(
    entry: AcceptedLifecycleSignal,
    signal: AiSessionLifecycleSignal
): void {
    entry.lastSignalToken = signal.token;
    entry.lastOccurredAtMs = signal.occurredAtMs;
}
