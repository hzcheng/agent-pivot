'use strict';

import { createHash } from 'crypto';
import * as path from 'path';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionRuntimeIdentity,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    cloneAiSessionRuntimeIdentity,
    getAiSessionRuntimeRootSnapshotKey,
    isValidAiSessionPromotionDisplayName,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';

interface TmuxRuntimeBindingIdentity {
    version: 2 | 3;
    provider: AiSessionProviderId;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    writableRootHostPaths?: string[];
    worktreeKey?: AiSessionRuntimeIdentity['worktreeKey'];
    cwd: string;
}

export interface TmuxPendingRuntimeBinding extends TmuxRuntimeBindingIdentity {
    state: 'pending';
    pendingId: string;
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
    title?: string;
    acceptedAtMs: number;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
}

export interface TmuxKnownRuntimeBinding extends TmuxRuntimeBindingIdentity {
    state: 'known';
    sessionId: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    lastSeenAtMs: number;
    markerPath?: string;
    runStartedAtMs?: number;
}

export interface TmuxInactiveRuntimeBinding extends TmuxRuntimeBindingIdentity {
    state: 'completed' | 'stopped';
    sessionId: string;
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    markerPath: string;
    runStartedAtMs: number;
    detectedAtMs: number;
}

export type TmuxInactiveAcknowledgementResult = 'acknowledged' | 'stale' | 'missing';
export type TmuxKnownRebindResult = 'rebound' | 'stale' | 'missing';

export interface TmuxFinalBindingSnapshot {
    pending: TmuxPendingRuntimeBinding[];
    known: TmuxKnownRuntimeBinding[];
    inactive: TmuxInactiveRuntimeBinding[];
}

export interface TmuxKnownRebindIntent {
    version: 1;
    state: 'rebind-known';
    expected: TmuxKnownRuntimeBinding;
    replacement: TmuxKnownRuntimeBinding;
    recordedAtMs: number;
}

export interface TmuxConsumedPendingBinding extends TmuxRuntimeBindingIdentity {
    state: 'consumed';
    pendingId: string;
    finalSessionId: string;
    finalSessionName?: string;
    layout: AiSessionTmuxLayout;
    finalLocator: AiSessionTmuxLocator;
    consumedAtMs: number;
}

export interface TmuxPromotingRuntimeBinding extends TmuxRuntimeBindingIdentity {
    state: 'promoting';
    pendingId: string;
    createdAt: string;
    markerPath: string;
    pendingBinding: TmuxPendingRuntimeBinding;
    finalSessionId: string;
    finalSessionName: string;
    layout: AiSessionTmuxLayout;
    sourceLocator: AiSessionTmuxLocator;
    finalLocator: AiSessionTmuxLocator;
    requestFingerprint: string;
    recordedAtMs: number;
}

export interface TmuxRecoverablePendingBinding {
    pendingBinding: TmuxPendingRuntimeBinding;
    promotionRecoveryDisplayName: string;
    recoverySessionId: string;
}

export interface TmuxAmbiguousRuntimeBindingBase extends TmuxRuntimeBindingIdentity {
    state: 'ambiguous';
    layout: AiSessionTmuxLayout;
    locator: AiSessionTmuxLocator;
    acceptedAtMs: number;
}

export type TmuxAmbiguousRuntimeBinding = TmuxAmbiguousRuntimeBindingBase & (
    { sessionId: string; pendingId?: never }
    | {
        pendingId: string;
        sessionId?: never;
        cwd: string;
        createdAt: string;
        excludedSessionIds: string[];
        projectName?: string;
        title?: string;
        markerPath?: string;
        requestFingerprint: string;
    }
);

export type TmuxFinalRuntimeBinding = TmuxKnownRuntimeBinding | TmuxInactiveRuntimeBinding;

export type TmuxRuntimeBinding = TmuxPendingRuntimeBinding | TmuxFinalRuntimeBinding
    | TmuxAmbiguousRuntimeBinding | TmuxConsumedPendingBinding | TmuxPromotingRuntimeBinding
    | TmuxKnownRebindIntent;

