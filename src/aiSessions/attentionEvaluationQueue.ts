'use strict';

import type { AiSessionLifecycleSignals } from './lifecycleSignalReader';

/**
 * How much work an attention evaluation should do.
 *
 * - `signals` recomputes attention from provider lifecycle signals that have
 *   already been read. It is cheap enough to run on every lifecycle tick.
 * - `runtimes` additionally reconciles persisted runtime ownership from disk,
 *   which costs a directory scan and is only affordable on a slow interval.
 */
export type AttentionEvaluationScope = 'signals' | 'runtimes';

export interface AttentionEvaluationRequest {
    scope: AttentionEvaluationScope;
    /**
     * The observation the execution pass used. Passing it through is what keeps
     * the running animation and the attention dot derived from the same read
     * rather than from two reads taken moments apart.
     */
    signals?: AiSessionLifecycleSignals;
}

export interface AttentionEvaluationQueueOptions {
    evaluate: (request: AttentionEvaluationRequest) => Promise<unknown>;
    onFailure?: (error: unknown) => void;
}

/**
 * Coalesces attention evaluation requests into a single in-flight run.
 *
 * Requests arrive in bursts, so they are folded into one drain loop that always
 * ends with an evaluation newer than the last request instead of stacking
 * overlapping evaluations. A batch runs at the widest scope anyone asked for, so
 * a cheap tick request never downgrades a pending runtime reconciliation, and it
 * carries the freshest signals offered so a coalesced batch never replays a
 * stale observation.
 */
export class AttentionEvaluationQueue {
    private draining: Promise<void> | null = null;
    private pending: AttentionEvaluationRequest | null = null;

    constructor(private readonly options: AttentionEvaluationQueueOptions) {
    }

    /** Resolves once an evaluation that observed this request has finished. */
    request(
        scope: AttentionEvaluationScope = 'signals',
        signals?: AiSessionLifecycleSignals
    ): Promise<void> {
        this.pending = {
            scope: scope === 'runtimes' || this.pending?.scope === 'runtimes' ? 'runtimes' : 'signals',
            ...(signals || this.pending?.signals
                ? { signals: signals || this.pending?.signals }
                : {}),
        };
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
            while (this.pending !== null) {
                const request = this.pending;
                this.pending = null;
                try {
                    await this.options.evaluate(request);
                } catch (error) {
                    this.options.onFailure?.(error);
                }
            }
        } finally {
            this.draining = null;
        }
    }
}
