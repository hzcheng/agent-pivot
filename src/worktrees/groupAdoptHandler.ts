'use strict';

import {
    acceptedWorktreeAdoptSettlement,
    parseAdoptWorktreesRequest,
    settledWorktreeAdoptSettlement,
} from './groupAdoptProtocol';
import type { WorktreeGroupManifestStore } from './groupManifestStore';
import { WorktreeGroupManifestError } from './groupManifestStore';
import { slugifyTaskName } from './provisioningPlan';
import type { WorktreeSnapshot } from './types';
import { worktreeKeysEqual } from './types';

/**
 * Adopt (PRD §6.5): attach existing unmanaged worktrees to a group. The
 * host is authoritative — every key is re-validated against the live
 * snapshot and the manifest (visible, healthy, non-bare, unclaimed)
 * before one aggregate write; nothing is adopted from stale card data.
 */
export interface WorktreeAdoptHandlerDeps {
    postMessage: (message: unknown) => Thenable<unknown>;
    getNavigationIdentity: (projectId: string) => string | null;
    store: WorktreeGroupManifestStore;
    getWorktreeSnapshot: () => WorktreeSnapshot | null;
    refreshNow: () => Promise<void>;
    logError: (message: string, error: unknown) => void;
}

export async function handleAdoptWorktrees(
    message: unknown,
    deps: WorktreeAdoptHandlerDeps
): Promise<void> {
    const request = parseAdoptWorktreesRequest(message);
    if (!request) {
        return;
    }
    await deps.postMessage(acceptedWorktreeAdoptSettlement(request));
    const fail = async (errorCode: string) => {
        await deps.postMessage(settledWorktreeAdoptSettlement(
            request, { kind: 'failed', errorCode }));
    };
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    const snapshot = deps.getWorktreeSnapshot();
    if (!navigationIdentity || !snapshot) {
        await fail('workspace-unavailable');
        return;
    }
    const groups = deps.store.listGroups(navigationIdentity);
    const members = [];
    for (const key of request.members) {
        const repository = snapshot.repositories.find(candidate =>
            candidate.repositoryKey === key.repositoryKey);
        const worktree = repository?.worktrees.find(candidate =>
            worktreeKeysEqual(candidate.key, {
                repositoryKey: key.repositoryKey,
                canonicalWorktreePath: key.canonicalWorktreePath,
            }));
        if (!worktree || worktree.isMain || worktree.isBare
            || worktree.health !== 'normal') {
            await fail('worktree-unavailable');
            return;
        }
        const claimed = groups.some(group => group.members.some(member =>
            member.worktreeKey && worktreeKeysEqual(member.worktreeKey, {
                repositoryKey: key.repositoryKey,
                canonicalWorktreePath: key.canonicalWorktreePath,
            })));
        if (claimed) {
            await fail('worktree-key-claimed');
            return;
        }
        members.push({
            repositoryKey: key.repositoryKey,
            worktreeKey: {
                repositoryKey: key.repositoryKey,
                canonicalWorktreePath: key.canonicalWorktreePath,
            },
            branchName: worktree.branchRef?.replace(/^refs\/heads\//u, '') || '',
            path: key.canonicalWorktreePath,
            state: 'ready' as const,
        });
    }
    try {
        if (request.targetGroupId) {
            const group = await deps.store.adoptReadyMembers(
                navigationIdentity, request.targetGroupId, members);
            await deps.refreshNow();
            await deps.postMessage(settledWorktreeAdoptSettlement(
                request, { kind: 'settled', groupId: group.groupId }));
            return;
        }
        const displayName = (request.displayName || '').trim();
        const slug = slugifyTaskName(displayName);
        if (!displayName || !slug) {
            await fail('invalid-task');
            return;
        }
        const group = await deps.store.createGroup(navigationIdentity, {
            displayName,
            suggestedSlug: slug,
            members,
        });
        await deps.refreshNow();
        await deps.postMessage(settledWorktreeAdoptSettlement(
            request, { kind: 'settled', groupId: group.groupId }));
    } catch (error) {
        deps.logError('Failed to adopt worktrees.', error);
        await fail(error instanceof WorktreeGroupManifestError
            ? error.code
            : 'adopt-failed');
    }
}
