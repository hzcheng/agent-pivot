'use strict';

export const SAVED_PROJECT_NAVIGATE_COMMAND = '_agentPivotProjects.bridge.navigate';
export const SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION = 1;
const MAX_PROJECT_PATH_LENGTH = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type SavedProjectRemoteType = 0 | 1 | 2 | 3 | 4;

export interface SavedProjectNavigationRequest {
    protocolVersion: 1;
    projectPath: string;
    remoteType: SavedProjectRemoteType;
    openInNewWindow: boolean;
}

export interface SavedProjectNavigationOutcome {
    protocolVersion: 1;
    opened: true;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, required: string[], label: string): void {
    const keys = Object.keys(value);
    if (keys.length !== required.length
        || keys.some(key => !required.includes(key))
        || required.some(key => !keys.includes(key))) {
        throw new Error(`${label} has unexpected fields`);
    }
}

export function validateSavedProjectNavigationRequest(raw: unknown): SavedProjectNavigationRequest {
    const request = requireObject(raw, 'saved project navigation request');
    requireExactKeys(request, [
        'protocolVersion',
        'projectPath',
        'remoteType',
        'openInNewWindow',
    ], 'saved project navigation request');
    if (request.protocolVersion !== SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION) {
        throw new Error('saved project navigation protocolVersion is unsupported');
    }
    if (typeof request.projectPath !== 'string'
        || request.projectPath.length === 0
        || request.projectPath.length > MAX_PROJECT_PATH_LENGTH
        || CONTROL_CHARACTERS.test(request.projectPath)) {
        throw new Error('saved project navigation projectPath is invalid');
    }
    if (!Number.isInteger(request.remoteType)
        || (request.remoteType as number) < 0
        || (request.remoteType as number) > 4) {
        throw new Error('saved project navigation remoteType is invalid');
    }
    if (typeof request.openInNewWindow !== 'boolean') {
        throw new Error('saved project navigation openInNewWindow must be a boolean');
    }
    return {
        protocolVersion: SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
        projectPath: request.projectPath,
        remoteType: request.remoteType as SavedProjectRemoteType,
        openInNewWindow: request.openInNewWindow,
    };
}

export function validateSavedProjectNavigationOutcome(raw: unknown): SavedProjectNavigationOutcome {
    const outcome = requireObject(raw, 'saved project navigation outcome');
    requireExactKeys(outcome, ['protocolVersion', 'opened'], 'saved project navigation outcome');
    if (outcome.protocolVersion !== SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION || outcome.opened !== true) {
        throw new Error('saved project navigation outcome is invalid');
    }
    return {
        protocolVersion: SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
        opened: true,
    };
}