export type TmuxFinalRecordLock = <T>(operation: () => Promise<T>) => Promise<T>;

const LEGACY_RECORD_VERSION = 2;
const RECORD_VERSION = 3;
const RECORD_FILENAME_VERSION = 2;
export const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const MAX_EXCLUDED_SESSION_IDS = 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isCanonicalRecordPath(filePath: string, record: TmuxRuntimeBinding): boolean {
    if (record.state === 'rebind-known') {
        return false;
    }
    let identity: string[];
    if (record.state === 'pending') {
        identity = pendingRecordIdentityParts(record);
    } else if (record.state === 'known' || record.state === 'completed' || record.state === 'stopped') {
        identity = [record.provider, record.workspaceScopeIdentity, record.sessionId];
    } else if (record.state === 'consumed' || record.state === 'promoting') {
        identity = pendingRecordIdentityParts(record);
    } else {
        identity = ambiguousRecordIdentityParts(record as TmuxAmbiguousRuntimeBinding);
    }
    const canonicalState = record.state === 'completed' || record.state === 'stopped'
        ? 'known' : record.state;
    return path.basename(filePath) === getRecordFilename(canonicalState, ...identity);
}

export function getRecordFilename(
    kind: 'pending' | 'known' | 'ambiguous' | 'consumed' | 'promoting' | 'rebind',
    ...identity: string[]
): string {
    const digest = createHash('sha256')
        .update(JSON.stringify([RECORD_FILENAME_VERSION, kind, ...identity]), 'utf8')
        .digest('hex');
    return `${kind}-${digest}.json`;
}

function validatePendingRecord(value: unknown): TmuxPendingRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    const identity = validateBindingIdentity(record, { pendingId: record.pendingId });
    if (!hasBindingExactKeys(record, [
        'version', 'state', 'pendingId', 'provider', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'createdAt',
        'excludedSessionIds', 'acceptedAtMs', 'layout', 'locator',
    ], ['projectName', 'title'])
        || !isRecordVersion(record.version) || record.state !== 'pending'
        || !identity
        || !isDateString(record.createdAt) || !isLayout(record.layout) || !locator
        || locator.layout !== record.layout || !Array.isArray(record.excludedSessionIds)
        || record.excludedSessionIds.length > MAX_EXCLUDED_SESSION_IDS
        || record.excludedSessionIds.some(id => !isBoundedString(id, MAX_ID_LENGTH))
        || !isFiniteNonNegative(record.acceptedAtMs)
        || (record.projectName !== undefined && !isOptionalTitle(record.projectName))
        || (record.title !== undefined && !isOptionalTitle(record.title))) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: 'pending',
        pendingId: identity.pendingId as string,
        ...bindingIdentityFields(identity),
        createdAt: record.createdAt,
        excludedSessionIds: [...record.excludedSessionIds] as string[],
        ...(record.projectName === undefined ? {} : { projectName: record.projectName as string }),
        ...(record.title === undefined ? {} : { title: record.title as string }),
        acceptedAtMs: record.acceptedAtMs,
        layout: record.layout,
        locator,
    };
}

export function validateTmuxPendingRuntimeBinding(
    value: unknown,
    nowMs: number = Date.now()
): TmuxPendingRuntimeBinding | null {
    const record = validatePersistedPendingRecord(value, nowMs);
    const createdAtMs = record ? Date.parse(record.createdAt) : NaN;
    return record && nowMs - createdAtMs < PENDING_TTL_MS
        ? record
        : null;
}

export function validatePersistedPendingRecord(
    value: unknown,
    nowMs: number
): TmuxPendingRuntimeBinding | null {
    const record = validatePendingRecord(value);
    const createdAtMs = record ? Date.parse(record.createdAt) : NaN;
    return record && Number.isFinite(nowMs) && createdAtMs <= nowMs + MAX_FUTURE_SKEW_MS
        && record.acceptedAtMs <= nowMs + MAX_FUTURE_SKEW_MS
        && !isPendingExpired(record, nowMs)
        ? record
        : null;
}

