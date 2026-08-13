'use strict';

import type { AiSessionProviderId } from '../models';
import type {
    AiSessionManagedTmuxMetadata,
    AiSessionManagedTmuxMetadataBase,
    AiSessionRuntimeIdentity,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    getAiSessionRuntimeRootSnapshotKey,
    getAiSessionRuntimeIdentityVersion,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';
import { legacyTmuxLocator } from './tmuxNaming';

const LEGACY_METADATA_VERSION = 2;
const METADATA_VERSION = 3;
const MAX_ID_LENGTH = 512;
const MAX_MARKER_LENGTH = 4096;
const MAX_CREATED_AT_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const TMUX_METADATA_OPTIONS = {
    managed: '@agent-pivot-managed',
    version: '@agent-pivot-version',
    layout: '@agent-pivot-layout',
    workspaceScopeIdentity: '@agent-pivot-workspace-scope-identity',
    workspaceNavigationIdentity: '@agent-pivot-workspace-navigation-identity',
    workspaceRootHostPaths: '@agent-pivot-workspace-root-host-paths',
    writableRootHostPaths: '@agent-pivot-writable-root-host-paths',
    worktreeKey: '@agent-pivot-worktree-key',
    cwd: '@agent-pivot-cwd',
    provider: '@agent-pivot-provider',
    sessionId: '@agent-pivot-session-id',
    pendingId: '@agent-pivot-pending-id',
    createdAt: '@agent-pivot-created-at',
    marker: '@agent-pivot-marker',
} as const;

export class ProjectTmuxLayout {
    getLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        requireIdentityId(identity.sessionId, 'sessionId');
        return legacyTmuxLocator(identity, 'project');
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        requireIdentityId(identity.pendingId, 'pendingId');
        return legacyTmuxLocator(identity, 'project');
    }
}

export class SessionTmuxLayout {
    getLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        requireIdentityId(identity.sessionId, 'sessionId');
        return legacyTmuxLocator(identity, 'session');
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        requireIdentityId(identity.pendingId, 'pendingId');
        return legacyTmuxLocator(identity, 'session');
    }
}

export function getTmuxRuntimeKey(identity: AiSessionRuntimeIdentity): string {
    validateIdentityBase(identity);
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if (hasSessionId === hasPendingId) {
        throw new Error('A tmux runtime identity must have exactly one sessionId or pendingId.');
    }
    const kind = hasSessionId ? 'session' : 'pending';
    const id = requireIdentityId(hasSessionId ? identity.sessionId : identity.pendingId, `${kind}Id`);
    const usesWorktreeIdentity = getAiSessionRuntimeIdentityVersion(identity) === METADATA_VERSION;
    return JSON.stringify([
        usesWorktreeIdentity ? METADATA_VERSION : LEGACY_METADATA_VERSION,
        identity.provider,
        identity.workspaceScopeIdentity,
        identity.workspaceNavigationIdentity,
        JSON.parse(getAiSessionRuntimeRootSnapshotKey(identity)),
        identity.cwd,
        ...(usesWorktreeIdentity ? [
            identity.writableRootHostPaths ?? identity.workspaceRootHostPaths,
            identity.worktreeKey ?? null,
        ] : []),
        kind,
        id,
    ]);
}

