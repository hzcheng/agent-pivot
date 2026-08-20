'use strict';

import type { WorktreeKey } from './types';
import {
    WorktreeGroupManifestError,
    worktreeGroupMemberWriterOf,
} from './groupManifestStore';
import type {
    WorktreeGroupManifestStore,
    WorktreeGroupManifestStoreHandle,
    WorktreeGroupMemberWriter,
} from './groupManifestStore';

export class IllegalMemberTransitionError extends Error {
    readonly code = 'illegal-member-transition';
}

/**
 * The single authority for worktree-group member state transitions
 * (invariant ARCH-WORKTREE-MEMBER-WRITER-001). Callers name the transition
 * they mean; the legal pre-states are enforced here at the state-owning
 * boundary instead of being re-remembered at every call site.
 *
 * Every transition commits through the store's atomic `transitionMember`
 * primitive (review R5): the expected-state check and the write happen
 * inside the same write-queue entry, so racing transitions serialize and
 * only one can observe its legal pre-state (no TOCTOU between the check
 * and the write).
 *
 * Legal transitions (see the Stage 1B RFC state machine):
 *   provisioning|failed   -> ready   (finalize; requires a worktree key; a
 *                                    live operation wins the demotion race)
 *   provisioning|planned|failed -> failed (settlement rewrite; a live
 *                                    operation's own settlement wins races)
 *   provisioning|planned    -> failed/interrupted (restart reconciliation)
 *   failed                  -> provisioning (retry readmission)
 *   failed                  -> removed  (dismiss)
 *   ready                   -> removed  (physical worktree was removed)
 *
 * The ready -> deleting -> ready/removed deletion sub-machine runs through
 * the store's journal primitives (beginDeletion / checkpointDeletedMember /
 * failDeletionMember), which are mechanically disjoint from this authority:
 * the journal lease blocks generic transitions on members under deletion,
 * and the journal primitives only act on members in the deleting state.
 */
export class WorktreeMemberLifecycle {
    // Member-authority view only (ARCH-WORKTREE-MEMBER-WRITER-001): this
    // family shares the store with the manifest-structure family, and the
    // view is what keeps it off the other family's write methods — calling
    // one is a compile error here, not a scanner finding.
    private readonly store: WorktreeGroupMemberWriter;

    constructor(storeHandle: WorktreeGroupManifestStoreHandle) {
        this.store = worktreeGroupMemberWriterOf(storeHandle);
    }

    private async transition(
        workspaceIdentity: string,
        groupId: string,
        memberId: string,
        options: Parameters<WorktreeGroupManifestStore['transitionMember']>[3]
    ): Promise<void> {
        try {
            await this.store.transitionMember(workspaceIdentity, groupId, memberId, options);
        } catch (error) {
            if (error instanceof WorktreeGroupManifestError
                && error.code === 'illegal-member-transition') {
                // Preserve the authority's coded-error contract: the check
                // now happens atomically inside the store queue, but the
                // error type and message stay the lifecycle's own.
                throw new IllegalMemberTransitionError(error.detail ?? error.message);
            }
            throw error;
        }
    }

    /** Finalize: provisioning -> ready with the materialized worktree key.
     *  A member demoted to failed/interrupted by reconciliation while its
     *  operation was still live still finalizes ready — a live operation's
     *  own settlement wins that race. */
    async markMemberReady(
        workspaceIdentity: string,
        groupId: string,
        memberId: string,
        worktreeKey: WorktreeKey
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['provisioning', 'failed'],
            transition: 'mark-ready',
            patch: { state: 'ready', worktreeKey },
        });
    }

    /**
     * Settlement failure: -> failed with the outcome error code. Failed is
     * a legal pre-state because a live operation's settlement rewrites the
     * state on every outcome and wins races with reconciliation.
     */
    async markMemberFailed(
        workspaceIdentity: string,
        groupId: string,
        memberId: string,
        lastError: string
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['provisioning', 'planned', 'failed'],
            transition: 'mark-failed',
            patch: { state: 'failed', lastError },
        });
    }

    /** Restart reconciliation: an in-flight member demotes to failed/interrupted. */
    async demoteInterruptedMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['provisioning', 'planned'],
            transition: 'demote-interrupted',
            patch: { state: 'failed', lastError: 'interrupted' },
        });
    }

    /** Retry readmission: failed -> provisioning (the plan is never re-made). */
    async readmitMemberForRetry(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['failed'],
            transition: 'retry-readmit',
            patch: {
                state: 'provisioning',
                // The store treats undefined as "leave unchanged".
                lastError: '',
            },
        });
    }

    /** Dismiss: failed -> removed. */
    async removeFailedMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['failed'],
            transition: 'dismiss-member',
            remove: true,
        });
    }

    /** The physical worktree is gone: the member record is removed from any state. */
    async removeMemberRecord(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.store.removeMember(workspaceIdentity, groupId, memberId);
    }

    /** Assign the primary member: the ready pre-state is enforced atomically. */
    async assignPrimary(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.transition(workspaceIdentity, groupId, memberId, {
            expectedStates: ['ready'],
            transition: 'assign-primary',
            assignPrimary: true,
        });
    }
}