export function validateConsumedRecord(
    value: unknown,
    requireFinalSessionName: boolean = false
): TmuxConsumedPendingBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.finalLocator);
    const identity = validateBindingIdentity(record, { pendingId: record.pendingId });
    const legacyKeys = [
        'version', 'state', 'pendingId', 'provider', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'finalSessionId',
        'layout', 'finalLocator', 'consumedAtMs',
    ];
    const hasFinalSessionName = Object.prototype.hasOwnProperty.call(record, 'finalSessionName');
    if (!(hasBindingExactKeys(record, [...legacyKeys, 'finalSessionName'])
            || (!requireFinalSessionName && hasBindingExactKeys(record, legacyKeys)))
        || !isRecordVersion(record.version) || record.state !== 'consumed'
        || !identity
        || !isBoundedString(record.finalSessionId, MAX_ID_LENGTH)
        || (hasFinalSessionName && !isRequiredDisplayName(record.finalSessionName))
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.consumedAtMs)) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: 'consumed',
        pendingId: identity.pendingId as string,
        ...bindingIdentityFields(identity),
        finalSessionId: record.finalSessionId,
        ...(hasFinalSessionName ? { finalSessionName: record.finalSessionName as string } : {}),
        layout: record.layout,
        finalLocator: locator,
        consumedAtMs: record.consumedAtMs,
    };
}

export function isLegacyProjectKeyConsumedRecord(value: unknown): boolean {
    if (!isObject(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.finalLocator);
    return hasExactKeys(record, [
        'version', 'state', 'pendingId', 'provider', 'projectKey', 'cwd',
        'finalSessionId', 'layout', 'finalLocator', 'consumedAtMs',
    ])
        && record.version === 1
        && record.state === 'consumed'
        && isBoundedString(record.pendingId, MAX_ID_LENGTH)
        && isProviderId(record.provider)
        && isBoundedString(record.projectKey, MAX_ID_LENGTH)
        && isBoundedString(record.cwd, MAX_PATH_LENGTH)
        && isBoundedString(record.finalSessionId, MAX_ID_LENGTH)
        && isLayout(record.layout)
        && !!locator && locator.layout === record.layout
        && isFiniteNonNegative(record.consumedAtMs);
}

export function validatePromotingRecord(value: unknown): TmuxPromotingRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const sourceLocator = validateLocator(record.sourceLocator);
    const finalLocator = validateLocator(record.finalLocator);
    const pendingBinding = validatePendingRecord(record.pendingBinding);
    const identity = validateBindingIdentity(record, { pendingId: record.pendingId });
    if (!hasBindingExactKeys(record, [
        'version', 'state', 'pendingId', 'provider', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'createdAt',
        'markerPath', 'pendingBinding', 'finalSessionId', 'layout', 'sourceLocator',
        'finalSessionName', 'finalLocator', 'requestFingerprint', 'recordedAtMs',
    ]) || !isRecordVersion(record.version) || record.state !== 'promoting'
        || !identity
        || !isDateString(record.createdAt)
        || (record.markerPath !== '' && !isBoundedString(record.markerPath, MAX_PATH_LENGTH))
        || !isBoundedString(record.finalSessionId, MAX_ID_LENGTH)
        || !isRequiredDisplayName(record.finalSessionName) || !isLayout(record.layout)
        || !sourceLocator || sourceLocator.layout !== record.layout
        || !finalLocator || finalLocator.layout !== record.layout
        || (record.layout === 'project' && sourceLocator.sessionName !== finalLocator.sessionName)
        || locatorsEqual(sourceLocator, finalLocator)
        || !pendingBinding || pendingBinding.pendingId !== record.pendingId
        || !bindingIdentitiesEqual(pendingBinding, identity)
        || pendingBinding.createdAt !== record.createdAt
        || pendingBinding.layout !== record.layout || !locatorsEqual(pendingBinding.locator, sourceLocator)
        || typeof record.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestFingerprint)
        || !isFiniteNonNegative(record.recordedAtMs)) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: 'promoting',
        pendingId: identity.pendingId as string,
        ...bindingIdentityFields(identity),
        createdAt: record.createdAt,
        markerPath: record.markerPath,
        pendingBinding,
        finalSessionId: record.finalSessionId,
        finalSessionName: record.finalSessionName,
        layout: record.layout,
        sourceLocator,
        finalLocator,
        requestFingerprint: record.requestFingerprint,
        recordedAtMs: record.recordedAtMs,
    };
}

