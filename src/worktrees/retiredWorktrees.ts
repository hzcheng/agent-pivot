'use strict';

import { worktreeKeysEqual } from './types';
import type { WorktreeKey } from './types';

/**
 * Retired worktree identities and session generations (PRD §6.4).
 *
 * A retired record is a persisted historical fact — "this worktree was
 * deleted by an extension-run, journaled deletion" — never a observation
 * about the current file system. It is produced only by a journaled
 * deletion (never inferred from missing/prunable discovery state), keeps
 * history sessions' worktree identity alive after the manifest member is
 * removed, and is the input to the generation rules that decide whether a
 * same-path session belongs to the pre-deletion generation (cannot resume)
 * or a post-cutoff one (can).
 */

export interface RetiredWorktreeOrigin {
    groupId: string;
    memberId: string;
    displayName: string;
}

export interface RetiredAffectedSession {
    provider: string;
    sessionId: string;
}

export interface RetiredWorktreeIdentity {
    /** Stable per-retirement identity; a path may retire several times. */
    retirementId: string;
    repositoryKey: string;
    canonicalWorktreePath: string;
    branchName: string;
    /** Physical deletion time (display only; never a generation boundary). */
    deletedAt: number;
    /** Authoritative generation boundary, frozen before any side effect. */
    generationCutoffAt: number;
    origin?: RetiredWorktreeOrigin;
    /** Frozen at beginDeletion; authoritative old-generation membership. */
    affectedSessions: RetiredAffectedSession[];
    /** Detail list was truncated; the counts are diagnostic only. */
    truncated?: boolean;
}

/**
 * A persisted, binding-independent record that a session was created on a
 * retired path after a specific retirement. Claims outlive terminal
 * bindings (`terminalBindingStore.remove()`) because generation judgment
 * needs them for as long as the history session exists.
 */
export interface GenerationClaim {
    claimId: string;
    worktreeKey: WorktreeKey;
    /** The latest retirement on this key when the session was created. */
    createdAfterRetirementId: string;
    createdAtMs: number;
    state: 'pending' | 'promoted';
    /** Pending: the runtime pending identity (session id not known yet). */
    pendingId?: string;
    /** Pending claims may carry the creating provider to focus recovery. */
    creatingProvider?: string;
    /**
     * Pending: the unique launch marker path of this creation. Durable
     * terminal bindings keep the same marker path after promotion, so
     * reconciliation can re-attach a session id even after a crash between
     * runtime promotion and claim promotion.
     */
    launchMarkerPath?: string;
    /** Promoted: the authoritative provider session identity. */
    provider?: string;
    sessionId?: string;
}

export interface SessionGenerationSubject {
    provider: string;
    sessionId: string;
    /** Stable provider creation time (epoch ms), when available. */
    createdAtMs?: number;
}

export type SessionGeneration = 'current' | 'retired';

/**
 * Maximum tolerated forward clock skew for provider creation times. A
 * creation time further into the future than this is drifted evidence and
 * fails closed to the retired generation (PRD §6.4).
 */
export const MAX_CREATION_TIME_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Generation judgment (PRD §6.4), fail-closed by construction:
 *  1. The frozen affected-session list is authoritative old-generation.
 *  2. A matching promoted claim (created after this or a later retirement
 *     of the same key) marks the current generation.
 *  3. A stable creation time at or before the cutoff is old-generation;
 *     one after the cutoff is current — unless it is implausibly far in
 *     the future (clock drift), which is no evidence at all.
 *  4. Everything else — unknown, invalid, or drifted evidence — is judged
 *     old-generation: better to mislabel as unresumable than to allow a
 *     stale session to resume into a rebuilt directory.
 */
export function judgeSessionGeneration(
    record: RetiredWorktreeIdentity,
    subject: SessionGenerationSubject,
    claims: readonly GenerationClaim[],
    allRetirements: readonly RetiredWorktreeIdentity[],
    nowMs: number
): SessionGeneration {
    if (record.affectedSessions.some(entry =>
        entry.provider === subject.provider && entry.sessionId === subject.sessionId)) {
        return 'retired';
    }
    const claim = claims.find(candidate =>
        candidate.state === 'promoted'
        && candidate.provider === subject.provider
        && candidate.sessionId === subject.sessionId
        && worktreeKeysEqual(candidate.worktreeKey, {
            repositoryKey: record.repositoryKey,
            canonicalWorktreePath: record.canonicalWorktreePath,
        }));
    if (claim) {
        const basis = allRetirements.find(candidate =>
            candidate.retirementId === claim.createdAfterRetirementId);
        if (basis && basis.generationCutoffAt >= record.generationCutoffAt
            // The basis must retire the same worktree key; a cutoff-only
            // comparison would let a foreign key's newer retirement prove
            // this record's generation.
            && basis.repositoryKey === record.repositoryKey
            && basis.canonicalWorktreePath === record.canonicalWorktreePath) {
            return 'current';
        }
        // A claim whose basis retirement is unknown or older cannot prove
        // the session postdates this record: fall through to fail-closed.
    }
    if (typeof subject.createdAtMs === 'number'
        && Number.isSafeInteger(subject.createdAtMs)
        && subject.createdAtMs > 0) {
        if (Number.isSafeInteger(nowMs)
            && subject.createdAtMs > nowMs + MAX_CREATION_TIME_FUTURE_SKEW_MS) {
            return 'retired';
        }
        return subject.createdAtMs <= record.generationCutoffAt ? 'retired' : 'current';
    }
    return 'retired';
}

/**
 * Longest matching retired path wins (mirrors the manifest fallback); ties
 * resolve to the most recent retirement.
 */
export function findLatestRetirementForPath(
    retirements: readonly RetiredWorktreeIdentity[],
    candidatePath: string,
    normalize: (path: string) => string,
    isContained: (parent: string, child: string) => boolean
): RetiredWorktreeIdentity | null {
    const normalized = normalize(candidatePath || '');
    if (!normalized) {
        return null;
    }
    let best: RetiredWorktreeIdentity | null = null;
    let bestLength = -1;
    for (const record of retirements) {
        const recordPath = normalize(record.canonicalWorktreePath);
        if (!recordPath || !isContained(recordPath, normalized)) {
            continue;
        }
        if (recordPath.length > bestLength
            || (recordPath.length === bestLength && best
                && record.generationCutoffAt > best.generationCutoffAt)) {
            best = record;
            bestLength = recordPath.length;
        }
    }
    return best;
}

export function findLatestRetirementForKey(
    retirements: readonly RetiredWorktreeIdentity[],
    key: WorktreeKey
): RetiredWorktreeIdentity | null {
    let best: RetiredWorktreeIdentity | null = null;
    for (const record of retirements) {
        if (record.repositoryKey !== key.repositoryKey
            || record.canonicalWorktreePath !== key.canonicalWorktreePath) {
            continue;
        }
        if (!best || record.generationCutoffAt > best.generationCutoffAt) {
            best = record;
        }
    }
    return best;
}

