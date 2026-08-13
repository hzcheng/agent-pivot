'use strict';

import { createHash } from 'crypto';
import type {
    AiSessionDeferredCreateRuntimeRequest,
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    cloneAiSessionRuntimeIdentity,
    getAiSessionRuntimeIdentityV3Fields,
} from './runtimeTypes';
import { getTmuxRuntimeKey } from './tmuxLayout';
import {
    TmuxAmbiguousRuntimeBinding,
    TmuxConsumedPendingBinding,
    TmuxPendingRuntimeBinding,
    TmuxPromotingRuntimeBinding,
} from './tmuxRuntimeBindingStore';

export function pendingIdentity(identity: AiSessionRuntimeIdentity & { pendingId: string }): AiSessionRuntimeIdentity {
    return {
        ...cloneAiSessionRuntimeIdentity(identity),
        pendingId: identity.pendingId,
        sessionId: undefined,
    };
}


export function pendingLifecycleLockKey(identity: AiSessionRuntimeIdentity): string {
    return `pending:${getTmuxRuntimeKey(identity)}`;
}


export function pendingLifecycleIdentityMatches(
    record: TmuxPendingRuntimeBinding | TmuxPromotingRuntimeBinding
        | TmuxConsumedPendingBinding | TmuxAmbiguousRuntimeBinding,
    identity: AiSessionRuntimeIdentity
): boolean {
    return record.pendingId === identity.pendingId && record.provider === identity.provider
        && aiSessionRuntimeIdentitiesEqual({
            ...cloneAiSessionRuntimeIdentity(identity),
            sessionId: undefined,
            pendingId: record.pendingId,
        }, {
            provider: record.provider,
            workspaceScopeIdentity: record.workspaceScopeIdentity,
            workspaceNavigationIdentity: record.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...record.workspaceRootHostPaths],
            ...getAiSessionRuntimeIdentityV3Fields(record as AiSessionRuntimeIdentity),
            cwd: record.cwd,
            pendingId: record.pendingId,
        });
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

export function pendingRequestFingerprint(request: AiSessionDeferredCreateRuntimeRequest): string {
    const digest = createHash('sha256').update(JSON.stringify([
        4,
        request.identity.provider,
        request.identity.workspaceScopeIdentity,
        request.identity.workspaceNavigationIdentity,
        request.identity.workspaceRootHostPaths.slice().sort(),
        (request.identity.writableRootHostPaths
            ?? request.identity.workspaceRootHostPaths).slice().sort(),
        request.identity.worktreeKey ?? null,
        request.identity.pendingId,
        request.identity.cwd,
        request.createdAt,
        request.excludedSessionIds,
        request.title ?? null,
        request.launchMarkerPath,
    ]), 'utf8').digest('hex');
    return `v4:${digest}`;
}

function legacyV3PendingRequestFingerprint(
    request: AiSessionDeferredCreateRuntimeRequest
): string {
    const digest = createHash('sha256').update(JSON.stringify([
        3,
        request.identity.provider,
        request.identity.workspaceScopeIdentity,
        request.identity.workspaceNavigationIdentity,
        request.identity.workspaceRootHostPaths.slice().sort(),
        request.identity.pendingId,
        request.identity.cwd,
        request.createdAt,
        request.excludedSessionIds,
        request.title ?? null,
        request.launchMarkerPath,
    ]), 'utf8').digest('hex');
    return `v3:${digest}`;
}

function identityFromPendingBinding(binding: TmuxPendingRuntimeBinding): AiSessionRuntimeIdentity {
    return {
        provider: binding.provider,
        workspaceScopeIdentity: binding.workspaceScopeIdentity,
        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
        ...getAiSessionRuntimeIdentityV3Fields(binding as AiSessionRuntimeIdentity),
        cwd: binding.cwd,
        pendingId: binding.pendingId,
    };
}

