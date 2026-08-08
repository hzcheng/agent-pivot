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
 */
export function buildRunningSessionQueue(input: {
    localSessions: readonly RunningSessionQueueLocalInput[];
    remoteWindows: readonly RunningSessionQueueRemoteInput[];
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
 * vanished cursor (session stopped, window closed) restarts at the head so
 * the cycle stays deterministic.
 */
export function getNextRunningSessionQueueItem(
    items: readonly RunningSessionQueueItem[],
    lastKey: string | null,
): RunningSessionQueueItem | null {
    if (!items.length) {
        return null;
    }
    const index = lastKey
        ? items.findIndex(item => item.key === lastKey)
        : -1;
    return index === -1
        ? items[0]
        : items[(index + 1) % items.length];
}
