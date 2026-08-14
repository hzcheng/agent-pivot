'use strict';

import type { WorktreeGroupManifestStore } from './groupManifestStore';
import type { PersistedWorktreeProvisioningOperation } from './provisioningStore';
import type { WorktreeSnapshotContent } from './types';

const MANAGED_BRANCH_PREFIX = 'refs/heads/agent-pivot/';

export interface ReconcileWorktreeGroupManifestOptions {
    store: WorktreeGroupManifestStore;
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
    const { store, workspaceIdentity, snapshot } = options;
    const visibleRepositories = new Set(
        snapshot.repositories.map(repository => repository.repositoryKey));
    const manifestRepositories = new Set<string>();
    for (const group of store.listGroups(workspaceIdentity)) {
        for (const member of group.members) {
            manifestRepositories.add(member.repositoryKey);
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
            const record = (options.recoveryRecords || []).find(candidate =>
                candidate.plan.repositoryKey === worktree.key.repositoryKey
                && candidate.plan.worktreePath === worktree.key.canonicalWorktreePath);
            if (record && !isCompleteRecoveryRecord(record)) {
                // The physical worktree exists but its setup never finished:
                // the restored provisioning row owns the retry/dismiss flow,
                // and a successful retry records the manifest through the
                // finalize hook. Seeding it ready here would let users start
                // sessions in a half-provisioned worktree.
                continue;
            }
            const managedBranch = branchRef.startsWith(MANAGED_BRANCH_PREFIX)
                ? branchRef.slice(MANAGED_BRANCH_PREFIX.length)
                : '';
            if (!managedBranch && !record) {
                continue;
            }
            const slug = record?.plan.slug || managedBranch;
            const displayName = record?.plan.taskName || managedBranch;
            const branchName = branchRef.slice('refs/heads/'.length) || record?.plan.branchName || '';
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
