'use strict';

import { randomBytes } from 'crypto';
import { URL } from 'url';
import * as vscode from 'vscode';
import { AGENT_PIVOT_CONVERSATION_VIEW_TYPE } from '../../constants';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';
import { CONVERSATION_COMMENT_LIMITS } from './comments';
import type { ConversationCommentStore } from './commentStore';
import type { ConversationBookmarkStore } from './bookmarkStore';
import { ConversationCommentController } from './commentController';
import { ConversationBookmarkController } from './bookmarkController';
import {
    ConversationTelemetryController,
    renderConversationTelemetry,
} from './conversationTelemetryController';
import {
    ConversationOutlineController,
    ConversationViewerOutlineEntry,
} from './outlineController';
import { renderConversationMarkdown } from './markdown';
import { parseConversationViewerMessage } from './viewerProtocol';
import type { ConversationViewerTarget } from './viewerTarget';
export type { ConversationViewerTarget } from './viewerTarget';
import {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationAbortSignal,
    ConversationError,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationTelemetry,
} from './types';

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
    mediaUri: (fileName: string) => vscode.Uri;
    submitPrompt: (
        target: ConversationViewerTarget,
        prompt: string
    ) => PromiseLike<void> | Promise<void>;
    focusSession?: (
        target: Pick<
            ConversationViewerTarget,
            'projectId' | 'provider' | 'sessionId'
        >
    ) => PromiseLike<void> | Promise<void>;
    commentStore?: ConversationCommentStore;
    bookmarkStore?: ConversationBookmarkStore;
}

export interface ConversationViewerApi extends AiSessionDisposable {
    isOpen(): boolean;
    open(target: ConversationViewerTarget): Promise<void>;
    follow(target: ConversationViewerTarget): Promise<boolean>;
    refresh(): Promise<void>;
    reconcileAuthority(
        resolveAuthority: (target: ConversationViewerTarget) => boolean
    ): Promise<void>;
}

interface RetainedConversationPage {
    page: ConversationPage;
}

interface ConversationViewerPageMessage {
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
    private subscriptionGeneration = 0;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private currentRequestId = 0;
    private stale = false;
    private latestPublication?: ConversationViewerPageMessage;
    private panelWasVisible = false;
    private suspended = false;
    private authoritativeLoadInFlight?: Promise<boolean>;
    private authoritativeRefreshPending = false;
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
            focusSession: options.focusSession,
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

    async open(target: ConversationViewerTarget): Promise<void> {
        await this.loadTarget(target, true);
    }

    async follow(target: ConversationViewerTarget): Promise<boolean> {
        if (!this.panel) {
            return false;
        }
        return this.loadTarget(target, false);
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
        await this.loadAuthoritative('initial', true);
        return true;
    }

    async refresh(): Promise<void> {
        const target = this.target;
        if (!target || !this.panel || this.suspended) {
            return;
        }
        await this.loadAuthoritative('refresh', false);
    }