export function parseManagedTmuxMetadata(values: unknown): AiSessionManagedTmuxMetadata | null {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return null;
    }
    const record = values as Record<string, unknown>;
    const hasSessionId = record.sessionId !== undefined;
    const hasPendingId = record.pendingId !== undefined;
    const version = record.version === String(LEGACY_METADATA_VERSION)
        ? LEGACY_METADATA_VERSION
        : record.version === String(METADATA_VERSION)
            ? METADATA_VERSION
            : null;
    const v3RequiredKeys = version === METADATA_VERSION ? ['writableRootHostPaths'] : [];
    const v3OptionalKeys = version === METADATA_VERSION ? ['worktreeKey'] : [];
    if (hasSessionId === hasPendingId || !hasExactKeys(record, [
        'managed', 'version', 'layout', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd',
        'provider', hasSessionId ? 'sessionId' : 'pendingId', ...v3RequiredKeys,
    ], ['createdAt', 'marker', ...v3OptionalKeys])) {
        return null;
    }
    if (record.managed !== '1' || version === null
        || !isTmuxLayout(record.layout) || !isAiSessionProviderIdValue(record.provider)
        || !isBoundedString(record.workspaceScopeIdentity, MAX_ID_LENGTH)
        || !isBoundedString(record.workspaceNavigationIdentity, MAX_MARKER_LENGTH)
        || !isBoundedString(record.cwd, MAX_MARKER_LENGTH)) {
        return null;
    }
    const workspaceRootHostPaths = parseWorkspaceRootHostPaths(record.workspaceRootHostPaths);
    if (!workspaceRootHostPaths) {
        return null;
    }
    const writableRootHostPaths = version === METADATA_VERSION
        ? parseWorkspaceRootHostPaths(record.writableRootHostPaths)
        : undefined;
    if (version === METADATA_VERSION && !writableRootHostPaths) {
        return null;
    }
    const worktreeKey = record.worktreeKey === undefined
        ? undefined
        : parseWorktreeKey(record.worktreeKey);
    if (record.worktreeKey !== undefined && !worktreeKey) {
        return null;
    }

    const createdAt = record.createdAt;
    if (createdAt !== undefined
        && (!isBoundedString(createdAt, MAX_CREATED_AT_LENGTH)
            || !Number.isFinite(Date.parse(createdAt)))) {
        return null;
    }
    const marker = record.marker;
    if (marker !== undefined && !isBoundedString(marker, MAX_MARKER_LENGTH)) {
        return null;
    }

    const base: AiSessionManagedTmuxMetadataBase = {
        version,
        layout: record.layout,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths,
        ...(writableRootHostPaths ? { writableRootHostPaths } : {}),
        ...(worktreeKey ? { worktreeKey } : {}),
        cwd: record.cwd,
        provider: record.provider,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(marker !== undefined ? { marker } : {}),
    };
    if (hasSessionId) {
        if (!isBoundedString(record.sessionId, MAX_ID_LENGTH)) {
            return null;
        }
        const result = { ...base, sessionId: record.sessionId };
        return isValidAiSessionRuntimeIdentity(result) ? result : null;
    }
    if (!isBoundedString(record.pendingId, MAX_ID_LENGTH)) {
        return null;
    }
    const result = { ...base, pendingId: record.pendingId };
    return isValidAiSessionRuntimeIdentity(result) ? result : null;
}

function parseWorktreeKey(value: unknown): AiSessionRuntimeIdentity['worktreeKey'] | null {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (_error) {
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const key = parsed as Record<string, unknown>;
    if (Object.keys(key).length !== 2
        || typeof key.repositoryKey !== 'string'
        || typeof key.canonicalWorktreePath !== 'string') {
        return null;
    }
    return {
        repositoryKey: key.repositoryKey,
        canonicalWorktreePath: key.canonicalWorktreePath,
    };
}

function hasExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const keys = Object.keys(record);
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && keys.every(key => allowed.has(key));
}

function validateIdentityBase(identity: AiSessionRuntimeIdentity): void {
    if (!identity || !isAiSessionProviderIdValue(identity.provider)) {
        throw new Error('Unknown AI session provider.');
    }
    if (!isValidAiSessionRuntimeIdentity(identity)) {
        throw new Error('The tmux runtime workspace identity is invalid.');
    }
}

function parseWorkspaceRootHostPaths(value: unknown): string[] | null {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (_error) {
            return null;
        }
    }
    if (!Array.isArray(parsed)) {
        return null;
    }
    const identity = {
        provider: 'codex' as const,
        workspaceScopeIdentity: 'validation',
        workspaceNavigationIdentity: 'validation',
        workspaceRootHostPaths: parsed,
        cwd: '',
        sessionId: 'validation',
    };
    for (const candidate of parsed) {
        identity.cwd = typeof candidate === 'string' ? candidate : '';
        if (isValidAiSessionRuntimeIdentity(identity)) {
            return [...parsed] as string[];
        }
    }
    return null;
}

function requireIdentityId(value: unknown, name: string): string {
    if (!isBoundedString(value, MAX_ID_LENGTH)) {
        throw new Error(`${name} must be a non-empty bounded string without control characters.`);
    }
    return value;
}

function isAiSessionProviderIdValue(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isTmuxLayout(value: unknown): value is AiSessionTmuxLayout {
    return value === 'project' || value === 'session';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}
