'use strict';

import * as vscode from 'vscode';
import {
    ConversationBookmarkSnapshot,
    ConversationBookmarkStore,
    isConversationBookmarkSnapshot,
    MAX_CONVERSATION_BOOKMARKS,
} from './bookmarkStore';
import type { ConversationOutline } from './types';
import type { ConversationViewerTarget } from './viewerTarget';
import type {
    ConversationViewerBookmarkMutationMessage,
} from './viewerProtocol';

interface ConversationViewerBookmarksResultMessage {
    type: 'conversation-viewer-bookmarks-result';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: ConversationViewerTarget['provider'];
    sessionId: string;
    operation: 'set';
    success: boolean;
    revision: number;
    interactionIds: string[];
    error?: 'invalid' | 'stale' | 'failed' | 'limit';
}

export interface ConversationBookmarkControllerOptions {
    bookmarkStore?: ConversationBookmarkStore;
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    getPanel: () => vscode.WebviewPanel | undefined;
    getOutline: () => ConversationOutline | undefined;
    rebuildLatestDocument: () => void;
}

export class ConversationBookmarkController {
    private interactionIds = new Set<string>();
    private revision = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements =
        new Map<string, ConversationViewerBookmarksResultMessage>();

    constructor(
        private readonly options: ConversationBookmarkControllerOptions
    ) {}

    get snapshot(): ConversationBookmarkSnapshot {
        return {
            revision: this.revision,
            interactionIds: [...this.interactionIds],
        };
    }

    reset(): void {
        this.interactionIds.clear();
        this.revision = 0;
        this.settlements.clear();
    }

    enqueue(
        request: ConversationViewerBookmarkMutationMessage
    ): Promise<void> {
        const operation = () => this.handleOperation(request);
        const queued = this.operationQueue.then(operation, operation);
        this.operationQueue = queued.catch(() => undefined);
        return queued;
    }

    async restore(
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        if (!this.options.bookmarkStore) {
            return;
        }
        let snapshot: ConversationBookmarkSnapshot;
        try {
            snapshot = await this.options.bookmarkStore.load(
                toBookmarkTarget(target)
            );
            if (!isConversationBookmarkSnapshot(snapshot)) {
                return;
            }
        } catch (_error) {
            return;
        }
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation) {
            return;
        }
        this.interactionIds = new Set(snapshot.interactionIds);
        this.revision = snapshot.revision;
    }

    private async handleOperation(
        request: ConversationViewerBookmarkMutationMessage
    ): Promise<void> {
        const target = this.options.getTarget();
        if (!target || !this.options.getPanel()) {
            return;
        }
        const settlementKey = getSettlementKey(request);
        const settled = this.settlements.get(settlementKey);
        if (settled) {
            await this.publishSettlement(settled);
            return;
        }
        if (!requestTargetsViewer(
            request,
            target,
            this.options.getSubscriptionGeneration()
        ) || request.expectedRevision !== this.revision) {
            await this.settleRequest(request, false, 'stale');
            return;
        }
        const interactionExists = this.options.getOutline()?.interactions.some(
            interaction => interaction.id === request.payload.interactionId
        ) === true;
        if (!interactionExists) {
            await this.settleRequest(request, false, 'stale');
            return;
        }
        const next = new Set(this.interactionIds);
        if (request.payload.bookmarked) {
            next.add(request.payload.interactionId);
        } else {
            next.delete(request.payload.interactionId);
        }
        if (next.size > MAX_CONVERSATION_BOOKMARKS) {
            await this.settleRequest(request, false, 'limit');
            return;
        }
        const changed = next.size !== this.interactionIds.size
            || [...next].some(id => !this.interactionIds.has(id));
        const snapshot = {
            revision: this.revision + (changed ? 1 : 0),
            interactionIds: [...next],
        };
        const previousSnapshot = this.snapshot;
        try {
            await this.persist(target, snapshot);
            if (this.options.getTarget() !== target
                || this.options.getSubscriptionGeneration()
                    !== request.subscriptionGeneration
                || this.revision !== request.expectedRevision) {
                await this.persist(target, previousSnapshot);
                throw new Error('stale');
            }
            this.interactionIds = next;
            this.revision = snapshot.revision;
            await this.settleRequest(request, true);
        } catch (error) {
            await this.settleRequest(
                request,
                false,
                error instanceof Error && error.message === 'stale'
                    ? 'stale'
                    : 'failed'
            );
        }
    }

    private async persist(
        target: ConversationViewerTarget,
        snapshot: ConversationBookmarkSnapshot
    ): Promise<void> {
        if (!this.options.bookmarkStore) {
            return;
        }
        await this.options.bookmarkStore.save(
            toBookmarkTarget(target),
            snapshot
        );
    }

    private async settleRequest(
        request: ConversationViewerBookmarkMutationMessage,
        success: boolean,
        error?: ConversationViewerBookmarksResultMessage['error']
    ): Promise<void> {
        const settlement: ConversationViewerBookmarksResultMessage = {
            type: 'conversation-viewer-bookmarks-result',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: 'set',
            success,
            revision: this.revision,
            interactionIds: [...this.interactionIds],
            ...(error ? { error } : {}),
        };
        this.settlements.set(getSettlementKey(request), settlement);
        while (this.settlements.size > 100) {
            const oldest = this.settlements.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            this.settlements.delete(oldest);
        }
        await this.publishSettlement(settlement);
    }

    private async publishSettlement(
        settlement: ConversationViewerBookmarksResultMessage
    ): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel) {
            return;
        }
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(settlement);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered && this.options.getPanel() === panel) {
            this.options.rebuildLatestDocument();
        }
    }
}

function toBookmarkTarget(
    target: ConversationViewerTarget
): Pick<
    ConversationViewerTarget,
    'projectId' | 'provider' | 'sessionId'
> {
    return {
        projectId: target.projectId,
        provider: target.provider,
        sessionId: target.sessionId,
    };
}

function requestTargetsViewer(
    request: ConversationViewerBookmarkMutationMessage,
    target: ConversationViewerTarget,
    subscriptionGeneration: number
): boolean {
    return request.subscriptionGeneration === subscriptionGeneration
        && request.projectId === target.projectId
        && request.provider === target.provider
        && request.sessionId === target.sessionId;
}

function getSettlementKey(
    request: ConversationViewerBookmarkMutationMessage
): string {
    return [
        request.subscriptionGeneration,
        request.projectId,
        request.provider,
        request.sessionId,
        request.requestId,
    ].join('\u0000');
}
