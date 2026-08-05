'use strict';

import { createHash, randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import { serializeTmuxLaunchCommand } from './launchSpec';
import type {
    AiSessionCreateRuntimeRequest,
    AiSessionDeferredCreateRuntimeRequest,
    AiSessionDeferredResumeRuntimeRequest,
    AiSessionDurablePendingPromotionCandidate,
    AiSessionExecutableRuntimeBackend,
    AiSessionManagedTmuxMetadata,
    AiSessionMaterializedCreateRuntimeRequest,
    AiSessionMaterializedResumeRuntimeRequest,
    AiSessionPendingRuntimeSnapshot,
    AiSessionResumeRuntimeRequest,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
    TmuxRuntimeUnavailableReason,
} from './runtimeTypes';
import {
    aiSessionRuntimeIdentitiesEqual,
    AiSessionRuntimeConflictError,
    AiSessionRuntimeLifecycleBlockedError,
    AiSessionRuntimeTargetChangedError,
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionPromotionDisplayName,
    isValidAiSessionRuntimeIdentity,
    TmuxRuntimeUnavailableError,
} from './runtimeTypes';
import {
    getTmuxRuntimeKey,
    parseManagedTmuxMetadata,
} from './tmuxLayout';
import {
    fullMetadata,
    projectSessionMetadata,
    sessionWindowMetadata,
    verifyPendingMetadata,
    writeFinalMetadata,
    writePendingMetadata,
} from './tmuxManagedMetadata';
import {
    createTmuxPromotionCapability,
    TmuxPromotionCapability,
} from './tmuxPromotionCapability';
import {
    TmuxAttachBinding,
    TmuxAttachBindingStore,
    TmuxAttachProcessId,
} from './tmuxAttachBindingStore';
import { TmuxClient, TmuxClientError } from './tmuxClient';
import {
    buildReadableTmuxLocator,
    projectTmuxSessionMatchesWorkspace,
    tmuxLocatorMatchesIdentity,
} from './tmuxNaming';
import {
    consumedMatchesPromotionIntent,
    consumedPendingError,
    PendingAmbiguousRuntimeBinding,
    pendingAmbiguityMatches,
    pendingIdentity,
    pendingLifecycleLockKey,
    pendingRequestFingerprint,
    pendingSnapshotFromBinding,
} from './tmuxPendingLifecycle';
import {
    TmuxAmbiguousRuntimeBinding,
    TmuxConsumedPendingBinding,
    TmuxPromotingRuntimeBinding,
    TmuxRuntimeBindingStore,
    TmuxPendingRuntimeBinding,
    validateTmuxPendingRuntimeBinding,
} from './tmuxRuntimeBindingStore';
import { getTmuxCollisionRuntimes, TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';
import {
    isBoundedOptionalLocalPath,
    isIdentityField,
    isLocalPath,
    materializePendingRequest,
    materializeResumeRequest,
    snapshotPendingRequest,
    snapshotResumeRequest,
    validateDispatchIdentity,
} from './tmuxRuntimeRequest';

const SESSION_WINDOW = 'ai-session';
const TERMINAL_PROCESS_ID_TIMEOUT_MS = 2000;
const LOCAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TMUX_ATTACH_RECOVERY_ENV = 'AGENT_PIVOT_TMUX_ATTACH_ID';
const TMUX_ATTACH_RECOVERY_TOKEN = /^[0-9a-f]{32}$/;

interface AttachTerminal {
    readonly name: string;
    readonly processId: number | PromiseLike<number | undefined>;
    readonly creationOptions?: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>;
    show(): void;
    dispose(): void;
}

interface AttachEntry<TTerminal> {
    terminal: TTerminal;
    binding: TmuxAttachBinding;
    recoveryToken?: string;
    focusedBinding?: TmuxAttachBinding | null;
    focusEpoch: number;
    explicitSelections: number;
}

export interface TmuxFocusedRuntimeSyncResult {
    monitored: boolean;
    changed: boolean;
    identity: AiSessionRuntimeIdentity | null;
}

export interface TmuxRuntimeBackendDependencies<TTerminal> {
    platform: NodeJS.Platform;
    client: TmuxClient;
    discovery: TmuxRuntimeDiscovery;
    runtimeStore: TmuxRuntimeBindingStore;
    attachStore: TmuxAttachBindingStore;
    getTerminals?(): readonly TTerminal[];
    withCreationLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
    createTerminal(options: vscode.TerminalOptions): TTerminal;
    nowMs(): number;
    getAttachTerminalName?(runtime: AiSessionRuntimeSnapshot): string | undefined;
}

export class TmuxRuntimeBackend<TTerminal = vscode.Terminal>
implements AiSessionExecutableRuntimeBackend<TTerminal> {
    private readonly attaches = new Map<string, AttachEntry<TTerminal>>();
    private attachRestoreQueue: Promise<void> = Promise.resolve();
    private readonly promotionCapability: TmuxPromotionCapability<TTerminal>;

    constructor(private readonly dependencies: TmuxRuntimeBackendDependencies<TTerminal>) {
        this.promotionCapability = createTmuxPromotionCapability<TTerminal>({
            client: dependencies.client,
            discovery: dependencies.discovery,
            runtimeStore: dependencies.runtimeStore,
            withCreationLock: (key, operation) => dependencies.withCreationLock(key, operation),
            nowMs: () => dependencies.nowMs(),
            requireAvailable: () => this.requireAvailable(),
            findVerified: (identity, requiredLocator) => this.findVerified(identity, requiredLocator),
            throwIfCollision: identity => this.throwIfCollision(identity),
            locatorIsOccupied: locator => this.locatorIsOccupied(locator),
            migrateAttach: (pending, promoted) => this.migrateAttach(pending, promoted),
            withAttach: runtime => this.withAttach(runtime),
            persistKnown: (identity, locator, lifecycle) =>
                this.persistKnown(identity, locator, lifecycle),
        });
    }

    async refresh(force: boolean = false): Promise<void> {
        await this.requireAvailable();
        try {
            await this.dependencies.discovery.refresh(force);
        } catch (error) {
            const unavailable = readOnlyRefreshUnavailableError(error);
            throw unavailable || error;
        }
    }

    getActive(): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.getActive().map(runtime => this.withAttach(runtime));
    }

    getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.getPending().map(runtime =>
            this.withAttach(runtime) as AiSessionPendingRuntimeSnapshot<TTerminal>);
    }

    getConflicts(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const getDiagnostics = this.dependencies.discovery.getDiagnostics;
        const diagnostics = typeof getDiagnostics === 'function'
            ? getDiagnostics.call(this.dependencies.discovery)
            : [];
        return getTmuxCollisionRuntimes(diagnostics)
            .map(runtime => this.withAttach(runtime));
    }

    getLifecycleBlockers(): AiSessionRuntimeSnapshot<TTerminal>[] {
        const getInactive = this.dependencies.discovery.getInactive;
        return (typeof getInactive === 'function'
            ? getInactive.call(this.dependencies.discovery)
            : []).map(runtime => this.withAttach(runtime));
    }

    find(identity: AiSessionRuntimeIdentity): AiSessionRuntimeSnapshot<TTerminal>[] {
        return this.dependencies.discovery.find(identity).map(runtime => this.withAttach(runtime));
    }

    async listRecoverablePending(): Promise<AiSessionDurablePendingPromotionCandidate<TTerminal>[]> {
        const candidates = await this.dependencies.runtimeStore.listRecoverablePending();
        return candidates.map(candidate => ({
            ...pendingSnapshotFromBinding(candidate.pendingBinding),
            promotionRecoveryDisplayName: candidate.promotionRecoveryDisplayName,
            recoverySessionId: candidate.recoverySessionId,
        }) as AiSessionDurablePendingPromotionCandidate<TTerminal>);
    }

    async getRecoverablePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string }
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal> | null> {
        const pendingIdentityValue = pendingIdentity(identity);
        if (!isValidAiSessionRuntimeIdentity(pendingIdentityValue)) {
            return null;
        }
        const matches = (await this.listRecoverablePending()).filter(runtime =>
            aiSessionRuntimeIdentitiesEqual(runtime.identity, pendingIdentityValue));
        if (matches.length > 1) {
            throw new Error('Multiple durable tmux promotions target one pending runtime.');
        }
        return matches[0] || null;
    }

    async ensureResume(
        request: AiSessionResumeRuntimeRequest,
        layout: AiSessionTmuxLayout = 'project'
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>> {
        const input = snapshotResumeRequest(request);
        requireLayout(layout);
        validateDispatchIdentity(input.identity);
        await this.requireAvailable();
        const identity = finalIdentity(input.identity);
        const preferredLocator = buildReadableTmuxLocator(identity, layout, {
            projectName: input.projectName,
            sessionName: input.sessionName,
        });
        const lockKey = getTmuxRuntimeKey(identity);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            this.throwIfCollision(identity);
            this.throwIfLifecycleBlocked(identity);
            const existing = this.findVerified(identity);
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(identity);
            if (ambiguous) {
                throw new Error('The prior tmux creation result is ambiguous; the provider command was not sent again.');
            }
            const locator = await this.resolveCreationLocator(identity, preferredLocator);
            return this.createFinalRuntime(input, layout, locator);
        });
        return this.attachAndFocus(runtime, this.getAttachTerminalName(runtime));
    }

    async ensurePending(
        request: AiSessionCreateRuntimeRequest,
        layout: AiSessionTmuxLayout = 'project'
    ): Promise<AiSessionPendingRuntimeSnapshot<TTerminal>> {
        const input = snapshotPendingRequest(request);
        requireLayout(layout);
        validateDispatchIdentity(input.identity);
        const identity = pendingIdentity(input.identity);
        await this.auditPendingId(identity);
        const preferredLocator = buildReadableTmuxLocator(identity, layout, {
            projectName: input.projectName,
            sessionName: input.title?.trim() || 'new-session',
        });
        const binding = validateTmuxPendingRuntimeBinding({
            version: 2,
            state: 'pending',
            pendingId: identity.pendingId,
            provider: identity.provider,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            createdAt: input.createdAt,
            excludedSessionIds: input.excludedSessionIds,
            projectName: input.projectName,
            ...(input.title === undefined ? {} : { title: input.title }),
            acceptedAtMs: Date.parse(input.createdAt),
            layout,
            locator: preferredLocator,
        }, this.dependencies.nowMs());
        if (!binding) {
            throw new Error('The pending runtime request is invalid or expired.');
        }
        await this.requireAvailable();
        const lockKey = pendingLifecycleLockKey(identity);
        const runtime = await this.withCreationLocks(identity, layout, lockKey, async () => {
            await this.dependencies.discovery.refresh(true);
            this.throwIfCollision(identity);
            const lifecycle = await this.auditPendingId(identity);
            const existing = this.findVerified(identity) as AiSessionPendingRuntimeSnapshot | undefined;
            if (existing) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
                return existing;
            }
            const ambiguous = lifecycle.ambiguous;
            if (ambiguous) {
                const pendingAmbiguous = ambiguous as PendingAmbiguousRuntimeBinding;
                const acceptedBinding = validateTmuxPendingRuntimeBinding({
                    ...binding,
                    locator: { ...pendingAmbiguous.locator },
                    ...(pendingAmbiguous.projectName === undefined
                        ? {} : { projectName: pendingAmbiguous.projectName }),
                }, this.dependencies.nowMs());
                if (!acceptedBinding) {
                    throw new Error('The prior pending runtime binding is invalid or expired.');
                }
                return this.recoverPendingAmbiguity(
                    input, acceptedBinding, acceptedBinding.locator, pendingAmbiguous
                );
            }
            const locator = await this.resolveCreationLocator(identity, preferredLocator);
            const dispatchBinding = validateTmuxPendingRuntimeBinding({
                ...binding,
                locator,
                acceptedAtMs: this.dependencies.nowMs(),
            }, this.dependencies.nowMs());
            if (!dispatchBinding) {
                throw new Error('The pending runtime request expired before provider dispatch.');
            }
            return this.createPendingRuntime(input, dispatchBinding, locator);
        });
        return this.attachAndFocus(
            runtime, this.getAttachTerminalName(runtime)
        ) as Promise<AiSessionPendingRuntimeSnapshot<TTerminal>>;
    }

    private async auditPendingId(identity: AiSessionRuntimeIdentity): Promise<{
        ambiguous: TmuxAmbiguousRuntimeBinding | null;
        pending: TmuxPendingRuntimeBinding | null;
    }> {
        const promoting = await this.dependencies.runtimeStore.getPromoting(identity);
        if (promoting) {
            throw new Error('The pending tmux runtime has a promotion in progress.');
        }
        const consumed = await this.dependencies.runtimeStore.getConsumed(identity);
        if (consumed) {
            throw consumedPendingError(consumed);
        }
        const ambiguous = await this.dependencies.runtimeStore.getAmbiguous(identity);
        const pending = await this.dependencies.runtimeStore.getPending(identity);
        return { ambiguous, pending };
    }

    async promotePending(
        identity: AiSessionRuntimeIdentity & { pendingId: string },
        sessionId: string,
        sessionName: string
    ): Promise<AiSessionRuntimeSnapshot<TTerminal>[]> {
        return this.promotionCapability.promotePending(identity, sessionId, sessionName);
    }

    private async promotionTransitionMatches(
        intent: TmuxPromotingRuntimeBinding,
        finalIdentityValue: AiSessionRuntimeIdentity
    ): Promise<boolean> {
        return this.promotionCapability.promotionTransitionMatches(intent, finalIdentityValue);
    }

    async focus(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux' || !runtime.tmux) {
            return;
        }
        await this.attachRestoreQueue;
        await this.verifyFocusTarget(runtime);
        await this.attachAndFocus(runtime, this.getAttachTerminalName(runtime));
    }

    private async verifyFocusTarget(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime.tmux) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        const target = await this.dependencies.client.getTargetWindow(runtime.tmux);
        const metadata = target ? parseManagedTmuxMetadata(target.metadata) : null;
        const actualLocator: AiSessionTmuxLocator | null = target && metadata ? {
            layout: metadata.layout,
            sessionName: target.sessionName,
            ...(metadata.layout === 'project' || runtime.tmux.windowName
                ? { windowName: target.windowName } : {}),
        } : null;
        if (!metadata || !actualLocator || !locatorsEqual(actualLocator, runtime.tmux)) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        if (!aiSessionRuntimeIdentitiesEqual(metadata, runtime.identity)
            && !await this.matchesCommittedCodexThreadRebind(runtime, metadata)) {
            throw new AiSessionRuntimeTargetChangedError();
        }
    }

    private async matchesCommittedCodexThreadRebind(
        runtime: AiSessionRuntimeSnapshot<TTerminal>,
        metadata: AiSessionManagedTmuxMetadata
    ): Promise<boolean> {
        const sessionId = runtime.identity.sessionId;
        if (runtime.identity.provider !== 'codex' || metadata.provider !== 'codex'
            || !sessionId || !metadata.sessionId || !runtime.tmux) {
            return false;
        }
        const known = await this.dependencies.runtimeStore.getKnown(
            runtime.identity.provider,
            sessionId,
            runtime.identity.workspaceScopeIdentity
        );
        return !!known
            && aiSessionRuntimeIdentitiesEqual(known, runtime.identity)
            && locatorsEqual(known.locator, runtime.tmux)
            && aiSessionRuntimeIdentitiesEqual(metadata, {
                ...runtime.identity,
                sessionId: metadata.sessionId,
                pendingId: undefined,
            });
    }

    getFocusedRuntime(terminal: TTerminal | null | undefined): AiSessionRuntimeSnapshot<TTerminal> | null {
        if (!terminal) {
            return null;
        }
        const entry = [...this.attaches.values()].find(candidate => candidate.terminal === terminal);
        const binding = entry?.focusedBinding !== undefined
            ? entry.focusedBinding
            : entry?.binding;
        const runtime = binding ? this.runtimeForBinding(binding) : undefined;
        return runtime ? this.withAttach(runtime) : null;
    }

    async syncFocusedRuntime(
        terminal: TTerminal | null | undefined
    ): Promise<TmuxFocusedRuntimeSyncResult> {
        const registered = terminal
            ? [...this.attaches.entries()].find(([, candidate]) => candidate.terminal === terminal)
            : undefined;
        const key = registered?.[0];
        const entry = registered?.[1];
        const previous = this.getFocusedRuntime(terminal);
        if (!entry || entry.binding.layout !== 'project') {
            return {
                monitored: false, changed: false,
                identity: previous ? cloneAiSessionRuntimeIdentity(previous.identity) : null,
            };
        }
        const focusEpoch = entry.focusEpoch;
        const activeWindow = await this.dependencies.client.getActiveWindow(entry.binding.sessionName);
        if (!key || this.attaches.get(key) !== entry
            || entry.focusEpoch !== focusEpoch || entry.explicitSelections > 0) {
            const current = this.getFocusedRuntime(terminal);
            return {
                monitored: true, changed: false,
                identity: current ? cloneAiSessionRuntimeIdentity(current.identity) : null,
            };
        }
        const matches = activeWindow ? [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ].filter(runtime => runtime.tmux?.layout === 'project'
            && runtime.identity.workspaceScopeIdentity === entry.binding.workspaceScopeIdentity
            && runtime.tmux.sessionName === activeWindow.sessionName
            && runtime.tmux.windowName === activeWindow.windowName) : [];
        if (matches.length > 1) {
            throw new Error('The active tmux window maps to multiple managed runtimes.');
        }
        const next = matches[0];
        entry.focusedBinding = next
            ? attachBinding(next, entry.binding.terminalNamePrefix)
            : null;
        entry.focusEpoch++;
        return {
            monitored: true,
            changed: !runtimeIdentityEquals(previous?.identity || null, next?.identity || null),
            identity: next ? cloneAiSessionRuntimeIdentity(next.identity) : null,
        };
    }

    async detach(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux') {
            return;
        }
        const key = registryKey(runtime);
        const entry = this.attaches.get(key);
        if (!entry) {
            return;
        }
        entry.focusEpoch++;
        this.attaches.delete(key);
        const terminal = attachTerminal(entry.terminal);
        this.removePersistedAttach(entry.recoveryToken || null, terminal.processId);
        terminal.dispose();
    }

    async terminate(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<void> {
        if (!runtime || runtime.backend !== 'tmux' || !runtime.tmux) {
            return;
        }
        await this.attachRestoreQueue;
        if (!await this.verifyTerminateTarget(runtime)) {
            return;
        }
        if (runtime.tmux.layout === 'project') {
            if (!runtime.tmux.windowName) {
                throw new AiSessionRuntimeTargetChangedError();
            }
            await this.dependencies.client.killWindow(runtime.tmux);
        } else {
            await this.dependencies.client.killSession(runtime.tmux.sessionName);
        }
        await this.dependencies.discovery.refresh(true);
    }

    private async verifyTerminateTarget(runtime: AiSessionRuntimeSnapshot<TTerminal>): Promise<boolean> {
        if (!runtime.tmux) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        const target = await this.dependencies.client.getTargetWindow(runtime.tmux);
        if (!target) {
            return false;
        }
        const metadata = parseManagedTmuxMetadata(target.metadata);
        const actualLocator: AiSessionTmuxLocator | null = metadata ? {
            layout: metadata.layout,
            sessionName: target.sessionName,
            ...(metadata.layout === 'project' || runtime.tmux.windowName
                ? { windowName: target.windowName } : {}),
        } : null;
        if (!metadata || !actualLocator || !locatorsEqual(actualLocator, runtime.tmux)) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        if (!aiSessionRuntimeIdentitiesEqual(metadata, runtime.identity)
            && !await this.matchesCommittedCodexThreadRebind(runtime, metadata)) {
            throw new AiSessionRuntimeTargetChangedError();
        }
        return true;
    }

    isAttachTerminalCandidate(terminal: TTerminal): boolean {
        const attach = attachTerminal(terminal);
        return getTmuxAttachRecoveryToken(attach.creationOptions) !== null
            || getTmuxAttachSessionName(
                attach.creationOptions,
                this.dependencies.client.getExecutablePath()
            ) !== null;
    }

    restoreAttachTerminals(terminals: readonly TTerminal[]): Promise<void> {
        const restore = this.attachRestoreQueue.then(
            () => this.restoreAttachTerminalsOnce(terminals)
        );
        this.attachRestoreQueue = restore.catch(() => undefined);
        return restore;
    }

    private async restoreAttachTerminalsOnce(terminals: readonly TTerminal[]): Promise<void> {
        await this.dependencies.discovery.refresh(true);
        const untracked = (terminals || []).filter(terminal =>
            ![...this.attaches.values()].some(entry => entry.terminal === terminal));
        // Terminal process IDs can stay pending until the pty host reconnects them after
        // a window reload (up to the per-terminal timeout each), so resolve them
        // concurrently instead of multiplying the restore latency by the terminal count.
        const resolved = await Promise.all(untracked.map(async terminal => {
            const attach = attachTerminal(terminal);
            return { terminal, attach, processId: await resolveProcessId(attach.processId) };
        }));
        // Live tmux client lookups share one list-clients snapshot per restore pass so a
        // window with many plain terminals does not spawn one tmux invocation each.
        let clientSessionsByProcess: Map<number, string> | null = null;
        const liveSessionForProcess = async (processId: number): Promise<string | null> => {
            if (!clientSessionsByProcess) {
                clientSessionsByProcess = await this.dependencies.client.getClientSessionsByProcess();
            }
            return clientSessionsByProcess.get(processId) || null;
        };
        for (const { terminal, attach, processId } of resolved) {
            if (processId === null) {
                continue;
            }
            const recoveryToken = getTmuxAttachRecoveryToken(attach.creationOptions);
            const recovery = recoveryToken
                ? this.dependencies.attachStore.getRecovery(recoveryToken)
                : null;
            let binding = recovery?.binding || this.dependencies.attachStore.get(processId);
            const launchSessionName = getTmuxAttachSessionName(
                attach.creationOptions, this.dependencies.client.getExecutablePath()
            );
            const bindingMatchesTerminal = binding
                ? Boolean(recovery) || terminalMatchesBinding(attach, binding, launchSessionName)
                : false;
            const liveSessionName = !bindingMatchesTerminal && launchSessionName === null
                ? await liveSessionForProcess(processId)
                : launchSessionName;
            let runtime = bindingMatchesTerminal ? this.runtimeForBinding(binding as TmuxAttachBinding)
                : await this.runtimeForAttachSession(liveSessionName);
            if (!bindingMatchesTerminal && runtime) {
                binding = attachBinding(runtime, getTerminalCreationName(attach)
                    || this.getAttachTerminalName(runtime));
            }
            if (binding?.pendingId && bindingMatchesTerminal && !runtime) {
                const pendingIdentityValue: AiSessionRuntimeIdentity = {
                    provider: binding.provider,
                    workspaceScopeIdentity: binding.workspaceScopeIdentity,
                    workspaceNavigationIdentity: binding.workspaceNavigationIdentity,
                    workspaceRootHostPaths: [...binding.workspaceRootHostPaths],
                    cwd: binding.cwd,
                    pendingId: binding.pendingId,
                };
                const consumed = await this.dependencies.runtimeStore.getConsumed(pendingIdentityValue);
                if (consumed) {
                    const finalIdentityValue: AiSessionRuntimeIdentity = {
                        ...pendingIdentityValue,
                        pendingId: undefined,
                        sessionId: consumed.finalSessionId,
                    };
                    const promoted = this.findVerified(finalIdentityValue, consumed.finalLocator);
                    if (promoted) {
                        binding = attachBinding(promoted, binding.terminalNamePrefix);
                        runtime = promoted;
                    } else {
                        const intent = await this.dependencies.runtimeStore.getPromoting(
                            pendingIdentityValue
                        );
                        const intentPending = intent
                            && consumedMatchesPromotionIntent(consumed, intent)
                            ? pendingSnapshotFromBinding(intent.pendingBinding) : null;
                        if (intentPending && bindingTargetsRuntime(binding, intentPending)) {
                            const key = registryKey(intentPending);
                            if (!this.attaches.has(key)) {
                                this.attaches.set(key, {
                                    terminal, binding, focusedBinding: binding,
                                    ...(recoveryToken ? { recoveryToken } : {}),
                                    focusEpoch: 0, explicitSelections: 0,
                                });
                                this.persistAttachBinding(
                                    attach.processId, binding, recoveryToken
                                );
                            }
                        } else {
                            this.removePersistedAttach(recoveryToken, processId);
                        }
                        continue;
                    }
                } else {
                    const intent = await this.dependencies.runtimeStore.getPromoting(pendingIdentityValue);
                    const intentPending = intent ? pendingSnapshotFromBinding(intent.pendingBinding) : null;
                    if (intentPending && bindingTargetsRuntime(binding, intentPending)) {
                        const key = registryKey(intentPending);
                        if (!this.attaches.has(key)) {
                            this.attaches.set(key, {
                                terminal, binding, focusedBinding: binding,
                                ...(recoveryToken ? { recoveryToken } : {}),
                                focusEpoch: 0, explicitSelections: 0,
                            });
                            this.persistAttachBinding(
                                attach.processId, binding, recoveryToken
                            );
                        }
                        continue;
                    }
                }
            }
            if (!binding || !runtime) {
                this.removePersistedAttach(recoveryToken, processId);
                continue;
            }
            const key = registryKey(runtime);
            const existing = this.attaches.get(key);
            if (existing) {
                if (existing.terminal !== terminal) {
                    this.removePersistedAttach(recoveryToken, processId);
                }
                continue;
            }
            this.attaches.set(key, {
                terminal, binding, focusedBinding: binding,
                ...(recoveryToken ? { recoveryToken } : {}),
                focusEpoch: 0, explicitSelections: 0,
            });
            this.persistAttachBinding(attach.processId, binding, recoveryToken);
        }
        await this.dependencies.attachStore.flush();
    }

    handleClosedTerminal(terminal: TTerminal): void {
        for (const [key, entry] of this.attaches) {
            if (entry.terminal !== terminal) {
                continue;
            }
            entry.focusEpoch++;
            this.attaches.delete(key);
            this.removePersistedAttach(
                entry.recoveryToken || null, attachTerminal(terminal).processId
            );
        }
    }

    private async createFinalRuntime(
        request: AiSessionDeferredResumeRuntimeRequest,
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionRuntimeSnapshot> {
        const createdAt = new Date(this.dependencies.nowMs()).toISOString();
        let providerLaunchAttempted = false;
        let dispatched: AiSessionMaterializedResumeRuntimeRequest | undefined;
        try {
            await this.createTarget(layout, locator, request.identity.cwd,
                request.identity,
                async () => {
                    await this.persistAmbiguous(request.identity, locator);
                    try {
                        dispatched = materializeResumeRequest(request);
                    } catch (error) {
                        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
                        throw error;
                    }
                    providerLaunchAttempted = true;
                    return serializeTmuxLaunchCommand(dispatched.launch);
                });
            if (!dispatched) {
                throw new Error('The provider launch was not prepared.');
            }
            await this.writeFinalMetadata(request.identity, locator, {
                createdAt,
                markerPath: dispatched.launch.markerPath || '',
            });
            await this.persistKnown(request.identity, locator, {
                identity: request.identity,
                markerPath: dispatched.launch.markerPath || '',
                runStartedAtMs: Date.parse(createdAt),
            });
        } catch (error) {
            if (!providerLaunchAttempted) {
                throw error;
            }
            return this.recoverAmbiguousCreation(request.identity, locator, error);
        }
        const runtime = await this.verifyCreated(request.identity, locator);
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return runtime;
    }

    private async createPendingRuntime(
        request: AiSessionDeferredCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        let providerLaunchAttempted = false;
        let dispatched: AiSessionMaterializedCreateRuntimeRequest | undefined;
        try {
            await this.createTarget(binding.layout, locator, request.identity.cwd,
                request.identity,
                async () => {
                    await this.persistAmbiguous(request.identity, locator, request, binding);
                    try {
                        dispatched = materializePendingRequest(request);
                    } catch (error) {
                        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
                        throw error;
                    }
                    providerLaunchAttempted = true;
                    return serializeTmuxLaunchCommand(dispatched.launch);
                });
            if (!dispatched) {
                throw new Error('The provider launch was not prepared.');
            }
            await this.writePendingMetadata(request.identity, locator, request.createdAt,
                dispatched.launch.markerPath || '');
            await this.verifyPendingMetadata(request.identity, locator, request.createdAt,
                dispatched.launch.markerPath || '');
            if (await this.dependencies.runtimeStore.setPending(binding) !== true) {
                throw new Error('The pending tmux binding could not be persisted.');
            }
        } catch (error) {
            if (!providerLaunchAttempted) {
                throw error;
            }
            return this.recoverPendingCreation(request, binding, locator, error);
        }
        const runtime = await this.verifyCreated(request.identity, locator) as AiSessionPendingRuntimeSnapshot;
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return runtime;
    }

    private async createTarget(
        layout: AiSessionTmuxLayout,
        locator: AiSessionTmuxLocator,
        cwd: string,
        identity: AiSessionRuntimeIdentity,
        prepareProviderCommand: () => Promise<string>
    ): Promise<void> {
        if (layout === 'session') {
            if (await this.dependencies.client.hasSession(locator.sessionName)) {
                throw new Error('The requested tmux session name is already occupied by an unverified target.');
            }
            const windowName = locator.windowName || SESSION_WINDOW;
            const command = await prepareProviderCommand();
            await this.dependencies.client.createSession(locator.sessionName, windowName, cwd, command);
            await this.dependencies.client.configureManagedWindow(locator.sessionName, windowName);
            return;
        }

        if (!projectTmuxSessionMatchesWorkspace(locator.sessionName, identity)) {
            throw new Error('The requested project tmux session is an unverified target.');
        }
        if (!locator.windowName) {
            throw new Error('A project tmux runtime requires a window name.');
        }
        const hasSession = await this.dependencies.client.hasSession(locator.sessionName);
        const compatibleContainer = this.projectContainerIsVerified(locator, identity.workspaceScopeIdentity)
            || (hasSession && recordsEqual(
                await this.dependencies.client.getSessionOptions(locator.sessionName),
                projectSessionMetadata(identity)
            ));
        if (hasSession && !compatibleContainer) {
            throw new Error('The requested project tmux session is occupied by an unverified target.');
        }
        if (!hasSession) {
            const command = await prepareProviderCommand();
            await this.dependencies.client.createSession(
                locator.sessionName, locator.windowName, cwd, command
            );
            await this.dependencies.client.setSessionOptions(locator.sessionName,
                projectSessionMetadata(identity));
            await this.dependencies.client.configureManagedWindow(locator.sessionName, locator.windowName);
            return;
        }
        if (await this.locatorIsOccupied(locator)) {
            throw new Error('The requested project tmux window is occupied by an unverified target.');
        }
        const command = await prepareProviderCommand();
        await this.dependencies.client.createWindow(locator.sessionName, locator.windowName, cwd, command);
        await this.dependencies.client.configureManagedWindow(locator.sessionName, locator.windowName);
    }

    private projectContainerIsVerified(locator: AiSessionTmuxLocator, workspaceScopeIdentity: string): boolean {
        return [...this.dependencies.discovery.getActive(), ...this.dependencies.discovery.getPending()]
            .some(runtime => runtime.tmux?.layout === 'project'
                && runtime.tmux.sessionName === locator.sessionName
                && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity);
    }

    private async resolveCreationLocator(
        identity: AiSessionRuntimeIdentity,
        preferred: AiSessionTmuxLocator
    ): Promise<AiSessionTmuxLocator> {
        if (preferred.layout !== 'project') {
            return { ...preferred };
        }
        const rows = await this.dependencies.client.listWindows();
        const expected = projectSessionMetadata(identity);
        const containers = new Map<string, string>();
        for (const row of rows) {
            if (recordsEqual(row.sessionMetadata, expected) && !containers.has(row.sessionName)) {
                containers.set(row.sessionName, row.windowName);
            }
        }
        if (containers.size === 0) {
            return { ...preferred };
        }
        const hasInvalidContainer = [...containers.keys()].some(sessionName =>
            !projectTmuxSessionMatchesWorkspace(sessionName, identity));
        if (containers.size === 1 && !hasInvalidContainer) {
            return { ...preferred, sessionName: containers.keys().next().value as string };
        }
        const conflicts = [...containers].map(([sessionName, windowName]) => ({
            identity: cloneAiSessionRuntimeIdentity(identity),
            backend: 'tmux' as const,
            state: 'conflict' as const,
            markerPath: '',
            runStartedAtMs: 0,
            attached: false,
            tmux: { layout: 'project' as const, sessionName, windowName },
        }));
        throw new AiSessionRuntimeConflictError(conflicts);
    }

    private withCreationLocks<T>(
        identity: AiSessionRuntimeIdentity,
        layout: AiSessionTmuxLayout,
        identityLockKey: string,
        operation: () => Promise<T>
    ): Promise<T> {
        if (layout !== 'project') {
            return this.dependencies.withCreationLock(identityLockKey, operation);
        }
        return this.dependencies.withCreationLock(`project:${identity.workspaceScopeIdentity}`, () =>
            this.dependencies.withCreationLock(identityLockKey, operation));
    }

    private async writeFinalMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lifecycle: { createdAt: string; markerPath: string }
    ): Promise<void> {
        return writeFinalMetadata(this.dependencies.client, identity, locator, lifecycle);
    }

    private async writePendingMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<void> {
        return writePendingMetadata(this.dependencies.client, identity, locator, createdAt, markerPath);
    }

    private async verifyPendingMetadata(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        createdAt: string,
        markerPath: string
    ): Promise<void> {
        return verifyPendingMetadata(this.dependencies.client, identity, locator, createdAt, markerPath);
    }

    private async persistKnown(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        lifecycle?: Pick<AiSessionRuntimeSnapshot, 'identity' | 'markerPath' | 'runStartedAtMs'>
    ): Promise<void> {
        if (!identity.sessionId) {
            throw new Error('A known tmux runtime requires a session ID.');
        }
        const hasLifecycleEvidence = !!lifecycle
            && isLocalPath(identity.cwd)
            && isBoundedOptionalLocalPath(lifecycle.markerPath)
            && Number.isFinite(lifecycle.runStartedAtMs)
            && lifecycle.runStartedAtMs > 0;
        await this.dependencies.runtimeStore.setKnown({
            version: 2,
            state: 'known',
            provider: identity.provider,
            sessionId: identity.sessionId,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            layout: locator.layout,
            locator: { ...locator },
            lastSeenAtMs: this.dependencies.nowMs(),
            ...(hasLifecycleEvidence ? {
                markerPath: lifecycle.markerPath,
                runStartedAtMs: lifecycle.runStartedAtMs,
            } : {}),
        });
    }

    private async verifyCreated(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator
    ): Promise<AiSessionRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const runtime = this.findVerified(identity, locator);
        if (!runtime) {
            throw new Error('The created tmux runtime could not be verified.');
        }
        return runtime;
    }

    private async recoverAmbiguousCreation(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        error: unknown
    ): Promise<AiSessionRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(identity, locator);
        if (!recovered) {
            if (isProvenNoCreate(error) && !await this.locatorIsOccupied(locator)) {
                await this.dependencies.runtimeStore.removeAmbiguous(identity);
            }
            throw error;
        }
        await this.persistKnown(identity, locator, recovered);
        await this.dependencies.runtimeStore.removeAmbiguous(identity);
        return recovered;
    }

    private async persistAmbiguous(
        identity: AiSessionRuntimeIdentity,
        locator: AiSessionTmuxLocator,
        pendingRequest?: AiSessionDeferredCreateRuntimeRequest,
        pendingBinding?: TmuxPendingRuntimeBinding
    ): Promise<void> {
        if (identity.sessionId === undefined && (!pendingRequest || !pendingBinding)) {
            throw new Error('A pending ambiguity tombstone requires the complete accepted request.');
        }
        const record: TmuxAmbiguousRuntimeBinding = {
            version: 2,
            state: 'ambiguous',
            provider: identity.provider,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            ...(identity.sessionId !== undefined
                ? { sessionId: identity.sessionId }
                : {
                    pendingId: identity.pendingId as string,
                    createdAt: pendingBinding?.createdAt as string,
                    excludedSessionIds: [...pendingBinding?.excludedSessionIds || []],
                    ...(pendingBinding?.projectName === undefined
                        ? {} : { projectName: pendingBinding.projectName }),
                    ...(pendingBinding?.title === undefined ? {} : { title: pendingBinding.title }),
                    ...(pendingRequest?.launchMarkerPath
                        ? { markerPath: pendingRequest.launchMarkerPath }
                        : {}),
                    requestFingerprint: pendingRequestFingerprint(
                        pendingRequest as AiSessionDeferredCreateRuntimeRequest
                    ),
                }),
            layout: locator.layout,
            locator: { ...locator },
            acceptedAtMs: pendingBinding?.acceptedAtMs ?? this.dependencies.nowMs(),
        };
        await this.dependencies.runtimeStore.setAmbiguous(record);
    }

    private async recoverPendingAmbiguity(
        request: AiSessionDeferredCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator,
        ambiguous: TmuxAmbiguousRuntimeBinding
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        if (ambiguous.sessionId !== undefined
            || !pendingAmbiguityMatches(ambiguous as PendingAmbiguousRuntimeBinding,
                request, binding, locator)) {
            throw new Error('The prior pending runtime request is ambiguous and does not match this request.');
        }
        await this.verifyPendingMetadata(request.identity, locator, request.createdAt,
            request.launchMarkerPath);
        if (await this.dependencies.runtimeStore.setPending({
            ...binding,
            acceptedAtMs: ambiguous.acceptedAtMs,
        }) !== true) {
            throw new Error('The recovered pending tmux binding could not be persisted.');
        }
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(request.identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
        if (!recovered) {
            throw new Error('The pending tmux runtime remains ambiguous after metadata recovery.');
        }
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return recovered;
    }

    private async recoverPendingCreation(
        request: AiSessionDeferredCreateRuntimeRequest,
        binding: TmuxPendingRuntimeBinding,
        locator: AiSessionTmuxLocator,
        error: unknown
    ): Promise<AiSessionPendingRuntimeSnapshot> {
        await this.dependencies.discovery.refresh(true);
        const recovered = this.findVerified(request.identity, locator) as AiSessionPendingRuntimeSnapshot | undefined;
        if (!recovered) {
            if (isProvenNoCreate(error) && !await this.locatorIsOccupied(locator)) {
                await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
            }
            throw error;
        }
        if (await this.dependencies.runtimeStore.setPending(binding) !== true) {
            throw new Error('The recovered pending tmux binding could not be persisted.');
        }
        await this.dependencies.runtimeStore.removeAmbiguous(request.identity);
        return recovered;
    }

    private findVerified(
        identity: AiSessionRuntimeIdentity,
        requiredLocator?: AiSessionTmuxLocator
    ): AiSessionRuntimeSnapshot | undefined {
        const matches = this.dependencies.discovery.find(identity)
            .filter(runtime => !!runtime.tmux
                && tmuxLocatorMatchesIdentity(runtime.tmux as AiSessionTmuxLocator, identity)
                && (!requiredLocator || locatorsEqual(
                    runtime.tmux as AiSessionTmuxLocator, requiredLocator
                )));
        return matches.length === 1 ? matches[0] : undefined;
    }

    private throwIfCollision(identity: AiSessionRuntimeIdentity): void {
        const conflicts = this.getConflicts().filter(runtime =>
            runtimeIdentitiesMatch(runtime.identity, identity));
        if (conflicts.length) {
            throw new AiSessionRuntimeConflictError(conflicts);
        }
    }

    private throwIfLifecycleBlocked(identity: AiSessionRuntimeIdentity): void {
        const blockers = this.getLifecycleBlockers().filter(runtime =>
            runtime.identity.provider === identity.provider
            && runtime.identity.workspaceScopeIdentity === identity.workspaceScopeIdentity
            && runtime.identity.sessionId === identity.sessionId);
        if (blockers.length) {
            throw new AiSessionRuntimeLifecycleBlockedError(blockers);
        }
    }

    private async attachAndFocus<T extends AiSessionRuntimeSnapshot>(
        runtime: T,
        terminalName: string
    ): Promise<T & AiSessionRuntimeSnapshot<TTerminal>> {
        if (!runtime.tmux) {
            throw new Error('A tmux runtime must include a locator.');
        }
        const key = registryKey(runtime);
        if (!this.attaches.has(key)) {
            const terminals = this.dependencies.getTerminals?.() || [];
            if (terminals.length) {
                await this.restoreAttachTerminals(terminals);
            }
        }
        const selectingEntry = this.attaches.get(key);
        if (selectingEntry) {
            selectingEntry.focusEpoch++;
            selectingEntry.explicitSelections++;
        }
        try {
            await this.dependencies.client.selectWindow(runtime.tmux);
            let entry = this.attaches.get(key);
            if (!entry) {
                const binding = attachBinding(runtime, terminalName);
                const recoveryToken = createAttachRecoveryToken();
                const terminal = this.dependencies.createTerminal({
                    name: terminalName,
                    shellPath: this.dependencies.client.getExecutablePath(),
                    shellArgs: ['attach-session', '-t', runtime.tmux.sessionName],
                    env: { TMUX: null, [TMUX_ATTACH_RECOVERY_ENV]: recoveryToken },
                });
                entry = {
                    terminal, binding, recoveryToken, focusedBinding: binding,
                    focusEpoch: 0, explicitSelections: 0,
                };
                this.attaches.set(key, entry);
                this.persistAttachBinding(
                    attachTerminal(terminal).processId, binding, recoveryToken
                );
            } else {
                const binding = attachBinding(runtime, entry.binding.terminalNamePrefix);
                entry.binding = binding;
                entry.focusedBinding = binding;
                entry.focusEpoch++;
                this.persistAttachBinding(
                    attachTerminal(entry.terminal).processId,
                    entry.binding,
                    entry.recoveryToken || null
                );
            }
            try {
                attachTerminal(entry.terminal).show();
            } catch (error) {
                entry.focusEpoch++;
                this.attaches.delete(key);
                this.removePersistedAttach(
                    entry.recoveryToken || null, attachTerminal(entry.terminal).processId
                );
                try {
                    attachTerminal(entry.terminal).dispose();
                } catch (_disposeError) {
                    // Preserve the original show failure.
                }
                throw error;
            }
            await this.dependencies.attachStore.flush();
            return this.withAttach(runtime) as T & AiSessionRuntimeSnapshot<TTerminal>;
        } finally {
            if (selectingEntry) {
                selectingEntry.focusEpoch++;
                selectingEntry.explicitSelections--;
            }
        }
    }

    private getAttachTerminalName(runtime: AiSessionRuntimeSnapshot): string {
        const candidate = this.dependencies.getAttachTerminalName?.({
            ...runtime,
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        });
        return isSafeAttachTerminalName(candidate)
            ? candidate
            : getRestoredAttachTerminalName(runtime);
    }

    private withAttach(runtime: AiSessionRuntimeSnapshot): AiSessionRuntimeSnapshot<TTerminal> {
        const entry = this.attaches.get(registryKey(runtime));
        const { terminal: _terminal, ...base } = runtime;
        return {
            ...base,
            identity: cloneAiSessionRuntimeIdentity(runtime.identity),
            attached: !!entry,
            ...(entry ? { terminal: entry.terminal } : {}),
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        };
    }

    private async requireAvailable(): Promise<void> {
        if (this.dependencies.platform === 'win32') {
            throw new TmuxRuntimeUnavailableError(
                'unsupported-platform',
                'Managed tmux runtimes require a POSIX extension host.'
            );
        }
        const availability = await this.dependencies.client.checkAvailability();
        if ('category' in availability) {
            throw new TmuxRuntimeUnavailableError(
                unavailableReason(availability.category),
                availability.message
            );
        }
    }

    private runtimeForBinding(binding: TmuxAttachBinding): AiSessionRuntimeSnapshot | undefined {
        const runtimes = [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ];
        if (binding.layout === 'project') {
            return runtimes.find(runtime => runtime.tmux?.layout === 'project'
                && runtime.identity.workspaceScopeIdentity === binding.workspaceScopeIdentity
                && runtime.tmux.sessionName === binding.sessionName
                && (!binding.windowName || runtime.tmux.windowName === binding.windowName));
        }
        return runtimes.find(runtime => runtime.tmux?.layout === 'session'
            && runtime.identity.workspaceScopeIdentity === binding.workspaceScopeIdentity
            && runtime.tmux.sessionName === binding.sessionName
            && (!binding.windowName || runtime.tmux.windowName === binding.windowName)
            && (!binding.provider || runtime.identity.provider === binding.provider)
            && (!binding.sessionId || runtime.identity.sessionId === binding.sessionId));
    }

    private persistAttachBinding(
        processId: AttachTerminal['processId'],
        binding: TmuxAttachBinding,
        recoveryToken: string | null
    ): void {
        if (recoveryToken) {
            this.dependencies.attachStore.setRecovery(recoveryToken, processId, binding);
            return;
        }
        this.dependencies.attachStore.set(processId, binding);
    }

    private removePersistedAttach(
        recoveryToken: string | null,
        processId: TmuxAttachProcessId
    ): void {
        if (recoveryToken) {
            this.dependencies.attachStore.removeRecovery(recoveryToken);
            return;
        }
        this.dependencies.attachStore.remove(processId);
    }

    private async runtimeForAttachSession(
        sessionName: string | null
    ): Promise<AiSessionRuntimeSnapshot | undefined> {
        if (!sessionName) {
            return undefined;
        }
        const matches = [
            ...this.dependencies.discovery.getActive(),
            ...this.dependencies.discovery.getPending(),
        ].filter(runtime => runtime.tmux?.sessionName === sessionName);
        if (matches.length <= 1) {
            return matches[0];
        }
        const registryKeys = new Set(matches.map(registryKey));
        if (registryKeys.size !== 1 || matches.some(runtime => runtime.tmux?.layout !== 'project')) {
            return undefined;
        }
        const activeWindow = await this.dependencies.client.getActiveWindow(sessionName);
        const activeMatches = activeWindow
            ? matches.filter(runtime => runtime.tmux?.windowName === activeWindow.windowName)
            : [];
        return activeMatches.length === 1 ? activeMatches[0] : matches[0];
    }

    private async locatorIsOccupied(locator: AiSessionTmuxLocator): Promise<boolean> {
        const rows = await this.dependencies.client.listWindows();
        return rows.some(row => row.sessionName === locator.sessionName
            && (locator.layout === 'session' || row.windowName === locator.windowName));
    }

    private async migrateAttach(
        pending: AiSessionRuntimeSnapshot,
        promoted: AiSessionRuntimeSnapshot
    ): Promise<void> {
        const oldKey = registryKey(pending);
        const newKey = registryKey(promoted);
        const entry = this.attaches.get(oldKey);
        if (!entry) {
            return;
        }
        const nextBinding = attachBinding(promoted, entry.binding.terminalNamePrefix);
        const updatePersisted = bindingTargetsRuntime(entry.binding, pending);
        const updateFocused = entry.focusedBinding !== undefined
            && bindingTargetsRuntime(entry.focusedBinding, pending);
        const changesRegistry = oldKey !== newKey;
        if (changesRegistry) {
            this.attaches.delete(oldKey);
            this.attaches.set(newKey, entry);
        }
        if (updatePersisted) {
            entry.binding = nextBinding;
            this.persistAttachBinding(
                attachTerminal(entry.terminal).processId,
                nextBinding,
                entry.recoveryToken || null
            );
        }
        if (updateFocused) {
            entry.focusedBinding = nextBinding;
        }
        if (changesRegistry || updatePersisted || updateFocused) {
            entry.focusEpoch++;
        }
        if (updatePersisted) {
            await this.dependencies.attachStore.flush();
        }
    }
}