export function pendingSnapshotFromBinding(binding: TmuxPendingRuntimeBinding): AiSessionPendingRuntimeSnapshot {
    return {
        identity: identityFromPendingBinding(binding),
        backend: 'tmux',
        state: 'pending',
        markerPath: '',
        runStartedAtMs: Date.parse(binding.createdAt),
        attached: false,
        tmux: { ...binding.locator },
        createdAt: binding.createdAt,
        excludedSessionIds: [...binding.excludedSessionIds],
        ...(binding.projectName === undefined ? {} : { projectName: binding.projectName }),
        ...(binding.title === undefined ? {} : { title: binding.title }),
    };
}

export function pendingBindingsEqual(left: TmuxPendingRuntimeBinding, right: TmuxPendingRuntimeBinding): boolean {
    return aiSessionRuntimeIdentitiesEqual(
        left as AiSessionRuntimeIdentity,
        right as AiSessionRuntimeIdentity
    )
        && left.createdAt === right.createdAt && left.projectName === right.projectName
        && left.title === right.title
        && left.acceptedAtMs === right.acceptedAtMs && left.layout === right.layout
        && locatorsEqual(left.locator, right.locator)
        && left.excludedSessionIds.length === right.excludedSessionIds.length
        && left.excludedSessionIds.every((value, index) => value === right.excludedSessionIds[index]);
}

export function promotionIntent(
    binding: TmuxPendingRuntimeBinding,
    pending: AiSessionRuntimeSnapshot,
    finalIdentityValue: AiSessionRuntimeIdentity,
    finalSessionName: string,
    finalLocator: AiSessionTmuxLocator,
    recordedAtMs: number,
    version: 2 | 3 = 3
): TmuxPromotingRuntimeBinding {
    if (!finalIdentityValue.sessionId) {
        throw new Error('A promotion intent requires a final session ID.');
    }
    const requestFingerprint = promotionRequestFingerprint(
        binding, pending.markerPath, finalSessionName, finalLocator, version
    );
    return {
        version,
        state: 'promoting',
        pendingId: binding.pendingId,
        provider: binding.provider,
        workspaceScopeIdentity: binding.workspaceScopeIdentity,
        workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
        ...(version === 3
            ? getAiSessionRuntimeIdentityV3Fields(
                binding as TmuxPendingRuntimeBinding & AiSessionRuntimeIdentity
            )
            : {}),
        cwd: binding.cwd,
        createdAt: binding.createdAt,
        markerPath: pending.markerPath,
        pendingBinding: clonePendingBindingForVersion(binding, version),
        finalSessionId: finalIdentityValue.sessionId,
        finalSessionName,
        layout: binding.layout,
        sourceLocator: { ...binding.locator },
        finalLocator: { ...finalLocator },
        requestFingerprint,
        recordedAtMs,
    };
}

function clonePendingBindingForVersion(
    binding: TmuxPendingRuntimeBinding,
    version: 2 | 3
): TmuxPendingRuntimeBinding {
    const clone: TmuxPendingRuntimeBinding = {
        ...binding,
        version,
        workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
        ...(version === 3
            ? getAiSessionRuntimeIdentityV3Fields(binding as AiSessionRuntimeIdentity)
            : {}),
        excludedSessionIds: [...binding.excludedSessionIds],
        locator: { ...binding.locator },
    };
    if (version === 2) {
        delete clone.writableRootHostPaths;
        delete clone.worktreeKey;
    }
    return clone;
}

function promotionRequestFingerprint(
    binding: TmuxPendingRuntimeBinding,
    markerPath: string,
    finalSessionName: string,
    finalLocator: AiSessionTmuxLocator,
    version: 2 | 3
): string {
    return createHash('sha256').update(JSON.stringify([
        version,
        binding.provider,
        binding.workspaceScopeIdentity,
        binding.workspaceNavigationIdentity,
        binding.workspaceRootHostPaths.slice().sort(),
        ...(version === 3 ? [
            (binding.writableRootHostPaths ?? binding.workspaceRootHostPaths).slice().sort(),
            binding.worktreeKey ?? null,
        ] : []),
        binding.pendingId,
        binding.cwd,
        binding.createdAt,
        binding.excludedSessionIds,
        binding.title ?? null,
        binding.acceptedAtMs,
        binding.layout,
        binding.locator,
        markerPath,
        finalSessionName,
        finalLocator,
    ]), 'utf8').digest('hex');
}

