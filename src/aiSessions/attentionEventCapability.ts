'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../models';
import type { OpenWorkspace } from '../workspaces/types';
import { hasWorkspaceRuntimeContinuity } from '../workspaces/runtimeOwnership';
import type ActiveAiSessionTerminalHighlighter from './activeTerminalHighlight';
import type { ActiveAiSessionTerminalIdentity } from './activeTerminalHighlight';
import type { AttentionAggregate } from './attentionAggregate';
import type { AiSessionAttentionController, AiSessionAttentionEvaluation } from './attentionController';
import type AttentionBridgeClient from './attentionBridgeClient';
import type { AttentionPayloadItem } from './attentionPayload';
import type { AiSessionRuntimeCoordinator } from './runtimeCoordinator';
import { cloneAiSessionRuntimeIdentity } from './runtimeTypes';
import type {
    AiSessionRuntimeConfiguration,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import { getAiSessionKey } from './sessionHelpers';
import type AiSessionTerminalService from './terminalService';
import type { TmuxRuntimeBackend } from './tmuxRuntimeBackend';
import type { TmuxRuntimeBindingStore } from './tmuxRuntimeBindingStore';
import type { TmuxFocusedRuntimeMonitor } from './tmuxFocusedRuntimeMonitor';
import { findTmuxCollisionRuntime, TmuxRuntimeDiscovery } from './tmuxRuntimeDiscovery';
import type { AiSessionTerminalEntry } from './types';

// Mirrors vscode.TerminalExitReason.User. The extension's minimum VS Code typings
// predate TerminalExitStatus.reason, while supported hosts expose it at runtime.
const USER_TERMINAL_EXIT_REASON = 3;

export interface AiSessionAttentionRuntimeOverride {
    providerId: AiSessionProviderId;
    sessionId: string;
    attentionKey: string;
    runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
}

export interface AiSessionAttentionEventCapabilityOptions {
    tmuxRuntimeDiscovery: TmuxRuntimeDiscovery;
    tmuxRuntimeBackend: TmuxRuntimeBackend<vscode.Terminal>;
    tmuxRuntimeStore: TmuxRuntimeBindingStore;
    aiSessionTerminalService: AiSessionTerminalService;
    getRuntimeConfiguration: () => AiSessionRuntimeConfiguration;
    getCurrentOpenWorkspace: () => OpenWorkspace | null;
    getActiveTerminal: () => vscode.Terminal | null;
    postAttentionState: () => void;
    isVisible: () => boolean;
    assertActive: () => void;
    createBridgeClient: (
        onAggregate: (aggregate: AttentionAggregate) => void,
        onError: (error: unknown) => void
    ) => AttentionBridgeClient;
    onDidOpenTerminal: (callback: (terminal: vscode.Terminal) => void) => vscode.Disposable;
    onDidChangeActiveTerminal: (callback: () => void) => vscode.Disposable;
    onDidCloseTerminal: (callback: (terminal: vscode.Terminal) => void) => vscode.Disposable;
    logError: (message: string, error: unknown) => void;
    logAiSessionRuntimeFailure: (operation: string, error: unknown) => void;
    /** Late-bound: the coordinator is constructed after this capability. */
    getRuntimeCoordinator: () => AiSessionRuntimeCoordinator<vscode.Terminal>;
    /** Late-bound: the controller is constructed after this capability. */
    getAttentionController: () => AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>;
    /** Late-bound: the settlement capability is constructed after this capability. */
    runSafeLifecycleTask: (
        operation: string,
        task: () => unknown | Promise<unknown>
    ) => Promise<void>;
    /** Late-bound: the status capability tick is wired after this capability. */
    evaluateLifecycleTick: () => void;
    /** Late-bound: the dashboard controller is constructed after this capability. */
    refreshViewsNow: (reason?: string) => void;
    /** Late-bound: the dashboard controller is constructed after this capability. */
    scheduleRefresh: (reason: string) => void;
    /** Late-bound: the open-workspace controller may never be constructed. */
    postOpenWorkspacesUpdated: () => void;
    /** Late-bound: the highlighter is constructed after this capability. */
    getActiveTerminalHighlighter: () =>
        ActiveAiSessionTerminalHighlighter<vscode.Terminal, AiSessionTerminalEntry<vscode.Terminal>>;
    /** Late-bound: the monitor is constructed after this capability. */
    getTmuxFocusedRuntimeMonitor: () => TmuxFocusedRuntimeMonitor<vscode.Terminal>;
    publishRestoredAttachTerminal: () => void;
}

export interface AiSessionAttentionEventCapability {
    evaluateAttention(
        runtimeOverrides?: ReadonlyArray<AiSessionAttentionRuntimeOverride>
    ): Promise<AiSessionAttentionEvaluation>;
    hasLiveTmuxOwnership(): Promise<boolean>;
    getRuntimeById(
        providerId: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    getRuntimeCollision(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    getFocusedRuntimeIdentity(): AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    belongsToCurrentWorkspace(runtime: AiSessionRuntimeSnapshot<vscode.Terminal>): boolean;
    refreshViewsIncrementally(): void;
    scheduleViewsRefresh(): void;
    postAttentionState(): void;
    acknowledgeEventIds(eventIds: string[]): Promise<void>;
    acknowledgeAttention(identity: ActiveAiSessionTerminalIdentity): Promise<void>;
    publish(items: AttentionPayloadItem[], forceHeartbeat?: boolean): Promise<boolean>;
    readonly bridgeClient: AttentionBridgeClient;
    startBridgeClient(): void;
    setDeferredRestoreSettled(): void;
    setDeferredRestoreRefreshReady(ready: boolean): void;
    publishDeferredRestoreIfReady(): void;
    registerTerminalRestoreHandler(): vscode.Disposable;
    registerTerminalEventHandlers(): vscode.Disposable;
    dispose(): void;
}

/**
 * Owns the AI session attention event plumbing extracted from activate() in
 * src/dashboard.ts: the attention evaluation with its fail-open tmux relevance
 * and ownership probes, the runtime lookups, the attention bridge client, the
 * deferred tmux-restore refresh state, and the terminal open/active/close
 * event handlers. Behaviour is unchanged; only the ownership moved.
 */
export function createAiSessionAttentionEventCapability(
    options: AiSessionAttentionEventCapabilityOptions
): AiSessionAttentionEventCapability {
    const tmuxRuntimeDiscovery = options.tmuxRuntimeDiscovery;
    const tmuxRuntimeBackend = options.tmuxRuntimeBackend;
    const tmuxRuntimeStore = options.tmuxRuntimeStore;
    const aiSessionTerminalService = options.aiSessionTerminalService;
    const getRuntimeConfiguration = options.getRuntimeConfiguration;
    const getCurrentOpenWorkspace = options.getCurrentOpenWorkspace;
    const getActiveTerminal = options.getActiveTerminal;
    const postAttentionState = options.postAttentionState;
    const isVisible = options.isVisible;
    const assertActive = options.assertActive;
    const createBridgeClient = options.createBridgeClient;
    const onDidOpenTerminal = options.onDidOpenTerminal;
    const onDidChangeActiveTerminal = options.onDidChangeActiveTerminal;
    const onDidCloseTerminal = options.onDidCloseTerminal;
    const logError = options.logError;
    const logAiSessionRuntimeFailure = options.logAiSessionRuntimeFailure;
    const getRuntimeCoordinator = options.getRuntimeCoordinator;
    const getAttentionController = options.getAttentionController;
    const runSafeAiSessionRuntimeLifecycleTask = options.runSafeLifecycleTask;
    const evaluateAiSessionLifecycleTick = options.evaluateLifecycleTick;
    const refreshViewsNow = options.refreshViewsNow;
    const scheduleRefresh = options.scheduleRefresh;
    const postOpenWorkspacesUpdated = options.postOpenWorkspacesUpdated;
    const getActiveTerminalHighlighter = options.getActiveTerminalHighlighter;
    const getTmuxFocusedRuntimeMonitor = options.getTmuxFocusedRuntimeMonitor;
    const publishRestoredAttachTerminal = options.publishRestoredAttachTerminal;

    let aiSessionAttentionBridgeClient: AttentionBridgeClient;
    let deferredTmuxRestoreSettled = false;
    let deferredTmuxRestoreRefreshReady = false;
    let deferredTmuxRestoreRefreshPublished = false;

    async function evaluateAiSessionAttention(
        runtimeOverrides: ReadonlyArray<{
            providerId: AiSessionProviderId;
            sessionId: string;
            attentionKey: string;
            runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
        }> = []
    ): Promise<AiSessionAttentionEvaluation> {
        try {
            await tmuxRuntimeDiscovery.loadPersistedInactive();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-inactive-restore', error);
        }
        const hasRelevantTmux = await hasRelevantTmuxRuntime();
        if (hasRelevantTmux && await hasLiveTmuxOwnership()) {
            try {
                await getRuntimeCoordinator().refreshForHost(false);
            } catch (error) {
                logAiSessionRuntimeFailure('attention-refresh', error);
            }
        }
        return getAttentionController().evaluate(runtimeOverrides);
    }

    async function hasLiveTmuxOwnership(): Promise<boolean> {
        if (getRuntimeConfiguration().mode === 'tmux'
            || tmuxRuntimeDiscovery.getActive().length
            || tmuxRuntimeDiscovery.getPending().length
            || tmuxRuntimeBackend.getConflicts().length) {
            return true;
        }
        try {
            const [known, pending] = await Promise.all([
                tmuxRuntimeStore.listKnown(),
                tmuxRuntimeStore.listPending(),
            ]);
            return known.length > 0 || pending.length > 0;
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    async function hasRelevantTmuxRuntime(): Promise<boolean> {
        if (tmuxRuntimeDiscovery.getInactive().length) {
            return true;
        }
        try {
            const inactive = await tmuxRuntimeStore.listInactive();
            return inactive.length > 0 || await hasLiveTmuxOwnership();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    function getAiSessionRuntimeById(
        providerId: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        const workspace = getCurrentOpenWorkspace();
        if (!workspace) {
            return null;
        }
        const workspaceScopeIdentity = workspace.scopeIdentity;
        const collision = getAiSessionRuntimeCollision(
            providerId, sessionId, workspaceScopeIdentity
        );
        if (collision) {
            return collision;
        }
        const live = getRuntimeCoordinator().getById(
            providerId, sessionId, workspaceScopeIdentity
        );
        const liveConflicts = getRuntimeCoordinator().getActive().filter(runtime =>
            runtime.identity.provider === providerId && runtime.identity.sessionId === sessionId
            && hasWorkspaceRuntimeContinuity(workspace, runtime));
        if (liveConflicts.length === 1) {
            return liveConflicts[0];
        }
        if (liveConflicts.length > 1) {
            return { ...liveConflicts[0], state: 'conflict' };
        }
        if (live) {
            return live;
        }
        const inactiveTmux: AiSessionRuntimeSnapshot<vscode.Terminal>[] = tmuxRuntimeDiscovery.getInactive()
            .filter(runtime => runtime.identity.provider === providerId
                && runtime.identity.sessionId === sessionId
                && hasWorkspaceRuntimeContinuity(workspace, runtime))
            .map(runtime => {
                const { terminal: _terminal, ...detached } = runtime;
                return {
                    ...detached,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                };
            });
        const completedDirect = aiSessionTerminalService.getTrackedTerminalEntries()
            .filter(entry => entry.provider === providerId && entry.sessionId === sessionId
                && aiSessionTerminalService.isComplete(entry) && !!entry.runtimeIdentity
                && hasWorkspaceRuntimeContinuity(workspace, {
                    identity: entry.runtimeIdentity,
                }))
            .map(entry => ({
                identity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity),
                backend: 'vscode' as const,
                state: 'completed' as const,
                markerPath: entry.markerPath,
                runStartedAtMs: entry.runStartedAtMs,
                attached: true,
                terminal: entry.terminal,
            }));
        const inactive = [...inactiveTmux, ...completedDirect];
        return inactive.length === 1 ? inactive[0] : null;
    }

    function getAiSessionRuntimeCollision(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        return findTmuxCollisionRuntime(
            tmuxRuntimeDiscovery.getDiagnostics(), providerId, sessionId,
            workspaceScopeIdentity
        ) as AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    }

    function getFocusedAiSessionRuntimeIdentity() {
        const activeTerminal = getActiveTerminal();
        const tmuxRuntime = tmuxRuntimeBackend.getFocusedRuntime(activeTerminal);
        return tmuxRuntime && runtimeBelongsToCurrentWorkspace(tmuxRuntime)
            ? tmuxRuntime.identity
            : getActiveTerminalHighlighter().getIdentity();
    }

    function runtimeBelongsToCurrentWorkspace(
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>
    ): boolean {
        const workspace = getCurrentOpenWorkspace();
        return !!workspace && hasWorkspaceRuntimeContinuity(workspace, runtime);
    }

    function scheduleAttentionViewsRefresh() {
        scheduleRefresh('attention');
        postOpenWorkspacesUpdated();
    }

    function refreshAiSessionViewsIncrementally() {
        void refreshViewsNow();
    }

    function publishDeferredTmuxRestoreIfReady(): void {
        if (!deferredTmuxRestoreSettled
            || !deferredTmuxRestoreRefreshReady
            || deferredTmuxRestoreRefreshPublished
            || !isVisible()) {
            return;
        }
        try {
            assertActive();
        } catch (_error) {
            return;
        }
        deferredTmuxRestoreRefreshPublished = true;
        void refreshViewsNow('tmux-bootstrap-restore');
    }

    function postAiSessionAttentionState() {
        postAttentionState();
    }

    const getAiSessionAttentionEventIds = (identity: ActiveAiSessionTerminalIdentity): string[] => {
        const sessionKey = getAiSessionKey(identity.provider, identity.sessionId);
        return getAttentionController().getRecoverySessionEvents()
            .find(session => session.sessionKey === sessionKey)?.eventIds || [];
    };
    const acknowledgeAiSessionAttentionEventIds = async (eventIds: string[]): Promise<void> => {
        const uniqueEventIds = Array.from(new Set(eventIds.filter(eventId => Boolean(eventId))));
        if (!uniqueEventIds.length) {
            return;
        }
        getAttentionController().acknowledge(uniqueEventIds);
        refreshAiSessionViewsIncrementally();
        await aiSessionAttentionBridgeClient.acknowledge(uniqueEventIds);
    };
    const acknowledgeAiSessionAttention = async (
        identity: ActiveAiSessionTerminalIdentity
    ): Promise<void> => {
        await acknowledgeAiSessionAttentionEventIds(getAiSessionAttentionEventIds(identity));
    };

    function startBridgeClient(): void {
        aiSessionAttentionBridgeClient = createBridgeClient(
            aggregate => {
                if (getAttentionController().setRemoteAggregate(aggregate)) {
                    scheduleAttentionViewsRefresh();
                }
            },
            error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
        );
    }

    function setDeferredRestoreSettled(): void {
        deferredTmuxRestoreSettled = true;
    }

    function setDeferredRestoreRefreshReady(ready: boolean): void {
        deferredTmuxRestoreRefreshReady = ready;
    }


    function registerTerminalRestoreHandler(): vscode.Disposable {
        const openListener = onDidOpenTerminal(terminal => {
            if (!tmuxRuntimeBackend.isAttachTerminalCandidate(terminal)) {
                return;
            }
            void tmuxRuntimeBackend.restoreAttachTerminals([terminal]).then(
                () => publishRestoredAttachTerminal(),
                error => logAiSessionRuntimeFailure('restore-opened-tmux-attach-terminal', error)
            );
        });
        return {
            dispose: () => {
                openListener.dispose();
            },
        };
    }

    function registerTerminalEventHandlers(): vscode.Disposable {
        const activeListener = onDidChangeActiveTerminal(() => {
            getActiveTerminalHighlighter().sync();
            void getTmuxFocusedRuntimeMonitor().request();
            refreshAiSessionViewsIncrementally();
            void runSafeAiSessionRuntimeLifecycleTask(
                'evaluate-attention-active-terminal', evaluateAiSessionAttention
            );
        });
        const closeListener = onDidCloseTerminal(terminal => {
            const closedRuntimes = getRuntimeCoordinator().getActive()
                .filter(runtime => runtime.backend === 'vscode' && runtime.terminal === terminal
                    && Boolean(runtime.identity.sessionId));
            const exitStatus = terminal.exitStatus as
                (vscode.TerminalExitStatus & { reason?: number }) | undefined;
            const userClosedTerminal = exitStatus?.reason === USER_TERMINAL_EXIT_REASON;
            const closedSessions: ActiveAiSessionTerminalIdentity[] = closedRuntimes.map(runtime => ({
                provider: runtime.identity.provider,
                sessionId: runtime.identity.sessionId as string,
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
            }));
            const hadRuntimeClient = [...getRuntimeCoordinator().getActive(), ...getRuntimeCoordinator().getPending()]
                .some(runtime => runtime.terminal === terminal);
            getRuntimeCoordinator().handleClosedTerminal(terminal);
            evaluateAiSessionLifecycleTick();
            getActiveTerminalHighlighter().handleTerminalClosed(terminal);
            if (closedSessions.length || hadRuntimeClient) {
                refreshAiSessionViewsIncrementally();
                if (userClosedTerminal) {
                    void runSafeAiSessionRuntimeLifecycleTask(
                        'acknowledge-user-terminal-close',
                        async () => {
                            for (const identity of closedSessions) {
                                await acknowledgeAiSessionAttention(identity);
                            }
                        }
                    );
                }
                void runSafeAiSessionRuntimeLifecycleTask(
                    'evaluate-attention-closed-terminal', evaluateAiSessionAttention
                );
            }
        });
        return {
            dispose: () => {
                activeListener.dispose();
                closeListener.dispose();
            },
        };
    }

    return {
        evaluateAttention: evaluateAiSessionAttention,
        hasLiveTmuxOwnership,
        getRuntimeById: getAiSessionRuntimeById,
        getRuntimeCollision: getAiSessionRuntimeCollision,
        getFocusedRuntimeIdentity: getFocusedAiSessionRuntimeIdentity,
        belongsToCurrentWorkspace: runtimeBelongsToCurrentWorkspace,
        refreshViewsIncrementally: refreshAiSessionViewsIncrementally,
        scheduleViewsRefresh: scheduleAttentionViewsRefresh,
        postAttentionState: postAiSessionAttentionState,
        acknowledgeEventIds: acknowledgeAiSessionAttentionEventIds,
        acknowledgeAttention: acknowledgeAiSessionAttention,
        publish: (items, forceHeartbeat) => aiSessionAttentionBridgeClient.publish(items, forceHeartbeat),
        get bridgeClient() { return aiSessionAttentionBridgeClient; },
        startBridgeClient,
        setDeferredRestoreSettled,
        setDeferredRestoreRefreshReady,
        publishDeferredRestoreIfReady: publishDeferredTmuxRestoreIfReady,
        registerTerminalRestoreHandler,
        registerTerminalEventHandlers,
        dispose: () => {
            aiSessionAttentionBridgeClient?.dispose();
        },
    };
}
