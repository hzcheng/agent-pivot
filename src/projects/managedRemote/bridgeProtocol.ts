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
    'fileTransferPreflightV1',
    'fileTransferCopyV1',
    'fileTransferCancelV1',
    'fileTransferProgressV1',
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
    | 'preflightFileTransfer'
    | 'copyFileTransferEntries'
    | 'cancelFileTransferCopy'
    | 'getFileTransferCopyStatus';

export interface FileTransferLocalRootRequest {
    kind: 'localRoot';
    rootId: string;
    directoryId?: string;
    /** A display-relative path below the opaque root, never a local absolute path. */
    path?: string;
}

export interface FileTransferRemoteDirectoryRequest {
    kind: 'managedMachine';
    directoryId?: string;
    /** A bounded absolute POSIX path or the remote home-directory shorthand. */
    path?: string;
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
    targetName?: string;
}

/** A non-mutating review of a copy plan, identified only by opaque handles. */
export interface FileTransferPreflightRequest {
    kind: 'preflight';
    source: FileTransferEndpointReference;
    destination: FileTransferEndpointReference;
    entryIds: string[];
    targetName?: string;
}

export interface FileTransferPreflightResult {
    totalItems: number;
    knownBytes: number;
    unknownSizeItems: number;
    existingFileNames: string[];
    existingDirectoryNames: string[];
}

export interface FileTransferCopyResult {
    status: 'copied' | 'cancelled' | 'failed';
    completedItems: number;
    skippedItems: number;
    totalItems: number;
    /** Bounded, redacted reason for a terminal failed copy. */
    message?: string;
}

export interface FileTransferCancelRequest {
    kind: 'cancel';
    taskId: string;
}

/** A read-only, redacted snapshot of a locally running transfer task. */
export interface FileTransferCopyStatusRequest {
    kind: 'status';
    taskId: string;
}

export interface FileTransferCopyStatus {
    status: 'running';
    phase: 'preparing' | 'copying';
    completedItems: number;
    skippedItems: number;
    totalItems: number;
    /** The bounded display name of the entry currently being prepared or copied. */
    currentItemName?: string;
}

export interface FileTransferLocalRootResponse {
    rootId: string;
    directoryId: string;
    label: string;
    /** A bounded display-only path relative to the approved endpoint root. */
    displayPath: string;
    entries: FileTransferDirectoryEntry[];
    /** The current bounded listing omitted additional entries. */
    hasMore?: boolean;
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
        | FileTransferPreflightRequest
        | FileTransferCopyRequest
        | FileTransferCancelRequest
        | FileTransferCopyStatusRequest;
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
            'preflightFileTransfer',
            'copyFileTransferEntries',
            'cancelFileTransferCopy',
            'getFileTransferCopyStatus',
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
        'preflightFileTransfer',
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
        || value.operation === 'preflightFileTransfer'
        || value.operation === 'copyFileTransferEntries'
        || value.operation === 'cancelFileTransferCopy'
        || value.operation === 'getFileTransferCopyStatus';
    if (value.operation === 'selectFileTransferLocalRoot') {
        if (value.fileTransfer !== undefined) { return null; }
    } else if (requiresFileTransfer) {
        const valid = value.operation === 'listFileTransferLocalDirectory'
            ? validFileTransferLocalRootRequest(value.fileTransfer)
            : value.operation === 'listFileTransferRemoteDirectory'
                ? validFileTransferRemoteDirectoryRequest(value.fileTransfer)
                : value.operation === 'preflightFileTransfer'
                    ? validFileTransferPreflightRequest(value.fileTransfer)
                : value.operation === 'copyFileTransferEntries'
                    ? validFileTransferCopyRequest(value.fileTransfer)
                    : value.operation === 'cancelFileTransferCopy'
                        ? validFileTransferCancelRequest(value.fileTransfer)
                        : validFileTransferCopyStatusRequest(value.fileTransfer);
        if (!valid) { return null; }
    } else if (value.fileTransfer !== undefined) {
        return null;
    }
    return value as unknown as ManagedRemoteBridgeRequest;
}

