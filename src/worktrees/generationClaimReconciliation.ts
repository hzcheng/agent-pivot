'use strict';

import type { GenerationClaim } from './retiredWorktrees';

/**
 * Disposition resolver for pending generation claims (PRD §6.4).
 *
 * Reconciliation can only ever PROMOTE or KEEP — never discard. The
 * evidence asymmetry is deliberate: presence is proof, absence is not.
 * Launch markers are cleaned up when terminals close, provider session
 * inventories cannot prove a negative (partial materialization, per-file
 * failures, and off-path storage all look exactly like "no session"), so
 * no post-hoc channel can authoritatively confirm "the launch never
 * happened". Claims are released only by the exact in-process compensating
 * delete, by promotion, or by explicit retired-record cleanup.
 *
 * This also makes the resolver TOCTOU-proof: the bound-binding marker link
 * is a durable fact, so a stale snapshot can only delay a promotion to the
 * next tick, never make it wrong.
 */

export type GenerationClaimDisposition =
    | { kind: 'keep' }
    | { kind: 'promote'; provider: string; sessionId: string };

export interface GenerationClaimEvidence {
    /**
     * Bound/released durable terminal bindings by their unique launch
     * marker path. null = enumeration failed or ambiguous (duplicate
     * marker paths): nothing is provable, every claim is kept.
     */
    boundSessionByMarkerPath: ReadonlyMap<string, { provider: string; sessionId: string }> | null;
}

export function resolveGenerationClaimDisposition(
    claim: GenerationClaim,
    evidence: GenerationClaimEvidence
): GenerationClaimDisposition {
    if (claim.state !== 'pending' || !claim.launchMarkerPath) {
        return { kind: 'keep' };
    }
    const bound = evidence.boundSessionByMarkerPath?.get(claim.launchMarkerPath);
    if (!bound) {
        return { kind: 'keep' };
    }
    // The runtime promoted but the claim promotion crashed or failed:
    // re-attach the session identity through the shared marker path.
    return {
        kind: 'promote',
        provider: bound.provider,
        sessionId: bound.sessionId,
    };
}
