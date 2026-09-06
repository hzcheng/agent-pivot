'use strict';

export const MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION = 1;
export const MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND = '_agentPivotManagedRemote.bridge.handshake';
export const MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND = '_agentPivotManagedRemote.bridge.execute';

export const MANAGED_REMOTE_BRIDGE_CAPABILITIES = [
    'managedSshConfigV1',
    'automaticSshProjectionV1',
    'openSshValidationV1',
    'localSshTerminalV1',
    'managedNavigationV1',
    'managedActionProjectionV2',
    'localSshEndpointV1',
    'fileTransferLocalBrowseV1',
    'fileTransferRemoteBrowseV1',
    'fileTransferCopyV1',
    'fileTransferCancelV1',
] as const;

export type ManagedRemoteBridgeOperation =
    | 'getStatus'
    | 'reconcile'
    | 'recover'
    | 'openLocalSshTerminal'
    | 'copyLocalSshCommand'
    | 'openManagedMachine'
    | 'openManagedProject'
    | 'openManagedEnvironment'
    | 'inspectLegacySshTarget'
    | 'selectFileTransferLocalRoot'
    | 'listFileTransferLocalDirectory'
    | 'listFileTransferRemoteDirectory'
    | 'copyFileTransferEntries'
    | 'cancelFileTransferCopy';

export interface FileTransferLocalRootRequest {
    kind: 'localRoot';
    rootId: string;
    directoryId?: string;
}

export interface FileTransferRemoteDirectoryRequest {
    kind: 'managedMachine';
    directoryId?: string;
}

export type FileTransferEndpointReference =
    | { kind: 'local'; rootId: string; directoryId: string }
    | { kind: 'managedMachine'; machineId: string; directoryId: string };

export interface FileTransferCopyRequest {
    kind: 'copy';
    taskId: string;
    source: FileTransferEndpointReference;
    destination: FileTransferEndpointReference;
    entryIds: string[];
    conflictPolicy: 'fail' | 'skip' | 'replace';
}

export interface FileTransferCopyResult {
    status: 'copied' | 'cancelled';
    completedItems: number;
    skippedItems: number;
    totalItems: number;
}

export interface FileTransferCancelRequest {
    kind: 'cancel';
    taskId: string;
}

export interface FileTransferLocalRootResponse {
    rootId: string;
    directoryId: string;
    label: string;
    /** A bounded display-only path relative to the approved endpoint root. */
    displayPath: string;
    entries: FileTransferDirectoryEntry[];
}

export interface FileTransferDirectoryEntry {
    id: string;
    name: string;
    kind: 'directory' | 'file' | 'symlink' | 'unsupported';
    size?: number;
    modifiedAt?: number;
}

export interface ManagedRemoteBridgeHandshakeRequest {
    protocolVersion: 1;
    requestId: string;
    challenge: string;
}

export interface ManagedRemoteBridgeHandshakeResponse {
    protocolVersion: 1;
    requestId: string;
    challenge: string;
    sessionToken: string;
    capabilities: typeof MANAGED_REMOTE_BRIDGE_CAPABILITIES;
}

export interface ManagedRemoteBridgeRequest {
    protocolVersion: 1;
    requestId: string;
    sessionToken: string;
    operation: ManagedRemoteBridgeOperation;
    expectedRevisionId?: string;
    targetId?: string;
    /** An SSH host alias to resolve against this computer's own SSH config. */
    legacySshTarget?: string;
    fileTransfer?: FileTransferLocalRootRequest
        | FileTransferRemoteDirectoryRequest
        | FileTransferCopyRequest
        | FileTransferCancelRequest;
}

export type ManagedRemoteBridgeResponse =
    | {
        protocolVersion: 1;
        requestId: string;
        status: 'ok';
        value: unknown;
    }
    | {
        protocolVersion: 1;
        requestId: string;
        status: 'catalogOutOfDate' | 'recoveryRequired' | 'failed';
        message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const keys = Object.keys(value);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function isCorrelationValue(value: unknown): value is string {
    return typeof value === 'string'
        && value.length >= 16
        && value.length <= 256
        && /^[A-Za-z0-9._:-]+$/u.test(value);
}

export function parseManagedRemoteBridgeHandshakeRequest(
    value: unknown,
): ManagedRemoteBridgeHandshakeRequest | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['protocolVersion', 'requestId', 'challenge'])
        || value.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
        || !isCorrelationValue(value.requestId)
        || !isCorrelationValue(value.challenge)) {
        return null;
    }
    return value as unknown as ManagedRemoteBridgeHandshakeRequest;
}

