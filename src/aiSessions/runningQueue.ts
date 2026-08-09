'use strict';

import type { AiSessionProviderId } from '../models';

export interface RunningSessionQueueLocalInput {
    provider: AiSessionProviderId;
    sessionId: string;
    name?: string;
}

export interface RunningSessionQueueRemoteInput {
    cardId: string;
    navigationIdentity: string;
    displayName: string;
    runningSessionCount: number;
}

export interface RunningSessionQueueLocalItem {
    kind: 'local';
    key: string;
    provider: AiSessionProviderId;
    sessionId: string;
    sessionName?: string;
}

export interface RunningSessionQueueRemoteItem {
    kind: 'remote';
    key: string;
    cardId: string;
    navigationIdentity: string;
    displayName: string;
    runningSessionCount: number;
}

export type RunningSessionQueueItem =
    RunningSessionQueueLocalItem | RunningSessionQueueRemoteItem;

export interface RunningSessionQueue {
    items: RunningSessionQueueItem[];
    localCount: number;
    remoteCount: number;
    total: number;
}

/**
 * Builds the round-robin queue for the next-running-session command. Local
 * running sessions lead (mirroring the attention queue) so a press always
 * visits this window's working sessions before hopping to another window;
 * remote entries stand in for windows that reported at least one running
 * session. Both groups sort by an immutable key so refreshes never reshuffle
 * the cycle under the user's finger.
 *
 * When the current window's navigation identity is known, the remote group
 * rotates to start with the window that follows it in the sorted order. Every
 * window then holds the same rotation of the global window cycle, so a jump
 * chain continues A → B → C → A instead of bouncing back to the window the
 * user just came from.
 */
export function buildRunningSessionQueue(input: {
    localSessions: readonly RunningSessionQueueLocalInput[];
    remoteWindows: readonly RunningSessionQueueRemoteInput[];
    selfNavigationIdentity?: string;
}): RunningSessionQueue {
    const locals: RunningSessionQueueLocalItem[] = [];
    const seenSessions = new Set<string>();
    for (const session of input.localSessions || []) {
        if (!session
            || (session.provider !== 'codex'
                && session.provider !== 'kimi'
                && session.provider !== 'claude')
            || typeof session.sessionId !== 'string'
            || !session.sessionId) {
            continue;
        }
        const key = `session:${session.provider}:${session.sessionId}`;
        if (seenSessions.has(key)) {
            continue;
        }
        seenSessions.add(key);
        locals.push({
            kind: 'local',
            key,
            provider: session.provider,
            sessionId: session.sessionId,
            ...(session.name ? { sessionName: session.name } : {}),
        });
    }
    locals.sort((left, right) => left.key.localeCompare(right.key));
    const remotes: RunningSessionQueueRemoteItem[] = [];
    const seenWindows = new Set<string>();
    for (const window of input.remoteWindows || []) {
        if (!window
            || typeof window.navigationIdentity !== 'string'
            || !window.navigationIdentity
            || typeof window.cardId !== 'string'
            || !window.cardId
            || !Number.isSafeInteger(window.runningSessionCount)
            || window.runningSessionCount < 1) {
            continue;
        }
        const key = `window:${window.navigationIdentity}`;
        if (seenWindows.has(key)) {
            continue;
        }
        seenWindows.add(key);
        remotes.push({
            kind: 'remote',
            key,
            cardId: window.cardId,
            navigationIdentity: window.navigationIdentity,
            displayName: typeof window.displayName === 'string' ? window.displayName : '',
            runningSessionCount: window.runningSessionCount,
        });
    }
    remotes.sort((left, right) => left.key.localeCompare(right.key));
    if (typeof input.selfNavigationIdentity === 'string'
        && input.selfNavigationIdentity
        && remotes.length > 1) {
        const selfKey = `window:${input.selfNavigationIdentity}`;
        const split = remotes.findIndex(item => item.key > selfKey);
        if (split > 0) {
            remotes.push(...remotes.splice(0, split));
        }
    }
    const items: RunningSessionQueueItem[] = [...locals, ...remotes];
    return {
        items,
        localCount: locals.length,
        remoteCount: remotes.length,
        total: items.length,
    };
}

/**
 * Picks the entry after `lastKey`, wrapping at the end of the queue. A
 * vanished cursor (session stopped, window closed) falls back to
 * `currentKey` — the currently focused session — so a press continues from
 * where the user is instead of re-landing on the head of the queue; without
 * either anchor the cycle restarts at the head, keeping it deterministic. A
 * hop that would land back on the focused session skips one more entry, so a
 * press always moves when another target exists.
 */
export function getNextRunningSessionQueueItem(
    items: readonly RunningSessionQueueItem[],
    lastKey: string | null,
    currentKey: string | null = null,
): RunningSessionQueueItem | null {
    if (!items.length) {
        return null;
    }
    const lastIndex = lastKey
        ? items.findIndex(item => item.key === lastKey)
        : -1;
    if (lastIndex !== -1) {
        const next = items[(lastIndex + 1) % items.length];
        if (currentKey && next.key === currentKey && items.length > 1) {
            return items[(lastIndex + 2) % items.length];
        }
        return next;
    }
    const currentIndex = currentKey
        ? items.findIndex(item => item.key === currentKey)
        : -1;
    return currentIndex === -1
        ? items[0]
        : items[(currentIndex + 1) % items.length];
}
