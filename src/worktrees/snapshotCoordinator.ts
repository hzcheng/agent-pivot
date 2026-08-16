'use strict';

import type {
    WorktreeSnapshot,
    WorktreeSnapshotContent,
    WorktreeSnapshotState,
} from './types';
import { GitWorktreeDiscoveryError } from './gitWorktreeDiscovery';

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_VISIBLE_TTL_MS = 30_000;

interface DisposableLike {
    dispose(): void;
}

type TimerHandle = unknown;

export interface WorktreeSnapshotCoordinatorOptions {
    load: () => Promise<WorktreeSnapshotContent>;
    debounceMs?: number;
    visibleTtlMs?: number;
    setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimeout?: (handle: TimerHandle) => void;
}

/**
 * Owns background worktree discovery and publishes only coherent generations.
 * Invalidations that arrive during a load make that result stale and trigger a
 * single follow-up load; callers never observe an out-of-date partial result.
 */
export class WorktreeSnapshotCoordinator implements DisposableLike {
    private state: WorktreeSnapshotState = Object.freeze({ kind: 'uninitialized' });
    private lastGoodSnapshot: WorktreeSnapshot | undefined;
    private revision = 0;
    private requestedGeneration = 0;
    private settledGeneration = 0;
    private inFlight = false;
    private visible = false;
    private disposed = false;
    private debounceTimer: TimerHandle | undefined;
    private ttlTimer: TimerHandle | undefined;
    private readonly listeners = new Set<(state: WorktreeSnapshotState) => void>();
    private readonly waiters: Array<{ generation: number; resolve: () => void }> = [];
    private readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
    private readonly clearTimeout: (handle: TimerHandle) => void;

    constructor(private readonly options: WorktreeSnapshotCoordinatorOptions) {
        this.setTimeout = options.setTimeout || ((callback, delayMs) =>
            setTimeout(callback, delayMs));
        this.clearTimeout = options.clearTimeout || (handle =>
            clearTimeout(handle as NodeJS.Timeout));
    }

    getState(): WorktreeSnapshotState {
        return this.state;
    }

    getSnapshot(): WorktreeSnapshot | null {
        if (this.state.kind === 'ready') {
            return this.state.snapshot;
        }
        if (this.state.kind === 'error') {
            return this.state.lastGoodSnapshot || null;
        }
        return this.lastGoodSnapshot || null;
    }

    onDidChange(listener: (state: WorktreeSnapshotState) => void): DisposableLike {
        if (this.disposed) {
            return { dispose: () => undefined };
        }
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    start(): Promise<void> {
        return this.refresh('startup');
    }

    invalidate(_reason: string): void {
        if (this.disposed) {
            return;
        }
        this.requestedGeneration += 1;
        this.publishRefreshingState();
        this.scheduleDebouncedLoad();
    }

    refresh(_reason = 'manual'): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        this.requestedGeneration += 1;
        const generation = this.requestedGeneration;
        this.publishRefreshingState();
        this.cancelDebounce();
        void this.beginLoad();
        return new Promise(resolve => {
            if (this.settledGeneration >= generation || this.disposed) {
                resolve();
                return;
            }
            this.waiters.push({ generation, resolve });
        });
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) {
            return;
        }
        this.visible = visible;
        this.cancelTtl();
        if (visible) {
            this.refresh('visible');
            this.scheduleTtl();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.cancelDebounce();
        this.cancelTtl();
        this.listeners.clear();
        for (const waiter of this.waiters.splice(0)) {
            waiter.resolve();
        }
    }

