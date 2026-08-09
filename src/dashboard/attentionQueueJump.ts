'use strict';

import type {
    AttentionQueue,
    AttentionQueueItem,
} from '../aiSessions/attentionQueue';
import type { AiSessionProviderId } from '../models';
import {
    createSessionNavigationCoordinator,
    SessionNavigationCoordinator,
} from './sessionNavigationCoordinator';
import type { SessionNavigationFocusResult } from './sessionNavigationFocusExecutor';

interface AttentionQueueJumpBaseOptions {
    navigationCoordinator?: SessionNavigationCoordinator;
    buildQueue: () => AttentionQueue;
    acknowledge: (eventIds: string[]) => Promise<void>;
    shouldAcknowledge: () => boolean;
    requestRemoteFocus?: (item: AttentionQueueItem) => Promise<boolean>;
    findNavigationCardId: (projectId: string) => string | null;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
    /** The session the user is currently watching, when it is a known AI session. */
    getCurrentIdentity?: () => { provider: AiSessionProviderId; sessionId: string } | null;
}

export type AttentionQueueJumpOptions = AttentionQueueJumpBaseOptions & (
    {
        navigateSession: (item: AttentionQueueItem) => Promise<SessionNavigationFocusResult>;
        focusSession?: never;
        openConversation?: never;
    }
    | {
        navigateSession?: never;
        focusSession: (item: AttentionQueueItem) => Promise<boolean>;
        openConversation: (item: AttentionQueueItem) => Promise<boolean>;
    }
);

export interface AttentionQueueJumpHandler {
    (): Promise<void>;
    jumpToAttentionSession(item: AttentionQueueJumpTarget): Promise<void>;
}

export type AttentionQueueJumpTarget = Pick<
    AttentionQueueItem,
    'projectId' | 'provider' | 'sessionId'
>;

/**
 * Advances a cursor through the oldest-first attention queue independently
 * from acknowledgement. A local jump acknowledges only when the user setting
 * opts in and after terminal focus and conversation open both succeed.
 * Otherwise it stays unread until the session card is clicked, while the next
 * invocation can still advance. A remote jump hands the exact queue item to
 * its owning window before switching there, so the destination applies the
 * same focus, open, and optional acknowledgement rules.
 */
export function createAttentionQueueJumpHandler(
    options: AttentionQueueJumpOptions
): AttentionQueueJumpHandler {
    let lastKey: string | null = null;
    let lastObservedCurrentKey: string | null = null;
    const navigationCoordinator = options.navigationCoordinator
        || createSessionNavigationCoordinator();

    async function jumpToLocal(item: AttentionQueueItem): Promise<void> {
        const key = attentionQueueItemKey(item);
        lastKey = key;
        const result = options.navigateSession
            ? await options.navigateSession(item)
            : await navigateWithLegacyCallbacks(item);
        if (!result.focused) {
            options.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
            return;
        }
        lastObservedCurrentKey = key;
        if (result.conversationOpened && options.shouldAcknowledge()) {
            await options.acknowledge(item.eventIds);
        }
    }

    async function navigateWithLegacyCallbacks(
        item: AttentionQueueItem,
    ): Promise<SessionNavigationFocusResult> {
        if (!options.focusSession || !options.openConversation) {
            throw new Error('Attention navigation requires one local execution strategy');
        }
        const focused = await options.focusSession(item);
        if (!focused) {
            return { focused: false, conversationOpened: false };
        }
        return {
            focused: true,
            conversationOpened: await options.openConversation(item),
        };
    }

    async function jumpToNextAttentionSession(): Promise<void> {
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
        const currentKey = currentIndex >= 0
            ? attentionQueueItemKey(items[currentIndex])
            : null;
        const currentChanged = currentKey !== null
            && currentKey !== lastObservedCurrentKey;
        lastObservedCurrentKey = currentKey;
        const previousIndex = lastKey === null
            ? -1
            : items.findIndex(item => attentionQueueItemKey(item) === lastKey);
        let next: AttentionQueueItem;
        if (currentIndex >= 0 && currentChanged) {
            // A focus change that was not produced by this handler is a manual
            // detour. Re-anchor to what the user is actually watching.
            next = items[(currentIndex + 1) % items.length];
        } else if (previousIndex >= 0) {
            // The cursor leads while it survives: only it walks the whole
            // cycle, because a lingering focused terminal makes the watched
            // anchor stale after every remote hop and starves the sessions
            // between them.
            next = items[(previousIndex + 1) % items.length];
            if (currentIndex >= 0
                && items.length > 1
                && attentionQueueItemKey(next) === attentionQueueItemKey(items[currentIndex])) {
                // Never spend a press re-landing on the watched session.
                next = items[(previousIndex + 2) % items.length];
            }
        } else if (currentIndex >= 0) {
            // A fresh or stale cursor continues after the session the user is
            // looking at rather than restarting at the queue head.
            next = items[(currentIndex + 1) % items.length];
        } else {
            // Nothing anchors the cycle: start at this window's oldest waiting
            // session before hopping to another window.
            next = items.find(item => item.local) || items[0];
        }
        if (next.local) {
            await jumpToLocal(next);
            return;
        }
        lastKey = attentionQueueItemKey(next);
        const cardId = options.findNavigationCardId(next.projectId);
        if (!cardId) {
            options.showWarningMessage(
                'Agent Pivot: the session that needs attention is in a window'
                    + ' that is no longer open.'
            );
            return;
        }
        if (options.requestRemoteFocus) {
            let handedOff = false;
            try {
                handedOff = await options.requestRemoteFocus(next);
            } catch (_error) {
                handedOff = false;
            }
            await options.openNavigationCard(cardId);
            if (!handedOff) {
                options.showInformationMessage(
                    'Agent Pivot: switched to the window with the session that needs attention;'
                        + ' run Next Attention Session again to finish the jump.'
                );
            }
            return;
        }
        await options.openNavigationCard(cardId);
    }

    async function jumpToAttentionSession(item: AttentionQueueJumpTarget): Promise<void> {
        const key = attentionQueueItemKey(item);
        const local = options.buildQueue().items.find(candidate =>
            candidate.local && attentionQueueItemKey(candidate) === key
        );
        if (!local) {
            options.showWarningMessage(
                'Agent Pivot: the selected AI session no longer needs attention in this window.'
            );
            return;
        }
        await jumpToLocal(local);
    }

    const handler = (() => navigationCoordinator.enqueue(
        jumpToNextAttentionSession
    )) as AttentionQueueJumpHandler;
    handler.jumpToAttentionSession = item => navigationCoordinator.enqueue(
        () => jumpToAttentionSession(item)
    );
    return handler;
}

function attentionQueueItemKey(item: AttentionQueueJumpTarget): string {
    return JSON.stringify([item.projectId, item.provider, item.sessionId]);
}
