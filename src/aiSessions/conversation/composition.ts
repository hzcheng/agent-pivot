'use strict';

import * as childProcess from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_PIVOT_DASHBOARD_VIEW_ID } from '../../constants';
import type { AiSessionProviderId } from '../../models';
import type {
    ActiveAiSessionViewModel,
    AiSessionDisposable,
    AiSessionService,
} from '../types';
import type { ConversationAuthoritativeTarget } from './displayMetadata';
import {
    ClaudeConversationAdapter,
    ClaudeConversationAdapterOptions,
} from './claudeAdapter';
import {
    CodexConversationAdapter,
    CodexConversationAdapterOptions,
    CodexConversationClient,
} from './codexAdapter';
import {
    CodexAppServerClient,
    CodexAppServerClientOptions,
} from './codexAppServerClient';
import type { ConversationCommentStore } from './commentStore';
import type { ProjectCommentStore } from './projectCommentStore';
import type { ConversationBookmarkStore } from './bookmarkStore';
import {
    ConversationCoordinator,
    ConversationCoordinatorOptions,
} from './coordinator';
import {
    KimiConversationAdapter,
    KimiConversationAdapterOptions,
} from './kimiAdapter';
import {
    ConversationAbortController,
    ConversationError,
    ConversationProviderAdapter,
    ConversationSnapshot,
    SanitizedConversationDiagnostic,
} from './types';
import {
    ConversationViewer,
    ConversationViewerApi,
    ConversationViewerOptions,
    ConversationViewerTarget,
} from './viewer';
import type { ConversationSessionSwitchDirection } from './viewerProtocol';
import {
    parseConversationViewerRestoreTarget,
} from './viewerRestoreState';
import { ConversationWorktreeResolver } from './worktreeResolver';
import type { ConversationChangesControllerOptions } from './conversationChangesController';
import { ChangesCollector } from '../../worktrees';
import { CommitsCollector } from '../../worktrees';
import { readCodexRolloutTelemetry } from '../codexRolloutWorkdir';
import CodexRolloutGoalTurnsReader from '../codexRolloutGoalTurns';
import {
    readCodexRolloutContentSignature,
    readCodexRolloutSourceBytes,
} from '../codexRolloutContentSignature';
import { encodeSubagentSessionId } from './subagentSessions';

export interface ConversationSessionOpenTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export type OpenLatestConversationResult =
    'opened' | 'unavailable' | 'empty' | 'unknownSession' | 'superseded';
export type FollowActiveConversationResult =
    OpenLatestConversationResult | 'closed';
export type FollowAdjacentConversationResult =
    FollowActiveConversationResult | 'inactive' | 'noAdjacentSession';

export interface ConversationCapability {
    viewer: ConversationViewerApi;
    availability: 'available' | 'unavailable';
    openLatestConversation(
        target: ConversationSessionOpenTarget
    ): Promise<OpenLatestConversationResult>;
    openLatestActiveConversation(
        target: ConversationSessionOpenTarget
    ): Promise<OpenLatestConversationResult>;
    followActiveConversation(
        target: ConversationSessionOpenTarget
    ): Promise<FollowActiveConversationResult>;
    followAdjacentActiveConversation(
        direction: ConversationSessionSwitchDirection
    ): Promise<FollowAdjacentConversationResult>;
    restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
    rebindSession(
        previous: ConversationSessionOpenTarget,
        next: ConversationSessionOpenTarget
    ): Promise<boolean>;
    freezeSessionMetadata(
        target: ConversationSessionOpenTarget
    ): Promise<boolean>;
    reconcile(): Promise<void>;
    dispose(): void;
}

export interface ConversationCapabilityOptions {
    services: Record<AiSessionProviderId, AiSessionService>;
    resolveTarget: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string
    ) => ConversationAuthoritativeTarget | null;
    resolveActiveTargets?: (
        projectId: string
    ) => readonly ActiveAiSessionViewModel[];
    resolveWorkspaceName?: (
        projectId: string
    ) => string;
    publish: (message: unknown) => Thenable<boolean>;
    createPanel: typeof vscode.window.createWebviewPanel;
    openExternal: typeof vscode.env.openExternal;
    openLocalFile?: ConversationViewerOptions['openLocalFile'];
    spawnCodex: typeof childProcess.spawn;
    now: () => number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    onDiagnostic: (event: SanitizedConversationDiagnostic) => void;
    getWorkspaceRootHostPaths?: () => readonly string[];
    /**
     * Changes-panel wiring (changes-panel PRD): session identity
     * resolution, manifest access, and diff/SCM actions. Absent disables
     * the Changes button and sidebar tab.
     */
    changes?: Omit<
        ConversationChangesControllerOptions,
        'getPanel' | 'getTarget' | 'getSubscriptionGeneration'
        | 'isSuspended' | 'resolveWorktreeKey' | 'collector'
        | 'commitsCollector'
    >;
    insertIntoActiveTerminal?: (
        text: string
    ) => PromiseLike<void> | Promise<void> | void;
    runCommandInNewTerminal?: ConversationViewerOptions['runCommandInNewTerminal'];
    /** Rename the viewer's current session (host owns the rename UX). */
    renameSession?: (
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ) => PromiseLike<void> | Promise<void> | void;
    submitPrompt: (
        target: ConversationViewerTarget,
        prompt: string
    ) => PromiseLike<void> | Promise<void>;
    focusSession?: (
        target: ConversationSessionOpenTarget
    ) => boolean | void | PromiseLike<boolean | void>;
    syncSession?: (
        target: ConversationSessionOpenTarget
    ) => boolean | void | PromiseLike<boolean | void>;
    commentStore?: ConversationCommentStore;
    projectCommentStore?: ProjectCommentStore;
    bookmarkStore?: ConversationBookmarkStore;
    getShowThinking?: () => boolean;
    readSessionStatus?: ConversationViewerOptions['readSessionStatus'];
    cycleLocalSessionStatus?: ConversationViewerOptions['cycleLocalSessionStatus'];
    acknowledgeSessionAttention?: ConversationViewerOptions['acknowledgeSessionAttention'];
    switchAdjacentWindow?: ConversationViewerOptions['switchAdjacentWindow'];
    /**
     * The context window declared by the Codex profile overlay a session runs
     * with, if any. Injected for the codex adapter's telemetry display: the
     * app-server under-reports custom provider model windows. The model lets
     * the implementation match sessions started outside the extension.
     */
    getCodexSessionProfileContextWindow?: (sessionId: string, model?: string) => number | undefined;
    setConversationFocusContext?: (
        focused: boolean
    ) => PromiseLike<void> | Promise<void> | void;
    resolveReboundTarget?: (
        target: ConversationSessionOpenTarget
    ) => ConversationSessionOpenTarget;
}