function finalIdentity(identity: AiSessionRuntimeIdentity & { sessionId: string }): AiSessionRuntimeIdentity {
    return {
        ...cloneAiSessionRuntimeIdentity(identity),
        sessionId: identity.sessionId,
        pendingId: undefined,
    };
}

function runtimeIdentitiesMatch(
    left: AiSessionRuntimeIdentity,
    right: AiSessionRuntimeIdentity
): boolean {
    if (!left || !right || left.provider !== right.provider
        || left.workspaceScopeIdentity !== right.workspaceScopeIdentity) {
        return false;
    }
    if (right.sessionId !== undefined) {
        return left.sessionId === right.sessionId;
    }
    return left.pendingId === right.pendingId
        && (!right.cwd || left.cwd === right.cwd);
}

function runtimeIdentityEquals(
    left: AiSessionRuntimeIdentity | null,
    right: AiSessionRuntimeIdentity | null
): boolean {
    if (!left || !right) {
        return left === right;
    }
    return aiSessionRuntimeIdentitiesEqual(left, right);
}

function bindingTargetsRuntime(
    binding: TmuxAttachBinding | null | undefined,
    runtime: AiSessionRuntimeSnapshot
): boolean {
    if (!binding || !runtime.tmux
        || binding.layout !== runtime.tmux.layout
        || !aiSessionRuntimeIdentitiesEqual(binding, runtime.identity)
        || binding.sessionName !== runtime.tmux.sessionName) {
        return false;
    }
    if (binding.layout === 'project') {
        return binding.windowName === runtime.tmux.windowName;
    }
    return (!binding.provider || binding.provider === runtime.identity.provider)
        && (!binding.sessionId || binding.sessionId === runtime.identity.sessionId)
        && (!binding.windowName || binding.windowName === runtime.tmux.windowName);
}

