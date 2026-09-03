'use strict';

import * as crypto from 'crypto';

export const PROJECT_CLIENT_PROTOCOL_VERSION = 1;
export const PROJECT_CLIENT_HANDSHAKE_COMMAND = '_agentPivotProjects.client.handshake';
export const PROJECT_CLIENT_UPDATE_PROFILE_COMMAND = '_agentPivotProjects.client.updateProfile';
export const PROJECT_CLIENT_CAPABILITIES = {
    clientIdentity: true,
    connectionProfiles: true,
    uiHostLocalStorage: true,
} as const;

const CLIENT_ID_PATTERN = /^[a-f0-9]{32}$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const CONTROL_OR_WHITESPACE_PATTERN = /[\u0000-\u0020\u007f-\u009f]/;
const MAX_EXTENSION_VERSION_LENGTH = 64;
const MAX_CONNECTION_TARGET_LENGTH = 512;
export const MAX_PROJECT_CONNECTION_PROFILES = 500;

export type ProjectConnectionKind = 'local' | 'ssh';

export interface ProjectConnectionProfile {
    machineId: string;
    kind: ProjectConnectionKind;
    target: string | null;
    updatedAtMs: number;
}

export interface ProjectClientSnapshot {
    protocolVersion: 1;
    clientId: string;
    revision: string;
    profiles: ProjectConnectionProfile[];
}

export interface ProjectClientHandshakeRequest {
    protocolVersion: 1;
    mainExtensionVersion: string;
}

export interface ProjectClientHandshakeResponse {
    accepted: true;
    protocolVersion: 1;
    bridgeExtensionVersion: string;
    capabilities: typeof PROJECT_CLIENT_CAPABILITIES;
    snapshot: ProjectClientSnapshot;
}

export interface ProjectConnectionProfileUpdateRequest {
    protocolVersion: 1;
    requestId: string;
    machineId: string;
    profile: { kind: ProjectConnectionKind; target: string | null } | null;
}

export interface ProjectConnectionProfileUpdateOutcome {
    protocolVersion: 1;
    requestId: string;
    machineId: string;
    saved: boolean;
    snapshot: ProjectClientSnapshot;
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

function requireProtocolVersion(value: unknown): 1 {
    if (value !== PROJECT_CLIENT_PROTOCOL_VERSION) {
        throw new Error('project client protocol version is incompatible');
    }
    return PROJECT_CLIENT_PROTOCOL_VERSION;
}

function requireClientId(value: unknown): string {
    if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
        throw new Error('project client clientId must be 32 lowercase hexadecimal characters');
    }
    return value;
}

export function validateProjectMachineId(value: unknown): string {
    if (typeof value !== 'string' || !MACHINE_ID_PATTERN.test(value)) {
        throw new Error('project client machineId must be a lowercase UUID');
    }
    return value;
}

function requireRequestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
        throw new Error('project client requestId must be 32 lowercase hexadecimal characters');
    }
    return value;
}

function requireTimestamp(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('project client updatedAtMs must be a non-negative safe integer');
    }
    return value;
}

function requireExtensionVersion(value: unknown, label: string): string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_EXTENSION_VERSION_LENGTH
        || CONTROL_OR_WHITESPACE_PATTERN.test(value)) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function requireConnectionKind(value: unknown): ProjectConnectionKind {
    if (value !== 'local' && value !== 'ssh') {
        throw new Error('project client connection kind is invalid');
    }
    return value;
}

function requireConnectionTarget(value: unknown, kind: ProjectConnectionKind): string | null {
    if (kind === 'local') {
        if (value !== null) {
            throw new Error('local project client connection target must be null');
        }
        return null;
    }
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_CONNECTION_TARGET_LENGTH
        || CONTROL_OR_WHITESPACE_PATTERN.test(value)) {
        throw new Error('SSH project client connection target is invalid');
    }
    return value;
}

function compareProfiles(left: ProjectConnectionProfile, right: ProjectConnectionProfile): number {
    return left.machineId < right.machineId ? -1 : left.machineId > right.machineId ? 1 : 0;
}

export function validateProjectConnectionProfile(raw: unknown): ProjectConnectionProfile {
    const profile = requireObject(raw, 'project client connection profile');
    requireExactKeys(
        profile,
        ['machineId', 'kind', 'target', 'updatedAtMs'],
        'project client connection profile',
    );
    const kind = requireConnectionKind(profile.kind);
    return {
        machineId: validateProjectMachineId(profile.machineId),
        kind,
        target: requireConnectionTarget(profile.target, kind),
        updatedAtMs: requireTimestamp(profile.updatedAtMs),
    };
}

