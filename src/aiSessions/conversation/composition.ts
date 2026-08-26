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
    ConversationAbortSignal,
    ConversationError,
    ConversationProviderAdapter,
    ConversationSnapshot,
    SanitizedConversationDiagnostic,
} from './types';
import {
    ConversationViewer,
    ConversationViewerApi,
    ConversationViewerApplicationTiming,
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

export {
    ConversationCommandRunner,
    resolveConversationCommandLocation,
} from './commandRunner';

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

/**
 * An already-started, but not yet Viewer-applicable, Conversation target.
 * Dashboard navigation starts this while terminal focus is queued, then
 * commits it only after that focus succeeds for the same user intent.
 */
export interface PreparedActiveConversationNavigation {
    apply(): Promise<FollowActiveConversationResult>;
    cancel(): void;
}

export interface ConversationCapability {
    viewer: ConversationViewerApi;
    availability: 'available' | 'unavailable';
    /**
     * Cancels an in-flight foreground resolution as soon as a newer
     * user-visible navigation intent wins, before that later intent reaches
     * the terminal-focus queue.
     */
    cancelPendingNavigation(options?: {
        preservePreparedPreview?: boolean;
    }): void;
    prepareActiveConversation(
        target: ConversationSessionOpenTarget,
        openWhenClosed: boolean
    ): PreparedActiveConversationNavigation;
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
    onViewerTiming?: (timing: ConversationViewerApplicationTiming) => void;
    monotonicNow?: () => number;
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
    runCommandInTerminal?: ConversationViewerOptions['runCommandInTerminal'];
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
    /** Serializes terminal focus with dashboard-level session navigation.
     * The caller owns the queue; this capability only supplies the exact
     * focus operation for one already-resolved target. */
    enqueueTerminalFocus?: (
        operation: () => Promise<void>
    ) => Promise<void>;
    commentStore?: ConversationCommentStore;
    projectCommentStore?: ProjectCommentStore;
    bookmarkStore?: ConversationBookmarkStore;
    getShowThinking?: () => boolean;
    readSessionStatus?: ConversationViewerOptions['readSessionStatus'];
    cycleLocalSessionStatus?: ConversationViewerOptions['cycleLocalSessionStatus'];
    acknowledgeSessionAttention?: ConversationViewerOptions['acknowledgeSessionAttention'];
    switchAdjacentWindow?: ConversationViewerOptions['switchAdjacentWindow'];
    onConversationNavigationIntent?: ConversationViewerOptions['onNavigationIntent'];
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
            const focus = async (): Promise<void> => {
                const focused = await (options.syncSession || options.focusSession)?.(
                    target
                );
                if (focused === false) {
                    throw new Error('AI session terminal focus was rejected');
                }
            };
            if (options.enqueueTerminalFocus) {
                await options.enqueueTerminalFocus(focus);
            } else {
                await focus();
            }
        },
        isCurrent
    );
    let viewerIntentGeneration = 0;
    let viewerIntentAbortController: ConversationAbortController | undefined;
    // A Dashboard row can start a reversible Renderer preflight before its
    // terminal focus is admitted. Unlike an authoritative Viewer load, this
    // handle is always safe to cancel for a non-Conversation intent (for
    // example a worktree switch) without leaving the panel loading.
    let pendingPreparedPreview: AiSessionDisposable | undefined;
    let disposed = false;
    const beginViewerIntent = (): {
        isCurrent: () => boolean;
        signal: ConversationAbortSignal;
    } => {
        const intentGeneration = ++viewerIntentGeneration;
        const previousAbortController = viewerIntentAbortController;
        const abortController = new ConversationAbortController();
        viewerIntentAbortController = abortController;
        // Provider reads can be substantially more expensive than applying a
        // cached frame. Do not merely ignore an obsolete completion: release
        // the provider/Host work as soon as a newer switch wins.
        previousAbortController?.abort();
        return {
            isCurrent: () => !disposed
                && intentGeneration === viewerIntentGeneration
                && viewerIntentAbortController === abortController,
            signal: abortController.signal,
        };
    };
    const terminalAuthority: {
        confirmedTarget?: ConversationViewerTarget;
    } = {};
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
        onNavigationIntent: options.onConversationNavigationIntent,
        submitPrompt: options.submitPrompt,
        focusSession: options.focusSession,
        commentStore: options.commentStore,
        projectCommentStore: options.projectCommentStore,
        bookmarkStore: options.bookmarkStore,
        insertIntoActiveTerminal: options.insertIntoActiveTerminal,
        runCommandInTerminal: options.runCommandInTerminal,
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
            const intent = beginViewerIntent();
            return followAdjacentConversation(
                options,
                coordinator,
                viewer,
                direction,
                currentTarget,
                intent.isCurrent,
                queueTerminalFocus,
                terminalAuthority,
                snapshotWarmup,
                intent.signal
            );
        },
        setKeyboardFocus: options.setConversationFocusContext,
        onDiagnostic: options.onDiagnostic
            ? event => options.onDiagnostic(event as never)
            : undefined,
        onTiming: options.onViewerTiming,
        now: options.monotonicNow,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
    }));
    const queueConversationFocus = (
        _target: ConversationSessionOpenTarget,
        isCurrent: () => boolean
    ): Promise<boolean> => queueFocus(() => {
        viewer.focus();
    }, isCurrent);
    type PreparedViewerIntent = {
        isCurrent(): boolean;
        signal: ConversationAbortSignal;
        resolution?: Promise<LatestConversationTargetResolution>;
        revalidateAfterLoad?: boolean;
        preview?: AiSessionDisposable;
    };
    const followOpenConversation = async (
        target: ConversationSessionOpenTarget,
        reveal: boolean,
        showFollowFailure: boolean,
        preparedIntent?: PreparedViewerIntent
    ): Promise<FollowActiveConversationResult> => {
        if (!viewer.isOpen()) {
            preparedIntent?.preview?.dispose();
            return 'closed';
        }
        const intent: PreparedViewerIntent = preparedIntent || beginViewerIntent();
        const currentTarget = viewer.getCurrentTarget();
        if (currentTarget
            && hasSameConversationSession(currentTarget, target)) {
            preparedIntent?.preview?.dispose();
            // This is a new navigation intent, even though it resolves to
            // the already-authoritative session. Let the Viewer cancel a
            // pending preflight for another session, then keep the retained
            // document without waiting for or parsing a second snapshot.
            viewer.previewSession?.(target);
            terminalAuthority.confirmedTarget =
                cloneConversationViewerTarget(currentTarget);
            if (reveal) {
                viewer.focus();
            }
            return 'opened';
        }
        const preview = preparedIntent?.preview || viewer.previewSession?.(target);
        let followedSuccessfully = false;
        try {
            const resolution = await (intent.resolution
                || resolveLatestConversationTarget(
                    options,
                    coordinator,
                    target,
                    undefined,
                    undefined,
                    snapshotWarmup,
                    intent.signal
                ));
            if (!intent.isCurrent()) {
                return 'superseded';
            }
            if (resolution.result !== 'opened') {
                if (showFollowFailure) {
                    reportFollowFailure(
                        options.onDiagnostic,
                        target.provider,
                        resolution.result,
                        resolution.diagnostic
                    );
                    viewer.showNotice(
                        conversationFollowNoticeText(resolution.result)
                    );
                }
                return resolution.result;
            }
            if (!viewer.isOpen()) {
                return 'closed';
            }
            const follow = viewer.follow(
                resolution.viewerTarget,
                resolution.snapshot
            );
            snapshotWarmup?.prepareAfterTargetSet(
                resolution.viewerTarget,
                viewer
            );
            let viewerLoadRecorded = false;
            const recordViewerLoad = (followed: boolean): void => {
                if (viewerLoadRecorded || !followed) {
                    return;
                }
                const current = viewer.getCurrentTarget?.();
                if (current && !hasSameConversationSession(
                    current,
                    resolution.viewerTarget
                )) {
                    return;
                }
                viewerLoadRecorded = true;
                snapshotWarmup?.afterLoad(
                    resolution.viewerTarget,
                    resolution.prefetchedSnapshot === true
                        || intent.revalidateAfterLoad === true,
                    viewer
                );
            };
            // The caller's wait is supersedable, but the Viewer operation is
            // deliberately allowed to finish when no replacement target ever
            // arrives. Keep warm-snapshot revalidation attached to that
            // underlying operation so a late successful application does not
            // leave the retained snapshot permanently stale.
            void follow.then(recordViewerLoad, () => undefined);
            let followed: boolean;
            try {
                // A Viewer delivery can wait on the Webview while the next
                // Dashboard target already has a newer intent. Release the
                // terminal-focus queue now, but leave Viewer-owned work
                // alone: the successor might fail to focus or might be a
                // worktree-only switch, in which case the current Viewer
                // load must still settle normally.
                followed = await awaitAbortableRead(follow, intent.signal);
            } catch (error) {
                if (!intent.isCurrent()) {
                    return 'superseded';
                }
                throw error;
            }
            if (!intent.isCurrent()) {
                return 'superseded';
            }
            if (followed) {
                recordViewerLoad(followed);
                const current = viewer.getCurrentTarget();
                terminalAuthority.confirmedTarget =
                    cloneConversationViewerTarget(
                        current
                            && hasSameConversationSession(
                                current,
                                resolution.viewerTarget
                            )
                            ? current
                            : resolution.viewerTarget
                    );
                followedSuccessfully = true;
                if (reveal) {
                    viewer.focus();
                }
            }
            return followed ? 'opened' : 'closed';
        } finally {
            if (!followedSuccessfully) {
                preview?.dispose();
            }
        }
    };
    const openConversation = async (
        target: ConversationSessionOpenTarget
    ): Promise<OpenLatestConversationResult> => {
        if (viewer.isOpen() && viewer.getCurrentTarget()) {
            const result = await followOpenConversation(target, true, false);
            return result === 'closed' ? 'superseded' : result;
        }
        const intent = beginViewerIntent();
        return openLatestConversation(
            options,
            coordinator,
            viewer,
            target,
            intent.isCurrent,
            snapshotWarmup,
            intent.signal
        );
    };
    const prepareActiveConversation = (
        target: ConversationSessionOpenTarget,
        openWhenClosed: boolean
    ): PreparedActiveConversationNavigation => {
        const intent = beginViewerIntent();
        const currentTarget = viewer.getCurrentTarget();
        // This is deliberately non-authoritative: previewSession only posts
        // the reversible loading/cache-frame protocol. It lets a click feel
        // immediate while terminal focus and the authoritative read run in
        // parallel below. follow/open still own the eventual Viewer target.
        const shouldPreflight = viewer.isOpen()
            && !(currentTarget && hasSameConversationSession(
                currentTarget,
                target
            ));
        // Let Viewer hand one preview directly to the next. It retains a
        // cached frame through rapid B → C clicks without a momentary return
        // to the old authoritative document. A same-target or unavailable
        // preflight instead restores the old document immediately.
        if (!shouldPreflight) {
            pendingPreparedPreview?.dispose();
            pendingPreparedPreview = undefined;
        }
        const preparedPreview = shouldPreflight
            ? viewer.previewSession?.(target)
            : undefined;
        if (preparedPreview) {
            pendingPreparedPreview = preparedPreview;
        } else if (shouldPreflight) {
            pendingPreparedPreview?.dispose();
            pendingPreparedPreview = undefined;
        }
        const releasePreparedPreview = (): void => {
            if (pendingPreparedPreview !== preparedPreview) {
                return;
            }
            pendingPreparedPreview = undefined;
            preparedPreview?.dispose();
        };
        const shouldResolve = openWhenClosed || viewer.isOpen();
        const resolution = shouldResolve && !(viewer.isOpen() && currentTarget
            && hasSameConversationSession(currentTarget, target))
            ? resolveLatestConversationTarget(
                options,
                coordinator,
                target,
                undefined,
                undefined,
                snapshotWarmup,
                intent.signal
            )
            : undefined;
        // A failed terminal focus never calls apply(). Keep the rejected
        // provider result observed in that case while retaining the original
        // promise for a successful focus to consume.
        void resolution?.catch(() => undefined);
        let applied = false;
        const cancel = (): void => {
            releasePreparedPreview();
            // A stale queued focus task must not cancel the newer target that
            // replaced it while it was waiting for terminal serialization.
            if (intent.isCurrent()) {
                beginViewerIntent();
            }
        };
        return {
            cancel,
            async apply(): Promise<FollowActiveConversationResult> {
                if (applied || !intent.isCurrent()) {
                    return 'superseded';
                }
                applied = true;
                if (!viewer.isOpen() && !openWhenClosed) {
                    cancel();
                    return 'closed';
                }
                let previewTransferred = false;
                try {
                    let resolutionForApply = resolution;
                    let retriedAtApply = false;
                    if (resolution) {
                        const preparedResolution = await resolution;
                        if (!intent.isCurrent()) {
                            return 'superseded';
                        }
                        // An early empty/unavailable response can become usable
                        // while terminal focus is queued. Re-read only those
                        // terminal outcomes at commit time; an opened snapshot
                        // is revalidated after Viewer application below.
                        if (preparedResolution.result !== 'opened') {
                            retriedAtApply = true;
                            resolutionForApply = resolveLatestConversationTarget(
                                options,
                                coordinator,
                                target,
                                undefined,
                                undefined,
                                snapshotWarmup,
                                intent.signal
                            );
                        }
                    }
                    const preparedIntent: PreparedViewerIntent = {
                        ...intent,
                        resolution: resolutionForApply,
                        revalidateAfterLoad: resolution !== undefined,
                        preview: preparedPreview,
                    };
                    if (viewer.isOpen()) {
                        // Viewer.loadTarget adopts the matching preflight
                        // synchronously. From this point a generic navigation
                        // intent must not cancel the authoritative load.
                        if (pendingPreparedPreview === preparedPreview) {
                            pendingPreparedPreview = undefined;
                        }
                        previewTransferred = true;
                        return followOpenConversation(
                            target,
                            openWhenClosed,
                            !openWhenClosed,
                            preparedIntent
                        );
                    }
                    if (!openWhenClosed) {
                        cancel();
                        return 'closed';
                    }
                    const result = await openLatestConversation(
                        options,
                        coordinator,
                        viewer,
                        target,
                        intent.isCurrent,
                        snapshotWarmup,
                        intent.signal,
                        resolutionForApply,
                        resolution !== undefined,
                        retriedAtApply
                    );
                    if (result === 'opened') {
                        const openedTarget = viewer.getCurrentTarget();
                        if (openedTarget
                            && hasSameConversationSession(openedTarget, target)) {
                            terminalAuthority.confirmedTarget =
                                cloneConversationViewerTarget(openedTarget);
                        }
                    }
                    return result;
                } finally {
                    if (!previewTransferred) {
                        preparedPreview?.dispose();
                    }
                }
            },
        };
    };
    return {
        viewer,
        availability: 'available',
        cancelPendingNavigation: navigationOptions => {
            if (!disposed) {
                // Only release an uncommitted visual preflight. Do not abort
                // the Viewer itself here: a worktree-only intent may have no
                // replacement Conversation transaction to settle it.
                if (!navigationOptions?.preservePreparedPreview) {
                    pendingPreparedPreview?.dispose();
                    pendingPreparedPreview = undefined;
                }
                beginViewerIntent();
            }
        },
        prepareActiveConversation,
        openLatestConversation: target => openConversation(target),
        async openLatestActiveConversation(
            target: ConversationSessionOpenTarget
        ): Promise<OpenLatestConversationResult> {
            const result = await openConversation(target);
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
            return followOpenConversation(target, false, true);
        },
        async followAdjacentActiveConversation(
            direction: ConversationSessionSwitchDirection
        ): Promise<FollowAdjacentConversationResult> {
            const currentTarget = viewer.getCurrentTarget();
            if (!currentTarget) {
                return viewer.isOpen() ? 'inactive' : 'closed';
            }
            const intent = beginViewerIntent();
            const isCurrent = intent.isCurrent;
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
                    snapshotWarmup,
                    intent.signal
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
            const intent = beginViewerIntent();
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
                snapshotWarmup,
                intent.signal
            );
            if (!intent.isCurrent()
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
            viewerIntentAbortController?.abort();
            viewerIntentAbortController = undefined;
            pendingPreparedPreview?.dispose();
            pendingPreparedPreview = undefined;
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
        cancelPendingNavigation(): void {},
        prepareActiveConversation(): PreparedActiveConversationNavigation {
            return {
                apply: async () => 'unavailable',
                cancel() {},
            };
        },
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
    snapshotWarmup?: ConversationSnapshotWarmup,
    signal?: ConversationAbortSignal,
    preparedResolution?: Promise<LatestConversationTargetResolution>,
    revalidateAfterLoad = false,
    skipUnavailableRetry = false
): Promise<OpenLatestConversationResult> {
    const preview = viewer.previewSession?.(target);
    let opened = false;
    try {
        let resolution = await (preparedResolution
            || resolveLatestConversationTarget(
                options,
                coordinator,
                target,
                undefined,
                undefined,
                snapshotWarmup,
                signal
            ));
        if (resolution.result === 'unavailable'
            && isCurrent()
            && !skipUnavailableRetry) {
            resolution = await resolveLatestConversationTarget(
                options,
                coordinator,
                target,
                undefined,
                undefined,
                snapshotWarmup,
                signal
            );
        }
        if (!isCurrent()) {
            return 'superseded';
        }
        if (!resolution.viewerTarget) {
            return resolution.result;
        }
        const opening = viewer.open(
            resolution.viewerTarget,
            resolution.snapshot
        );
        snapshotWarmup?.prepareAfterTargetSet(resolution.viewerTarget, viewer);
        let viewerLoadRecorded = false;
        const recordViewerLoad = (): void => {
            if (viewerLoadRecorded) {
                return;
            }
            const current = viewer.getCurrentTarget?.();
            if (current && !hasSameConversationSession(
                current,
                resolution.viewerTarget
            )) {
                return;
            }
            viewerLoadRecorded = true;
            snapshotWarmup?.afterLoad(
                resolution.viewerTarget,
                resolution.prefetchedSnapshot === true || revalidateAfterLoad,
                viewer
            );
        };
        // See followOpenConversation: revalidation belongs to the Viewer
        // operation, not solely to this supersedable caller's wait.
        void opening.then(recordViewerLoad, () => undefined);
        try {
            // See followOpenConversation: supersede only this caller's wait,
            // never a Viewer operation that could remain the active target.
            await awaitAbortableRead(opening, signal);
        } catch (error) {
            if (!isCurrent()) {
                return 'superseded';
            }
            throw error;
        }
        if (!isCurrent()) {
            return 'superseded';
        }
        recordViewerLoad();
        opened = true;
        return 'opened';
    } finally {
        if (!opened) {
            preview?.dispose();
        }
    }
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

function awaitAbortableRead<T>(
    read: Promise<T>,
    signal?: ConversationAbortSignal
): Promise<T> {
    if (!signal) {
        return read;
    }
    if (signal.aborted) {
        return Promise.reject(new Error('Conversation navigation was superseded'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let abortSubscription: AiSessionDisposable | undefined;
        const settle = (operation: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            abortSubscription?.dispose();
            operation();
        };
        abortSubscription = signal.onAbort(() => settle(() => {
            reject(new Error('Conversation navigation was superseded'));
        }));
        void Promise.resolve(read).then(
            result => settle(() => {
                if (signal.aborted) {
                    reject(new Error('Conversation navigation was superseded'));
                    return;
                }
                resolve(result);
            }),
            error => settle(() => reject(error))
        );
    });
}

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
    snapshotWarmup?: ConversationSnapshotWarmup,
    signal?: ConversationAbortSignal
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
    const target = {
        projectId: currentTarget.projectId,
        provider: adjacent.provider,
        sessionId: adjacent.sessionId,
    };
    const preview = viewer.previewSession?.(target);
    let followedSuccessfully = false;
    try {
        const resolution = await resolveLatestConversationTarget(
            options,
            coordinator,
            target,
            undefined,
            undefined,
            snapshotWarmup,
            signal
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
        const follow = viewer.follow(
            resolution.viewerTarget,
            resolution.snapshot
        );
        snapshotWarmup?.prepareAfterTargetSet(resolution.viewerTarget, viewer);
        const followed = await follow;
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
        followedSuccessfully = true;
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
    } finally {
        if (!followedSuccessfully) {
            preview?.dispose();
        }
    }
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
// A speculative read is useful only when it is already almost complete. A
// foreground switch must otherwise start its own abortable read promptly.
const CONVERSATION_SNAPSHOT_WARM_CLAIM_BUDGET_MS = 120;

interface WarmConversationSnapshot {
    completedAt?: number;
    claimed: boolean;
    claimGeneration: number;
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
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot | undefined> | undefined {
        if (signal?.aborted) {
            return Promise.resolve(undefined);
        }
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
        if (entry.completedAt !== undefined) {
            return entry.promise;
        }
        entry.claimGeneration += 1;
        return this.claimWithinBudget(
            key,
            entry,
            entry.claimGeneration,
            signal
        );
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    afterLoad(
        target: ConversationViewerTarget,
        prefetchedSnapshot: boolean,
        viewer: ConversationViewerApi
    ): void {
        this.schedule(async () => {
            // Keep a post-load fallback for Viewer implementations that do
            // not expose the new target until their async load settles. The
            // cache deduplicates this with the early prepareAfterTargetSet
            // prefetch in the usual path.
            try {
                this.prefetchAdjacent(target, viewer);
            } catch (_error) {
                // Speculative reads never affect the active Conversation.
            }
            if (!prefetchedSnapshot) {
                return;
            }
            // Revalidation is hygiene for a warm snapshot. It must wait for
            // the authoritative page, while adjacent prefetching normally
            // starts much earlier in prepareAfterTargetSet.
            const current = viewer.getCurrentTarget();
            if (current && hasSameConversationSession(current, target)) {
                await viewer.revalidateLatest?.(target.interactionId);
            }
        });
    }

    prepareAfterTargetSet(
        target: ConversationViewerTarget,
        viewer: ConversationViewerApi
    ): void {
        // The target is committed before Viewer metadata restoration and the
        // first authoritative page complete. Start the bounded, best-effort
        // adjacent reads now so the next user switch can share them instead
        // of waiting for this Viewer load to finish.
        this.schedule(() => {
            try {
                this.prefetchAdjacent(target, viewer);
            } catch (_error) {
                // Speculative reads never affect the active Conversation.
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
            claimGeneration: 0,
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

    private claimWithinBudget(
        key: string,
        entry: WarmConversationSnapshot,
        claimGeneration: number,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot | undefined> {
        return new Promise(resolve => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortSubscription: AiSessionDisposable | undefined;
            const settle = (snapshot: ConversationSnapshot | undefined): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== undefined) {
                    this.options.clearTimer(timer);
                    timer = undefined;
                }
                abortSubscription?.dispose();
                abortSubscription = undefined;
                resolve(snapshot);
            };
            let budgetFiredSynchronously = false;
            const budget = this.options.setTimer(() => {
                budgetFiredSynchronously = true;
                if (entry.claimGeneration !== claimGeneration) {
                    settle(undefined);
                    return;
                }
                if (this.snapshots.get(key) === entry) {
                    this.snapshots.delete(key);
                }
                // Release the speculative provider work before the
                // authoritative foreground read starts. Adapters receive the
                // abort signal and can give the new target priority.
                entry.cancel();
                settle(undefined);
            }, CONVERSATION_SNAPSHOT_WARM_CLAIM_BUDGET_MS);
            if (!budgetFiredSynchronously) {
                timer = budget;
            }
            if (signal) {
                abortSubscription = signal.onAbort(() => {
                    settle(undefined);
                    // Queue handoff is itself asynchronous: a rapid repeat
                    // of this target cannot reclaim until the current queue
                    // task unwinds. Give that successor one event-loop turn
                    // to claim the shared warmup. A different target still
                    // releases it far ahead of the 120ms foreground budget.
                    this.schedule(() => {
                        if (entry.claimGeneration !== claimGeneration) {
                            return;
                        }
                        if (this.snapshots.get(key) === entry) {
                            this.snapshots.delete(key);
                        }
                        entry.cancel();
                    });
                });
            }
            void entry.promise.then(snapshot => settle(snapshot));
        });
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
    snapshotWarmup?: ConversationSnapshotWarmup,
    signal?: ConversationAbortSignal
): Promise<LatestConversationTargetResolution> {
    if (signal?.aborted) {
        return { result: 'unavailable' };
    }
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
            subagents = await awaitAbortableRead(
                coordinator.readSubagents(
                    target.provider,
                    target.sessionId,
                    signal
                ),
                signal
            );
        } catch (_error) {
            return {
                result: 'unavailable',
                diagnostic: conversationFollowDiagnosticBase(target),
            };
        }
        if (!subagents || signal?.aborted) {
            return { result: 'unavailable' };
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
            ? snapshotWarmup?.take(target.provider, effectiveSessionId, signal)
            : undefined;
        const resolvedWarmSnapshot = warmSnapshot
            ? await awaitAbortableRead(warmSnapshot, signal)
            : undefined;
        if (signal?.aborted) {
            return { result: 'unavailable' };
        }
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
        const resolvedSnapshot = usableWarmSnapshot
            || await awaitAbortableRead(
                typeof coordinator.readSnapshot === 'function'
                    ? coordinator.readSnapshot(
                        target.provider,
                        effectiveSessionId,
                        preferredInteractionId,
                        signal
                    )
                    : coordinator.readOutline(
                        target.provider,
                        effectiveSessionId,
                        signal
                    ).then(outline => ({ outline })),
                signal
            );
        if (!resolvedSnapshot || signal?.aborted) {
            return { result: 'unavailable' };
        }
        snapshot = resolvedSnapshot;
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
