'use strict';

export const MANAGED_REMOTE_MANAGEMENT_PROTOCOL_VERSION = 1;

export type ManagedRemoteManagementOperation =
    | 'addMachine'
    | 'editMachine'
    | 'removeMachine'
    | 'addProject'
    | 'editProject'
    | 'removeProject'
    | 'toggleFavorite'
    | 'resolveMachineConflict'
    | 'beginMigration'
    | 'rollbackMigration';

export interface ManagedRemoteManagementRequest {
    type: 'managed-remote-action';
    version: 1;
    requestId: string;
    operation: ManagedRemoteManagementOperation;
    expectedRevisionId: string | null;
    targetId?: string;
}

export interface ManagedRemoteManagementSettlement {
    type: 'managed-remote-settlement';
    version: 1;
    requestId: string;
    operation: string;
    status: 'applied' | 'cancelled' | 'failed';
    authoritativeRevisionId?: string;
    message?: string;
}

const TARGET_OPERATIONS = new Set<ManagedRemoteManagementOperation>([
    'editMachine',
    'removeMachine',
    'editProject',
    'removeProject',
    'toggleFavorite',
    'resolveMachineConflict',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBoundedIdentity(value: unknown, minimumLength = 1): value is string {
    return typeof value === 'string'
        && value.length >= minimumLength
        && value.length <= 256
        && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRevisionId(value: unknown): value is string | null {
    return value === null || typeof value === 'string'
        && /^revision:[a-f0-9]{64}$/u.test(value);
}

export function readManagedRemoteManagementCorrelation(
    value: unknown,
): { requestId: string; operation: string } | null {
    if (!isRecord(value)
        || value.type !== 'managed-remote-action'
        || value.version !== MANAGED_REMOTE_MANAGEMENT_PROTOCOL_VERSION
        || !isBoundedIdentity(value.requestId, 16)
        || !isBoundedIdentity(value.operation)) {
        return null;
    }
    return { requestId: value.requestId, operation: value.operation };
}

export function parseManagedRemoteManagementRequest(
    value: unknown,
): ManagedRemoteManagementRequest | null {
    const correlation = readManagedRemoteManagementCorrelation(value);
    if (!correlation || !isRecord(value)) { return null; }
    const operation = correlation.operation as ManagedRemoteManagementOperation;
    if (![
        'addMachine',
        'editMachine',
        'removeMachine',
        'addProject',
        'editProject',
        'removeProject',
        'toggleFavorite',
        'resolveMachineConflict',
        'beginMigration',
        'rollbackMigration',
    ].includes(operation) || !isRevisionId(value.expectedRevisionId)) {
        return null;
    }
    const requiredKeys = [
        'type', 'version', 'requestId', 'operation', 'expectedRevisionId',
    ];
    const acceptsTarget = TARGET_OPERATIONS.has(operation) || operation === 'addProject';
    const allowedKeys = acceptsTarget
        ? [...requiredKeys, 'targetId'] : requiredKeys;
    if (Object.keys(value).some(key => !allowedKeys.includes(key))) { return null; }
    if (TARGET_OPERATIONS.has(operation) && !isBoundedIdentity(value.targetId)) {
        return null;
    }
    if (!acceptsTarget && value.targetId !== undefined) {
        return null;
    }
    if (operation === 'addProject'
        && value.targetId !== undefined
        && !isBoundedIdentity(value.targetId)) {
        return null;
    }
    return value as unknown as ManagedRemoteManagementRequest;
}

export function createManagedRemoteManagementSettlement(input: {
    requestId: string;
    operation: string;
    status: ManagedRemoteManagementSettlement['status'];
    authoritativeRevisionId?: string;
    message?: string;
}): ManagedRemoteManagementSettlement {
    return {
        type: 'managed-remote-settlement',
        version: MANAGED_REMOTE_MANAGEMENT_PROTOCOL_VERSION,
        requestId: input.requestId,
        operation: input.operation,
        status: input.status,
        ...(input.authoritativeRevisionId
            ? { authoritativeRevisionId: input.authoritativeRevisionId } : {}),
        ...(input.message ? { message: input.message } : {}),
    };
}
