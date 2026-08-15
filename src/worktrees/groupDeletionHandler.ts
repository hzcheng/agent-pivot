'use strict';

import type { WorktreeDeletionController } from './deletionController';
import {
    acceptedWorktreeGroupDeletionSettlement,
    parseAbandonWorktreeGroupDeletionRequest,
    parseDeleteWorktreeGroupMemberRequest,
    parseDiscardWorktreeGenerationClaimRequest,
    parsePreviewWorktreeGroupDeletionRequest,
    parseRetryWorktreeGroupDeletionRequest,
    settledWorktreeGroupDeletionSettlement,
    WorktreeGroupDeletionPreview,
    WorktreeGroupDeletionSettlement,
} from './groupDeletionProtocol';
import type { WorktreeGroupManifestStore } from './groupManifestStore';
import { WorktreeGroupManifestError } from './groupManifestStore';
import type { SettlementReplayCache } from './settlementReplayCache';

/**
 * Host side of the member-level deletion protocol (PRD §6.4, batch 4):
 * preview → confirm → journaled execution, plus Retry / abandon of a
 * partial journal and the explicit discard of an orphan generation claim.
 * Every recognized request settles exactly once; the terminal settlement
 * carries the aggregate revision the mutation produced so the webview can
 * hold its pending state until the authoritative replacement catches up.
 */

export interface WorktreeGroupDeletionHandlerDeps {
    postMessage: (message: unknown) => Thenable<unknown>;
    /** Resolves the caller's project to the current workspace bucket. */
    getNavigationIdentity: (projectId: string) => string | null;
    store: WorktreeGroupManifestStore;
    controller: WorktreeDeletionController;
    /**
     * Preview-time checks: per-member blocker probe and history session
     * count (the confirm path re-checks everything under the mutex).
     */
    probeMemberBlocker: (
        navigationIdentity: string, groupId: string, memberId: string
    ) => Promise<string | null>;
    countMemberHistorySessions: (
        navigationIdentity: string, groupId: string, memberId: string
    ) => Promise<number>;
    /** Repository label for card display. */
    getRepositoryLabel: (repositoryKey: string) => string;
    /** Awaits publication of the authoritative replacement. */
    refreshNow: () => Promise<void>;
    logError: (message: string, error: unknown) => void;
    replayCache: SettlementReplayCache<WorktreeGroupDeletionSettlement>;
}

function manifestErrorCode(error: unknown): string {
    if (error instanceof WorktreeGroupManifestError) {
        return error.code;
    }
    return 'deletion-failed';
}

