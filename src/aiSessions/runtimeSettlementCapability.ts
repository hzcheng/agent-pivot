'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../models';
import type { AiSessionAttentionEvaluation } from './attentionController';
import { getAttentionRuntimeSessionKey } from '../attentionSessionKeys';
import { cloneAiSessionRuntimeIdentity } from './runtimeTypes';
import type { AiSessionRuntimeSnapshot } from './runtimeTypes';
import type AiSessionTerminalService from './terminalService';
import type { TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';

type RuntimeLifecycleCandidate = AiSessionRuntimeLifecycleCandidate & {
    runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
};

export interface RuntimeSettlementAttentionOverride {
    providerId: AiSessionProviderId;
    sessionId: string;
    attentionKey: string;
    runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
}

export interface AiSessionRuntimeSettlementCapabilityOptions {
    runtimeBelongsToCurrentWorkspace: (
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>
    ) => boolean;
    evaluateAttention: (
        runtimeOverrides: readonly RuntimeSettlementAttentionOverride[]
    ) => Promise<AiSessionAttentionEvaluation>;
    tmuxRuntimeDiscovery: TmuxRuntimeDiscovery;
    aiSessionTerminalService: AiSessionTerminalService;
    refreshAiSessionViewsIncrementally: () => void;
    /** Late-bound: the highlighter is constructed after this capability. */
    syncActiveTerminalHighlighter: () => void;
    logDiagnostic: (event: Record<string, unknown>) => void;
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
}

export interface AiSessionRuntimeSettlementCapability {
    /** Runs a runtime lifecycle task with the shared named-reason failure reporting. */
    runSafeLifecycleTask(
        operation: string,
        task: () => unknown | Promise<unknown>
    ): Promise<void>;
    /** Queues completed/stopped runtimes of the current workspace for settlement. */
    queueSettlements(runtimes: readonly AiSessionRuntimeSnapshot<vscode.Terminal>[]): void;
    /** Starts the 1s completed-runtime settlement scan. Idempotent. */
    startSettlementScan(): void;
    dispose(): void;
}

/**
 * Owns the AI session runtime settlement queue: completed and stopped runtimes
 * are coalesced by attention key, drained in key order through
 * settleAiSessionRuntimeLifecycles, and released against their backend, while
 * the 1s scan feeds the queue from the terminal service and tmux discovery.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts (see the session
 * status capability for the cadence pattern). Behaviour is unchanged: the
 * queue keys, drain order, in-flight semantics, failure reporting, and scan
 * interval are the same; only their ownership moved.
 */
export function createAiSessionRuntimeSettlementCapability(
    options: AiSessionRuntimeSettlementCapabilityOptions
): AiSessionRuntimeSettlementCapability {
    const runtimeBelongsToCurrentWorkspace = options.runtimeBelongsToCurrentWorkspace;
    const evaluateAiSessionAttention = options.evaluateAttention;
    const tmuxRuntimeDiscovery = options.tmuxRuntimeDiscovery;
    const aiSessionTerminalService = options.aiSessionTerminalService;
    const refreshAiSessionViewsIncrementally = options.refreshAiSessionViewsIncrementally;
    const syncActiveTerminalHighlighter = options.syncActiveTerminalHighlighter;
    const logAiSessionDiagnostic = options.logDiagnostic;

    const queuedAiSessionRuntimeSettlements = new Map<string, RuntimeLifecycleCandidate>();
    const settlingAiSessionRuntimeKeys = new Set<string>();
    let aiSessionRuntimeSettlementInFlight: Promise<void> | null = null;
    const runSafeAiSessionRuntimeLifecycleTask = (
        operation: string,
        task: () => unknown | Promise<unknown>
    ): Promise<void> => runAiSessionRuntimeLifecycleTask(
        operation,
        task,
        (failedOperation, category) => logAiSessionDiagnostic({
            event: 'runtime-lifecycle-task-failed',
            operation: failedOperation,
            category,
        })
    );
    const queueAiSessionRuntimeSettlements = (
        runtimes: readonly AiSessionRuntimeSnapshot<vscode.Terminal>[]
    ): void => {
        for (const runtime of runtimes) {
            if (!runtimeBelongsToCurrentWorkspace(runtime)) {
                continue;
            }
            const sessionId = runtime.identity.sessionId;
            if (!sessionId || (runtime.state !== 'completed' && runtime.state !== 'stopped')) {
                continue;
            }
            const key = getAttentionRuntimeSessionKey({
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                provider: runtime.identity.provider,
                sessionId,
                runStartedAtMs: runtime.runStartedAtMs,
                backend: runtime.backend,
            });
            if (settlingAiSessionRuntimeKeys.has(key)) {
                continue;
            }
            queuedAiSessionRuntimeSettlements.set(key, {
                key,
                sessionKey: key,
                state: runtime.state,
                runtime: {
                    ...runtime,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                },
            });
        }
        if (!aiSessionRuntimeSettlementInFlight && queuedAiSessionRuntimeSettlements.size) {
            aiSessionRuntimeSettlementInFlight = runSafeAiSessionRuntimeLifecycleTask(
                'settle-runtime-lifecycles',
                drainAiSessionRuntimeSettlements
            );
        }
    };
    const drainAiSessionRuntimeSettlements = async (): Promise<void> => {
        try {
            while (queuedAiSessionRuntimeSettlements.size) {
                const candidates = [...queuedAiSessionRuntimeSettlements.values()]
                    .sort((left, right) => left.key.localeCompare(right.key));
                queuedAiSessionRuntimeSettlements.clear();
                candidates.forEach(candidate => settlingAiSessionRuntimeKeys.add(candidate.key));
                try {
                    const settled = await settleAiSessionRuntimeLifecycles({
                        candidates: candidates,
                        evaluateAttention: () => evaluateAiSessionAttention(
                            candidates.map(candidate => ({
                                providerId: candidate.runtime.identity.provider,
                                sessionId: candidate.runtime.identity.sessionId as string,
                                attentionKey: candidate.key,
                                runtime: candidate.runtime,
                            }))
                        ),
                        release: async candidate => {
                            if (candidate.runtime.backend === 'tmux') {
                                const acknowledgement = await tmuxRuntimeDiscovery
                                    .acknowledgeInactive(candidate.runtime);
                                if (acknowledgement === 'stale') {
                                    throw new Error('The tmux lifecycle acknowledgement became stale.');
                                }
                                return;
                            }
                            aiSessionTerminalService.releaseCompletedSession(
                                candidate.runtime.identity.provider,
                                candidate.runtime.identity.sessionId as string,
                                candidate.runtime.identity.workspaceScopeIdentity
                            );
                        },
                        reportFailure: (operation, category, key) => logAiSessionDiagnostic({
                            event: 'runtime-lifecycle-settlement-failed',
                            operation,
                            category,
                            hasRuntimeKey: Boolean(key),
                        }),
                    });
                    if (settled.releasedKeys.length) {
                        refreshAiSessionViewsIncrementally();
                        syncActiveTerminalHighlighter();
                    }
                } finally {
                    candidates.forEach(candidate => settlingAiSessionRuntimeKeys.delete(candidate.key));
                }
            }
        } catch (_error) {
            logAiSessionDiagnostic({
                event: 'runtime-lifecycle-settlement-failed',
                operation: 'drain',
                category: 'unexpected',
            });
        } finally {
            aiSessionRuntimeSettlementInFlight = null;
            if (queuedAiSessionRuntimeSettlements.size) {
                queueAiSessionRuntimeSettlements([]);
            }
        }
    };

    let settlementScanHandle: unknown;
    const startSettlementScan = (): void => {
        if (settlementScanHandle !== undefined) {
            return;
        }
        settlementScanHandle = options.setInterval(() => {
            const completedSessions = aiSessionTerminalService.getCompletedSessions();
            const completedRuntimes = completedSessions.filter(resolution =>
                !!resolution.entry.runtimeIdentity).map(resolution => ({
                    identity: cloneAiSessionRuntimeIdentity(resolution.entry.runtimeIdentity),
                    backend: 'vscode',
                    state: 'completed',
                    markerPath: resolution.entry.markerPath,
                    runStartedAtMs: resolution.entry.runStartedAtMs,
                    attached: true,
                    terminal: resolution.terminal,
                } as AiSessionRuntimeSnapshot<vscode.Terminal>));
            const inactiveTmuxRuntimes = tmuxRuntimeDiscovery.getInactive()
                .map(runtime => runtime as AiSessionRuntimeSnapshot<vscode.Terminal>);
            queueAiSessionRuntimeSettlements([...completedRuntimes, ...inactiveTmuxRuntimes]);
        }, 1_000);
    };

    return {
        runSafeLifecycleTask: runSafeAiSessionRuntimeLifecycleTask,
        queueSettlements: queueAiSessionRuntimeSettlements,
        startSettlementScan,
        dispose: () => {
            if (settlementScanHandle !== undefined) {
                options.clearInterval(settlementScanHandle);
                settlementScanHandle = undefined;
            }
        },
    };
}
export interface AiSessionRuntimeLifecycleCandidate {
    key: string;
    sessionKey?: string;
    state: 'completed' | 'stopped';
}

export type AiSessionRuntimeLifecycleFailureOperation = 'evaluate' | 'release';

export interface SettleAiSessionRuntimeLifecyclesOptions<TCandidate extends AiSessionRuntimeLifecycleCandidate> {
    candidates: readonly TCandidate[];
    evaluateAttention: () => Promise<AiSessionAttentionEvaluation>;
    release: (candidate: TCandidate) => void | Promise<void>;
    reportFailure?: (
        operation: AiSessionRuntimeLifecycleFailureOperation,
        category: 'unexpected',
        key: string | undefined
    ) => void;
}

export interface AiSessionRuntimeLifecycleSettlementResult {
    releasedKeys: string[];
    retainedKeys: string[];
}

export function runAiSessionRuntimeLifecycleTask(
    operation: string,
    task: () => unknown | Promise<unknown>,
    reportFailure: (operation: string, category: 'unexpected') => unknown | Promise<unknown>
): Promise<void> {
    return Promise.resolve().then(task).then(() => undefined, async () => {
        try {
            await reportFailure(operation, 'unexpected');
        } catch (_reportError) {
            // A diagnostic reporter must not escape the safe lifecycle boundary.
        }
    });
}

export async function settleAiSessionRuntimeLifecycles<
    TCandidate extends AiSessionRuntimeLifecycleCandidate
>(
    options: SettleAiSessionRuntimeLifecyclesOptions<TCandidate>
): Promise<AiSessionRuntimeLifecycleSettlementResult> {
    const candidates = deduplicateLifecycleCandidates(options.candidates);
    let evaluation: AiSessionAttentionEvaluation;
    try {
        evaluation = await options.evaluateAttention();
    } catch (_error) {
        options.reportFailure?.('evaluate', 'unexpected', undefined);
        return {
            releasedKeys: [],
            retainedKeys: candidates.map(candidate => candidate.key).sort(),
        };
    }

    const inScope = new Set(evaluation.inScopeSessionKeys);
    const candidateSessionKey = (candidate: TCandidate): string => candidate.sessionKey || candidate.key;
    const overflowed = new Set(evaluation.overflowedSessionKeys);
    const hasAttentionEvidence = (candidate: TCandidate): boolean => {
        const sessionKey = candidateSessionKey(candidate);
        return (evaluation.eventIdsBySession[sessionKey] || []).length > 0
            || overflowed.has(sessionKey);
    };
    const safeToRelease = candidates.filter(candidate => {
        if (candidate.state === 'stopped' || !evaluation.enabled) {
            return true;
        }
        const sessionKey = candidateSessionKey(candidate);
        if (!inScope.has(sessionKey) || !hasAttentionEvidence(candidate)) {
            return true;
        }
        return evaluation.published;
    });

    const eligibleByKey = new Map<string, TCandidate>();
    for (const candidate of safeToRelease) {
        eligibleByKey.set(candidate.key, candidate);
    }
    const releasedKeys: string[] = [];
    for (const candidate of [...eligibleByKey.values()].sort((left, right) =>
        left.key.localeCompare(right.key))) {
        try {
            await options.release(candidate);
            releasedKeys.push(candidate.key);
        } catch (_error) {
            options.reportFailure?.('release', 'unexpected', candidate.key);
        }
    }
    const released = new Set(releasedKeys);
    return {
        releasedKeys,
        retainedKeys: candidates.map(candidate => candidate.key)
            .filter(key => !released.has(key)).sort(),
    };
}

function deduplicateLifecycleCandidates<TCandidate extends AiSessionRuntimeLifecycleCandidate>(
    candidates: readonly TCandidate[]
): TCandidate[] {
    const byKey = new Map<string, TCandidate>();
    for (const candidate of candidates) {
        if (candidate && candidate.key && (candidate.state === 'completed' || candidate.state === 'stopped')) {
            const existing = byKey.get(candidate.key);
            if (!existing || (existing.state === 'stopped' && candidate.state === 'completed')) {
                byKey.set(candidate.key, candidate);
            }
        }
    }
    return [...byKey.values()];
}
