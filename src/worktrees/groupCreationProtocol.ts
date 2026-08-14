'use strict';

/**
 * Webview ↔ Host protocol for the M2 inline group creation form. Every
 * mutation request carries a requestId and is answered by exactly one
 * terminal settlement (resilient webview mutation protocol).
 */

export interface OpenWorktreeGroupFormRequest {
    type: 'open-worktree-group-form';
    version: 1;
    projectId: string;
    /** Branch-from-here entry (PRD §6.1): precheck + prefill this repo. */
    seedRepositoryKey?: string;
    seedBaseRef?: string;
}

export interface PreviewWorktreeGroupRequest {
    type: 'preview-worktree-group';
    version: 1;
    requestId: string;
    projectId: string;
    displayName: string;
    selections: { repositoryKey: string; baseRef?: string }[];
}

export interface ConfirmWorktreeGroupRequest {
    type: 'confirm-worktree-group';
    version: 1;
    requestId: string;
    projectId: string;
    displayName: string;
    primaryRepositoryKey?: string;
    members: {
        repositoryKey: string;
        baseRef: string;
        branchName: string;
        worktreePath: string;
        setupCommand: string[];
    }[];
}

export interface WorktreeGroupMemberRequest {
    type: 'retry-worktree-group-member' | 'dismiss-worktree-group-member';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    memberId: string;
}

export interface WorktreeGroupCreationSettlement {
    type: 'worktree-group-creation-settlement';
    version: 1;
    requestId: string;
    status: 'accepted' | 'created' | 'failed';
    groupId?: string;
    errorCode?: string;
}

export interface WorktreeGroupMemberSettlement {
    type: 'worktree-group-member-settlement';
    version: 1;
    requestId: string;
    groupId: string;
    memberId: string;
    status: 'accepted' | 'settled' | 'failed';
    errorCode?: string;
}

export function parseOpenWorktreeGroupFormRequest(
    value: unknown
): OpenWorktreeGroupFormRequest | null {
    if (!isRecord(value) || value.type !== 'open-worktree-group-form'
        || value.version !== 1 || !isSafeString(value.projectId)) {
        return null;
    }
    const hasSeed = value.seedRepositoryKey !== undefined
        || value.seedBaseRef !== undefined;
    const expected = hasSeed
        ? ['projectId', 'seedBaseRef', 'seedRepositoryKey', 'type', 'version']
        : ['projectId', 'type', 'version'];
    if (!sameKeys(value, expected)
        || (hasSeed && (!isSafeString(value.seedRepositoryKey)
            || !isSafeRef(value.seedBaseRef)))) {
        return null;
    }
    return value as unknown as OpenWorktreeGroupFormRequest;
}

export function parsePreviewWorktreeGroupRequest(
    value: unknown
): PreviewWorktreeGroupRequest | null {
    if (!isRecord(value) || value.type !== 'preview-worktree-group'
        || value.version !== 1
        || !isSafeId(value.requestId) || !isSafeString(value.projectId)
        || typeof value.displayName !== 'string'
        || value.displayName.length > 1024
        || !Array.isArray(value.selections)) {
        return null;
    }
    if (!sameKeys(value, ['displayName', 'projectId', 'requestId', 'selections', 'type', 'version'])) {
        return null;
    }
    const selections: PreviewWorktreeGroupRequest['selections'] = [];
    for (const candidate of value.selections.slice(0, 32)) {
        if (!isRecord(candidate) || !isSafeString(candidate.repositoryKey)) {
            return null;
        }
        const hasOverride = candidate.baseRef !== undefined;
        const expected = hasOverride ? ['baseRef', 'repositoryKey'] : ['repositoryKey'];
        if (!sameKeys(candidate, expected)
            || (hasOverride && !isSafeRef(candidate.baseRef))) {
            return null;
        }
        selections.push(hasOverride
            ? { repositoryKey: candidate.repositoryKey, baseRef: candidate.baseRef as string }
            : { repositoryKey: candidate.repositoryKey });
    }
    return {
        type: 'preview-worktree-group', version: 1,
        requestId: value.requestId,
        projectId: value.projectId,
        displayName: value.displayName,
        selections,
    };
}