export async function handlePreviewWorktreeGroupDeletion(
    message: unknown,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<void> {
    const request = parsePreviewWorktreeGroupDeletionRequest(message);
    if (!request) {
        return;
    }
    const fail = (errorCode: string): WorktreeGroupDeletionPreview => ({
        type: 'worktree-group-deletion-preview', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
        status: 'failed',
        errorCode,
    });
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    if (!navigationIdentity) {
        await deps.postMessage(fail('workspace-unavailable'));
        return;
    }
    const group = deps.store.listGroups(navigationIdentity)
        .find(candidate => candidate.groupId === request.groupId);
    if (!group) {
        await deps.postMessage(fail('group-changed'));
        return;
    }
    if (deps.store.isGroupDeletionLeased(navigationIdentity, group.groupId)) {
        await deps.postMessage(fail('group-leased'));
        return;
    }
    const member = request.mode === 'member'
        ? group.members.find(candidate => candidate.memberId === request.memberId)
        : undefined;
    if (request.mode === 'member' && !member) {
        await deps.postMessage(fail('group-changed'));
        return;
    }
    if (member && member.state !== 'ready') {
        await deps.postMessage(fail('member-not-ready'));
        return;
    }
    const blockingClaimsFor = (target: typeof member) =>
        deps.store.listGenerationClaims(navigationIdentity)
            .filter(claim => claim.state === 'pending' && target.worktreeKey
                && claim.worktreeKey.repositoryKey === target.worktreeKey.repositoryKey
                && claim.worktreeKey.canonicalWorktreePath
                    === target.worktreeKey.canonicalWorktreePath)
            .map(claim => ({
                claimId: claim.claimId,
                ...(claim.creatingProvider ? { provider: claim.creatingProvider } : {}),
            }));
    if (request.mode !== 'member') {
        // Group-level preview (batch 5): every visible member with its own
        // gate; detached members cannot be deleted, and their presence
        // blocks the whole-group action (PRD §6.4 双动作).
        const visible = group.members.filter(candidate => !candidate.detached);
        const members = [];
        for (const candidate of visible) {
            members.push({
                memberId: candidate.memberId,
                repositoryLabel: deps.getRepositoryLabel(candidate.repositoryKey),
                path: candidate.path,
                branchName: candidate.branchName,
                blocker: candidate.state === 'ready'
                    ? await deps.probeMemberBlocker(
                        navigationIdentity, group.groupId, candidate.memberId)
                    : 'member-not-ready',
                historyCount: await deps.countMemberHistorySessions(
                    navigationIdentity, group.groupId, candidate.memberId),
                isPrimary: group.primaryMemberId === candidate.memberId,
            });
        }
        const detachedCount = group.members.length - visible.length;
        const blockingClaims = visible.reduce<ReturnType<typeof blockingClaimsFor>>(
            (all, candidate) => all.concat(blockingClaimsFor(candidate)), []);
        await deps.postMessage({
            type: 'worktree-group-deletion-preview', version: 1,
            requestId: request.requestId,
            projectId: request.projectId,
            groupId: group.groupId,
            mode: request.mode,
            status: 'ready',
            members,
            ...(detachedCount > 0 ? { detachedCount } : {}),
            ...(request.mode === 'group' && detachedCount > 0
                ? { wholeGroupBlocked: true }
                : {}),
            ...(blockingClaims.length ? { blockingClaims } : {}),
            groupRevision: group.revision,
        } as WorktreeGroupDeletionPreview);
        return;
    }
    const blocker = await deps.probeMemberBlocker(
        navigationIdentity, group.groupId, member.memberId);
    const historyCount = await deps.countMemberHistorySessions(
        navigationIdentity, group.groupId, member.memberId);
    const blockingClaims = blockingClaimsFor(member);
    const isPrimary = group.primaryMemberId === member.memberId;
    const survivors = group.members.filter(candidate =>
        candidate.memberId !== member.memberId && candidate.state === 'ready'
        && !candidate.detached);
    await deps.postMessage({
        type: 'worktree-group-deletion-preview', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: group.groupId,
        mode: 'member',
        status: 'ready',
        member: {
            memberId: member.memberId,
            repositoryLabel: deps.getRepositoryLabel(member.repositoryKey),
            path: member.path,
            branchName: member.branchName,
            blocker,
            historyCount,
            isPrimary,
        },
        ...(isPrimary && survivors.length > 0
            ? {
                replacementRequired: true,
                replacementCandidates: survivors.map(candidate => ({
                    memberId: candidate.memberId,
                    repositoryLabel: deps.getRepositoryLabel(candidate.repositoryKey),
                })),
            }
            : {}),
        ...(blockingClaims.length ? { blockingClaims } : {}),
        groupRevision: group.revision,
    } as WorktreeGroupDeletionPreview);
}

export async function handleDeleteWorktreeGroupMember(
    message: unknown,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<void> {
    const request = parseDeleteWorktreeGroupMemberRequest(message);
    if (!request) {
        return;
    }
    const replayed = deps.replayCache.get(request.requestId);
    if (replayed) {
        await deps.postMessage(await replayed);
        return;
    }
    if (deps.replayCache.isExpired(request.requestId)) {
        await deps.postMessage(settledWorktreeGroupDeletionSettlement(
            request, { kind: 'failed', errorCode: 'request-expired' }));
        return;
    }
    const terminal = executeMemberDeletion(request, deps);
    deps.replayCache.remember(request.requestId, terminal);
    await deps.postMessage(await terminal);
}

async function executeMemberDeletion(
    request: ReturnType<typeof parseDeleteWorktreeGroupMemberRequest> & object,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<WorktreeGroupDeletionSettlement> {
    await deps.postMessage(acceptedWorktreeGroupDeletionSettlement(request));
    const fail = (errorCode: string) =>
        settledWorktreeGroupDeletionSettlement(request, { kind: 'failed', errorCode });
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    if (!navigationIdentity) {
        return fail('workspace-unavailable');
    }
    // Stale card: the group drifted since the preview (rename / member
    // change / another deletion). Fail closed; the user re-previews.
    const group = deps.store.listGroups(navigationIdentity)
        .find(candidate => candidate.groupId === request.groupId);
    if (!group || group.revision !== request.baseRevision) {
        return fail('group-changed');
    }
    const mode = request.mode || 'member';
    let memberIds: readonly string[] | undefined;
    if (mode === 'member') {
        memberIds = [request.memberId!];
    } else if (mode === 'visible-only') {
        // The host re-derives the visible set from the authoritative
        // manifest — the card's snapshot may be stale.
        memberIds = group.members
            .filter(candidate => !candidate.detached)
            .map(candidate => candidate.memberId);
        if (memberIds.length === 0) {
            return fail('member-not-ready');
        }
    } else if (group.members.some(candidate => candidate.detached)) {
        // Whole-group deletion may never leave invisible residue (PRD
        // §6.4): the visible-only action exists for that case.
        return fail('member-detached');
    }
    try {
        const outcome = await deps.controller.beginDeletion(
            navigationIdentity, request.groupId, mode, memberIds,
            request.replacementPrimaryMemberId
                ? { replacementPrimaryMemberId: request.replacementPrimaryMemberId }
                : undefined);
        if (outcome.kind === 'blocked') {
            return fail(outcome.errorCode);
        }
        await deps.controller.executeOperation(
            navigationIdentity, outcome.journal.operationId);
    } catch (error) {
        deps.logError('Failed to delete the worktree group member.', error);
        return fail(manifestErrorCode(error));
    }
    // The journal decides the outcome: archived means every target
    // checkpointed; still active means partial failure awaiting Retry.
    const active = deps.store.listDeletionJournals(navigationIdentity)
        .some(entry => entry.groupId === request.groupId);
    await deps.refreshNow();
    const minimumAggregateRevision = deps.store.getAggregateRevision(navigationIdentity);
    return settledWorktreeGroupDeletionSettlement(request, active
        ? { kind: 'partial', minimumAggregateRevision }
        : { kind: 'settled', minimumAggregateRevision });
}

export async function handleRetryWorktreeGroupDeletion(
    message: unknown,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<void> {
    const request = parseRetryWorktreeGroupDeletionRequest(message);
    if (!request) {
        return;
    }
    const replayed = deps.replayCache.get(request.requestId);
    if (replayed) {
        await deps.postMessage(await replayed);
        return;
    }
    if (deps.replayCache.isExpired(request.requestId)) {
        await deps.postMessage(settledWorktreeGroupDeletionSettlement(
            request, { kind: 'failed', errorCode: 'request-expired' }));
        return;
    }
    const terminal = (async (): Promise<WorktreeGroupDeletionSettlement> => {
        await deps.postMessage(acceptedWorktreeGroupDeletionSettlement(request));
        const navigationIdentity = deps.getNavigationIdentity(request.projectId);
        if (!navigationIdentity) {
            return settledWorktreeGroupDeletionSettlement(
                request, { kind: 'failed', errorCode: 'workspace-unavailable' });
        }
        try {
            await deps.store.retryDeletion(navigationIdentity, request.operationId);
            await deps.controller.executeOperation(navigationIdentity, request.operationId);
        } catch (error) {
            deps.logError('Failed to retry the worktree deletion.', error);
            return settledWorktreeGroupDeletionSettlement(
                request, { kind: 'failed', errorCode: manifestErrorCode(error) });
        }
        const active = deps.store.listDeletionJournals(navigationIdentity)
            .some(entry => entry.operationId === request.operationId);
        await deps.refreshNow();
        const minimumAggregateRevision = deps.store.getAggregateRevision(navigationIdentity);
        return settledWorktreeGroupDeletionSettlement(request, active
            ? { kind: 'partial', minimumAggregateRevision }
            : { kind: 'settled', minimumAggregateRevision });
    })();
    deps.replayCache.remember(request.requestId, terminal);
    await deps.postMessage(await terminal);
}

export async function handleAbandonWorktreeGroupDeletion(
    message: unknown,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<void> {
    const request = parseAbandonWorktreeGroupDeletionRequest(message);
    if (!request) {
        return;
    }
    const replayed = deps.replayCache.get(request.requestId);
    if (replayed) {
        await deps.postMessage(await replayed);
        return;
    }
    if (deps.replayCache.isExpired(request.requestId)) {
        await deps.postMessage(settledWorktreeGroupDeletionSettlement(
            request, { kind: 'failed', errorCode: 'request-expired' }));
        return;
    }
    const terminal = (async (): Promise<WorktreeGroupDeletionSettlement> => {
        await deps.postMessage(acceptedWorktreeGroupDeletionSettlement(request));
        const navigationIdentity = deps.getNavigationIdentity(request.projectId);
        if (!navigationIdentity) {
            return settledWorktreeGroupDeletionSettlement(
                request, { kind: 'failed', errorCode: 'workspace-unavailable' });
        }
        try {
            await deps.store.abandonDeletion(navigationIdentity, request.operationId);
        } catch (error) {
            deps.logError('Failed to abandon the worktree deletion.', error);
            return settledWorktreeGroupDeletionSettlement(
                request, { kind: 'failed', errorCode: manifestErrorCode(error) });
        }
        await deps.refreshNow();
        return settledWorktreeGroupDeletionSettlement(request, {
            kind: 'settled',
            minimumAggregateRevision: deps.store.getAggregateRevision(navigationIdentity),
        });
    })();
    deps.replayCache.remember(request.requestId, terminal);
    await deps.postMessage(await terminal);
}

/**
 * The user explicitly releases an orphan pending generation claim that is
 * blocking a deletion (PRD §6.4: the third authoritative release path).
 */
export async function handleDiscardWorktreeGenerationClaim(
    message: unknown,
    deps: WorktreeGroupDeletionHandlerDeps
): Promise<void> {
    const request = parseDiscardWorktreeGenerationClaimRequest(message);
    if (!request) {
        return;
    }
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    let status: 'settled' | 'failed' = 'settled';
    let errorCode: string | undefined;
    if (!navigationIdentity) {
        status = 'failed';
        errorCode = 'workspace-unavailable';
    } else {
        try {
            const removed = await deps.store.removeGenerationClaim(
                navigationIdentity, request.claimId);
            if (!removed) {
                status = 'failed';
                errorCode = 'claim-not-found';
            }
        } catch (error) {
            deps.logError('Failed to discard the generation claim.', error);
            status = 'failed';
            errorCode = manifestErrorCode(error);
        }
    }
    await deps.postMessage({
        type: 'worktree-group-deletion-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
        status,
        ...(errorCode ? { errorCode } : {}),
        ...(status === 'settled' && navigationIdentity
            ? {
                minimumAggregateRevision:
                    deps.store.getAggregateRevision(navigationIdentity),
            }
            : {}),
    } as WorktreeGroupDeletionSettlement);
}
