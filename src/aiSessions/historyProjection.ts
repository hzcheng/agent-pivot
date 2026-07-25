'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionViewModel } from './types';

export interface AiSessionHistoryProjection {
    pinned: AiSessionViewModel[];
    unpinned: AiSessionViewModel[];
}

export function projectAiSessionHistory(
    selectedProviders: readonly AiSessionProviderId[],
    sessionsByProvider: Partial<Record<AiSessionProviderId, readonly AiSessionViewModel[]>>
): AiSessionHistoryProjection {
    const pinned: AiSessionViewModel[] = [];
    const unpinned: AiSessionViewModel[] = [];
    for (const provider of selectedProviders) {
        for (const session of sessionsByProvider[provider] || []) {
            (session.pinned ? pinned : unpinned).push({ ...session, provider });
        }
    }
    return { pinned, unpinned };
}
