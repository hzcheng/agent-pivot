'use strict';

import { URL } from 'url';
import * as vscode from 'vscode';
import { AGENT_PIVOT_CONVERSATION_VIEW_TYPE } from '../../constants';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';
import type { ConversationCommentStore } from './commentStore';
import type { ConversationBookmarkStore } from './bookmarkStore';
import { ConversationCommentController } from './commentController';
import { ConversationBookmarkController } from './bookmarkController';
import { ConversationTelemetryController } from './conversationTelemetryController';
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
import type { ConversationSessionSwitchDirection } from './viewerProtocol';
import type { ConversationViewerTarget } from './viewerTarget';
export type { ConversationViewerTarget } from './viewerTarget';
import { truncateGraphemes } from './text';
import {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationAbortSignal,
    ConversationError,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationSubagentEntry,
    ConversationTelemetry,
} from './types';
import { encodeSubagentSessionId } from './subagentSessions';

export interface ConversationViewerOptions {
    createPanel: typeof vscode.window.createWebviewPanel;
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
    bookmarkStore?: ConversationBookmarkStore;
    showWorktreeInSourceControl?: (
        worktreeRoot: string
    ) => PromiseLike<void> | Promise<void> | void;
    insertIntoActiveTerminal?: (
        text: string
    ) => PromiseLike<void> | Promise<void> | void;
    followAdjacentConversation?: (
        direction: ConversationSessionSwitchDirection,
        currentTarget: ConversationViewerTarget
    ) => PromiseLike<unknown> | Promise<unknown> | void;
    setKeyboardFocus?: (
        focused: boolean
    ) => PromiseLike<void> | Promise<void> | void;
}

export interface ConversationViewerApi extends AiSessionDisposable {
    isOpen(): boolean;
    focus(): boolean;
    getCurrentTarget(): ConversationViewerTarget | undefined;
    getFocusedTarget(): ConversationViewerTarget | undefined;
    getFocusedSessionTarget(): Pick<
        ConversationViewerTarget,
        'projectId' | 'provider' | 'sessionId'
    > | undefined;
    open(target: ConversationViewerTarget): Promise<void>;
    restore(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget
    ): Promise<void>;
    follow(target: ConversationViewerTarget): Promise<boolean>;
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
    refresh(): Promise<void>;
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
}

interface RetainedConversationPage {
    page: ConversationPage;
}

export interface ConversationViewerPageMessage {
    type: 'conversation-viewer-page';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    updateKind: 'initial' | 'navigation' | 'refresh';
    html: string;
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
    private subagents: ConversationSubagentEntry[] = [];
    private mainInteractionId?: string;
    private subscriptionGeneration = 0;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private currentRequestId = 0;
    private stale = false;
    private latestPublication?: ConversationViewerPageMessage;
    private panelWasVisible = false;
    private suspended = false;
    private rebindGeneration = 0;
    private authoritativeLoadInFlight?: Promise<boolean>;
    private authoritativeRefreshPending = false;
    private keyboardFocused = false;
    private readonly commentController: ConversationCommentController;
    private readonly bookmarkController: ConversationBookmarkController;
    private readonly outlineController = new ConversationOutlineController();
    private readonly telemetryController: ConversationTelemetryController;

