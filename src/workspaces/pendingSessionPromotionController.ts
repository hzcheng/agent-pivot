'use strict';

import type { AiSessionProviderId } from '../models';
import {
    resolvePendingAiSessionTerminals,
} from '../aiSessions/pendingTerminalResolver';
import type {
    PendingAiSessionRuntimeCoordinator,
} from '../aiSessions/pendingTerminalResolver';
import type {
    AiSessionPendingPromotionCandidate,
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    AiSessionProviderDefinition,
    AiSessionReadResult,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';

type PromotionProvider = Pick<
    AiSessionProviderDefinition,
    'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'
>;

interface WorkspacePromotionRuntimeCoordinator<TTerminal>
extends PendingAiSessionRuntimeCoordinator<TTerminal> {
    getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    getPendingForPromotion(): Promise<AiSessionPendingPromotionCandidate<TTerminal>[]>;
}

interface PromotionRequest {
    workspace: OpenWorkspace;
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    reason: string;
}

export interface WorkspacePendingSessionPromotionControllerOptions<TTerminal = unknown> {
    providers: readonly PromotionProvider[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    runtimeCoordinator: WorkspacePromotionRuntimeCoordinator<TTerminal>;
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    setSessionProfile?: (providerId: AiSessionProviderId, pendingId: string, sessionId: string) => void;
    syncActiveRuntime: () => void;
    evaluateExecution: () => void;
    scheduleRefresh: (reason: string) => void;
    /**
     * A pending runtime was authoritatively promoted to a provider session.
     * Used to promote pending worktree generation claims (PRD §6.4).
     */
    onSessionPromoted?: (input: {
        navigationIdentity: string;
        pendingId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }) => void | Promise<void>;
    /**
     * Idempotent generation-claim reconciliation (PRD §6.4): runs on every
     * promotion tick — even when no pending runtime exists, because the
     * crash window it closes is exactly "runtime promoted, claim not".
     */
    reconcileGenerationClaims?: (workspace: OpenWorkspace) => Promise<void>;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class WorkspacePendingSessionPromotionController<TTerminal = unknown> {
    private readonly queuedByScope = new Map<string, PromotionRequest>();
    private readonly inFlightByScope = new Map<string, Promise<void>>();

    constructor(
        private readonly options: WorkspacePendingSessionPromotionControllerOptions<TTerminal>
    ) {
    }

    promote(
        workspace: OpenWorkspace,
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        reason: string
    ): Promise<void> {
        const scope = workspace.scopeIdentity;
        this.queuedByScope.set(scope, { workspace, sessionResults, reason });
        const existing = this.inFlightByScope.get(scope);
        if (existing) {
            return existing;
        }
        return this.startDrain(scope);
    }

    private startDrain(scope: string): Promise<void> {
        let resolveDrain: () => void;
        let rejectDrain: (error: unknown) => void;
        const drainResult = new Promise<void>((resolve, reject) => {
            resolveDrain = resolve;
            rejectDrain = reject;
        });
        let running: Promise<void>;
        running = drainResult.finally(() => {
            if (this.inFlightByScope.get(scope) === running) {
                this.inFlightByScope.delete(scope);
                if (this.queuedByScope.has(scope)) {
                    return this.startDrain(scope);
                }
            }
        });
        this.inFlightByScope.set(scope, running);
        this.drain(scope).then(resolveDrain, rejectDrain);
        return running;
    }

    private async drain(scope: string): Promise<void> {
        while (this.queuedByScope.has(scope)) {
            const request = this.queuedByScope.get(scope) as PromotionRequest;
            this.queuedByScope.delete(scope);
            try {
                await this.promoteOnce(request);
            } catch (error) {
                this.logDiagnostic({
                    event: 'workspace-ai-session-promotion-failed',
                    reason: request.reason,
                    category: error instanceof Error ? error.name : typeof error,
                });
            }
        }
    }

    private async promoteOnce(request: PromotionRequest): Promise<void> {
        if (this.options.reconcileGenerationClaims) {
            try {
                await this.options.reconcileGenerationClaims(request.workspace);
            } catch (error) {
                this.logDiagnostic({
                    event: 'workspace-ai-session-claim-reconcile-failed',
                    reason: request.reason,
                    category: error instanceof Error ? error.name : typeof error,
                });
            }
        }
        const pendingRuntimes = (await this.options.runtimeCoordinator.getPendingForPromotion())
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity);
        if (!pendingRuntimes.length) {
            return;
        }
        const activeRuntimes = this.options.runtimeCoordinator.getActive()
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity
                || runtime.identity.workspaceNavigationIdentity
                    === request.workspace.navigationIdentity);
        const result = await resolvePendingAiSessionTerminals({
            pendingRuntimes,
            activeRuntimes,
            sessionResults: request.sessionResults,
            providers: this.options.providers,
            getSessionKey: this.options.getSessionKey,
            runtimeCoordinator: this.options.runtimeCoordinator,
            setAlias: this.options.setAlias,
            setSessionProfile: this.options.setSessionProfile,
            syncActiveRuntime: this.options.syncActiveRuntime,
        });
        if (result.promoted.length) {
            for (const promoted of result.promoted) {
                try {
                    await this.options.onSessionPromoted?.({
                        // The runtime's captured identity owns the claim
                        // bucket; the hydrating workspace may have changed
                        // (Save Workspace As) since creation.
                        navigationIdentity: promoted.navigationIdentity
                            || request.workspace.navigationIdentity,
                        pendingId: promoted.pendingId,
                        provider: promoted.provider,
                        sessionId: promoted.sessionId,
                    });
                } catch {
                    // Claim promotion must never break session promotion.
                }
            }
            this.options.evaluateExecution();
            this.options.scheduleRefresh('pending-promotion');
        }
        if (result.failures.length) {
            this.logDiagnostic({
                event: 'workspace-ai-session-promotion',
                reason: request.reason,
                attempted: result.attempted,
                promotedCount: result.promoted.length,
                failureReasons: result.failures.map(failure => failure.reason),
            });
        }
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        try {
            this.options.logDiagnostic?.(event);
        } catch {
            // Diagnostics must not break pending promotion or later retries.
        }
    }
}