export function createProjectClientSnapshot(
    clientId: string,
    rawProfiles: readonly ProjectConnectionProfile[],
): ProjectClientSnapshot {
    const profiles = Array.from(rawProfiles || [], validateProjectConnectionProfile)
        .sort(compareProfiles);
    if (profiles.length > MAX_PROJECT_CONNECTION_PROFILES) {
        throw new Error(`project client snapshot exceeds ${MAX_PROJECT_CONNECTION_PROFILES} profiles`);
    }
    if (new Set(profiles.map(profile => profile.machineId)).size !== profiles.length) {
        throw new Error('project client snapshot contains duplicate machineIds');
    }
    const normalizedClientId = requireClientId(clientId);
    const revision = crypto.createHash('sha256')
        .update(JSON.stringify(profiles))
        .digest('hex');
    return {
        protocolVersion: PROJECT_CLIENT_PROTOCOL_VERSION,
        clientId: normalizedClientId,
        revision,
        profiles,
    };
}

export function validateProjectClientSnapshot(raw: unknown): ProjectClientSnapshot {
    const snapshot = requireObject(raw, 'project client snapshot');
    requireExactKeys(
        snapshot,
        ['protocolVersion', 'clientId', 'revision', 'profiles'],
        'project client snapshot',
    );
    requireProtocolVersion(snapshot.protocolVersion);
    if (typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision)) {
        throw new Error('project client snapshot revision is invalid');
    }
    if (!Array.isArray(snapshot.profiles)) {
        throw new Error('project client snapshot profiles must be an array');
    }
    const normalized = createProjectClientSnapshot(
        requireClientId(snapshot.clientId),
        snapshot.profiles as ProjectConnectionProfile[],
    );
    if (normalized.revision !== snapshot.revision) {
        throw new Error('project client snapshot revision does not match its profiles');
    }
    return normalized;
}

export function validateProjectClientHandshakeRequest(raw: unknown): ProjectClientHandshakeRequest {
    const request = requireObject(raw, 'project client handshake request');
    requireExactKeys(
        request,
        ['protocolVersion', 'mainExtensionVersion'],
        'project client handshake request',
    );
    return {
        protocolVersion: requireProtocolVersion(request.protocolVersion),
        mainExtensionVersion: requireExtensionVersion(
            request.mainExtensionVersion,
            'project client mainExtensionVersion',
        ),
    };
}

export function validateProjectClientHandshakeResponse(raw: unknown): ProjectClientHandshakeResponse {
    const response = requireObject(raw, 'project client handshake response');
    requireExactKeys(
        response,
        ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities', 'snapshot'],
        'project client handshake response',
    );
    const capabilities = requireObject(response.capabilities, 'project client capabilities');
    requireExactKeys(capabilities, Object.keys(PROJECT_CLIENT_CAPABILITIES), 'project client capabilities');
    if (response.accepted !== true
        || Object.keys(PROJECT_CLIENT_CAPABILITIES).some(key => capabilities[key] !== true)) {
        throw new Error('project client handshake capabilities are incompatible');
    }
    return {
        accepted: true,
        protocolVersion: requireProtocolVersion(response.protocolVersion),
        bridgeExtensionVersion: requireExtensionVersion(
            response.bridgeExtensionVersion,
            'project client bridgeExtensionVersion',
        ),
        capabilities: PROJECT_CLIENT_CAPABILITIES,
        snapshot: validateProjectClientSnapshot(response.snapshot),
    };
}

export function validateProjectConnectionProfileUpdateRequest(
    raw: unknown,
): ProjectConnectionProfileUpdateRequest {
    const request = requireObject(raw, 'project client profile update request');
    requireExactKeys(
        request,
        ['protocolVersion', 'requestId', 'machineId', 'profile'],
        'project client profile update request',
    );
    const machineId = validateProjectMachineId(request.machineId);
    let profile: ProjectConnectionProfileUpdateRequest['profile'] = null;
    if (request.profile !== null) {
        const rawProfile = requireObject(request.profile, 'project client profile update');
        requireExactKeys(rawProfile, ['kind', 'target'], 'project client profile update');
        const kind = requireConnectionKind(rawProfile.kind);
        profile = {
            kind,
            target: requireConnectionTarget(rawProfile.target, kind),
        };
    }
    return {
        protocolVersion: requireProtocolVersion(request.protocolVersion),
        requestId: requireRequestId(request.requestId),
        machineId,
        profile,
    };
}

export function validateProjectConnectionProfileUpdateOutcome(
    raw: unknown,
): ProjectConnectionProfileUpdateOutcome {
    const outcome = requireObject(raw, 'project client profile update outcome');
    requireExactKeys(
        outcome,
        ['protocolVersion', 'requestId', 'machineId', 'saved', 'snapshot'],
        'project client profile update outcome',
    );
    if (typeof outcome.saved !== 'boolean') {
        throw new Error('project client profile update outcome saved must be boolean');
    }
    const normalized: ProjectConnectionProfileUpdateOutcome = {
        protocolVersion: requireProtocolVersion(outcome.protocolVersion),
        requestId: requireRequestId(outcome.requestId),
        machineId: validateProjectMachineId(outcome.machineId),
        saved: outcome.saved,
        snapshot: validateProjectClientSnapshot(outcome.snapshot),
    };
    const exists = normalized.snapshot.profiles.some(
        profile => profile.machineId === normalized.machineId,
    );
    if (exists !== normalized.saved) {
        throw new Error('project client profile update outcome does not match its snapshot');
    }
    return normalized;
}