function getRestoredAttachTerminalName(runtime: AiSessionRuntimeSnapshot): string {
    const identityId = runtime.identity.sessionId || runtime.identity.pendingId || 'runtime';
    const digest = createHash('sha256').update(JSON.stringify([
        runtime.tmux?.layout,
        runtime.identity.provider,
        runtime.identity.workspaceScopeIdentity,
        identityId,
        runtime.tmux?.sessionName,
        runtime.tmux?.windowName || '',
    ]), 'utf8').digest('hex').slice(0, 12);
    return runtime.tmux?.layout === 'project'
        ? `Agent Pivot: tmux project ${digest} [tmux]`
        : `Agent Pivot: ${runtime.identity.provider} ${digest} [tmux]`;
}

function isSafeAttachTerminalName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200
        && !LOCAL_CONTROL_CHARACTERS.test(value);
}

function requireLayout(value: unknown): asserts value is AiSessionTmuxLayout {
    if (value !== 'project' && value !== 'session') {
        throw new Error('The tmux runtime layout must be project or session.');
    }
}

function attachBinding(runtime: AiSessionRuntimeSnapshot, terminalName: string): TmuxAttachBinding {
    if (!runtime.tmux) {
        throw new Error('A tmux attach binding requires a locator.');
    }
    return {
        version: 2,
        layout: runtime.tmux.layout,
        workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: runtime.identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
        cwd: runtime.identity.cwd,
        sessionName: runtime.tmux.sessionName,
        ...(runtime.tmux.windowName
            ? { windowName: runtime.tmux.windowName }
            : {}),
        provider: runtime.identity.provider,
        ...(runtime.identity.sessionId
            ? { sessionId: runtime.identity.sessionId }
            : { pendingId: runtime.identity.pendingId as string }),
        terminalNamePrefix: terminalName,
    };
}