    private scheduleDebouncedLoad(): void {
        if (this.inFlight || this.debounceTimer !== undefined) {
            return;
        }
        const delayMs = Math.max(0, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
        this.debounceTimer = this.setTimeout(() => {
            this.debounceTimer = undefined;
            void this.beginLoad();
        }, delayMs);
    }

    private async beginLoad(): Promise<void> {
        if (this.disposed || this.inFlight) {
            return;
        }
        this.inFlight = true;
        const generation = this.requestedGeneration;
        this.publishLoadingState();
        try {
            const content = await this.options.load();
            if (!this.disposed && generation === this.requestedGeneration) {
                this.revision = nextRevision(this.revision);
                const snapshot = freezeSnapshot(content, this.revision);
                this.lastGoodSnapshot = snapshot;
                this.settledGeneration = generation;
                this.publish(Object.freeze({
                    kind: 'ready',
                    snapshot,
                    refreshing: false,
                }));
                this.resolveWaiters();
            }
        } catch (error) {
            if (!this.disposed && generation === this.requestedGeneration) {
                this.settledGeneration = generation;
                this.publish(Object.freeze({
                    kind: 'error',
                    message: errorMessage(error),
                    ...(this.lastGoodSnapshot
                        ? { lastGoodSnapshot: this.lastGoodSnapshot }
                        : {}),
                    retryable: !(error instanceof GitWorktreeDiscoveryError)
                        || error.retryable,
                }));
                this.resolveWaiters();
            }
        } finally {
            this.inFlight = false;
            if (!this.disposed && generation !== this.requestedGeneration) {
                void this.beginLoad();
            }
        }
    }

    private publishRefreshingState(): void {
        if (this.lastGoodSnapshot) {
            this.publish(Object.freeze({
                kind: 'ready',
                snapshot: this.lastGoodSnapshot,
                refreshing: true,
            }));
        }
    }

    private publishLoadingState(): void {
        if (this.lastGoodSnapshot) {
            this.publish(Object.freeze({
                kind: 'ready',
                snapshot: this.lastGoodSnapshot,
                refreshing: true,
            }));
        } else {
            this.publish(Object.freeze({ kind: 'loading' }));
        }
    }

    private publish(state: WorktreeSnapshotState): void {
        this.state = state;
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(state);
            } catch (_error) {
                // A presentation listener must not break snapshot authority.
            }
        }
    }

    private scheduleTtl(): void {
        if (!this.visible || this.disposed) {
            return;
        }
        const delayMs = Math.max(1, this.options.visibleTtlMs ?? DEFAULT_VISIBLE_TTL_MS);
        this.ttlTimer = this.setTimeout(() => {
            this.ttlTimer = undefined;
            if (!this.visible || this.disposed) {
                return;
            }
            this.invalidate('visible-ttl');
            this.scheduleTtl();
        }, delayMs);
    }

    private cancelDebounce(): void {
        if (this.debounceTimer !== undefined) {
            this.clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }

    private cancelTtl(): void {
        if (this.ttlTimer !== undefined) {
            this.clearTimeout(this.ttlTimer);
            this.ttlTimer = undefined;
        }
    }

    private resolveWaiters(): void {
        for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
            if (this.waiters[index].generation <= this.settledGeneration) {
                const [waiter] = this.waiters.splice(index, 1);
                waiter.resolve();
            }
        }
    }
}

function nextRevision(revision: number): number {
    if (revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Worktree snapshot revision exhausted.');
    }
    return revision + 1;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message.slice(0, 1024);
    }
    return 'Worktree discovery failed.';
}

function freezeSnapshot(content: WorktreeSnapshotContent, revision: number): WorktreeSnapshot {
    const repositories = content.repositories.map(repository => Object.freeze({
        repositoryKey: repository.repositoryKey,
        rootBindings: Object.freeze(repository.rootBindings.map(binding => Object.freeze({ ...binding }))),
        ...(repository.baseRef ? { baseRef: repository.baseRef } : {}),
        worktrees: Object.freeze(repository.worktrees.map(worktree => Object.freeze({
            ...worktree,
            key: Object.freeze({ ...worktree.key }),
        }))),
    }));
    return Object.freeze({
        revision,
        repositories: Object.freeze(repositories),
        truncatedWorktreeCount: content.truncatedWorktreeCount,
    });
}
