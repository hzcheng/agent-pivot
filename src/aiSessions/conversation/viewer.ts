'use strict';

import { URL } from 'url';
import * as vscode from 'vscode';
import { AGENT_PIVOT_CONVERSATION_VIEW_TYPE } from '../../constants';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';
import type {
    ConversationCommentSnapshot,
    ConversationCommentStore,
} from './commentStore';
import type {
    ConversationBookmarkSnapshot,
    ConversationBookmarkStore,
} from './bookmarkStore';
import { ConversationCommentController } from './commentController';
import { ProjectCommentController } from './projectCommentController';
import type {
    ProjectCommentSnapshot,
    ProjectCommentStore,
} from './projectCommentStore';
import { ConversationBookmarkController } from './bookmarkController';
import { ConversationTelemetryController } from './conversationTelemetryController';
import {
    ConversationChangesController,
    ConversationChangesControllerOptions,
} from './conversationChangesController';
import {
    ConversationSessionStatus,
    ConversationSessionStatusController,
    ConversationSessionStatusKind,
} from './sessionStatusController';
import {
    escapeAttribute,
    renderConversationViewerDocument,
} from './viewerDocument';
import {
    ConversationOutlineController,
    ConversationViewerOutlineEntry,
} from './outlineController';
import {
    ConversationLocalFileTarget,
    parseConversationLocalFileLink,
    renderConversationMarkdown,
} from './markdown';
import { parseConversationViewerMessage } from './viewerProtocol';
import type {
    ConversationSessionSwitchDirection,
    ConversationViewerAppliedMessage,
    ConversationViewerCopyMessage,
} from './viewerProtocol';
import type { ConversationViewerTarget } from './viewerTarget';
export type { ConversationViewerTarget } from './viewerTarget';
import {
    formatConversationClockTime,
    formatWorkedDuration,
    truncateGraphemes,
} from './text';
import type { ConversationClockTime } from './text';
import { copyConversationMessage } from './model';
import {
    ConversationContentSignatureRegistry,
    ConversationContentStream,
    ConversationMessageRenderCache,
    createMessageRenderSignature,
} from './messageRenderCache';
import {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationAbortSignal,
    ConversationError,
    ConversationFileDiff,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationQuestionItem,
    ConversationResponseState,
    ConversationSnapshot,
    ConversationSubagentEntry,
    ConversationTelemetry,
} from './types';
import { encodeSubagentSessionId } from './subagentSessions';