interface ConversationCapabilityInternalFactories {
    createCodexClient(
        options: CodexAppServerClientOptions
    ): CodexConversationClient;
    createCodexAdapter(
        options: CodexConversationAdapterOptions
    ): ConversationProviderAdapter;
    createKimiAdapter(
        options: KimiConversationAdapterOptions
    ): ConversationProviderAdapter;
    createClaudeAdapter(
        options: ClaudeConversationAdapterOptions
    ): ConversationProviderAdapter;
    createCoordinator(
        options: ConversationCoordinatorOptions
    ): ConversationCoordinator;
    createViewer(options: ConversationViewerOptions): ConversationViewerApi;
}

const DEFAULT_FACTORIES: ConversationCapabilityInternalFactories = {
    createCodexClient: options => new CodexAppServerClient(options),
    createCodexAdapter: options => new CodexConversationAdapter(options),
    createKimiAdapter: options => new KimiConversationAdapter(options),
    createClaudeAdapter: options => new ClaudeConversationAdapter(options),
    createCoordinator: options => new ConversationCoordinator(options),
    createViewer: options => new ConversationViewer(options),
};

export function createConversationCapability(
    options: ConversationCapabilityOptions
): ConversationCapability;
export function createConversationCapability(
    options: ConversationCapabilityOptions,
    internalFactories: Partial<ConversationCapabilityInternalFactories> = {}
): ConversationCapability {
    const ownership = createConstructionOwnership();
    try {
        return createAvailableConversationCapability(
            options,
            { ...DEFAULT_FACTORIES, ...internalFactories },
            ownership
        );
    } catch (_error) {
        ownership.dispose();
        reportUnavailable(options.onDiagnostic);
        return createUnavailableConversationCapability();
    }
}