function validFileTransferPreflightRequest(value: unknown): value is FileTransferPreflightRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'source', 'destination', 'entryIds'], ['targetName'])
        && value.kind === 'preflight'
        && validFileTransferEndpointReference(value.source)
        && validFileTransferEndpointReference(value.destination)
        && Array.isArray(value.entryIds)
        && value.entryIds.length > 0
        && value.entryIds.length <= 100
        && value.entryIds.every(validFileTransferHandle)
        && new Set(value.entryIds).size === value.entryIds.length
        && validFileTransferTargetName(value.targetName);
}

function validFileTransferCopyRequest(value: unknown): value is FileTransferCopyRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'taskId', 'source', 'destination', 'entryIds', 'conflictPolicy'], ['targetName'])
        && value.kind === 'copy'
        && isCorrelationValue(value.taskId)
        && ['fail', 'skip', 'replace'].includes(value.conflictPolicy as string)
        && validFileTransferEndpointReference(value.source)
        && validFileTransferEndpointReference(value.destination)
        && Array.isArray(value.entryIds)
        && value.entryIds.length > 0
        && value.entryIds.length <= 100
        && value.entryIds.every(validFileTransferHandle)
        && new Set(value.entryIds).size === value.entryIds.length
        && validFileTransferTargetName(value.targetName);
}

function validFileTransferTargetName(value: unknown): boolean {
    return value === undefined || (typeof value === 'string'
        && value.length > 0 && value.length <= 255
        && value !== '.' && value !== '..'
        && !/[\\/\0\r\n]/u.test(value));
}

function validFileTransferCancelRequest(value: unknown): value is FileTransferCancelRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'taskId'])
        && value.kind === 'cancel'
        && isCorrelationValue(value.taskId);
}

function validFileTransferCopyStatusRequest(value: unknown): value is FileTransferCopyStatusRequest {
    return isRecord(value)
        && hasExactKeys(value, ['kind', 'taskId'])
        && value.kind === 'status'
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
        && hasExactKeys(value, ['kind'], ['directoryId', 'path'])
        && value.kind === 'managedMachine'
        && (value.directoryId === undefined || validFileTransferHandle(value.directoryId))
        && (value.path === undefined || validFileTransferRemoteNavigationPath(value.path))
        && !(value.directoryId !== undefined && value.path !== undefined);
}

function validFileTransferLocalRootRequest(value: unknown): value is FileTransferLocalRootRequest {
    if (!isRecord(value)
        || !hasExactKeys(value, ['kind', 'rootId'], ['directoryId', 'path'])
        || value.kind !== 'localRoot'
        || !validFileTransferHandle(value.rootId)
        || (value.directoryId !== undefined && !validFileTransferHandle(value.directoryId))
        || (value.path !== undefined && !validFileTransferLocalNavigationPath(value.path))
        || (value.directoryId !== undefined && value.path !== undefined)) {
        return false;
    }
    return true;
}

function validFileTransferLocalNavigationPath(value: unknown): boolean {
    return typeof value === 'string'
        && value.length > 0 && value.length <= 1024
        && !/[\\\0\r\n]/u.test(value)
        && (value === '.' || (!value.startsWith('/') && value.split('/').every(segment =>
            segment.length > 0 && segment !== '.' && segment !== '..')));
}

function validFileTransferRemoteNavigationPath(value: unknown): boolean {
    return typeof value === 'string'
        && value.length > 0 && value.length <= 1024
        && !/[\0\r\n]/u.test(value)
        && (value === '.' || value === '/' || (value.startsWith('/') && value.split('/').every((segment, index) =>
            index === 0 || (segment.length > 0 && segment !== '.' && segment !== '..'))));
}

function validFileTransferHandle(value: unknown): value is string {
    return typeof value === 'string'
        && /^[a-f0-9]{32}$/u.test(value);
}
