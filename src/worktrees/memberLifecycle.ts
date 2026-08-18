'use strict';

import type { WorktreeKey } from './types';
import type { WorktreeGroupManifestStore } from './groupManifestStore';

export class IllegalMemberTransitionError extends Error {
    readonly code = 'illegal-member-transition';
}

/**
 * The single authority for worktree-group member state transitions
 * (invariant ARCH-WORKTREE-MEMBER-WRITER-001). Callers name the transition
 * they mean; the legal pre-states are enforced here at the state-owning
 * boundary instead of being re-remembered at every call site.
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
 */
export class WorktreeMemberLifecycle {
    constructor(private readonly store: WorktreeGroupManifestStore) {}

    private memberState(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): string | undefined {
        return this.store.listGroups(workspaceIdentity)
            .find(group => group.groupId === groupId)
            ?.members.find(member => member.memberId === memberId)?.state;
    }

    private requireState(
        workspaceIdentity: string,
        groupId: string,
        memberId: string,
        allowed: readonly string[],
        transition: string
    ): void {
        const state = this.memberState(workspaceIdentity, groupId, memberId);
        if (!state || !allowed.includes(state)) {
            throw new IllegalMemberTransitionError(
                `${transition}: member ${memberId} is '${state ?? 'missing'}', `
                + `expected one of ${allowed.join(', ')}`);
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
        this.requireState(
            workspaceIdentity, groupId, memberId,
            ['provisioning', 'failed'], 'mark-ready');
        await this.store.updateMember(workspaceIdentity, groupId, memberId, {
            state: 'ready',
            worktreeKey,
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
        this.requireState(workspaceIdentity, groupId, memberId,
            ['provisioning', 'planned', 'failed'], 'mark-failed');
        await this.store.updateMember(workspaceIdentity, groupId, memberId, {
            state: 'failed',
            lastError,
        });
    }

    /** Restart reconciliation: an in-flight member demotes to failed/interrupted. */
    async demoteInterruptedMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        this.requireState(workspaceIdentity, groupId, memberId,
            ['provisioning', 'planned'], 'demote-interrupted');
        await this.store.updateMember(workspaceIdentity, groupId, memberId, {
            state: 'failed',
            lastError: 'interrupted',
        });
    }

    /** Retry readmission: failed -> provisioning (the plan is never re-made). */
    async readmitMemberForRetry(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        this.requireState(workspaceIdentity, groupId, memberId, ['failed'], 'retry-readmit');
        await this.store.updateMember(workspaceIdentity, groupId, memberId, {
            state: 'provisioning',
            // The store treats undefined as "leave unchanged".
            lastError: '',
        });
    }

    /** Dismiss: failed -> removed. */
    async removeFailedMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        this.requireState(workspaceIdentity, groupId, memberId, ['failed'], 'dismiss-member');
        await this.store.removeMember(workspaceIdentity, groupId, memberId);
    }

    /** The physical worktree is gone: the member record is removed from any state. */
    async removeMemberRecord(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        await this.store.removeMember(workspaceIdentity, groupId, memberId);
    }

    /** Assign the primary member; the store enforces the ready invariant. */
    async assignPrimary(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<void> {
        this.requireState(workspaceIdentity, groupId, memberId, ['ready'], 'assign-primary');
        await this.store.setPrimaryMember(workspaceIdentity, groupId, memberId);
    }
}