function createAvailableConversationCapability(
    options: ConversationCapabilityOptions,
    factories: ConversationCapabilityInternalFactories,
    ownership: ConstructionOwnership
): ConversationCapability {
    const codexClient = ownership.own(factories.createCodexClient({
        // Unlocks thread/turns/list for incremental large-session reloads.
        // The adapter treats it strictly as an accelerator: version-gated
        // and backed by the stable thread/read fallback on any anomaly.
        experimentalApi: true,
        spawn: options.spawnCodex as unknown as CodexAppServerClientOptions['spawn'],
        resolveExecutable: () => 'codex',
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    }));
    const worktreeResolver = new ConversationWorktreeResolver({
        now: options.now,
        canonicalizePath: candidatePath =>
            fs.promises.realpath(candidatePath)
                .catch(() => path.resolve(candidatePath)),
    });
    const codexGoalTurns = new CodexRolloutGoalTurnsReader();
    const changesCollector = new ChangesCollector({ now: options.now });
    const commitsCollector = new CommitsCollector();
    const codexAdapter = ownership.own(factories.createCodexAdapter({
        client: codexClient,
        watchSessionChanges: onDidChange =>
            options.services.codex.watchSessionChanges(onDidChange),
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        resolveWorktree: candidatePath =>
            worktreeResolver.resolve(candidatePath),
        readRolloutTelemetry: sessionId => {
            const rolloutPath = options.services.codex
                .resolveSessionFilePath?.(sessionId);
            return rolloutPath
                ? readCodexRolloutTelemetry(rolloutPath)
                : undefined;
        },
        readGoalTurns: sessionId => {
            const rolloutPath = options.services.codex
                .resolveSessionFilePath?.(sessionId);
            return rolloutPath
                ? codexGoalTurns.read(rolloutPath)
                : undefined;
        },
        readContentSignature: sessionId => {
            const rolloutPath = options.services.codex
                .resolveSessionFilePath?.(sessionId);
            return rolloutPath
                ? readCodexRolloutContentSignature(rolloutPath)
                : undefined;
        },
        readSourceBytes: sessionId => {
            const rolloutPath = options.services.codex
                .resolveSessionFilePath?.(sessionId);
            return rolloutPath
                ? readCodexRolloutSourceBytes(rolloutPath)
                : undefined;
        },
        readLifecycleSignal: sessionId =>
            options.services.codex.getConversationLifecycleSignal?.(
                sessionId
            ),
        listSubagentThreads: sessionId =>
            options.services.codex.listSubagentThreads?.(sessionId) || [],
        getSessionProfileContextWindow: options.getCodexSessionProfileContextWindow,
    }));
    ownership.transfer(codexClient);
    const kimiAdapter = ownership.own(factories.createKimiAdapter({
        resolveSource: sessionId =>
            options.services.kimi.resolveConversationSource?.(sessionId)
            || null,
        watchSessionChanges: onDidChange =>
            options.services.kimi.watchSessionChanges(onDidChange),
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        resolveWorktree: candidatePath =>
            worktreeResolver.resolve(candidatePath),
    }));
    const claudeAdapter = ownership.own(factories.createClaudeAdapter({
        resolveSource: sessionId =>
            options.services.claude.resolveConversationSource?.(
                sessionId,
                getWorkspaceRootHostPaths(options)
            ) || null,
        watchSessionChanges: onDidChange =>
            options.services.claude.watchSessionChanges(onDidChange),
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        resolveWorktree: candidatePath =>
            worktreeResolver.resolve(candidatePath),
    }));
    const adapters: Record<AiSessionProviderId, ConversationProviderAdapter> = {
        codex: codexAdapter,
        kimi: kimiAdapter,
        claude: claudeAdapter,
    };
    const coordinator = ownership.own(factories.createCoordinator({
        adapters,
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    }));
    ownership.transfer(codexAdapter);
    ownership.transfer(kimiAdapter);
    ownership.transfer(claudeAdapter);
    const snapshotWarmup = typeof coordinator.readSnapshot === 'function'
        && typeof coordinator.setSessionStopped === 'function'
        ? ownership.own(new ConversationSnapshotWarmup({
            readSnapshot: coordinator.readSnapshot.bind(coordinator),
            setSessionStopped: coordinator.setSessionStopped.bind(coordinator),
            resolveActiveTargets: options.resolveActiveTargets,
            now: options.now,
            setTimer: options.setTimer,
            clearTimer: options.clearTimer,
        }))
        : undefined;
    let focusTail: Promise<void> = Promise.resolve();
    const queueFocus = (
        operation: () => void | PromiseLike<void>,
        isCurrent: () => boolean
    ): Promise<boolean> => {
        const pending = focusTail.then(async () => {
            if (!isCurrent()) {
                return false;
            }
            await operation();
            return true;
        });
        focusTail = pending.then(() => undefined, () => undefined);
        return pending;
    };
    const queueTerminalFocus = (
        target: ConversationSessionOpenTarget,
        isCurrent: () => boolean
    ): Promise<boolean> => queueFocus(
        async () => {
            const focused = await (options.syncSession || options.focusSession)?.(
                target
            );
            if (focused === false) {
                throw new Error('AI session terminal focus was rejected');
            }
        },
        isCurrent
    );
    const viewer = ownership.own(factories.createViewer({
        createPanel: options.createPanel,
        readSnapshot: typeof coordinator.readSnapshot === 'function'
            ? coordinator.readSnapshot.bind(coordinator)
            : undefined,
        readOutline: coordinator.readOutline.bind(coordinator),
        readPage: coordinator.readPage.bind(coordinator),
        readSubagents: typeof coordinator.readSubagents === 'function'
            ? coordinator.readSubagents.bind(coordinator)
            : undefined,
        readTelemetry: coordinator.readTelemetry.bind(coordinator),
        watch: coordinator.watch.bind(coordinator),
        restoreFocus: target => restoreConversationFocus(options, target),
        openExternal: options.openExternal,
        openLocalFile: options.openLocalFile,
        mediaUri: getConversationMediaUri,
        showThinking: options.getShowThinking,
        readSessionStatus: options.readSessionStatus,
        cycleLocalSessionStatus: options.cycleLocalSessionStatus,
        acknowledgeSessionAttention: options.acknowledgeSessionAttention,
        switchAdjacentWindow: options.switchAdjacentWindow,
        submitPrompt: options.submitPrompt,
        focusSession: options.focusSession,
        commentStore: options.commentStore,
        projectCommentStore: options.projectCommentStore,
        bookmarkStore: options.bookmarkStore,
        insertIntoActiveTerminal: options.insertIntoActiveTerminal,
        runCommandInNewTerminal: options.runCommandInNewTerminal,
        renameSession: options.renameSession,
        changes: options.changes
            ? {
                ...options.changes,
                resolveWorktreeKey: candidatePath =>
                    worktreeResolver.resolveKey(candidatePath),
                collector: changesCollector,
                commitsCollector,
            }
            : undefined,
        followAdjacentConversation: (direction, currentTarget) => {
            const intentGeneration = ++viewerIntentGeneration;
            return followAdjacentConversation(
                options,
                coordinator,
                viewer,
                direction,
                currentTarget,
                () => intentGeneration === viewerIntentGeneration,
                queueTerminalFocus,
                terminalAuthority,
                snapshotWarmup
            );
        },
        setKeyboardFocus: options.setConversationFocusContext,
        onDiagnostic: options.onDiagnostic
            ? event => options.onDiagnostic(event as never)
            : undefined,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
    }));
    const queueConversationFocus = (
        _target: ConversationSessionOpenTarget,
        isCurrent: () => boolean
    ): Promise<boolean> => queueFocus(() => {
        viewer.focus();
    }, isCurrent);
    const terminalAuthority: {
        confirmedTarget?: ConversationViewerTarget;
    } = {};
    let viewerIntentGeneration = 0;
    let disposed = false;
    return {
        viewer,
        availability: 'available',
        openLatestConversation: target => {
            const intentGeneration = ++viewerIntentGeneration;
            return openLatestConversation(
                options,
                coordinator,
                viewer,
                target,
                () => intentGeneration === viewerIntentGeneration,
                snapshotWarmup
            );
        },
        async openLatestActiveConversation(
            target: ConversationSessionOpenTarget
        ): Promise<OpenLatestConversationResult> {
            const intentGeneration = ++viewerIntentGeneration;
            const result = await openLatestConversation(
                options,
                coordinator,
                viewer,
                target,
                () => intentGeneration === viewerIntentGeneration,
                snapshotWarmup
            );
            if (result === 'opened') {
                const currentTarget = viewer.getCurrentTarget();
                if (currentTarget
                    && hasSameConversationSession(currentTarget, target)) {
                    terminalAuthority.confirmedTarget =
                        cloneConversationViewerTarget(currentTarget);
                }
            }
            return result;
        },
        async followActiveConversation(
            target: ConversationSessionOpenTarget
        ): Promise<FollowActiveConversationResult> {
            if (!viewer.isOpen()) {
                return 'closed';
            }
            const intentGeneration = ++viewerIntentGeneration;
            const resolution = await resolveLatestConversationTarget(
                options,
                coordinator,
                target,
                undefined,
                undefined,
                snapshotWarmup
            );
            if (intentGeneration !== viewerIntentGeneration) {
                return 'superseded';
            }
            if (resolution.result !== 'opened') {
                reportFollowFailure(
                    options.onDiagnostic,
                    target.provider,
                    resolution.result,
                    resolution.diagnostic
                );
                viewer.showNotice(
                    conversationFollowNoticeText(resolution.result)
                );
                return resolution.result;
            }
            if (!viewer.isOpen()) {
                return 'closed';
            }
            const followed = await viewer.follow(
                resolution.viewerTarget,
                resolution.snapshot
            );
            if (followed) {
                snapshotWarmup?.afterLoad(
                    resolution.viewerTarget,
                    resolution.prefetchedSnapshot === true,
                    viewer
                );
                const currentTarget = viewer.getCurrentTarget();
                terminalAuthority.confirmedTarget =
                    cloneConversationViewerTarget(
                        currentTarget
                            && hasSameConversationSession(
                                currentTarget,
                                resolution.viewerTarget
                            )
                            ? currentTarget
                            : resolution.viewerTarget
                    );
            }
            return followed ? 'opened' : 'closed';
        },
        async followAdjacentActiveConversation(
            direction: ConversationSessionSwitchDirection
        ): Promise<FollowAdjacentConversationResult> {
            const currentTarget = viewer.getCurrentTarget();
            if (!currentTarget) {
                return viewer.isOpen() ? 'inactive' : 'closed';
            }
            const intentGeneration = ++viewerIntentGeneration;
            const isCurrent = () =>
                intentGeneration === viewerIntentGeneration;
            try {
                return await followAdjacentConversation(
                    options,
                    coordinator,
                    viewer,
                    direction,
                    currentTarget,
                    isCurrent,
                    queueTerminalFocus,
                    terminalAuthority,
                    snapshotWarmup
                );
            } finally {
                // A terminal focus from an older Webview switch may already
                // be running. Queue the command's Conversation refocus for
                // every result, including no-adjacent and failed loads.
                try {
                    await queueConversationFocus(currentTarget, isCurrent);
                } catch (_error) {
                    // Preserve the authoritative switch result if reveal fails.
                }
            }
        },
        async restorePanel(
            panel: vscode.WebviewPanel,
            state: unknown
        ): Promise<void> {
            const savedTarget = parseConversationViewerRestoreTarget(state);
            if (!savedTarget || disposed) {
                panel.dispose();
                return;
            }
            const intentGeneration = ++viewerIntentGeneration;
            const reboundTarget = options.resolveReboundTarget?.(savedTarget)
                || savedTarget;
            const reboundRootChanged = reboundTarget.projectId
                !== savedTarget.projectId
                || reboundTarget.provider !== savedTarget.provider
                || reboundTarget.sessionId !== savedTarget.sessionId;
            const resolution = await resolveLatestConversationTarget(
                options,
                coordinator,
                reboundTarget,
                savedTarget.interactionId,
                reboundRootChanged ? undefined : savedTarget.subagentId,
                snapshotWarmup
            );
            if (disposed || intentGeneration !== viewerIntentGeneration
                || !resolution.viewerTarget) {
                panel.dispose();
                return;
            }
            try {
                await viewer.restore(
                    panel,
                    resolution.viewerTarget,
                    resolution.snapshot
                );
                snapshotWarmup?.afterLoad(
                    resolution.viewerTarget,
                    resolution.prefetchedSnapshot === true,
                    viewer
                );
            } catch (_error) {
                panel.dispose();
            }
        },
        rebindSession: (previous, next) =>
            viewer.rebindSession(previous, next),
        freezeSessionMetadata: target =>
            viewer.freezeSessionMetadata(target),
        async reconcile(): Promise<void> {
            if (disposed) {
                return;
            }
            try {
                if (options.resolveReboundTarget) {
                    await viewer.reconcileReboundSession(
                        options.resolveReboundTarget
                    );
                }
                await viewer.reconcileAuthority(target => {
                    const authoritativeTarget = resolveExactTarget(
                        options,
                        target
                    );
                    if (!authoritativeTarget) {
                        return false;
                    }
                    coordinator.setSessionStopped(
                        target.provider,
                        target.sessionId,
                        authoritativeTarget.executionState === 'stopped'
                    );
                    const displayMetadata = authoritativeTarget as
                        ConversationAuthoritativeTarget & {
                            conversationDisplayName?: string;
                            duplicateConversationDisplayName?: boolean;
                            conversationTaskName?: string;
                        };
                    const trimmedName = String(
                        authoritativeTarget.name || ''
                    ).trim();
                    return {
                        displayName: displayMetadata.conversationDisplayName
                            || (trimmedName
                                || `${target.provider} conversation`),
                        duplicateDisplayName:
                            displayMetadata.duplicateConversationDisplayName
                                === true,
                        taskName: displayMetadata.conversationTaskName || '',
                    };
                });
            } catch (_error) {
                reportUnavailable(options.onDiagnostic);
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            viewerIntentGeneration += 1;
            ownership.dispose();
        },
    };
}

function createUnavailableConversationCapability(): ConversationCapability {
    const viewer: ConversationViewerApi = {
        isOpen: () => false,
        focus: () => false,
        showNotice: () => false,
        getCurrentTarget: () => undefined,
        getFocusedTarget: () => undefined,
        getFocusedSessionTarget: () => undefined,
        async open() {},
        async restore(panel) {
            panel.dispose();
        },
        async follow() {
            return false;
        },
        async rebindSession() {
            return false;
        },
        async freezeSessionMetadata() {
            return false;
        },
        async reconcileReboundSession() {
            return false;
        },
        async navigateLatest() {},
        async publishSessionStatus() {},
        async refresh() {},
        async refreshPresentation() {},
        async reconcileAuthority() {},
        dispose() {},
    };
    let disposed = false;
    return {
        viewer,
        availability: 'unavailable',
        async openLatestConversation(): Promise<OpenLatestConversationResult> {
            return 'unavailable';
        },
        async openLatestActiveConversation(): Promise<OpenLatestConversationResult> {
            return 'unavailable';
        },
        async followActiveConversation(): Promise<FollowActiveConversationResult> {
            return 'unavailable';
        },
        async followAdjacentActiveConversation(): Promise<FollowAdjacentConversationResult> {
            return 'unavailable';
        },
        async restorePanel(panel: vscode.WebviewPanel): Promise<void> {
            panel.dispose();
        },
        async rebindSession(): Promise<boolean> {
            return false;
        },
        async freezeSessionMetadata(): Promise<boolean> {
            return false;
        },
        async reconcile(): Promise<void> {},
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            viewer.dispose();
        },
    };
}

