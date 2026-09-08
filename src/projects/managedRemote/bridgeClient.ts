'use strict';

import { randomBytes } from 'crypto';

import {
    MANAGED_REMOTE_BRIDGE_CAPABILITIES,
    MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
    MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
    MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
    FileTransferLocalRootResponse,
    FileTransferPreflightRequest,
    FileTransferPreflightResult,
    FileTransferCopyRequest,
    FileTransferCopyResult,
    FileTransferCopyStatus,
    ManagedRemoteBridgeOperation,
    ManagedRemoteBridgeResponse,
} from './bridgeProtocol';

// A relay copy can legitimately take hours. The ordinary Bridge deadline only
// protects short control-plane requests such as browse, preflight, and cancel.
const FILE_TRANSFER_COPY_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export interface ManagedRemoteBridgeCommandExecutor {
    executeCommand<T>(command: string, ...args: unknown[]): Thenable<T | undefined>;
}

export class ManagedRemoteBridgeClientError extends Error {
    constructor(
        public readonly status: Exclude<ManagedRemoteBridgeResponse['status'], 'ok'>,
        message: string,
    ) {
        super(message);
    }
}

function correlation(prefix: string): string {
    return `${prefix}-${randomBytes(16).toString('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = keys.slice().sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function supportsCapabilities(value: unknown): boolean {
    return Array.isArray(value)
        && MANAGED_REMOTE_BRIDGE_CAPABILITIES.every(capability =>
            value.includes(capability));
}

export class ManagedRemoteBridgeClient {
    private session?: Promise<string>;

    constructor(
        private readonly commands: ManagedRemoteBridgeCommandExecutor,
        private readonly timeoutMs = 15_000,
    ) {
    }

    async execute(
        operation: ManagedRemoteBridgeOperation,
        expectedRevisionId?: string,
        targetId?: string,
    ): Promise<unknown> {
        return this.executeAttempt(
            operation, expectedRevisionId, targetId, undefined, undefined, true,
        );
    }

    /**
     * Resolve an SSH host alias against this computer's own SSH config.
     *
     * Only the local extension host can read the user's `~/.ssh/config`, so the
     * endpoint behind an alias they already use is otherwise unknowable.
     */
    inspectLegacySshTarget(target: string): Promise<unknown> {
        return this.executeAttempt(
            'inspectLegacySshTarget', undefined, undefined, target, undefined, true,
        );
    }

    selectFileTransferLocalRoot(): Promise<FileTransferLocalRootResponse | null> {
        return this.executeAttempt(
            'selectFileTransferLocalRoot', undefined, undefined, undefined, undefined, true,
        ).then(value => parseFileTransferLocalRootResponse(value));
    }

    listFileTransferLocalDirectory(
        rootId: string,
        directoryId?: string,
        navigationPath?: string,
    ): Promise<FileTransferLocalRootResponse> {
        return this.executeAttempt(
            'listFileTransferLocalDirectory', undefined, undefined, undefined,
            {
                kind: 'localRoot', rootId,
                ...(directoryId ? { directoryId } : {}),
                ...(navigationPath ? { path: navigationPath } : {}),
            }, true,
        ).then(value => {
            const parsed = parseFileTransferLocalRootResponse(value);
            if (!parsed) {
                throw new Error('Agent Pivot UI Bridge returned an invalid File Transfer directory.');
            }
            return parsed;
        });
    }

    listFileTransferRemoteDirectory(
        expectedRevisionId: string,
        machineId: string,
        directoryId?: string,
        navigationPath?: string,
    ): Promise<FileTransferLocalRootResponse> {
        return this.executeAttempt(
            'listFileTransferRemoteDirectory', expectedRevisionId, machineId, undefined,
            {
                kind: 'managedMachine',
                ...(directoryId ? { directoryId } : {}),
                ...(navigationPath ? { path: navigationPath } : {}),
            }, true,
        ).then(value => {
            const parsed = parseFileTransferLocalRootResponse(value);
            if (!parsed) {
                throw new Error('Agent Pivot UI Bridge returned an invalid File Transfer directory.');
            }
            return parsed;
        });
    }

    copyFileTransferEntries(
        expectedRevisionId: string,
        request: FileTransferCopyRequest,
    ): Promise<FileTransferCopyResult> {
        return this.executeAttempt(
            'copyFileTransferEntries', expectedRevisionId, undefined, undefined, request, true,
            FILE_TRANSFER_COPY_TIMEOUT_MS,
        ).then(value => {
            const parsed = parseFileTransferCopyResult(value);
            if (!parsed) {
                throw new Error('Agent Pivot UI Bridge returned an invalid File Transfer result.');
            }
            return parsed;
        });
    }

    preflightFileTransfer(
        expectedRevisionId: string,
        request: FileTransferPreflightRequest,
    ): Promise<FileTransferPreflightResult> {
        return this.executeAttempt(
            'preflightFileTransfer', expectedRevisionId, undefined, undefined, request, true,
        ).then(value => {
            const parsed = parseFileTransferPreflightResult(value);
            if (!parsed) {
                throw new Error('Agent Pivot UI Bridge returned an invalid File Transfer review.');
            }
            return parsed;
        });
    }

    cancelFileTransferCopy(taskId: string): Promise<unknown> {
        return this.executeAttempt(
            'cancelFileTransferCopy', undefined, undefined, undefined,
            { kind: 'cancel', taskId }, true,
        );
    }

    getFileTransferCopyStatus(taskId: string): Promise<FileTransferCopyStatus | { status: 'unknown' }> {
        return this.executeAttempt(
            'getFileTransferCopyStatus', undefined, undefined, undefined,
            { kind: 'status', taskId }, true,
        ).then(value => {
            const parsed = parseFileTransferCopyStatus(value);
            if (!parsed) {
                throw new Error('Agent Pivot UI Bridge returned an invalid File Transfer task status.');
            }
            return parsed;
        });
    }

    private async executeAttempt(
        operation: ManagedRemoteBridgeOperation,
        expectedRevisionId: string | undefined,
        targetId: string | undefined,
        legacySshTarget: string | undefined,
        fileTransfer: (
            | { kind: 'localRoot'; rootId: string; directoryId?: string; path?: string }
            | { kind: 'managedMachine'; directoryId?: string; path?: string }
            | FileTransferPreflightRequest
            | FileTransferCopyRequest
            | { kind: 'cancel'; taskId: string }
            | { kind: 'status'; taskId: string }
        ) | undefined,
        retryExpiredSession: boolean,
        deadlineMs = this.timeoutMs,
    ): Promise<unknown> {
        const requestId = correlation('managed-remote');
        const response = await this.withDeadline(this.commands.executeCommand<unknown>(
            MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
            {
                protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
                requestId,
                sessionToken: await this.getSession(),
                operation,
                ...(expectedRevisionId ? { expectedRevisionId } : {}),
                ...(targetId ? { targetId } : {}),
                ...(legacySshTarget ? { legacySshTarget } : {}),
                ...(fileTransfer ? { fileTransfer } : {}),
            },
        ), deadlineMs);
        if (!isRecord(response)
            || response.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
            || response.requestId !== requestId
            || !['ok', 'catalogOutOfDate', 'recoveryRequired', 'failed']
                .includes(String(response.status))) {
            throw new Error('Agent Pivot UI Bridge returned an invalid Managed Remote response.');
        }
        const responseKeys = response.status === 'ok'
            ? ['protocolVersion', 'requestId', 'status', 'value']
            : ['protocolVersion', 'requestId', 'status', 'message'];
        if (!hasExactKeys(response, responseKeys)
            || (response.status !== 'ok' && typeof response.message !== 'string')) {
            throw new Error('Agent Pivot UI Bridge returned an invalid Managed Remote response.');
        }
        if (response.status !== 'ok') {
            if (retryExpiredSession
                && response.status === 'failed'
                && typeof response.message === 'string'
                && /session expired/iu.test(response.message)) {
                this.session = undefined;
                return this.executeAttempt(
                    operation, expectedRevisionId, targetId, legacySshTarget, fileTransfer, false, deadlineMs,
                );
            }
            throw new ManagedRemoteBridgeClientError(
                response.status as Exclude<ManagedRemoteBridgeResponse['status'], 'ok'>,
                typeof response.message === 'string'
                    ? response.message : 'Managed Remote action failed.',
            );
        }
        return response.value;
    }

    private getSession(): Promise<string> {
        if (!this.session) {
            this.session = this.handshake().catch(error => {
                this.session = undefined;
                throw error;
            });
        }
        return this.session;
    }

    private async handshake(): Promise<string> {
        const requestId = correlation('managed-handshake');
        const challenge = correlation('managed-challenge');
        let response: unknown;
        try {
            response = await this.withDeadline(this.commands.executeCommand<unknown>(
                MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
                {
                    protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
                    requestId,
                    challenge,
                },
            ));
        } catch (_error) {
            throw new Error('Install or update the Agent Pivot UI Bridge to use Managed Remote commands.');
        }
        if (!isRecord(response)
            || !hasExactKeys(response, [
                'protocolVersion', 'requestId', 'challenge', 'sessionToken', 'capabilities',
            ])
            || response.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
            || response.requestId !== requestId
            || response.challenge !== challenge
            || typeof response.sessionToken !== 'string'
            || response.sessionToken.length < 16
            || !supportsCapabilities(response.capabilities)) {
            throw new Error('Update the Agent Pivot UI Bridge to use Managed Remote commands.');
        }
        return response.sessionToken;
    }

    private withDeadline<T>(
        operation: Thenable<T | undefined>,
        timeoutMs = this.timeoutMs,
    ): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
                'Agent Pivot UI Bridge timed out. Try the action again.',
            )), timeoutMs);
            Promise.resolve(operation).then(
                value => { clearTimeout(timer); resolve(value); },
                error => { clearTimeout(timer); reject(error); },
            );
        });
    }
}

function parseFileTransferPreflightResult(value: unknown): FileTransferPreflightResult | null {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'totalItems', 'knownBytes', 'unknownSizeItems', 'existingFileNames', 'existingDirectoryNames',
        ])
        || !Number.isSafeInteger(value.totalItems)
        || value.totalItems < 1
        || value.totalItems > 100
        || !Number.isSafeInteger(value.knownBytes)
        || value.knownBytes < 0
        || !Number.isSafeInteger(value.unknownSizeItems)
        || value.unknownSizeItems < 0
        || value.unknownSizeItems > value.totalItems
        || !validFileTransferNames(value.existingFileNames)
        || !validFileTransferNames(value.existingDirectoryNames)) {
        return null;
    }
    return value as unknown as FileTransferPreflightResult;
}

function validFileTransferNames(value: unknown): value is string[] {
    return Array.isArray(value)
        && value.length <= 100
        && value.every(name => typeof name === 'string'
            && name.length > 0
            && name.length <= 255
            && !/[\0\r\n]/u.test(name))
        && new Set(value).size === value.length;
}

function parseFileTransferCopyResult(value: unknown): FileTransferCopyResult | null {
    if (!isRecord(value)) { return null; }
    const failed = value.status === 'failed';
    const expectedKeys = [
        'status', 'completedItems', 'skippedItems', 'totalItems',
    ].concat(failed ? ['message'] : []).concat(value.diagnostic === undefined ? [] : ['diagnostic']);
    if (!hasExactKeys(value, expectedKeys)
        || (value.status !== 'copied' && value.status !== 'cancelled' && !failed)
        || typeof value.completedItems !== 'number' || !Number.isSafeInteger(value.completedItems)
        || value.completedItems < 0
        || typeof value.skippedItems !== 'number' || !Number.isSafeInteger(value.skippedItems)
        || value.skippedItems < 0
        || typeof value.totalItems !== 'number' || !Number.isSafeInteger(value.totalItems)
        || value.totalItems < 1
        || value.completedItems + value.skippedItems > value.totalItems
        || (failed && (typeof value.message !== 'string' || value.message.length < 1
            || value.message.length > 320 || /[\0\r\n]/u.test(value.message)))
        || (value.diagnostic !== undefined && !validFileTransferCopyFailureDiagnostic(value.diagnostic))) {
        return null;
    }
    return value as unknown as FileTransferCopyResult;
}

function parseFileTransferCopyStatus(value: unknown): FileTransferCopyStatus | { status: 'unknown' } | null {
    if (!isRecord(value)) { return null; }
    if (value.status === 'unknown') {
        return hasExactKeys(value, ['status']) ? { status: 'unknown' } : null;
    }
    const completedItems = value.completedItems;
    const skippedItems = value.skippedItems;
    const totalItems = value.totalItems;
    const expectedKeys = [
        'status', 'phase', 'completedItems', 'skippedItems', 'totalItems',
    ].concat(value.currentItemName === undefined ? [] : ['currentItemName'])
        .concat(value.hop === undefined ? [] : ['hop'])
        .concat(value.transferredBytes === undefined ? [] : ['transferredBytes'])
        .concat(value.totalBytes === undefined ? [] : ['totalBytes'])
        .concat(value.bytesPerSecond === undefined ? [] : ['bytesPerSecond'])
        .concat(value.activity === undefined ? [] : ['activity'])
        .concat(value.lastActivityAt === undefined ? [] : ['lastActivityAt']);
    if (!hasExactKeys(value, expectedKeys)
        || value.status !== 'running'
        || (value.phase !== 'preparing' && value.phase !== 'downloading'
            && value.phase !== 'uploading' && value.phase !== 'verifying')
        || typeof completedItems !== 'number' || !Number.isSafeInteger(completedItems) || completedItems < 0
        || typeof skippedItems !== 'number' || !Number.isSafeInteger(skippedItems) || skippedItems < 0
        || typeof totalItems !== 'number' || !Number.isSafeInteger(totalItems) || totalItems < 1
        || completedItems + skippedItems > totalItems
        || (value.currentItemName !== undefined
            && (typeof value.currentItemName !== 'string'
                || value.currentItemName.length < 1 || value.currentItemName.length > 255
                || /[\0\r\n]/u.test(value.currentItemName)))
        || (value.hop !== undefined && value.hop !== 'source-to-relay'
            && value.hop !== 'relay-to-target' && value.hop !== 'source-to-target')
        || ((value.transferredBytes === undefined) !== (value.totalBytes === undefined))
        || (value.transferredBytes !== undefined
            && (!Number.isSafeInteger(value.transferredBytes) || value.transferredBytes < 0
                || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
                || value.transferredBytes > value.totalBytes))
        || (value.bytesPerSecond !== undefined
            && (!Number.isSafeInteger(value.bytesPerSecond) || value.bytesPerSecond < 0))
        || (value.activity !== undefined && value.activity !== 'preparing' && value.activity !== 'scp-started'
            && value.activity !== 'scp-running' && value.activity !== 'scp-exited' && value.activity !== 'verifying')
        || (value.lastActivityAt !== undefined
            && (!Number.isSafeInteger(value.lastActivityAt) || value.lastActivityAt < 0))) {
        return null;
    }
    return value as unknown as FileTransferCopyStatus;
}

function validFileTransferCopyFailureDiagnostic(value: unknown): boolean {
    if (!isRecord(value) || !hasExactKeys(value, ['phase', 'hop', 'code'])) { return false; }
    return (value.phase === 'preparing' || value.phase === 'downloading'
        || value.phase === 'uploading' || value.phase === 'verifying')
        && (value.hop === 'source-to-relay' || value.hop === 'relay-to-target'
            || value.hop === 'source-to-target')
        && (value.code === 'space' || value.code === 'network' || value.code === 'permission'
            || value.code === 'verification' || value.code === 'cancelled' || value.code === 'unknown');
}

function parseFileTransferLocalRootResponse(value: unknown): FileTransferLocalRootResponse | null {
    if (!isRecord(value)
        || !hasExactKeys(value, value.hasMore === undefined
            ? ['rootId', 'directoryId', 'label', 'displayPath', 'entries']
            : ['rootId', 'directoryId', 'label', 'displayPath', 'entries', 'hasMore'])
        || !validFileTransferHandle(value.rootId)
        || !validFileTransferHandle(value.directoryId)
        || typeof value.label !== 'string'
        || value.label.length < 1
        || value.label.length > 255
        || typeof value.displayPath !== 'string'
        || value.displayPath.length < 1
        || value.displayPath.length > 1_024
        || /[\0\r\n]/u.test(value.displayPath)
        || !Array.isArray(value.entries)
        || value.entries.length > 1_000
        || (value.hasMore !== undefined && typeof value.hasMore !== 'boolean')
        || !value.entries.every(validFileTransferDirectoryEntry)) {
        return null;
    }
    return value as unknown as FileTransferLocalRootResponse;
}

function validFileTransferDirectoryEntry(value: unknown): boolean {
    if (!isRecord(value)
        || !hasAllowedFileTransferEntryKeys(value)
        || !validFileTransferHandle(value.id)
        || typeof value.name !== 'string'
        || value.name.length < 1
        || value.name.length > 255
        || !['directory', 'file', 'symlink', 'unsupported'].includes(String(value.kind))
        || (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0))
        || (value.modifiedAt !== undefined
            && (!Number.isSafeInteger(value.modifiedAt) || value.modifiedAt < 0))) {
        return false;
    }
    return true;
}

function hasAllowedFileTransferEntryKeys(value: Record<string, unknown>): boolean {
    const required = ['id', 'name', 'kind'];
    const allowed = required.concat(['size', 'modifiedAt']);
    const keys = Object.keys(value);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => allowed.includes(key));
}

function validFileTransferHandle(value: unknown): boolean {
    return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}
