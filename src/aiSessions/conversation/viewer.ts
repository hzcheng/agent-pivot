'use strict';

import { randomBytes } from 'crypto';
import { URL } from 'url';
import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';
import { renderConversationMarkdown } from './markdown';
import {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationAbortSignal,
    ConversationError,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
} from './types';

export interface ConversationViewerTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
    displayName: string;
    duplicateDisplayName: boolean;
}

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
}

export interface ConversationViewerApi extends AiSessionDisposable {
    open(target: ConversationViewerTarget): Promise<void>;
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
    selectedInteractionId: string;
    selectedInput: number;
    totalInputs: number;
    partial: boolean;
    atLatest: boolean;
    previousCursor?: string;
    nextCursor?: string;
    stale: boolean;
}

interface ConversationViewerNavigationMessage {
    type: 'conversation-viewer-previous'
        | 'conversation-viewer-next'
        | 'conversation-viewer-latest'
        | 'conversation-viewer-closed';
    version: 1;
}

interface ConversationViewerOpenLinkMessage {
    type: 'conversation-viewer-open-link';
    version: 1;
    href: string;
}

type ConversationViewerMessage =
    ConversationViewerNavigationMessage | ConversationViewerOpenLinkMessage;

const NAVIGATION_MESSAGE_TYPES = new Set([
    'conversation-viewer-previous',
    'conversation-viewer-next',
    'conversation-viewer-latest',
    'conversation-viewer-closed',
]);

export class ConversationViewer implements ConversationViewerApi {
    private panel?: vscode.WebviewPanel;
    private target?: ConversationViewerTarget;
    private watch?: AiSessionDisposable;
    private messageListener?: vscode.Disposable;
    private panelDisposeListener?: vscode.Disposable;
    private viewStateListener?: vscode.Disposable;
    private abortController?: ConversationAbortController;
    private outline?: ConversationOutline;
    private pages: RetainedConversationPage[] = [];
    private subscriptionGeneration = 0;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private currentRequestId = 0;
    private selectedInteractionId?: string;
    private stale = false;
    private latestPublication?: ConversationViewerPageMessage;
    private panelWasVisible = false;
    private suspended = false;

    constructor(private readonly options: ConversationViewerOptions) {}

    get snapshotSize(): number {
        return this.interactionIds().length;
    }

