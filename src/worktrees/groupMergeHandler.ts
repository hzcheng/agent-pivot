'use strict';

import type { WorktreeGroupManifestStore } from './groupManifestStore';

export interface MergeWorktreeGroupsPick {
    label: string;
    description?: string;
    groupId: string;
}

export interface MergeWorktreeGroupsHandlerDeps {
    /** Resolves the caller's project to the current workspace bucket. */
    getNavigationIdentity: (projectId: string) => string | null;
    store: WorktreeGroupManifestStore;
    showQuickPick: (
        items: MergeWorktreeGroupsPick[],
        placeHolder: string
    ) => Thenable<MergeWorktreeGroupsPick | undefined>;
    showWarning: (message: string) => void;
    /** Awaits publication of the authoritative replacement. */
    refreshNow: () => Promise<void>;
    logError: (message: string, error: unknown) => void;
}

/**
 * Migration-suggested group → group merge (PRD §6.5): the webview submits
 * only the source group; the host stays authoritative by re-deriving the
 * candidates and confirming via QuickPick. M3 batch 8: merge is no longer
 * slug-gated — any other group is a candidate; same-slug groups sort first
 * as the migration-era hint. Double revision binding (decision G): the
 * revisions captured when the dialog opened must still hold at the write.
 *
 * Extracted verbatim from the composition root so the merge seam is
 * testable; behavior is identical to the former inline handler.
 */
export async function handleMergeWorktreeGroups(
    message: unknown,
    deps: MergeWorktreeGroupsHandlerDeps
): Promise<void> {
    const request = (message && typeof message === 'object')
        ? message as { projectId?: unknown; sourceGroupId?: unknown }
        : {};
    if (typeof request.projectId !== 'string'
        || typeof request.sourceGroupId !== 'string'
        || !request.sourceGroupId) {
        return;
    }
    const bucket = deps.getNavigationIdentity(request.projectId);
    if (!bucket) {
        return;
    }
    const groups = deps.store.listGroups(bucket);
    const source = groups.find(group => group.groupId === request.sourceGroupId);
    if (!source) {
        return;
    }
    const candidates = groups
        .filter(group => group.groupId !== source.groupId)
        .sort((left, right) =>
            Number(right.suggestedSlug === source.suggestedSlug)
            - Number(left.suggestedSlug === source.suggestedSlug));
    if (candidates.length === 0) {
        return;
    }
    const picks: MergeWorktreeGroupsPick[] = candidates.map(group => ({
        label: group.displayName,
        description: group.members.map(member => member.branchName).join(' · '),
        groupId: group.groupId,
    }));
    const chosen = await deps.showQuickPick(picks,
        `Merge "${source.displayName}" into…`);
    if (!chosen) {
        return;
    }
    const expectedRevisions = {
        targetRevision: chosen.groupId
            ? groups.find(group => group.groupId === chosen.groupId)?.revision ?? -1
            : -1,
        sourceRevision: source.revision,
    };
    try {
        await deps.store.mergeGroups(
            bucket, chosen.groupId, source.groupId, expectedRevisions);
    } catch (error) {
        const code = (error as { code?: string })?.code || 'merge-failed';
        deps.showWarning(
            code === 'repository-conflict'
                ? 'These groups cannot be merged: both contain a worktree of the same repository. Remove one of them first.'
                : code === 'group-changed'
                    ? 'A group changed while the merge was open. Review and try again.'
                    : 'The groups could not be merged. Try again.');
        return;
    }
    // Fire-and-forget, exactly as the inline handler did.
    void deps.refreshNow();
}
