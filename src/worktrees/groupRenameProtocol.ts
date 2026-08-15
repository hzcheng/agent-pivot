'use strict';

/**
 * Request/settlement protocol for the group rename mutation (PRD §5.2:
 * rename regenerates the suggested slug; displayName + suggestedSlug +
 * revision land in a single store write). The webview disables the rename
 * input as a transient pending state; only a terminal settlement (or the
 * correlated authoritative replacement) may resolve it, so the host owes
 * every accepted request exactly one terminal settlement.
 */

export interface RenameWorktreeGroupRequest {
    type: 'rename-worktree-group';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    displayName: string;
    /** The group revision the editor saw; staleness fails closed. */
    baseRevision: number;
}

export type WorktreeGroupRenameSettlementStatus = 'accepted' | 'settled' | 'failed';

export interface WorktreeGroupRenameSettlement {
    type: 'worktree-group-rename-settlement';
    version: 1;
    requestId: string;
    projectId: string;
    groupId: string;
    status: WorktreeGroupRenameSettlementStatus;
    errorCode?: string;
}

/** Accepts only the exact versioned Webview request shape. */
export function parseRenameWorktreeGroupRequest(
    value: unknown
): RenameWorktreeGroupRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const expectedKeys = [
        'baseRevision', 'displayName', 'groupId', 'projectId', 'requestId', 'type', 'version',
    ];
    const keys = Object.keys(record).sort();
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || record.type !== 'rename-worktree-group'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !isSafeId(record.groupId)
        || !isDisplayName(record.displayName)
        || typeof record.baseRevision !== 'number'
        || !Number.isSafeInteger(record.baseRevision)
        || record.baseRevision < 1) {
        return null;
    }
    return record as unknown as RenameWorktreeGroupRequest;
}

export function acceptedWorktreeGroupRenameSettlement(
    request: RenameWorktreeGroupRequest
): WorktreeGroupRenameSettlement {
    return {
        type: 'worktree-group-rename-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
        status: 'accepted',
    };
}

export function settledWorktreeGroupRenameSettlement(
    request: RenameWorktreeGroupRequest,
    outcome: { kind: 'settled' } | { kind: 'failed'; errorCode: string }
): WorktreeGroupRenameSettlement {
    return {
        type: 'worktree-group-rename-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        groupId: request.groupId,
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

/** Mirrors the store's display-name bounds so bad input fails at the edge. */
function isDisplayName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
        && value.length <= 200 && !/[\0\r\n]/u.test(value);
}
