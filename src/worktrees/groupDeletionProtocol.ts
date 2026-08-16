'use strict';

/**
 * Request/preview/settlement protocol for the journaled member-level
 * worktree deletion (PRD §6.4, batch 4). Mirrors the hardened rename
 * protocol: per-document-nonce request ids, `projectId` correlation on
 * every message, single-flight settlement replay on the host, and a
 * terminal settlement that keeps the webview pending until the
 * authoritative replacement lands.
 *
 * Batch 4 issues only mode 'member' (exactly one member); the store and
 * journal already support 'group' / 'visible-only' for batch 5.
 */

export type WorktreeGroupDeletionRequestMode = 'member' | 'group' | 'visible-only';

export interface PreviewWorktreeGroupDeletionRequest {
    type: 'preview-worktree-group-deletion';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    mode: WorktreeGroupDeletionRequestMode;
    /** Required for mode 'member'; absent for the group-level modes. */
    memberId?: string;
}

export interface WorktreeGroupDeletionPreviewMember {
    memberId: string;
    repositoryLabel: string;
    path: string;
    branchName: string;
    /** Blocker error code, or null when the member may be deleted. */
    blocker: string | null;
    /** Frozen-at-confirm history session count (advisory display). */
    historyCount: number;
    isPrimary: boolean;
}

export interface WorktreeGroupDeletionPreview {
    type: 'worktree-group-deletion-preview';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    mode?: WorktreeGroupDeletionRequestMode;
    status: 'ready' | 'failed';
    errorCode?: string;
    /** Mode 'member': the single target. */
    member?: WorktreeGroupDeletionPreviewMember;
    /** Group modes: every visible member with its own gate result. */
    members?: WorktreeGroupDeletionPreviewMember[];
    /** Detached members (repository left the workspace) cannot be deleted. */
    detachedCount?: number;
    /**
     * Whole-group deletion is blocked while detached members exist (PRD
     * §6.4): the card offers the visible-only action instead.
     */
    wholeGroupBlocked?: boolean;
    /** Deleting the primary with ready survivors requires a choice. */
    replacementRequired?: boolean;
    replacementCandidates?: { memberId: string; repositoryLabel: string }[];
    /** Pending generation claims blocking the deletion (PRD §6.4). */
    blockingClaims?: { claimId: string; provider?: string }[];
    /** The group revision the preview was computed against. */
    groupRevision?: number;
}

export interface DeleteWorktreeGroupMemberRequest {
    type: 'delete-worktree-group-member';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    mode?: WorktreeGroupDeletionRequestMode;
    /** Required for mode 'member' (or a legacy modeless request). */
    memberId?: string;
    /** The group revision the confirmation card saw; drift fails closed. */
    baseRevision: number;
    /** Decision I: chosen replacement when the deleted member is primary. */
    replacementPrimaryMemberId?: string;
}

export type WorktreeGroupDeletionSettlementStatus =
    | 'accepted' | 'settled' | 'partial' | 'failed';

export interface WorktreeGroupDeletionSettlement {
    type: 'worktree-group-deletion-settlement';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    status: WorktreeGroupDeletionSettlementStatus;
    errorCode?: string;
    /** The aggregate revision the mutation produced (decision J). */
    minimumAggregateRevision?: number;
}

export interface RetryWorktreeGroupDeletionRequest {
    type: 'retry-worktree-group-deletion';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    operationId: string;
}

export interface AbandonWorktreeGroupDeletionRequest {
    type: 'abandon-worktree-group-deletion';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    operationId: string;
}

export interface DiscardWorktreeGenerationClaimRequest {
    type: 'discard-worktree-generation-claim';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    claimId: string;
}

const ERROR_CODE_PATTERN = /^[a-z0-9-]{1,64}$/u;

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function isSafeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(record).sort();
    const sorted = [...expected].sort();
    return keys.length === sorted.length
        && keys.every((key, index) => key === sorted[index]);
}