async function openLatestConversation(
    options: ConversationCapabilityOptions,
    coordinator: ConversationCoordinator,
    viewer: ConversationViewerApi,
    target: ConversationSessionOpenTarget,
    isCurrent: () => boolean,
    snapshotWarmup?: ConversationSnapshotWarmup
): Promise<OpenLatestConversationResult> {
    let resolution = await resolveLatestConversationTarget(
        options,
        coordinator,
        target,
        undefined,
        undefined,
        snapshotWarmup
    );
    if (resolution.result === 'unavailable' && isCurrent()) {
        resolution = await resolveLatestConversationTarget(
            options,
            coordinator,
            target,
            undefined,
            undefined,
            snapshotWarmup
        );
    }
    if (!isCurrent()) {
        return 'superseded';
    }
    if (!resolution.viewerTarget) {
        return resolution.result;
    }
    await viewer.open(resolution.viewerTarget, resolution.snapshot);
    snapshotWarmup?.afterLoad(
        resolution.viewerTarget,
        resolution.prefetchedSnapshot === true,
        viewer
    );
    return 'opened';
}

type LatestConversationTargetResolution =
    | {
        result: 'opened';
        viewerTarget: ConversationViewerTarget;
        snapshot: ConversationSnapshot;
        prefetchedSnapshot: boolean;
    }
    | {
        result: 'unavailable' | 'empty' | 'unknownSession';
        viewerTarget?: undefined;
        snapshot?: undefined;
        prefetchedSnapshot?: undefined;
        diagnostic?: Partial<SanitizedConversationDiagnostic>;
    };