export function validateAmbiguousRecord(value: unknown): TmuxAmbiguousRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    const hasSessionId = record.sessionId !== undefined;
    const hasPendingId = record.pendingId !== undefined;
    const exactKeys = hasSessionId
        ? hasBindingExactKeys(record, [
            'version', 'state', 'provider', 'workspaceScopeIdentity',
            'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'layout',
            'locator', 'acceptedAtMs', 'sessionId',
        ])
        : hasBindingExactKeys(record, [
            'version', 'state', 'provider', 'workspaceScopeIdentity',
            'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'layout',
            'locator', 'acceptedAtMs', 'pendingId', 'createdAt', 'excludedSessionIds',
            'requestFingerprint',
        ], ['projectName', 'title', 'markerPath']);
    const identity = hasSessionId === hasPendingId ? null : validateBindingIdentity(record,
        hasSessionId ? { sessionId: record.sessionId } : { pendingId: record.pendingId });
    if (!exactKeys || !isRecordVersion(record.version) || record.state !== 'ambiguous'
        || !identity
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.acceptedAtMs)
        || (hasPendingId && (!isDateString(record.createdAt) || !Array.isArray(record.excludedSessionIds)
            || record.excludedSessionIds.length > MAX_EXCLUDED_SESSION_IDS
            || record.excludedSessionIds.some(id => !isBoundedString(id, MAX_ID_LENGTH))
            || (record.projectName !== undefined && !isOptionalTitle(record.projectName))
            || (record.title !== undefined && !isOptionalTitle(record.title))
            || (record.markerPath !== undefined
                && !isBoundedString(record.markerPath, MAX_PATH_LENGTH))
            || typeof record.requestFingerprint !== 'string'
            || !/^(?:(?:v3|v4):)?[a-f0-9]{64}$/.test(record.requestFingerprint)))) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: 'ambiguous',
        ...bindingIdentityFields(identity),
        ...(hasSessionId
            ? { sessionId: record.sessionId as string }
            : {
                pendingId: record.pendingId as string,
                cwd: record.cwd as string,
                createdAt: record.createdAt as string,
                excludedSessionIds: [...record.excludedSessionIds as string[]],
                ...(record.projectName === undefined ? {} : { projectName: record.projectName as string }),
                ...(record.title === undefined ? {} : { title: record.title as string }),
                ...(record.markerPath === undefined ? {} : { markerPath: record.markerPath as string }),
                requestFingerprint: record.requestFingerprint as string,
            }),
        layout: record.layout,
        locator,
        acceptedAtMs: record.acceptedAtMs,
    } as TmuxAmbiguousRuntimeBinding;
}

export function validateKnownRecord(value: unknown): TmuxKnownRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    const identity = validateBindingIdentity(record, { sessionId: record.sessionId });
    const lifecycleFieldCount = [record.markerPath, record.runStartedAtMs]
        .filter(field => field !== undefined).length;
    if (!hasBindingExactKeys(record, [
        'version', 'state', 'provider', 'sessionId', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'layout',
        'locator', 'lastSeenAtMs',
    ], ['markerPath', 'runStartedAtMs'])
        || !isRecordVersion(record.version) || record.state !== 'known'
        || !identity
        || !isLayout(record.layout) || !locator || locator.layout !== record.layout
        || !isFiniteNonNegative(record.lastSeenAtMs)
        || (lifecycleFieldCount !== 0 && lifecycleFieldCount !== 2)
        || (lifecycleFieldCount === 2 && (!isBoundedPath(record.markerPath)
            || !isFinitePositive(record.runStartedAtMs)))) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: 'known',
        sessionId: identity.sessionId as string,
        ...bindingIdentityFields(identity),
        layout: record.layout,
        locator,
        lastSeenAtMs: record.lastSeenAtMs,
        ...(lifecycleFieldCount === 2 ? {
            markerPath: record.markerPath as string,
            runStartedAtMs: record.runStartedAtMs as number,
        } : {}),
    };
}

