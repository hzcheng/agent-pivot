'use strict';

import { CONVERSATION_LIMITS, ConversationHistoryRestartPoint } from './types';

/** Retains only the recent in-memory discovery window; durable sparse points
 * are owned by the later sidecar index, not by an adapter cache. */
export function appendConversationHistoryRestartPoint(
    points: ConversationHistoryRestartPoint[],
    point: ConversationHistoryRestartPoint
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