export interface ConversationViewerOptions {
    createPanel: typeof vscode.window.createWebviewPanel;
    readSnapshot?: (
        provider: AiSessionProviderId,
        sessionId: string,
        preferredInteractionId: string | undefined,
        signal: ConversationAbortSignal
    ) => Promise<ConversationSnapshot>;
    readOutline: (
        provider: AiSessionProviderId,
        sessionId: string,
        signal: ConversationAbortSignal
    ) => Promise<ConversationOutline>;
    readPage: (
        request: ConversationPageRequest,
        signal: ConversationAbortSignal
    ) => Promise<ConversationPage>;
    readSubagents?: (
        provider: AiSessionProviderId,
        sessionId: string,
        signal?: ConversationAbortSignal
    ) => Promise<ConversationSubagentEntry[]>;
    readTelemetry?: (
        provider: AiSessionProviderId,
        sessionId: string,
        signal?: ConversationAbortSignal
    ) => Promise<ConversationTelemetry | undefined>;
    readSessionStatus?: (
        currentTarget: ConversationViewerTarget | undefined
    ) => ConversationSessionStatus | undefined;
    /** Cycle this window's sessions of one lifecycle group (header status
     * buttons); the Host owns focus, conversation open, and the cursor. */
    cycleLocalSessionStatus?: (
        kind: ConversationSessionStatusKind,
        currentTarget: ConversationViewerTarget | undefined
    ) => PromiseLike<void> | Promise<void> | void;
    /** Acknowledge (clear) the attention state of the session the viewer
     * currently shows (telemetry-bar provider icon click). The Host
     * recomputes the session's attention events authoritatively; clearing
     * a session that no longer needs attention is a safe no-op. */
    acknowledgeSessionAttention?: (
        currentTarget: ConversationViewerTarget
    ) => PromiseLike<void> | Promise<void> | void;
    /** Focus the previous/next open window (the bottom window rails). */
    switchAdjacentWindow?: (
        direction: ConversationSessionSwitchDirection
    ) => PromiseLike<void> | Promise<void> | void;
    watch: (
        provider: AiSessionProviderId,
        sessionId: string,
        onChange: () => void
    ) => AiSessionDisposable;
    restoreFocus: (
        target: ConversationViewerTarget
    ) => void | PromiseLike<void>;
    openExternal: (uri: vscode.Uri) => Thenable<boolean>;
    openLocalFile?: (
        target: ConversationLocalFileTarget
    ) => PromiseLike<void> | Promise<void> | void;
    mediaUri: (fileName: string) => vscode.Uri;
    showThinking?: () => boolean;
    submitPrompt: (
        target: ConversationViewerTarget,
        prompt: string
    ) => PromiseLike<void> | Promise<void>;
    focusSession?: (
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ) => boolean | void | PromiseLike<boolean | void>;
    commentStore?: ConversationCommentStore;
    projectCommentStore?: ProjectCommentStore;
    bookmarkStore?: ConversationBookmarkStore;
    /**
     * Changes-panel wiring (changes-panel PRD); absent disables the
     * Changes button and sidebar tab.
     */
    changes?: Omit<
        ConversationChangesControllerOptions,
        'getPanel' | 'getTarget' | 'getSubscriptionGeneration' | 'isSuspended'
    >;
    insertIntoActiveTerminal?: (
        text: string
    ) => PromiseLike<void> | Promise<void> | void;
    /** Run a command the user explicitly invoked from a rendered shell
     * snippet in the conversation's workspace terminal. */
    runCommandInTerminal?: (
        target: ConversationViewerTarget,
        command: string
    ) => PromiseLike<void> | Promise<void> | void;
    /** Rename the current session; the host owns the actual rename UX and
     * persistence, the refreshed authority updates the viewer header. */
    renameSession?: (
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ) => PromiseLike<void> | Promise<void> | void;
    writeClipboardText?: (
        text: string
    ) => PromiseLike<void> | Promise<void> | void;
    followAdjacentConversation?: (
        direction: ConversationSessionSwitchDirection,
        currentTarget: ConversationViewerTarget
    ) => PromiseLike<unknown> | Promise<unknown> | void;
    setKeyboardFocus?: (
        focused: boolean
    ) => PromiseLike<void> | Promise<void> | void;
    /** Diagnostics sink for load/switch failures (never throws). */
    onDiagnostic?: (event: Record<string, unknown>) => void;
    setTimer?: (callback: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface ConversationViewerApi extends AiSessionDisposable {
    isOpen(): boolean;
    focus(): boolean;
    showNotice(text: string): boolean;
    getCurrentTarget(): ConversationViewerTarget | undefined;
    getFocusedTarget(): ConversationViewerTarget | undefined;
    getFocusedSessionTarget(): Pick<
        ConversationViewerTarget,
        'projectId' | 'provider' | 'sessionId'
    > | undefined;
    open(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<void>;
    restore(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<void>;
    follow(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<boolean>;
    rebindSession(
        previous: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>,
        next: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean>;
    freezeSessionMetadata(
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean>;
    reconcileReboundSession(
        resolve: (
            target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
        ) => Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean>;
    navigateLatest(): Promise<void>;
    publishSessionStatus(): Promise<void>;
    refresh(): Promise<void>;
    revalidateLatest?(expectedInteractionId: string): Promise<void>;
    refreshPresentation(): Promise<void>;
    reconcileAuthority(
        resolveAuthority: (
            target: ConversationViewerTarget
        ) => boolean | ConversationViewerAuthorityMetadata
    ): Promise<void>;
}

export interface ConversationViewerAuthorityMetadata {
    displayName: string;
    duplicateDisplayName: boolean;
    /** Worktree task group display name; empty when the session is
     * group-less. */
    taskName?: string;
}

interface RetainedConversationPage {
    page: ConversationPage;
}

function conversationFrameTokenKey(
    target: Pick<
        ConversationViewerTarget,
        'projectId' | 'provider' | 'sessionId'
    >
): string {
    return `${target.projectId}\u0001${target.provider}\u0001${target.sessionId}`;
}

export interface ConversationViewerPageMessage {
    type: 'conversation-viewer-page';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    updateKind: 'initial' | 'navigation' | 'refresh';
    html?: string;
    htmlSignature: string;
    restoreFrame?: boolean;
    outline: ConversationViewerOutlineEntry[];
    selectedInteractionId: string;
    selectedInput: number;
    totalInputs: number;
    partial: boolean;
    atLatest: boolean;
    previousCursor?: string;
    nextCursor?: string;
    stale: boolean;
    displayName: string;
    subagents: ConversationSubagentEntry[];
    activeSubagent: { id: string; label: string } | null;
    target: Pick<
        ConversationViewerTarget,
        'projectId' | 'provider' | 'sessionId' | 'interactionId'
            | 'displayName' | 'duplicateDisplayName' | 'workspaceName'
            | 'taskName'
    >;
    comments: ConversationCommentSnapshot;
    projectComments: ProjectCommentSnapshot;
    bookmarks: ConversationBookmarkSnapshot;
}

export class ConversationViewer implements ConversationViewerApi {
    private panel?: vscode.WebviewPanel;
    private target?: ConversationViewerTarget;
    private watch?: AiSessionDisposable;
    private messageListener?: vscode.Disposable;
    private panelDisposeListener?: vscode.Disposable;
    private viewStateListener?: vscode.Disposable;
    private abortController?: ConversationAbortController;
    private pages: RetainedConversationPage[] = [];
    private readonly renderCache = new ConversationMessageRenderCache();
    private readonly contentSignatures =
        new ConversationContentSignatureRegistry();
    private subagents: ConversationSubagentEntry[] = [];
    private mainInteractionId?: string;
    private subscriptionGeneration = 0;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private currentRequestId = 0;
    private stale = false;
    private latestPublication?: ConversationViewerPageMessage;
    // Advanced only by the Webview's correlated applied acknowledgement —
    // never by postMessage resolving, which proves queueing, not application.
    private appliedContentSignature?: string;
    // The Webview's own report of which session frames it currently holds,
    // refreshed by every applied acknowledgement. Frame restores are
    // offered only for entries on this authoritative list — an applied ack
    // alone never implies the frame is still cached.
    private readonly webviewFrames = new Map<string, string>();
    private syncRebuildRequestId = 0;
    private suspended = false;
    private rebindGeneration = 0;
    private authoritativeLoadInFlight?: Promise<boolean>;
    private authoritativeRefreshPending = false;
    private authoritativeLatestRefreshPending?: string;
    private subagentDiscoveryGeneration = 0;
    private keyboardFocused = false;
    private readonly commentController: ConversationCommentController;
    private readonly projectCommentController: ProjectCommentController;
    private readonly bookmarkController: ConversationBookmarkController;
    private readonly outlineController = new ConversationOutlineController();
    private readonly telemetryController: ConversationTelemetryController;
    private readonly sessionStatusController: ConversationSessionStatusController;
    private readonly changesController?: ConversationChangesController;

    constructor(private readonly options: ConversationViewerOptions) {
        this.telemetryController = new ConversationTelemetryController({
            readTelemetry: options.readTelemetry,
            getPanel: () => this.panel,
            getTarget: () => this.target,
            getSubscriptionGeneration: () => this.subscriptionGeneration,
            getCurrentRequestId: () => this.currentRequestId,
            isSuspended: () => this.suspended,
            rebuildLatestDocument: () => this.rebuildLatestDocument(),
            onDidPublish: target => {
                void this.changesController?.onTelemetryRefreshed(target);
            },
            setTimer: options.setTimer,
            clearTimer: options.clearTimer,
        });
        if (options.changes) {
            this.changesController = new ConversationChangesController({
                ...options.changes,
                getPanel: () => this.panel,
                getTarget: () => this.target,
                getSubscriptionGeneration: () => this.subscriptionGeneration,
                isSuspended: () => this.suspended,
            });
        }
        this.sessionStatusController = new ConversationSessionStatusController({
            // Evaluated lazily at publish time so the classification always
            // matches the session the viewer shows right then, never a
            // target captured before a switch. Keep the reader absent (not
            // just returning undefined) when the option is missing: the
            // controller treats a missing reader as "status unsupported"
            // and must not publish zeroed statuses.
            readStatus: options.readSessionStatus
                ? () => options.readSessionStatus?.(this.target)
                : undefined,
            getPanel: () => this.panel,
            getSubscriptionGeneration: () => this.subscriptionGeneration,
            getCurrentRequestId: () => this.currentRequestId,
            isSuspended: () => this.suspended,
            rebuildLatestDocument: () => this.rebuildLatestDocument(),
        });
        this.commentController = new ConversationCommentController({
            commentStore: options.commentStore,
            submitPrompt: options.submitPrompt,
            focusSession: async target => {
                await options.focusSession?.(target);
            },
            getTarget: () => this.target,
            getSubscriptionGeneration: () => this.subscriptionGeneration,
            getPanel: () => this.panel,
            getMessages: () => this.messages(),
            navigateToInteraction: interactionId =>
                this.navigateToInteraction(interactionId),
            rebuildLatestDocument: () => this.rebuildLatestDocument(),
        });
        this.projectCommentController = new ProjectCommentController({
            projectCommentStore: options.projectCommentStore,
            submitPrompt: options.submitPrompt,
            focusSession: async target => {
                await options.focusSession?.(target);
            },
            getTarget: () => this.target,
            getSubscriptionGeneration: () => this.subscriptionGeneration,
            getPanel: () => this.panel,
            rebuildLatestDocument: () => this.rebuildLatestDocument(),
        });
        this.bookmarkController = new ConversationBookmarkController({
            bookmarkStore: options.bookmarkStore,
            getTarget: () => this.target,
            getSubscriptionGeneration: () => this.subscriptionGeneration,
            getPanel: () => this.panel,
            getOutline: () => this.outlineController.snapshot,
            rebuildLatestDocument: () => this.rebuildLatestDocument(),
        });
    }

    get snapshotSize(): number {
        return this.interactionIds().length;
    }

    isOpen(): boolean {
        return Boolean(this.panel);
    }

    focus(): boolean {
        const panel = this.panel;
        if (!panel) {
            return false;
        }
        panel.reveal(panel.viewColumn || vscode.ViewColumn.Active, false);
        return true;
    }

    showNotice(text: string): boolean {
        const panel = this.panel;
        if (!panel) {
            return false;
        }
        try {
            void Promise.resolve(panel.webview.postMessage({
                type: 'conversation-viewer-notice',
                text,
            })).catch(() => undefined);
        } catch (_error) {
            return false;
        }
        return true;
    }

    getCurrentTarget(): ConversationViewerTarget | undefined {
        if (!this.panel || !this.target) {
            return undefined;
        }
        return cloneViewerTarget(this.target);
    }

    getFocusedTarget(): ConversationViewerTarget | undefined {
        if (!this.panel?.active || !this.keyboardFocused || !this.target) {
            return undefined;
        }
        return cloneViewerTarget(this.target);
    }

    getFocusedSessionTarget(): Pick<
        ConversationViewerTarget,
        'projectId' | 'provider' | 'sessionId'
    > | undefined {
        if (!this.panel?.active || !this.keyboardFocused || !this.target) {
            return undefined;
        }
        return {
            projectId: this.target.projectId,
            provider: this.target.provider,
            sessionId: this.target.sessionId,
        };
    }

    async open(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<void> {
        await this.loadTarget(target, true, snapshot);
    }

    async restore(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<void> {
        if (this.panel && this.panel !== panel) {
            panel.dispose();
            return;
        }
        panel.webview.options = this.webviewOptions();
        this.attachPanel(panel);
        await this.loadTarget(target, false, snapshot, true);
    }

    async follow(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<boolean> {
        if (!this.panel) {
            return false;
        }
        // A dashboard-driven follow for the same session must not yank the
        // user out of a subagent transcript they deliberately opened.
        if (this.target?.subagent
            && this.target.projectId === target.projectId
            && this.target.provider === target.provider
            && this.target.sessionId === target.sessionId) {
            return true;
        }
        return this.loadTarget(target, false, snapshot);
    }

    async rebindSession(
        previous: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>,
        next: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean> {
        const current = this.target;
        if (!this.panel || !current
            || current.projectId !== previous.projectId
            || current.provider !== previous.provider
            || current.sessionId !== previous.sessionId
            || next.projectId !== previous.projectId
            || next.provider !== previous.provider
            || next.sessionId === previous.sessionId) {
            return false;
        }
        const rebindGeneration = ++this.rebindGeneration;
        let outline: ConversationOutline;
        let snapshot: ConversationSnapshot | undefined;
        try {
            const rebindRead = new ConversationAbortController();
            if (this.options.readSnapshot) {
                snapshot = await this.options.readSnapshot(
                    next.provider,
                    next.sessionId,
                    current.interactionId,
                    rebindRead.signal
                );
                outline = snapshot.outline;
            } else {
                outline = await this.options.readOutline(
                    next.provider,
                    next.sessionId,
                    rebindRead.signal
                );
            }
        } catch (_error) {
            return false;
        }
        if (rebindGeneration !== this.rebindGeneration
            || this.target !== current || !this.panel
            || outline.provider !== next.provider
            || outline.sessionId !== next.sessionId
            || !outline.interactions.length) {
            return false;
        }
        const selected = outline.interactions.find(interaction =>
            interaction.id === current.interactionId
        ) || outline.interactions[outline.interactions.length - 1];
        const { subagent: _oldSubagent, ...rootTarget } = current;
        return this.loadTarget({
            ...rootTarget,
            sessionId: next.sessionId,
            interactionId: selected.id,
            expectedRevision: outline.sourceRevision,
        }, false, snapshot);
    }

    async freezeSessionMetadata(
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean> {
        const current = this.target;
        if (!this.panel || !current
            || current.projectId !== target.projectId
            || current.provider !== target.provider
            || current.sessionId !== target.sessionId) {
            await Promise.all([
                this.commentController.drainMutations(),
                this.projectCommentController.drainMutations(),
                this.bookmarkController.drainMutations(),
            ]);
            return false;
        }
        await Promise.all([
            this.commentController.freezeMutations(),
            this.bookmarkController.freezeMutations(),
        ]);
        return this.target === current && Boolean(this.panel);
    }

    async reconcileReboundSession(
        resolve: (
            target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
        ) => Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ): Promise<boolean> {
        const current = this.target;
        if (!this.panel || !current) {
            return false;
        }
        const previous = {
            projectId: current.projectId,
            provider: current.provider,
            sessionId: current.sessionId,
        };
        const next = resolve(previous);
        if (next.projectId === previous.projectId
            && next.provider === previous.provider
            && next.sessionId === previous.sessionId) {
            return false;
        }
        return this.rebindSession(previous, next);
    }

    private async loadTarget(
        target: ConversationViewerTarget,
        reveal: boolean,
        snapshot?: ConversationSnapshot,
        forceDocumentReplacement = false
    ): Promise<boolean> {
        const hadPanel = Boolean(this.panel);
        const followedPanel = reveal ? undefined : this.panel;
        const previousTarget = this.target;
        const generation = this.replaceTarget(target);
        const activeTarget = this.target;
        if (!activeTarget) {
            return false;
        }
        const panel = reveal ? this.ensurePanel() : this.panel;
        if (!panel || (!reveal && panel !== followedPanel)) {
            this.emitDiagnostic('load-target-no-panel');
            return false;
        }
        panel.title = 'AI Conversation';
        if (reveal) {
            panel.reveal(vscode.ViewColumn.Active);
        }
        const replaceDocument = forceDocumentReplacement || !hadPanel;
        if (replaceDocument) {
            panel.webview.html = this.renderDocument(
                undefined,
                'Loading conversation…'
            );
        } else if (!previousTarget
            || previousTarget.projectId !== activeTarget.projectId
            || previousTarget.provider !== activeTarget.provider
            || previousTarget.sessionId !== activeTarget.sessionId) {
            // Surface the target transition before optional local metadata
            // (comments, project notes, bookmarks) finishes loading. The
            // generation guard below still prevents stale metadata from ever
            // reaching the newly selected session.
            this.postLoadingNotice(panel, activeTarget, generation);
        }
        await Promise.all([
            this.commentController.restore(activeTarget, generation),
            this.projectCommentController.restore(activeTarget, generation),
            this.bookmarkController.restore(activeTarget, generation),
        ]);
        if (this.target !== activeTarget
            || this.subscriptionGeneration !== generation) {
            return false;
        }
        this.ensureWatch(generation);
        const loaded = await this.loadAuthoritative(
            'initial',
            replaceDocument,
            snapshot
        );
        if (loaded && this.target === activeTarget
            && this.subscriptionGeneration === generation) {
            this.telemetryController.activate(
                activeTarget,
                generation,
                this.effectiveSessionId(activeTarget)
            );
            void this.changesController?.activate(activeTarget)
                .catch(() => undefined);
            // Heal status updates that were discarded by the Webview while
            // this target transition was in flight.
            void this.sessionStatusController.republish();
        }
        return loaded;
    }

    async refresh(): Promise<void> {
        const target = this.target;
        if (!target || !this.panel || this.suspended) {
            return;
        }
        await this.loadAuthoritative(
            'refresh',
            false,
            undefined,
            this.outlineController.latestInteractionId()
        );
    }

    async revalidateLatest(expectedInteractionId: string): Promise<void> {
        if (!this.target || !this.panel || this.suspended
            || this.outlineController.selection !== expectedInteractionId) {
            return;
        }
        await this.loadAuthoritative(
            'refresh',
            false,
            undefined,
            expectedInteractionId
        );
    }

    async refreshPresentation(): Promise<void> {
        const pendingLoad = this.authoritativeLoadInFlight;
        if (pendingLoad) {
            try {
                await pendingLoad;
            } catch (_error) {
                // The normal load path owns its failure presentation.
            }
        }
        if (!this.panel || !this.target || !this.outlineController.snapshot
            || !this.pages.length || this.suspended) {
            return;
        }
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        await this.deliverPublication(this.createPublication(
            requestId,
            this.subscriptionGeneration,
            'refresh'
        ), false);
    }

    async reconcileAuthority(
        resolveAuthority: (
            target: ConversationViewerTarget
        ) => boolean | ConversationViewerAuthorityMetadata
    ): Promise<void> {
        const target = this.target;
        const panel = this.panel;
        if (!target || !panel) {
            return;
        }
        let authority: boolean | ConversationViewerAuthorityMetadata = false;
        try {
            authority = resolveAuthority({ ...target });
        } catch (_error) {
            authority = false;
        }
        const available = authority === true
            || (Boolean(authority) && typeof authority === 'object');
        if (!available) {
            if (this.suspended) {
                return;
            }
            this.suspended = true;
            this.telemetryController.pause();
            this.authoritativeLoadInFlight = undefined;
            this.authoritativeRefreshPending = false;
            this.abortController?.abort();
            this.abortController = undefined;
            this.watch?.dispose();
            this.watch = undefined;
            this.subscriptionGeneration += 1;
            this.currentRequestId = this.allocateRequestId();
            if (this.pages.length && this.outlineController.snapshot) {
                this.stale = true;
                await this.deliverPublication(this.createPublication(
                    this.currentRequestId,
                    this.subscriptionGeneration,
                    'refresh'
                ), false);
            } else {
                panel.webview.html = this.renderDocument(
                    undefined,
                    'Conversation history unavailable.'
                );
            }
            return;
        }
        let metadataChanged = false;
        if (typeof authority === 'object') {
            const displayName = boundedConversationDisplayName(
                authority.displayName
            );
            const taskName = typeof authority.taskName === 'string'
                ? authority.taskName
                : '';
            metadataChanged = target.displayName !== displayName
                || target.duplicateDisplayName
                    !== authority.duplicateDisplayName
                || (target.taskName || '') !== taskName;
            target.displayName = displayName;
            target.duplicateDisplayName = authority.duplicateDisplayName;
            target.taskName = taskName || undefined;
        }
        const wasSuspended = this.suspended;
        if (wasSuspended
            && !this.ensureWatch(this.subscriptionGeneration, true)) {
            return;
        }
        this.suspended = false;
        await this.refresh();
        if (this.target === target && !this.suspended) {
            this.telemetryController.activate(
                target,
                this.subscriptionGeneration,
                this.effectiveSessionId(target)
            );
            void this.changesController?.activate(target)
                .catch(() => undefined);
            // activate() early-returns for the same session, but the panel
            // slept while suspended — force a fresh collection so the
            // changes view never shows pre-suspend data (PRD §5.4).
            void this.changesController?.handleRefresh()
                .catch(() => undefined);
            // Replay statuses that were skipped while the viewer was
            // suspended.
            void this.sessionStatusController.republish();
        }
        const expectedDisplayName = visibleConversationDisplayName(target);
        if (metadataChanged
            && this.latestPublication?.displayName !== expectedDisplayName) {
            await this.refreshPresentation();
        }
    }

    dispose(): void {
        if (this.panel) {
            this.panel.dispose();
            return;
        }
        this.clear(undefined);
    }

    private emitDiagnostic(reason: string, detail?: Record<string, unknown>) {
        try {
            this.options.onDiagnostic?.({
                event: 'conversation-viewer',
                reason,
                sessionId: this.target?.sessionId,
                provider: this.target?.provider,
                generation: this.subscriptionGeneration,
                ...detail,
            });
        } catch (_error) {
            // Diagnostics never break the viewer.
        }
    }

    private replaceTarget(target: ConversationViewerTarget): number {
        this.authoritativeLoadInFlight = undefined;
        this.authoritativeRefreshPending = false;
        this.authoritativeLatestRefreshPending = undefined;
        this.subagentDiscoveryGeneration += 1;
        this.abortController?.abort();
        this.abortController = undefined;
        this.watch?.dispose();
        this.watch = undefined;
        this.pages = [];
        this.subagents = [];
        this.outlineController.reset(target.interactionId);
        this.stale = false;
        this.telemetryController.reset();
        this.changesController?.reset();
        this.latestPublication = undefined;
        this.appliedContentSignature = undefined;
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.target = {
            ...target,
            displayName: boundedConversationDisplayName(target.displayName),
        };
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.currentRequestId = 0;
        return this.subscriptionGeneration;
    }

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }
        const panel = this.options.createPanel(
            AGENT_PIVOT_CONVERSATION_VIEW_TYPE,
            'AI Conversation',
            vscode.ViewColumn.Active,
            this.webviewOptions()
        );
        this.attachPanel(panel);
        return panel;
    }

    private webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
        return {
            enableScripts: true,
            localResourceRoots: [this.options.mediaUri('')],
            retainContextWhenHidden: true,
        };
    }

    private attachPanel(panel: vscode.WebviewPanel): void {
        if (this.panel === panel) {
            return;
        }
        this.panel = panel;
        this.publishKeyboardFocus(false, true);
        this.messageListener = panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message)
        );
        this.viewStateListener = panel.onDidChangeViewState(event => {
            if (this.panel !== panel || event.webviewPanel !== panel) {
                return;
            }
            if (!panel.active) {
                this.publishKeyboardFocus(false);
            }
            if (!panel.visible) {
                this.telemetryController.pause();
            } else if (this.target && !this.suspended) {
                this.telemetryController.activate(
                    this.target,
                    this.subscriptionGeneration,
                    this.effectiveSessionId(this.target)
                );
            }
        });
        this.panelDisposeListener = panel.onDidDispose(() => {
            if (this.panel !== panel) {
                return;
            }
            const restoreTarget = this.target;
            this.panel = undefined;
            this.clear(restoreTarget);
            if (restoreTarget) {
                try {
                    void Promise.resolve(
                        this.options.restoreFocus(restoreTarget)
                    ).catch(() => undefined);
                } catch (_error) {
                    // Focus restoration is optional and never blocks disposal.
                }
            }
        });
    }

    private clear(_restoreTarget: ConversationViewerTarget | undefined): void {
        this.authoritativeLoadInFlight = undefined;
        this.authoritativeRefreshPending = false;
        this.authoritativeLatestRefreshPending = undefined;
        this.subagentDiscoveryGeneration += 1;
        this.abortController?.abort();
        this.abortController = undefined;
        this.watch?.dispose();
        this.watch = undefined;
        this.messageListener?.dispose();
        this.messageListener = undefined;
        this.panelDisposeListener?.dispose();
        this.panelDisposeListener = undefined;
        this.viewStateListener?.dispose();
        this.viewStateListener = undefined;
        this.pages = [];
        this.renderCache.clear();
        this.contentSignatures.clear();
        this.webviewFrames.clear();
        this.outlineController.reset();
        this.target = undefined;
        this.stale = false;
        this.telemetryController.reset();
        this.changesController?.reset();
        this.latestPublication = undefined;
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.publishKeyboardFocus(false);
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.currentRequestId = 0;
    }

    private async handleMessage(message: unknown): Promise<void> {
        const parsed = parseConversationViewerMessage(message);
        if (!parsed || !this.panel) {
            return;
        }
        if (parsed.type === 'conversation-viewer-focus') {
            this.publishKeyboardFocus(parsed.focused && this.panel.active);
            return;
        }
        if (!this.target) {
            return;
        }
        if (parsed.type === 'conversation-viewer-open-link') {
            await this.openLink(parsed.href);
            return;
        }
        if (parsed.type === 'conversation-viewer-run-command'
            || parsed.type === 'conversation-viewer-changes-refresh'
            || parsed.type === 'conversation-viewer-changes-select'
            || parsed.type === 'conversation-viewer-changes-open-file'
            || parsed.type === 'conversation-viewer-changes-review'
            || parsed.type === 'conversation-viewer-changes-open-scm'
            || parsed.type === 'conversation-viewer-commits-list'
            || parsed.type === 'conversation-viewer-commit-detail'
            || parsed.type === 'conversation-viewer-commit-open-file'
            || parsed.type === 'conversation-viewer-commit-review') {
            // Changes actions are bound to the authoritative target and
            // generation: an intent stranded by a session switch must not
            // act on the newly active session when member IDs overlap.
            const target = this.target;
            if (!target
                || parsed.subscriptionGeneration
                    !== this.subscriptionGeneration
                || parsed.projectId !== target.projectId
                || parsed.provider !== target.provider
                || parsed.sessionId !== target.sessionId) {
                this.emitDiagnostic(
                    parsed.type === 'conversation-viewer-run-command'
                        ? 'run-command-dropped-stale'
                        : 'changes-action-dropped-stale', {
                    requestGeneration: parsed.subscriptionGeneration,
                });
                return;
            }
        }
        if (parsed.type === 'conversation-viewer-run-command') {
            await this.options.runCommandInTerminal?.(
                this.target,
                parsed.command
            );
            return;
        }
        if (parsed.type === 'conversation-viewer-changes-refresh') {
            await this.changesController?.handleRefresh();
            return;
        }
        if (parsed.type === 'conversation-viewer-changes-select') {
            this.changesController?.handleSelect(parsed.memberId);
            return;
        }
        if (parsed.type === 'conversation-viewer-changes-open-file') {
            await this.changesController?.handleOpenFile({
                memberId: parsed.memberId,
                item: {
                    group: parsed.group,
                    xy: parsed.xy,
                    path: parsed.path,
                    ...(parsed.originalPath
                        ? { originalPath: parsed.originalPath }
                        : {}),
                },
            });
            return;
        }
        if (parsed.type === 'conversation-viewer-changes-review') {
            await this.changesController?.handleReview(parsed.memberId);
            return;
        }
        if (parsed.type === 'conversation-viewer-changes-open-scm') {
            await this.changesController?.handleOpenScm(parsed.memberId);
            return;
        }
        if (parsed.type === 'conversation-viewer-commits-list') {
            await this.changesController?.handleCommitsList({
                requestId: parsed.requestId,
                memberId: parsed.memberId,
                scope: parsed.scope,
                offset: parsed.offset,
                ...(parsed.historyHead
                    ? { historyHead: parsed.historyHead }
                    : {}),
            });
            return;
        }
        if (parsed.type === 'conversation-viewer-commit-detail') {
            await this.changesController?.handleCommitDetail({
                requestId: parsed.requestId,
                memberId: parsed.memberId,
                sha: parsed.sha,
            });
            return;
        }
        if (parsed.type === 'conversation-viewer-commit-open-file') {
            await this.changesController?.handleCommitOpenFile({
                memberId: parsed.memberId,
                sha: parsed.sha,
                path: parsed.path,
                ...(parsed.oldPath ? { oldPath: parsed.oldPath } : {}),
            });
            return;
        }
        if (parsed.type === 'conversation-viewer-commit-review') {
            await this.changesController?.handleCommitReview({
                memberId: parsed.memberId,
                sha: parsed.sha,
            });
            return;
        }
        if (parsed.type === 'conversation-viewer-rename-session') {
            const target = this.target;
            if (target) {
                await this.options.renameSession?.({
                    projectId: target.projectId,
                    provider: target.provider,
                    sessionId: target.sessionId,
                });
            }
            return;
        }
        if (parsed.type === 'conversation-viewer-send-selection') {
            await this.options.insertIntoActiveTerminal?.(parsed.text);
            return;
        }
        if (parsed.type === 'conversation-viewer-switch-session') {
            const currentTarget = this.target;
            await this.options.followAdjacentConversation?.(
                parsed.direction,
                currentTarget
            );
            return;
        }
        if (parsed.type === 'conversation-viewer-cycle-status-session') {
            const currentTarget = this.target;
            await this.options.cycleLocalSessionStatus?.(
                parsed.kind,
                currentTarget
            );
            return;
        }
        if (parsed.type === 'conversation-viewer-acknowledge-attention') {
            const currentTarget = this.target;
            if (currentTarget) {
                await this.options.acknowledgeSessionAttention?.(currentTarget);
            }
            return;
        }
        if (parsed.type === 'conversation-viewer-switch-window') {
            await this.options.switchAdjacentWindow?.(parsed.direction);
            return;
        }
        if (parsed.type === 'conversation-viewer-applied') {
            this.acknowledgePublication(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-request-sync') {
            // The Webview failed to apply a delivered publication; rebuild
            // the document with the full HTML so a dropped delta cannot
            // strand it on stale content. Bound to one rebuild per
            // publication: a persistent apply failure must not loop. A
            // request correlated to a superseded generation or session is
            // stale — the current target's own delivery and ack closure
            // recovers the Webview — so it must not rebuild the incoming
            // session's document.
            const target = this.target;
            if (!target
                || parsed.subscriptionGeneration
                    !== this.subscriptionGeneration
                || parsed.projectId !== target.projectId
                || parsed.provider !== target.provider
                || parsed.sessionId !== target.sessionId) {
                this.emitDiagnostic('resync-dropped-stale', {
                    requestGeneration: parsed.subscriptionGeneration,
                });
                return;
            }
            const publication = this.latestPublication;
            if (publication
                && publication.requestId !== this.syncRebuildRequestId) {
                this.syncRebuildRequestId = publication.requestId;
                this.emitDiagnostic('resync-rebuild', {
                    ...(parsed.applyError
                        ? { applyError: parsed.applyError }
                        : {}),
                });
                this.rebuildLatestDocument();
            }
            return;
        }
        if (parsed.type === 'conversation-viewer-comment-mutation'
            || parsed.type === 'conversation-viewer-send-comments') {
            await this.commentController.enqueue(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-project-comment-mutation'
            || parsed.type === 'conversation-viewer-send-project-comment') {
            await this.projectCommentController.enqueue(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-bookmark-mutation') {
            await this.bookmarkController.enqueue(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-copy') {
            await this.settleCopy(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-locate-comment') {
            await this.commentController.locate(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-open-subagent') {
            await this.openSubagent(parsed.subagentId);
            return;
        }
        if (parsed.type === 'conversation-viewer-close-subagent') {
            await this.closeSubagent();
            return;
        }
        if (parsed.type === 'conversation-viewer-select-interaction') {
            await this.navigateToInteraction(parsed.interactionId);
            return;
        }
        if (parsed.type === 'conversation-viewer-previous') {
            await this.navigate('before');
            return;
        }
        if (parsed.type === 'conversation-viewer-next') {
            await this.navigate('after');
            return;
        }
        await this.navigateLatest();
    }

    private async settleCopy(
        message: ConversationViewerCopyMessage
    ): Promise<void> {
        const target = this.target;
        let text: string | undefined;
        let error: 'invalid' | 'failed' | undefined;
        if (!target
            || message.subscriptionGeneration !== this.subscriptionGeneration
            || message.projectId !== target.projectId
            || message.provider !== target.provider
            || message.sessionId !== target.sessionId) {
            error = 'invalid';
        } else if (message.payload.kind === 'code') {
            text = message.payload.text;
        } else {
            const messageId = message.payload.messageId;
            text = this.messages().find(
                candidate => candidate.id === messageId
            )?.markdown;
            if (text === undefined) {
                error = 'invalid';
            }
        }
        if (!error && text !== undefined) {
            try {
                const write = this.options.writeClipboardText
                    ?? (value => vscode.env.clipboard.writeText(value));
                await write(text);
            } catch (_error) {
                error = 'failed';
            }
        }
        try {
            await this.panel?.webview.postMessage({
                type: 'conversation-viewer-copy-result',
                version: 1,
                requestId: message.requestId,
                success: !error,
                ...(error ? { error } : {}),
            });
        } catch (_error) {
            // The clipboard outcome is already decided; a dead panel needs
            // no settlement.
        }
    }

    private publishKeyboardFocus(focused: boolean, force = false): void {
        if (!force && this.keyboardFocused === focused) {
            return;
        }
        this.keyboardFocused = focused;
        try {
            void Promise.resolve(this.options.setKeyboardFocus?.(focused))
                .catch(() => undefined);
        } catch (_error) {
            // Focus context is advisory and must not break the viewer.
        }
    }

    private effectiveSessionId(target: ConversationViewerTarget): string {
        return target.subagent
            ? encodeSubagentSessionId(target.sessionId, target.subagent.id)
            : target.sessionId;
    }

    private async readSubagentsSafely(
        target: ConversationViewerTarget
    ): Promise<ConversationSubagentEntry[]> {
        if (typeof this.options.readSubagents !== 'function') {
            return [];
        }
        try {
            return await this.options.readSubagents(
                target.provider,
                target.sessionId
            );
        } catch (_error) {
            return [];
        }
    }

    private async switchConversationView(
        target: ConversationViewerTarget
    ): Promise<void> {
        // In-place subagent switch: keep the subscription generation and the
        // request counter so the publication applies through the normal page
        // channel instead of rebuilding the whole document. Stale in-flight
        // loads are still rejected by target identity and request id checks.
        if (!this.panel) {
            return;
        }
        this.authoritativeLoadInFlight = undefined;
        this.authoritativeRefreshPending = false;
        this.authoritativeLatestRefreshPending = undefined;
        this.subagentDiscoveryGeneration += 1;
        this.abortController?.abort();
        this.abortController = undefined;
        this.watch?.dispose();
        this.watch = undefined;
        this.pages = [];
        this.outlineController.reset(target.interactionId);
        this.stale = false;
        this.telemetryController.reset();
        this.latestPublication = undefined;
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.target = { ...target };
        this.suspended = false;
        this.currentRequestId = 0;
        const generation = this.subscriptionGeneration;
        const activeTarget = this.target;
        await Promise.all([
            this.commentController.restore(activeTarget, generation),
            this.projectCommentController.restore(activeTarget, generation),
            this.bookmarkController.restore(activeTarget, generation),
        ]);
        if (this.target !== activeTarget
            || this.subscriptionGeneration !== generation) {
            return;
        }
        this.ensureWatch(generation);
        await this.loadAuthoritative('initial', false);
        if (this.target === activeTarget
            && this.subscriptionGeneration === generation) {
            // Heal status updates that were discarded by the Webview while
            // the in-place view switch was in flight.
            void this.sessionStatusController.republish();
        }
    }

    private async openSubagent(subagentId: string): Promise<void> {
        const target = this.target;
        if (!target || !this.panel || target.subagent?.id === subagentId) {
            return;
        }
        const entry = this.subagents.find(item => item.id === subagentId);
        if (!entry) {
            return;
        }
        const effectiveId = encodeSubagentSessionId(target.sessionId, entry.id);
        let outline: ConversationOutline;
        try {
            outline = await this.options.readOutline(
                target.provider,
                effectiveId,
                new ConversationAbortController().signal
            );
        } catch (_error) {
            return;
        }
        if (this.target !== target || outline.sessionId !== effectiveId
            || !outline.interactions.length) {
            return;
        }
        if (!target.subagent) {
            this.mainInteractionId = this.outlineController.selection;
        }
        const anchor = outline.interactions[
            outline.interactions.length - 1
        ].id;
        await this.switchConversationView({
            ...target,
            subagent: { id: entry.id, label: entry.label },
            interactionId: anchor,
            expectedRevision: outline.sourceRevision,
        });
    }

    private async closeSubagent(): Promise<void> {
        const target = this.target;
        if (!target || !this.panel || !target.subagent) {
            return;
        }
        let outline: ConversationOutline;
        try {
            outline = await this.options.readOutline(
                target.provider,
                target.sessionId,
                new ConversationAbortController().signal
            );
        } catch (_error) {
            return;
        }
        if (this.target !== target || outline.sessionId !== target.sessionId
            || !outline.interactions.length) {
            return;
        }
        const interactionIds = outline.interactions.map(
            interaction => interaction.id
        );
        const anchor = this.mainInteractionId
            && interactionIds.includes(this.mainInteractionId)
            ? this.mainInteractionId as string
            : interactionIds[interactionIds.length - 1];
        this.mainInteractionId = undefined;
        const restored = { ...target };
        delete restored.subagent;
        await this.switchConversationView({
            ...restored,
            interactionId: anchor,
            expectedRevision: outline.sourceRevision,
        });
    }

    private async openLink(href: string): Promise<void> {
        const localFile = parseConversationLocalFileLink(href);
        if (localFile) {
            await this.options.openLocalFile?.(localFile);
            return;
        }
        let parsed: URL;
        try {
            parsed = new URL(href);
        } catch (_error) {
            return;
        }
        if (parsed.protocol !== 'https:') {
            return;
        }
        await this.options.openExternal(vscode.Uri.parse(href));
    }

    private async navigate(direction: 'before' | 'after'): Promise<boolean> {
        const target = this.target;
        const outline = this.outlineController.snapshot;
        const selectedInteractionId = this.outlineController.selection;
        if (!target || !outline || !selectedInteractionId || !this.pages.length) {
            return false;
        }
        const nextInteractionId = this.outlineController.adjacentInteractionId(
            direction
        );
        if (!nextInteractionId) {
            return false;
        }
        if (this.interactionIds().includes(nextInteractionId)) {
            return this.publishSelection(nextInteractionId, 'navigation');
        }
        const edge = direction === 'before'
            ? this.pages[0].page
            : this.pages[this.pages.length - 1].page;
        const cursor = direction === 'before'
            ? edge.previousCursor
            : edge.nextCursor;
        const states = edge.interactionStates;
        const anchorInteractionId = direction === 'before'
            ? states[0]?.interactionId
            : states[states.length - 1]?.interactionId;
        if (!cursor || !anchorInteractionId) {
            return this.read({
                provider: target.provider,
                sessionId: this.effectiveSessionId(target),
                anchorInteractionId: nextInteractionId,
                direction: 'around',
                expectedRevision: outline.sourceRevision,
                limit: CONVERSATION_LIMITS.maxPageInteractions,
            }, 'replace', false, 'navigation', nextInteractionId);
        }
        return this.read({
            provider: target.provider,
            sessionId: this.effectiveSessionId(target),
            anchorInteractionId,
            direction,
            cursor,
            expectedRevision: outline.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        }, direction, false, 'navigation', nextInteractionId);
    }

    async navigateLatest(): Promise<void> {
        const target = this.target;
        const outline = this.outlineController.snapshot;
        const latestInteractionId = this.outlineController.latestInteractionId();
        if (!target || !outline || !latestInteractionId) {
            return;
        }
        if (this.interactionIds().includes(latestInteractionId)) {
            await this.publishSelection(latestInteractionId, 'navigation');
            return;
        }
        await this.read({
            provider: target.provider,
            sessionId: this.effectiveSessionId(target),
            anchorInteractionId: latestInteractionId,
            direction: 'around',
            expectedRevision: outline.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        }, 'replace', false, 'navigation', latestInteractionId);
    }

    publishSessionStatus(): Promise<void> {
        return this.sessionStatusController.publish();
    }

    private async navigateToInteraction(
        interactionId: string
    ): Promise<boolean> {
        const target = this.target;
        const outline = this.outlineController.snapshot;
        if (!target || !outline
            || !this.outlineController.contains(interactionId)) {
            return false;
        }
        if (this.interactionIds().includes(interactionId)) {
            return this.publishSelection(interactionId, 'navigation');
        }
        return this.read({
            provider: target.provider,
            sessionId: this.effectiveSessionId(target),
            anchorInteractionId: interactionId,
            direction: 'around',
            expectedRevision: outline.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        }, 'replace', false, 'navigation', interactionId);
    }

    private loadAuthoritative(
        updateKind: 'initial' | 'refresh',
        replaceDocument: boolean,
        snapshot?: ConversationSnapshot,
        latestIfSelection?: string
    ): Promise<boolean> {
        if (this.authoritativeLoadInFlight) {
            this.authoritativeRefreshPending = true;
            if (latestIfSelection !== undefined) {
                this.authoritativeLatestRefreshPending = latestIfSelection;
            }
            return this.authoritativeLoadInFlight;
        }
        let loadInFlight: Promise<boolean>;
        loadInFlight = this.performAuthoritativeLoad(
            updateKind,
            replaceDocument,
            snapshot,
            latestIfSelection
        ).finally(() => {
            if (this.authoritativeLoadInFlight !== loadInFlight) {
                return;
            }
            this.authoritativeLoadInFlight = undefined;
            if (!this.authoritativeRefreshPending
                || !this.target
                || !this.panel
                || this.suspended) {
                return;
            }
            this.authoritativeRefreshPending = false;
            let pendingLatest = this.authoritativeLatestRefreshPending;
            this.authoritativeLatestRefreshPending = undefined;
            const currentLatest = this.outlineController.latestInteractionId();
            if (pendingLatest !== undefined
                && this.outlineController.selection !== pendingLatest
                && this.outlineController.selection === currentLatest) {
                // The in-flight refresh followed the former latest input.
                // Continue from the newly published latest input when another
                // watcher invalidation was coalesced behind it. A historical
                // user selection does not satisfy this condition, so it stays
                // pinned instead of being pulled back to the tail.
                pendingLatest = currentLatest;
            }
            void this.loadAuthoritative(
                'refresh',
                false,
                undefined,
                pendingLatest
            );
        });
        this.authoritativeLoadInFlight = loadInFlight;
        return loadInFlight;
    }

    private async performAuthoritativeLoad(
        updateKind: 'initial' | 'refresh',
        replaceDocument: boolean,
        prefetchedSnapshot?: ConversationSnapshot,
        latestIfSelection?: string
    ): Promise<boolean> {
        const target = this.target;
        const panel = this.panel;
        if (!target || !panel || this.suspended) {
            return false;
        }
        this.abortController?.abort();
        const abortController = new ConversationAbortController();
        this.abortController = abortController;
        const generation = this.subscriptionGeneration;
        const subagentDiscoveryGeneration =
            ++this.subagentDiscoveryGeneration;
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        const previousSelectedInteractionId = this.outlineController.selection;
        const followLatest = updateKind === 'refresh'
            && latestIfSelection !== undefined
            && previousSelectedInteractionId === latestIfSelection;
        try {
            const preferredInteractionId = updateKind === 'initial'
                ? target.interactionId
                : followLatest
                    ? undefined
                    : previousSelectedInteractionId;
            let snapshot = prefetchedSnapshot;
            if (!snapshot && this.options.readSnapshot) {
                snapshot = await this.options.readSnapshot(
                    target.provider,
                    this.effectiveSessionId(target),
                    preferredInteractionId,
                    abortController.signal
                );
            }
            let outline = snapshot?.outline || await this.options.readOutline(
                target.provider,
                this.effectiveSessionId(target),
                abortController.signal
            );
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            if (outline.provider !== target.provider
                || outline.sessionId !== this.effectiveSessionId(target)
                || !outline.interactions.length) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            const interactionIds = outline.interactions.map(
                interaction => interaction.id
            );
            let advanceToLatest = followLatest
                && interactionIds.includes(latestIfSelection as string);
            if (updateKind === 'initial'
                && !interactionIds.includes(target.interactionId)) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (updateKind === 'refresh'
                && !advanceToLatest
                && (!previousSelectedInteractionId
                    || !interactionIds.includes(previousSelectedInteractionId))) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            let selectedInteractionId = updateKind === 'initial'
                ? target.interactionId
                : advanceToLatest
                    ? interactionIds[interactionIds.length - 1]
                    : previousSelectedInteractionId as string;
            let lifecycleProjectionInteractionId: string | undefined;
            const retainedOutline = this.outlineController.snapshot;
            const retainedRevisionMatches = retainedOutline?.sourceRevision
                === outline.sourceRevision;
            if (updateKind === 'refresh' && !this.stale && retainedOutline) {
                const sameInteractionIds = retainedOutline.interactions.length
                    === outline.interactions.length
                    && outline.interactions.every((interaction, index) =>
                        retainedOutline.interactions[index].id
                            === interaction.id
                    );
                const lifecycleChangedInteractionIds = sameInteractionIds
                    ? outline.interactions.filter((interaction, index) =>
                        retainedOutline.interactions[index].responseState
                            !== interaction.responseState
                    ).map(interaction => interaction.id)
                    : [];
                if (retainedRevisionMatches
                    && !lifecycleChangedInteractionIds.length) {
                    void this.telemetryController.refresh(
                        target,
                        generation,
                        this.effectiveSessionId(target)
                    );
                    return true;
                }
                // Lifecycle projection can change both responseState and the
                // latest assistant/progress roles. Re-read the bounded page
                // even though provider content is unchanged so retained HTML
                // cannot lag behind the authoritative turn state.
                const loadedInteractionIds = new Set(this.interactionIds());
                for (let index = lifecycleChangedInteractionIds.length - 1;
                    index >= 0;
                    index--) {
                    const interactionId = lifecycleChangedInteractionIds[index];
                    if (loadedInteractionIds.has(interactionId)) {
                        lifecycleProjectionInteractionId = interactionId;
                        break;
                    }
                }
                if (retainedRevisionMatches
                    && !lifecycleProjectionInteractionId) {
                    if (this.outlineController.replace(
                        outline,
                        selectedInteractionId
                    )) {
                        await this.deliverPublication(this.createPublication(
                            requestId,
                            generation,
                            updateKind
                        ), replaceDocument);
                    }
                    return true;
                }
            }
            let page: ConversationPage;
            let selectedRefreshPage: ConversationPage | undefined;
            const snapshotCoversLifecycleProjection =
                !lifecycleProjectionInteractionId
                || snapshot?.page?.interactionStates.some(state =>
                    state.interactionId === lifecycleProjectionInteractionId
                ) === true;
            if (snapshot?.page && snapshotCoversLifecycleProjection) {
                page = snapshot.page;
            } else {
                // A content revision can advance in the same refresh that
                // completes a retained turn. Keep the selected snapshot page
                // as well as re-reading the changed turn: the former carries
                // unrelated content changes, while the latter restores final
                // assistant roles and worklog collapse state.
                selectedRefreshPage = snapshot?.page;
                try {
                    page = await this.options.readPage({
                        provider: target.provider,
                        sessionId: this.effectiveSessionId(target),
                        anchorInteractionId: lifecycleProjectionInteractionId
                            || selectedInteractionId,
                        direction: 'around',
                        expectedRevision: outline.sourceRevision,
                        limit: CONVERSATION_LIMITS.maxPageInteractions,
                    }, abortController.signal);
                } catch (error) {
                    if (!isStaleRevision(error)) {
                        throw error;
                    }
                    if (!this.canPublish(panel, target, generation, requestId)
                        || abortController.signal.aborted) {
                        return false;
                    }
                    outline = await this.options.readOutline(
                        target.provider,
                        this.effectiveSessionId(target),
                        abortController.signal
                    );
                    if (!this.canPublish(panel, target, generation, requestId)) {
                        return false;
                    }
                    if (outline.provider !== target.provider
                        || outline.sessionId !== this.effectiveSessionId(target)
                        || !outline.interactions.length) {
                        await this.publishFailure(replaceDocument, updateKind);
                        return false;
                    }
                    const retryInteractionIds = outline.interactions.map(
                        interaction => interaction.id
                    );
                    advanceToLatest = followLatest
                        && retryInteractionIds.includes(
                            latestIfSelection as string
                        );
                    if (updateKind === 'refresh'
                        && !advanceToLatest
                        && (!previousSelectedInteractionId
                            || !retryInteractionIds.includes(
                                previousSelectedInteractionId
                            ))) {
                        await this.publishFailure(replaceDocument, updateKind);
                        return false;
                    }
                    if (advanceToLatest) {
                        selectedInteractionId = outline.interactions[
                            outline.interactions.length - 1
                        ].id;
                    } else if (updateKind === 'refresh') {
                        selectedInteractionId = previousSelectedInteractionId as string;
                    }
                    if (!outline.interactions.some(
                        interaction => interaction.id === selectedInteractionId
                    )) {
                        await this.publishFailure(replaceDocument, updateKind);
                        return false;
                    }
                    if (lifecycleProjectionInteractionId
                        && !outline.interactions.some(interaction =>
                            interaction.id
                                === lifecycleProjectionInteractionId)) {
                        lifecycleProjectionInteractionId = undefined;
                    }
                    selectedRefreshPage = undefined;
                    page = await this.options.readPage({
                        provider: target.provider,
                        sessionId: this.effectiveSessionId(target),
                        anchorInteractionId: lifecycleProjectionInteractionId
                            || selectedInteractionId,
                        direction: 'around',
                        expectedRevision: outline.sourceRevision,
                        limit: CONVERSATION_LIMITS.maxPageInteractions,
                    }, abortController.signal);
                }
            }
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            if (page.provider !== target.provider
                || page.sessionId !== this.effectiveSessionId(target)
                || page.sourceRevision !== outline.sourceRevision) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (selectedRefreshPage
                && (selectedRefreshPage.provider !== target.provider
                    || selectedRefreshPage.sessionId
                        !== this.effectiveSessionId(target)
                    || selectedRefreshPage.sourceRevision
                        !== outline.sourceRevision)) {
                selectedRefreshPage = undefined;
            }
            if (!this.outlineController.replace(
                outline,
                lifecycleProjectionInteractionId
                    ? selectedInteractionId
                    : page.anchorInteractionId
            )) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            this.stale = false;
            if (updateKind === 'refresh') {
                if (selectedRefreshPage) {
                    this.mergeRefreshPage(selectedRefreshPage, outline);
                }
                this.mergeRefreshPage(page, outline);
            } else {
                this.retain(page, 'replace');
            }
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            const publication = this.createPublication(
                requestId,
                generation,
                updateKind
            );
            await this.deliverPublication(publication, replaceDocument);
            this.refreshSubagentsAfterPublication(
                panel,
                target,
                generation,
                subagentDiscoveryGeneration
            );
            void this.telemetryController.refresh(
                target,
                generation,
                this.effectiveSessionId(target)
            );
            return true;
        } catch (_error) {
            if (!this.canPublish(panel, target, generation, requestId)
                || abortController.signal.aborted) {
                return false;
            }
            await this.publishFailure(replaceDocument, updateKind);
            return false;
        } finally {
            if (this.abortController === abortController) {
                this.abortController = undefined;
            }
        }
    }

    private refreshSubagentsAfterPublication(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget,
        generation: number,
        discoveryGeneration: number
    ): void {
        if (this.panel !== panel
            || this.target !== target
            || this.suspended
            || this.subscriptionGeneration !== generation
            || this.subagentDiscoveryGeneration !== discoveryGeneration) {
            return;
        }
        void this.readSubagentsSafely(target).then(async subagents => {
            if (this.panel !== panel
                || this.target !== target
                || this.suspended
                || this.subscriptionGeneration !== generation
                || this.subagentDiscoveryGeneration !== discoveryGeneration
                || sameSubagents(this.subagents, subagents)) {
                return;
            }
            this.subagents = subagents.map(entry => ({ ...entry }));
            const requestId = this.allocateRequestId();
            this.currentRequestId = requestId;
            await this.deliverPublication(this.createPublication(
                requestId,
                generation,
                'refresh'
            ), false);
        }).catch(() => undefined);
    }

    private async read(
        request: ConversationPageRequest,
        placement: 'replace' | 'before' | 'after',
        replaceDocument: boolean,
        updateKind: ConversationViewerPageMessage['updateKind'],
        preferredInteractionId: string
    ): Promise<boolean> {
        const target = this.target;
        const panel = this.panel;
        if (!target || !panel || this.suspended) {
            return false;
        }
        this.abortController?.abort();
        const abortController = new ConversationAbortController();
        this.abortController = abortController;
        const generation = this.subscriptionGeneration;
        const subagentDiscoveryGeneration =
            ++this.subagentDiscoveryGeneration;
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        const previousOutline = this.outlineController.snapshot;
        try {
            let outline = previousOutline;
            let page: ConversationPage;
            let retriedStaleRevision = false;
            try {
                page = await this.options.readPage(request, abortController.signal);
            } catch (error) {
                if (!isStaleRevision(error)) {
                    throw error;
                }
                if (!this.canPublish(panel, target, generation, requestId)
                    || abortController.signal.aborted) {
                    return false;
                }
                outline = await this.options.readOutline(
                    target.provider,
                    this.effectiveSessionId(target),
                    abortController.signal
                );
                if (!this.canPublish(panel, target, generation, requestId)) {
                    return false;
                }
                if (outline.provider !== target.provider
                    || outline.sessionId !== this.effectiveSessionId(target)
                    || !outline.interactions.length) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
                if (!outline.interactions.some(
                    interaction => interaction.id === preferredInteractionId
                )) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
                retriedStaleRevision = true;
                page = await this.options.readPage({
                    provider: target.provider,
                    sessionId: this.effectiveSessionId(target),
                    anchorInteractionId: preferredInteractionId,
                    direction: 'around',
                    expectedRevision: outline.sourceRevision,
                    limit: CONVERSATION_LIMITS.maxPageInteractions,
                }, abortController.signal);
            }
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            if (page.provider !== target.provider
                || page.sessionId !== this.effectiveSessionId(target)
                || page.sourceRevision !== outline?.sourceRevision) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            this.stale = false;
            const selected = retriedStaleRevision && outline
                ? this.outlineController.replace(
                    outline,
                    page.anchorInteractionId
                )
                : this.outlineController.select(page.anchorInteractionId);
            if (!selected) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (retriedStaleRevision && outline) {
                this.mergeRefreshPage(page, outline);
            } else {
                this.retain(page, placement);
            }
            const publication = this.createPublication(
                requestId,
                generation,
                updateKind
            );
            await this.deliverPublication(publication, replaceDocument);
            this.refreshSubagentsAfterPublication(
                panel,
                target,
                generation,
                subagentDiscoveryGeneration
            );
            return true;
        } catch (_error) {
            if (!this.canPublish(panel, target, generation, requestId)
                || abortController.signal.aborted) {
                return false;
            }
            await this.publishFailure(replaceDocument, updateKind);
            return false;
        } finally {
            if (this.abortController === abortController) {
                this.abortController = undefined;
            }
        }
    }

    private async publishSelection(
        interactionId: string,
        updateKind: ConversationViewerPageMessage['updateKind']
    ): Promise<boolean> {
        const panel = this.panel;
        const target = this.target;
        if (!panel || !target
            || !this.outlineController.contains(interactionId)) {
            return false;
        }
        this.abortController?.abort();
        if (!this.outlineController.select(interactionId)) {
            return false;
        }
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        await this.deliverPublication(this.createPublication(
            requestId,
            this.subscriptionGeneration,
            updateKind
        ), false);
        return true;
    }

    private async publishFailure(
        replaceDocument: boolean,
        updateKind: ConversationViewerPageMessage['updateKind']
    ): Promise<void> {
        const panel = this.panel;
        if (!panel) {
            return;
        }
        if (this.pages.length) {
            this.stale = true;
            const publication = this.createPublication(
                this.currentRequestId,
                this.subscriptionGeneration,
                updateKind
            );
            await this.deliverPublication(publication, replaceDocument);
            return;
        }
        this.emitDiagnostic('publish-failure', { updateKind, replaceDocument });
        this.latestPublication = undefined;
        panel.webview.html = this.renderDocument(
            undefined,
            'Conversation history unavailable.'
        );
    }

    private async deliverPublication(
        publication: ConversationViewerPageMessage,
        replaceDocument: boolean
    ): Promise<void> {
        const panel = this.panel;
        if (!panel || !this.isCurrentPublication(publication)) {
            return;
        }
        this.latestPublication = publication;
        if (replaceDocument) {
            panel.webview.html = this.renderDocument(publication);
            return;
        }
        // Delta delivery: only when the Webview has acknowledged applying
        // exactly this content may the HTML string be omitted from the wire.
        // Until that ack arrives, every publication carries the full HTML, so
        // a lost or unapplied page is always retried in full.
        const sameAsApplied = publication.htmlSignature
            === this.appliedContentSignature;
        // A session switch whose content is on the Webview's own reported
        // frame list may restore the detached frame wholesale.
        const frameRestorable = !sameAsApplied
            && this.webviewFrames.get(
                conversationFrameTokenKey(publication.target)
            ) === publication.htmlSignature;
        const wire: ConversationViewerPageMessage = sameAsApplied
            ? { ...publication, html: undefined }
            : frameRestorable
                ? { ...publication, html: undefined, restoreFrame: true }
                : publication;
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(wire);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered && this.isCurrentPublication(publication)) {
            this.rebuildLatestDocument();
        }
    }

    private acknowledgePublication(
        message: ConversationViewerAppliedMessage
    ): void {
        if (message.subscriptionGeneration !== this.subscriptionGeneration) {
            return;
        }
        // The Webview is the authority on which frames it still holds:
        // replace the table with its latest report so evicted frames and
        // document rebuilds stop being offered restores immediately.
        this.webviewFrames.clear();
        (message.frames ?? []).forEach(frame => {
            this.webviewFrames.set(
                `${frame.projectId}\u0001${frame.provider}\u0001${frame.sessionId}`,
                frame.token
            );
        });
        const publication = this.latestPublication;
        if (!publication
            || message.requestId !== publication.requestId
            || message.htmlSignature !== publication.htmlSignature) {
            return;
        }
        this.appliedContentSignature = publication.htmlSignature;
    }

    private rebuildLatestDocument(): void {
        const panel = this.panel;
        const publication = this.latestPublication;
        if (!panel || !publication || !this.isCurrentPublication(publication)) {
            return;
        }
        panel.webview.html = this.renderDocument(publication);
    }

    private postLoadingNotice(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget,
        generation: number
    ): void {
        // A reused panel keeps the outgoing conversation visible while the
        // incoming session loads; the Webview dims it and announces the
        // load until the first publication of the new target lands. The
        // notice is cosmetic, so a lost post never blocks the load.
        try {
            void Promise.resolve(panel.webview.postMessage({
                type: 'conversation-viewer-loading',
                version: 1,
                subscriptionGeneration: generation,
                target: {
                    projectId: target.projectId,
                    provider: target.provider,
                    sessionId: target.sessionId,
                },
            })).catch(() => undefined);
        } catch (_error) {
            // See above: the indicator is best-effort only.
        }
    }

    private isCurrentPublication(
        publication: ConversationViewerPageMessage
    ): boolean {
        return publication.subscriptionGeneration === this.subscriptionGeneration
            && publication.requestId === this.currentRequestId;
    }

    private canPublish(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget,
        generation: number,
        requestId: number
    ): boolean {
        return this.panel === panel
            && this.target === target
            && !this.suspended
            && this.subscriptionGeneration === generation
            && this.currentRequestId === requestId;
    }

    private allocateRequestId(): number {
        const requestId = this.nextRequestId;
        this.nextRequestId = requestId === Number.MAX_SAFE_INTEGER
            ? CONVERSATION_LIMITS.minRequestId
            : requestId + 1;
        return requestId;
    }

    private ensureWatch(
        generation: number,
        isolateFailure = false
    ): boolean {
        const target = this.target;
        if (!target || this.watch || (this.suspended && !isolateFailure)) {
            return false;
        }
        try {
            const watch = this.options.watch(
                target.provider,
                this.effectiveSessionId(target),
                () => {
                    if (generation !== this.subscriptionGeneration
                        || this.suspended) {
                        return;
                    }
                    void this.refresh();
                }
            );
            if (this.target !== target
                || generation !== this.subscriptionGeneration) {
                watch.dispose();
                return false;
            }
            this.watch = watch;
            return true;
        } catch (error) {
            if (!isolateFailure) {
                throw error;
            }
            return false;
        }
    }

    private retain(
        page: ConversationPage,
        placement: 'replace' | 'before' | 'after'
    ): void {
        // Incoming pages carry authoritative content for their interactions;
        // drop any stale renders before they can be served from the cache.
        page.interactionStates.forEach(state =>
            this.renderCache.invalidateInteraction(
                page.sessionId,
                state.interactionId
            )
        );
        const retained = { page };
        if (placement === 'replace') {
            this.pages = [retained];
        } else if (placement === 'before') {
            this.pages.unshift(retained);
        } else {
            this.pages.push(retained);
        }
        this.evict();
    }

    private mergeRefreshPage(
        page: ConversationPage,
        outline: ConversationOutline
    ): void {
        const outlineIds = new Set(
            outline.interactions.map(interaction => interaction.id)
        );
        const loadedIds = new Set<string>();
        const messagesByInteraction = new Map<string, ConversationMessage[]>();
        const statesByInteraction = new Map<
            string,
            ConversationPage['interactionStates'][number]
        >();
        this.pages.forEach(retained => {
            retained.page.interactionStates.forEach(state => {
                if (outlineIds.has(state.interactionId)) {
                    loadedIds.add(state.interactionId);
                    if (!statesByInteraction.has(state.interactionId)) {
                        statesByInteraction.set(state.interactionId, {
                            ...state,
                        });
                    }
                }
            });
            retained.page.messages.forEach(message => {
                if (!outlineIds.has(message.interactionId)) {
                    return;
                }
                const messages = messagesByInteraction.get(message.interactionId)
                    || [];
                messages.push(copyMessage(message));
                messagesByInteraction.set(message.interactionId, messages);
            });
        });
        const refreshedIds = new Set<string>();
        page.interactionStates.forEach(state => {
            if (!outlineIds.has(state.interactionId)) {
                return;
            }
            loadedIds.add(state.interactionId);
            refreshedIds.add(state.interactionId);
            this.renderCache.invalidateInteraction(
                page.sessionId,
                state.interactionId
            );
            messagesByInteraction.set(state.interactionId, []);
            const previous = statesByInteraction.get(state.interactionId);
            statesByInteraction.set(state.interactionId, {
                ...previous,
                ...state,
            });
        });
        page.messages.forEach(message => {
            if (!refreshedIds.has(message.interactionId)) {
                return;
            }
            const messages = messagesByInteraction.get(message.interactionId)
                || [];
            messages.push(copyMessage(message));
            messagesByInteraction.set(message.interactionId, messages);
        });
        this.pages = outline.interactions.reduce(
            (retainedPages: RetainedConversationPage[], interaction, index) => {
                if (!loadedIds.has(interaction.id)) {
                    return retainedPages;
                }
                const retainedState = statesByInteraction.get(interaction.id);
                retainedPages.push({
                    page: {
                        provider: outline.provider,
                        sessionId: outline.sessionId,
                        sourceRevision: outline.sourceRevision,
                        anchorInteractionId: interaction.id,
                        messages: messagesByInteraction.get(interaction.id) || [],
                        interactionStates: [{
                            interactionId: interaction.id,
                            responseState: interaction.responseState,
                            ...(retainedState?.timestamp !== undefined
                                ? { timestamp: retainedState.timestamp }
                                : {}),
                            ...(retainedState?.completedAt !== undefined
                                ? { completedAt: retainedState.completedAt }
                                : {}),
                        }],
                        isStart: index === 0,
                        isEnd: index === outline.interactions.length - 1,
                    },
                });
                return retainedPages;
            },
            []
        );
        this.evict();
    }

    private evict(): void {
        // Measure once per eviction run instead of once per loop iteration:
        // snapshotBytes() serializes every retained page, which multiplied a
        // 4 MiB stringify by the number of removed pages.
        let interactionCount = this.snapshotSize;
        let byteCount = this.snapshotBytes();
        while (this.pages.length > 1
            && (interactionCount > CONVERSATION_LIMITS.maxViewerInteractions
                || byteCount > CONVERSATION_LIMITS.maxViewerBytes)) {
            const targetId = this.outlineController.selection;
            const anchorPage = this.pages.findIndex(retained =>
                retained.page.interactionStates.some(
                    state => state.interactionId === targetId
                ));
            let victim: RetainedConversationPage | undefined;
            if (anchorPage < 0) {
                victim = this.pages.pop();
            } else {
                const distanceBefore = anchorPage;
                const distanceAfter = this.pages.length - 1 - anchorPage;
                if (distanceAfter >= distanceBefore && anchorPage
                    !== this.pages.length - 1) {
                    victim = this.pages.pop();
                } else if (anchorPage !== 0) {
                    victim = this.pages.shift();
                } else {
                    break;
                }
            }
            if (victim) {
                // Retained pages never share interactions (mergeRefreshPage
                // rebuilds one page per interaction and paged retains load
                // disjoint ranges), so subtracting the victim's own counts
                // keeps both running totals sound. The byte total is a
                // conservative overestimate (the per-victim serialization
                // omits the array separators), so eviction may release one
                // page early, never late.
                interactionCount -= new Set(
                    victim.page.interactionStates.map(
                        state => state.interactionId
                    )
                ).size;
                byteCount -= Buffer.byteLength(
                    JSON.stringify(victim.page),
                    'utf8'
                );
            }
        }
    }

    private snapshotBytes(): number {
        return Buffer.byteLength(JSON.stringify(
            this.pages.map(retained => retained.page)
        ), 'utf8');
    }

    private interactionIds(): string[] {
        const seen = new Set<string>();
        const interactionIds: string[] = [];
        this.pages.forEach(retained => {
            retained.page.interactionStates.forEach(state => {
                if (seen.has(state.interactionId)) {
                    return;
                }
                seen.add(state.interactionId);
                interactionIds.push(state.interactionId);
            });
        });
        return interactionIds;
    }

    private messages(): ConversationMessage[] {
        const seen = new Set<string>();
        const messages: ConversationMessage[] = [];
        this.pages.forEach(retained => {
            retained.page.messages.forEach(message => {
                if (seen.has(message.id)) {
                    return;
                }
                seen.add(message.id);
                messages.push(message);
            });
        });
        return messages;
    }

    private createPublication(
        requestId: number,
        generation: number,
        updateKind: ConversationViewerPageMessage['updateKind']
    ): ConversationViewerPageMessage {
        const target = this.target;
        const outline = this.outlineController.snapshot;
        if (!target || !outline) {
            throw new Error('Conversation viewer target unavailable.');
        }
        const projection = this.outlineController.createPublication();
        const interactionIds = outline.interactions.map(
            interaction => interaction.id
        );
        const interactionInfo = new Map<string, {
            responseState: ConversationResponseState;
            timestamp?: number;
            completedAt?: number;
        }>();
        this.pages.forEach(retained => {
            retained.page.interactionStates.forEach(state => {
                if (!interactionInfo.has(state.interactionId)) {
                    interactionInfo.set(state.interactionId, state);
                }
            });
        });
        const selectedIndex = interactionIds.indexOf(
            projection.selectedInteractionId
        );
        const first = this.pages[0]?.page;
        const last = this.pages[this.pages.length - 1]?.page;
        const rendered = renderMessages(
            this.messages(),
            this.showThinking(),
            interactionInfo,
            this.renderCache,
            this.contentSignatures,
            this.effectiveSessionId(target)
        );
        return {
            type: 'conversation-viewer-page',
            version: 1,
            requestId,
            subscriptionGeneration: generation,
            updateKind,
            html: rendered.html,
            htmlSignature: rendered.contentSignature,
            ...projection,
            previousCursor: selectedIndex > 0
                ? first?.previousCursor || ''
                : undefined,
            nextCursor: selectedIndex >= 0
                && selectedIndex < interactionIds.length - 1
                ? last?.nextCursor || ''
                : undefined,
            stale: this.stale,
            displayName: visibleConversationDisplayName(target),
            subagents: this.subagents.map(entry => ({ ...entry })),
            activeSubagent: target.subagent ? { ...target.subagent } : null,
            target: {
                projectId: target.projectId,
                provider: target.provider,
                sessionId: target.sessionId,
                interactionId: target.interactionId,
                displayName: target.displayName,
                duplicateDisplayName: target.duplicateDisplayName,
                workspaceName: target.workspaceName,
                ...(target.taskName ? { taskName: target.taskName } : {}),
            },
            comments: this.commentController.snapshot,
            projectComments: this.projectCommentController.snapshot,
            bookmarks: this.bookmarkController.snapshot,
        };
    }

    private renderDocument(
        initialPage?: ConversationViewerPageMessage,
        initialStatus = ''
    ): string {
        const panel = this.panel;
        const target = this.target;
        if (!panel || !target) {
            return '';
        }
        return renderConversationViewerDocument({
            panel,
            target,
            mediaUri: this.options.mediaUri,
            commentSnapshot: this.commentController.snapshot,
            projectCommentSnapshot: this.projectCommentController.snapshot,
            bookmarkSnapshot: this.bookmarkController.snapshot,
            telemetrySnapshot: this.telemetryController.snapshot,
            sessionStatusSnapshot: this.sessionStatusController.snapshot,
            sessionStatusRequestId: this.currentRequestId,
            subscriptionGeneration: this.subscriptionGeneration,
            initialPage,
            initialStatus,
        });
    }

    private showThinking(): boolean {
        try {
            return this.options.showThinking?.() === true;
        } catch (_error) {
            return false;
        }
    }
}

function sameSubagents(
    left: readonly ConversationSubagentEntry[],
    right: readonly ConversationSubagentEntry[]
): boolean {
    return left.length === right.length && left.every((entry, index) => {
        const candidate = right[index];
        return Boolean(candidate)
            && entry.id === candidate.id
            && entry.label === candidate.label
            && entry.agentType === candidate.agentType
            && entry.status === candidate.status
            && entry.createdAt === candidate.createdAt
            && entry.updatedAt === candidate.updatedAt;
    });
}

function cloneViewerTarget(
    target: ConversationViewerTarget
): ConversationViewerTarget {
    return {
        ...target,
        ...(target.subagent
            ? { subagent: { ...target.subagent } }
            : {}),
    };
}

function boundedConversationDisplayName(value: string): string {
    const graphemeBounded = truncateGraphemes(String(value || '').trim(), 200)
        || 'Conversation';
    if (graphemeBounded.length <= 600) {
        return graphemeBounded;
    }
    let bounded = '';
    for (const codePoint of Array.from(graphemeBounded)) {
        if (bounded.length + codePoint.length > 599) {
            break;
        }
        bounded += codePoint;
    }
    return `${bounded}…`;
}

function visibleConversationDisplayName(
    target: ConversationViewerTarget
): string {
    return target.displayName + (target.duplicateDisplayName
        ? ` · ${target.sessionId.slice(0, 8)}`
        : '');
}

function isStaleRevision(error: unknown): error is ConversationError {
    return error instanceof ConversationError && error.code === 'staleRevision';
}

function copyMessage(message: ConversationMessage): ConversationMessage {
    return copyConversationMessage(message);
}

function renderConversationDiffFile(
    diff: ConversationFileDiff
): string {
    const kind = diff.kind
        ? `<span class="conversation-diff-kind conversation-diff-kind-${escapeAttribute(diff.kind)}">${escapeAttribute(diff.kind)}</span>`
        : '';
    const hunks = diff.hunks.map(hunk => {
        const header = hunk.oldStart !== undefined
            && hunk.newStart !== undefined
            ? `<span class="conversation-diff-line conversation-diff-line-hunk">@@ -${hunk.oldStart} +${hunk.newStart} @@</span>`
            : '';
        // Block-level spans stack on their own; newline text nodes inside
        // the <pre> would render as extra blank lines.
        const lines = hunk.lines.map(line =>
            `<span class="conversation-diff-line conversation-diff-line-${line.type}">${line.type === 'add'
                ? '+'
                : line.type === 'del'
                    ? '-'
                    : ' '}${escapeAttribute(line.text)}</span>`
        ).join('');
        const truncated = hunk.truncatedLines
            ? `<span class="conversation-diff-line conversation-diff-line-truncated">… ${hunk.truncatedLines} more lines</span>`
            : '';
        return `${header}${lines}${truncated}`;
    }).join('');
    return `<section class="conversation-diff-file">
        <section class="conversation-diff-file-header"><span class="conversation-diff-path" title="${escapeAttribute(diff.path)}">${escapeAttribute(diff.path)}</span>${kind}<span class="conversation-diff-counts"><span class="conversation-diff-count-add">+${diff.additions}</span> <span class="conversation-diff-count-del">−${diff.deletions}</span></span></section>
        ${hunks
            ? `<pre class="conversation-diff-hunks"><code>${hunks}</code></pre>`
            : ''}
    </section>`;
}

function renderConversationDiffs(diffs: ConversationFileDiff[]): string {
    return `<section class="conversation-diff">${diffs.map(
        renderConversationDiffFile
    ).join('')}</section>`;
}

function renderToolMessage(message: ConversationMessage): string {
    const tool = message.tool;
    const summary = tool ? escapeAttribute(tool.summary) : '';
    const name = tool ? escapeAttribute(tool.name) : '';
    const diffs = tool?.diffs;
    const totals = diffs?.length
        ? diffs.reduce(
            (acc, diff) => ({
                additions: acc.additions + diff.additions,
                deletions: acc.deletions + diff.deletions,
            }),
            { additions: 0, deletions: 0 }
        )
        : undefined;
    const totalsBadge = totals && (totals.additions || totals.deletions)
        ? ` <span class="conversation-diff-totals"><span class="conversation-diff-count-add">+${totals.additions}</span> <span class="conversation-diff-count-del">−${totals.deletions}</span></span>`
        : '';
    const diffsHtml = diffs?.length
        ? renderConversationDiffs(diffs)
        : '';
    const detailHtml = tool?.detail
        ? `<pre class="conversation-tool-detail"><code>${escapeAttribute(tool.detail)}</code></pre>`
        : '';
    const body = tool && (tool.detail || diffsHtml)
        ? `<details class="conversation-tool-call"><summary><span class="conversation-tool-name">${name}</span> ${summary}${totalsBadge}</summary>
${diffsHtml}${detailHtml}</details>`
        : `<div class="conversation-tool-call conversation-tool-call-static"><span class="conversation-tool-name">${name}</span> ${summary}${totalsBadge}</div>`;
    return `<article class="conversation-message conversation-message-tool"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    ${body}
</article>`;
}

function renderThinkingMessage(message: ConversationMessage): string {
    const text = message.thinking?.text || '';
    return `<article class="conversation-message conversation-message-thinking"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <details class="conversation-thinking"><summary>Thinking</summary>
<pre class="conversation-thinking-body">${escapeAttribute(text)}</pre></details>
</article>`;
}

function renderProgressMessage(message: ConversationMessage): string {
    return `<article class="conversation-message conversation-message-progress"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <section class="conversation-progress">
        <span class="conversation-progress-label">Progress:</span>
        <span class="conversation-progress-dot"></span>
        <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
    </section>
</article>`;
}

function renderPlanMessage(message: ConversationMessage): string {
    const plan = message.plan;
    const filePath = plan?.filePath
        ? `<span class="conversation-plan-path" title="${escapeAttribute(plan.filePath)}">${escapeAttribute(plan.filePath)}</span>`
        : '';
    return `<article class="conversation-message conversation-message-plan"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <section class="conversation-plan">
        <section class="conversation-plan-header"><span class="conversation-plan-label">Plan</span>${filePath}</section>
        <section class="conversation-markdown">${renderConversationMarkdown(
        plan?.markdown || ''
    )}</section>
    </section>
</article>`;
}

const QUESTION_OUTCOME_LABELS: Record<string, string> = {
    approved: 'Approved',
    revised: 'Revision requested',
    rejected: 'Rejected',
    answered: 'Answered',
    dismissed: 'Dismissed',
    pending: 'Pending',
};

function questionSourceLabel(source: string): string {
    if (source === 'ExitPlanMode') {
        return 'Plan approval';
    }
    if (source === 'AskUserQuestion') {
        return 'Question';
    }
    return source || 'Question';
}

function renderQuestionOption(
    option: { label: string; description?: string },
    selected: boolean
): string {
    const description = option.description
        ? `<span class="conversation-question-option-description">${escapeAttribute(option.description)}</span>`
        : '';
    return `<li class="conversation-question-option${selected
        ? ' conversation-question-option-selected'
        : ''}"><span class="conversation-question-option-check">${selected
        ? '\u2713'
        : ''}</span><span class="conversation-question-option-label">${escapeAttribute(option.label)}</span>${description}</li>`;
}

function renderQuestionItem(
    item: Omit<ConversationQuestionItem, 'answers'>
        & { answers?: string[] }
): string {
    const answers = item.answers || [];
    const header = item.header
        ? `<span class="conversation-question-header">${escapeAttribute(item.header)}</span>`
        : '';
    const options = item.options.length
        ? `<ul class="conversation-question-options">${item.options
            .map(option => renderQuestionOption(
                option,
                answers.includes(option.label)
            ))
            .join('')}</ul>`
        : '';
    const freeAnswers = answers.filter(answer =>
        !item.options.some(option => option.label === answer));
    const freeText = freeAnswers.length
        ? `<section class="conversation-question-free-answer">${item.otherLabel
            ? `${escapeAttribute(item.otherLabel)}: `
            : 'Answer: '}${escapeAttribute(freeAnswers.join(', '))}</section>`
        : '';
    const otherPrompt = !freeAnswers.length && item.otherLabel
        ? `<section class="conversation-question-other-hint">${escapeAttribute(item.otherLabel)} option was available</section>`
        : '';
    return `<section class="conversation-question-item">
        <section class="conversation-question-title">${header}<span class="conversation-question-text">${escapeAttribute(item.question)}</span>${item.multiSelect
            ? '<span class="conversation-question-multi">multi-select</span>'
            : ''}</section>
        ${options}${freeText}${otherPrompt}
    </section>`;
}

function renderQuestionMessage(message: ConversationMessage): string {
    const question = message.question;
    if (!question) {
        return '';
    }
    const outcome = question.outcome
        ? `<span class="conversation-question-outcome conversation-question-outcome-${escapeAttribute(question.outcome)}">${escapeAttribute(
            QUESTION_OUTCOME_LABELS[question.outcome] || question.outcome
        )}</span>`
        : '';
    const items = question.questions
        .map(item => renderQuestionItem(item))
        .join('');
    return `<article class="conversation-message conversation-message-question"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <section class="conversation-question">
        <section class="conversation-question-top"><span class="conversation-question-source">${escapeAttribute(questionSourceLabel(question.source))}</span>${outcome}</section>
        ${items}
    </section>
</article>`;
}

interface ConversationInteractionRenderInfo {
    responseState: ConversationResponseState;
    timestamp?: number;
    completedAt?: number;
}

function isWorklogEntry(
    message: ConversationMessage,
    showThinking: boolean
): boolean {
    return message.role === 'tool'
        || message.role === 'progress'
        || (message.role === 'thinking' && showThinking);
}

function worklogDurationMs(
    info: ConversationInteractionRenderInfo
): number | undefined {
    if (info.timestamp === undefined || info.completedAt === undefined) {
        return undefined;
    }
    const duration = info.completedAt - info.timestamp;
    return Number.isFinite(duration) && duration >= 1000
        ? duration
        : undefined;
}

function renderWorklogRow(
    interactionId: string,
    durationMs?: number
): string {
    const label = durationMs !== undefined
        ? `Worked for ${formatWorkedDuration(durationMs)}`
        : 'Worked';
    const id = `${interactionId}:worklog`;
    return `<article class="conversation-message conversation-message-worklog"
    data-message-id="${escapeAttribute(id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(id))}"
    data-interaction-id="${escapeAttribute(interactionId)}">
    <button class="conversation-worklog-toggle"><span class="conversation-worklog-label">${escapeAttribute(label)}</span></button>
</article>`;
}

function renderMessage(
    message: ConversationMessage,
    showThinking: boolean,
    clock?: ConversationClockTime
): string {
    if (message.role === 'tool') {
        return renderToolMessage(message);
    }
    if (message.role === 'thinking') {
        return showThinking ? renderThinkingMessage(message) : '';
    }
    if (message.role === 'progress') {
        return renderProgressMessage(message);
    }
    if (message.role === 'plan') {
        return renderPlanMessage(message);
    }
    if (message.role === 'question') {
        return renderQuestionMessage(message);
    }
    if (message.role === 'user') {
        const inputClock = clock
            ? `<span class="conversation-message-time" title="${escapeAttribute(clock.title)}">${escapeAttribute(clock.label)}</span>`
            : '';
        return `<article class="conversation-message conversation-message-user"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <span class="conversation-role">User</span>
    <button class="conversation-message-bookmark" title="Bookmark this input"></button>
    <section class="conversation-message-corner">${inputClock}<button class="conversation-message-copy" title="Copy input"></button></section>
    <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
</article>`;
    }
    const clockHtml = clock
        ? `<span class="conversation-message-time" title="${escapeAttribute(clock.title)}">${escapeAttribute(clock.label)}</span>`
        : '';
    return `<article class="conversation-message conversation-message-${message.role}"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <span class="conversation-role">Assistant</span>
    <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
    <section class="conversation-message-actions"><button class="conversation-message-copy" title="Copy response"></button>${clockHtml}</section>
</article>`;
}

interface RenderedConversationMessages {
    html: string;
    contentSignature: string;
}

function renderMessages(
    messages: ConversationMessage[],
    showThinking: boolean,
    interactionInfo: Map<string, ConversationInteractionRenderInfo>,
    renderCache: ConversationMessageRenderCache,
    contentSignatures: ConversationContentSignatureRegistry,
    sessionId: string
): RenderedConversationMessages {
    const groups: ConversationMessage[][] = [];
    messages.forEach(message => {
        const last = groups[groups.length - 1];
        if (last && last[0].interactionId === message.interactionId) {
            last.push(message);
        } else {
            groups.push([message]);
        }
    });
    const contentStream = new ConversationContentStream();
    const html = groups.map(group => {
        const info = interactionInfo.get(group[0].interactionId);
        const now = Date.now();
        const inputClock = info
            ? formatConversationClockTime(info.timestamp, now)
            : undefined;
        const answerClock = info
            ? formatConversationClockTime(
                info.completedAt ?? info.timestamp,
                now
            )
            : undefined;
        const rendered = group.map(message => {
            const clock = message.role === 'user'
                ? inputClock
                : message.role === 'assistant'
                    ? answerClock
                    : undefined;
            const messageSignature = createMessageRenderSignature({
                sessionId,
                showThinking,
                responseState: info?.responseState,
                clock,
            });
            const entry = renderCache.render(
                `${sessionId}\u0001${message.id}`,
                messageSignature,
                () => renderMessage(message, showThinking, clock)
            );
            contentStream.mixMessage(
                message,
                messageSignature,
                entry.version
            );
            return entry.html;
        });
        const answerIndex = group.findIndex(
            message => message.role === 'assistant'
        );
        const firstWorkIndex = group.findIndex(
            message => isWorklogEntry(message, showThinking)
        );
        if (info
            && info.responseState !== 'inProgress'
            && answerIndex >= 0
            && firstWorkIndex >= 0) {
            // The row heads the work group (accordion-style) so expanding
            // reveals entries below the toggle instead of pushing it down.
            const durationMs = worklogDurationMs(info);
            contentStream
                .mix(`${group[0].interactionId}:worklog`)
                .mix(String(durationMs ?? ''));
            rendered.splice(firstWorkIndex, 0, renderWorklogRow(
                group[0].interactionId,
                durationMs
            ));
        }
        return rendered.join('');
    }).join('');
    return {
        html,
        contentSignature: contentSignatures.tokenFor(
            contentStream.toString()
        ),
    };
}