async function followAdjacentConversation(
    options: ConversationCapabilityOptions,
    coordinator: ConversationCoordinator,
    viewer: ConversationViewerApi,
    direction: ConversationSessionSwitchDirection,
    currentTarget: ConversationViewerTarget,
    isCurrent: () => boolean,
    queueTerminalFocus?: (
        target: ConversationSessionOpenTarget,
        isCurrent: () => boolean
    ) => Promise<boolean>,
    terminalAuthority?: {
        confirmedTarget?: ConversationViewerTarget;
    },
    snapshotWarmup?: ConversationSnapshotWarmup
): Promise<FollowAdjacentConversationResult> {
    if (!viewer.isOpen()) {
        return 'closed';
    }
    if (terminalAuthority
        && (!terminalAuthority.confirmedTarget
            || hasSameConversationSession(
                terminalAuthority.confirmedTarget,
                currentTarget
            ))) {
        // Moving between interactions or subagents does not change terminal
        // authority. Keep the exact visible target fresh for a later rollback.
        terminalAuthority.confirmedTarget =
            cloneConversationViewerTarget(currentTarget);
    }
    let sessions: readonly ActiveAiSessionViewModel[];
    try {
        sessions = typeof options.resolveActiveTargets === 'function'
            ? options.resolveActiveTargets(currentTarget.projectId)
            : [];
    } catch (_error) {
        return 'unavailable';
    }
    const switchable = sessions.filter((
        session
    ): session is ActiveAiSessionViewModel & { sessionId: string } =>
        Boolean(session)
            && typeof session.sessionId === 'string'
            && session.sessionId.length > 0
    );
    const currentIndex = switchable.findIndex(session =>
        session.provider === currentTarget.provider
            && session.sessionId === currentTarget.sessionId
    );
    if (currentIndex === -1 || switchable.length < 2) {
        return 'noAdjacentSession';
    }
    const step = direction === 'next' ? 1 : -1;
    const adjacent = switchable[
        (currentIndex + step + switchable.length) % switchable.length
    ];
    const resolution = await resolveLatestConversationTarget(
        options,
        coordinator,
        {
            projectId: currentTarget.projectId,
            provider: adjacent.provider,
            sessionId: adjacent.sessionId,
        },
        undefined,
        undefined,
        snapshotWarmup
    );
    if (!isCurrent()) {
        return 'superseded';
    }
    if (!resolution.viewerTarget) {
        return resolution.result;
    }
    if (!viewer.isOpen()) {
        return 'closed';
    }
    const followed = await viewer.follow(
        resolution.viewerTarget,
        resolution.snapshot
    );
    if (!isCurrent()) {
        return 'superseded';
    }
    if (!followed) {
        return 'closed';
    }
    snapshotWarmup?.afterLoad(
        resolution.viewerTarget,
        resolution.prefetchedSnapshot === true,
        viewer
    );
    if (queueTerminalFocus) {
        // Webview navigation syncs the terminal/tmux window. Command
        // navigation queues a Conversation reveal behind any terminal focus
        // already in flight, so AI Conversation remains the final focus owner.
        try {
            const terminalFocused = await queueTerminalFocus({
                projectId: currentTarget.projectId,
                provider: adjacent.provider,
                sessionId: adjacent.sessionId,
            }, isCurrent);
            if (!terminalFocused) {
                return 'superseded';
            }
            if (terminalAuthority) {
                terminalAuthority.confirmedTarget =
                    cloneConversationViewerTarget(resolution.viewerTarget);
            }
        } catch (_error) {
            if (!isCurrent()) {
                return 'superseded';
            }
            // Terminal authority did not move to the requested Session. Best
            // effort restores the previous terminal and exact Conversation
            // target so the card and viewer cannot settle on different roots.
            const rollbackTarget = terminalAuthority?.confirmedTarget
                || currentTarget;
            try {
                await queueTerminalFocus(rollbackTarget, isCurrent);
            } catch (_rollbackError) {
                // The authoritative refresh still reflects the observed runtime.
            }
            if (!isCurrent()) {
                return 'superseded';
            }
            if (!viewer.isOpen()) {
                return 'closed';
            }
            const restored = await viewer.follow(rollbackTarget);
            if (!isCurrent()) {
                return 'superseded';
            }
            return restored ? 'unavailable' : 'closed';
        }
    }
    return isCurrent() ? 'opened' : 'superseded';
}

function cloneConversationViewerTarget(
    target: ConversationViewerTarget
): ConversationViewerTarget {
    return {
        ...target,
        ...(target.subagent
            ? { subagent: { ...target.subagent } }
            : {}),
    };
}

function hasSameConversationSession(
    left: ConversationSessionOpenTarget,
    right: ConversationSessionOpenTarget
): boolean {
    return left.projectId === right.projectId
        && left.provider === right.provider
        && left.sessionId === right.sessionId;
}

const CONVERSATION_SNAPSHOT_WARM_TTL_MS = 5_000;
const CONVERSATION_SNAPSHOT_WARM_LIMIT = 4;

interface WarmConversationSnapshot {
    completedAt?: number;
    claimed: boolean;
    abortController: ConversationAbortController;
    promise: Promise<ConversationSnapshot | undefined>;
    timeout?: ReturnType<typeof setTimeout>;
    cancel(): void;
}

class ConversationSnapshotWarmup implements AiSessionDisposable {
    private readonly snapshots = new Map<string, WarmConversationSnapshot>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private disposed = false;

