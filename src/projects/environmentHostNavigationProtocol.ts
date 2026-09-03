'use strict';

import { validateProjectMachineId } from './projectClientProtocol';

export const ENVIRONMENT_HOST_OPEN_COMMAND = '_agentPivotProjects.bridge.openHost';
export const ENVIRONMENT_PROJECT_OPEN_COMMAND = '_agentPivotProjects.bridge.openProject';
export const ENVIRONMENT_NAVIGATION_HANDSHAKE_COMMAND = '_agentPivotProjects.bridge.navigationHandshake';
export const ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION = 1;

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export interface EnvironmentHostOpenRequest {
    protocolVersion: 1;
    requestId: string;
    machineId: string;
}

export interface EnvironmentProjectOpenRequest extends EnvironmentHostOpenRequest {
    projectPath: string;
}

export type EnvironmentHostOpenOutcome = {
    protocolVersion: 1;
    requestId: string;
    handedOff: true;
} | {
    protocolVersion: 1;
    requestId: string;
    handedOff: false;
    reason: 'remoteSshMissing';
};

export interface EnvironmentNavigationHandshakeRequest {
    protocolVersion: 1;
    mainExtensionVersion: string;
}

export interface EnvironmentNavigationHandshakeOutcome {
    protocolVersion: 1;
    bridgeExtensionVersion: string;
    capabilities: {
        hostNavigation: true;
        projectNavigation: true;
        authoritativeProfiles: true;
    };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
    label: string,
): void {
    const keys = Object.keys(value).sort();
    const required = [...expected].sort();
    if (keys.length !== required.length
        || keys.some((key, index) => key !== required[index])) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireRequestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
        throw new Error('environment Host open requestId is invalid');
    }
    return value;
}

export function validateEnvironmentHostOpenRequest(raw: unknown): EnvironmentHostOpenRequest {
    const request = requireObject(raw, 'environment Host open request');
    requireExactKeys(request, [
        'protocolVersion', 'requestId', 'machineId',
    ], 'environment Host open request');
    if (request.protocolVersion !== ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION) {
        throw new Error('environment Host open protocolVersion is unsupported');
    }
    return {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        requestId: requireRequestId(request.requestId),
        machineId: validateProjectMachineId(request.machineId),
    };
}

export function validateEnvironmentProjectOpenRequest(raw: unknown): EnvironmentProjectOpenRequest {
    const request = requireObject(raw, 'environment Project open request');
    requireExactKeys(request, [
        'protocolVersion', 'requestId', 'machineId', 'projectPath',
    ], 'environment Project open request');
    if (request.protocolVersion !== ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION
        || typeof request.projectPath !== 'string'
        || request.projectPath.length === 0
        || request.projectPath.length > 8192
        || CONTROL_CHARACTERS_PATTERN.test(request.projectPath)) {
        throw new Error('environment Project open request is invalid');
    }
    return {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        requestId: requireRequestId(request.requestId),
        machineId: validateProjectMachineId(request.machineId),
        projectPath: request.projectPath,
    };
}

export function validateEnvironmentNavigationHandshakeRequest(
    raw: unknown,
): EnvironmentNavigationHandshakeRequest {
    const request = requireObject(raw, 'environment navigation handshake request');
    requireExactKeys(request, ['protocolVersion', 'mainExtensionVersion'], 'environment navigation handshake request');
    if (request.protocolVersion !== ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION
        || typeof request.mainExtensionVersion !== 'string'
        || request.mainExtensionVersion.length === 0
        || request.mainExtensionVersion.length > 64) {
        throw new Error('environment navigation handshake request is invalid');
    }
    return {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        mainExtensionVersion: request.mainExtensionVersion,
    };
}

export function validateEnvironmentNavigationHandshakeOutcome(
    raw: unknown,
): EnvironmentNavigationHandshakeOutcome {
    const outcome = requireObject(raw, 'environment navigation handshake outcome');
    requireExactKeys(outcome, [
        'protocolVersion', 'bridgeExtensionVersion', 'capabilities',
    ], 'environment navigation handshake outcome');
    const capabilities = requireObject(outcome.capabilities, 'environment navigation capabilities');
    requireExactKeys(capabilities, [
        'hostNavigation', 'projectNavigation', 'authoritativeProfiles',
    ], 'environment navigation capabilities');
    if (outcome.protocolVersion !== ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION
        || typeof outcome.bridgeExtensionVersion !== 'string'
        || !outcome.bridgeExtensionVersion
        || outcome.bridgeExtensionVersion.length > 64
        || capabilities.hostNavigation !== true
        || capabilities.projectNavigation !== true
        || capabilities.authoritativeProfiles !== true) {
        throw new Error('environment navigation handshake outcome is incompatible');
    }
    return {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        bridgeExtensionVersion: outcome.bridgeExtensionVersion,
        capabilities: {
            hostNavigation: true,
            projectNavigation: true,
            authoritativeProfiles: true,
        },
    };
}

export function validateEnvironmentHostOpenOutcome(raw: unknown): EnvironmentHostOpenOutcome {
    const outcome = requireObject(raw, 'environment Host open outcome');
    const handedOff = outcome.handedOff === true;
    requireExactKeys(outcome, handedOff
        ? ['protocolVersion', 'requestId', 'handedOff']
        : ['protocolVersion', 'requestId', 'handedOff', 'reason'],
    'environment Host open outcome');
    if (outcome.protocolVersion !== ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION
        || (outcome.handedOff !== true
            && (outcome.handedOff !== false || outcome.reason !== 'remoteSshMissing'))) {
        throw new Error('environment Host open outcome is invalid');
    }
    return handedOff ? {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        requestId: requireRequestId(outcome.requestId),
        handedOff: true,
    } : {
        protocolVersion: ENVIRONMENT_HOST_OPEN_PROTOCOL_VERSION,
        requestId: requireRequestId(outcome.requestId),
        handedOff: false,
        reason: 'remoteSshMissing',
    };
}