    async open(target: ConversationViewerTarget): Promise<void> {
        const generation = this.replaceTarget(target);
        const panel = this.ensurePanel();
        panel.title = 'AI Conversation';
        panel.reveal(vscode.ViewColumn.Active);
        panel.webview.html = this.renderDocument(undefined, 'Loading conversation…');
        this.ensureWatch(generation);
        await this.loadAuthoritative('initial', true);
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
            this.abortController?.abort();
            this.abortController = undefined;
            this.watch?.dispose();
            this.watch = undefined;
            this.subscriptionGeneration += 1;
            this.currentRequestId = this.allocateRequestId();
            if (this.pages.length && this.outline) {
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
        this.abortController?.abort();
        this.abortController = undefined;
        this.watch?.dispose();
        this.watch = undefined;
        this.pages = [];
        this.outline = undefined;
        this.stale = false;
        this.latestPublication = undefined;
        this.target = { ...target };
        this.selectedInteractionId = target.interactionId;
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
            'projectSteward.aiConversation',
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
        this.outline = undefined;
        this.target = undefined;
        this.selectedInteractionId = undefined;
        this.stale = false;
        this.latestPublication = undefined;
        this.panelWasVisible = false;
        this.suspended = false;
        this.subscriptionGeneration += 1;
        this.currentRequestId = 0;
    }

    private async handleMessage(message: unknown): Promise<void> {
        const parsed = parseViewerMessage(message);
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
        const outline = this.outline;
        const selectedInteractionId = this.selectedInteractionId;
        if (!target || !outline || !selectedInteractionId || !this.pages.length) {
            return false;
        }
        const outlineIds = outline.interactions.map(interaction => interaction.id);
        const selectedIndex = outlineIds.indexOf(selectedInteractionId);
        const targetIndex = direction === 'before'
            ? selectedIndex - 1
            : selectedIndex + 1;
        if (selectedIndex < 0 || targetIndex < 0
            || targetIndex >= outlineIds.length) {
            return false;
        }
        const nextInteractionId = outlineIds[targetIndex];
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
        const outline = this.outline;
        const latestInteractionId = outline?.interactions[
            outline.interactions.length - 1
        ]?.id;
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

    private async loadAuthoritative(
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
        const previousOutline = this.outline;
        const previousSelectedInteractionId = this.selectedInteractionId;
        const previousWasLatest = Boolean(
            previousOutline
            && previousSelectedInteractionId
            && previousOutline.interactions[
                previousOutline.interactions.length - 1
            ]?.id === previousSelectedInteractionId
        );
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
                : previousWasLatest
                    ? interactionIds[interactionIds.length - 1]
                    : previousSelectedInteractionId as string;
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
            this.outline = outline;
            this.selectedInteractionId = page.anchorInteractionId;
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
        const previousOutline = this.outline;
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
            if (retriedStaleRevision && outline) {
                this.outline = outline;
            }
            this.stale = false;
            this.selectedInteractionId = page.anchorInteractionId;
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
        if (!panel || !target || !this.outline?.interactions.some(
            interaction => interaction.id === interactionId
        )) {
            return false;
        }
        this.abortController?.abort();
        this.selectedInteractionId = interactionId;
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
            const targetId = this.selectedInteractionId;
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
        const outline = this.outline;
        const selectedInteractionId = this.selectedInteractionId;
        if (!target || !outline || !selectedInteractionId) {
            throw new Error('Conversation viewer target unavailable.');
        }
        const interactionIds = outline.interactions.map(
            interaction => interaction.id
        );
        const selectedIndex = interactionIds.indexOf(selectedInteractionId);
        const omittedInteractions = outline.partial
            ? Math.max(0, outline.totalInteractions - interactionIds.length)
            : 0;
        const first = this.pages[0]?.page;
        const last = this.pages[this.pages.length - 1]?.page;
        return {
            type: 'conversation-viewer-page',
            version: 1,
            requestId,
            subscriptionGeneration: generation,
            updateKind,
            html: renderMessages(this.messages()),
            selectedInteractionId,
            selectedInput: selectedIndex < 0
                ? 0
                : omittedInteractions + selectedIndex + 1,
            totalInputs: outline.partial
                ? Math.min(outline.totalInteractions,
                    CONVERSATION_LIMITS.maxOutlineInteractions)
                : outline.totalInteractions,
            partial: outline.partial,
            atLatest: selectedIndex === interactionIds.length - 1,
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
        const purify = panel.webview.asWebviewUri(
            this.options.mediaUri('purify.min.js')
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
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${escapeAttribute(
            panel.webview.cspSource
        )}; script-src 'nonce-${escapeAttribute(nonce)}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeAttribute(stylesheet.toString())}">
    <title>AI Conversation</title>
</head>
<body data-auto-scroll-threshold="${CONVERSATION_LIMITS.autoScrollThresholdPx}"
    data-subscription-generation="${this.subscriptionGeneration}"${initialPageAttribute}>
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
            <button type="button" data-action="close">Close</button>
        </nav>
    </header>
    <div class="conversation-status" data-conversation-status aria-live="polite">${escapeHtml(
        initialStatus
    )}</div>
    <main class="conversation-scroll" data-conversation-scroll tabindex="0">
        <div class="conversation-messages" data-conversation-messages></div>
    </main>
    <button class="new-response" type="button" data-new-response hidden>New response content</button>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        purify.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        script.toString()
    )}"></script>
</body>
</html>`;
    }
}

function parseViewerMessage(message: unknown): ConversationViewerMessage | undefined {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return undefined;
    }
    const value = message as { [key: string]: unknown };
    if (value.version !== 1 || typeof value.type !== 'string') {
        return undefined;
    }
    const keys = Object.keys(value);
    if (NAVIGATION_MESSAGE_TYPES.has(value.type)) {
        if (keys.length !== 2 || !hasOwn(value, 'type') || !hasOwn(value, 'version')) {
            return undefined;
        }
        return value as unknown as ConversationViewerNavigationMessage;
    }
    if (value.type !== 'conversation-viewer-open-link'
        || keys.length !== 3
        || !hasOwn(value, 'type')
        || !hasOwn(value, 'version')
        || !hasOwn(value, 'href')
        || typeof value.href !== 'string') {
        return undefined;
    }
    return value as unknown as ConversationViewerOpenLinkMessage;
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
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