function registryKey(runtime: AiSessionRuntimeSnapshot): string {
    if (runtime.tmux?.layout === 'project') {
        return `project:${runtime.identity.workspaceScopeIdentity}`;
    }
    const identityId = runtime.identity.sessionId || `pending:${runtime.identity.pendingId || ''}`;
    return `session:${runtime.identity.provider}:${identityId}`;
}

function attachTerminal<TTerminal>(terminal: TTerminal): AttachTerminal {
    return terminal as unknown as AttachTerminal;
}

function terminalTitleMatches(title: string, binding: TmuxAttachBinding): boolean {
    return typeof title === 'string' && title.startsWith(binding.terminalNamePrefix);
}

function terminalMatchesBinding(
    terminal: AttachTerminal,
    binding: TmuxAttachBinding,
    launchSessionName: string | null
): boolean {
    if (launchSessionName !== null) {
        return launchSessionName === binding.sessionName
            || terminalTitleMatches(terminal.name, binding);
    }
    if (hasExplicitTerminalLaunch(terminal.creationOptions)) {
        return false;
    }
    return terminalTitleMatches(terminal.name, binding);
}

function getTmuxAttachSessionName(
    creationOptions: AttachTerminal['creationOptions'],
    tmuxExecutablePath: string
): string | null {
    if (!creationOptions || !('shellPath' in creationOptions)
        || creationOptions.shellPath !== tmuxExecutablePath
        || !Array.isArray(creationOptions.shellArgs)) {
        return null;
    }
    const args = creationOptions.shellArgs;
    const targetIndex = args.length === 3
        && args[0] === 'attach-session'
        && args[1] === '-t'
        ? 2
        : args.length === 4
            && args[0] === 'attach-session'
            && args[1] === '-d'
            && args[2] === '-t'
            ? 3
            : -1;
    const sessionName = targetIndex >= 0 ? args[targetIndex] : null;
    return typeof sessionName === 'string' && sessionName.length > 0
        ? sessionName
        : null;
}