export function promotionIntentMatchesLiveBinding(
    intent: TmuxPromotingRuntimeBinding,
    binding: TmuxPendingRuntimeBinding
): boolean {
    return pendingBindingsEqual(intent.pendingBinding, binding)
        && intent.requestFingerprint === promotionRequestFingerprint(
            binding, intent.markerPath, intent.finalSessionName, intent.finalLocator,
            intent.version
        );
}

export function promotionIntentsMatch(
    left: TmuxPromotingRuntimeBinding,
    right: TmuxPromotingRuntimeBinding
): boolean {
    return aiSessionRuntimeIdentitiesEqual(
        left as AiSessionRuntimeIdentity,
        right as AiSessionRuntimeIdentity
    )
        && left.createdAt === right.createdAt && left.markerPath === right.markerPath
        && pendingBindingsEqual(left.pendingBinding, right.pendingBinding)
        && left.finalSessionId === right.finalSessionId
        && left.finalSessionName === right.finalSessionName && left.layout === right.layout
        && locatorsEqual(left.sourceLocator, right.sourceLocator)
        && locatorsEqual(left.finalLocator, right.finalLocator)
        && left.requestFingerprint === right.requestFingerprint;
}

export function consumedMatchesPromotionIntent(
    consumed: TmuxConsumedPendingBinding,
    intent: TmuxPromotingRuntimeBinding
): boolean {
    return consumed.finalSessionName !== undefined
        && pendingLifecycleIdentityMatches(consumed, intent)
        && consumed.finalSessionId === intent.finalSessionId
        && consumed.finalSessionName === intent.finalSessionName
        && consumed.layout === intent.layout
        && locatorsEqual(consumed.finalLocator, intent.finalLocator);
}

export type PendingAmbiguousRuntimeBinding = TmuxAmbiguousRuntimeBinding & {
    pendingId: string;
    sessionId?: never;
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
    title?: string;
    markerPath?: string;
    requestFingerprint: string;
};

export function pendingAmbiguityMatches(
    ambiguous: PendingAmbiguousRuntimeBinding,
    request: AiSessionDeferredCreateRuntimeRequest,
    binding: TmuxPendingRuntimeBinding,
    locator: AiSessionTmuxLocator
): boolean {
    return aiSessionRuntimeIdentitiesEqual(
        ambiguous as AiSessionRuntimeIdentity,
        binding as AiSessionRuntimeIdentity
    )
        && ambiguous.pendingId === binding.pendingId
        && ambiguous.createdAt === binding.createdAt
        && ambiguous.title === binding.title
        && (ambiguous.markerPath || '') === request.launchMarkerPath
        && ambiguous.layout === binding.layout
        && locatorsEqual(ambiguous.locator, locator)
        && ambiguous.excludedSessionIds.length === binding.excludedSessionIds.length
        && ambiguous.excludedSessionIds.every((value, index) => value === binding.excludedSessionIds[index])
        && (isLegacyPendingRequestFingerprint(ambiguous.requestFingerprint)
            || ambiguous.requestFingerprint === legacyV3PendingRequestFingerprint(request)
            || ambiguous.requestFingerprint === pendingRequestFingerprint(request));
}

function isLegacyPendingRequestFingerprint(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
}

export function consumedPendingError(record: TmuxConsumedPendingBinding): Error {
    return new Error(`The pending tmux runtime was already consumed by session ${record.finalSessionId}.`);
}