    async reconcileAuthority(
        resolveAuthority: (target: ConversationViewerTarget) => boolean
    ): Promise<void> {
        const target = this.target;
        const panel = this.panel;
        if (!target || !panel) {
            return;
        }
        let available = false;
        try {
            available = resolveAuthority({ ...target }) === true;
        } catch (_error) {
            available = false;
        }
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
        const wasSuspended = this.suspended;
        if (wasSuspended
            && !this.ensureWatch(this.subscriptionGeneration, true)) {
            return;
        }
        this.suspended = false;
        await this.refresh();
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
        this.outlineController.reset(target.interactionId);
        this.stale = false;
        this.telemetryController.reset();
        this.latestPublication = undefined;
        this.commentController.reset();
        this.bookmarkController.reset();
        this.target = { ...target };
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
            {
                enableScripts: true,
                localResourceRoots: [this.options.mediaUri('')],
            }
        );
        this.panel = panel;
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
        return panel;
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
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.currentRequestId = 0;
    }

    private async handleMessage(message: unknown): Promise<void> {
        const parsed = parseConversationViewerMessage(message);
        if (!parsed || !this.target || !this.panel) {
            return;
        }
        if (parsed.type === 'conversation-viewer-closed') {
            this.panel.dispose();
            return;
        }
        if (parsed.type === 'conversation-viewer-open-link') {
            await this.openLink(parsed.href);
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

    private async openLink(href: string): Promise<void> {
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
                sessionId: target.sessionId,
                anchorInteractionId: nextInteractionId,
                direction: 'around',
                expectedRevision: outline.sourceRevision,
                limit: CONVERSATION_LIMITS.maxPageInteractions,
            }, 'replace', false, 'navigation', nextInteractionId);
        }
        return this.read({
            provider: target.provider,
            sessionId: target.sessionId,
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
            sessionId: target.sessionId,
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
            sessionId: target.sessionId,
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
                target.sessionId,
                abortController.signal
            );
            if (!this.canPublish(panel, target, generation, requestId)) {
                return false;
            }
            if (outline.provider !== target.provider
                || outline.sessionId !== target.sessionId
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
            if (updateKind === 'refresh'
                && !this.stale
                && this.outlineController.snapshot?.sourceRevision
                    === outline.sourceRevision) {
                void this.telemetryController.refresh(target, generation);
                return true;
            }
            let page: ConversationPage;
            try {
                page = await this.options.readPage({
                    provider: target.provider,
                    sessionId: target.sessionId,
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
                    target.sessionId,
                    abortController.signal
                );
                if (!this.canPublish(panel, target, generation, requestId)) {
                    return false;
                }
                if (outline.provider !== target.provider
                    || outline.sessionId !== target.sessionId
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
                    sessionId: target.sessionId,
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
                || page.sessionId !== target.sessionId
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
            const publication = this.createPublication(
                requestId,
                generation,
                updateKind
            );
            await this.deliverPublication(publication, replaceDocument);
            void this.telemetryController.refresh(target, generation);
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
                    target.sessionId,
                    abortController.signal
                );
                if (!this.canPublish(panel, target, generation, requestId)) {
                    return false;
                }
                if (outline.provider !== target.provider
                    || outline.sessionId !== target.sessionId
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
                    sessionId: target.sessionId,
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
                || page.sessionId !== target.sessionId
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
                target.sessionId,
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
            html: renderMessages(this.messages()),
            ...projection,
            previousCursor: selectedIndex > 0
                ? first?.previousCursor || ''
                : undefined,
            nextCursor: selectedIndex >= 0
                && selectedIndex < interactionIds.length - 1
                ? last?.nextCursor || ''
                : undefined,
            stale: this.stale,
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
        const nonce = randomBytes(16).toString('base64');
        const stylesheet = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationViewer.css')
        );
        const telemetryStylesheet = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationTelemetry.css')
        );
        const purify = panel.webview.asWebviewUri(
            this.options.mediaUri('purify.min.js')
        );
        const mermaid = panel.webview.asWebviewUri(
            this.options.mediaUri('mermaid.min.js')
        );
        const readingAnchorScript = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationReadingAnchorScripts.js')
        );
        const mermaidScript = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationMermaidScripts.js')
        );
        const outlineScript = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationOutlineScripts.js')
        );
        const telemetryScript = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationTelemetryScripts.js')
        );
        const commentsScript = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationCommentsScripts.js')
        );
        const script = panel.webview.asWebviewUri(
            this.options.mediaUri('conversationViewerScripts.js')
        );
        const duplicateId = target.duplicateDisplayName
            ? ` · ${target.sessionId.toLocaleLowerCase().slice(0, 8)}`
            : '';
        const initialPageAttribute = initialPage
            ? ` data-initial-page="${escapeAttribute(JSON.stringify(initialPage))}"`
            : '';
        const commentStateAttribute = ` data-initial-comments="${escapeAttribute(
            JSON.stringify(this.commentController.snapshot)
        )}"`;
        const bookmarkStateAttribute = ` data-initial-bookmarks="${escapeAttribute(
            JSON.stringify(this.bookmarkController.snapshot)
        )}"`;
        const targetAttribute = ` data-conversation-target="${escapeAttribute(
            JSON.stringify({
                projectId: target.projectId,
                provider: target.provider,
                sessionId: target.sessionId,
            })
        )}"`;
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src https: blob:; style-src ${escapeAttribute(
            panel.webview.cspSource
        )}; script-src 'nonce-${escapeAttribute(nonce)}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeAttribute(stylesheet.toString())}">
    <link rel="stylesheet"
        href="${escapeAttribute(telemetryStylesheet.toString())}">
    <title>AI Conversation</title>
