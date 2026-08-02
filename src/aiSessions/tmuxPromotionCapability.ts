'use strict';

import type {
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionPromotionDisplayName,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';
import { getTmuxRuntimeKey } from './tmuxLayout';
import {
    fullMetadata,
    projectSessionMetadata,
    sessionWindowMetadata,
    verifyPendingMetadata,
    writeFinalMetadata,
} from './tmuxManagedMetadata';
import type { TmuxClient } from './tmuxClient';
import { buildReadableTmuxLocator } from './tmuxNaming';
import {
    pendingBindingsEqual,
    pendingIdentity,
    pendingLifecycleIdentityMatches,
    pendingLifecycleLockKey,
    pendingSnapshotFromBinding,
    promotionIntent,
    promotionIntentMatchesLiveBinding,
    promotionIntentsMatch,
} from './tmuxPendingLifecycle';
import type { TmuxPromotingRuntimeBinding, TmuxRuntimeBindingStore } from './tmuxRuntimeBindingStore';
import type { TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';
import { isIdentityField } from './tmuxRuntimeRequest';

const SESSION_WINDOW = 'ai-session';

export interface TmuxPromotionCapabilityOptions<TTerminal> {
    client: TmuxClient;
    discovery: TmuxRuntimeDiscovery;
    runtimeStore: TmuxRuntimeBindingStore;
    withCreationLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
    nowMs: () => number;
    requireAvailable: () => Promise<void>;
    findVerified: (
        identity: AiSessionRuntimeIdentity,
        requiredLocator?: AiSessionTmuxLocator
    ) => AiSessionRuntimeSnapshot | undefined;
    throwIfCollision: (identity: AiSessionRuntimeIdentity) => void;
    locatorIsOccupied: (locator: AiSessionTmuxLocator) => Promise<boolean>;
    migrateAttach: (
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot
    ) => Promise<void>;
    withAttach: (runtime: AiSessionRuntimeSnapshot) => AiSessionRuntimeSnapshot<TTerminal>;
    persistKnown: (
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lifecycle?: Pick<AiSessionRuntimeSnapshot, 'identity' | 'markerPath' | 'runStartedAtMs'>
    ) => Promise<void>;
}

export interface TmuxPromotionCapability<TTerminal> {
    promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
    promotionTransitionMatches(
        intent: TmuxPromotingRuntimeBinding,
        finalIdentityValue: AiSessionRuntimeIdentity
    ): Promise<boolean>;
}

/**
 * Owns the tmux pending-to-final promotion state machine: the durable intent
 * lifecycle (promoting/consumed records), the ordered rename + metadata
 * transition, and the conflict/ambiguity outcomes. Extracted from
 * TmuxRuntimeBackend; the lock nesting (pending lifecycle key, then final
 * runtime key), the six forced discovery refreshes, and the cleanup order
 * (migrate attach, remove pending, refresh, remove promoting) are unchanged.
 */
export function createTmuxPromotionCapability<TTerminal>(
    options: TmuxPromotionCapabilityOptions<TTerminal>
): TmuxPromotionCapability<TTerminal> {
    const client = options.client;
    const discovery = options.discovery;
    const runtimeStore = options.runtimeStore;
    const withCreationLock = options.withCreationLock;
    const nowMs = options.nowMs;
    const requireAvailable = options.requireAvailable;
    const findVerified = options.findVerified;
    const throwIfCollision = options.throwIfCollision;
    const locatorIsOccupied = options.locatorIsOccupied;
    const migrateAttach = options.migrateAttach;
    const withAttach = options.withAttach;
    const persistKnown = options.persistKnown;

    async function promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        const pendingIdentityValue = pendingIdentity(identity);
        if (!isValidAiSessionRuntimeIdentity(pendingIdentityValue) || !isIdentityField(sessionId)
            || !isValidAiSessionPromotionDisplayName(sessionName)) {
            return [];
        }
        return withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
            pendingLifecycleLockKey(pendingIdentityValue), async () => {
            const storedIntent = await runtimeStore.getPromoting(pendingIdentityValue);
            const storedLiveBinding = await runtimeStore.getPending(pendingIdentityValue);
            if (storedIntent && storedLiveBinding
                && !promotionIntentMatchesLiveBinding(storedIntent, storedLiveBinding)) {
                throw new Error('The pending tmux promotion intent conflicts with the live pending binding.');
            }
            const storedPending = storedIntent?.pendingBinding
                || storedLiveBinding;
            if (!storedPending) {
                return [];
            }
            if (!pendingLifecycleIdentityMatches(storedPending, pendingIdentityValue)) {
                return [];
            }
            if (storedIntent && storedIntent.finalSessionId !== sessionId) {
                throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
            }
            await requireAvailable();
            await discovery.refresh(true);
            if (!storedIntent) {
                throwIfCollision(pendingIdentityValue);
            }
            const consumed = await runtimeStore.getConsumed(pendingIdentityValue);
            if (consumed && consumed.finalSessionId !== sessionId) {
                throw new Error('The pending tmux runtime was consumed by a different promotion.');
            }
            const ambiguous = await runtimeStore.getAmbiguous(pendingIdentityValue);
            if (ambiguous) {
                throw new Error('The prior pending runtime creation result remains ambiguous.');
            }
            const currentIntent = await runtimeStore.getPromoting(pendingIdentityValue);
            const freshBinding = await runtimeStore.getPending(pendingIdentityValue);
            if (currentIntent && freshBinding
                && !promotionIntentMatchesLiveBinding(currentIntent, freshBinding)) {
                throw new Error('The pending tmux promotion intent conflicts with the live pending binding.');
            }
            const currentBinding = currentIntent?.pendingBinding || freshBinding;
            if (!currentBinding || !pendingBindingsEqual(storedPending, currentBinding)
                || (storedIntent && (!currentIntent || !promotionIntentsMatch(storedIntent, currentIntent)))) {
                return [];
            }
            const currentPending = discovery.getPending()
                .find(runtime => aiSessionRuntimeIdentitiesEqual(
                    runtime.identity, pendingIdentityValue
                )
                    && !!runtime.tmux && locatorsEqual(runtime.tmux, currentBinding.locator));
            const pendingSnapshot = currentPending || pendingSnapshotFromBinding(currentBinding);
            const finalIdentityValue: AiSessionRuntimeIdentity = {
                provider: currentBinding.provider,
                workspaceScopeIdentity: currentBinding.workspaceScopeIdentity,
                workspaceNavigationIdentity: currentBinding.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...currentBinding.workspaceRootHostPaths],
                cwd: currentBinding.cwd,
                sessionId,
            };
            const preferredFinal = buildReadableTmuxLocator(finalIdentityValue, currentBinding.layout, {
                projectName: currentBinding.projectName || 'workspace',
                sessionName,
            });
            const finalLocator: AiSessionTmuxLocator = currentBinding.layout === 'project'
                ? { ...preferredFinal, sessionName: currentBinding.locator.sessionName }
                : preferredFinal;
            const finalLockKey = getTmuxRuntimeKey(finalIdentityValue);
            return withCreationLock<AiSessionRuntimeSnapshot<TTerminal>[]>(
                finalLockKey,
                async () => {
                    await discovery.refresh(true);
                    const intent = await runtimeStore.getPromoting(pendingIdentityValue);
                    if (!intent) {
                        throwIfCollision(pendingIdentityValue);
                    }
                    throwIfCollision(finalIdentityValue);
                    const expectedIntent = promotionIntent(currentBinding, {
                        ...pendingSnapshot,
                        markerPath: intent?.markerPath ?? pendingSnapshot.markerPath,
                    }, finalIdentityValue, sessionName, finalLocator, nowMs());
                    if (intent && !promotionIntentsMatch(intent, expectedIntent)) {
                        throw new Error('The pending tmux runtime has a conflicting promotion in progress.');
                    }
                    const consumed = await runtimeStore.getConsumed(pendingIdentityValue);
                    if (consumed) {
                        if (consumed.finalSessionId !== sessionId
                            || consumed.finalSessionName !== sessionName
                            || !locatorsEqual(consumed.finalLocator, finalLocator)) {
                            throw new Error('The pending tmux runtime was consumed by a different promotion.');
                        }
                        const completed = findVerified(finalIdentityValue, finalLocator);
                        if (!completed) {
                            return [];
                        }
                        await finishPromotionCleanup(pendingSnapshot, completed, pendingIdentityValue);
                        return [withAttach(completed)];
                    }
                    const compatible = findVerified(finalIdentityValue, finalLocator);
                    if (compatible) {
                        if (!intent) {
                            return [withAttach(asConflict(compatible)), withAttach(asConflict(pendingSnapshot))];
                        }
                        return completePromotion(pendingSnapshot, finalIdentityValue, sessionName,
                            finalLocator, compatible, pendingIdentityValue);
                    }
                    const differentlyNamedFinal = findVerified(finalIdentityValue);
                    if (differentlyNamedFinal) {
                        return [
                            withAttach(asConflict(differentlyNamedFinal)),
                            withAttach(asConflict(pendingSnapshot)),
                        ];
                    }
                    if (intent && await promotionTransitionMatches(intent, finalIdentityValue)) {
                        await writeFinalMetadata(client, finalIdentityValue, finalLocator, {
                            createdAt: intent.createdAt,
                            markerPath: intent.markerPath,
                        });
                        await client.clearPendingMetadata(finalLocator);
                        return verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                            sessionName, finalLocator, pendingIdentityValue);
                    }
                    if (intent && await sessionPromotionPartiallyRenamed(intent)) {
                        const sourceWindow = intent.sourceLocator.windowName || SESSION_WINDOW;
                        const finalWindow = intent.finalLocator.windowName;
                        if (!finalWindow) {
                            throw new Error('The pending tmux promotion state is ambiguous; no mutation was attempted.');
                        }
                        try {
                            await client.renameWindow(
                                intent.finalLocator.sessionName, sourceWindow, finalWindow
                            );
                            await writeFinalMetadata(client, finalIdentityValue, finalLocator, {
                                createdAt: intent.createdAt,
                                markerPath: intent.markerPath,
                            });
                            await client.clearPendingMetadata(finalLocator);
                        } catch (error) {
                            await discovery.refresh(true);
                            if (!findVerified(finalIdentityValue, finalLocator)) {
                                throw error;
                            }
                        }
                        return verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                            sessionName, finalLocator, pendingIdentityValue);
                    }
                    const sourcePendingVerified = !!currentPending || !!(intent
                        && await pendingMetadataMatches(pendingIdentityValue,
                            intent.sourceLocator, intent.createdAt, intent.markerPath));
                    if (!sourcePendingVerified) {
                        throw new Error('The pending tmux promotion state is ambiguous; no mutation was attempted.');
                    }
                    if (await locatorIsOccupied(finalLocator)) {
                        return [withAttach(asConflict(pendingSnapshot))];
                    }

                    if (!intent && await runtimeStore.setPromoting(expectedIntent) !== true) {
                        throw new Error('The pending tmux promotion intent could not be persisted.');
                    }
                    try {
                        const sourceLocator = currentPending?.tmux || currentBinding.locator;
                        await renameRuntime(sourceLocator, finalLocator);
                        await writeFinalMetadata(client, finalIdentityValue, finalLocator, {
                            createdAt: pendingSnapshot.createdAt,
                            markerPath: pendingSnapshot.markerPath,
                        });
                        await client.clearPendingMetadata(finalLocator);
                    } catch (error) {
                        await discovery.refresh(true);
                        const recovered = findVerified(finalIdentityValue, finalLocator);
                        if (!recovered) {
                            const sourceStillVerified = await pendingMetadataMatches(
                                pendingIdentityValue, currentBinding.locator,
                                pendingSnapshot.createdAt, pendingSnapshot.markerPath
                            );
                            if (sourceStillVerified && !await locatorIsOccupied(finalLocator)) {
                                await runtimeStore.removePromoting(pendingIdentityValue);
                            }
                            throw error;
                        }
                    }
                    return verifyAndCompletePromotion(pendingSnapshot, finalIdentityValue,
                        sessionName, finalLocator, pendingIdentityValue);
                }
            );
        });
    }

    async function promotionTransitionMatches(
        intent: TmuxPromotingRuntimeBinding,
        finalIdentityValue: AiSessionRuntimeIdentity
    ): Promise<boolean> {
        try {
            const sessionOptions = await client.getSessionOptions(
                intent.finalLocator.sessionName
            );
            const windowName = intent.finalLocator.layout === 'project'
                ? intent.finalLocator.windowName
                : intent.finalLocator.windowName || SESSION_WINDOW;
            if (!windowName) {
                return false;
            }
            const windowOptions = await client.getWindowOptions(
                intent.finalLocator.sessionName, windowName
            );
            const pendingIdentityValue: AiSessionRuntimeIdentity = {
                provider: intent.provider,
                workspaceScopeIdentity: intent.workspaceScopeIdentity,
                workspaceNavigationIdentity: intent.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...intent.workspaceRootHostPaths],
                cwd: intent.cwd,
                pendingId: intent.pendingId,
            };
            const pendingMetadata = fullMetadata(pendingIdentityValue, intent.layout,
                intent.createdAt, intent.markerPath);
            const finalMetadata = fullMetadata(finalIdentityValue, intent.layout,
                intent.createdAt, intent.markerPath);
            const bothMetadata = {
                ...pendingMetadata,
                sessionId: intent.finalSessionId,
            };
            const identityOptions = intent.layout === 'project' ? windowOptions : sessionOptions;
            const baseOptions = intent.layout === 'project' ? sessionOptions : windowOptions;
            const expectedBase = intent.layout === 'project'
                ? projectSessionMetadata(pendingIdentityValue)
                : sessionWindowMetadata();
            return recordsEqual(baseOptions, expectedBase)
                && [pendingMetadata, finalMetadata, bothMetadata]
                    .some(expected => recordsEqual(identityOptions, expected));
        } catch (_error) {
            return false;
        }
    }

    async function sessionPromotionPartiallyRenamed(
        intent: TmuxPromotingRuntimeBinding
    ): Promise<boolean> {
        if (intent.layout !== 'session') {
            return false;
        }
        const sourceWindow = intent.sourceLocator.windowName || SESSION_WINDOW;
        const finalWindow = intent.finalLocator.windowName;
        if (!finalWindow || sourceWindow === finalWindow) {
            return false;
        }
        try {
            const rows = await client.listWindows();
            const finalSessionRows = rows.filter(row =>
                row.sessionName === intent.finalLocator.sessionName);
            if (finalSessionRows.length !== 1 || finalSessionRows[0].windowName !== sourceWindow
                || rows.some(row => row.sessionName === intent.sourceLocator.sessionName)) {
                return false;
            }
            const sessionOptions = await client.getSessionOptions(
                intent.finalLocator.sessionName
            );
            const windowOptions = await client.getWindowOptions(
                intent.finalLocator.sessionName, sourceWindow
            );
            const pendingIdentityValue: AiSessionRuntimeIdentity = {
                provider: intent.provider,
                workspaceScopeIdentity: intent.workspaceScopeIdentity,
                workspaceNavigationIdentity: intent.workspaceNavigationIdentity,
                workspaceRootHostPaths: [...intent.workspaceRootHostPaths],
                cwd: intent.cwd,
                pendingId: intent.pendingId,
            };
            return recordsEqual(sessionOptions, fullMetadata(
                pendingIdentityValue, intent.layout, intent.createdAt, intent.markerPath
            )) && recordsEqual(windowOptions, sessionWindowMetadata());
        } catch (_error) {
            return false;
        }
    }

    async function pendingMetadataMatches(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<boolean> {
        try {
            await verifyPendingMetadata(client, identity, locator, createdAt, markerPath);
            return true;
        } catch (_error) {
            return false;
        }
    }

    async function verifyAndCompletePromotion(
        pending: AiSessionRuntimeSnapshot,
        identity: AiSessionRuntimeIdentity,
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await discovery.refresh(true);
        const promoted = findVerified(identity, finalLocator);
        if (!promoted) {
            throw new Error('The promoted tmux runtime could not be verified.');
        }
        return completePromotion(
            pending, identity, finalSessionName, finalLocator, promoted, pendingIdentityValue
        );
    }

    async function completePromotion(
        pending: AiSessionRuntimeSnapshot,
        identity: AiSessionRuntimeIdentity,
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator,
        promoted: AiSessionRuntimeSnapshot,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        await persistKnown(identity, finalLocator, promoted);
        await persistConsumed(pending, identity, finalSessionName, finalLocator);
        await finishPromotionCleanup(pending, promoted, pendingIdentityValue);
        return [withAttach(promoted)];
    }

    async function finishPromotionCleanup(
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot,
        pendingIdentityValue: AiSessionRuntimeIdentity
    ): Promise<void> {
        await migrateAttach(pending, promoted);
        await runtimeStore.removePending(pendingIdentityValue);
        await discovery.refresh(true);
        await runtimeStore.removePromoting(pendingIdentityValue);
    }

    async function persistConsumed(
        pending: AiSessionRuntimeSnapshot,
        finalIdentityValue: AiSessionRuntimeIdentity,
        finalSessionName: string,
        finalLocator: AiSessionTmuxLocator
    ): Promise<void> {
        if (!pending.identity.pendingId || !finalIdentityValue.sessionId) {
            throw new Error('A consumed pending runtime requires pending and final IDs.');
        }
        if (await runtimeStore.setConsumed({
            version: 2,
            state: 'consumed',
            pendingId: pending.identity.pendingId,
            provider: pending.identity.provider,
            workspaceScopeIdentity: pending.identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: pending.identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...pending.identity.workspaceRootHostPaths],
            cwd: pending.identity.cwd,
            finalSessionId: finalIdentityValue.sessionId,
            finalSessionName,
            layout: finalLocator.layout,
            finalLocator: { ...finalLocator },
            consumedAtMs: nowMs(),
        }) !== true) {
            throw new Error('The consumed pending tmux binding could not be persisted.');
        }
    }

    async function renameRuntime(from: AiSessionTmuxLocator, to: AiSessionTmuxLocator): Promise<void> {
        if (from.layout !== to.layout) {
            throw new Error('A tmux runtime cannot change layout during promotion.');
        }
        if (from.layout === 'project') {
            if (!from.windowName || !to.windowName || from.sessionName !== to.sessionName) {
                throw new Error('A project tmux promotion requires two windows in the same session.');
            }
            await client.renameWindow(from.sessionName, from.windowName, to.windowName);
            return;
        }
        await client.renameSession(from.sessionName, to.sessionName);
        const sourceWindow = from.windowName || SESSION_WINDOW;
        if (!to.windowName) {
            throw new Error('A session tmux promotion requires a final managed window name.');
        }
        await client.renameWindow(to.sessionName, sourceWindow, to.windowName);
    }
    return { promotePending, promotionTransitionMatches };
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

function asConflict(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot {
    return {
        ...runtime,
        identity: cloneAiSessionRuntimeIdentity(runtime.identity),
        state: 'conflict',
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}
