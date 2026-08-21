'use strict';

import type { GenerationClaim } from './retiredWorktrees';
import type { WorktreeKey } from './types';
import { worktreeKeysMatch } from '../worktreeIdentity';
import { resolveGenerationClaimDisposition } from './generationClaimReconciliation';
import type { GenerationClaimDisposition } from './generationClaimReconciliation';

/**
 * Crash-recovery pass for pending generation claims (PRD §6.4): the runtime
 * promotion and the generation-claim promotion are separate writes, so a
 * crash (or a transient memento failure) between them strands a pending
 * claim whose runtime no longer exists. This idempotent pass re-attaches the
 * session id from the durable terminal binding (same unique launch marker
 * path). It never discards: no post-hoc channel can authoritatively prove a
 * launch never happened (markers are cleaned up on terminal close and
 * provider inventories cannot prove a negative), so claims are released only
 * by the in-process compensating delete, by promotion, or by explicit
 * retired-record cleanup.
 *
 * Extracted from the composition root (dashboard.ts) during the shell
 * decomposition; behavior is byte-identical.
 */
/**
 * The binding view the recovery pass reads. Structural on purpose: the
 * worktree domain must not import the AI session module (red line
 * ARCH-SESSION-WORKTREE-001), so the composition root adapts the real
 * terminal-binding union onto this shape.
 */
export type GenerationClaimTerminalBinding = {
    providerId: string;
    workspaceNavigationIdentity: string;
    markerPath?: string;
    worktreeKey?: WorktreeKey;
} & (
    | { state: 'pending' }
    | { state: 'bound' | 'released'; sessionId: string }
);

export interface GenerationClaimRecoveryDeps {
    listGenerationClaims: (navigationIdentity: string) => GenerationClaim[];
    reconcileGenerationClaims: (
        navigationIdentity: string,
        resolve: (claim: GenerationClaim) => GenerationClaimDisposition
    ) => Promise<unknown>;
    listTerminalBindings: () => readonly GenerationClaimTerminalBinding[] | null;
    logError: (message: string, error: unknown) => void;
}

export function createGenerationClaimRecovery(
    deps: GenerationClaimRecoveryDeps
): (workspace: { navigationIdentity: string }) => Promise<void> {
    return async workspace => {
        const identity = workspace.navigationIdentity;
        const pendingClaims = deps.listGenerationClaims(identity)
            .filter(claim => claim.state === 'pending');
        if (!pendingClaims.length) {
            return;
        }
        const bindings = deps.listTerminalBindings();
        if (!bindings) {
            // Enumeration failed: absence of evidence is not evidence.
            return;
        }
        const boundByMarkerPath = new Map<string, {
            provider: string;
            sessionId: string;
            navigationIdentity: string;
            worktreeKey?: WorktreeKey;
        }>();
        let ambiguous = false;
        for (const binding of bindings) {
            if ((binding.state !== 'bound' && binding.state !== 'released')
                || !binding.markerPath) {
                continue;
            }
            const existing = boundByMarkerPath.get(binding.markerPath);
            // Session identity is the composite {provider, sessionId} plus
            // the owning bucket and worktree key: any half differing makes
            // the marker ambiguous.
            if (existing && (existing.sessionId !== binding.sessionId
                || existing.provider !== binding.providerId
                || existing.navigationIdentity !== binding.workspaceNavigationIdentity
                || !worktreeKeysMatch(existing.worktreeKey, binding.worktreeKey))) {
                ambiguous = true;
                break;
            }
            boundByMarkerPath.set(binding.markerPath, {
                provider: binding.providerId,
                sessionId: binding.sessionId,
                navigationIdentity: binding.workspaceNavigationIdentity,
                ...(binding.worktreeKey ? { worktreeKey: binding.worktreeKey } : {}),
            });
        }
        if (ambiguous) {
            deps.logError('Ambiguous terminal bindings skipped during claim reconciliation.', null);
            return;
        }
        await deps.reconcileGenerationClaims(identity, claim =>
            resolveGenerationClaimDisposition(claim, {
                navigationIdentity: identity,
                boundSessionByMarkerPath: boundByMarkerPath,
            }));
    };
}