    constructor(private readonly options: {
        readSnapshot(
            provider: AiSessionProviderId,
            sessionId: string,
            preferredInteractionId?: string,
            signal?: ConversationAbortController['signal']
        ): Promise<ConversationSnapshot>;
        setSessionStopped(
            provider: AiSessionProviderId,
            sessionId: string,
            stopped: boolean
        ): void;
        resolveActiveTargets?: (
            projectId: string
        ) => readonly ActiveAiSessionViewModel[];
        now(): number;
        setTimer: typeof setTimeout;
        clearTimer: typeof clearTimeout;
    }) {}

    take(
        provider: AiSessionProviderId,
        sessionId: string
    ): Promise<ConversationSnapshot | undefined> | undefined {
        const key = getWarmSnapshotKey(provider, sessionId);
        const entry = this.snapshots.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.completedAt !== undefined
            && this.options.now() - entry.completedAt
                > CONVERSATION_SNAPSHOT_WARM_TTL_MS) {
            this.snapshots.delete(key);
            entry.cancel();
            return undefined;
        }
        entry.claimed = true;
        if (entry.completedAt !== undefined) {
            this.snapshots.delete(key);
            entry.cancel();
        }
        return entry.promise;
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    afterLoad(
        target: ConversationViewerTarget,
        prefetchedSnapshot: boolean,
        viewer: ConversationViewerApi
    ): void {
        // One serialized task instead of two racing ones: prefetching the
        // adjacent sessions keeps a rapid follow-up switch instant, while
        // revalidating the just-opened warm snapshot is hygiene that can
        // wait until the prefetches are under way.
        this.schedule(async () => {
            try {
                this.prefetchAdjacent(target, viewer);
            } catch (_error) {
                // A prefetch hiccup must not skip the warm-snapshot
                // revalidation below; warmup remains best effort.
            }
            if (!prefetchedSnapshot) {
                return;
            }
            const current = viewer.getCurrentTarget();
            if (current && hasSameConversationSession(current, target)) {
                await viewer.revalidateLatest?.(target.interactionId);
            }
        });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.timers.forEach(timer => this.options.clearTimer(timer));
        this.timers.clear();
        Array.from(this.snapshots.values()).forEach(entry => entry.cancel());
        this.snapshots.clear();
    }

    private prefetchAdjacent(
        target: ConversationViewerTarget,
        viewer: ConversationViewerApi
    ): void {
        const current = viewer.getCurrentTarget();
        if (!current || !hasSameConversationSession(current, target)
            || typeof this.options.resolveActiveTargets !== 'function') {
            return;
        }
        let sessions: readonly ActiveAiSessionViewModel[];
        try {
            sessions = this.options.resolveActiveTargets(target.projectId);
        } catch (_error) {
            return;
        }
        const switchable = sessions.filter(available =>
            Boolean(available)
                && typeof available.sessionId === 'string'
                && available.sessionId.length > 0
        ) as Array<ActiveAiSessionViewModel & { sessionId: string }>;
        const currentIndex = switchable.findIndex(available =>
            available.provider === target.provider
                && available.sessionId === target.sessionId
        );
        if (currentIndex === -1 || switchable.length < 2) {
            return;
        }
        const adjacent = new Map<string, ActiveAiSessionViewModel & {
            sessionId: string;
        }>();
        for (const step of [-1, 1]) {
            const candidate = switchable[
                (currentIndex + step + switchable.length) % switchable.length
            ];
            adjacent.set(
                getWarmSnapshotKey(candidate.provider, candidate.sessionId),
                candidate
            );
        }
        adjacent.forEach(candidate => this.prefetch(candidate));
    }

    private prefetch(
        target: ActiveAiSessionViewModel & { sessionId: string }
    ): void {
        const key = getWarmSnapshotKey(target.provider, target.sessionId);
        const existing = this.snapshots.get(key);
        if (existing) {
            if (existing.completedAt === undefined
                || this.options.now() - existing.completedAt
                    <= CONVERSATION_SNAPSHOT_WARM_TTL_MS) {
                return;
            }
            this.snapshots.delete(key);
            existing.cancel();
        }
        while (this.snapshots.size >= CONVERSATION_SNAPSHOT_WARM_LIMIT) {
            const oldestKey = this.snapshots.keys().next().value;
            if (typeof oldestKey !== 'string') {
                break;
            }
            this.snapshots.get(oldestKey)?.cancel();
            this.snapshots.delete(oldestKey);
        }
        this.options.setSessionStopped(
            target.provider,
            target.sessionId,
            target.executionState === 'stopped'
        );
        const abortController = new ConversationAbortController();
        let readSnapshot: Promise<ConversationSnapshot>;
        try {
            readSnapshot = this.options.readSnapshot(
                target.provider,
                target.sessionId,
                undefined,
                abortController.signal
            );
        } catch (_error) {
            return;
        }
        let resolvePromise: (
            snapshot: ConversationSnapshot | undefined
        ) => void = () => undefined;
        const promise = new Promise<ConversationSnapshot | undefined>(
            resolve => { resolvePromise = resolve; }
        );
        let settled = false;
        let entry: WarmConversationSnapshot;
        const clearEntryTimeout = (): void => {
            if (entry.timeout === undefined) {
                return;
            }
            this.options.clearTimer(entry.timeout);
            entry.timeout = undefined;
        };
        const scheduleCompletedExpiry = (): void => {
            let timeoutFiredSynchronously = false;
            const timeout = this.options.setTimer(() => {
                timeoutFiredSynchronously = true;
                entry.timeout = undefined;
                if (this.snapshots.get(key) === entry) {
                    this.snapshots.delete(key);
                }
            }, CONVERSATION_SNAPSHOT_WARM_TTL_MS);
            if (!timeoutFiredSynchronously) {
                entry.timeout = timeout;
            }
        };
        const settle = (
            snapshot: ConversationSnapshot | undefined,
            abort: boolean
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearEntryTimeout();
            if (abort) {
                abortController.abort();
            }
            if (snapshot) {
                entry.completedAt = this.options.now();
                if (entry.claimed) {
                    if (this.snapshots.get(key) === entry) {
                        this.snapshots.delete(key);
                    }
                } else {
                    scheduleCompletedExpiry();
                }
            } else if (this.snapshots.get(key) === entry) {
                this.snapshots.delete(key);
            }
            resolvePromise(snapshot);
        };
        entry = {
            abortController,
            claimed: false,
            promise,
            cancel: () => {
                clearEntryTimeout();
                if (!settled) {
                    settle(undefined, true);
                }
            },
        };
        this.snapshots.set(key, entry);
        let timeoutFiredSynchronously = false;
        const timeout = this.options.setTimer(() => {
            timeoutFiredSynchronously = true;
            settle(undefined, true);
        }, CONVERSATION_SNAPSHOT_WARM_TTL_MS);
        if (!timeoutFiredSynchronously) {
            entry.timeout = timeout;
        }
        void Promise.resolve(readSnapshot).then(
            snapshot => settle(snapshot, false),
            () => settle(undefined, false)
        );
    }