export function validateKnownRebindIntent(value: unknown): TmuxKnownRebindIntent | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const expected = validateKnownRecord(record.expected);
    const replacement = validateKnownRecord(record.replacement);
    if (!hasExactKeys(record, [
        'version', 'state', 'expected', 'replacement', 'recordedAtMs',
    ]) || record.version !== 1 || record.state !== 'rebind-known'
        || !expected || !replacement
        || expected.sessionId === replacement.sessionId
        || !knownBindingsEqualExceptSessionId(expected, replacement)
        || !isFiniteNonNegative(record.recordedAtMs)) {
        return null;
    }
    return {
        version: 1,
        state: 'rebind-known',
        expected: cloneKnown(expected),
        replacement: cloneKnown(replacement),
        recordedAtMs: record.recordedAtMs as number,
    };
}

export function validateInactiveRecord(
    value: unknown,
    nowMs: number = Date.now()
): TmuxInactiveRuntimeBinding | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const locator = validateLocator(record.locator);
    const identity = validateBindingIdentity(record, { sessionId: record.sessionId });
    if (!hasBindingExactKeys(record, [
        'version', 'state', 'provider', 'sessionId', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'layout',
        'locator', 'markerPath', 'runStartedAtMs', 'detectedAtMs',
    ]) || !isRecordVersion(record.version)
        || (record.state !== 'completed' && record.state !== 'stopped')
        || !identity || !isLayout(record.layout)
        || !locator || locator.layout !== record.layout
        || !isBoundedPath(record.markerPath)
        || !isFinitePositive(record.runStartedAtMs)
        || !isFinitePositive(record.detectedAtMs)
        || !Number.isFinite(nowMs) || record.detectedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
        return null;
    }
    return {
        version: record.version as 2 | 3,
        state: record.state,
        sessionId: identity.sessionId as string,
        ...bindingIdentityFields(identity),
        layout: record.layout,
        locator,
        markerPath: record.markerPath,
        runStartedAtMs: record.runStartedAtMs,
        detectedAtMs: record.detectedAtMs,
    };
}

export function validateFinalRuntimeRecord(
    value: unknown,
    nowMs: number = Date.now()
): TmuxFinalRuntimeBinding | null {
    return validateKnownRecord(value) || validateInactiveRecord(value, nowMs);
}

function validateLocator(value: unknown): AiSessionTmuxLocator | null {
    if (!isObject(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const hasValidKeys = record.layout === 'project'
        ? hasExactKeys(record, ['layout', 'sessionName', 'windowName'])
        : hasExactKeys(record, ['layout', 'sessionName'])
            || hasExactKeys(record, ['layout', 'sessionName', 'windowName']);
    if (!isLayout(record.layout) || !isBoundedString(record.sessionName, MAX_ID_LENGTH)
        || !hasValidKeys) {
        return null;
    }
    if (record.layout === 'project') {
        return isBoundedString(record.windowName, MAX_ID_LENGTH)
            ? { layout: 'project', sessionName: record.sessionName, windowName: record.windowName }
            : null;
    }
    return hasExactKeys(record, ['layout', 'sessionName'])
        ? { layout: 'session', sessionName: record.sessionName }
        : isBoundedString(record.windowName, MAX_ID_LENGTH)
            ? { layout: 'session', sessionName: record.sessionName, windowName: record.windowName }
            : null;
}

function hasExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && Object.keys(record).every(key => allowed.has(key));
}

function hasBindingExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    if (!isRecordVersion(record.version)) {
        return false;
    }
    return record.version === RECORD_VERSION
        ? hasExactKeys(record, [...required, 'writableRootHostPaths'], [
            ...optional, 'worktreeKey',
        ])
        : hasExactKeys(record, required, optional);
}