</head>
<body data-auto-scroll-threshold="${CONVERSATION_LIMITS.autoScrollThresholdPx}"
    data-mermaid-src="${escapeAttribute(mermaid.toString())}"
    data-subscription-generation="${this.subscriptionGeneration}"${initialPageAttribute}${commentStateAttribute}${bookmarkStateAttribute}${targetAttribute}>
    <header class="conversation-header">
        <div class="conversation-identity">
            <strong>${escapeHtml(providerLabel(target.provider))}</strong>
            <span>${escapeHtml(target.displayName + duplicateId)}</span>
        </div>
        <span data-conversation-position>Input 0 of 0</span>
        <nav class="conversation-navigation" aria-label="Conversation navigation">
            <button type="button" data-action="previous">Previous</button>
            <button type="button" data-action="next">Next</button>
            <button type="button" data-action="latest">Latest</button>
            <button type="button" data-action="toggle-outline"
                aria-controls="conversation-sidebar"
                aria-expanded="true">Outline (0)</button>
            <button type="button" data-action="toggle-comments"
                aria-controls="conversation-sidebar"
                aria-expanded="false">Comments (0)</button>
            <button type="button" data-action="close">Close</button>
        </nav>
    </header>
    ${renderConversationTelemetry(this.telemetryController.snapshot)}
    <div class="conversation-status" data-conversation-status aria-live="polite">${escapeHtml(
        initialStatus
    )}</div>
    <div class="conversation-workspace">
        <main class="conversation-scroll" data-conversation-scroll tabindex="0">
            <div class="conversation-messages" data-conversation-messages></div>
        </main>
        <div class="conversation-comments-resizer" data-comments-resizer
            role="separator" aria-label="Resize side panel"
            aria-orientation="vertical" aria-valuemin="192"
            aria-valuemax="420" aria-valuenow="240" tabindex="0"></div>
        <aside id="conversation-sidebar"
            class="conversation-sidebar" data-conversation-sidebar
            aria-label="Conversation side panel">
            <div class="conversation-sidebar-tabs" role="tablist"
                aria-label="Conversation side panel">
                <button type="button" role="tab" data-sidebar-tab="outline"
                    id="conversation-outline-tab"
                    aria-controls="conversation-outline-panel"
                    aria-selected="true">Outline</button>
                <button type="button" role="tab" data-sidebar-tab="comments"
                    id="conversation-comments-tab"
                    aria-controls="conversation-comments-panel"
                    aria-selected="false">Comments</button>
                <button type="button" class="conversation-sidebar-close"
                    data-sidebar-close aria-label="Close side panel"
                    title="Close side panel">×</button>
            </div>
            <section id="conversation-outline-panel"
                class="conversation-outline" data-conversation-outline
                role="tabpanel" aria-labelledby="conversation-outline-tab">
                <div class="conversation-outline-header">
                    <div>
                        <strong>Conversation outline</strong>
                        <span data-outline-summary>No inputs yet</span>
                    </div>
                    <span data-outline-count aria-label="0 inputs">0</span>
                </div>
                <label class="conversation-outline-search-label"
                    for="conversation-outline-search">Search inputs</label>
                <input id="conversation-outline-search" type="search"
                    data-outline-search placeholder="Search user inputs">
                <button type="button" class="conversation-outline-bookmarks-only"
                    data-outline-bookmarks-only aria-pressed="false">
                    ☆ Bookmarks
                </button>
                <p class="conversation-outline-partial"
                    data-outline-partial hidden>
                    Showing the newest inputs available in this Session.
                </p>
                <ol class="conversation-outline-list"
                    data-outline-list></ol>
                <p class="conversation-outline-empty"
                    data-outline-empty hidden>No inputs match this search.</p>
            </section>
            <section id="conversation-comments-panel"
                class="conversation-comments" data-conversation-comments
                role="tabpanel" aria-labelledby="conversation-comments-tab"
                hidden>
                <div class="conversation-comments-header">
                    <div class="conversation-comments-heading">
                        <strong>Review comments</strong>
                        <span data-comment-summary>No comments yet</span>
                    </div>
                    <div class="conversation-comments-header-actions">
                        <button type="button" data-comment-action="new"
                            title="Add a note about this Session">+ Note</button>
                        <span data-comment-count aria-label="0 comments">0</span>
                    </div>
                </div>
                <div class="conversation-comment-composer"
                    data-comment-composer hidden>
                    <blockquote data-comment-selection></blockquote>
                    <label for="conversation-comment-input">Comment</label>
                    <textarea id="conversation-comment-input" data-comment-input
                        rows="3" maxlength="${CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes}"
                        aria-keyshortcuts="Control+Enter Meta+Enter"
                        placeholder="What should the AI address?"></textarea>
                    <div class="conversation-comment-actions">
                        <button type="button"
                            data-comment-action="cancel-add">Cancel</button>
                        <button type="button"
                            data-comment-action="confirm-add"
                            title="Add comment (Ctrl+Enter or Cmd+Enter)">Add comment</button>
                    </div>
                </div>
                <div class="conversation-comment-list"
                    data-comment-list></div>
                <p class="conversation-comment-empty" data-comment-empty>
                    Select text to comment on it, or add a Session note.
                </p>
                <div class="conversation-comments-toolbar"
                    data-comments-toolbar role="group"
                    aria-label="Comment actions">
                    <button class="conversation-comments-clear" type="button"
                        data-comment-action="clearSent"
                        title="Clear comments added to the session input"
                        disabled>Clear added</button>
                    <button class="conversation-comments-clear" type="button"
                        data-comment-action="clearResolved"
                        title="Clear resolved comments"
                        disabled>Clear resolved</button>
                    <button class="conversation-comments-clear conversation-comments-clear-all"
                        type="button" data-comment-action="clearAll"
                        title="Clear all comments" disabled>Clear all</button>
                    <button class="conversation-comments-send" type="button"
                        data-comment-action="send" disabled
                        title="Add open comments to the session input">Add open comments to session input</button>
                </div>
            </section>
        </aside>
    </div>
    <button class="conversation-add-comment" type="button"
        data-add-comment hidden>Add comment</button>
    <button class="new-response" type="button" data-new-response hidden>New response content</button>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        purify.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        readingAnchorScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        mermaidScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        outlineScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        telemetryScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        commentsScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        script.toString()
    )}"></script>
</body>
</html>`;
    }
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
    };
}

function renderMessages(messages: ConversationMessage[]): string {
    return messages.map(message => `<article class="conversation-message conversation-message-${message.role}"
    data-message-id="${escapeAttribute(message.id)}"
    data-conversation-message-id="${escapeAttribute(encodeURIComponent(message.id))}"
    data-interaction-id="${escapeAttribute(message.interactionId)}">
    <span class="conversation-role">${message.role === 'user' ? 'User' : 'Assistant'}</span>
    <section class="conversation-markdown">${renderConversationMarkdown(
        message.markdown
    )}</section>
</article>`).join('');
}

function providerLabel(provider: AiSessionProviderId): string {
    return provider === 'codex' ? 'Codex' : provider === 'kimi' ? 'Kimi' : 'Claude';
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}
