'use strict';

export type SessionNavigationTask = () => Promise<void>;

export interface SessionNavigationCoordinator {
    enqueue(task: SessionNavigationTask): Promise<void>;
}

/**
 * Owns the ordering of every user-visible AI session navigation transaction
 * in one extension host. A failed transaction does not poison later commands,
 * while a later command never starts before the earlier transaction settles.
 */
export function createSessionNavigationCoordinator(): SessionNavigationCoordinator {
    let tail: Promise<void> = Promise.resolve();
    return {
        enqueue(task: SessionNavigationTask): Promise<void> {
            const result = tail.then(task, task);
            tail = result.then(() => undefined, () => undefined);
            return result;
        },
    };
}
