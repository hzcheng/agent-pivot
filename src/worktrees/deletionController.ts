'use strict';

import type {
    DeletionJournalEntry,
    DeletionJournalTarget,
    DeletionOperationMode,
} from './deletionJournal';
import type { RetiredAffectedSession } from './retiredWorktrees';
import type {
    WorktreeGroup,
    WorktreeGroupManifestStore,
    WorktreeGroupMember,
} from './groupManifestStore';
import { WorktreeGroupManifestError } from './groupManifestStore';

/**
 * Orchestrates journaled worktree deletions (PRD §6.4, decisions B/F/J).
 *
 * The store owns identity freezing, journaling, capacity, and lease
 * enforcement; this controller owns everything asynchronous around it:
 *
 * - the admission mutex shared by deletion admission and New session
 *   admission, keyed by `{navigationIdentity, groupId}` — it closes the
 *   race between the blocker recheck awaits and the journal write;
 * - the final per-member blocker recheck and affected-session snapshot
 *   that happen BEFORE `store.beginDeletion` (and therefore before any
 *   physical side effect);
 * - the per-member physical execution with immediate checkpoints;
 * - the fail-closed restart reconciliation that converges interrupted
 *   journals from fresh observations without ever guessing success.
 */

export type DeletionObservation = 'missing' | 'present' | 'unknown';

export type PhysicalRemovalResult =
    | { kind: 'removed' }
    | { kind: 'failed'; errorCode: string };

export interface WorktreeDeletionControllerOptions {
    store: WorktreeGroupManifestStore;
    /**
     * Final blocker recheck for one target member (active session /
     * uncommitted changes / locked / provisioning). Returns the blocker
     * error code, or null when deletion may proceed.
     */
    recheckBlocker: (
        group: WorktreeGroup,
        member: WorktreeGroupMember
    ) => Promise<string | null>;
    /** Freezes the old-generation session list for one target member. */
    snapshotAffectedSessions: (
        group: WorktreeGroup,
        member: WorktreeGroupMember
    ) => Promise<RetiredAffectedSession[]>;
    /**
     * Physically removes the worktree and verifies the path is gone.
     * Implementations must return 'failed' unless the removal is certain.
     */
    removeWorktree: (target: DeletionJournalTarget) => Promise<PhysicalRemovalResult>;
    /**
     * Fresh observation of a target's physical state for restart
     * reconciliation. 'unknown' covers truncated discovery, detached
     * repositories, and any uncertainty — the member stays `deleting`.
     */
    observeWorktree: (target: DeletionJournalTarget) => Promise<DeletionObservation>;
    /** Runs after every committed journal mutation (view republication). */
    onChanged?: (workspaceIdentity: string) => void | Promise<void>;
    nowMs?: () => number;
}

export type BeginDeletionOutcome =
    | { kind: 'started'; journal: DeletionJournalEntry }
    | { kind: 'blocked'; memberId: string; errorCode: string };

export class WorktreeDeletionController {
    private readonly admissionLocks = new Map<string, Promise<unknown>>();
    private readonly nowMs: () => number;

    constructor(private readonly options: WorktreeDeletionControllerOptions) {
        this.nowMs = options.nowMs || (() => Date.now());
    }

    /**
     * The admission mutex (decision J): deletion admission and New session
     * admission serialize on `{navigationIdentity, groupId}`, so a session
     * cannot slip in between the blocker rechecks and the journal write.
     */
    withAdmissionLock<T>(
        workspaceIdentity: string,
        groupId: string,
        operation: () => Promise<T>
    ): Promise<T> {
        const key = `${workspaceIdentity}${groupId}`;
        const previous = this.admissionLocks.get(key) || Promise.resolve();
        const result = previous.then(operation, operation);
        this.admissionLocks.set(key, result.then(() => undefined, () => undefined));
        return result;
    }