function isRecordVersion(value: unknown): value is 2 | 3 {
    return value === LEGACY_RECORD_VERSION || value === RECORD_VERSION;
}

export function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

export function pendingLifecycleRecordKey(record: {
    provider: AiSessionProviderId;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    pendingId: string;
}): string {
    return JSON.stringify(pendingRecordIdentityParts(record));
}

export function pendingBindingsEqual(
    left: TmuxPendingRuntimeBinding,
    right: TmuxPendingRuntimeBinding
): boolean {
    return pendingLifecycleRecordKey(left) === pendingLifecycleRecordKey(right)
        && left.createdAt === right.createdAt
        && left.acceptedAtMs === right.acceptedAtMs
        && left.projectName === right.projectName
        && left.title === right.title
        && left.layout === right.layout
        && locatorsEqual(left.locator, right.locator)
        && left.excludedSessionIds.length === right.excludedSessionIds.length
        && left.excludedSessionIds.every((value, index) => value === right.excludedSessionIds[index]);
}

export function consumedMatchesPromoting(
    consumed: TmuxConsumedPendingBinding,
    promoting: TmuxPromotingRuntimeBinding
): boolean {
    return consumed.finalSessionName !== undefined
        && consumed.finalSessionId === promoting.finalSessionId
        && consumed.finalSessionName === promoting.finalSessionName
        && consumed.layout === promoting.layout
        && locatorsEqual(consumed.finalLocator, promoting.finalLocator);
}

export function inactiveBindingsMatchRun(
    left: TmuxInactiveRuntimeBinding,
    right: TmuxInactiveRuntimeBinding
): boolean {
    return bindingIdentitiesEqual(left, right)
        && left.layout === right.layout && locatorsEqual(left.locator, right.locator)
        && left.markerPath === right.markerPath
        && left.runStartedAtMs === right.runStartedAtMs;
}

export function inactiveBindingsEqual(
    left: TmuxInactiveRuntimeBinding,
    right: TmuxInactiveRuntimeBinding
): boolean {
    return inactiveBindingsMatchRun(left, right)
        && left.state === right.state
        && left.detectedAtMs === right.detectedAtMs;
}

export function knownBindingsEqual(
    left: TmuxKnownRuntimeBinding,
    right: TmuxKnownRuntimeBinding
): boolean {
    return left.sessionId === right.sessionId
        && knownBindingsEqualExceptSessionId(left, right);
}

function knownBindingsEqualExceptSessionId(
    left: TmuxKnownRuntimeBinding,
    right: TmuxKnownRuntimeBinding
): boolean {
    return bindingIdentitiesEqual(left, right)
        && left.layout === right.layout
        && locatorsEqual(left.locator, right.locator)
        && left.lastSeenAtMs === right.lastSeenAtMs
        && left.markerPath === right.markerPath
        && left.runStartedAtMs === right.runStartedAtMs;
}

export function clonePending(record: TmuxPendingRuntimeBinding): TmuxPendingRuntimeBinding {
    return {
        ...record,
        ...cloneBindingIdentityFields(record),
        excludedSessionIds: [...record.excludedSessionIds],
        locator: { ...record.locator },
    };
}

export function cloneKnown(record: TmuxKnownRuntimeBinding): TmuxKnownRuntimeBinding {
    return { ...record, ...cloneBindingIdentityFields(record), locator: { ...record.locator } };
}

export function cloneInactive(record: TmuxInactiveRuntimeBinding): TmuxInactiveRuntimeBinding {
    return { ...record, ...cloneBindingIdentityFields(record), locator: { ...record.locator } };
}

