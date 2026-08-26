'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationHistoryRestartPoint,
} from './types';
import { digestConversationSourceRange, OpenConversationSource } from './source';

/** Adapter-cache-only proof data; the provider API deliberately omits it. */
export interface CachedConversationHistoryRestartPoint
    extends ConversationHistoryRestartPoint {
    recordEndOffset: number;
    recordDigest: string;
    /** Digest of this scan's bytes before the restart record. */
    prefixDigest: string;
}

/** Retains only the recent in-memory discovery window; durable sparse points
 * are owned by the later sidecar index, not by an adapter cache. */
export function appendConversationHistoryRestartPoint<
    T extends ConversationHistoryRestartPoint
>(
    points: T[],
    point: T
): void {
    const previous = points[points.length - 1];
    if (previous?.offset === point.offset) {
        return;
    }
    points.push(point);
    const excess = points.length - CONVERSATION_LIMITS.maxOutlineInteractions;
    if (excess >= 64) {
        points.splice(0, excess);
    }
}

/** Drops any candidate whose record boundary no longer proves identical in
 * the continuation source. Each point is independently restart-safe. */
export async function verifyConversationHistoryRestartPoints(
    source: OpenConversationSource,
    points: CachedConversationHistoryRestartPoint[],
    signal?: ConversationAbortSignal
): Promise<CachedConversationHistoryRestartPoint[]> {
    const verified: CachedConversationHistoryRestartPoint[] = [];
    for (const point of points) {
        if (signal?.aborted) {
            return [];
        }
        const digest = await digestConversationSourceRange(
            source,
            point.offset,
            point.recordEndOffset,
            signal
        );
        if (digest === point.recordDigest) {
            verified.push(point);
        }
    }
    return verified;
}

/** Captures raw-record proofs only after the current source scan succeeded. */