    /**
     * Opens a journaled deletion: holds the admission mutex from the final
     * blocker recheck until the journal is persisted. Any blocker rejects
     * the whole operation with zero physical side effects.
     */
    beginDeletion(
        workspaceIdentity: string,
        groupId: string,
        mode: DeletionOperationMode,
        memberIds?: readonly string[],
        options?: {
            replacementPrimaryMemberId?: string;
            /** The revision the user confirmed; store-validated atomically. */
            expectedRevision?: number;
        }
    ): Promise<BeginDeletionOutcome> {
        return this.withAdmissionLock(workspaceIdentity, groupId, async () => {
            const store = this.options.store;
            const group = store.listGroups(workspaceIdentity)
                .find(candidate => candidate.groupId === groupId);
            if (!group) {
                throw new WorktreeGroupManifestError('group-not-found');
            }
            const members = mode === 'group'
                ? group.members
                : group.members.filter(member => memberIds?.includes(member.memberId));
            // Final per-member blocker recheck under the mutex: anything
            // blocked aborts the operation before the journal exists.
            for (const member of members) {
                const blocker = await this.options.recheckBlocker(group, member);
                if (blocker) {
                    return { kind: 'blocked', memberId: member.memberId, errorCode: blocker };
                }
            }
            // Freeze the old-generation session lists before the write.
            const affectedSessions: Record<string, RetiredAffectedSession[]> = {};
            for (const member of members) {
                affectedSessions[member.memberId] =
                    await this.options.snapshotAffectedSessions(group, member);
            }
            const journal = await store.beginDeletion(workspaceIdentity, {
                groupId,
                mode,
                ...(mode === 'group' ? {} : { memberIds: memberIds || [] }),
                affectedSessions,
                ...(options?.replacementPrimaryMemberId
                    ? { replacementPrimaryMemberId: options.replacementPrimaryMemberId }
                    : {}),
                ...(options?.expectedRevision !== undefined
                    ? { expectedRevision: options.expectedRevision }
                    : {}),
                nowMs: this.nowMs(),
            });
            return { kind: 'started', journal };
        });
    }

    /**
     * Executes the pending targets of an operation one at a time, with an
     * execution-time blocker recheck per member as defense in depth
     * (decision J). Every outcome is checkpointed immediately; a failure
     * never rolls back already-deleted members.
     */
    async executeOperation(
        workspaceIdentity: string,
        operationId: string
    ): Promise<void> {
        const store = this.options.store;
        const journal = store.listDeletionJournals(workspaceIdentity)
            .find(entry => entry.operationId === operationId);
        if (!journal) {
            return;
        }
        const group = store.listGroups(workspaceIdentity)
            .find(candidate => candidate.groupId === journal.groupId);
        for (const target of journal.targets) {
            if (target.status !== 'pending') {
                continue;
            }
            const member = group?.members.find(candidate =>
                candidate.memberId === target.memberId);
            let blocker: string | null = null;
            if (member) {
                try {
                    blocker = await this.options.recheckBlocker(group!, member);
                } catch {
                    blocker = 'blocker-recheck-failed';
                }
            }
            if (!member || blocker) {
                await store.failDeletionMember(
                    workspaceIdentity, operationId, target.memberId,
                    blocker || 'member-not-found');
                await this.options.onChanged?.(workspaceIdentity);
                continue;
            }
            let result: PhysicalRemovalResult;
            try {
                result = await this.options.removeWorktree(target);
            } catch {
                result = { kind: 'failed', errorCode: 'worktree-remove-failed' };
            }
            if (result.kind === 'removed') {
                await store.checkpointDeletedMember(
                    workspaceIdentity, operationId, target.memberId, this.nowMs());
            } else {
                await store.failDeletionMember(
                    workspaceIdentity, operationId, target.memberId, result.errorCode);
            }
            await this.options.onChanged?.(workspaceIdentity);
        }
    }

    /**
     * Fail-closed restart reconciliation (PRD §6.4): converge every
     * interrupted journal from fresh observations. A path proven missing
     * completes from the frozen journal data; a worktree still present
     * returns to `ready` + `deletion-interrupted` for Retry; anything
     * unknown stays `deleting` and keeps the lease.
     */
    async reconcileAfterRestart(workspaceIdentity: string): Promise<void> {
        const store = this.options.store;
        for (const journal of store.listDeletionJournals(workspaceIdentity)) {
            for (const target of journal.targets) {
                if (target.status !== 'pending') {
                    continue;
                }
                let observation: DeletionObservation;
                try {
                    observation = await this.options.observeWorktree(target);
                } catch {
                    observation = 'unknown';
                }
                if (observation === 'missing') {
                    await store.checkpointDeletedMember(
                        workspaceIdentity, journal.operationId, target.memberId,
                        this.nowMs());
                    await this.options.onChanged?.(workspaceIdentity);
                } else if (observation === 'present') {
                    await store.failDeletionMember(
                        workspaceIdentity, journal.operationId, target.memberId,
                        'deletion-interrupted');
                    await this.options.onChanged?.(workspaceIdentity);
                }
                // 'unknown': keep `deleting`; the lease keeps blocking the
                // group until a later reconciliation gets a certain view.
            }
            // A journal whose targets all checkpointed but that never
            // archived (crash between the two steps) terminates here.
            const current = store.listDeletionJournals(workspaceIdentity)
                .find(entry => entry.operationId === journal.operationId);
            if (current
                && current.targets.every(target => target.status === 'deleted')) {
                await store.completeDeletion(workspaceIdentity, journal.operationId);
                await this.options.onChanged?.(workspaceIdentity);
            }
        }
    }
}
