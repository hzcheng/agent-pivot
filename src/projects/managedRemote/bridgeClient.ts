'use strict';

import { randomBytes } from 'crypto';

import {
    MANAGED_REMOTE_BRIDGE_CAPABILITIES,
    MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
    MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
    MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
    FileTransferLocalRootResponse,
    FileTransferCopyRequest,
    ManagedRemoteBridgeOperation,
    ManagedRemoteBridgeResponse,
} from './bridgeProtocol';

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
    ): Promise<FileTransferLocalRootResponse> {
        return this.executeAttempt(
            'listFileTransferLocalDirectory', undefined, undefined, undefined,
            { kind: 'localRoot', rootId, ...(directoryId ? { directoryId } : {}) }, true,
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
    ): Promise<FileTransferLocalRootResponse> {
        return this.executeAttempt(
            'listFileTransferRemoteDirectory', expectedRevisionId, machineId, undefined,
            { kind: 'managedMachine', ...(directoryId ? { directoryId } : {}) }, true,
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
    ): Promise<unknown> {
        return this.executeAttempt(
            'copyFileTransferEntries', expectedRevisionId, undefined, undefined, request, true,
        );
    }

    cancelFileTransferCopy(taskId: string): Promise<unknown> {
        return this.executeAttempt(
            'cancelFileTransferCopy', undefined, undefined, undefined,
            { kind: 'cancel', taskId }, true,
        );
    }

    private async executeAttempt(
        operation: ManagedRemoteBridgeOperation,
        expectedRevisionId: string | undefined,
        targetId: string | undefined,
        legacySshTarget: string | undefined,
        fileTransfer: (
            | { kind: 'localRoot'; rootId: string; directoryId?: string }
            | { kind: 'managedMachine'; directoryId?: string }
            | FileTransferCopyRequest
            | { kind: 'cancel'; taskId: string }
        ) | undefined,
        retryExpiredSession: boolean,
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
        ));
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
                    operation, expectedRevisionId, targetId, legacySshTarget, fileTransfer, false,
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

    private withDeadline<T>(operation: Thenable<T | undefined>): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
                'Agent Pivot UI Bridge timed out. Try the action again.',
            )), this.timeoutMs);
            Promise.resolve(operation).then(
                value => { clearTimeout(timer); resolve(value); },
                error => { clearTimeout(timer); reject(error); },
            );
        });
    }
}

function parseFileTransferLocalRootResponse(value: unknown): FileTransferLocalRootResponse | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['rootId', 'directoryId', 'label', 'displayPath', 'entries'])
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
