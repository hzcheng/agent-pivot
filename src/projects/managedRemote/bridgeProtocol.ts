'use strict';

export const MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION = 1;
export const MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND = '_agentPivotManagedRemote.bridge.handshake';
export const MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND = '_agentPivotManagedRemote.bridge.execute';

export const MANAGED_REMOTE_BRIDGE_CAPABILITIES = [
    'managedSshConfigV1',
    'manualIncludeConsentV1',
    'openSshValidationV1',
] as const;

export type ManagedRemoteBridgeOperation =
    | 'getStatus'
    | 'preflightEnable'
    | 'beginEnable'
    | 'confirmEnable'
    | 'reconcile'
    | 'preflightDisable'
    | 'beginDisable'
    | 'confirmDisable'
    | 'cancelTransition'
    | 'recover';

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
        status: 'catalogOutOfDate' | 'clientNotEnabled' | 'recoveryRequired' | 'failed';
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
            ['expectedRevisionId'],
        )
        || value.protocolVersion !== MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION
        || !isCorrelationValue(value.requestId)
        || !isCorrelationValue(value.sessionToken)
        || ![
            'getStatus',
            'preflightEnable',
            'beginEnable',
            'confirmEnable',
            'reconcile',
            'preflightDisable',
            'beginDisable',
            'confirmDisable',
            'cancelTransition',
            'recover',
        ].includes(value.operation as string)
        || (value.expectedRevisionId !== undefined
            && (typeof value.expectedRevisionId !== 'string'
                || !/^revision:[a-f0-9]{64}$/u.test(value.expectedRevisionId)))) {
        return null;
    }
    const requiresRevision = [
        'preflightEnable', 'beginEnable', 'confirmEnable', 'reconcile',
    ].includes(value.operation as string);
    if (requiresRevision && typeof value.expectedRevisionId !== 'string') {
        return null;
    }
    if (!requiresRevision
        && value.operation !== 'recover'
        && value.expectedRevisionId !== undefined) {
        return null;
    }
    return value as unknown as ManagedRemoteBridgeRequest;
}
