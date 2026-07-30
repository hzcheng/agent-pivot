'use strict';

import * as crypto from 'crypto';

export const OPEN_WORKSPACE_PIN_PROTOCOL_VERSION = 1;
export const MAX_OPEN_WORKSPACE_PINS = 200;
export const OPEN_WORKSPACE_PIN_SET_COMMAND =
    '_agentPivotOpenWorkspaces.bridge.setPin';
export const OPEN_WORKSPACE_PIN_SNAPSHOT_COMMAND =
    '_agentPivotOpenWorkspaces.workspace.pinSnapshot';

const NAVIGATION_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

export interface OpenWorkspacePinRecord {
    protocolVersion: 1;
    navigationIdentity: string;
    pinnedAtMs: number;
}

export interface OpenWorkspacePinSnapshot {
    protocolVersion: 1;
    revision: string;
    pins: OpenWorkspacePinRecord[];
}

export interface OpenWorkspacePinSetRequest {
    protocolVersion: 1;
    requestId: number;
    navigationIdentity: string;
    pinned: boolean;
}

export interface OpenWorkspacePinSetOutcome {
    protocolVersion: 1;
    requestId: number;
    navigationIdentity: string;
    pinned: boolean;
    snapshot: OpenWorkspacePinSnapshot;
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
    if (value !== OPEN_WORKSPACE_PIN_PROTOCOL_VERSION) {
        throw new Error('open workspace pin protocol version is incompatible');
    }
    return OPEN_WORKSPACE_PIN_PROTOCOL_VERSION;
}

function requireNavigationIdentity(value: unknown): string {
    if (typeof value !== 'string' || !NAVIGATION_IDENTITY_PATTERN.test(value)) {
        throw new Error(
            'open workspace pin navigationIdentity must be 64 lowercase hexadecimal characters',
        );
    }
    return value;
}

function requireRequestId(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error('open workspace pin requestId must be a positive safe integer');
    }
    return value as number;
}

function requireTimestamp(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error('open workspace pin timestamp must be a non-negative safe integer');
    }
    return value as number;
}

function comparePins(left: OpenWorkspacePinRecord, right: OpenWorkspacePinRecord): number {
    if (left.pinnedAtMs !== right.pinnedAtMs) {
        return left.pinnedAtMs - right.pinnedAtMs;
    }
    return left.navigationIdentity < right.navigationIdentity
        ? -1
        : left.navigationIdentity > right.navigationIdentity ? 1 : 0;
}

export function validateOpenWorkspacePinRecord(raw: unknown): OpenWorkspacePinRecord {
    const record = requireObject(raw, 'open workspace pin record');
    requireExactKeys(
        record,
        ['protocolVersion', 'navigationIdentity', 'pinnedAtMs'],
        'open workspace pin record',
    );
    return {
        protocolVersion: requireProtocolVersion(record.protocolVersion),
        navigationIdentity: requireNavigationIdentity(record.navigationIdentity),
        pinnedAtMs: requireTimestamp(record.pinnedAtMs),
    };
}

export function createOpenWorkspacePinSnapshot(
    records: readonly OpenWorkspacePinRecord[],
): OpenWorkspacePinSnapshot {
    const byIdentity = new Map<string, OpenWorkspacePinRecord>();
    for (const raw of records || []) {
        const record = validateOpenWorkspacePinRecord(raw);
        if (byIdentity.has(record.navigationIdentity)) {
            throw new Error('open workspace pin snapshot contains duplicate identities');
        }
        byIdentity.set(record.navigationIdentity, record);
    }
    if (byIdentity.size > MAX_OPEN_WORKSPACE_PINS) {
        throw new Error(`open workspace pin snapshot exceeds ${MAX_OPEN_WORKSPACE_PINS} records`);
    }
    const pins = Array.from(byIdentity.values()).sort(comparePins);
    const revision = crypto.createHash('sha256')
        .update(JSON.stringify(pins))
        .digest('hex');
    return {
        protocolVersion: OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
        revision,
        pins,
    };
}

export function validateOpenWorkspacePinSnapshot(raw: unknown): OpenWorkspacePinSnapshot {
    const snapshot = requireObject(raw, 'open workspace pin snapshot');
    requireExactKeys(
        snapshot,
        ['protocolVersion', 'revision', 'pins'],
        'open workspace pin snapshot',
    );
    requireProtocolVersion(snapshot.protocolVersion);
    if (typeof snapshot.revision !== 'string'
        || !NAVIGATION_IDENTITY_PATTERN.test(snapshot.revision)
        || !Array.isArray(snapshot.pins)) {
        throw new Error('open workspace pin snapshot is invalid');
    }
    const normalized = createOpenWorkspacePinSnapshot(snapshot.pins);
    if (normalized.revision !== snapshot.revision) {
        throw new Error('open workspace pin snapshot revision does not match its records');
    }
    return normalized;
}

export function validateOpenWorkspacePinSetRequest(
    raw: unknown,
): OpenWorkspacePinSetRequest {
    const request = requireObject(raw, 'open workspace pin request');
    requireExactKeys(
        request,
        ['protocolVersion', 'requestId', 'navigationIdentity', 'pinned'],
        'open workspace pin request',
    );
    if (typeof request.pinned !== 'boolean') {
        throw new Error('open workspace pin request pinned must be boolean');
    }
    return {
        protocolVersion: requireProtocolVersion(request.protocolVersion),
        requestId: requireRequestId(request.requestId),
        navigationIdentity: requireNavigationIdentity(request.navigationIdentity),
        pinned: request.pinned,
    };
}

export function validateOpenWorkspacePinSetOutcome(
    raw: unknown,
): OpenWorkspacePinSetOutcome {
    const outcome = requireObject(raw, 'open workspace pin outcome');
    requireExactKeys(
        outcome,
        ['protocolVersion', 'requestId', 'navigationIdentity', 'pinned', 'snapshot'],
        'open workspace pin outcome',
    );
    if (typeof outcome.pinned !== 'boolean') {
        throw new Error('open workspace pin outcome pinned must be boolean');
    }
    const normalized: OpenWorkspacePinSetOutcome = {
        protocolVersion: requireProtocolVersion(outcome.protocolVersion),
        requestId: requireRequestId(outcome.requestId),
        navigationIdentity: requireNavigationIdentity(outcome.navigationIdentity),
        pinned: outcome.pinned,
        snapshot: validateOpenWorkspacePinSnapshot(outcome.snapshot),
    };
    const record = normalized.snapshot.pins.find(
        pin => pin.navigationIdentity === normalized.navigationIdentity,
    );
    if (Boolean(record) !== normalized.pinned) {
        throw new Error('open workspace pin outcome does not match its snapshot');
    }
    return normalized;
}

export function getOpenWorkspacePinTimes(
    snapshot: OpenWorkspacePinSnapshot | null,
): ReadonlyMap<string, number> {
    const pins = snapshot ? validateOpenWorkspacePinSnapshot(snapshot).pins : [];
    return new Map(pins.map(pin => [pin.navigationIdentity, pin.pinnedAtMs]));
}
