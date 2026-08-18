import type { WorktreeGroupCreationController } from '../worktrees/groupCreationController';
import {
    acceptedWorktreeGroupCreationSettlement,
    acceptedWorktreeGroupMemberSettlement,
    parseConfirmWorktreeGroupRequest,
    parseOpenWorktreeGroupFormRequest,
    parsePreviewWorktreeGroupRequest,
    parseWorktreeGroupMemberRequest,
    settledWorktreeGroupCreationSettlement,
    settledWorktreeGroupMemberSettlement,
} from '../worktrees/groupCreationProtocol';
import type { WorktreeSnapshot } from '../worktrees/types';

export interface WorktreeGroupFormHandlersOptions {
    controller: WorktreeGroupCreationController;
    postMessage: (message: unknown) => Thenable<boolean>;
    getSnapshot: () => WorktreeSnapshot | null;
    logError: (message: string, error: unknown) => void;
}

/**
 * The worktree-group form message family (open/preview/confirm/retry/dismiss).
 * Extracted verbatim from the composition root so the accepted→settled chain
 * is unit-testable; behavior is byte-identical to the inline handlers.
 */
export function createWorktreeGroupFormHandlers(
    options: WorktreeGroupFormHandlersOptions,
): Record<string, (message: unknown) => Promise<void>> {
    const { controller, postMessage, getSnapshot, logError } = options;
    return {
        'open-worktree-group-form': async (message: unknown) => {
            const request = parseOpenWorktreeGroupFormRequest(message);
            if (!request) {
                return;
            }
            // Add repo (PRD §6.3): the form lists only repositories not
            // already in the group, locks the group name, and prechecks
            // only the active editor's repository when eligible.
            const addRepo = request.targetGroupId
                ? await controller.listAddRepoOptions(
                    request.projectId, request.targetGroupId)
                : null;
            if (request.targetGroupId && !addRepo) {
                return;
            }
            const repositories = addRepo
                ? addRepo.options
                : await controller
                    .listRepositoryOptions(request.projectId);
            // Derive (PRD §6.2): prefill name, selection, and base refs
            // from the source group; the group itself is never modified.
            const derive = request.sourceGroupId
                ? await controller.deriveFormContext(
                    request.projectId, request.sourceGroupId)
                : null;
            // Branch-from-here (PRD §6.1): resolve the seed worktree's
            // branch so the form can prefill the base-ref override.
            const seedWorktree = request.seedRepositoryKey
                && request.seedWorktreePath
                ? getSnapshot()?.repositories
                    .find(candidate =>
                        candidate.repositoryKey === request.seedRepositoryKey)
                    ?.worktrees.find(candidate =>
                        candidate.key.canonicalWorktreePath
                            === request.seedWorktreePath)
                : undefined;
            await postMessage({
                type: 'worktree-group-form-state',
                version: 1,
                projectId: request.projectId,
                ...(addRepo
                    ? {
                        addRepo: {
                            groupId: addRepo.group.groupId,
                            displayName: addRepo.group.displayName,
                        },
                    }
                    : {}),
                ...(derive ? { derive } : {}),
                ...(request.seedRepositoryKey && seedWorktree?.branchRef
                    ? {
                        seed: {
                            repositoryKey: request.seedRepositoryKey,
                            baseRef: seedWorktree.branchRef,
                        },
                    }
                    : {}),
                repositories,
            });
        },
        'preview-worktree-group': async (message: unknown) => {
            const request = parsePreviewWorktreeGroupRequest(message);
            if (!request) {
                return;
            }
            const preview = await controller.preview(
                request.projectId, request.displayName, request.selections,
                request.sourceGroupId, request.targetGroupId);
            await postMessage({
                type: 'worktree-group-preview',
                version: 1,
                requestId: request.requestId,
                projectId: request.projectId,
                previewId: preview.previewId,
                slug: preview.slug,
                ...(preview.formError ? { formError: preview.formError } : {}),
                members: preview.members,
            });
        },
        'confirm-worktree-group': async (message: unknown) => {
            const request = parseConfirmWorktreeGroupRequest(message);
            if (!request) {
                return;
            }
            await postMessage(
                acceptedWorktreeGroupCreationSettlement(request));
            // Every accepted request owes exactly one terminal settlement —
            // the webview keeps its confirm button pending until it lands.
            const result = await controller.confirm({
                projectId: request.projectId,
                previewId: request.previewId,
                displayName: request.displayName,
                members: request.members,
                ...(request.primaryRepositoryKey
                    ? { primaryRepositoryKey: request.primaryRepositoryKey }
                    : {}),
                ...(request.targetGroupId
                    ? { targetGroupId: request.targetGroupId }
                    : {}),
            }).catch(error => {
                logError('Failed to confirm the worktree group creation.', error);
                return { kind: 'failed' as const, errorCode: 'unexpected-error' };
            });
            await postMessage(
                settledWorktreeGroupCreationSettlement(request, result));
        },
        'retry-worktree-group-member': async (message: unknown) => {
            const request = parseWorktreeGroupMemberRequest(message);
            if (!request || request.type !== 'retry-worktree-group-member') {
                return;
            }
            await postMessage(
                acceptedWorktreeGroupMemberSettlement(request));
            const outcome = await controller.retryMember(
                request.projectId, request.groupId, request.memberId)
                .catch(error => {
                    logError('Failed to retry the worktree group member.', error);
                    return {
                        kind: 'failed' as const,
                        operationId: request.memberId,
                        errorCode: 'unexpected-error',
                    };
                });
            await postMessage(settledWorktreeGroupMemberSettlement(
                request,
                outcome.kind === 'succeeded'
                    ? { kind: 'settled' }
                    : { kind: 'failed', errorCode: outcome.errorCode }));
        },
        'dismiss-worktree-group-member': async (message: unknown) => {
            const request = parseWorktreeGroupMemberRequest(message);
            if (!request || request.type !== 'dismiss-worktree-group-member') {
                return;
            }
            await postMessage(
                acceptedWorktreeGroupMemberSettlement(request));
            const dismissed = await controller.dismissMember(
                request.projectId, request.groupId, request.memberId)
                .catch(error => {
                    logError('Failed to dismiss the worktree group member.', error);
                    return 'unavailable' as const;
                });
            await postMessage(settledWorktreeGroupMemberSettlement(
                request,
                dismissed === 'dismissed'
                    ? { kind: 'settled' }
                    : {
                        kind: 'failed',
                        errorCode: dismissed === 'store-full'
                            ? 'store-full' : 'dismiss-unavailable',
                    }));
        },
    };
}
