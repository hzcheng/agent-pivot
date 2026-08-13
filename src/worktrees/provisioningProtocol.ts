'use strict';

import type {
    IsolatedSessionStartOutcome,
} from './isolatedSessionController';
import type { WorktreeProvisioningOutcome } from './provisioningController';

export type IsolatedSessionRequest =
  | {
      type: 'start-isolated-session'; version: 1; requestId: string; projectId: string;
      /** When present, the new worktree branches from this worktree's branch. */
      sourceWorktree?: { repositoryKey: string; canonicalWorktreePath: string };
  }
  | {
      type: 'retry-isolated-session'; version: 1;
      requestId: string; projectId: string; operationId: string;
  }
  | {
      type: 'cancel-isolated-session'; version: 1;
      requestId: string; projectId: string; operationId: string;
  };

export type IsolatedSessionSettlementStatus =
  | 'accepted'
  | 'cancelled'
  | 'rejected'
  | 'succeeded'
  | 'partial'
  | 'failed';

export interface IsolatedSessionSettlement {
    type: 'isolated-session-settlement';
    version: 1;
    requestId: string;
    operationId: string;
    status: IsolatedSessionSettlementStatus;
    errorCode?: string;
}

/** Accepts only the exact versioned Webview request shape. */
export function parseIsolatedSessionRequest(value: unknown): IsolatedSessionRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const type = record.type;
    const hasOperation = type === 'retry-isolated-session'
        || type === 'cancel-isolated-session';
    if (type !== 'start-isolated-session' && !hasOperation) {
        return null;
    }
    const sourceWorktree = parseSourceWorktree(record.sourceWorktree);
    const expectedKeys = hasOperation
        ? ['operationId', 'projectId', 'requestId', 'type', 'version']
        : sourceWorktree
            ? ['projectId', 'requestId', 'sourceWorktree', 'type', 'version']
            : ['projectId', 'requestId', 'type', 'version'];
    if (!sameKeys(record, expectedKeys)
        || record.version !== 1
        || !isSafeId(record.requestId)
        || !isSafeProjectId(record.projectId)
        || (hasOperation && !isSafeId(record.operationId))) {
        return null;
    }
    if (!hasOperation && record.sourceWorktree !== undefined && !sourceWorktree) {
        return null;
    }
    return hasOperation
        ? ({
            type, version: 1,
            requestId: record.requestId as string,
            projectId: record.projectId as string,
            operationId: record.operationId as string,
        } as IsolatedSessionRequest)
        : {
            type: 'start-isolated-session', version: 1,
            requestId: record.requestId as string,
            projectId: record.projectId as string,
            ...(sourceWorktree ? { sourceWorktree } : {}),
        };
}

function parseSourceWorktree(
    value: unknown
): { repositoryKey: string; canonicalWorktreePath: string } | null {
    if (value === undefined) {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (!sameKeys(record, ['canonicalWorktreePath', 'repositoryKey'])
        || !isSafeProjectId(record.repositoryKey)
        || !isSafeProjectId(record.canonicalWorktreePath)) {
        return null;
    }
    return {
        repositoryKey: record.repositoryKey as string,
        canonicalWorktreePath: record.canonicalWorktreePath as string,
    };
}

export function acceptedIsolatedSessionSettlement(
    request: IsolatedSessionRequest
): IsolatedSessionSettlement {
    return {
        type: 'isolated-session-settlement', version: 1,
        requestId: request.requestId,
        operationId: request.type === 'start-isolated-session'
            ? request.requestId : request.operationId,
        status: 'accepted',
    };
}

export function settledIsolatedSessionSettlement(
    request: IsolatedSessionRequest,
    outcome: IsolatedSessionStartOutcome | WorktreeProvisioningOutcome
): IsolatedSessionSettlement {
    const operationId = request.type === 'start-isolated-session'
        ? request.requestId : request.operationId;
    const status = outcome.kind;
    return {
        type: 'isolated-session-settlement', version: 1,
        requestId: request.requestId,
        operationId,
        status,
        ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {}),
    };
}

export function cancelledMutationSettlement(
    request: {
        type: 'cancel-isolated-session'; version: 1; requestId: string;
        projectId: string; operationId: string;
    },
    accepted: boolean
): IsolatedSessionSettlement {
    return {
        type: 'isolated-session-settlement', version: 1,
        requestId: request.requestId,
        operationId: request.operationId,
        status: accepted ? 'succeeded' : 'rejected',
        ...(!accepted ? { errorCode: 'cancel-unavailable' } : {}),
    };
}

function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(record).sort();
    return keys.length === expected.length
        && keys.every((key, index) => key === expected[index]);
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string'
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function isSafeProjectId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024
        && !/[\0\r\n]/u.test(value);
}
