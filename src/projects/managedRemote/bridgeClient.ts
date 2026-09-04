'use strict';

import { randomBytes } from 'crypto';

import {
    MANAGED_REMOTE_BRIDGE_CAPABILITIES,
    MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
    MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
    MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
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

function supportsCapabilities(value: unknown): boolean {
    return Array.isArray(value)
        && MANAGED_REMOTE_BRIDGE_CAPABILITIES.every(capability =>
            value.includes(capability));
}

export class ManagedRemoteBridgeClient {
    private session?: Promise<string>;

    constructor(private readonly commands: ManagedRemoteBridgeCommandExecutor) {
    }

    async execute(
        operation: ManagedRemoteBridgeOperation,
        expectedRevisionId: string,
        targetId?: string,
    ): Promise<unknown> {
        return this.executeAttempt(operation, expectedRevisionId, targetId, true);
    }

    private async executeAttempt(
        operation: ManagedRemoteBridgeOperation,
        expectedRevisionId: string,
        targetId: string | undefined,
        retryExpiredSession: boolean,
    ): Promise<unknown> {
        const requestId = correlation('managed-remote');
        const response = await this.commands.executeCommand<unknown>(
            MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
            {
                protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
                requestId,
                sessionToken: await this.getSession(),
                operation,
                expectedRevisionId,
                ...(targetId ? { targetId } : {}),
            },
        );
        if (!isRecord(response)
            || response.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
            || response.requestId !== requestId
            || !['ok', 'catalogOutOfDate', 'clientNotEnabled', 'recoveryRequired', 'failed']
                .includes(String(response.status))) {
            throw new Error('Agent Pivot UI Bridge returned an invalid Managed Remote response.');
        }
        if (response.status !== 'ok') {
            if (retryExpiredSession
                && response.status === 'failed'
                && typeof response.message === 'string'
                && /session expired/iu.test(response.message)) {
                this.session = undefined;
                return this.executeAttempt(
                    operation, expectedRevisionId, targetId, false,
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
            response = await this.commands.executeCommand<unknown>(
                MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
                {
                    protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
                    requestId,
                    challenge,
                },
            );
        } catch (_error) {
            throw new Error('Install or update the Agent Pivot UI Bridge to use Managed Remote commands.');
        }
        if (!isRecord(response)
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
}
