'use strict';

/**
 * Request/settlement protocol for adopting unmanaged worktrees into a
 * group (PRD §6.5, batch 8): the webview sends the selected worktree keys
 * and either a new-group display name or an existing target group; the
 * host re-validates everything against the live snapshot and manifest
 * before a single aggregate write. Same hardening as the other mutation
 * protocols: nonce'd request ids, projectId correlation, exactly one
 * terminal settlement.
 */

export interface AdoptWorktreesRequest {
    type: 'adopt-worktrees';
    version: 1;
    requestId: string;
    projectId: string;
    members: { repositoryKey: string; canonicalWorktreePath: string }[];
    /** New-group name; absent when targetGroupId is present. */
    displayName?: string;
    /** Existing group to adopt into; absent creates a new group. */
    targetGroupId?: string;
}

export interface WorktreeAdoptSettlement {
    type: 'worktree-adopt-settlement';
    version: 1;
    requestId: string;
    projectId: string;
    status: 'accepted' | 'settled' | 'failed';
    errorCode?: string;
    groupId?: string;
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function isSafeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value);
}

export function parseAdoptWorktreesRequest(value: unknown): AdoptWorktreesRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const baseKeys = ['members', 'projectId', 'requestId', 'type', 'version'];
    const withName = [...baseKeys, 'displayName'];
    const withTarget = [...baseKeys, 'targetGroupId'];
    const keys = Object.keys(record).sort();
    const matches = [baseKeys, withName, withTarget]
        .map(expected => expected.slice().sort())
        .some(expected => keys.length === expected.length
            && keys.every((key, index) => key === expected[index]));
    if (!matches
        || record.type !== 'adopt-worktrees'
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeString(record.projectId)
        || !Array.isArray(record.members)
        || record.members.length === 0
        || (record.displayName !== undefined && !isSafeString(record.displayName))
        || (record.targetGroupId !== undefined && !isSafeId(record.targetGroupId))) {
        return null;
    }
    const members: AdoptWorktreesRequest['members'] = [];
    for (const candidate of (record.members as unknown[]).slice(0, 64)) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return null;
        }
        const member = candidate as Record<string, unknown>;
        const memberKeys = Object.keys(member).sort();
        if (memberKeys.length !== 2
            || memberKeys[0] !== 'canonicalWorktreePath'
            || memberKeys[1] !== 'repositoryKey'
            || !isSafeString(member.repositoryKey)
            || !isSafeString(member.canonicalWorktreePath)) {
            return null;
        }
        members.push({
            repositoryKey: member.repositoryKey as string,
            canonicalWorktreePath: member.canonicalWorktreePath as string,
        });
    }
    if (members.length !== (record.members as unknown[]).length) {
        return null;
    }
    return {
        type: 'adopt-worktrees', version: 1,
        requestId: record.requestId as string,
        projectId: record.projectId as string,
        members,
        ...(record.displayName !== undefined
            ? { displayName: record.displayName as string }
            : {}),
        ...(record.targetGroupId !== undefined
            ? { targetGroupId: record.targetGroupId as string }
            : {}),
    };
}

export function acceptedWorktreeAdoptSettlement(
    request: AdoptWorktreesRequest
): WorktreeAdoptSettlement {
    return {
        type: 'worktree-adopt-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        status: 'accepted',
    };
}

export function settledWorktreeAdoptSettlement(
    request: AdoptWorktreesRequest,
    outcome: { kind: 'settled'; groupId: string } | { kind: 'failed'; errorCode: string }
): WorktreeAdoptSettlement {
    return {
        type: 'worktree-adopt-settlement', version: 1,
        requestId: request.requestId,
        projectId: request.projectId,
        status: outcome.kind,
        ...(outcome.kind === 'settled' ? { groupId: outcome.groupId } : {}),
        ...(outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : {}),
    };
}
