'use strict';

import type { WorktreeMemberLifecycle } from './memberLifecycle';
import type { WorktreeGroupManifestStoreHandle } from './groupManifestStore';
import { worktreeGroupManifestStoreOf } from './groupManifestStore';
import type { PersistedWorktreeProvisioningOperation } from './provisioningStore';
import type { WorktreeSnapshotContent } from './types';

const MANAGED_BRANCH_PREFIX = 'refs/heads/agent-pivot/';

export interface ReconcileWorktreeGroupManifestOptions {
    store: WorktreeGroupManifestStoreHandle;
    /** Stable workspace navigation identity (the manifest bucket, PRD §9). */
    workspaceIdentity: string;
    snapshot: WorktreeSnapshotContent;
    /**
     * Provisioning recovery records: the second migration signal (PRD §9).
     * Worktrees the extension created but whose branch was later renamed no
     * longer carry the managed prefix, and task names that slugify poorly
     * (e.g. CJK names) keep their original display name here.
     */
    recoveryRecords?: readonly PersistedWorktreeProvisioningOperation[];
    /**
     * Member ids with a live provisioning operation (PRD §9 in-flight
     * reconciliation): members stuck in planned/provisioning without one
     * crashed mid-creation and are downgraded to failed/interrupted.
     */
    activeGroupMemberIds?: readonly string[];
    /** The single writer for member transitions (ARCH-WORKTREE-MEMBER-WRITER-001). */
    memberLifecycle: WorktreeMemberLifecycle;
    onError?: (message: string, error: unknown) => void;
}

/**
 * Reconciles the authoritative group manifest with a coherent Git snapshot
 * (docs/worktree-tasks-prd.md §9):
 *
 * - Extension-created worktrees (recognizable by the managed branch prefix)
 *   are seeded as one-worktree groups — never auto-merged across
 *   repositories by slug. This doubles as the first-run migration and as the
 *   "every new worktree lands in the manifest" guarantee, because every
 *   extension creation flow produces exactly such a branch.
 * - Members whose repository is no longer part of the workspace are flagged
 *   detached (and re-attach automatically when the repository returns).
 *
 * Idempotent: reconciling the same snapshot twice changes nothing.
 */
export async function reconcileWorktreeGroupManifest(
    options: ReconcileWorktreeGroupManifestOptions
): Promise<void> {
    const { workspaceIdentity, snapshot } = options;
    const store = worktreeGroupManifestStoreOf(options.store);
    const activeMemberIds = new Set(options.activeGroupMemberIds || []);
    const visibleRepositories = new Set(
        snapshot.repositories.map(repository => repository.repositoryKey));
    const manifestRepositories = new Set<string>();
    // Members claim their worktree by path from the moment they are
    // planned — before any worktreeKey exists. Seeding must honor that
    // claim: a snapshot refresh racing an in-flight group creation would
    // otherwise seed a duplicate group for the same physical worktree and
    // the finalize write would fail with worktree-key-claimed.
    const claimedMemberPaths = new Set<string>();
    for (const group of store.listGroups(workspaceIdentity)) {
        for (const member of group.members) {
            manifestRepositories.add(member.repositoryKey);
            claimedMemberPaths.add(memberPathClaim(member.repositoryKey, member.path));
            if ((member.state === 'provisioning' || member.state === 'planned')
                && !activeMemberIds.has(member.memberId)) {
                // The process exited mid-creation: an in-flight member must
                // not stay pending forever. It becomes a retryable failed
                // member; a live operation's own settlement wins the race
                // because it rewrites the state on every outcome.
                try {
                    await options.memberLifecycle.demoteInterruptedMember(
                        workspaceIdentity, group.groupId, member.memberId);
                } catch (error) {
                    options.onError?.(
                        'Failed to downgrade an interrupted group member.', error);
                }
            }
        }
    }
    for (const repositoryKey of manifestRepositories) {
        await store.setRepositoryDetached(
            workspaceIdentity, repositoryKey, !visibleRepositories.has(repositoryKey));
    }
    for (const repository of snapshot.repositories) {
        for (const worktree of repository.worktrees) {
            const branchRef = worktree.branchRef || '';
            if (worktree.isMain || worktree.isBare) {
                continue;
            }
            if (claimedMemberPaths.has(memberPathClaim(
                worktree.key.repositoryKey, worktree.key.canonicalWorktreePath))) {
                continue;
            }
            const matchedRecord = (options.recoveryRecords || []).find(candidate =>
                candidate.plan.repositoryKey === worktree.key.repositoryKey
                && candidate.plan.worktreePath === worktree.key.canonicalWorktreePath);
            if (matchedRecord && !isCompleteRecoveryRecord(matchedRecord)) {
                // The physical worktree exists but its setup never finished:
                // the restored provisioning row owns the retry/dismiss flow,
                // and a successful retry records the manifest through the
                // finalize hook. Seeding it ready here would let users start
                // sessions in a half-provisioned worktree. This gate applies
                // to the *unfiltered* match: a foreign-workspace record still
                // proves the worktree is incomplete.
                continue;
            }
            // A record bound to a different navigation identity (Save
            // Workspace As can reuse a legacy projectId for new roots) must
            // never seed this workspace's bucket; the managed branch prefix
            // remains an independent seeding signal.
            const record = matchedRecord?.workspaceNavigationIdentity
                && matchedRecord.workspaceNavigationIdentity !== workspaceIdentity
                ? undefined
                : matchedRecord;
            // A group member's recovery record is owned by the group
            // creation lifecycle, never a seeding source; the managed
            // branch prefix remains an independent signal.
            const seedRecord = record?.groupId ? undefined : record;
            const managedBranch = branchRef.startsWith(MANAGED_BRANCH_PREFIX)
                ? branchRef.slice(MANAGED_BRANCH_PREFIX.length)
                : '';
            if (!managedBranch && !seedRecord) {
                continue;
            }
            const slug = seedRecord?.plan.slug || managedBranch;
            const displayName = seedRecord?.plan.taskName || managedBranch;
            const branchName = branchRef.slice('refs/heads/'.length) || seedRecord?.plan.branchName || '';
            if (!slug || !displayName || !branchName) {
                continue;
            }
            if (store.findGroupByWorktreeKey(workspaceIdentity, worktree.key)) {
                continue;
            }
            try {
                await store.createGroup(workspaceIdentity, {
                    displayName,
                    suggestedSlug: slug,
                    members: [{
                        repositoryKey: worktree.key.repositoryKey,
                        worktreeKey: worktree.key,
                        branchName,
                        path: worktree.key.canonicalWorktreePath,
                        state: 'ready',
                    }],
                });
            } catch (error) {
                // Seeding must never break discovery; a later snapshot
                // reconciles the same worktree again.
                options.onError?.('Failed to seed a worktree group record.', error);
            }
        }
    }
}

function isCompleteRecoveryRecord(record: PersistedWorktreeProvisioningOperation): boolean {
    if (!record.completedSteps.includes('worktree')) {
        return false;
    }
    // Setup only counts when the operation actually had one to run.
    return record.setupCommand.length === 0
        || record.completedSteps.includes('setup');
}

function memberPathClaim(repositoryKey: string, worktreePath: string): string {
    return `${repositoryKey}${worktreePath}`;
}
