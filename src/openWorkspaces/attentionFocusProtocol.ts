'use strict';

export const OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION = 1;
export const OPEN_WORKSPACE_ATTENTION_FOCUS_REQUEST_COMMAND =
    '_agentPivotOpenWorkspaces.bridge.requestAttentionFocus';
export const OPEN_WORKSPACE_ATTENTION_FOCUS_DELIVER_COMMAND =
    '_agentPivotOpenWorkspaces.workspace.attentionFocusRequested';
export const OPEN_WORKSPACE_ATTENTION_FOCUS_LEASE_MS = 60_000;
export const MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS = 100;

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const IDENTITY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SESSION_ID_LENGTH = 1024;

export type OpenWorkspaceAttentionFocusProvider = 'codex' | 'kimi' | 'claude';

export interface OpenWorkspaceAttentionFocusTarget {
    projectId: string;
    provider: OpenWorkspaceAttentionFocusProvider;
    sessionId: string;
}

export interface OpenWorkspaceAttentionFocusRequest
    extends OpenWorkspaceAttentionFocusTarget {
    protocolVersion: 1;
    requestId: string;
    targetNavigationIdentity: string;
    createdAtMs: number;
    expiresAtMs: number;
}

export interface OpenWorkspaceAttentionFocusOutcome {
    protocolVersion: 1;
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

function requireIdentity(value: unknown, label: string): string {
    if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
        throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
    }
    return value;
}

function requireRequestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
        throw new Error(
            'open workspace attention focus requestId must be 32 lowercase hexadecimal characters',
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

function requireProvider(value: unknown): OpenWorkspaceAttentionFocusProvider {
    if (value !== 'codex' && value !== 'kimi' && value !== 'claude') {
        throw new Error('open workspace attention focus provider is invalid');
    }
    return value;
}

function requireSessionId(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > MAX_SESSION_ID_LENGTH) {
        throw new Error('open workspace attention focus sessionId is invalid');
    }
    return value;
}

export function createOpenWorkspaceAttentionFocusRequest(input: {
    requestId: string;
    targetNavigationIdentity: string;
    target: OpenWorkspaceAttentionFocusTarget;
    nowMs: number;
}): OpenWorkspaceAttentionFocusRequest {
    return validateOpenWorkspaceAttentionFocusRequest({
        protocolVersion: OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
        requestId: input.requestId,
        targetNavigationIdentity: input.targetNavigationIdentity,
        projectId: input.target.projectId,
        provider: input.target.provider,
        sessionId: input.target.sessionId,
        createdAtMs: input.nowMs,
        expiresAtMs: input.nowMs + OPEN_WORKSPACE_ATTENTION_FOCUS_LEASE_MS,
    });
}

export function validateOpenWorkspaceAttentionFocusRequest(
    raw: unknown,
): OpenWorkspaceAttentionFocusRequest {
    const request = requireObject(raw, 'open workspace attention focus request');
    requireExactKeys(request, [
        'protocolVersion',
        'requestId',
        'targetNavigationIdentity',
        'projectId',
        'provider',
        'sessionId',
        'createdAtMs',
        'expiresAtMs',
    ], 'open workspace attention focus request');
    if (request.protocolVersion !== OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION) {
        throw new Error('open workspace attention focus protocol version is incompatible');
    }
    const createdAtMs = requireTimestamp(request.createdAtMs, 'createdAtMs');
    const expiresAtMs = requireTimestamp(request.expiresAtMs, 'expiresAtMs');
    if (expiresAtMs <= createdAtMs
        || expiresAtMs - createdAtMs > OPEN_WORKSPACE_ATTENTION_FOCUS_LEASE_MS) {
        throw new Error('open workspace attention focus request expiry must be within its lease');
    }
    return {
        protocolVersion: OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
        requestId: requireRequestId(request.requestId),
        targetNavigationIdentity: requireIdentity(
            request.targetNavigationIdentity,
            'open workspace attention focus targetNavigationIdentity',
        ),
        projectId: requireIdentity(
            request.projectId,
            'open workspace attention focus projectId',
        ),
        provider: requireProvider(request.provider),
        sessionId: requireSessionId(request.sessionId),
        createdAtMs,
        expiresAtMs,
    };
}

export function validateOpenWorkspaceAttentionFocusOutcome(
    raw: unknown,
): OpenWorkspaceAttentionFocusOutcome {
    const outcome = requireObject(raw, 'open workspace attention focus outcome');
    requireExactKeys(outcome, [
        'protocolVersion', 'requestId', 'targetNavigationIdentity', 'delivered',
    ], 'open workspace attention focus outcome');
    if (outcome.protocolVersion !== OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION) {
        throw new Error('open workspace attention focus protocol version is incompatible');
    }
    if (outcome.delivered !== true) {
        throw new Error('open workspace attention focus outcome must be delivered');
    }
    return {
        protocolVersion: OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
        requestId: requireRequestId(outcome.requestId),
        targetNavigationIdentity: requireIdentity(
            outcome.targetNavigationIdentity,
            'open workspace attention focus targetNavigationIdentity',
        ),
        delivered: true,
    };
}
