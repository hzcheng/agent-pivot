'use strict';

import {
    getNextRunningSessionQueueItem,
    RunningSessionQueue,
    RunningSessionQueueItem,
    RunningSessionQueueLocalItem,
    RunningSessionQueueRemoteItem,
} from '../aiSessions/runningQueue';
import {
    createSessionNavigationCoordinator,
    SessionNavigationCoordinator,
} from './sessionNavigationCoordinator';
import type {
    SessionNavigationFocusExecutionOptions,
    SessionNavigationFocusResult,
} from './sessionNavigationFocusExecutor';

interface RunningSessionJumpBaseOptions {
    navigationCoordinator?: SessionNavigationCoordinator;
    nowMs?: () => number;
    buildQueue: () => RunningSessionQueue;
    requestRemoteFocus: (item: RunningSessionQueueRemoteItem) => Promise<boolean>;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
    /** Key of the session the user is currently looking at, when known. */
    getCurrentKey?: () => string | null;
}

export type RunningSessionJumpOptions = RunningSessionJumpBaseOptions & (
    {
        navigateSession: (
            item: RunningSessionQueueLocalItem,
            executionOptions: SessionNavigationFocusExecutionOptions,
        ) => Promise<SessionNavigationFocusResult>;
        focusSession?: never;
        openConversation?: never;
    }
    | {
        navigateSession?: never;
        focusSession: (item: RunningSessionQueueLocalItem) => Promise<boolean>;
        openConversation: (item: RunningSessionQueueLocalItem) => Promise<void>;
    }
);

export interface RunningSessionJumpHandler {
    jumpToNextRunningSession(): Promise<void>;
    jumpToNextLocalRunningSession(handoff?: RunningSessionFocusHandoff): Promise<void>;
}

export interface RunningSessionFocusHandoff {
    sourceNavigationIdentity: string;
    targetNavigationIdentity: string;
    createdAtMs: number;
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
 * A delivered hand-off also records its authoritative target window. If a
 * temporarily incomplete snapshot cannot rotate the remote queue itself, the
 * handler still selects the target's stable successor for any ring size.
 *
 * The cursor advances even when a jump fails, so a session that ended
 * mid-cycle is skipped by the next press instead of trapping the user on a
 * dead target.
 */
export function createRunningSessionJumpHandler(
    options: RunningSessionJumpOptions
): RunningSessionJumpHandler {
    // Cross-window navigation and within-window session rotation advance at
    // different rates, so neither cursor may overwrite the other.
    let lastKey: string | null = null;
    let lastLocalKey: string | null = null;
    let lastObservedCurrentKey: string | null = null;
    let handoffTargetKey: string | null = null;
    let lastDirectInvocationAtMs = Number.NEGATIVE_INFINITY;
    const navigationCoordinator = options.navigationCoordinator
        || createSessionNavigationCoordinator();
    const nowMs = options.nowMs || (() => Date.now());

    async function jumpToLocal(item: RunningSessionQueueLocalItem): Promise<void> {
        const result = options.navigateSession
            ? await options.navigateSession(item, {
                onFocused: () => {
                    lastKey = item.key;
                    lastLocalKey = item.key;
                    lastObservedCurrentKey = item.key;
                },
            })
            : await navigateWithLegacyCallbacks(item, {
                onFocused: () => {
                    lastKey = item.key;
                    lastLocalKey = item.key;
                    lastObservedCurrentKey = item.key;
                },
            });
        if (!result.focused) {
            lastKey = item.key;
            lastLocalKey = item.key;
            options.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
            return;
        }
    }

    async function navigateWithLegacyCallbacks(
        item: RunningSessionQueueLocalItem,
        executionOptions: SessionNavigationFocusExecutionOptions,
    ): Promise<SessionNavigationFocusResult> {
        if (!options.focusSession || !options.openConversation) {
            throw new Error('Running navigation requires one local execution strategy');
        }
        const focused = await options.focusSession(item);
        if (!focused) {
            return { focused: false, conversationOpened: false };
        }
        executionOptions.onFocused?.();
        await options.openConversation(item);
        return { focused: true, conversationOpened: true };
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

    async function jump(
        scope: 'all' | 'local',
        handoff?: RunningSessionFocusHandoff,
    ): Promise<void> {
        if (scope === 'local' && handoff) {
            handoffTargetKey = `window:${handoff.targetNavigationIdentity}`;
        }
        const advancesLocalCursor = Boolean(
            handoff && handoff.createdAtMs > lastDirectInvocationAtMs
        );
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
        const current = currentKey
            ? items.find(item => item.key === currentKey) || null
            : null;
        const currentChanged = current !== null
            && current.key !== lastObservedCurrentKey;
        lastObservedCurrentKey = current?.key || null;
        const cursorKey = currentChanged
            ? null
            : scope === 'local'
                ? advancesLocalCursor
                    ? lastLocalKey
                    : lastKey
                : lastKey;
        let next = scope === 'local'
            && current?.kind === 'local'
            && (!advancesLocalCursor || cursorKey === null)
            ? current
            : getNextRunningSessionQueueItem(items, cursorKey, currentKey);
        if (scope === 'all'
            && next?.kind === 'remote'
            && handoffTargetKey) {
            const targetKey = handoffTargetKey;
            const remotes = items
                .filter((item): item is RunningSessionQueueRemoteItem => item.kind === 'remote')
                .sort((left, right) => left.key.localeCompare(right.key));
            next = remotes.find(item => item.key > targetKey) || remotes[0] || next;
        }
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
        jumpToNextRunningSession: () => {
            lastDirectInvocationAtMs = Math.max(lastDirectInvocationAtMs, nowMs());
            // This is a relative operation: every key press advances one
            // place from the cursor that the preceding operation establishes.
            // It therefore must remain lossless rather than latest-wins.
            return navigationCoordinator.enqueue(() => jump('all'));
        },
        jumpToNextLocalRunningSession: handoff =>
            // A bridge hand-off names one exact remote request. The source
            // may switch windows as soon as this resolves, so it cannot be
            // coalesced into a successful no-op.
            navigationCoordinator.enqueue(() => jump('local', handoff)),
    };
}
