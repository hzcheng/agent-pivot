'use strict';

import type { GenerationClaim } from './retiredWorktrees';

/**
 * Disposition resolver for pending generation claims (PRD §6.4). Pure and
 * evidence-driven so the fail-closed matrix is directly testable; the host
 * gathers the evidence and applies the resolutions through the store's
 * reconcile API.
 *
 * Discard is reserved for creations that provably never launched. Any
 * doubt — in-flight creation, missing evidence channels, unreadable
 * provider history, legacy claims without recovery fields — keeps the
 * claim, which blocks deletion and can only be released by explicit
 * retired-record cleanup.
 */

export type GenerationClaimDisposition =
    | { kind: 'keep' }
    | { kind: 'promote'; provider: string; sessionId: string }
    | { kind: 'discard' };

export interface GenerationClaimEvidence {
    /** Live pending runtime pending ids (null = enumeration failed). */
    livePendingIds: ReadonlySet<string> | null;
    /** Durable pending binding pending ids (null = enumeration failed). */
    pendingBindingIds: ReadonlySet<string> | null;
    /** Bound/released bindings by their unique launch marker path. */
    boundSessionByMarkerPath: ReadonlyMap<string, { provider: string; sessionId: string }> | null;
    /** Whether the completed-launch marker file exists. */
    markerExists: (path: string) => boolean;
    /**
     * Whether an authoritative provider read (forced refresh, unbounded,
     * untruncated, error-visible) shows session activity on the worktree
     * path at or after the claim's creation. 'unknown' covers every
     * unavailable/truncated/failed read.
     */
    hasProviderActivityOnPath: (claim: GenerationClaim) => boolean | 'unknown';
    /** Creations currently between claim persistence and runtime start. */
    isCreationInFlight: (pendingId: string) => boolean;
}

export function resolveGenerationClaimDisposition(
    claim: GenerationClaim,
    evidence: GenerationClaimEvidence
): GenerationClaimDisposition {
    if (claim.pendingId && evidence.isCreationInFlight(claim.pendingId)) {
        // The creation is between the claim write and the runtime start:
        // every evidence channel is empty by definition in this window.
        return { kind: 'keep' };
    }
    if (evidence.livePendingIds === null || evidence.pendingBindingIds === null
        || evidence.boundSessionByMarkerPath === null) {
        // Evidence enumeration failed: without it nothing is provable.
        return { kind: 'keep' };
    }
    if (claim.pendingId
        && (evidence.livePendingIds.has(claim.pendingId)
            || evidence.pendingBindingIds.has(claim.pendingId))) {
        // The normal promotion flow owns this claim.
        return { kind: 'keep' };
    }
    if (claim.launchMarkerPath) {
        const bound = evidence.boundSessionByMarkerPath.get(claim.launchMarkerPath);
        if (bound) {
            // The runtime promoted but the claim write crashed or failed:
            // re-attach the session identity through the shared marker.
            return {
                kind: 'promote',
                provider: bound.provider,
                sessionId: bound.sessionId,
            };
        }
        if (evidence.markerExists(claim.launchMarkerPath)) {
            // The launch completed but no binding survived to tell us the
            // session id: unknowable, keep blocking deletion.
            return { kind: 'keep' };
        }
    }
    if (!claim.launchMarkerPath || !claim.creatingProvider) {
        // Claims written before the recovery fields existed cannot prove
        // a launch never happened: keep them fail-closed.
        return { kind: 'keep' };
    }
    const activity = evidence.hasProviderActivityOnPath(claim);
    if (activity !== false) {
        return { kind: 'keep' };
    }
    return { kind: 'discard' };
}
