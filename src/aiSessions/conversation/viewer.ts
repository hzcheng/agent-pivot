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
    parseConversationWorkspaceFileLink,
    renderConversationMarkdown,
    ConversationWorkspaceFileTarget,
} from './markdown';
import { renderConversationDiffs } from './diffRenderer';
import { parseConversationViewerMessage } from './viewerProtocol';
import type {
    ConversationSessionSwitchDirection,
    ConversationViewerAppliedMessage,
    ConversationViewerCopyMessage,
    ConversationViewerHistoryChunkAppliedMessage,
    ConversationViewerLoadEarlierMessage,
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
    /** Invalidates an older dashboard navigation before the Viewer begins a
     * user-requested session change of its own. */
    onNavigationIntent?: () => void;
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
        target: ConversationLocalFileTarget | ConversationWorkspaceFileTarget,
        viewerTarget: ConversationViewerTarget
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
    /** Receives aggregate publication/application timing only. */
    onTiming?: (timing: ConversationViewerApplicationTiming) => void;
    now?: () => number;
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
    /**
     * Shows a cached conversation frame while the Host resolves the target's
     * authoritative snapshot. The returned handle is cancelled when that
     * speculative intent cannot become the active target.
     */
    previewSession?(
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ): AiSessionDisposable | undefined;
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
    /** Wire-only: when set, `html` is omitted and the Webview replaces just
     * this trailing interaction group with `tailHtml`. */
    tailInteractionId?: string;
    tailHtml?: string;
    restoreFrame?: boolean;
    /** Return keyboard focus to the selected interaction after a document recovery. */
    restoreFocus?: boolean;
    outline: ConversationViewerOutlineEntry[];
    selectedInteractionId: string;
    selectedInput: number;
    totalInputs: number;
    partial: boolean;
    atLatest: boolean;
    selectedOutsideOutline?: boolean;
    previousCursor?: string;
    /** Cursor for on-demand retained-window history loading. This is kept
     * separate from `previousCursor`, which also drives ordinary selection
     * navigation inside an already complete page. */
    earlierPageCursor?: string;
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

/**
 * Wire-only tail patch: when a refresh changes only the trailing
 * interaction group (the dominant streaming case), the Host omits the full
 * HTML and sends the re-rendered trailing group instead. The Webview
 * replaces that group in place and confirms with the page's full content
 * signature, so acknowledgement, watchdog, and recovery semantics are
 * identical to a full delivery.
 */
interface ConversationTailSplit {
    prefixSignature: string;
    tailInteractionId: string;
    tailHtml: string;
}

/**
 * One slice of older history prepended above a progressively rendered
 * partial page. Slices arrive nearest-first; `complete` marks the oldest
 * slice, after which the visible document equals the full content whose
 * cumulative signature is `htmlSignature`.
 */
export interface ConversationViewerHistoryChunkMessage {
    type: 'conversation-viewer-history-chunk';
    version: 1;
    subscriptionGeneration: number;
    requestId: number;
    html: string;
    htmlSignature: string;
    complete: boolean;
}

interface ConversationProgressiveBackfill {
    generation: number;
    /** Request id of the partial publication this backfill extends. A newer
     * publication or in-flight load moves `currentRequestId` past it, which
     * invalidates the plan: a stale slice receipt must never allocate
     * request ids or publish over the newer work. */
    anchorRequestId: number;
    /** Oldest deferred-message boundary not yet sent. The next chunk is
     * sized lazily after the prior receipt, so opening a huge page never
     * renders all future chunks before its first backfill post. */
    nextDeferredEnd: number;
    messages: ConversationMessage[];
    interactionInfo: Map<string, ConversationInteractionRenderInfo>;
    sessionId: string;
    pending?: {
        requestId: number;
        htmlSignature: string;
    };
    timerToken: number;
    timer?: unknown;
}

/**
 * Aggregate timing for one authoritative Conversation publication. It never
 * carries a workspace, provider, session, or other user content.
 */
export interface ConversationViewerApplicationTiming {
    /** Aggregate-only classification; it is not a cross-system trace id. */
    source: 'open' | 'follow' | 'restore' | 'rebind'
        | 'initial' | 'navigation' | 'refresh';
    updateKind: ConversationViewerPageMessage['updateKind'];
    delivery: 'document' | 'message';
    /** Host publication to the Webview's correlated applied acknowledgement. */
    applicationMs: number;
    /** User target load to the first correlated Webview application. */
    loadMs?: number;
    /** Bytes of HTML carried by the actual Host-to-Webview delivery (zero for a frame/delta reuse). */
    contentBytes: number;
    /** Whether the first visible page deferred older history for backfill. */
    progressive: boolean;
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
    // A root-session intent can be known before its outline/snapshot has
    // resolved. Keep its cosmetic preview separate from the authoritative
    // target/generation so a slow provider read never delays a cache hit.
    private preflightPreview?: {
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>;
        subscriptionGeneration: number;
    };
    // The target can change before its first authoritative document is
    // applied. This is set only for a reused panel, where an outgoing
    // Webview document could still have queued an action.
    private transitioningGeneration?: number;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private currentRequestId = 0;
    private stale = false;
    private latestPublication?: ConversationViewerPageMessage;
    // The tail split of latestPublication's render: lets a refresh that
    // only changed the trailing interaction group send just that group.
    private latestTailSplit?: ConversationTailSplit;
    // The running Webview document advertises tail-patch support through a
    // dedicated capabilities message posted at script startup. Documents
    // rendered by older scripts never post it, so they keep receiving
    // full-HTML refreshes. The flag is scoped to the document: it survives
    // in-place target switches but resets on every document replacement,
    // whose fresh script re-posts its capabilities before any receipt.
    private webviewTailPatchCapable = false;
    // Preflight is a reversible, Host-to-Webview cosmetic protocol. Unlike a
    // normal loading notice it must never reach an older retained document,
    // which would not understand the cancellation message.
    private webviewFramePreflightCapable = false;
    // Monotonic identity of the document most recently rendered for this
    // panel; the capabilities handshake echoes it back, so only the running
    // document's advertisement arms delta deliveries.
    private currentDocumentId = '0';
    private documentSerial = 0;
    // Set by createPublication and consumed synchronously by
    // deliverPublication; never valid across an await boundary.
    private lastPublicationTailSplit?: ConversationTailSplit;
    // A large, latest-at-tail page first sends its recent messages. Once the
    // Webview has applied that lightweight page, it receives the complete
    // retained window through the normal, correlated publication channel.
    // Keeping this state on the publication (rather than an unbound timer)
    // makes a target change or user navigation naturally cancel the follow-up.
    private progressivePublication?: ConversationViewerPageMessage;
    // A revalidation deferred while a progressive backfill holds the
    // incomplete-content obligation; run once the full-content receipt
    // closes it. Cleared on every target switch.
    private pendingRevalidationInteractionId?: string;
    // A page-boundary continuation currently prepending one older page on
    // demand (the user scrolled the transcript to its top while earlier
    // history sits behind the oldest retained page's cursor).
    private earlierPageBackfill?: {
        token: number;
        request: ConversationViewerLoadEarlierMessage;
        target: ConversationViewerTarget;
        /** A stale before-page retry had to refresh around the selection. */
        staleFallback?: boolean;
        abortController?: ConversationAbortController;
        timer?: unknown;
    };
    private nextEarlierPageBackfillToken = 0;
    // The oldest interaction of a page-boundary walk that made no progress
    // (its prepended page was evicted by the retention budget). Blocks
    // further automatic retries for that boundary so an ack-triggered
    // restart cannot loop forever. Cleared on every target switch.
    private earlierBackfillStuckAnchor?: string;
    // A partial page remains incomplete until a different full-content page
    // applies. Auxiliary and subagent publications may supersede either
    // phase, so this is bound to the generation instead of one request id.
    private progressiveContentIncomplete?: {
        generation: number;
        partialHtmlSignature: string;
        /** The exact atomic boundary used for this rendered first paint. */
        deferredMessageCount: number;
    };
    // The source-size plan is deliberately only a cheap initial heuristic.
    // Markdown rendering (especially syntax highlighting) can expand a small
    // source window into much larger HTML. Keep the refined boundary next to
    // the publication so its ack-paced backfill resumes from exactly what the
    // Webview saw, without exposing an implementation detail on the wire.
    private readonly progressiveDeferredMessageCounts = new WeakMap<
        ConversationViewerPageMessage,
        number
    >();
    // Older history for a progressive page is backfilled in ack-paced
    // slices instead of one full-document refresh, so the Webview never
    // renders the whole history in a single task. Any superseding page
    // publication cancels the plan; a lost slice falls back to the normal
    // full-content refresh.
    private progressiveBackfill?: ConversationProgressiveBackfill;
    // Every path that yields the backfill assumes a superseding load will
    // publish the full document instead. A load can also be aborted, or
    // resolve to "nothing changed", and publish nothing at all — which would
    // leave the reader's deferred-history placeholder with no delivery and no
    // timer left to retire it. This watchdog belongs to the open
    // incomplete-content obligation itself, so a yielded backfill always
    // converges on one full-content refresh.
    private progressiveObligationTimer?: unknown;
    private progressiveObligationTimerToken = 0;
    private pendingPublicationTiming?: {
        subscriptionGeneration: number;
        requestId: number;
        htmlSignature: string;
        updateKind: ConversationViewerPageMessage['updateKind'];
        delivery: 'document' | 'message';
        publishedAt: number;
        contentBytes: number;
        progressive: boolean;
    };
    private pendingTargetLoadTiming?: {
        subscriptionGeneration: number;
        startedAt: number;
        source: 'open' | 'follow' | 'restore' | 'rebind';
    };
    // Auxiliary state restores after the content-first load and is published
    // only once its exact document has been acknowledged by the Webview.
    private pendingRestoredAuxiliaryState?: {
        target: ConversationViewerTarget;
        generation: number;
    };
    private publicationAckTimer?: unknown;
    private publicationAckTimerToken = 0;
    private publicationRecoveryRebuildRequestId = 0;
    private publicationRecoveryAttemptRequestId = 0;
    // Advanced only by the Webview's correlated applied acknowledgement —
    // never by postMessage resolving, which proves queueing, not application.
    private appliedContentSignature?: string;
    // The Webview's own report of which session frames it currently holds,
    // refreshed by every applied acknowledgement. Frame restores are
    // offered only for entries on this authoritative list — an applied ack
    // alone never implies the frame is still cached.
    private readonly webviewFrames = new Map<string, string>();
    // A document rebuild restarts the Webview's per-document resync guard.
    // Keep the Host recovery allowance until a publication applies so a
    // streaming provider cannot turn one persistent failure into a rebuild
    // for every fresh publication in the same subscription generation.
    private publicationRecoveryGeneration?: number;
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
            onDidPublish: (target, telemetry) => {
                void this.changesController?.onTelemetryRefreshed(
                    target,
                    telemetry?.worktree?.worktreeRoot
                );
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

    previewSession(
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ): AiSessionDisposable | undefined {
        const panel = this.panel;
        const current = this.target;
        if (!panel || !current) {
            return undefined;
        }
        if (hasSameConversationSessionTarget(current, target)) {
            // A quick reversal is itself a newer intent. Restore the
            // authoritative current document now rather than leaving the
            // prior target's preview on screen until this root re-resolves.
            if (this.preflightPreview) {
                this.cancelPreflightPreview(this.preflightPreview);
            }
            return undefined;
        }
        if (this.suspended || !this.webviewFramePreflightCapable) {
            return undefined;
        }
        const preview = {
            target: {
                projectId: target.projectId,
                provider: target.provider,
                sessionId: target.sessionId,
            },
            subscriptionGeneration: this.subscriptionGeneration + 1,
        };
        // A newer intent naturally supersedes an older preview. Do not send a
        // cancel for it: the Webview can move one detached cached frame to the
        // next without a visible return-to-the-outgoing-document flicker.
        this.preflightPreview = preview;
        this.postLoadingNotice(
            panel,
            preview.target,
            preview.subscriptionGeneration,
            true
        );
        return {
            dispose: () => this.cancelPreflightPreview(preview),
        };
    }

    async open(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<void> {
        await this.loadTarget(target, true, snapshot, false, 'open');
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
        await this.loadTarget(target, false, snapshot, true, 'restore');
    }

    async follow(
        target: ConversationViewerTarget,
        snapshot?: ConversationSnapshot
    ): Promise<boolean> {
        if (!this.panel) {
            return false;
        }
        if (this.target && hasSameConversationViewerTarget(this.target, target)) {
            // The target is already authoritative. A duplicate dashboard
            // intent has no new state to apply, so do not re-read or
            // re-render the retained conversation. It may arrive after a
            // preflight for another target, however; cancel that preview so
            // the authoritative document becomes interactive immediately.
            if (this.preflightPreview) {
                this.cancelPreflightPreview(this.preflightPreview);
            }
            return true;
        }
        // A dashboard-driven follow for the same session must not yank the
        // user out of a subagent transcript they deliberately opened.
        if (this.target?.subagent
            && this.target.projectId === target.projectId
            && this.target.provider === target.provider
            && this.target.sessionId === target.sessionId) {
            return true;
        }
        return this.loadTarget(target, false, snapshot, false, 'follow');
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
        }, false, snapshot, false, 'rebind');
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
        forceDocumentReplacement = false,
        source: 'open' | 'follow' | 'restore' | 'rebind' = 'follow'
    ): Promise<boolean> {
        const startedAt = this.now();
        const hadPanel = Boolean(this.panel);
        const followedPanel = reveal ? undefined : this.panel;
        const previousTarget = this.target;
        const generation = this.replaceTarget(target);
        const preflightPreview = this.preflightPreview;
        this.preflightPreview = undefined;
        if (preflightPreview
            && (preflightPreview.subscriptionGeneration !== generation
                || !hasSameConversationSessionTarget(
                    preflightPreview.target,
                    target
                ))) {
            this.postLoadingCancel(preflightPreview);
        }
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
        const targetChanged = !previousTarget
            || previousTarget.projectId !== activeTarget.projectId
            || previousTarget.provider !== activeTarget.provider
            || previousTarget.sessionId !== activeTarget.sessionId;
        if (targetChanged) {
            this.pendingTargetLoadTiming = {
                subscriptionGeneration: generation,
                startedAt,
                source,
            };
        }
        if (hadPanel && targetChanged) {
            this.transitioningGeneration = generation;
        }
        const replaceDocument = forceDocumentReplacement || !hadPanel;
        if (replaceDocument) {
            panel.webview.html = this.renderDocument(
                undefined,
                'Loading conversation…'
            );
        } else if (targetChanged) {
            // Keep the existing document for a fast, scroll-stable handoff,
            // but make its outgoing controls inert until the new target has
            // an authoritative publication.
            this.postLoadingNotice(panel, activeTarget, generation);
        }
        this.restoreAuxiliaryState(activeTarget, generation);
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
        // A progressive page is still backfilling its deferred history: a
        // revalidation refresh would supersede the partial page before its
        // receipt, advance the request counter, and silently cancel the
        // chunked backfill — degrading every large-session open to a full
        // re-render. The completion publication converges state and the
        // session watch covers genuine appends, so defer the freshness
        // check until the incomplete-content obligation closes.
        if (this.progressiveContentIncomplete?.generation
            === this.subscriptionGeneration) {
            this.pendingRevalidationInteractionId = expectedInteractionId;
            return;
        }
        await this.loadAuthoritative(
            'refresh',
            false,
            undefined,
            expectedInteractionId
        );
    }

    private runPendingRevalidation(): void {
        const pending = this.pendingRevalidationInteractionId;
        if (pending === undefined) {
            return;
        }
        if (this.outlineController.selection !== pending) {
            // A newer selection superseded the deferred freshness check.
            this.pendingRevalidationInteractionId = undefined;
            return;
        }
        if (this.progressivePublication
            || this.progressiveContentIncomplete
            || this.suspended
            || !this.target
            || !this.panel) {
            // The obligation is still open: keep it pending; a later
            // full-content receipt closes the obligation and reruns this.
            return;
        }
        this.pendingRevalidationInteractionId = undefined;
        void this.loadAuthoritative(
            'refresh',
            false,
            undefined,
            pending
        );
    }

    private settleEarlierPageBackfill(
        request: ConversationViewerLoadEarlierMessage,
        outcome: 'busy' | 'unavailable' | 'stalled' | 'timed-out'
    ): void {
        // A retained previous Webview script sent the original two-field
        // envelope. It cannot understand a correlated result, so rebuild its
        // document on a terminal failure to clear its one-shot request flag.
        if (request.requestId === undefined
            || request.subscriptionGeneration === undefined) {
            if (outcome !== 'busy') {
                this.rebuildLatestDocument();
            }
            return;
        }
        if (!this.panel) {
            return;
        }
        void Promise.resolve(this.panel.webview.postMessage({
            type: 'conversation-viewer-load-earlier-result',
            version: 1,
            subscriptionGeneration: this.subscriptionGeneration,
            requestId: request.requestId,
            outcome,
        })).catch(() => undefined);
    }

    private clearEarlierPageBackfillTimer(backfill: NonNullable<
        ConversationViewer['earlierPageBackfill']
    >): void {
        const timer = backfill.timer;
        backfill.timer = undefined;
        if (timer === undefined) {
            return;
        }
        if (this.options.clearTimer) {
            this.options.clearTimer(timer);
        } else {
            clearTimeout(timer as NodeJS.Timeout);
        }
    }

    private cancelEarlierPageBackfill(): void {
        const backfill = this.earlierPageBackfill;
        this.earlierPageBackfill = undefined;
        if (!backfill) {
            return;
        }
        this.clearEarlierPageBackfillTimer(backfill);
        backfill.abortController?.abort();
    }

    private maybeContinueEarlierPageBackfill(
        request: ConversationViewerLoadEarlierMessage
    ): void {
        // User-driven: the Webview posts conversation-viewer-load-earlier
        // when the transcript reaches its top with earlier history pending.
        // Loads exactly one older page per request; the next page loads
        // when the user scrolls up again.
        const target = this.target;
        const panel = this.panel;
        const edge = this.pages[0]?.page;
        if (request.subscriptionGeneration !== undefined
            && request.subscriptionGeneration !== this.subscriptionGeneration) {
            return;
        }
        if (!target || !panel || this.suspended
            || !edge
            || edge.isStart
            || edge.previousCursor === undefined) {
            this.settleEarlierPageBackfill(request, 'unavailable');
            return;
        }
        if (this.progressivePublication
            || this.progressiveContentIncomplete
            || this.progressiveBackfill
            || this.authoritativeLoadInFlight
            || this.earlierPageBackfill) {
            this.settleEarlierPageBackfill(request, 'busy');
            return;
        }
        if (edge.interactionStates[0]?.interactionId
            === this.earlierBackfillStuckAnchor) {
            this.settleEarlierPageBackfill(request, 'stalled');
            return;
        }
        const anchor = edge.interactionStates[0]?.interactionId;
        const outline = this.outlineController.snapshot;
        if (!anchor || !outline) {
            this.settleEarlierPageBackfill(request, 'unavailable');
            return;
        }
        const cursor = edge.previousCursor;
        const oldestBefore = edge.interactionStates[0]?.interactionId;
        const backfill: NonNullable<ConversationViewer[
            'earlierPageBackfill'
        ]> = {
            token: ++this.nextEarlierPageBackfillToken,
            request,
            target,
        };
        this.earlierPageBackfill = backfill;
        const read = this.read({
            provider: target.provider,
            sessionId: this.effectiveSessionId(target),
            anchorInteractionId: anchor,
            direction: 'before',
            cursor,
            expectedRevision: outline.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        }, 'before', false, 'refresh', this.outlineController.selection, true, backfill);
        backfill.abortController = this.abortController;
        const timeout = () => {
            if (this.earlierPageBackfill !== backfill) {
                return;
            }
            this.earlierPageBackfill = undefined;
            backfill.timer = undefined;
            if (this.abortController === backfill.abortController) {
                backfill.abortController?.abort();
            }
            this.settleEarlierPageBackfill(request, 'timed-out');
        };
        const timer = this.options.setTimer
            ? this.options.setTimer(
                timeout,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            )
            : setTimeout(
                timeout,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            );
        backfill.timer = timer;
        void read
            .then(
                (outcome) => {
                    if (this.earlierPageBackfill !== backfill) {
                        return;
                    }
                    this.earlierPageBackfill = undefined;
                    this.clearEarlierPageBackfillTimer(backfill);
                    if (!outcome) {
                        if (this.target === target
                            && (request.subscriptionGeneration === undefined
                                || this.subscriptionGeneration
                                    === request.subscriptionGeneration)) {
                            this.settleEarlierPageBackfill(request, 'unavailable');
                        }
                        return;
                    }
                    const next = this.pages[0]?.page;
                    const madeProgress = !!next
                        && next.interactionStates[0]?.interactionId
                            !== oldestBefore;
                    // A prepend evicted by the retention budget made no
                    // progress: remember this boundary so ack-triggered
                    // restarts stop retrying it forever.
                    this.earlierBackfillStuckAnchor = madeProgress
                        || backfill.staleFallback
                        ? undefined
                        : oldestBefore;
                    if (!madeProgress) {
                        // A stale cursor retry intentionally falls back to
                        // an around-selection page. It did not prepend, but
                        // it also did not prove this cursor is terminal; keep
                        // it available for the next user-requested attempt.
                        this.settleEarlierPageBackfill(
                            request,
                            backfill.staleFallback ? 'busy' : 'stalled'
                        );
                    }
                },
                () => {
                    if (this.earlierPageBackfill !== backfill) {
                        return;
                    }
                    this.earlierPageBackfill = undefined;
                    this.clearEarlierPageBackfillTimer(backfill);
                    if (this.target === target
                        && (request.subscriptionGeneration === undefined
                            || this.subscriptionGeneration
                                === request.subscriptionGeneration)) {
                        this.settleEarlierPageBackfill(request, 'unavailable');
                    }
                }
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
            this.cancelEarlierPageBackfill();
            this.watch?.dispose();
            this.watch = undefined;
            const previousGeneration = this.subscriptionGeneration;
            this.subscriptionGeneration += 1;
            if (this.progressiveContentIncomplete?.generation
                === previousGeneration) {
                this.progressiveContentIncomplete = {
                    ...this.progressiveContentIncomplete,
                    generation: this.subscriptionGeneration,
                };
            }
            // The full-content refresh published below supersedes any
            // in-flight history backfill.
            this.cancelProgressiveBackfill();
            this.pendingRestoredAuxiliaryState = undefined;
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
        this.latestTailSplit = undefined;
        this.clearPublicationAckTimeout();
        this.progressivePublication = undefined;
        this.progressiveContentIncomplete = undefined;
        this.clearProgressiveObligationWatchdog();
        this.cancelProgressiveBackfill();
        this.pendingPublicationTiming = undefined;
        this.pendingTargetLoadTiming = undefined;
        this.pendingRestoredAuxiliaryState = undefined;
        this.pendingRevalidationInteractionId = undefined;
        this.earlierBackfillStuckAnchor = undefined;
        this.cancelEarlierPageBackfill();
        this.appliedContentSignature = undefined;
        this.publicationRecoveryRebuildRequestId = 0;
        this.publicationRecoveryAttemptRequestId = 0;
        this.publicationRecoveryGeneration = undefined;
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.target = {
            ...target,
            displayName: boundedConversationDisplayName(target.displayName),
        };
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.transitioningGeneration = undefined;
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
        this.preflightPreview = undefined;
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
        this.latestTailSplit = undefined;
        this.clearPublicationAckTimeout();
        this.progressivePublication = undefined;
        this.progressiveContentIncomplete = undefined;
        this.clearProgressiveObligationWatchdog();
        this.cancelProgressiveBackfill();
        this.pendingPublicationTiming = undefined;
        this.pendingTargetLoadTiming = undefined;
        this.pendingRestoredAuxiliaryState = undefined;
        this.pendingRevalidationInteractionId = undefined;
        this.earlierBackfillStuckAnchor = undefined;
        this.cancelEarlierPageBackfill();
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.publishKeyboardFocus(false);
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.transitioningGeneration = undefined;
        this.currentRequestId = 0;
        this.publicationRecoveryRebuildRequestId = 0;
        this.publicationRecoveryAttemptRequestId = 0;
        this.publicationRecoveryGeneration = undefined;
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
        if (parsed.type === 'conversation-viewer-capabilities') {
            // Document-scoped handshake, posted once at script startup:
            // Hosts predating it ignore the unknown type, while their
            // exact-key receipt whitelist would have rejected this as a
            // field on the applied receipt. The echoed document identity
            // keeps a queued advertisement from an outgoing document from
            // arming patches for its replacement.
            if (parsed.documentId === this.currentDocumentId) {
                this.webviewTailPatchCapable = parsed.capabilities
                    .includes('tail-patch');
                this.webviewFramePreflightCapable = parsed.capabilities
                    .includes('frame-preflight');
            }
            return;
        }
        if (parsed.type === 'conversation-viewer-frame-cache-preview') {
            const target = this.target;
            const authoritativeMatch = target
                && parsed.subscriptionGeneration === this.subscriptionGeneration
                && parsed.projectId === target.projectId
                && parsed.provider === target.provider
                && parsed.sessionId === target.sessionId;
            const preflight = this.preflightPreview;
            const preflightMatch = preflight
                && parsed.subscriptionGeneration === preflight.subscriptionGeneration
                && parsed.projectId === preflight.target.projectId
                && parsed.provider === preflight.target.provider
                && parsed.sessionId === preflight.target.sessionId;
            if (authoritativeMatch || preflightMatch) {
                this.emitDiagnostic('frame-cache-preview', {
                    outcome: parsed.outcome,
                    ...(preflightMatch ? {
                        preflightSessionId: parsed.sessionId,
                        preflightProvider: parsed.provider,
                    } : {}),
                });
            }
            return;
        }
        if (!this.target) {
            return;
        }
        if (this.transitioningGeneration === this.subscriptionGeneration
            && parsed.type !== 'conversation-viewer-applied'
            && parsed.type !== 'conversation-viewer-request-sync') {
            // A panel replacement is asynchronous at the Webview boundary.
            // Ignore any outgoing-document action until the authoritative
            // incoming document is ready, rather than applying it to the
            // already-replaced Host target.
            if (parsed.type === 'conversation-viewer-load-earlier'
                && parsed.subscriptionGeneration
                    === this.subscriptionGeneration) {
                this.settleEarlierPageBackfill(parsed, 'busy');
            } else {
                this.emitDiagnostic('message-dropped-target-transition');
            }
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
            this.options.onNavigationIntent?.();
            const currentTarget = this.target;
            await this.options.followAdjacentConversation?.(
                parsed.direction,
                currentTarget
            );
            return;
        }
        if (parsed.type === 'conversation-viewer-cycle-status-session') {
            this.options.onNavigationIntent?.();
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
        if (parsed.type === 'conversation-viewer-history-chunk-applied') {
            this.acknowledgeHistoryChunk(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-request-sync') {
            // The Webview failed to apply a delivered publication; rebuild
            // the document with the full HTML so a dropped delta cannot
            // strand it on stale content. Bound to one rebuild per
            // subscription generation: a persistent apply failure must not
            // loop when a streaming provider publishes a new request. A
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
            if (parsed.requestId === undefined
                || parsed.htmlSignature === undefined) {
                // A retained version-1 Webview cannot identify the failed
                // publication. Do not let that stale request consume a newer
                // page's one recovery attempt while a handoff watchdog is
                // already guarding that page. Outside a handoff, recover the
                // latest page once so a legacy refresh failure cannot remain
                // stale forever.
                if (this.transitioningGeneration
                    === parsed.subscriptionGeneration) {
                    this.emitDiagnostic('resync-legacy-await-watchdog', {
                        requestGeneration: parsed.subscriptionGeneration,
                    });
                } else if (publication) {
                    this.recoverPublication(publication, 'resync-legacy-rebuild');
                }
                return;
            }
            if (!publication
                || publication.requestId !== parsed.requestId
                || publication.htmlSignature !== parsed.htmlSignature) {
                this.emitDiagnostic('resync-dropped-stale-publication', {
                    requestGeneration: parsed.subscriptionGeneration,
                });
                return;
            }
            this.recoverPublication(publication, 'resync-rebuild', {
                ...(parsed.applyError
                    ? { applyError: parsed.applyError }
                    : {}),
            });
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
        if (parsed.type === 'conversation-viewer-first') {
            await this.navigateFirst();
            return;
        }
        if (parsed.type === 'conversation-viewer-previous') {
            await this.navigate('before');
            return;
        }
        if (parsed.type === 'conversation-viewer-load-earlier') {
            this.maybeContinueEarlierPageBackfill(parsed);
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
        this.latestTailSplit = undefined;
        this.cancelProgressiveBackfill();
        this.pendingRestoredAuxiliaryState = undefined;
        this.pendingRevalidationInteractionId = undefined;
        this.earlierBackfillStuckAnchor = undefined;
        this.cancelEarlierPageBackfill();
        this.commentController.reset();
        this.projectCommentController.reset();
        this.bookmarkController.reset();
        this.target = { ...target };
        this.suspended = false;
        this.currentRequestId = 0;
        const generation = this.subscriptionGeneration;
        const activeTarget = this.target;
        this.restoreAuxiliaryState(activeTarget, generation);
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
        const workspaceFile = parseConversationWorkspaceFileLink(href);
        if (workspaceFile) {
            if (this.target) {
                await this.options.openLocalFile?.(workspaceFile, this.target);
            }
            return;
        }
        const localFile = parseConversationLocalFileLink(href);
        if (localFile) {
            if (this.target) {
                await this.options.openLocalFile?.(localFile, this.target);
            }
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
        const loadedInteractionIds = this.interactionIds();
        const loadedIndex = loadedInteractionIds.indexOf(selectedInteractionId);
        const loadedInteractionId = loadedIndex >= 0
            ? loadedInteractionIds[loadedIndex + (direction === 'before' ? -1 : 1)]
            : undefined;
        const selectedInput = this.outlineController.selectedInput();
        const nextInteractionId = loadedInteractionId
            || (selectedInput === undefined
                ? this.outlineController.adjacentInteractionId(direction)
                : undefined);
        if (!nextInteractionId) {
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
            const selectedOutsideOutlineInput = selectedInput === undefined
                ? undefined
                : selectedInput + (direction === 'before' ? -1 : 1);
            if (!cursor || !anchorInteractionId
                || selectedOutsideOutlineInput === undefined) {
                return false;
            }
            return this.read({
                provider: target.provider,
                sessionId: this.effectiveSessionId(target),
                anchorInteractionId,
                direction,
                cursor,
                expectedRevision: outline.sourceRevision,
                limit: CONVERSATION_LIMITS.maxPageInteractions,
            }, direction, false, 'navigation', anchorInteractionId, false,
            undefined, selectedOutsideOutlineInput);
        }
        const selectedOutsideOutlineInput = selectedInput !== undefined
            ? selectedInput + (direction === 'before' ? -1 : 1)
            : undefined;
        if (this.interactionIds().includes(nextInteractionId)) {
            return this.publishSelection(
                nextInteractionId,
                'navigation',
                selectedOutsideOutlineInput
            );
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

    private restoreAuxiliaryState(
        target: ConversationViewerTarget,
        generation: number
    ): void {
        void Promise.all([
            this.commentController.restore(target, generation),
            this.projectCommentController.restore(target, generation),
            this.bookmarkController.restore(target, generation),
        ]).then(() => {
            if (this.target !== target
                || this.subscriptionGeneration !== generation) {
                return;
            }
            this.pendingRestoredAuxiliaryState = { target, generation };
            this.publishRestoredAuxiliaryState();
        }).catch(() => undefined);
    }

    private publishRestoredAuxiliaryState(): void {
        const pending = this.pendingRestoredAuxiliaryState;
        const publication = this.latestPublication;
        if (!pending || this.suspended || this.target !== pending.target
            || this.subscriptionGeneration !== pending.generation
            || this.progressiveBackfill
            // A partial page owes the reader its deferred history. Auxiliary
            // state is not content, so it must never buy its way onto the wire
            // by re-rendering the whole conversation: wait for the obligation
            // to close and ride the state-only envelope below instead. Without
            // this, every switch into a session with comments, bookmarks, or
            // subagents discards the progressive first paint.
            || this.progressiveContentIncomplete?.generation
                === this.subscriptionGeneration
            || !publication || !this.isCurrentPublication(publication)) {
            return;
        }
        if (this.publicationHasCurrentAuxiliaryState(publication)) {
            this.pendingRestoredAuxiliaryState = undefined;
            return;
        }
        // A state-only envelope must never update an outgoing or unready
        // document. An applied receipt proves this exact content is visible.
        if (this.appliedContentSignature !== publication.htmlSignature) {
            return;
        }
        this.pendingRestoredAuxiliaryState = undefined;
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        void this.deliverPublication(this.createPublication(
            requestId,
            pending.generation,
            'refresh'
        ), false);
    }

    private publicationHasCurrentAuxiliaryState(
        publication: ConversationViewerPageMessage
    ): boolean {
        return publication.comments.revision
                === this.commentController.snapshot.revision
            && publication.projectComments.revision
                === this.projectCommentController.snapshot.revision
            && publication.bookmarks.revision
                === this.bookmarkController.snapshot.revision
            && sameSubagents(publication.subagents, this.subagents);
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

    private async navigateFirst(): Promise<void> {
        const target = this.target;
        const outline = this.outlineController.snapshot;
        const firstInteractionId = outline?.firstInteractionId
            || (!outline?.partial ? outline?.interactions[0]?.id : undefined);
        if (!target || !outline || !firstInteractionId) {
            return;
        }
        if (this.outlineController.contains(firstInteractionId)
            && this.interactionIds().includes(firstInteractionId)) {
            await this.publishSelection(firstInteractionId, 'navigation');
            return;
        }
        await this.read({
            provider: target.provider,
            sessionId: this.effectiveSessionId(target),
            anchorInteractionId: firstInteractionId,
            direction: 'around',
            expectedRevision: outline.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        }, 'replace', false, 'navigation', firstInteractionId);
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
        // A normal authoritative read supersedes a user-triggered retained
        // history read. Detach it before aborting so its late completion
        // cannot settle an obsolete request against the new page.
        if (this.earlierPageBackfill?.abortController
            === this.abortController) {
            this.cancelEarlierPageBackfill();
        }
        this.abortController?.abort();
        const abortController = new ConversationAbortController();
        this.abortController = abortController;
        const generation = this.subscriptionGeneration;
        const subagentDiscoveryGeneration =
            ++this.subagentDiscoveryGeneration;
        const requestId = this.allocateRequestId();
        const supersededRequestId = this.currentRequestId;
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
            if (!this.canPublish(panel, target, generation, requestId)
                || abortController.signal.aborted) {
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
            const containsSelectedInteraction = (interactionId: string) =>
                interactionIds.includes(interactionId)
                || outline.firstInteractionId === interactionId
                || (this.outlineController.isSelectedOutsideOutline()
                    && this.outlineController.selection === interactionId);
            let advanceToLatest = followLatest
                && interactionIds.includes(latestIfSelection as string);
            if (updateKind === 'initial'
                && !containsSelectedInteraction(target.interactionId)) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (updateKind === 'refresh'
                && !advanceToLatest
                && (!previousSelectedInteractionId
                    || !containsSelectedInteraction(previousSelectedInteractionId))) {
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
                // A completed background history index can replace the
                // bounded tail with a continuous source without changing
                // either the source revision or the most recent outline
                // IDs. Its total/partial metadata still changes the page
                // boundary (and therefore its earlier cursor), so it must
                // not take the lifecycle-only fast path.
                const pagingMetadataChanged = retainedOutline.totalInteractions
                    !== outline.totalInteractions
                    || retainedOutline.partial !== outline.partial;
                if (retainedRevisionMatches
                    && !lifecycleChangedInteractionIds.length
                    && !pagingMetadataChanged) {
                    // Nothing to publish: hand the request counter back so the
                    // still-visible publication stays correlatable.
                    this.releaseUnpublishedRequestId(
                        requestId,
                        supersededRequestId
                    );
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
                    && !lifecycleProjectionInteractionId
                    && !pagingMetadataChanged) {
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
                            || !(retryInteractionIds.includes(
                                previousSelectedInteractionId
                            ) || outline.firstInteractionId
                                === previousSelectedInteractionId
                                || (this.outlineController
                                    .isSelectedOutsideOutline()
                                    && this.outlineController.selection
                                        === previousSelectedInteractionId)))) {
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
                    ) && outline.firstInteractionId !== selectedInteractionId) {
                        const selectedInput = this.outlineController.selectedInput();
                        if (selectedInput === undefined
                            || !this.outlineController.selectOutsideOutline(
                                selectedInteractionId,
                                selectedInput
                            )) {
                            await this.publishFailure(replaceDocument, updateKind);
                            return false;
                        }
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
            ) && (this.outlineController.selectedInput() === undefined
                || !this.outlineController.selectOutsideOutline(
                    lifecycleProjectionInteractionId
                        ? selectedInteractionId
                        : page.anchorInteractionId,
                    this.outlineController.selectedInput()!
                ))) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            this.stale = false;
            if (updateKind === 'refresh') {
                if (selectedRefreshPage) {
                    this.mergeRefreshPage(
                        selectedRefreshPage,
                        outline,
                        retainedRevisionMatches
                    );
                }
                this.mergeRefreshPage(page, outline, retainedRevisionMatches);
            } else {
                this.retain(page, 'replace');
            }
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            const progressiveCandidate = updateKind === 'initial'
                && this.canProgressivelyRender();
            const publication = this.restorableFramePublication(
                requestId,
                generation,
                updateKind,
                progressiveCandidate,
                target
            ) || this.createPublication(
                requestId,
                generation,
                updateKind,
                progressiveCandidate
            );
            const progressive = this.progressiveDeferredMessageCounts
                .has(publication);
            if (progressive) {
                this.progressivePublication = publication;
                this.progressiveContentIncomplete = {
                    generation,
                    partialHtmlSignature: publication.htmlSignature,
                    deferredMessageCount: this.progressiveDeferredMessageCounts
                        .get(publication) || 0,
                };
            }
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
            // The list is sidebar metadata, so it publishes the same way as
            // restored comments and bookmarks: deferred behind any open
            // deferred-history obligation and then delivered as a state-only
            // envelope. Publishing a page for it directly would resend the
            // whole transcript, because a fresh publication's content
            // signature cannot match what the Webview already applied.
            this.pendingRestoredAuxiliaryState = { target, generation };
            this.publishRestoredAuxiliaryState();
        }).catch(() => undefined);
    }

    private async read(
        request: ConversationPageRequest,
        placement: 'replace' | 'before' | 'after',
        replaceDocument: boolean,
        updateKind: ConversationViewerPageMessage['updateKind'],
        preferredInteractionId: string,
        preserveSelection = false,
        earlierBackfill?: NonNullable<ConversationViewer['earlierPageBackfill']>,
        selectedOutsideOutlineInput?: number
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
                if (!this.canPublish(panel, target, generation, requestId)
                    || abortController.signal.aborted) {
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
                ) && outline.firstInteractionId !== preferredInteractionId) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
                retriedStaleRevision = true;
                if (placement === 'before' && earlierBackfill) {
                    earlierBackfill.staleFallback = true;
                }
                page = await this.options.readPage({
                    provider: target.provider,
                    sessionId: this.effectiveSessionId(target),
                    anchorInteractionId: preferredInteractionId,
                    direction: 'around',
                    expectedRevision: outline.sourceRevision,
                    limit: CONVERSATION_LIMITS.maxPageInteractions,
                }, abortController.signal);
            }
            if (!this.canPublish(panel, target, generation, requestId)
                || abortController.signal.aborted) {
                return false;
            }
            if (page.provider !== target.provider
                || page.sessionId !== this.effectiveSessionId(target)
                || page.sourceRevision !== outline?.sourceRevision) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            this.stale = false;
            if (retriedStaleRevision && outline) {
                // A retry is a new authoritative snapshot even while the
                // user reads an older page. Advance the outline revision
                // before retaining the selection for later before-page reads.
                if (!this.outlineController.replace(
                    outline,
                    preferredInteractionId
                ) && (selectedOutsideOutlineInput === undefined
                    || !this.outlineController.selectOutsideOutline(
                        preferredInteractionId,
                        selectedOutsideOutlineInput
                    ))) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
            }
            if (preserveSelection) {
                // A prepended page may be older than the bounded outline.
                // Keep the current selection anchored in that outline rather
                // than rejecting a perfectly valid, cursor-authorized page.
                if (!this.outlineController.contains(preferredInteractionId)) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
            } else {
                if (!this.outlineController.select(page.anchorInteractionId)
                    && (selectedOutsideOutlineInput === undefined
                        || !this.outlineController.selectOutsideOutline(
                            page.anchorInteractionId,
                            selectedOutsideOutlineInput
                        ))) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
            }
            if (retriedStaleRevision && outline) {
                this.mergeRefreshPage(page, outline, false);
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
        updateKind: ConversationViewerPageMessage['updateKind'],
        selectedOutsideOutlineInput?: number
    ): Promise<boolean> {
        const panel = this.panel;
        const target = this.target;
        if (!panel || !target || (!this.outlineController.contains(interactionId)
            && (selectedOutsideOutlineInput === undefined
                || !this.interactionIds().includes(interactionId)))) {
            return false;
        }
        this.abortController?.abort();
        if (!this.outlineController.select(interactionId)
            && (selectedOutsideOutlineInput === undefined
                || !this.outlineController.selectOutsideOutline(
                    interactionId,
                    selectedOutsideOutlineInput
                ))) {
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
        this.latestTailSplit = undefined;
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
        // Any page publication supersedes an in-flight history backfill:
        // it either carries the full content itself or is the backfill's
        // own completion refresh (whose plan is already detached).
        this.cancelProgressiveBackfill();
        this.publicationRecoveryRebuildRequestId = 0;
        this.publicationRecoveryAttemptRequestId = 0;
        const previousPublication = this.latestPublication;
        const previousTailSplit = this.latestTailSplit;
        const tailSplit = this.lastPublicationTailSplit;
        this.lastPublicationTailSplit = undefined;
        this.latestPublication = publication;
        this.latestTailSplit = tailSplit;
        if (replaceDocument) {
            this.recordPublicationDelivery(publication, 'document');
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
        // Streaming tail patch: the Webview applied exactly the previous
        // publication, and everything before the trailing interaction group
        // is unchanged, so only that group goes on the wire. The receipt
        // still confirms the full content signature, keeping every later
        // delta decision authoritative.
        const tailPatch = !sameAsApplied && !frameRestorable && tailSplit
            && publication.updateKind === 'refresh'
            && this.webviewTailPatchCapable
            && previousPublication !== undefined && previousTailSplit
            && previousPublication.subscriptionGeneration
                === publication.subscriptionGeneration
            && previousPublication.htmlSignature
                === this.appliedContentSignature
            && tailSplit.prefixSignature === previousTailSplit.prefixSignature
            && tailSplit.tailInteractionId
                === previousTailSplit.tailInteractionId
            && this.progressiveContentIncomplete?.generation
                !== publication.subscriptionGeneration
            && !this.progressivePublication
            ? tailSplit
            : undefined;
        const wire: ConversationViewerPageMessage = sameAsApplied
            ? { ...publication, html: undefined }
            : frameRestorable
                ? { ...publication, html: undefined, restoreFrame: true }
                : tailPatch
                    ? {
                        ...publication,
                        html: undefined,
                        tailInteractionId: tailPatch.tailInteractionId,
                        tailHtml: tailPatch.tailHtml,
                    }
                    : publication;
        let delivered = false;
        try {
            this.recordPublicationDelivery(
                publication,
                'message',
                wire.html === undefined
                    ? Buffer.byteLength(wire.tailHtml || '', 'utf8')
                    : Buffer.byteLength(wire.html, 'utf8')
            );
            delivered = await panel.webview.postMessage(wire);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered && this.isCurrentPublication(publication)) {
            this.recoverPublication(publication, 'publication-delivery-failed');
        }
    }

    private acknowledgePublication(
        message: ConversationViewerAppliedMessage
    ): void {
        if (message.subscriptionGeneration !== this.subscriptionGeneration) {
            return;
        }
        const publication = this.latestPublication;
        if (!publication
            || message.requestId !== publication.requestId
            || message.htmlSignature !== publication.htmlSignature) {
            return;
        }
        // Transitional documents rendered by the pre-handshake script
        // advertise tail-patch support on the receipt itself; accept it as
        // an upgrade path, but never clear the dedicated handshake's
        // verdict (the current script omits the field).
        if (message.capabilities?.includes('tail-patch')) {
            this.webviewTailPatchCapable = true;
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
        this.appliedContentSignature = publication.htmlSignature;
        // A correlated application receipt proves this Webview generation is
        // healthy again, so a later independent failure may use recovery.
        this.publicationRecoveryGeneration = undefined;
        this.clearPublicationAckTimeout();
        if (this.progressiveContentIncomplete
            && this.progressiveContentIncomplete.generation
                === publication.subscriptionGeneration
            && this.progressiveContentIncomplete.partialHtmlSignature
                !== publication.htmlSignature) {
            this.progressiveContentIncomplete = undefined;
            this.progressivePublication = undefined;
            this.clearProgressiveObligationWatchdog();
        }
        this.reportPublicationApplication(publication);
        if (this.transitioningGeneration === message.subscriptionGeneration) {
            this.transitioningGeneration = undefined;
        }
        this.publishRestoredAuxiliaryState();
        this.publishDeferredMessages(publication);
        this.runPendingRevalidation();
    }

    private publishDeferredMessages(
        publication: ConversationViewerPageMessage
    ): void {
        if (this.progressivePublication !== publication
            || !this.isCurrentPublication(publication)) {
            // A superseding load claimed the counter before this receipt
            // arrived. The obligation stays open, so watch it.
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        this.progressivePublication = undefined;
        this.cancelProgressiveBackfill();
        const backfill = this.createProgressiveBackfill(publication);
        if (backfill) {
            this.progressiveBackfill = backfill;
            this.sendNextProgressiveBackfillChunk();
            return;
        }
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        const complete = this.createPublication(
            requestId,
            publication.subscriptionGeneration,
            'refresh'
        );
        void this.deliverPublication(complete, false);
    }

    /**
     * Plan an ack-paced history backfill for a progressively rendered page.
     * Returns undefined when the deferred window is small enough for one
     * full refresh or when the rendered content drifted from the published
     * partial page (chunk prepending is only valid against that exact
     * document).
     */
    private createProgressiveBackfill(
        publication: ConversationViewerPageMessage
    ): ConversationProgressiveBackfill | undefined {
        const generation = publication.subscriptionGeneration;
        if (this.progressiveContentIncomplete?.generation !== generation
            || this.progressiveContentIncomplete.partialHtmlSignature
                !== publication.htmlSignature) {
            return undefined;
        }
        const target = this.target;
        if (!target || !this.outlineController.snapshot) {
            return undefined;
        }
        const allMessages = this.messages();
        const deferredCount = this.progressiveContentIncomplete
            .deferredMessageCount;
        if (!deferredCount) {
            return undefined;
        }
        const interactionInfo = this.createInteractionInfo();
        const sessionId = this.effectiveSessionId(target);
        // Chunks prepend blindly above the placeholder, so they are valid
        // only while the visible tail is byte-identical to this render. Any
        // drift (a streamed message, a clock rollover) falls back to the
        // single full refresh, which reconciles the whole document.
        const partial = renderMessages(
            allMessages.slice(deferredCount),
            this.showThinking(),
            interactionInfo,
            this.renderCache,
            this.contentSignatures,
            sessionId,
            deferredCount
        );
        if (partial.contentSignature !== publication.htmlSignature) {
            return undefined;
        }
        return {
            generation,
            anchorRequestId: publication.requestId,
            nextDeferredEnd: deferredCount,
            messages: allMessages,
            interactionInfo,
            sessionId,
            timerToken: 0,
        };
    }

    private sendNextProgressiveBackfillChunk(): void {
        const plan = this.progressiveBackfill;
        const panel = this.panel;
        if (!plan || !panel || this.suspended) {
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        if (plan.generation !== this.subscriptionGeneration
            || plan.anchorRequestId !== this.currentRequestId) {
            // A newer load or publication owns the request counter now; it
            // supersedes the backfill (its own delivery cancels the plan).
            this.cancelProgressiveBackfill();
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        const chunk = this.createNextProgressiveBackfillChunk(plan);
        if (!chunk) {
            this.recoverProgressiveBackfill(plan, 'backfill-chunk-plan-failed');
            return;
        }
        const requestId = this.allocateRequestId();
        plan.pending = { requestId, htmlSignature: chunk.htmlSignature };
        this.scheduleProgressiveBackfillTimeout(plan);
        const wire: ConversationViewerHistoryChunkMessage = {
            type: 'conversation-viewer-history-chunk',
            version: 1,
            subscriptionGeneration: plan.generation,
            requestId,
            html: chunk.html,
            htmlSignature: chunk.htmlSignature,
            complete: chunk.complete,
        };
        void Promise.resolve(panel.webview.postMessage(wire)).then(
            delivered => {
                if (!delivered) {
                    this.recoverProgressiveBackfill(
                        plan,
                        'backfill-chunk-delivery-failed'
                    );
                }
            },
            () => this.recoverProgressiveBackfill(
                plan,
                'backfill-chunk-delivery-failed'
            )
        );
    }

    private createNextProgressiveBackfillChunk(
        plan: ConversationProgressiveBackfill
    ): { html: string; htmlSignature: string; complete: boolean } | undefined {
        const end = plan.nextDeferredEnd;
        if (!end) {
            return undefined;
        }
        let start = end;
        let chunk: RenderedConversationMessages | undefined;
        while (start > 0) {
            const groupStart = interactionGroupStart(plan.messages, start - 1);
            const candidate = renderMessages(
                plan.messages.slice(groupStart, end),
                this.showThinking(),
                plan.interactionInfo,
                this.renderCache,
                this.contentSignatures,
                plan.sessionId
            );
            if (start !== end
                && (end - groupStart > CONVERSATION_PROGRESSIVE_CHUNK_SIZE
                    || Buffer.byteLength(candidate.html, 'utf8')
                        > CONVERSATION_PROGRESSIVE_RENDERED_HTML_BUDGET)) {
                break;
            }
            start = groupStart;
            chunk = candidate;
        }
        if (!chunk) {
            return undefined;
        }
        const cumulative = renderMessages(
            plan.messages.slice(start),
            this.showThinking(),
            plan.interactionInfo,
            this.renderCache,
            this.contentSignatures,
            plan.sessionId,
            start
        );
        plan.nextDeferredEnd = start;
        return {
            html: chunk.html,
            htmlSignature: cumulative.contentSignature,
            complete: start === 0,
        };
    }

    private acknowledgeHistoryChunk(
        message: ConversationViewerHistoryChunkAppliedMessage
    ): void {
        const plan = this.progressiveBackfill;
        if (!plan || !plan.pending
            || message.subscriptionGeneration !== this.subscriptionGeneration
            || message.subscriptionGeneration !== plan.generation
            || message.requestId !== plan.pending.requestId
            || message.htmlSignature !== plan.pending.htmlSignature) {
            return;
        }
        if (plan.anchorRequestId !== this.currentRequestId) {
            // A newer load or publication allocated the request counter
            // after this slice was sent. Its delivery supersedes the
            // backfill, so the receipt must not allocate ids or publish.
            this.emitDiagnostic('backfill-stale-anchor');
            this.cancelProgressiveBackfill();
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        this.clearProgressiveBackfillTimer(plan);
        // The Webview is the authority on applied content: the cumulative
        // signature it confirmed is what later publications may omit.
        this.appliedContentSignature = plan.pending.htmlSignature;
        plan.pending = undefined;
        if (plan.nextDeferredEnd > 0) {
            this.sendNextProgressiveBackfillChunk();
            return;
        }
        this.progressiveBackfill = undefined;
        // History is fully visible. Close the loop with a normal refresh
        // publication (HTML omitted while the content is unchanged) so the
        // latest publication, deferred auxiliary state, and the
        // incomplete-content obligation all converge on the full document.
        if (!this.target || !this.outlineController.snapshot) {
            return;
        }
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        void this.deliverPublication(this.createPublication(
            requestId,
            plan.generation,
            'refresh'
        ), false);
    }

    private scheduleProgressiveBackfillTimeout(
        plan: ConversationProgressiveBackfill
    ): void {
        // A slice is now the pending step and carries its own recovery.
        this.clearProgressiveObligationWatchdog();
        const token = ++plan.timerToken;
        const recover = () => {
            if (token !== plan.timerToken) {
                return;
            }
            plan.timer = undefined;
            this.recoverProgressiveBackfill(plan, 'backfill-chunk-ack-timeout');
        };
        const handle = this.options.setTimer
            ? this.options.setTimer(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            )
            : setTimeout(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            );
        if (token === plan.timerToken) {
            plan.timer = handle;
        } else if (this.options.clearTimer) {
            this.options.clearTimer(handle);
        } else {
            clearTimeout(handle as NodeJS.Timeout);
        }
    }

    private clearProgressiveBackfillTimer(
        plan: ConversationProgressiveBackfill
    ): void {
        plan.timerToken += 1;
        const timer = plan.timer;
        plan.timer = undefined;
        if (timer === undefined) {
            return;
        }
        if (this.options.clearTimer) {
            this.options.clearTimer(timer);
        } else {
            clearTimeout(timer as NodeJS.Timeout);
        }
    }

    /**
     * A lost or unacknowledged slice never strands the partial page: cancel
     * the plan and deliver one full-content refresh. The generation-level
     * incomplete-content watchdog still guards that publication.
     */
    private recoverProgressiveBackfill(
        plan: ConversationProgressiveBackfill,
        reason: string
    ): void {
        if (this.progressiveBackfill !== plan
            || plan.generation !== this.subscriptionGeneration) {
            return;
        }
        this.emitDiagnostic(reason);
        this.cancelProgressiveBackfill();
        if (this.suspended || !this.panel) {
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        if (plan.anchorRequestId !== this.currentRequestId) {
            // A newer load owns the request counter; its publication
            // supersedes the backfill, so a recovery refresh would kill it.
            this.emitDiagnostic('backfill-recovery-yielded');
            this.scheduleProgressiveObligationWatchdog();
            return;
        }
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        void this.deliverPublication(this.createPublication(
            requestId,
            plan.generation,
            'refresh'
        ), false);
    }

    private cancelProgressiveBackfill(): void {
        const plan = this.progressiveBackfill;
        this.progressiveBackfill = undefined;
        if (!plan) {
            return;
        }
        this.clearProgressiveBackfillTimer(plan);
    }

    /**
     * Arm the open incomplete-content obligation's own watchdog. Safe to call
     * from any yield path: it no-ops unless a partial page for the current
     * generation is still waiting for its deferred history. Re-arming on each
     * yield is intended — the obligation is only ever closed by a full-content
     * receipt.
     */
    private scheduleProgressiveObligationWatchdog(): void {
        if (this.progressiveContentIncomplete?.generation
            !== this.subscriptionGeneration
            || this.suspended
            || !this.panel) {
            return;
        }
        this.clearProgressiveObligationWatchdog();
        const generation = this.subscriptionGeneration;
        const token = ++this.progressiveObligationTimerToken;
        const recover = () => {
            if (token !== this.progressiveObligationTimerToken) {
                return;
            }
            this.progressiveObligationTimer = undefined;
            this.recoverProgressiveObligation(generation);
        };
        const handle = this.options.setTimer
            ? this.options.setTimer(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            )
            : setTimeout(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            );
        if (token === this.progressiveObligationTimerToken) {
            this.progressiveObligationTimer = handle;
        } else if (this.options.clearTimer) {
            this.options.clearTimer(handle);
        } else {
            clearTimeout(handle as NodeJS.Timeout);
        }
    }

    private clearProgressiveObligationWatchdog(): void {
        this.progressiveObligationTimerToken += 1;
        const timer = this.progressiveObligationTimer;
        this.progressiveObligationTimer = undefined;
        if (timer === undefined) {
            return;
        }
        if (this.options.clearTimer) {
            this.options.clearTimer(timer);
        } else {
            clearTimeout(timer as NodeJS.Timeout);
        }
    }

    /**
     * Nothing has advanced the partial page since it yielded its backfill.
     * Publish the full document once: it retires the placeholder, and its own
     * delivery receipt closes the obligation. A load still in flight loses the
     * request counter here and yields without publishing, which is the
     * intended outcome — a stalled read must not outrank the reader's promised
     * history, and the session watch reissues any genuinely newer content.
     */
    private recoverProgressiveObligation(generation: number): void {
        if (this.progressiveContentIncomplete?.generation !== generation
            || generation !== this.subscriptionGeneration
            || this.suspended
            || !this.panel
            || !this.target
            || !this.outlineController.snapshot
            || this.progressiveBackfill?.pending) {
            return;
        }
        this.emitDiagnostic('progressive-obligation-timeout');
        this.cancelProgressiveBackfill();
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        void this.deliverPublication(this.createPublication(
            requestId,
            generation,
            'refresh'
        ), false);
    }

    private rebuildLatestDocument(): void {
        const panel = this.panel;
        const publication = this.latestPublication;
        if (!panel || !publication || !this.isCurrentPublication(publication)) {
            return;
        }
        this.recordPublicationDelivery(publication, 'document');
        panel.webview.html = this.renderDocument(publication);
    }

    private rebuildRecoveredPublication(
        publication: ConversationViewerPageMessage
    ): void {
        const panel = this.panel;
        if (!panel || !this.isCurrentPublication(publication)) {
            return;
        }
        // A document replacement starts a new Webview application attempt.
        // Its receipt must never be confused with a late acknowledgement from
        // the outgoing document that triggered recovery.
        const recovery = {
            ...publication,
            requestId: this.allocateRequestId(),
            ...(this.keyboardFocused && panel.active
                ? { restoreFocus: true }
                : {}),
        };
        // Recovery owns a fresh object and request id. Preserve the
        // deferred-content lifecycle on that authoritative retry — both for
        // a partial page whose first receipt never arrived and for one
        // whose history backfill was already in flight (the rebuilt
        // document restarts from the partial page, so its receipt must
        // re-plan the backfill).
        if (this.progressivePublication === publication
            || (this.progressiveContentIncomplete?.generation
                    === publication.subscriptionGeneration
                && this.progressiveContentIncomplete.partialHtmlSignature
                    === publication.htmlSignature)) {
            this.progressivePublication = recovery;
            const deferredMessageCount = this.progressiveDeferredMessageCounts
                .get(publication);
            if (deferredMessageCount) {
                this.progressiveDeferredMessageCounts.set(
                    recovery,
                    deferredMessageCount
                );
            }
        }
        this.cancelProgressiveBackfill();
        this.currentRequestId = recovery.requestId;
        this.latestPublication = recovery;
        this.publicationRecoveryAttemptRequestId = recovery.requestId;
        this.recordPublicationDelivery(recovery, 'document');
        panel.webview.html = this.renderDocument(recovery);
    }

    private recordPublicationDelivery(
        publication: ConversationViewerPageMessage,
        delivery: ConversationViewerApplicationTiming['delivery'],
        contentBytes = Buffer.byteLength(publication.html || '', 'utf8')
    ): void {
        // A delivery is now the pending step, and its own ack watchdog covers
        // an open incomplete-content obligation.
        this.clearProgressiveObligationWatchdog();
        this.pendingPublicationTiming = {
            subscriptionGeneration: publication.subscriptionGeneration,
            requestId: publication.requestId,
            htmlSignature: publication.htmlSignature,
            updateKind: publication.updateKind,
            delivery,
            publishedAt: this.now(),
            contentBytes,
            progressive: this.progressiveContentIncomplete?.generation
                === publication.subscriptionGeneration
                && this.progressiveContentIncomplete.partialHtmlSignature
                    === publication.htmlSignature,
        };
        this.schedulePublicationAckTimeout(publication);
    }

    private schedulePublicationAckTimeout(
        publication: ConversationViewerPageMessage
    ): void {
        this.clearPublicationAckTimeout();
        const protectsProgressiveContent = this.progressiveContentIncomplete
            ?.generation === publication.subscriptionGeneration;
        // A fresh document has no outgoing controls to strand. The normal
        // watchdog protects a reused-panel handoff; every publication in a
        // progressive generation inherits it until a full-content receipt
        // closes the incomplete-content obligation.
        if (this.transitioningGeneration !== publication.subscriptionGeneration
            && !protectsProgressiveContent) {
            return;
        }
        const token = ++this.publicationAckTimerToken;
        const recover = () => {
            if (token !== this.publicationAckTimerToken) {
                return;
            }
            this.publicationAckTimer = undefined;
            if (!this.isCurrentPublication(publication)
                || (this.appliedContentSignature
                        === publication.htmlSignature
                    && this.progressiveContentIncomplete?.generation
                        !== publication.subscriptionGeneration)
                || (this.transitioningGeneration
                    !== publication.subscriptionGeneration
                    && this.progressiveContentIncomplete?.generation
                        !== publication.subscriptionGeneration)
                || this.publicationRecoveryRebuildRequestId
                    === publication.requestId
                || this.publicationRecoveryAttemptRequestId
                    === publication.requestId) {
                return;
            }
            // postMessage resolving proves only queueing. Retry the current
            // page once as a full document so a dropped Webview delivery
            // cannot leave the panel loading forever.
            this.recoverPublication(publication, 'publication-ack-timeout');
        };
        const handle = this.options.setTimer
            ? this.options.setTimer(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            )
            : setTimeout(
                recover,
                CONVERSATION_LIMITS.viewerPublicationAckTimeoutMs
            );
        if (token === this.publicationAckTimerToken) {
            this.publicationAckTimer = handle;
        } else if (this.options.clearTimer) {
            this.options.clearTimer(handle);
        } else {
            clearTimeout(handle as NodeJS.Timeout);
        }
    }

    private clearPublicationAckTimeout(): void {
        this.publicationAckTimerToken += 1;
        const timer = this.publicationAckTimer;
        this.publicationAckTimer = undefined;
        if (timer === undefined) {
            return;
        }
        if (this.options.clearTimer) {
            this.options.clearTimer(timer);
        } else {
            clearTimeout(timer as NodeJS.Timeout);
        }
    }

    private recoverPublication(
        publication: ConversationViewerPageMessage,
        reason: string,
        detail?: Record<string, unknown>
    ): boolean {
        if (!this.isCurrentPublication(publication)
            || this.publicationRecoveryRebuildRequestId === publication.requestId
            || this.publicationRecoveryAttemptRequestId === publication.requestId
            || this.publicationRecoveryGeneration
                === publication.subscriptionGeneration) {
            return false;
        }
        // Delivery rejection, an explicit Webview resync, and an absent
        // applied receipt are competing reports of the same failed page.
        // They share one recovery allowance. Keep it until an applied receipt
        // arrives so streaming updates cannot rebuild the document repeatedly
        // after a persistent Webview failure.
        this.publicationRecoveryRebuildRequestId = publication.requestId;
        this.publicationRecoveryGeneration = publication.subscriptionGeneration;
        this.emitDiagnostic(reason, detail);
        this.rebuildRecoveredPublication(publication);
        return true;
    }

    private reportPublicationApplication(
        publication: ConversationViewerPageMessage
    ): void {
        const timing = this.pendingPublicationTiming;
        if (!timing
            || timing.subscriptionGeneration !== publication.subscriptionGeneration
            || timing.requestId !== publication.requestId
            || timing.htmlSignature !== publication.htmlSignature) {
            return;
        }
        this.pendingPublicationTiming = undefined;
        const now = this.now();
        const loadTiming = this.pendingTargetLoadTiming;
        const loadMs = loadTiming
            && loadTiming.subscriptionGeneration === publication.subscriptionGeneration
            ? Math.max(0, now - loadTiming.startedAt)
            : undefined;
        if (loadMs !== undefined) {
            this.pendingTargetLoadTiming = undefined;
        }
        try {
            this.options.onTiming?.({
                source: loadTiming
                    && loadTiming.subscriptionGeneration === publication.subscriptionGeneration
                    ? loadTiming.source
                    : timing.updateKind,
                updateKind: timing.updateKind,
                delivery: timing.delivery,
                applicationMs: Math.max(0, now - timing.publishedAt),
                contentBytes: timing.contentBytes,
                progressive: timing.progressive,
                ...(loadMs === undefined ? {} : { loadMs }),
            });
        } catch (_error) {
            // Timing must never affect the Conversation lifecycle.
        }
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }

    private postLoadingNotice(
        panel: vscode.WebviewPanel,
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >,
        generation: number,
        preflight = false
    ): void {
        // The notice is cosmetic and must never delay the load. The Webview
        // makes all outgoing controls inert; Host-side transition gating
        // below is the matching defense for any already-queued message.
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
                ...(preflight ? { preflight: true } : {}),
            })).catch(() => undefined);
        } catch (_error) {
            // Best-effort visual state only.
        }
    }

    private cancelPreflightPreview(preview: {
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>;
        subscriptionGeneration: number;
    }): void {
        if (this.preflightPreview !== preview) {
            return;
        }
        this.preflightPreview = undefined;
        this.postLoadingCancel(preview);
    }

    private postLoadingCancel(preview: {
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>;
        subscriptionGeneration: number;
    }): void {
        const panel = this.panel;
        if (!panel) {
            return;
        }
        try {
            void Promise.resolve(panel.webview.postMessage({
                type: 'conversation-viewer-loading-cancel',
                version: 1,
                subscriptionGeneration: preview.subscriptionGeneration,
                target: preview.target,
            })).catch(() => undefined);
        } catch (_error) {
            // Best-effort visual state only.
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

    /**
     * A load claims the request counter before it can know whether it will
     * publish. One that resolves to "nothing changed" replaces nothing, so it
     * must hand the counter back to the publication still on screen —
     * otherwise that publication's own correlated receipts (above all a
     * progressive history slice's) are orphaned by a delivery that never
     * happened, and the Webview's deferred-history placeholder is left with
     * nothing in flight to converge it. Only the counter is restored: the
     * caller has already published nothing.
     */
    private releaseUnpublishedRequestId(
        claimed: number,
        superseded: number
    ): void {
        if (this.currentRequestId !== claimed) {
            // A newer load owns the counter; its delivery is authoritative.
            return;
        }
        if (this.latestPublication?.requestId !== superseded) {
            // Nothing authoritative to restore to, so leaving the claimed id
            // in place keeps every stale receipt correctly rejected.
            return;
        }
        this.currentRequestId = superseded;
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
        outline: ConversationOutline,
        preserveOutOfOutline = true
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
                if (preserveOutOfOutline || outlineIds.has(state.interactionId)) {
                    loadedIds.add(state.interactionId);
                    if (!statesByInteraction.has(state.interactionId)) {
                        statesByInteraction.set(state.interactionId, {
                            ...state,
                        });
                    }
                }
            });
            retained.page.messages.forEach(message => {
                if (!preserveOutOfOutline && !outlineIds.has(message.interactionId)) {
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
        const orderedIds: string[] = [];
        const addOrderedId = (interactionId: string): void => {
            if (loadedIds.has(interactionId) && !orderedIds.includes(interactionId)) {
                orderedIds.push(interactionId);
            }
        };
        if (preserveOutOfOutline) {
            this.pages.forEach(retained => retained.page.interactionStates
                .filter(state => !outlineIds.has(state.interactionId))
                .forEach(state => addOrderedId(state.interactionId)));
        }
        outline.interactions.forEach(interaction => addOrderedId(interaction.id));
        const outlineStates = new Map(outline.interactions.map(interaction => [
            interaction.id,
            interaction,
        ]));
        // Cursors describe the two outer edges only. Interior page cursors
        // are already covered by retained interactions and must never be
        // promoted to a rebuilt edge.
        const oldestRetained = this.pages[0]?.page;
        const newestRetained = this.pages[this.pages.length - 1]?.page;
        // Overlap alone is not enough: an around page can include the last
        // interaction of the oldest retained page while its cursor still
        // starts later. Only an exact outer-boundary match can replace an
        // existing edge cursor.
        const refreshedOldestEdge = oldestRetained?.interactionStates[0]
            ?.interactionId === page.interactionStates[0]?.interactionId;
        const refreshedNewestEdge = newestRetained?.interactionStates[
            newestRetained.interactionStates.length - 1
        ]?.interactionId === page.interactionStates[
            page.interactionStates.length - 1
        ]?.interactionId;
        const hadStart = refreshedOldestEdge
            ? page.isStart
            : (oldestRetained?.isStart ?? page.isStart);
        const hadEnd = refreshedNewestEdge
            ? page.isEnd
            : (newestRetained?.isEnd ?? page.isEnd);
        const previousCursor = refreshedOldestEdge
            ? page.previousCursor
            : (oldestRetained
                ? oldestRetained.previousCursor
                : page.previousCursor);
        const nextCursor = refreshedNewestEdge
            ? page.nextCursor
            : (newestRetained
                ? newestRetained.nextCursor
                : page.nextCursor);
        this.pages = orderedIds.map((interactionId, index) => {
            const retainedState = statesByInteraction.get(interactionId);
            const outlineState = outlineStates.get(interactionId);
            return {
                page: {
                    provider: outline.provider,
                    sessionId: outline.sessionId,
                    sourceRevision: outline.sourceRevision,
                    anchorInteractionId: interactionId,
                    messages: messagesByInteraction.get(interactionId) || [],
                    interactionStates: [{
                        interactionId,
                        responseState: outlineState?.responseState
                            || retainedState?.responseState || 'complete',
                        ...(retainedState?.timestamp !== undefined
                            ? { timestamp: retainedState.timestamp }
                            : {}),
                        ...(retainedState?.completedAt !== undefined
                            ? { completedAt: retainedState.completedAt }
                            : {}),
                    }],
                    isStart: index === 0 && hadStart,
                    isEnd: index === orderedIds.length - 1 && hadEnd,
                    ...(index === 0 && previousCursor !== undefined
                        ? { previousCursor }
                        : {}),
                    ...(index === orderedIds.length - 1 && nextCursor !== undefined
                        ? { nextCursor }
                        : {}),
                },
            };
        });
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
        updateKind: ConversationViewerPageMessage['updateKind'],
        recentOnly = false
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
        const interactionInfo = this.createInteractionInfo();
        const selectedIndex = interactionIds.indexOf(
            projection.selectedInteractionId
        );
        const first = this.pages[0]?.page;
        const last = this.pages[this.pages.length - 1]?.page;
        const allMessages = this.messages();
        const progressivePlan = recentOnly && projection.atLatest
            && !projection.partial
            ? createProgressiveRenderPlan(allMessages, this.showThinking())
            : undefined;
        let deferredMessageCount = progressivePlan
            && shouldProgressivelyRenderPlan(progressivePlan)
            ? progressivePlan.deferredCount
            : 0;
        const render = () => renderMessages(
            deferredMessageCount
                ? allMessages.slice(deferredMessageCount)
                : allMessages,
            this.showThinking(),
            interactionInfo,
            this.renderCache,
            this.contentSignatures,
            this.effectiveSessionId(target),
            deferredMessageCount,
            deferredMessageCount === 0
        );
        let rendered = render();
        // The pre-render plan bounds source text only. Keep dropping complete
        // oldest visible interactions until the generated HTML itself fits
        // the Webview first-paint budget. One oversized latest interaction
        // remains intact: renderMessages has group-level worklog semantics
        // that cannot safely be reconstructed from partial groups.
        // A small source page can still expand past the Webview budget after
        // Markdown rendering. In that case start by hiding the oldest
        // complete group, then use the same exact-HTML loop below. The Host
        // pays one render to discover that expansion, but the Webview avoids
        // the much more visible parse/layout stall.
        if (recentOnly && deferredMessageCount === 0
            && Buffer.byteLength(rendered.html, 'utf8')
                > CONVERSATION_PROGRESSIVE_RENDERED_HTML_BUDGET) {
            const firstDeferredMessageCount = interactionGroupEnd(
                allMessages,
                0
            );
            if (firstDeferredMessageCount < allMessages.length) {
                deferredMessageCount = firstDeferredMessageCount;
                rendered = render();
            }
        }
        while (deferredMessageCount > 0
            && Buffer.byteLength(rendered.html, 'utf8')
                > CONVERSATION_PROGRESSIVE_RENDERED_HTML_BUDGET) {
            const nextDeferredMessageCount = interactionGroupEnd(
                allMessages,
                deferredMessageCount
            );
            if (nextDeferredMessageCount >= allMessages.length) {
                break;
            }
            deferredMessageCount = nextDeferredMessageCount;
            rendered = render();
        }
        // The split describes exactly this publication's render. It is read
        // synchronously by deliverPublication (the only caller path) before
        // anything else can create another publication.
        this.lastPublicationTailSplit = rendered.tailSplit;
        const publication: ConversationViewerPageMessage = {
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
            earlierPageCursor: !first?.isStart
                && first?.previousCursor !== undefined
                ? first.previousCursor
                : undefined,
            nextCursor: (projection.selectedOutsideOutline
                || (selectedIndex >= 0
                    && selectedIndex < interactionIds.length - 1))
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
        if (deferredMessageCount) {
            this.progressiveDeferredMessageCounts.set(
                publication,
                deferredMessageCount
            );
        }
        return publication;
    }

    private canProgressivelyRender(): boolean {
        const projection = this.outlineController.createPublication();
        return projection.atLatest && !projection.partial;
    }

    /**
     * Reattaching the Webview's own detached frame is the cheapest switch
     * there is: no HTML on the wire, no sanitize, no parse, no layout. A
     * progressive publication can never be served that way — its signature
     * describes the partial first paint, not the converged document the frame
     * holds — so a progressive candidate whose session is on the reported
     * frame list renders whole once to find out whether the frame still
     * matches. When it does, that whole publication is the one to deliver and
     * `deliverPublication` turns it into a frame restore. When it does not
     * (the transcript moved on while away), the caller falls back to the
     * progressive first paint and only the Host paid one extra render.
     *
     * Returns undefined whenever the frame cannot serve this content, so the
     * caller keeps its normal publication path.
     */
    private restorableFramePublication(
        requestId: number,
        generation: number,
        updateKind: ConversationViewerPageMessage['updateKind'],
        progressiveCandidate: boolean,
        target: ConversationViewerTarget
    ): ConversationViewerPageMessage | undefined {
        if (!progressiveCandidate) {
            return undefined;
        }
        const token = this.webviewFrames.get(
            conversationFrameTokenKey(target)
        );
        if (token === undefined || token === this.appliedContentSignature) {
            // No reported frame, or the Webview already has this content live
            // and the ordinary delta path is cheaper still.
            return undefined;
        }
        const whole = this.createPublication(requestId, generation, updateKind);
        return whole.htmlSignature === token ? whole : undefined;
    }

    private createInteractionInfo(): Map<string, {
        responseState: ConversationResponseState;
        timestamp?: number;
        completedAt?: number;
    }> {
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
        return interactionInfo;
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
        // A replacement document re-runs the viewer script, which re-posts
        // its capabilities correlated to this fresh identity; forget what
        // the outgoing document advertised.
        this.currentDocumentId = String(++this.documentSerial);
        this.webviewTailPatchCapable = false;
        this.webviewFramePreflightCapable = false;
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
            documentId: this.currentDocumentId,
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

function hasSameConversationSessionTarget(
    left: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>,
    right: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
): boolean {
    return left.projectId === right.projectId
        && left.provider === right.provider
        && left.sessionId === right.sessionId;
}

function hasSameConversationViewerTarget(
    left: ConversationViewerTarget,
    right: ConversationViewerTarget
): boolean {
    return hasSameConversationSessionTarget(left, right)
        && left.workspaceName === right.workspaceName
        && left.interactionId === right.interactionId
        && left.expectedRevision === right.expectedRevision
        && left.displayName === right.displayName
        && left.duplicateDisplayName === right.duplicateDisplayName
        && left.taskName === right.taskName
        && left.subagent?.id === right.subagent?.id
        && left.subagent?.label === right.subagent?.label;
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

function toolIconKind(name: string | undefined): string {
    const normalized = String(name || '').toLowerCase();
    if (/(shell|terminal|command|exec|bash|powershell)/.test(normalized)) {
        return 'terminal';
    }
    if (/(read|open|file)/.test(normalized)) {
        return 'file';
    }
    if (/(write|edit|patch|apply|create|delete)/.test(normalized)) {
        return 'edit';
    }
    if (/(search|find|grep|query)/.test(normalized)) {
        return 'search';
    }
    if (/(git|branch|commit|diff)/.test(normalized)) {
        return 'git';
    }
    if (/(fetch|browse|web|http|url)/.test(normalized)) {
        return 'web';
    }
    return 'tool';
}

function toolIcon(name: string | undefined): string {
    const paths: Record<string, string> = {
        terminal: '<path d="M4 5h16v14H4z"/><path d="m7 9 3 3-3 3M12 15h4"/>',
        file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
        edit: '<path d="m4 16 9-9 3 3-9 9-4 1z"/><path d="m12 6 3 3"/>',
        search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
        git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 6h3a4 4 0 0 1 4 4v6"/><path d="M8 6h10"/>',
        web: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16"/>',
        tool: '<path d="m14.7 6.3 3 3-8.8 8.8-3.8.8.8-3.8z"/><path d="m13 8 3 3"/>',
    };
    return `<svg class="conversation-tool-icon conversation-tool-icon-${toolIconKind(
        name
    )}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[toolIconKind(name)]}</svg>`;
}

function toolLabel(message: ConversationMessage): string {
    const tool = message.tool;
    const name = tool?.name || 'Tool';
    return tool?.summary ? `${name} ${tool.summary}` : name;
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
    const icon = toolIcon(tool?.name);
    const body = tool && (tool.detail || diffsHtml)
        ? `<details class="conversation-tool-call"><summary>${icon}<span class="conversation-tool-name">${name}</span> ${summary}${totalsBadge}</summary>
${diffsHtml}${detailHtml}</details>`
        : `<div class="conversation-tool-call conversation-tool-call-static">${icon}<span class="conversation-tool-name">${name}</span> ${summary}${totalsBadge}</div>`;
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
    return `<article class="conversation-message conversation-message-assistant conversation-message-progress"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <span class="conversation-role">Assistant</span>
    <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
    <section class="conversation-message-actions"><button class="conversation-message-copy" title="Copy response"></button></section>
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

interface ConversationToolGroup {
    id: string;
    firstMessageId: string;
    toolMessageIds: Set<string>;
    latestTool: ConversationMessage;
}

function toolGroups(
    group: readonly ConversationMessage[],
    interactionId: string
): ConversationToolGroup[] {
    const rawGroups: ConversationMessage[][] = [];
    let current: ConversationMessage[] | undefined;
    group.forEach(message => {
        if (message.role !== 'tool') {
            current = undefined;
            return;
        }
        if (!current) {
            current = [];
            rawGroups.push(current);
        }
        current.push(message);
    });
    return rawGroups.map(messages => {
        const firstMessageId = messages[0].id;
        return {
            id: `${interactionId}:tool-group:${firstMessageId}`,
            firstMessageId,
            toolMessageIds: new Set(messages.map(message => message.id)),
            latestTool: messages[messages.length - 1],
        };
    });
}

function renderWorklogRow(
    interactionId: string,
    durationMs?: number
): string {
    const label = durationMs !== undefined
        ? `Worked for ${formatWorkedDuration(durationMs)}`
        : 'Worked';
    const worklogId = `${interactionId}:worklog`;
    return `<article class="conversation-message conversation-message-worklog"
    data-message-id="${escapeAttribute(worklogId)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(worklogId))}"
    data-interaction-id="${escapeAttribute(interactionId)}"
    data-worklog-id="${escapeAttribute(worklogId)}">
    <button class="conversation-worklog-toggle"><span class="conversation-worklog-label">${escapeAttribute(label)}</span></button>
</article>`;
}

function renderToolGroupRow(
    interactionId: string,
    toolGroup: ConversationToolGroup,
    worklogId: string | undefined,
    running: boolean
): string {
    const tool = toolGroup.latestTool.tool;
    const worklogAttribute = worklogId
        ? ` data-worklog-id="${escapeAttribute(worklogId)}"`
        : '';
    const status = running
        ? '<span class="conversation-tool-group-status">Running</span>'
        : '';
    return `<article class="conversation-message conversation-message-tool-group${running
        ? ' conversation-tool-group-running'
        : ''}"
    data-message-id="${escapeAttribute(toolGroup.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(toolGroup.id))}"
    data-interaction-id="${escapeAttribute(interactionId)}"
    data-tool-group-id="${escapeAttribute(toolGroup.id)}"${worklogAttribute}>
    <button class="conversation-tool-group-toggle"><span class="conversation-tool-group-icon">${toolIcon(tool?.name)}</span><span class="conversation-tool-group-label">${escapeAttribute(toolLabel(toolGroup.latestTool))}</span>${status}</button>
</article>`;
}

function renderWorklogEntry(
    html: string,
    worklogId: string | undefined,
    toolGroupId: string | undefined
): string {
    if (!html || (!worklogId && !toolGroupId)) {
        return html;
    }
    const attributes = `${worklogId
        ? `data-worklog-id="${escapeAttribute(worklogId)}" `
        : ''}${toolGroupId
        ? `data-tool-group-id="${escapeAttribute(toolGroupId)}" `
        : ''}`;
    return html.replace(
        '<article ',
        `<article ${attributes}`
    );
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
    /** Present when requested and the render holds more than one group:
     * the trailing interaction group rendered separately, plus the content
     * signature of everything before it. A later publication whose prefix
     * signature still matches can patch just this group on the wire. */
    tailSplit?: {
        prefixSignature: string;
        tailInteractionId: string;
        tailHtml: string;
    };
}

function renderMessages(
    messages: ConversationMessage[],
    showThinking: boolean,
    interactionInfo: Map<string, ConversationInteractionRenderInfo>,
    renderCache: ConversationMessageRenderCache,
    contentSignatures: ConversationContentSignatureRegistry,
    sessionId: string,
    deferredMessageCount = 0,
    withTailSplit = false
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
    let prefixStream: string | undefined;
    const groupHtml = groups.map((group, groupIndex) => {
        if (withTailSplit && groups.length > 1
            && groupIndex === groups.length - 1) {
            prefixStream = contentStream.toString();
        }
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
        const answerIndex = group.findIndex(
            message => message.role === 'assistant'
        );
        const firstWorkIndex = group.findIndex(
            message => isWorklogEntry(message, showThinking)
        );
        const durationMs = info ? worklogDurationMs(info) : undefined;
        const worklogId = info
            && info.responseState !== 'inProgress'
            && answerIndex >= 0
            && firstWorkIndex >= 0
            ? `${group[0].interactionId}:worklog`
            : undefined;
        if (worklogId) {
            contentStream.mix(worklogId).mix(String(durationMs ?? ''));
        }
        const toolGroupByMessageId = new Map<string, ConversationToolGroup>();
        const toolGroupStarts = new Map<string, ConversationToolGroup>();
        const toolGroupsForInteraction = toolGroups(
            group,
            group[0].interactionId
        );
        toolGroupsForInteraction.forEach(toolGroup => {
            toolGroup.toolMessageIds.forEach(messageId => {
                toolGroupByMessageId.set(messageId, toolGroup);
            });
            toolGroupStarts.set(toolGroup.firstMessageId, toolGroup);
            contentStream.mix(toolGroup.id).mix(toolGroup.latestTool.id);
        });
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
            const toolGroup = toolGroupByMessageId.get(message.id);
            const toolGroupStart = toolGroupStarts.get(message.id);
            const isWorklogEntryForTurn = worklogId !== undefined
                && isWorklogEntry(message, showThinking);
            const runningToolGroup = info?.responseState === 'inProgress'
                && toolGroupStart === toolGroupsForInteraction[
                    toolGroupsForInteraction.length - 1
                ];
            return `${message.id === group[firstWorkIndex]?.id && worklogId
                ? renderWorklogRow(
                    group[0].interactionId,
                    durationMs
                )
                : ''}${toolGroupStart
                ? renderToolGroupRow(
                    group[0].interactionId,
                    toolGroupStart,
                    worklogId,
                    runningToolGroup
                )
                : ''}${renderWorklogEntry(
                    entry.html,
                    isWorklogEntryForTurn ? worklogId : undefined,
                    toolGroup?.id
                )}`;
        });
        return rendered.join('');
    });
    const html = groupHtml.join('');
    const tailInteractionId = groups[groups.length - 1]?.[0]?.interactionId;
    return {
        html: deferredMessageCount
            ? `<section class="conversation-deferred-messages">Loading earlier messages…</section>${html}`
            : html,
        contentSignature: contentSignatures.tokenFor(
            `${deferredMessageCount}\u0001${contentStream.toString()}`
        ),
        tailSplit: prefixStream !== undefined && tailInteractionId
            && groupHtml[groupHtml.length - 1].length > 0
            ? {
                prefixSignature: contentSignatures.tokenFor(
                    `0\u0001${prefixStream}`
                ),
                tailInteractionId,
                tailHtml: groupHtml[groupHtml.length - 1],
            }
            : undefined,
    };
}

const CONVERSATION_PROGRESSIVE_RENDER_THRESHOLD = 24;
const CONVERSATION_PROGRESSIVE_RENDER_RECENT_COUNT = 12;
// A single page can contain only a few messages yet still be expensive to
// parse and lay out (for example, a tool result or a long reasoning turn).
// In that case rendering the most recent conversational window first is a
// material first-paint win even when the deferred history is small.
const CONVERSATION_PROGRESSIVE_RENDER_BYTES_THRESHOLD = 96 * 1024;
// The first visible window deliberately has its own smaller byte budget.
// Keeping the newest complete interaction group is more useful than an
// arbitrary character truncation, while capping adjacent older groups keeps
// a heavy page from monopolising the Webview main thread before first paint.
const CONVERSATION_PROGRESSIVE_RECENT_BYTES_BUDGET = 64 * 1024;
// Source bytes are only a cheap pre-render heuristic: Markdown decoration
// can expand code and structured tool output substantially. The actual HTML
// sent to the Webview is tightened to this same budget before publication.
const CONVERSATION_PROGRESSIVE_RENDERED_HTML_BUDGET = 64 * 1024;
// Backfill slices above the visible recent window. Small deferred windows
// are cheaper to deliver as one full refresh; larger ones arrive in
// ack-paced slices so no single Webview task renders the whole history.
const CONVERSATION_PROGRESSIVE_CHUNK_SIZE = 24;
const CONVERSATION_PROGRESSIVE_CHUNK_MIN_DEFERRED = 48;

interface ConversationProgressiveRenderPlan {
    deferredCount: number;
    renderedBytes: number;
}

function createProgressiveRenderPlan(
    messages: readonly ConversationMessage[],
    showThinking: boolean
): ConversationProgressiveRenderPlan {
    const messageBytes = messages.map(message =>
        renderedConversationMessageBytes(message, showThinking)
    );
    const totalBytes = messageBytes.reduce((total, bytes) => total + bytes, 0);
    const visibleMessageCount = messageBytes.filter(bytes => bytes > 0).length;
    if (visibleMessageCount <= CONVERSATION_PROGRESSIVE_RENDER_THRESHOLD
        && totalBytes < CONVERSATION_PROGRESSIVE_RENDER_BYTES_THRESHOLD) {
        return { deferredCount: 0, renderedBytes: totalBytes };
    }
    // Do not split one interaction's message group (tool/progress/thinking
    // entries can precede its final assistant response).
    let firstVisible = interactionGroupStart(messages, Math.max(
        0,
        messages.length - CONVERSATION_PROGRESSIVE_RENDER_RECENT_COUNT
    ));
    if (totalBytes >= CONVERSATION_PROGRESSIVE_RENDER_BYTES_THRESHOLD) {
        let visibleBytes = 0;
        let byteBoundedStart = messages.length;
        while (byteBoundedStart > 0) {
            const groupStart = interactionGroupStart(
                messages,
                byteBoundedStart - 1
            );
            const groupBytes = sumMessageBytes(
                messageBytes,
                groupStart,
                byteBoundedStart
            );
            // Always retain the latest complete interaction group, even if
            // that one group exceeds the budget. It is the selected/latest
            // conversational context and cannot be split safely here.
            if (byteBoundedStart !== messages.length
                && visibleBytes + groupBytes
                    > CONVERSATION_PROGRESSIVE_RECENT_BYTES_BUDGET) {
                break;
            }
            visibleBytes += groupBytes;
            byteBoundedStart = groupStart;
        }
        firstVisible = Math.max(firstVisible, byteBoundedStart);
    }
    return {
        deferredCount: firstVisible,
        renderedBytes: totalBytes,
    };
}

function interactionGroupStart(
    messages: readonly ConversationMessage[],
    index: number
): number {
    let start = index;
    const interactionId = messages[start]?.interactionId;
    while (start > 0 && messages[start - 1].interactionId === interactionId) {
        start -= 1;
    }
    return start;
}

function interactionGroupEnd(
    messages: readonly ConversationMessage[],
    start: number
): number {
    const interactionId = messages[start]?.interactionId;
    let end = start + 1;
    while (end < messages.length
        && messages[end].interactionId === interactionId) {
        end += 1;
    }
    return end;
}

function renderedConversationMessageBytes(
    message: ConversationMessage,
    showThinking: boolean
): number {
    if (message.role === 'thinking' && !showThinking) {
        return 0;
    }
    // This intentionally estimates the rendered source instead of
    // serialising the full message array. It keeps heavy hidden Thinking
    // payloads out of the decision and avoids a multi-megabyte temporary
    // allocation on the first-paint critical path.
    return Buffer.byteLength(
        `${message.id}\u0001${message.interactionId}\u0001${message.role}\u0001${message.markdown}`,
        'utf8'
    ) + optionalStructuredBytes(message.tool)
        + optionalStructuredBytes(message.thinking)
        + optionalStructuredBytes(message.plan)
        + optionalStructuredBytes(message.question);
}

function optionalStructuredBytes(value: unknown): number {
    return value === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sumMessageBytes(
    messageBytes: readonly number[],
    start: number,
    end: number
): number {
    let total = 0;
    for (let index = start; index < end; index++) {
        total += messageBytes[index] || 0;
    }
    return total;
}

function shouldProgressivelyRenderPlan(
    plan: ConversationProgressiveRenderPlan
): boolean {
    return plan.deferredCount > CONVERSATION_PROGRESSIVE_CHUNK_MIN_DEFERRED
        || plan.renderedBytes >= CONVERSATION_PROGRESSIVE_RENDER_BYTES_THRESHOLD;
}
