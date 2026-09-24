'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionDisposable } from '../aiSessions/types';

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
    cancel(): void;
}

export type PendingSessionAutoFollowOpenResult = 'opened' | 'empty' | 'retry';

export interface PendingSessionAutoFollowCoordinatorOptions {
    beginNavigationIntent(): number;
    getNavigationIntent(): number;
    openConversation(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<PendingSessionAutoFollowOpenResult>;
    previewConversation?(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): AiSessionDisposable | undefined;
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
    const earlyPromotions = new Map<string, {
        input: PromotedSessionNavigation;
        expiresAt: number;
    }>();
    const promoted = new Map<string, {
        projectId: string;
        navigationIdentity: string;
        provider: AiSessionProviderId;
        sessionId: string;
        intent: number;
        expiresAt: number;
        inFlight: boolean;
        preview?: AiSessionDisposable;
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
    const disposePreview = (
        tracked: { preview?: AiSessionDisposable }
    ): void => {
        try {
            tracked.preview?.dispose();
        } catch (_error) {
            // A cosmetic preview must never break navigation cleanup.
        }
        tracked.preview = undefined;
    };
    const deletePromoted = (key: string): void => {
        const tracked = promoted.get(key);
        if (tracked) {
            promoted.delete(key);
            disposePreview(tracked);
        }
    };
    const trim = <T>(entries: Map<string, T>, onDelete?: (value: T) => void): void => {
        while (entries.size > maxPending) {
            const oldest = entries.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            const value = entries.get(oldest);
            entries.delete(oldest);
            if (value) {
                onDelete?.(value);
            }
        }
    };
    const cleanupExpired = (): void => {
        const currentTime = now();
        for (const [key, tracked] of pending) {
            if (tracked.expiresAt <= currentTime) {
                pending.delete(key);
            }
        }
        for (const [key, tracked] of earlyPromotions) {
            if (tracked.expiresAt <= currentTime) {
                earlyPromotions.delete(key);
            }
        }
        for (const [key, tracked] of promoted) {
            if (tracked.expiresAt <= currentTime) {
                deletePromoted(key);
            }
        }
    };
    const promote = (
        key: string,
        input: PromotedSessionNavigation,
        tracked: {
            projectId: string;
            intent: number;
            expiresAt: number;
        }
    ): void => {
        const target = {
            projectId: tracked.projectId,
            provider: input.provider,
            sessionId: input.sessionId,
        };
        const ready = {
            ...target,
            navigationIdentity: input.navigationIdentity,
            intent: tracked.intent,
            expiresAt: tracked.expiresAt,
            inFlight: false,
            preview: undefined as AiSessionDisposable | undefined,
        };
        try {
            ready.preview = options.previewConversation?.(target);
        } catch (_error) {
            // Provider discovery must continue even if the cosmetic handoff
            // cannot be rendered in the currently open Viewer.
        }
        promoted.set(key, ready);
        trim(promoted, disposePreview);
    };
    const cancel = (): void => {
        pending.clear();
        earlyPromotions.clear();
        for (const tracked of promoted.values()) {
            disposePreview(tracked);
        }
        promoted.clear();
    };

    return {
        trackStarted(input): void {
            cleanupExpired();
            const key = keyOf(input);
            // Provider discovery can beat the post-create callback. Preserve
            // the exact promotion across the navigation-intent reset below,
            // then correlate it after the creation owns the new intent.
            const earlyPromotion = earlyPromotions.get(key);
            earlyPromotions.delete(key);
            const tracked = {
                projectId: input.projectId,
                intent: options.beginNavigationIntent(),
                expiresAt: now() + ttlMs,
            };
            if (earlyPromotion && earlyPromotion.expiresAt > now()) {
                promote(key, earlyPromotion.input, tracked);
                return;
            }
            pending.set(key, tracked);
            trim(pending);
        },
        trackPromoted(input): boolean {
            cleanupExpired();
            const key = keyOf(input);
            const tracked = pending.get(key);
            if (!tracked) {
                earlyPromotions.set(key, {
                    input: { ...input },
                    expiresAt: now() + ttlMs,
                });
                trim(earlyPromotions);
                return false;
            }
            pending.delete(key);
            if (tracked.expiresAt <= now()
                || tracked.intent !== options.getNavigationIntent()) {
                return false;
            }
            promote(key, input, tracked);
            return true;
        },
        async followReady(navigationIdentity): Promise<boolean> {
            cleanupExpired();
            const currentIntent = options.getNavigationIntent();
            const candidates = Array.from(promoted.entries())
                .filter(([, tracked]) =>
                    tracked.navigationIdentity === navigationIdentity);
            for (const [key, tracked] of candidates) {
                if (tracked.expiresAt <= now()
                    || tracked.intent !== currentIntent) {
                    deletePromoted(key);
                    continue;
                }
                if (tracked.inFlight) {
                    continue;
                }
                // Keep the entry registered while awaiting the provider read
                // so cancellation can restore the outgoing authoritative
                // document and concurrent hydration callers can coalesce.
                tracked.inFlight = true;
                let result: PendingSessionAutoFollowOpenResult = 'retry';
                try {
                    result = await options.openConversation({
                        projectId: tracked.projectId,
                        provider: tracked.provider,
                        sessionId: tracked.sessionId,
                    });
                } catch (_error) {
                    result = 'retry';
                }
                if (promoted.get(key) !== tracked) {
                    return false;
                }
                tracked.inFlight = false;
                if (tracked.expiresAt <= now()
                    || tracked.intent !== options.getNavigationIntent()) {
                    deletePromoted(key);
                    return false;
                }
                if (result === 'opened') {
                    deletePromoted(key);
                    return true;
                }
                // Empty sessions retain their one preflight frame until the
                // first interaction is readable. Other transient failures
                // also retry without reverting to the old authoritative chat.
            }
            return false;
        },
        cancel,
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