export function cloneAmbiguous(record: TmuxAmbiguousRuntimeBinding): TmuxAmbiguousRuntimeBinding {
    if (record.sessionId !== undefined) {
        return { ...record, ...cloneBindingIdentityFields(record), locator: { ...record.locator } };
    }
    const pendingRecord = record as TmuxAmbiguousRuntimeBindingBase & {
        pendingId: string;
        cwd: string;
        createdAt: string;
        excludedSessionIds: string[];
        projectName?: string;
        title?: string;
        markerPath?: string;
        requestFingerprint: string;
    };
    return {
        ...pendingRecord,
        ...cloneBindingIdentityFields(pendingRecord),
        locator: { ...pendingRecord.locator },
        excludedSessionIds: [...pendingRecord.excludedSessionIds],
    };
}

export function cloneConsumed(record: TmuxConsumedPendingBinding): TmuxConsumedPendingBinding {
    return { ...record, ...cloneBindingIdentityFields(record), finalLocator: { ...record.finalLocator } };
}

export function clonePromoting(record: TmuxPromotingRuntimeBinding): TmuxPromotingRuntimeBinding {
    return {
        ...record,
        ...cloneBindingIdentityFields(record),
        sourceLocator: { ...record.sourceLocator },
        finalLocator: { ...record.finalLocator },
        pendingBinding: clonePending(record.pendingBinding),
    };
}

export function consumedRecordMatchesIdentity(
    record: TmuxConsumedPendingBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && bindingIdentitiesEqual(record, identity);
}

export function pendingRecordMatchesIdentity(
    record: TmuxPendingRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && bindingIdentitiesEqual(record, identity);
}

export function pendingIdentityParts(identity: AiSessionRuntimeIdentity): string[] | null {
    return identity && identity.sessionId === undefined && isValidAiSessionRuntimeIdentity(identity)
        ? [
            identity.provider,
            identity.workspaceScopeIdentity,
            identity.workspaceNavigationIdentity,
            getAiSessionRuntimeRootSnapshotKey(identity),
            identity.cwd,
            identity.pendingId as string,
        ]
        : null;
}

export function pendingRecordIdentityParts(record: {
    provider: AiSessionProviderId;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    pendingId: string;
}): string[] {
    return [
        record.provider,
        record.workspaceScopeIdentity,
        record.workspaceNavigationIdentity,
        getAiSessionRuntimeRootSnapshotKey(record as AiSessionRuntimeIdentity),
        record.cwd,
        record.pendingId,
    ];
}

export function promotingRecordMatchesIdentity(
    record: TmuxPromotingRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && bindingIdentitiesEqual(record, identity);
}

export function ambiguousIdentityParts(identity: AiSessionRuntimeIdentity): string[] | null {
    if (!isValidAiSessionRuntimeIdentity(identity)) {
        return null;
    }
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if (hasSessionId === hasPendingId) {
        return null;
    }
    const id = hasSessionId ? identity.sessionId : identity.pendingId;
    if (!isBoundedString(id, MAX_ID_LENGTH)) {
        return null;
    }
    return hasSessionId
        ? [identity.provider, identity.workspaceScopeIdentity, 'session', id]
        : [
            identity.provider,
            identity.workspaceScopeIdentity,
            'pending',
            identity.workspaceNavigationIdentity,
            getAiSessionRuntimeRootSnapshotKey(identity),
            identity.cwd,
            id,
        ];
}

export function ambiguousRecordIdentityParts(record: TmuxAmbiguousRuntimeBinding): string[] {
    return record.sessionId !== undefined ? [
        record.provider,
        record.workspaceScopeIdentity,
        'session',
        record.sessionId,
    ] : [
        record.provider,
        record.workspaceScopeIdentity,
        'pending',
        record.workspaceNavigationIdentity,
        getAiSessionRuntimeRootSnapshotKey(record as AiSessionRuntimeIdentity),
        record.cwd,
        record.pendingId,
    ];
}

export function ambiguousRecordMatchesIdentity(
    record: TmuxAmbiguousRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.provider === identity.provider
        && bindingIdentitiesEqual(record, identity)
        && record.sessionId === identity.sessionId
        && record.pendingId === identity.pendingId;
}