    private schedule(operation: () => void | PromiseLike<void>): void {
        if (this.disposed) {
            return;
        }
        let handle: ReturnType<typeof setTimeout> | undefined;
        let firedSynchronously = false;
        const callback = (): void => {
            firedSynchronously = true;
            if (handle) {
                this.timers.delete(handle);
            }
            if (this.disposed) {
                return;
            }
            try {
                void Promise.resolve(operation()).catch(() => undefined);
            } catch (_error) {
                // Warmup is optional and cannot break authoritative switching.
            }
        };
        handle = this.options.setTimer(callback, 0);
        if (!firedSynchronously) {
            this.timers.add(handle);
        }
    }
}

function getWarmSnapshotKey(
    provider: AiSessionProviderId,
    sessionId: string
): string {
    return `${provider}:${sessionId}`;
}

async function resolveLatestConversationTarget(
    options: ConversationCapabilityOptions,
    coordinator: ConversationCoordinator,
    target: ConversationSessionOpenTarget,
    preferredInteractionId?: string,
    subagentId?: string,
    snapshotWarmup?: ConversationSnapshotWarmup
): Promise<LatestConversationTargetResolution> {
    const authoritativeTarget = resolveExactTarget(options, target);
    if (!authoritativeTarget) {
        return {
            result: 'unknownSession',
            diagnostic: conversationFollowDiagnosticBase(target),
        };
    }
    coordinator.setSessionStopped(
        target.provider,
        target.sessionId,
        authoritativeTarget.executionState === 'stopped'
    );
    let subagent: ConversationViewerTarget['subagent'];
    let effectiveSessionId = target.sessionId;
    if (subagentId) {
        let subagents;
        try {
            subagents = await coordinator.readSubagents(
                target.provider,
                target.sessionId
            );
        } catch (_error) {
            return {
                result: 'unavailable',
                diagnostic: conversationFollowDiagnosticBase(target),
            };
        }
        const authoritativeSubagent = subagents.find(entry =>
            entry.id === subagentId
        );
        if (!authoritativeSubagent) {
            return {
                result: 'unavailable',
                diagnostic: conversationFollowDiagnosticBase(target),
            };
        }
        subagent = {
            id: authoritativeSubagent.id,
            label: authoritativeSubagent.label,
        };
        effectiveSessionId = encodeSubagentSessionId(
            target.sessionId,
            authoritativeSubagent.id
        );
    }
    let snapshot: ConversationSnapshot;
    let prefetchedSnapshot = false;
    let discardedEmptyWarmSnapshot = false;
    try {
        const warmSnapshot = preferredInteractionId === undefined
            && subagentId === undefined
            ? snapshotWarmup?.take(target.provider, effectiveSessionId)
            : undefined;
        const resolvedWarmSnapshot = warmSnapshot
            ? await warmSnapshot
            : undefined;
        if (warmSnapshot && !resolvedWarmSnapshot
            && snapshotWarmup?.isDisposed()) {
            return {
                result: 'unavailable',
                diagnostic: conversationFollowDiagnosticBase(
                    target,
                    effectiveSessionId
                ),
            };
        }
        // A speculative read can finish before a newly started provider has
        // persisted its first user turn. Never let that empty warm snapshot
        // authoritatively report a live Session as conversation-less: confirm
        // it against the provider when the user actually navigates there.
        const usableWarmSnapshot = resolvedWarmSnapshot
            && resolvedWarmSnapshot.outline.interactions.length
            ? resolvedWarmSnapshot
            : undefined;
        discardedEmptyWarmSnapshot = Boolean(
            resolvedWarmSnapshot && !usableWarmSnapshot
        );
        prefetchedSnapshot = Boolean(usableWarmSnapshot);
        snapshot = usableWarmSnapshot || (
            typeof coordinator.readSnapshot === 'function'
            ? await coordinator.readSnapshot(
                target.provider,
                effectiveSessionId,
                preferredInteractionId
            )
            : {
                outline: await coordinator.readOutline(
                    target.provider,
                    effectiveSessionId
                ),
            });
    } catch (_error) {
        return {
            result: 'unavailable',
            diagnostic: {
                ...conversationFollowDiagnosticBase(target, effectiveSessionId),
                ...conversationCacheDiagnostics(
                    coordinator,
                    target.provider,
                    effectiveSessionId
                ),
            },
        };
    }
    const selected = snapshot.outline.interactions.find(interaction =>
        interaction.id === preferredInteractionId
    ) || snapshot.outline.interactions[
        snapshot.outline.interactions.length - 1
    ];
    if (!selected) {
        return {
            result: 'empty',
            diagnostic: {
                ...conversationFollowDiagnosticBase(target, effectiveSessionId),
                snapshotSource: 'fresh',
                discardedEmptyWarmSnapshot,
                outlineInteractions: snapshot.outline.interactions.length,
                sourceRevision: snapshot.outline.sourceRevision,
                ...conversationCacheDiagnostics(
                    coordinator,
                    target.provider,
                    effectiveSessionId
                ),
            },
        };
    }
    const displayMetadata = authoritativeTarget as ConversationAuthoritativeTarget & {
        conversationDisplayName?: string;
        duplicateConversationDisplayName?: boolean;
        conversationTaskName?: string;
    };
    const trimmedName = String(authoritativeTarget.name || '').trim();
    return {
        result: 'opened',
        viewerTarget: {
            projectId: target.projectId,
            provider: target.provider,
            workspaceName: typeof options.resolveWorkspaceName === 'function'
                ? options.resolveWorkspaceName(target.projectId)
                : '',
            sessionId: target.sessionId,
            interactionId: selected.id,
            expectedRevision: snapshot.outline.sourceRevision,
            displayName: displayMetadata.conversationDisplayName
                || (trimmedName || `${target.provider} conversation`),
            duplicateDisplayName:
                displayMetadata.duplicateConversationDisplayName === true,
            ...(displayMetadata.conversationTaskName
                ? { taskName: displayMetadata.conversationTaskName }
                : {}),
            ...(subagent ? { subagent } : {}),
        },
        snapshot,
        prefetchedSnapshot,
    };
}

