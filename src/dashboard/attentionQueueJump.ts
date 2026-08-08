'use strict';

import type {
    AttentionQueue,
    AttentionQueueItem,
} from '../aiSessions/attentionQueue';

export interface AttentionQueueJumpOptions {
    buildQueue: () => AttentionQueue;
    focusSession: (item: AttentionQueueItem) => Promise<boolean>;
    openConversation: (item: AttentionQueueItem) => Promise<void>;
    acknowledge: (eventIds: string[]) => Promise<void>;
    findNavigationCardId: (projectId: string) => string | null;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
}

/**
 * Drains the attention queue one entry per invocation. A local jump only
 * acknowledges after the terminal focus and the conversation open both
 * succeeded; a remote jump switches windows and deliberately leaves the
 * entry unread so the destination window drains it from its own queue.
 */
export function createAttentionQueueJumpHandler(
    options: AttentionQueueJumpOptions
): () => Promise<void> {
    return async function jumpToNextAttentionSession(): Promise<void> {
        const next = options.buildQueue().items[0];
        if (!next) {
            options.showInformationMessage(
                'Agent Pivot: no AI sessions need attention.'
            );
            return;
        }
        if (next.local) {
            const focused = await options.focusSession(next);
            if (!focused) {
                options.showWarningMessage(
                    'Agent Pivot: the selected AI session is no longer active.'
                );
                return;
            }
            await options.openConversation(next);
            await options.acknowledge(next.eventIds);
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
