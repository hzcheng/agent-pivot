'use strict';

export const OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION = 3;
export const OPEN_WORKSPACE_RUNNING_FOCUS_REQUEST_COMMAND =
    '_agentPivotOpenWorkspaces.bridge.requestRunningFocusV3';
export const OPEN_WORKSPACE_RUNNING_FOCUS_DELIVER_COMMAND =
    '_agentPivotOpenWorkspaces.workspace.runningFocusRequestedV3';
export const OPEN_WORKSPACE_RUNNING_FOCUS_LEASE_MS = 60_000;
export const MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS = 100;

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const NAVIGATION_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

export interface OpenWorkspaceRunningFocusRequest {
    protocolVersion: 3;
    requestId: string;
    sourceNavigationIdentity: string;
    targetNavigationIdentity: string;
    createdAtMs: number;
    expiresAtMs: number;
}

export interface OpenWorkspaceRunningFocusOutcome {
    protocolVersion: 3;
    requestId: string;
    targetNavigationIdentity: string;
    delivered: true;
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
    const actual = Object.keys(value).sort();
    const required = [...expected].sort();
    if (actual.length !== required.length
        || actual.some((key, index) => key !== required[index])) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireProtocolVersion(value: unknown): 3 {
    if (value !== OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION) {
        throw new Error('open workspace running focus protocol version is incompatible');
    }
    return OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION;
}

function requireRequestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
        throw new Error(
            'open workspace running focus requestId must be 32 lowercase hexadecimal characters',
        );
    }
    return value;
}

function requireNavigationIdentity(value: unknown, label: string): string {
    if (typeof value !== 'string' || !NAVIGATION_IDENTITY_PATTERN.test(value)) {
        throw new Error(
            `open workspace running focus ${label} must be 64 lowercase hexadecimal characters`,
        );
    }
    return value;
}

function requireTimestamp(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value as number;
}

export function createOpenWorkspaceRunningFocusRequest(input: {
    requestId: string;
    sourceNavigationIdentity: string;
    targetNavigationIdentity: string;
    nowMs: number;
}): OpenWorkspaceRunningFocusRequest {
    return validateOpenWorkspaceRunningFocusRequest({
        protocolVersion: OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION,
        requestId: input.requestId,
        sourceNavigationIdentity: input.sourceNavigationIdentity,
        targetNavigationIdentity: input.targetNavigationIdentity,
        createdAtMs: input.nowMs,
        expiresAtMs: input.nowMs + OPEN_WORKSPACE_RUNNING_FOCUS_LEASE_MS,
    });
}

export function validateOpenWorkspaceRunningFocusRequest(
    raw: unknown,
): OpenWorkspaceRunningFocusRequest {
    const request = requireObject(raw, 'open workspace running focus request');
    requireExactKeys(
        request,
        [
            'protocolVersion',
            'requestId',
            'sourceNavigationIdentity',
            'targetNavigationIdentity',
            'createdAtMs',
            'expiresAtMs',
        ],
        'open workspace running focus request',
    );
    const createdAtMs = requireTimestamp(request.createdAtMs, 'createdAtMs');
    const expiresAtMs = requireTimestamp(request.expiresAtMs, 'expiresAtMs');
    if (expiresAtMs <= createdAtMs
        || expiresAtMs - createdAtMs > OPEN_WORKSPACE_RUNNING_FOCUS_LEASE_MS) {
        throw new Error(
            'open workspace running focus request expiry must be within its lease',
        );
    }
    const sourceNavigationIdentity = requireNavigationIdentity(
        request.sourceNavigationIdentity,
        'sourceNavigationIdentity',
    );
    const targetNavigationIdentity = requireNavigationIdentity(
        request.targetNavigationIdentity,
        'targetNavigationIdentity',
    );
    if (sourceNavigationIdentity === targetNavigationIdentity) {
        throw new Error('open workspace running focus source and target must differ');
    }
    return {
        protocolVersion: requireProtocolVersion(request.protocolVersion),
        requestId: requireRequestId(request.requestId),
        sourceNavigationIdentity,
        targetNavigationIdentity,
        createdAtMs,
        expiresAtMs,
    };
}

export function validateOpenWorkspaceRunningFocusOutcome(
    raw: unknown,
): OpenWorkspaceRunningFocusOutcome {
    const outcome = requireObject(raw, 'open workspace running focus outcome');
    requireExactKeys(
        outcome,
        ['protocolVersion', 'requestId', 'targetNavigationIdentity', 'delivered'],
        'open workspace running focus outcome',
    );
    if (outcome.delivered !== true) {
        throw new Error('open workspace running focus outcome must be delivered');
    }
    return {
        protocolVersion: requireProtocolVersion(outcome.protocolVersion),
        requestId: requireRequestId(outcome.requestId),
        targetNavigationIdentity: requireNavigationIdentity(
            outcome.targetNavigationIdentity,
            'targetNavigationIdentity',
        ),
        delivered: true,
    };
}
