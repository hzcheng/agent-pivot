'use strict';

import type { AiSessionProviderId } from '../models';

export type SessionNavigationTask = () => Promise<void>;

export interface SessionNavigationQueueTiming {
    event: 'started' | 'settled' | 'superseded';
    latest: boolean;
    queueMs: number;
    executionMs?: number;
    outcome?: 'succeeded' | 'failed';
}

export interface SessionNavigationCoordinator {
    enqueue(task: SessionNavigationTask): Promise<void>;
    /**
     * Enqueues a user navigation intent while retaining only the newest
     * not-yet-started intent. Running terminal work is allowed to settle so
     * runtime focus never interleaves, but stale queued hops cannot make a
     * rapid command sequence feel delayed or land on an obsolete target.
     */
    enqueueLatest(task: SessionNavigationTask): Promise<void>;
}

export interface SessionNavigationCoordinatorOptions {
    now?(): number;
    /** Receives aggregate timings only; no navigation target identity. */
    onTiming?(timing: SessionNavigationQueueTiming): void;
}

export interface StartedSessionNavigation {
    projectId: string;
    navigationIdentity: string;
    provider: AiSessionProviderId;
    pendingId: string;
}

export interface PromotedSessionNavigation {
    navigationIdentity: string;
    provider: AiSessionProviderId;
    pendingId: string;
    sessionId: string;
}

export interface PendingSessionAutoFollowCoordinator {
    trackStarted(input: StartedSessionNavigation): void;
    trackPromoted(input: PromotedSessionNavigation): boolean;
    followReady(navigationIdentity: string): Promise<boolean>;
}

export interface PendingSessionAutoFollowCoordinatorOptions {
    beginNavigationIntent(): number;
    getNavigationIntent(): number;
    openConversation(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<boolean>;
    maxPending?: number;
    now?(): number;
    ttlMs?: number;
}

/**
 * Bridges the creation-time pending id to the provider session id discovered
 * later. Only the latest still-current creation intent may move the UI: any
 * intervening explicit conversation navigation advances the shared intent and
 * makes the delayed promotion a quiet no-op.
 */
export function createPendingSessionAutoFollowCoordinator(
    options: PendingSessionAutoFollowCoordinatorOptions
): PendingSessionAutoFollowCoordinator {
    const maxPending = Math.max(1, options.maxPending ?? 64);
    const now = options.now || (() => Date.now());
    const ttlMs = Math.max(1, options.ttlMs ?? 5 * 60 * 1000);
    const pending = new Map<string, {
        projectId: string;
        intent: number;
        expiresAt: number;
    }>();
    const promoted = new Map<string, {
        projectId: string;
        navigationIdentity: string;
        provider: AiSessionProviderId;
        sessionId: string;
        intent: number;
        expiresAt: number;
    }>();
    const keyOf = (input: {
        navigationIdentity: string;
        provider: AiSessionProviderId;
        pendingId: string;
    }): string => JSON.stringify([
        input.navigationIdentity,
        input.provider,
        input.pendingId,
    ]);

    return {
        trackStarted(input): void {
            pending.set(keyOf(input), {
                projectId: input.projectId,
                intent: options.beginNavigationIntent(),
                expiresAt: now() + ttlMs,
            });
            while (pending.size > maxPending) {
                const oldest = pending.keys().next().value;
                if (typeof oldest !== 'string') {
                    break;
                }
                pending.delete(oldest);
            }
        },
        trackPromoted(input): boolean {
            const key = keyOf(input);
            const tracked = pending.get(key);
            pending.delete(key);
            if (!tracked || tracked.expiresAt <= now()
                || tracked.intent !== options.getNavigationIntent()) {
                return false;
            }
            promoted.set(key, {
                projectId: tracked.projectId,
                navigationIdentity: input.navigationIdentity,
                provider: input.provider,
                sessionId: input.sessionId,
                intent: tracked.intent,
                expiresAt: tracked.expiresAt,
            });
            return true;
        },
        async followReady(navigationIdentity): Promise<boolean> {
            const currentIntent = options.getNavigationIntent();
            const currentTime = now();
            const candidates = Array.from(promoted.entries())
                .filter(([, tracked]) =>
                    tracked.navigationIdentity === navigationIdentity);
            for (const [key, tracked] of candidates) {
                if (tracked.expiresAt <= currentTime
                    || tracked.intent !== currentIntent) {
                    promoted.delete(key);
                    continue;
                }
                // Claim the retry before awaiting the provider read. Several
                // hydration callers can share one promotion drain and settle
                // together; none of them may open the same chat twice.
                promoted.delete(key);
                let opened = false;
                try {
                    opened = await options.openConversation({
                        projectId: tracked.projectId,
                        provider: tracked.provider,
                        sessionId: tracked.sessionId,
                    });
                } catch (_error) {
                    if (tracked.expiresAt > now()
                        && tracked.intent === options.getNavigationIntent()) {
                        promoted.set(key, tracked);
                    }
                    return false;
                }
                if (opened) {
                    return true;
                }
                if (tracked.expiresAt > now()
                    && tracked.intent === options.getNavigationIntent()) {
                    promoted.set(key, tracked);
                }
            }
            return false;
        },
    };
}

/**
 * Owns the ordering of every user-visible AI session navigation transaction
 * in one extension host. A failed transaction does not poison later commands,
 * while a later command never starts before the earlier transaction settles.
 */
export function createSessionNavigationCoordinator(
    options: SessionNavigationCoordinatorOptions = {}
): SessionNavigationCoordinator {
    interface QueuedTask {
        task: SessionNavigationTask;
        resolve(): void;
        reject(error: unknown): void;
        latest: boolean;
        queuedAt: number;
    }

    const queue: QueuedTask[] = [];
    let running = false;
    const now = options.now || (() => Date.now());
    const report = (timing: SessionNavigationQueueTiming): void => {
        try {
            options.onTiming?.(timing);
        } catch (_error) {
            // Diagnostics must not affect user navigation.
        }
    };

    const runNext = (): void => {
        const next = queue.shift();
        if (!next) {
            running = false;
            return;
        }
        running = true;
        const startedAt = now();
        const queueMs = Math.max(0, startedAt - next.queuedAt);
        report({ event: 'started', latest: next.latest, queueMs });
        void Promise.resolve()
            .then(next.task)
            .then(
                () => {
                    next.resolve();
                    report({
                        event: 'settled',
                        latest: next.latest,
                        queueMs,
                        executionMs: Math.max(0, now() - startedAt),
                        outcome: 'succeeded',
                    });
                },
                error => {
                    next.reject(error);
                    report({
                        event: 'settled',
                        latest: next.latest,
                        queueMs,
                        executionMs: Math.max(0, now() - startedAt),
                        outcome: 'failed',
                    });
                },
            )
            .then(runNext);
    };

    const add = (task: SessionNavigationTask, latest: boolean): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            if (latest) {
                // Preserve ordinary queued work, but replace older pending
                // navigation intents. Their callers see a settled no-op;
                // only the final requested target runs after the current
                // transaction has safely finished.
                for (let index = queue.length - 1; index >= 0; index -= 1) {
                    if (queue[index].latest) {
                        const superseded = queue.splice(index, 1)[0];
                        superseded.resolve();
                        report({
                            event: 'superseded',
                            latest: true,
                            queueMs: Math.max(0, now() - superseded.queuedAt),
                        });
                    }
                }
            }
            queue.push({ task, resolve, reject, latest, queuedAt: now() });
            if (!running) {
                runNext();
            }
        });

    return {
        enqueue: task => add(task, false),
        enqueueLatest: task => add(task, true),
    };
}
