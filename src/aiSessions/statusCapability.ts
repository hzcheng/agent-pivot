'use strict';

import { AttentionEvaluationQueue } from './attentionEvaluationQueue';
import type { AttentionEvaluationScope } from './attentionEvaluationQueue';
import { AiSessionLifecycleSignalReader } from './lifecycleSignalReader';
import type {
    AiSessionLifecycleRequestsByProvider,
    AiSessionLifecycleSignalProvider,
    AiSessionLifecycleSignals,
} from './lifecycleSignalReader';

const LIFECYCLE_TICK_MS = 1_000;
const RUNTIME_RECONCILE_MS = 10_000;

export interface AiSessionStatusCapabilityOptions {
    getProviders: () => readonly AiSessionLifecycleSignalProvider[];
    /** Sessions each consumer needs signals for, merged into one read. */
    getLifecycleRequests: () => readonly AiSessionLifecycleRequestsByProvider[];
    evaluateExecution: (signals: AiSessionLifecycleSignals) => void;
    evaluateAttentionSignals: (signals: AiSessionLifecycleSignals) => Promise<unknown>;
    /** Also reconciles persisted runtime ownership from disk. */
    evaluateAttentionRuntimes: () => Promise<unknown>;
    onFailure: () => void;
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
}

export interface AiSessionStatusCapability {
    /** Reads provider signals once and drives both status passes from them. */
    tick(): void;
    requestAttentionEvaluation(scope: AttentionEvaluationScope): Promise<void>;
    dispose(): void;
}

/**
 * Owns the cadence that keeps the running animation and the attention dot in
 * step.
 *
 * Both surfaces are views of the same provider lifecycle signal, so they are
 * driven from a single read per tick rather than reading independently. The
 * slower interval carries the runtime reconciliation, which scans the tmux
 * binding directory and is too expensive for the fast path; it doubles as the
 * fallback for signals that never change the execution state.
 */
export function createAiSessionStatusCapability(
    options: AiSessionStatusCapabilityOptions
): AiSessionStatusCapability {
    const reader = new AiSessionLifecycleSignalReader({
        getProviders: options.getProviders,
        getRequests: options.getLifecycleRequests,
    });
    const attentionEvaluations = new AttentionEvaluationQueue({
        evaluate: request => request.scope === 'runtimes'
            ? options.evaluateAttentionRuntimes()
            : options.evaluateAttentionSignals(request.signals || reader.read()),
        onFailure: options.onFailure,
    });

    const tick = (): void => {
        const signals = reader.read();
        options.evaluateExecution(signals);
        void attentionEvaluations.request('signals', signals);
    };

    const handles = [
        options.setInterval(tick, LIFECYCLE_TICK_MS),
        options.setInterval(
            () => { void attentionEvaluations.request('runtimes'); },
            RUNTIME_RECONCILE_MS
        ),
    ];

    return {
        tick,
        requestAttentionEvaluation: scope => attentionEvaluations.request(scope),
        dispose: () => handles.forEach(handle => options.clearInterval(handle)),
    };
}