export function parseConfirmWorktreeGroupRequest(
    value: unknown
): ConfirmWorktreeGroupRequest | null {
    if (!isRecord(value) || value.type !== 'confirm-worktree-group'
        || value.version !== 1
        || !isSafeId(value.requestId) || !isSafeString(value.projectId)
        || typeof value.displayName !== 'string'
        || !value.displayName.trim() || value.displayName.length > 1024
        || !Array.isArray(value.members) || value.members.length === 0) {
        return null;
    }
    const hasPrimary = value.primaryRepositoryKey !== undefined;
    const expected = hasPrimary
        ? ['displayName', 'members', 'primaryRepositoryKey', 'projectId', 'requestId', 'type', 'version']
        : ['displayName', 'members', 'projectId', 'requestId', 'type', 'version'];
    if (!sameKeys(value, expected)
        || (hasPrimary && !isSafeString(value.primaryRepositoryKey))) {
        return null;
    }
    const members: ConfirmWorktreeGroupRequest['members'] = [];
    for (const candidate of value.members.slice(0, 17)) {
        if (!isRecord(candidate)
            || !sameKeys(candidate, [
                'baseRef', 'branchName', 'repositoryKey', 'setupCommand', 'worktreePath',
            ])
            || !isSafeString(candidate.repositoryKey)
            || !isSafeString(candidate.branchName)
            || !isSafeString(candidate.worktreePath)
            || !isSafeRef(candidate.baseRef)
            || !Array.isArray(candidate.setupCommand)
            || candidate.setupCommand.length > 128
            || !(candidate.setupCommand as unknown[]).every(isSafeString)) {
            return null;
        }
        members.push(candidate as unknown as ConfirmWorktreeGroupRequest['members'][number]);
    }
    if (members.length !== value.members.length) {
        return null;
    }
    return {
        type: 'confirm-worktree-group', version: 1,
        requestId: value.requestId,
        projectId: value.projectId,
        displayName: value.displayName,
        ...(hasPrimary ? { primaryRepositoryKey: value.primaryRepositoryKey as string } : {}),
        members,
    };
}

export function parseWorktreeGroupMemberRequest(
    value: unknown
): WorktreeGroupMemberRequest | null {
    if (!isRecord(value)
        || (value.type !== 'retry-worktree-group-member'
            && value.type !== 'dismiss-worktree-group-member')
        || value.version !== 1
        || !isSafeId(value.requestId) || !isSafeString(value.projectId)
        || !isSafeId(value.groupId) || !isSafeId(value.memberId)) {
        return null;
    }
    if (!sameKeys(value, ['groupId', 'memberId', 'projectId', 'requestId', 'type', 'version'])) {
        return null;
    }
    return value as unknown as WorktreeGroupMemberRequest;
}

export function acceptedWorktreeGroupCreationSettlement(
    request: ConfirmWorktreeGroupRequest
): WorktreeGroupCreationSettlement {
    return {
        type: 'worktree-group-creation-settlement', version: 1,
        requestId: request.requestId, status: 'accepted',
    };
}

export function settledWorktreeGroupCreationSettlement(
    request: ConfirmWorktreeGroupRequest,
    outcome: { kind: 'created'; groupId: string } | { kind: 'failed'; errorCode: string }
): WorktreeGroupCreationSettlement {
    return {
        type: 'worktree-group-creation-settlement', version: 1,
        requestId: request.requestId,
        status: outcome.kind === 'created' ? 'created' : 'failed',
        ...(outcome.kind === 'created'
            ? { groupId: outcome.groupId }
            : { errorCode: outcome.errorCode }),
    };
}

export function acceptedWorktreeGroupMemberSettlement(
    request: WorktreeGroupMemberRequest
): WorktreeGroupMemberSettlement {
    return {
        type: 'worktree-group-member-settlement', version: 1,
        requestId: request.requestId,
        groupId: request.groupId, memberId: request.memberId,
        status: 'accepted',
    };
}

export function settledWorktreeGroupMemberSettlement(
    request: WorktreeGroupMemberRequest,
    outcome: { kind: 'settled' } | { kind: 'failed'; errorCode: string }
): WorktreeGroupMemberSettlement {
    return {
        type: 'worktree-group-member-settlement', version: 1,
        requestId: request.requestId,
        groupId: request.groupId, memberId: request.memberId,
        status: outcome.kind,
        ...(outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(record).sort();
    return keys.length === expected.length
        && keys.every((key, index) => key === expected[index]);
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function isSafeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value);
}

function isSafeRef(value: unknown): value is string {
    return isSafeString(value) && !String(value).startsWith('-');
}