function resolveExactTarget(
    options: ConversationCapabilityOptions,
    target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }
): ConversationAuthoritativeTarget | null {
    let authoritativeTarget: ConversationAuthoritativeTarget | null;
    try {
        authoritativeTarget = options.resolveTarget(
            target.projectId,
            target.provider,
            target.sessionId
        );
    } catch (_error) {
        return null;
    }
    const projectedTarget = authoritativeTarget as
        | (ConversationAuthoritativeTarget & { projectId?: string })
        | null;
    if (!projectedTarget
        || authoritativeTarget.provider !== target.provider
        || authoritativeTarget.sessionId !== target.sessionId
        || (projectedTarget.projectId !== undefined
            && projectedTarget.projectId !== target.projectId)) {
        return null;
    }
    return authoritativeTarget;
}

async function restoreConversationFocus(
    options: ConversationCapabilityOptions,
    target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
        interactionId: string;
    }
): Promise<void> {
    try {
        await vscode.commands.executeCommand(`${AGENT_PIVOT_DASHBOARD_VIEW_ID}.focus`);
    } catch (_error) {
        // Publishing the semantic fallback remains useful if reveal fails.
    }
    try {
        await options.publish({
            type: 'focus-ai-session-conversation-origin',
            version: 1,
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
            interactionId: target.interactionId,
        });
    } catch (_error) {
        // Hidden or disposed sidebar delivery is an expected no-op.
    }
}

function getWorkspaceRootHostPaths(
    options: ConversationCapabilityOptions
): readonly string[] {
    try {
        const paths = options.getWorkspaceRootHostPaths?.();
        return Array.isArray(paths)
            ? paths.filter(candidate => typeof candidate === 'string')
            : [];
    } catch (_error) {
        return [];
    }
}

function getConversationMediaUri(fileName: string): vscode.Uri {
    const mediaRoot = path.basename(__dirname) === 'conversation'
        ? path.resolve(__dirname, '..', '..', '..', 'media')
        : path.resolve(__dirname, '..', 'media');
    const filePath = path.join(mediaRoot, fileName);
    const uri = vscode.Uri.file(filePath);
    // In-place installs reuse the same extension version directory, so a
    // bare asWebviewUri is byte-stable across builds and the webview may
    // serve a stale cached stylesheet/script. A content fingerprint makes
    // every build's media URI unique.
    try {
        const digest = createHash('sha256')
            .update(fs.readFileSync(filePath))
            .digest('hex')
            .slice(0, 12);
        return uri.with({ query: `v=${digest}` });
    } catch (_error) {
        return uri;
    }
}

function reportUnavailable(
    onDiagnostic: ConversationCapabilityOptions['onDiagnostic']
): void {
    try {
        onDiagnostic({
            event: 'conversation-read',
            category: 'unavailable',
        });
    } catch (_error) {
        // Optional diagnostics never block Dashboard activation.
    }
}

function hashConversationSessionId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function conversationFollowDiagnosticBase(
    target: ConversationSessionOpenTarget,
    effectiveSessionId?: string
): Partial<SanitizedConversationDiagnostic> {
    return {
        sessionIdHash: hashConversationSessionId(target.sessionId),
        ...(effectiveSessionId !== undefined
            && effectiveSessionId !== target.sessionId
            ? {
                effectiveSessionIdHash:
                    hashConversationSessionId(effectiveSessionId),
            }
            : {}),
    };
}

function conversationCacheDiagnostics(
    coordinator: ConversationCoordinator,
    provider: AiSessionProviderId,
    sessionId: string
): Partial<SanitizedConversationDiagnostic> {
    try {
        return {
            ...(coordinator.readCacheDiagnostics(provider, sessionId) || {}),
        };
    } catch (_error) {
        return {};
    }
}

function conversationFollowNoticeText(
    result: 'empty' | 'unavailable' | 'unknownSession'
): string {
    if (result === 'empty') {
        return 'This AI session has no conversation yet.';
    }
    if (result === 'unknownSession') {
        return 'This AI session is no longer active.';
    }
    return 'Unable to read the AI session conversation.'
        + ' Click the session again to retry.';
}

function reportFollowFailure(
    onDiagnostic: ConversationCapabilityOptions['onDiagnostic'],
    provider: AiSessionProviderId,
    result: 'empty' | 'unavailable' | 'unknownSession',
    detail?: Partial<SanitizedConversationDiagnostic>
): void {
    try {
        onDiagnostic({
            event: 'conversation-follow',
            category: result,
            provider,
            ...detail,
        });
    } catch (_error) {
        // Optional diagnostics never block Dashboard activation.
    }
}

function disposeAll(disposables: readonly AiSessionDisposable[]): void {
    const seen = new Set<AiSessionDisposable>();
    for (const disposable of disposables) {
        if (!disposable || seen.has(disposable)) {
            continue;
        }
        seen.add(disposable);
        try {
            disposable.dispose();
        } catch (_error) {
            // One optional capability resource cannot block the remaining cleanup.
        }
    }
}

interface ConstructionOwnership {
    own<TDisposable extends AiSessionDisposable>(
        disposable: TDisposable
    ): TDisposable;
    transfer(disposable: AiSessionDisposable): void;
    dispose(): void;
}

function createConstructionOwnership(): ConstructionOwnership {
    const owned: AiSessionDisposable[] = [];
    let disposed = false;
    return {
        own<TDisposable extends AiSessionDisposable>(
            disposable: TDisposable
        ): TDisposable {
            owned.push(disposable);
            return disposable;
        },
        transfer(disposable: AiSessionDisposable): void {
            const index = owned.indexOf(disposable);
            if (index >= 0) {
                owned.splice(index, 1);
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeAll(owned.slice().reverse());
            owned.length = 0;
        },
    };
}
