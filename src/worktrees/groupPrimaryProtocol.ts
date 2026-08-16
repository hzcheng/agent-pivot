'use strict';

/**
 * Request/settlement protocol for the group primary-member mutation. The
 * webview disables the clicked button as a transient pending state; only a
 * settled settlement (or an authoritative refresh) may re-enable it, so the
 * host owes every accepted request exactly one terminal settlement.
 */

export interface SetWorktreeGroupPrimaryRequest {
    type: 'set-worktree-group-primary';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    memberId: string;
}

export type WorktreeGroupPrimarySettlementStatus = 'accepted' | 'settled' | 'failed';

export interface WorktreeGroupPrimarySettlement {
    type: 'worktree-group-primary-settlement';
    version: 1;
    requestId: string;
    groupId: string;
    memberId: string;
    status: WorktreeGroupPrimarySettlementStatus;
    errorCode?: string;
}

/** Accepts only the exact versioned Webview request shape. */
export function parseSetWorktreeGroupPrimaryRequest(
    value: unknown
): SetWorktreeGroupPrimaryRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const expectedKeys = ['groupId', 'memberId', 'projectId', 'requestId', 'type', 'version'];
    const keys = Object.keys(record).sort();
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || record.type !== 'set-worktree-group-primary'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !isSafeId(record.memberId)) {
        return null;
    }
    return record as unknown as SetWorktreeGroupPrimaryRequest;
}

export function acceptedWorktreeGroupPrimarySettlement(
    request: SetWorktreeGroupPrimaryRequest
): WorktreeGroupPrimarySettlement {
    return {
        type: 'worktree-group-primary-settlement', version: 1,
        requestId: request.requestId,
        groupId: request.groupId,
        memberId: request.memberId,
        status: 'accepted',
    };
}

export function settledWorktreeGroupPrimarySettlement(
    request: SetWorktreeGroupPrimaryRequest,
    outcome: { kind: 'settled' } | { kind: 'failed'; errorCode: string }
): WorktreeGroupPrimarySettlement {
    return {
        type: 'worktree-group-primary-settlement', version: 1,
        requestId: request.requestId,
        groupId: request.groupId,
        memberId: request.memberId,
        status: outcome.kind,
        ...(outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : {}),
    };
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function isSafeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value);
}
