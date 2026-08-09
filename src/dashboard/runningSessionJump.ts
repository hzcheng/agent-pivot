'use strict';

import {
    getNextRunningSessionQueueItem,
    RunningSessionQueue,
    RunningSessionQueueItem,
    RunningSessionQueueLocalItem,
    RunningSessionQueueRemoteItem,
} from '../aiSessions/runningQueue';

export interface RunningSessionJumpOptions {
    buildQueue: () => RunningSessionQueue;
    focusSession: (item: RunningSessionQueueLocalItem) => Promise<boolean>;
    openConversation: (item: RunningSessionQueueLocalItem) => Promise<void>;
    requestRemoteFocus: (item: RunningSessionQueueRemoteItem) => Promise<boolean>;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
    /** Key of the session the user is currently looking at, when known. */
    getCurrentKey?: () => string | null;
}

export interface RunningSessionJumpHandler {
    jumpToNextRunningSession(): Promise<void>;
    jumpToNextLocalRunningSession(): Promise<void>;
}

/**
 * Advances a shared cursor through the running-session queue, one entry per
 * invocation. Local entries focus the session terminal and open its
 * conversation; remote entries hand a focus request to the window that owns
 * a running session and then switch to that window, so a single press lands
 * on a working session there. When the handoff channel is unavailable (older
 * bridge) the press degrades to a plain window switch and the next press in
 * the destination window completes the landing.
 *
 * The cursor advances even when a jump fails, so a session that ended
 * mid-cycle is skipped by the next press instead of trapping the user on a
 * dead target.
 */
export function createRunningSessionJumpHandler(
    options: RunningSessionJumpOptions
): RunningSessionJumpHandler {
    let lastKey: string | null = null;

    async function jumpToLocal(item: RunningSessionQueueLocalItem): Promise<void> {
        const focused = await options.focusSession(item);
        lastKey = item.key;
        if (!focused) {
            options.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
            return;
        }
        await options.openConversation(item);
    }

    async function jumpToRemote(item: RunningSessionQueueRemoteItem): Promise<void> {
        let handedOff = false;
        try {
            handedOff = await options.requestRemoteFocus(item);
        } catch (_error) {
            // A missing or failing handoff channel degrades to a plain window
            // switch; navigation below still moves the user closer.
            handedOff = false;
        }
        lastKey = item.key;
        await options.openNavigationCard(item.cardId);
        if (!handedOff) {
            options.showInformationMessage(
                `Agent Pivot: switched to ${item.displayName || 'the other window'};`
                    + ' run Next Running Session again to focus a session there.'
            );
        }
    }

    async function jump(scope: 'all' | 'local'): Promise<void> {
        const queue = options.buildQueue();
        const items: RunningSessionQueueItem[] = scope === 'local'
            ? queue.items.filter(item => item.kind === 'local')
            : queue.items;
        if (!items.length) {
            options.showInformationMessage(
                scope === 'local'
                    ? 'Agent Pivot: no running AI sessions in this window.'
                    : 'Agent Pivot: no running AI sessions.'
            );
            return;
        }
        const currentKey = options.getCurrentKey ? options.getCurrentKey() : null;
        const next = getNextRunningSessionQueueItem(items, lastKey, currentKey);
        if (!next) {
            return;
        }
        if (next.kind === 'local') {
            await jumpToLocal(next);
        } else {
            await jumpToRemote(next);
        }
    }

    return {
        jumpToNextRunningSession: () => jump('all'),
        jumpToNextLocalRunningSession: () => jump('local'),
    };
}
