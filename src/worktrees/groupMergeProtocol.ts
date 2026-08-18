'use strict';

/**
 * Request/settlement protocol for merging a worktree group into another
 * (PRD §6.5). Same envelope family as rename/deletion: version 1, exact key
 * sets, requestId correlation, and an accepted→settled pair so the webview
 * never hangs.
 */

export interface MergeWorktreeGroupsRequest {
    type: 'merge-worktree-groups';
    version: 1;
    requestId: string;
    projectId: string;
    sourceGroupId: string;
}

export interface WorktreeGroupMergeSettlement {
    type: 'worktree-group-merge-settlement';
    version: 1;
    requestId: string;
    status: 'accepted' | 'merged' | 'cancelled' | 'failed';
    groupId?: string;
    errorCode?: string;
}

const REQUEST_KEYS = ['projectId', 'requestId', 'sourceGroupId', 'type', 'version'];
const ERROR_CODE = /^[a-z0-9-]{1,64}$/u;

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
    return typeof value === 'string' && value.length > 0 && value.length <= 32768
        && !/[\0\r\n]/u.test(value);
}

export function parseMergeWorktreeGroupsRequest(
    value: unknown
): MergeWorktreeGroupsRequest | null {
    if (!isRecord(value) || value.type !== 'merge-worktree-groups'
        || value.version !== 1
        || !isSafeId(value.requestId) || !isSafeString(value.projectId)
        || !isSafeId(value.sourceGroupId)
        || !sameKeys(value, REQUEST_KEYS)) {
        return null;
    }
    return value as unknown as MergeWorktreeGroupsRequest;
}

export function acceptedWorktreeGroupMergeSettlement(
    request: MergeWorktreeGroupsRequest
): WorktreeGroupMergeSettlement {
    return {
        type: 'worktree-group-merge-settlement', version: 1,
        requestId: request.requestId, status: 'accepted',
    };
}

export function settledWorktreeGroupMergeSettlement(
    request: MergeWorktreeGroupsRequest,
    outcome: { kind: 'merged'; groupId: string }
        | { kind: 'cancelled' }
        | { kind: 'failed'; errorCode: string }
): WorktreeGroupMergeSettlement {
    return {
        type: 'worktree-group-merge-settlement', version: 1,
        requestId: request.requestId,
        status: outcome.kind,
        ...(outcome.kind === 'merged' ? { groupId: outcome.groupId } : {}),
        ...(outcome.kind === 'failed' && ERROR_CODE.test(outcome.errorCode)
            ? { errorCode: outcome.errorCode } : {}),
    };
}
