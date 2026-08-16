'use strict';

import * as path from 'path';
import type { ManagedWorktreeRemovalOutcome } from './managedWorktreeRemovalController';

export interface ManagedWorktreeRemovalRequest {
    type: 'remove-managed-worktree';
    version: 1;
    requestId: string;
    projectId: string;
    repositoryKey: string;
    worktreePath: string;
}

export interface ManagedWorktreeRemovalSettlement {
    type: 'managed-worktree-removal-settlement';
    version: 1;
    requestId: string;
    status: 'accepted' | ManagedWorktreeRemovalOutcome['kind'];
    errorCode?: string;
}

export function parseManagedWorktreeRemovalRequest(
    value: unknown
): ManagedWorktreeRemovalRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const expected = [
        'projectId', 'repositoryKey', 'requestId', 'type', 'version', 'worktreePath',
    ];
    const keys = Object.keys(record).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
        || record.type !== 'remove-managed-worktree' || record.version !== 1
        || !safeId(record.requestId) || !safeString(record.projectId)
        || !absolutePath(record.repositoryKey) || !absolutePath(record.worktreePath)) {
        return null;
    }
    return record as unknown as ManagedWorktreeRemovalRequest;
}

export function acceptedManagedWorktreeRemovalSettlement(
    request: ManagedWorktreeRemovalRequest
): ManagedWorktreeRemovalSettlement {
    return {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: request.requestId, status: 'accepted',
    };
}

export function settledManagedWorktreeRemovalSettlement(
    request: ManagedWorktreeRemovalRequest,
    outcome: ManagedWorktreeRemovalOutcome
): ManagedWorktreeRemovalSettlement {
    return {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: request.requestId, status: outcome.kind,
        ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {}),
    };
}

function safeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function safeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value);
}

function absolutePath(value: unknown): value is string {
    return safeString(value) && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}