export function parseManagedRemoteBridgeRequest(value: unknown): ManagedRemoteBridgeRequest | null {
    if (!isRecord(value)
        || !hasExactKeys(
            value,
            ['protocolVersion', 'requestId', 'sessionToken', 'operation'],
            ['expectedRevisionId', 'targetId', 'legacySshTarget', 'fileTransfer'],
        )
        || value.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
        || !isCorrelationValue(value.requestId)
        || !isCorrelationValue(value.sessionToken)
        || ![
            'getStatus',
            'reconcile',
            'recover',
            'openLocalSshTerminal',
            'copyLocalSshCommand',
            'openManagedMachine',
            'openManagedProject',
            'openManagedEnvironment',
            'inspectLegacySshTarget',
            'selectFileTransferLocalRoot',
            'listFileTransferLocalDirectory',
            'listFileTransferRemoteDirectory',
            'copyFileTransferEntries',
            'cancelFileTransferCopy',
        ].includes(value.operation as string)
        || (value.expectedRevisionId !== undefined
            && (typeof value.expectedRevisionId !== 'string'
                || !/^revision:[a-f0-9]{64}$/u.test(value.expectedRevisionId)))) {
        return null;
    }
    const requiresRevision = [
        'reconcile',
        'openLocalSshTerminal', 'copyLocalSshCommand',
        'openManagedMachine', 'openManagedProject', 'openManagedEnvironment',
        'listFileTransferRemoteDirectory',
        'copyFileTransferEntries',
    ].includes(value.operation as string);
    if (requiresRevision && typeof value.expectedRevisionId !== 'string') {
        return null;
    }
    if (!requiresRevision
        && value.operation !== 'recover'
        && value.expectedRevisionId !== undefined) {
        return null;
    }
    const requiresTarget = value.operation === 'openLocalSshTerminal'
        || value.operation === 'copyLocalSshCommand'
        || value.operation === 'openManagedMachine'
        || value.operation === 'openManagedProject'
        || value.operation === 'openManagedEnvironment';
    const remoteBrowse = value.operation === 'listFileTransferRemoteDirectory';
    const requiresTargetForOperation = requiresTarget || remoteBrowse;
    const validTarget = typeof value.targetId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.targetId);
    if ((requiresTargetForOperation && !validTarget)
        || (!requiresTargetForOperation && value.targetId !== undefined)) {
        return null;
    }
    const requiresLegacyTarget = value.operation === 'inspectLegacySshTarget';
    const validLegacyTarget = typeof value.legacySshTarget === 'string'
        && value.legacySshTarget.length <= 256
        && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.legacySshTarget);
    if ((requiresLegacyTarget && !validLegacyTarget)
        || (!requiresLegacyTarget && value.legacySshTarget !== undefined)) {
        return null;
    }
    const requiresFileTransfer = value.operation === 'listFileTransferLocalDirectory'
        || value.operation === 'listFileTransferRemoteDirectory'
        || value.operation === 'copyFileTransferEntries'
        || value.operation === 'cancelFileTransferCopy';
    if (value.operation === 'selectFileTransferLocalRoot') {
        if (value.fileTransfer !== undefined) { return null; }
    } else if (requiresFileTransfer) {
        const valid = value.operation === 'listFileTransferLocalDirectory'
            ? validFileTransferLocalRootRequest(value.fileTransfer)
            : value.operation === 'listFileTransferRemoteDirectory'
                ? validFileTransferRemoteDirectoryRequest(value.fileTransfer)
                : value.operation === 'copyFileTransferEntries'
                    ? validFileTransferCopyRequest(value.fileTransfer)
                    : validFileTransferCancelRequest(value.fileTransfer);
        if (!valid) { return null; }
    } else if (value.fileTransfer !== undefined) {
        return null;
    }
    return value as unknown as ManagedRemoteBridgeRequest;
}

function validFileTransferCopyRequest(value: unknown): value is FileTransferCopyRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'taskId', 'source', 'destination', 'entryIds', 'conflictPolicy'])
        && value.kind === 'copy'
        && isCorrelationValue(value.taskId)
        && ['fail', 'skip', 'replace'].includes(value.conflictPolicy as string)
        && validFileTransferEndpointReference(value.source)
        && validFileTransferEndpointReference(value.destination)
        && Array.isArray(value.entryIds)
        && value.entryIds.length > 0
        && value.entryIds.length <= 100
        && value.entryIds.every(validFileTransferHandle)
        && new Set(value.entryIds).size === value.entryIds.length;
}

function validFileTransferCancelRequest(value: unknown): value is FileTransferCancelRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'taskId'])
        && value.kind === 'cancel'
        && isCorrelationValue(value.taskId);
}

function validFileTransferEndpointReference(value: unknown): value is FileTransferEndpointReference {
    if (!isRecord(value) || typeof value.kind !== 'string') { return false; }
    if (value.kind === 'local') {
        return hasExactKeys(value, ['kind', 'rootId', 'directoryId'])
            && validFileTransferHandle(value.rootId)
            && validFileTransferHandle(value.directoryId);
    }
    return value.kind === 'managedMachine'
        && hasExactKeys(value, ['kind', 'machineId', 'directoryId'])
        && typeof value.machineId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.machineId)
        && validFileTransferHandle(value.directoryId);
}

function validFileTransferRemoteDirectoryRequest(
    value: unknown,
): value is FileTransferRemoteDirectoryRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind'], ['directoryId'])
        && value.kind === 'managedMachine'
        && (value.directoryId === undefined || validFileTransferHandle(value.directoryId));
}

function validFileTransferLocalRootRequest(value: unknown): value is FileTransferLocalRootRequest {
    if (!isRecord(value)
        || !hasExactKeys(value, ['kind', 'rootId'], ['directoryId'])
        || value.kind !== 'localRoot'
        || !validFileTransferHandle(value.rootId)
        || (value.directoryId !== undefined && !validFileTransferHandle(value.directoryId))) {
        return false;
    }
    return true;
}

function validFileTransferHandle(value: unknown): value is string {
    return typeof value === 'string'
        && /^[a-f0-9]{32}$/u.test(value);
}
