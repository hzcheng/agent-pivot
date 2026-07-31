'use strict';

/**
 * How much work an attention evaluation should do.
 *
 * - `signals` recomputes attention from provider lifecycle signals that have
 *   already been read. It is cheap enough to run on every lifecycle edge.
 * - `runtimes` additionally reconciles persisted runtime ownership from disk,
 *   which costs a directory scan and is only affordable on a slow interval.
 */
export type AttentionEvaluationScope = 'signals' | 'runtimes';

export interface AttentionEvaluationQueueOptions {
    evaluate: (scope: AttentionEvaluationScope) => Promise<unknown>;
    onFailure?: (error: unknown) => void;
}

/**
 * Coalesces attention evaluation requests into a single in-flight run.
 *
 * Attention used to be recomputed only by a slow fallback interval, which let the
 * red dot survive for seconds after the running animation had already started.
 * Edge triggers fix that, but they also arrive in bursts, so requests are folded
 * into one drain loop that always ends with an evaluation newer than the last
 * request instead of stacking overlapping evaluations. A batch runs at the widest
 * scope anyone asked for, so a cheap edge request never downgrades a pending
 * runtime reconciliation.
 */
export class AttentionEvaluationQueue {
    private draining: Promise<void> | null = null;
    private pendingScope: AttentionEvaluationScope | null = null;

    constructor(private readonly options: AttentionEvaluationQueueOptions) {
    }

    /** Resolves once an evaluation that observed this request has finished. */
    request(scope: AttentionEvaluationScope = 'signals'): Promise<void> {
        if (scope === 'runtimes' || this.pendingScope === null) {
            this.pendingScope = scope;
        }
        if (!this.draining) {
            this.draining = this.drain();
        }
        return this.draining;
    }

    isIdle(): boolean {
        return !this.draining;
    }

    private async drain(): Promise<void> {
        try {
            while (this.pendingScope !== null) {
                const scope = this.pendingScope;
                this.pendingScope = null;
                try {
                    await this.options.evaluate(scope);
                } catch (error) {
                    this.options.onFailure?.(error);
                }
            }
        } finally {
            this.draining = null;
        }
    }
}
