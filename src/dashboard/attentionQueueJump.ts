'use strict';

import type {
    AttentionQueue,
    AttentionQueueItem,
} from '../aiSessions/attentionQueue';
import type { AiSessionProviderId } from '../models';

export interface AttentionQueueJumpOptions {
    buildQueue: () => AttentionQueue;
    focusSession: (item: AttentionQueueItem) => Promise<boolean>;
    openConversation: (item: AttentionQueueItem) => Promise<void>;
    acknowledge: (eventIds: string[]) => Promise<void>;
    shouldAcknowledge: () => boolean;
    findNavigationCardId: (projectId: string) => string | null;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
    /** The session the user is currently watching, when it is a known AI session. */
    getCurrentIdentity?: () => { provider: AiSessionProviderId; sessionId: string } | null;
}

/**
 * Advances a cursor through the oldest-first attention queue independently
 * from acknowledgement. A local jump acknowledges only when the user setting
 * opts in and after terminal focus and conversation open both succeed.
 * Otherwise it stays unread until the session card is clicked, while the next
 * invocation can still advance. A remote jump switches windows and
 * deliberately leaves the entry unread.
 */
export function createAttentionQueueJumpHandler(
    options: AttentionQueueJumpOptions
): () => Promise<void> {
    let lastKey: string | null = null;
    return async function jumpToNextAttentionSession(): Promise<void> {
        const items = options.buildQueue().items;
        if (!items.length) {
            options.showInformationMessage(
                'Agent Pivot: no AI sessions need attention.'
            );
            return;
        }
        const currentIdentity = options.getCurrentIdentity
            ? options.getCurrentIdentity()
            : null;
        const currentIndex = currentIdentity
            ? items.findIndex(item => item.local
                && item.provider === currentIdentity.provider
                && item.sessionId === currentIdentity.sessionId)
            : -1;
        const previousIndex = lastKey === null
            ? -1
            : items.findIndex(item => attentionQueueItemKey(item) === lastKey);
        let next: AttentionQueueItem;
        if (previousIndex >= 0) {
            next = items[(previousIndex + 1) % items.length];
            if (currentIndex >= 0
                && items.length > 1
                && attentionQueueItemKey(next) === attentionQueueItemKey(items[currentIndex])) {
                // The wrap would re-land on the session the user is already
                // watching; spend the press on the following entry instead.
                next = items[(previousIndex + 2) % items.length];
            }
        } else if (currentIndex >= 0) {
            // A fresh or stale cursor continues after the session the user is
            // looking at rather than restarting at the queue head.
            next = items[(currentIndex + 1) % items.length];
        } else {
            next = items[0];
        }
        lastKey = attentionQueueItemKey(next);
        if (next.local) {
            const focused = await options.focusSession(next);
            if (!focused) {
                options.showWarningMessage(
                    'Agent Pivot: the selected AI session is no longer active.'
                );
                return;
            }
            await options.openConversation(next);
            if (options.shouldAcknowledge()) {
                await options.acknowledge(next.eventIds);
            }
            return;
        }
        const cardId = options.findNavigationCardId(next.projectId);
        if (!cardId) {
            options.showWarningMessage(
                'Agent Pivot: the session that needs attention is in a window'
                    + ' that is no longer open.'
            );
            return;
        }
        await options.openNavigationCard(cardId);
    };
}

function attentionQueueItemKey(item: AttentionQueueItem): string {
    return JSON.stringify([item.projectId, item.provider, item.sessionId]);
}
