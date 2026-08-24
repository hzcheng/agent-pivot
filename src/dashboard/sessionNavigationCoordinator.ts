'use strict';

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
