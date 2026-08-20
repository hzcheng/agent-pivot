'use strict';

import {
    acceptedWorktreeAdoptSettlement,
    parseAdoptWorktreesRequest,
    settledWorktreeAdoptSettlement,
} from './groupAdoptProtocol';
import type { AdoptWorktreesRequest, WorktreeAdoptSettlement } from './groupAdoptProtocol';
import type { WorktreeGroupManifestStoreHandle } from './groupManifestStore';
import {
    WorktreeGroupManifestError,
    worktreeGroupManifestStoreOf,
} from './groupManifestStore';
import { slugifyTaskName } from './provisioningPlan';
import type { SettlementReplayCache } from './settlementReplayCache';
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
    store: WorktreeGroupManifestStoreHandle;
    getWorktreeSnapshot: () => WorktreeSnapshot | null;
    refreshNow: () => Promise<void>;
    logError: (message: string, error: unknown) => void;
    /** Exactly-once replay protection (rename/deletion family pattern). */
    replayCache: SettlementReplayCache<WorktreeAdoptSettlement>;
}

export async function handleAdoptWorktrees(
    message: unknown,
    deps: WorktreeAdoptHandlerDeps
): Promise<void> {
    const request = parseAdoptWorktreesRequest(message);
    if (!request) {
        return;
    }
    // Single-flight per request id: a replay — even a concurrent one —
    // awaits and re-receives the first execution's terminal settlement.
    const replayed = deps.replayCache.get(request.requestId);
    if (replayed) {
        await deps.postMessage(await replayed);
        return;
    }
    if (deps.replayCache.isExpired(request.requestId)) {
        // The settlement aged out of the bounded cache: re-executing could
        // flip an old outcome, so expired replays fail closed.
        await deps.postMessage(settledWorktreeAdoptSettlement(
            request, { kind: 'failed', errorCode: 'request-expired' }));
        return;
    }
    const terminal = executeAdoptWorktrees(request, deps);
    deps.replayCache.remember(request.requestId, terminal);
    await deps.postMessage(await terminal);
}

async function executeAdoptWorktrees(
    request: AdoptWorktreesRequest,
    deps: WorktreeAdoptHandlerDeps
): Promise<WorktreeAdoptSettlement> {
    await deps.postMessage(acceptedWorktreeAdoptSettlement(request));
    const store = worktreeGroupManifestStoreOf(deps.store);
    const fail = (errorCode: string) =>
        settledWorktreeAdoptSettlement(request, { kind: 'failed', errorCode });
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    const snapshot = deps.getWorktreeSnapshot();
    if (!navigationIdentity || !snapshot) {
        return fail('workspace-unavailable');
    }
    const groups = store.listGroups(navigationIdentity);
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
            return fail('worktree-unavailable');
        }
        const claimed = groups.some(group => group.members.some(member =>
            member.worktreeKey && worktreeKeysEqual(member.worktreeKey, {
                repositoryKey: key.repositoryKey,
                canonicalWorktreePath: key.canonicalWorktreePath,
            })));
        if (claimed) {
            return fail('worktree-key-claimed');
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
            const group = await store.adoptReadyMembers(
                navigationIdentity, request.targetGroupId, members);
            await deps.refreshNow();
            return settledWorktreeAdoptSettlement(
                request, { kind: 'settled', groupId: group.groupId });
        }
        const displayName = (request.displayName || '').trim();
        const slug = slugifyTaskName(displayName);
        if (!displayName || !slug) {
            return fail('invalid-task');
        }
        const group = await store.createGroup(navigationIdentity, {
            displayName,
            suggestedSlug: slug,
            members,
        });
        await deps.refreshNow();
        return settledWorktreeAdoptSettlement(
            request, { kind: 'settled', groupId: group.groupId });
    } catch (error) {
        deps.logError('Failed to adopt worktrees.', error);
        return fail(error instanceof WorktreeGroupManifestError
            ? error.code
            : 'adopt-failed');
    }
}
