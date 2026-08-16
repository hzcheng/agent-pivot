'use strict';

import type { WorktreeKey } from './types';
import type { RetiredAffectedSession } from './retiredWorktrees';

/**
 * The deletion journal (PRD §6.4): the authoritative record of an
 * in-flight journaled deletion. It lives inside the manifest aggregate so
 * that "mark member deleting → physical removal → retire identity →
 * remove member → advance journal" commits in a single memento write.
 *
 * Everything the post-crash reconciliation needs is frozen into the
 * journal BEFORE any physical side effect: target identities, affected
 * sessions, retirement ids, and the generation cutoff. Reconciliation and
 * checkpoints consume only this frozen data and never re-query the live
 * world for identity decisions.
 */

/**
 * member: one member of a group; group: every member (the group
 * disappears with its last member); visible-only: only currently visible
 * members, detached members stay in the manifest.
 */
export type DeletionOperationMode = 'member' | 'group' | 'visible-only';

export type DeletionTargetStatus = 'pending' | 'deleted' | 'failed';

export interface DeletionJournalTarget {
    memberId: string;
    repositoryKey: string;
    /** Frozen physical identity of the worktree being deleted. */
    canonicalWorktreePath: string;
    branchName: string;
    worktreeKey?: WorktreeKey;
    /** Generated at beginDeletion; unique within the workspace bucket. */
    retirementId: string;
    /** Frozen old-generation membership; authoritative, never re-queried. */
    affectedSessions: RetiredAffectedSession[];
    /** The frozen detail list overflowed; counts are diagnostic only. */
    truncated?: boolean;
    status: DeletionTargetStatus;
    /** Physical deletion time (display only; never a generation boundary). */
    deletedAt?: number;
    errorCode?: string;
}

/**
 * An entry present in `deletionJournal` is ACTIVE: the group is leased and
 * only Retry / abandon / view operations may touch it. Entries leave the
 * active journal only through completeDeletion / abandonDeletion (which
 * archive a diagnostic summary) — never through a crash or a reload.
 */
export interface DeletionJournalEntry {
    operationId: string;
    groupId: string;
    mode: DeletionOperationMode;
    /** Primary at beginDeletion, for restore/display after failure. */
    originalPrimaryMemberId: string | null;
    /** Frozen generation boundary shared by every target of this operation. */
    generationCutoffAt: number;
    targets: DeletionJournalTarget[];
    startedAt: number;
}

/**
 * Bounded, non-authoritative diagnostic ring of finished operations (PRD
 * §6.4): summaries only, never participates in recovery or reconciliation,
 * may be dropped when capacity runs out.
 */
export interface DeletionDiagnosticEntry {
    operationId: string;
    groupId: string;
    mode: DeletionOperationMode;
    outcome: 'completed' | 'abandoned';
    finishedAt: number;
    deletedCount: number;
    failedCount: number;
    lastErrorCode?: string;
}

export const MAX_DELETION_HISTORY_ENTRIES = 8;