function validateBindingIdentity(
    record: Record<string, unknown>,
    id: { sessionId: unknown } | { pendingId: unknown }
): AiSessionRuntimeIdentity | null {
    const identity = {
        provider: record.provider,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths: record.workspaceRootHostPaths,
        ...(record.writableRootHostPaths !== undefined
            ? { writableRootHostPaths: record.writableRootHostPaths }
            : {}),
        ...(record.worktreeKey !== undefined ? { worktreeKey: record.worktreeKey } : {}),
        cwd: record.cwd,
        ...id,
    };
    return isValidAiSessionRuntimeIdentity(identity)
        ? cloneAiSessionRuntimeIdentity(identity)
        : null;
}

function bindingIdentityFields(identity: AiSessionRuntimeIdentity) {
    return {
        provider: identity.provider,
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
        ...(identity.writableRootHostPaths
            ? { writableRootHostPaths: [...identity.writableRootHostPaths] }
            : {}),
        ...(identity.worktreeKey ? { worktreeKey: { ...identity.worktreeKey } } : {}),
        cwd: identity.cwd,
    };
}

function cloneBindingIdentityFields(identity: TmuxRuntimeBindingIdentity) {
    return {
        workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
        ...(identity.writableRootHostPaths
            ? { writableRootHostPaths: [...identity.writableRootHostPaths] }
            : {}),
        ...(identity.worktreeKey ? { worktreeKey: { ...identity.worktreeKey } } : {}),
    };
}

export function bindingIdentitiesEqual(
    left: {
        provider: AiSessionProviderId;
        workspaceScopeIdentity: string;
        workspaceNavigationIdentity: string;
        workspaceRootHostPaths: string[];
        cwd: string;
    },
    right: {
        provider: AiSessionProviderId;
        workspaceScopeIdentity: string;
        workspaceNavigationIdentity: string;
        workspaceRootHostPaths: string[];
        cwd: string;
    }
): boolean {
    return aiSessionRuntimeIdentitiesEqual(
        { ...left, sessionId: 'identity-comparison' } as AiSessionRuntimeIdentity,
        { ...right, sessionId: 'identity-comparison' } as AiSessionRuntimeIdentity
    );
}

function isPendingExpired(record: TmuxPendingRuntimeBinding, now: number): boolean {
    return now - record.acceptedAtMs >= PENDING_TTL_MS;
}

export function isKnownExpired(record: TmuxKnownRuntimeBinding, now: number): boolean {
    return now - record.lastSeenAtMs >= KNOWN_TTL_MS;
}

export function isInactiveExpired(record: TmuxInactiveRuntimeBinding, now: number): boolean {
    return now - record.detectedAtMs >= KNOWN_TTL_MS;
}

export function isFinalRuntimeExpired(record: TmuxFinalRuntimeBinding, now: number): boolean {
    return record.state === 'known' ? isKnownExpired(record, now) : isInactiveExpired(record, now);
}

export function finalRuntimePriority(record: TmuxFinalRuntimeBinding): number {
    return record.state === 'completed' ? 0 : record.state === 'known' ? 1 : 2;
}

export function finalRuntimeTimestamp(record: TmuxFinalRuntimeBinding): number {
    return record.state === 'known' ? record.lastSeenAtMs : record.detectedAtMs;
}

function isObject(value: unknown): value is object {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isProviderId(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isLayout(value: unknown): value is AiSessionTmuxLayout {
    return value === 'project' || value === 'session';
}

export function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}

function isOptionalTitle(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_TITLE_LENGTH && !CONTROL_CHARACTERS.test(value);
}

function isRequiredDisplayName(value: unknown): value is string {
    return isValidAiSessionPromotionDisplayName(value);
}

function isDateString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TITLE_LENGTH
        && Number.isFinite(Date.parse(value));
}

export function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isBoundedPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_PATH_LENGTH
        && !CONTROL_CHARACTERS.test(value);
}

export function isNodeError(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