export function parsePreviewWorktreeGroupDeletionRequest(
    value: unknown
): PreviewWorktreeGroupDeletionRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const baseKeys = [
        'groupId', 'memberId', 'mode', 'projectId', 'requestId', 'type', 'version',
    ];
    if ((!hasExactKeys(record, baseKeys)
            && !hasExactKeys(record, baseKeys.filter(key => key !== 'memberId')))
        || record.type !== 'preview-worktree-group-deletion'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !['member', 'group', 'visible-only'].includes(record.mode as string)
        || (record.mode === 'member' && !isSafeId(record.memberId))
        || (record.memberId !== undefined && !isSafeId(record.memberId))
        || (record.mode !== 'member' && record.memberId !== undefined)) {
        return null;
    }
    return record as unknown as PreviewWorktreeGroupDeletionRequest;
}

export function parseDeleteWorktreeGroupMemberRequest(
    value: unknown
): DeleteWorktreeGroupMemberRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const baseKeys = [
        'baseRevision', 'groupId', 'memberId', 'mode', 'projectId', 'requestId',
        'type', 'version',
    ];
    const withReplacement = [...baseKeys, 'replacementPrimaryMemberId'];
    const withoutMember = baseKeys.filter(key => key !== 'memberId');
    const withoutMemberWithReplacement = [...withoutMember, 'replacementPrimaryMemberId'];
    const legacyMember = baseKeys.filter(key => key !== 'mode');
    const legacyMemberWithReplacement = [...legacyMember, 'replacementPrimaryMemberId'];
    if (![baseKeys, withReplacement, withoutMember, withoutMemberWithReplacement,
            legacyMember, legacyMemberWithReplacement]
            .some(expected => hasExactKeys(record, expected))
        || record.type !== 'delete-worktree-group-member'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || (record.mode !== undefined
            && !['member', 'group', 'visible-only'].includes(record.mode as string))
        || (record.memberId !== undefined && !isSafeId(record.memberId))
        || ((record.mode || 'member') === 'member' && !isSafeId(record.memberId))
        || typeof record.baseRevision !== 'number'
        || !Number.isSafeInteger(record.baseRevision)
        || record.baseRevision < 1
        || (record.replacementPrimaryMemberId !== undefined
            && !isSafeId(record.replacementPrimaryMemberId))) {
        return null;
    }
    return record as unknown as DeleteWorktreeGroupMemberRequest;
}

export function parseRetryWorktreeGroupDeletionRequest(
    value: unknown
): RetryWorktreeGroupDeletionRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, [
        'groupId', 'operationId', 'projectId', 'requestId', 'type', 'version',
    ]) || record.type !== 'retry-worktree-group-deletion'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !isSafeId(record.operationId)) {
        return null;
    }
    return record as unknown as RetryWorktreeGroupDeletionRequest;
}

export function parseAbandonWorktreeGroupDeletionRequest(
    value: unknown
): AbandonWorktreeGroupDeletionRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, [
        'groupId', 'operationId', 'projectId', 'requestId', 'type', 'version',
    ]) || record.type !== 'abandon-worktree-group-deletion'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !isSafeId(record.operationId)) {
        return null;
    }
    return record as unknown as AbandonWorktreeGroupDeletionRequest;
}

export function parseDiscardWorktreeGenerationClaimRequest(
    value: unknown
): DiscardWorktreeGenerationClaimRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, [
        'claimId', 'groupId', 'projectId', 'requestId', 'type', 'version',
    ]) || record.type !== 'discard-worktree-generation-claim'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !isSafeId(record.claimId)) {
        return null;
    }
    return record as unknown as DiscardWorktreeGenerationClaimRequest;
}

export function acceptedWorktreeGroupDeletionSettlement(
    request: { requestId: string; projectId: string; groupId: string }
): WorktreeGroupDeletionSettlement {
    return {
        type: 'worktree-group-deletion-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
        status: 'accepted',
    };
}

export function settledWorktreeGroupDeletionSettlement(
    request: { requestId: string; projectId: string; groupId: string },
    outcome:
        | { kind: 'settled'; minimumAggregateRevision: number }
        | { kind: 'partial'; minimumAggregateRevision: number }
        | { kind: 'failed'; errorCode: string }
): WorktreeGroupDeletionSettlement {
    return {
        type: 'worktree-group-deletion-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
        status: outcome.kind,
        ...(outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.kind !== 'failed'
            ? { minimumAggregateRevision: outcome.minimumAggregateRevision }
            : {}),
    };
}

export { ERROR_CODE_PATTERN as WORKTREE_GROUP_DELETION_ERROR_CODE_PATTERN };