    constructor(private readonly options: ConversationViewerOptions) {
        this.telemetryController = new ConversationTelemetryController({
            readTelemetry: options.readTelemetry,
            getPanel: () => this.panel,
            getTarget: () => this.target,
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

    async open(target: ConversationViewerTarget): Promise<void> {
        await this.loadTarget(target, true);
    }

    async restore(
        panel: vscode.WebviewPanel,
        target: ConversationViewerTarget
    ): Promise<void> {
        if (this.panel && this.panel !== panel) {
            panel.dispose();
            return;
        }
        panel.webview.options = this.webviewOptions();
        this.attachPanel(panel);
        await this.loadTarget(target, false);
    }

    async follow(target: ConversationViewerTarget): Promise<boolean> {
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
        return this.loadTarget(target, false);
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
        try {
            const rebindRead = new ConversationAbortController();
            outline = await this.options.readOutline(
                next.provider,
                next.sessionId,
                rebindRead.signal
            );
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
        }, false);
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
        reveal: boolean
    ): Promise<boolean> {
        const followedPanel = reveal ? undefined : this.panel;
        const generation = this.replaceTarget(target);
        const activeTarget = this.target;
        if (!activeTarget) {
            return false;
        }
        await Promise.all([
            this.commentController.restore(activeTarget, generation),
            this.bookmarkController.restore(activeTarget, generation),
        ]);
        if (this.target !== activeTarget
            || this.subscriptionGeneration !== generation) {
            return false;
        }
        const panel = reveal ? this.ensurePanel() : this.panel;
        if (!panel || (!reveal && panel !== followedPanel)) {
            return false;
        }
        panel.title = 'AI Conversation';
        if (reveal) {
            panel.reveal(vscode.ViewColumn.Active);
        }
        panel.webview.html = this.renderDocument(undefined, 'Loading conversation…');
        this.ensureWatch(generation);
        return this.loadAuthoritative('initial', true);
    }

    async refresh(): Promise<void> {
        const target = this.target;
        if (!target || !this.panel || this.suspended) {
            return;
        }
        await this.loadAuthoritative('refresh', false);
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
            metadataChanged = target.displayName !== displayName
                || target.duplicateDisplayName
                    !== authority.duplicateDisplayName;
            target.displayName = displayName;
            target.duplicateDisplayName = authority.duplicateDisplayName;
        }
        const wasSuspended = this.suspended;
        if (wasSuspended
            && !this.ensureWatch(this.subscriptionGeneration, true)) {
            return;
        }
        this.suspended = false;
        await this.refresh();
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

    private replaceTarget(target: ConversationViewerTarget): number {
        this.authoritativeLoadInFlight = undefined;
        this.authoritativeRefreshPending = false;
        this.abortController?.abort();
        this.abortController = undefined;
        this.watch?.dispose();
        this.watch = undefined;
        this.pages = [];
        this.subagents = [];
        this.outlineController.reset(target.interactionId);
        this.stale = false;
        this.telemetryController.reset();
        this.latestPublication = undefined;
        this.commentController.reset();
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

    private webviewOptions(): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [this.options.mediaUri('')],
        };
    }

    private attachPanel(panel: vscode.WebviewPanel): void {
        if (this.panel === panel) {
            return;
        }
        this.panel = panel;
        this.publishKeyboardFocus(false, true);
        this.panelWasVisible = panel.visible;
        this.messageListener = panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message)
        );
        this.viewStateListener = panel.onDidChangeViewState(event => {
            if (this.panel !== panel || event.webviewPanel !== panel) {
                return;
            }
            const becameVisible = !this.panelWasVisible && panel.visible;
            this.panelWasVisible = panel.visible;
            if (!panel.active) {
                this.publishKeyboardFocus(false);
            }
            if (becameVisible) {
                this.rebuildLatestDocument();
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
        this.outlineController.reset();
        this.target = undefined;
        this.stale = false;
        this.telemetryController.reset();
        this.latestPublication = undefined;
        this.commentController.reset();
        this.bookmarkController.reset();
        this.panelWasVisible = false;
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
        if (parsed.type === 'conversation-viewer-open-worktree') {
            await this.options.showWorktreeInSourceControl?.(
                parsed.worktreeRoot
            );
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
        if (parsed.type === 'conversation-viewer-comment-mutation'
            || parsed.type === 'conversation-viewer-send-comments') {
            await this.commentController.enqueue(parsed);
            return;
        }
        if (parsed.type === 'conversation-viewer-bookmark-mutation') {
            await this.bookmarkController.enqueue(parsed);
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
        this.bookmarkController.reset();
        this.target = { ...target };
        this.suspended = false;
        this.currentRequestId = 0;
        const generation = this.subscriptionGeneration;
        const activeTarget = this.target;
        await Promise.all([
            this.commentController.restore(activeTarget, generation),
            this.bookmarkController.restore(activeTarget, generation),
        ]);
        if (this.target !== activeTarget
            || this.subscriptionGeneration !== generation) {
            return;
        }
        this.ensureWatch(generation);
        await this.loadAuthoritative('initial', false);
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

    private async navigateLatest(): Promise<void> {
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
        replaceDocument: boolean
    ): Promise<boolean> {
        if (this.authoritativeLoadInFlight) {
            this.authoritativeRefreshPending = true;
            return this.authoritativeLoadInFlight;
        }
        let loadInFlight: Promise<boolean>;
        loadInFlight = this.performAuthoritativeLoad(
            updateKind,
            replaceDocument
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
            void this.loadAuthoritative('refresh', false);
        });
        this.authoritativeLoadInFlight = loadInFlight;
        return loadInFlight;
    }

    private async performAuthoritativeLoad(
        updateKind: 'initial' | 'refresh',
        replaceDocument: boolean
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
        const requestId = this.allocateRequestId();
        this.currentRequestId = requestId;
        const previousSelectedInteractionId = this.outlineController.selection;
        try {
            let outline = await this.options.readOutline(
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
            if (updateKind === 'initial'
                && !interactionIds.includes(target.interactionId)) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (updateKind === 'refresh'
                && (!previousSelectedInteractionId
                    || !interactionIds.includes(previousSelectedInteractionId))) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            const selectedInteractionId = updateKind === 'initial'
                ? target.interactionId
                : previousSelectedInteractionId as string;
            const retainedOutline = this.outlineController.snapshot;
            if (updateKind === 'refresh'
                && !this.stale
                && retainedOutline?.sourceRevision
                    === outline.sourceRevision) {
                const sameInteractionIds = retainedOutline.interactions.length
                    === outline.interactions.length
                    && outline.interactions.every((interaction, index) =>
                        retainedOutline.interactions[index].id
                            === interaction.id
                    );
                const lifecycleChanged = sameInteractionIds
                    && outline.interactions.some((interaction, index) =>
                        retainedOutline.interactions[index].responseState
                            !== interaction.responseState
                    );
                if (lifecycleChanged
                    && this.outlineController.replace(
                        outline,
                        selectedInteractionId
                    )) {
                    await this.deliverPublication(this.createPublication(
                        requestId,
                        generation,
                        updateKind
                    ), replaceDocument);
                }
                void this.telemetryController.refresh(
                    target,
                    generation,
                    this.effectiveSessionId(target)
                );
                return true;
            }
            let page: ConversationPage;
            try {
                page = await this.options.readPage({
                    provider: target.provider,
                    sessionId: this.effectiveSessionId(target),
                    anchorInteractionId: selectedInteractionId,
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
                if (!outline.interactions.some(
                    interaction => interaction.id === selectedInteractionId
                )) {
                    await this.publishFailure(replaceDocument, updateKind);
                    return false;
                }
                page = await this.options.readPage({
                    provider: target.provider,
                    sessionId: this.effectiveSessionId(target),
                    anchorInteractionId: selectedInteractionId,
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
                || page.sourceRevision !== outline.sourceRevision) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            if (!this.outlineController.replace(
                outline,
                page.anchorInteractionId
            )) {
                await this.publishFailure(replaceDocument, updateKind);
                return false;
            }
            this.stale = false;
            if (updateKind === 'refresh') {
                this.mergeRefreshPage(page, outline);
            } else {
                this.retain(page, 'replace');
            }
            this.subagents = await this.readSubagentsSafely(target);
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            const publication = this.createPublication(
                requestId,
                generation,
                updateKind
            );
            await this.deliverPublication(publication, replaceDocument);
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
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(publication);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered && this.isCurrentPublication(publication)) {
            this.rebuildLatestDocument();
        }
    }

    private rebuildLatestDocument(): void {
        const panel = this.panel;
        const publication = this.latestPublication;
        if (!panel || !publication || !this.isCurrentPublication(publication)) {
            return;
        }
        panel.webview.html = this.renderDocument(publication);
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
        this.pages.forEach(retained => {
            retained.page.interactionStates.forEach(state => {
                if (outlineIds.has(state.interactionId)) {
                    loadedIds.add(state.interactionId);
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
            messagesByInteraction.set(state.interactionId, []);
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
        while (this.pages.length > 1
            && (this.snapshotSize > CONVERSATION_LIMITS.maxViewerInteractions
                || this.snapshotBytes() > CONVERSATION_LIMITS.maxViewerBytes)) {
            const targetId = this.outlineController.selection;
            const anchorPage = this.pages.findIndex(retained =>
                retained.page.interactionStates.some(
                    state => state.interactionId === targetId
                ));
            if (anchorPage < 0) {
                this.pages.pop();
                continue;
            }
            const distanceBefore = anchorPage;
            const distanceAfter = this.pages.length - 1 - anchorPage;
            if (distanceAfter >= distanceBefore && anchorPage
                !== this.pages.length - 1) {
                this.pages.pop();
            } else if (anchorPage !== 0) {
                this.pages.shift();
            } else {
                break;
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
        const selectedIndex = interactionIds.indexOf(
            projection.selectedInteractionId
        );
        const first = this.pages[0]?.page;
        const last = this.pages[this.pages.length - 1]?.page;
        return {
            type: 'conversation-viewer-page',
            version: 1,
            requestId,
            subscriptionGeneration: generation,
            updateKind,
            html: renderMessages(this.messages(), this.showThinking()),
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
            bookmarkSnapshot: this.bookmarkController.snapshot,
            telemetrySnapshot: this.telemetryController.snapshot,
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
    return {
        id: message.id,
        interactionId: message.interactionId,
        role: message.role,
        timestamp: message.timestamp,
        markdown: message.markdown,
        ...(message.tool
            ? {
                tool: {
                    name: message.tool.name,
                    summary: message.tool.summary,
                    ...(message.tool.detail !== undefined
                        ? { detail: message.tool.detail }
                        : {}),
                },
            }
            : {}),
        ...(message.thinking
            ? { thinking: { text: message.thinking.text } }
            : {}),
    };
}

function renderToolMessage(message: ConversationMessage): string {
    const tool = message.tool;
    const summary = tool ? escapeAttribute(tool.summary) : '';
    const name = tool ? escapeAttribute(tool.name) : '';
    const body = tool?.detail
        ? `<details class="conversation-tool-call"><summary><span class="conversation-tool-name">${name}</span> ${summary}</summary>
<pre class="conversation-tool-detail"><code>${escapeAttribute(tool.detail)}</code></pre></details>`
        : `<div class="conversation-tool-call conversation-tool-call-static"><span class="conversation-tool-name">${name}</span> ${summary}</div>`;
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

function renderMessages(
    messages: ConversationMessage[],
    showThinking: boolean
): string {
    return messages.map(message => {
        if (message.role === 'tool') {
            return renderToolMessage(message);
        }
        if (message.role === 'thinking') {
            return showThinking ? renderThinkingMessage(message) : '';
        }
        if (message.role === 'progress') {
            return renderProgressMessage(message);
        }
        return `<article class="conversation-message conversation-message-${message.role}"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <span class="conversation-role">${message.role === 'user' ? 'User' : 'Assistant'}</span>
    <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
</article>`;
    }).join('');
}