function getTmuxAttachRecoveryToken(
    creationOptions: AttachTerminal['creationOptions']
): string | null {
    if (!creationOptions || !('env' in creationOptions) || !creationOptions.env) {
        return null;
    }
    const token = creationOptions.env[TMUX_ATTACH_RECOVERY_ENV];
    return typeof token === 'string' && TMUX_ATTACH_RECOVERY_TOKEN.test(token)
        ? token
        : null;
}

function createAttachRecoveryToken(): string {
    return randomBytes(16).toString('hex');
}

function hasExplicitTerminalLaunch(
    creationOptions: AttachTerminal['creationOptions']
): boolean {
    return Boolean(creationOptions && 'shellPath' in creationOptions
        && (creationOptions.shellPath !== undefined || creationOptions.shellArgs !== undefined));
}

function getTerminalCreationName(terminal: AttachTerminal): string | null {
    const creationOptions = terminal.creationOptions;
    return creationOptions && typeof creationOptions.name === 'string'
        && isSafeAttachTerminalName(creationOptions.name)
        ? creationOptions.name
        : null;
}

function resolveProcessId(value: AttachTerminal['processId']): Promise<number | null> {
    return new Promise(resolve => {
        let settled = false;
        const settle = (processId: number | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0
                ? processId
                : null);
        };
        const timeout = setTimeout(() => settle(undefined), TERMINAL_PROCESS_ID_TIMEOUT_MS);
        Promise.resolve(value).then(settle, () => settle(undefined));
    });
}

