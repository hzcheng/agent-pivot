'use strict';

import type { AiSessionLaunchSpec } from './launchSpec';
import { serializeTmuxLaunchCommand } from './launchSpec';
import {
    materializeAiSessionLaunchSpec,
    snapshotAiSessionRuntimeLaunch,
} from './runtimeLaunch';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionDeferredCreateRuntimeRequest,
    AiSessionDeferredResumeRuntimeRequest,
    AiSessionLazyRuntimeLaunch,
    AiSessionMaterializedCreateRuntimeRequest,
    AiSessionMaterializedResumeRuntimeRequest,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeIdentity,
} from './runtimeTypes';
import {
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';

const MAX_LOCAL_PATH_LENGTH = 4096;
const MAX_IDENTITY_FIELD_LENGTH = 512;
const MAX_EXECUTABLE_LENGTH = 4096;
const MAX_LAUNCH_ARGUMENT_BYTES = 16 * 1024;
const MAX_LAUNCH_ARGUMENTS = 256;
const MAX_EXCLUDED_SESSION_IDS = 1000;
const MAX_AGGREGATE_LAUNCH_BYTES = 32 * 1024;
const MAX_SERIALIZED_TMUX_COMMAND_BYTES = 128 * 1024;
const LOCAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function snapshotResumeRequest(
    request: AiSessionResumeRuntimeRequest
): AiSessionDeferredResumeRuntimeRequest {
    if (!isRecordShape(request)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const identity = snapshotResumeIdentity(request.identity);
    const projectName = snapshotRequiredString(request.projectName, 'The tmux runtime request');
    const sessionName = snapshotDisplayName(
        request.sessionName, identity.sessionId, 'The tmux runtime request'
    );
    const terminalName = snapshotRequiredString(request.terminalName, 'The tmux runtime request');
    const launch = snapshotTmuxRuntimeLaunch(request, identity);
    return {
        identity,
        projectName,
        sessionName,
        terminalName,
        launchMarkerPath: launch.launchMarkerPath,
        createLaunchSpec: launch.createLaunchSpec,
        directoryScope: request.directoryScope,
    };
}

export function snapshotPendingRequest(
    request: AiSessionCreateRuntimeRequest
): AiSessionDeferredCreateRuntimeRequest {
    if (!isRecordShape(request)) {
        throw new Error('The pending runtime request shape is invalid.');
    }
    const identity = snapshotPendingIdentity(request.identity);
    const projectName = snapshotRequiredString(request.projectName, 'The pending runtime request');
    const terminalName = snapshotRequiredString(request.terminalName, 'The pending runtime request');
    const createdAt = snapshotRequiredString(request.createdAt, 'The pending runtime request');
    const excludedSessionIds = snapshotDenseStringArray(request.excludedSessionIds,
        MAX_EXCLUDED_SESSION_IDS, 'excluded session IDs', 'The pending runtime request');
    const title = snapshotOptionalString(request.title, 'The pending runtime request');
    const launch = snapshotTmuxRuntimeLaunch(request, identity);
    return {
        identity,
        projectName,
        terminalName,
        createdAt,
        excludedSessionIds,
        ...(title === undefined ? {} : { title }),
        launchMarkerPath: launch.launchMarkerPath,
        createLaunchSpec: launch.createLaunchSpec,
        directoryScope: request.directoryScope,
    };
}

function snapshotLaunch(
    launch: unknown
): AiSessionLaunchSpec {
    if (!isRecordShape(launch)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const executable = snapshotRequiredString(launch.executable, 'The tmux runtime request');
    const args = snapshotDenseStringArray(launch.args, MAX_LAUNCH_ARGUMENTS,
        'provider launch arguments', 'The tmux runtime request');
    const cwd = snapshotOptionalString(launch.cwd, 'The tmux runtime request');
    const markerPath = snapshotOptionalString(launch.markerPath, 'The tmux runtime request');
    const windowsDirectShell = launch.windowsDirectShell;
    if (windowsDirectShell !== undefined && windowsDirectShell !== 'current'
        && windowsDirectShell !== 'powershell') {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    return {
        executable,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        ...(markerPath === undefined ? {} : { markerPath }),
        ...(windowsDirectShell === undefined
            ? {}
            : { windowsDirectShell: windowsDirectShell as 'current' | 'powershell' }),
    };
}

function snapshotTmuxRuntimeLaunch(
    request: AiSessionCreateRuntimeRequest | AiSessionResumeRuntimeRequest,
    identity: AiSessionRuntimeIdentity
): AiSessionLazyRuntimeLaunch {
    const candidate = request as unknown as Record<string, unknown>;
    if (typeof candidate.createLaunchSpec === 'function') {
        return snapshotAiSessionRuntimeLaunch(request);
    }
    const launch = snapshotLaunch(candidate.launch);
    validateDispatchInputs(identity, launch);
    const launchMarkerPath = candidate.launchMarkerPath === undefined
        ? launch.markerPath || ''
        : snapshotRequiredString(candidate.launchMarkerPath, 'The tmux runtime request');
    return {
        launchMarkerPath,
        createLaunchSpec: () => launch,
    };
}

export function materializeResumeRequest(
    request: AiSessionDeferredResumeRuntimeRequest
): AiSessionMaterializedResumeRuntimeRequest {
    const launch = snapshotLaunch(materializeAiSessionLaunchSpec(request));
    validateDispatchInputs(request.identity, launch);
    return {
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        projectName: request.projectName,
        sessionName: request.sessionName,
        terminalName: request.terminalName,
        launchMarkerPath: request.launchMarkerPath,
        launch,
        directoryScope: request.directoryScope,
    };
}

export function materializePendingRequest(
    request: AiSessionDeferredCreateRuntimeRequest
): AiSessionMaterializedCreateRuntimeRequest {
    const launch = snapshotLaunch(materializeAiSessionLaunchSpec(request));
    validateDispatchInputs(request.identity, launch);
    return {
        identity: cloneAiSessionRuntimeIdentity(request.identity),
        projectName: request.projectName,
        terminalName: request.terminalName,
        createdAt: request.createdAt,
        excludedSessionIds: [...request.excludedSessionIds],
        ...(request.title === undefined ? {} : { title: request.title }),
        launchMarkerPath: request.launchMarkerPath,
        launch,
        directoryScope: request.directoryScope,
    };
}

function snapshotResumeIdentity(value: unknown): AiSessionResumeRuntimeRequest['identity'] {
    if (!isRecordShape(value)) {
        throw new Error('The tmux runtime request shape is invalid.');
    }
    const provider = snapshotRequiredString(value.provider, 'The tmux runtime request');
    const workspaceScopeIdentity = snapshotRequiredString(value.workspaceScopeIdentity, 'The tmux runtime request');
    const workspaceNavigationIdentity = snapshotRequiredString(
        value.workspaceNavigationIdentity, 'The tmux runtime request'
    );
    const workspaceRootHostPaths = snapshotDenseStringArray(value.workspaceRootHostPaths,
        MAX_EXCLUDED_SESSION_IDS, 'workspace root paths', 'The tmux runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The tmux runtime request');
    const sessionId = snapshotRequiredString(value.sessionId, 'The tmux runtime request');
    return {
        provider: provider as AiSessionResumeRuntimeRequest['identity']['provider'],
        workspaceScopeIdentity,
        workspaceNavigationIdentity,
        workspaceRootHostPaths,
        cwd,
        sessionId,
    };
}

function snapshotPendingIdentity(value: unknown): AiSessionCreateRuntimeRequest['identity'] {
    if (!isRecordShape(value)) {
        throw new Error('The pending runtime request shape is invalid.');
    }
    const provider = snapshotRequiredString(value.provider, 'The pending runtime request');
    const workspaceScopeIdentity = snapshotRequiredString(value.workspaceScopeIdentity, 'The pending runtime request');
    const workspaceNavigationIdentity = snapshotRequiredString(
        value.workspaceNavigationIdentity, 'The pending runtime request'
    );
    const workspaceRootHostPaths = snapshotDenseStringArray(value.workspaceRootHostPaths,
        MAX_EXCLUDED_SESSION_IDS, 'workspace root paths', 'The pending runtime request');
    const cwd = snapshotRequiredString(value.cwd, 'The pending runtime request');
    const pendingId = snapshotRequiredString(value.pendingId, 'The pending runtime request');
    return {
        provider: provider as AiSessionCreateRuntimeRequest['identity']['provider'],
        workspaceScopeIdentity,
        workspaceNavigationIdentity,
        workspaceRootHostPaths,
        cwd,
        pendingId,
    };
}

function snapshotRequiredString(value: unknown, owner: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${owner} shape is invalid.`);
    }
    return value;
}

function snapshotOptionalString(value: unknown, owner: string): string | undefined {
    return value === undefined ? undefined : snapshotRequiredString(value, owner);
}

function snapshotDisplayName(value: unknown, fallback: string, owner: string): string {
    const candidate = value === undefined ? fallback : snapshotRequiredString(value, owner);
    if (candidate.length > 200 || LOCAL_CONTROL_CHARACTERS.test(candidate)) {
        throw new Error(`${owner} display name is invalid.`);
    }
    return candidate;
}

function snapshotDenseStringArray(
    value: unknown,
    maximum: number,
    label: string,
    owner: string
): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${owner} ${label} must be an array.`);
    }
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > maximum) {
        throw new Error(`${owner} has too many ${label}; the ${label} count is too large.`);
    }
    const snapshot: string[] = [];
    for (let index = 0; index < length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new Error(`${owner} requires dense ${label}.`);
        }
        const item = value[index];
        if (typeof item !== 'string') {
            throw new Error(`${owner} requires dense ${label}.`);
        }
        snapshot.push(item);
    }
    return snapshot;
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateDispatchInputs(
    identity: AiSessionRuntimeIdentity,
    launch: AiSessionLaunchSpec
): void {
    validateDispatchIdentity(identity);
    validateLaunchInputs(identity, launch);
}

export function validateDispatchIdentity(identity: AiSessionRuntimeIdentity): void {
    if (!identity || !isValidAiSessionRuntimeIdentity(identity)) {
        throw new Error('The tmux runtime cwd is invalid.');
    }
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if ((identity.provider !== 'codex' && identity.provider !== 'kimi' && identity.provider !== 'claude')
        || hasSessionId === hasPendingId
        || !isIdentityField(hasSessionId ? identity.sessionId : identity.pendingId)) {
        throw new Error('The tmux runtime identity is invalid.');
    }
}

function validateLaunchInputs(
    identity: AiSessionRuntimeIdentity,
    launch: AiSessionLaunchSpec
): void {
    if (!launch || typeof launch.executable !== 'string' || !launch.executable
        || launch.executable.length > MAX_EXECUTABLE_LENGTH
        || LOCAL_CONTROL_CHARACTERS.test(launch.executable)) {
        throw new Error('The provider executable is invalid.');
    }
    if (!Array.isArray(launch.args) || launch.args.length > MAX_LAUNCH_ARGUMENTS
        || launch.args.some(argument => typeof argument !== 'string'
            || Buffer.byteLength(argument, 'utf8') > MAX_LAUNCH_ARGUMENT_BYTES
            || argument.indexOf('\0') !== -1)) {
        throw new Error('A provider launch argument is invalid or too large.');
    }
    if (launch.cwd !== undefined && !isLocalPath(launch.cwd)) {
        throw new Error('The provider launch cwd is invalid.');
    }
    if (launch.markerPath !== undefined && !isLocalPath(launch.markerPath)) {
        throw new Error('The provider marker path is invalid.');
    }
    if (launch.windowsDirectShell !== undefined
        && launch.windowsDirectShell !== 'current' && launch.windowsDirectShell !== 'powershell') {
        throw new Error('The provider launch shell is invalid.');
    }
    const aggregateBytes = [
        identity.cwd,
        launch.executable,
        ...launch.args,
        launch.cwd || '',
        launch.markerPath || '',
    ].reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
    if (aggregateBytes > MAX_AGGREGATE_LAUNCH_BYTES) {
        throw new Error('The provider launch exceeds the aggregate launch budget.');
    }
    if (Buffer.byteLength(serializeTmuxLaunchCommand(launch), 'utf8')
        > MAX_SERIALIZED_TMUX_COMMAND_BYTES) {
        throw new Error('The serialized provider launch exceeds the tmux command budget.');
    }
}

export function isIdentityField(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_FIELD_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

export function isLocalPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_LOCAL_PATH_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

export function isBoundedOptionalLocalPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_LOCAL_PATH_LENGTH
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}