function locatorsEqual(left: AiSessionTmuxLocator, right: AiSessionTmuxLocator): boolean {
    return left.layout === right.layout
        && left.sessionName === right.sessionName
        && left.windowName === right.windowName;
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function isProvenNoCreate(error: unknown): boolean {
    return error instanceof TmuxClientError
        && (error.category === 'nonzero-exit' || error.category === 'argument-list-too-long')
        && (error.operation === 'create-session' || error.operation === 'create-window');
}

function unavailableReason(category: string): TmuxRuntimeUnavailableReason {
    switch (category) {
        case 'not-found':
            return 'not-found';
        case 'permission-denied':
            return 'permission-denied';
        case 'timeout':
            return 'probe-timeout';
        case 'invalid-version':
            return 'invalid-version';
        case 'missing-capability':
            return 'missing-capability';
        default:
            return 'probe-failed';
    }
}

function readOnlyRefreshUnavailableError(error: unknown): TmuxRuntimeUnavailableError | null {
    if (!(error instanceof TmuxClientError)
        || !isReadOnlyTmuxOperation(error.operation)
        || (error.category !== 'not-found'
            && error.category !== 'permission-denied'
            && error.category !== 'timeout')) {
        return null;
    }
    return new TmuxRuntimeUnavailableError(
        unavailableReason(error.category),
        error.message
    );
}

function isReadOnlyTmuxOperation(operation: string): boolean {
    return operation === 'check-version'
        || operation === 'list-commands'
        || operation === 'list-windows'
        || operation === 'has-session'
        || operation === 'get-session-options'
        || operation === 'get-window-options';
}
