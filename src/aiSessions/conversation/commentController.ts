'use strict';

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import {
    buildConversationCommentsPrompt,
    clearConversationComments,
    cloneConversationComments,
    CONVERSATION_COMMENT_LIMITS,
    ConversationCommentDraft,
    ConversationCommentError,
    ConversationCommentOperation,
    ConversationCommentSelection,
    ConversationCommentSessionNote,
    ConversationCommentTarget,
    createConversationComment,
    createConversationSessionComment,
    updateConversationComment,
    validateConversationComments,
} from './comments';
import type {
    ConversationCommentSnapshot,
    ConversationCommentStore,
} from './commentStore';
import type { ConversationMessage } from './types';
import type { ConversationViewerTarget } from './viewerTarget';
import {
    ConversationViewerCommentMutationMessage,
    ConversationViewerLocateCommentMessage,
    ConversationViewerSendCommentsMessage,
    hasExactKeys,
    isConversationViewerTargetId,
} from './viewerProtocol';

interface ConversationViewerLocateCommentResultMessage {
    type: 'conversation-viewer-locate-comment-result';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: ConversationViewerTarget['provider'];
    sessionId: string;
    commentId: string;
    success: boolean;
    error?: 'stale';
}

interface ConversationViewerCommentsResultMessage {
    type: 'conversation-viewer-comments-result';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: ConversationViewerTarget['provider'];
    sessionId: string;
    operation: ConversationCommentOperation;
    success: boolean;
    revision: number;
    comments: ConversationCommentDraft[];
    error?: ConversationCommentError['code'];
}

export interface ConversationCommentControllerOptions {
    commentStore?: ConversationCommentStore;
    now?: () => number;
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
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    getPanel: () => vscode.WebviewPanel | undefined;
    getMessages: () => ConversationMessage[];
    navigateToInteraction: (interactionId: string) => Promise<boolean>;
    rebuildLatestDocument: () => void;
}

export class ConversationCommentController {
    private comments: ConversationCommentDraft[] = [];
    private revision = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements =
        new Map<string, ConversationViewerCommentsResultMessage>();

    constructor(
        private readonly options: ConversationCommentControllerOptions
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    get snapshot(): ConversationCommentSnapshot {
        return {
            revision: this.revision,
            comments: cloneConversationComments(this.comments),
        };
    }

    reset(): void {
        this.comments = [];
        this.revision = 0;
        this.settlements.clear();
    }

    enqueue(
        request: ConversationViewerCommentMutationMessage
            | ConversationViewerSendCommentsMessage
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
        if (!this.options.commentStore) {
            return;
        }
        let snapshot: ConversationCommentSnapshot;
        try {
            snapshot = await this.options.commentStore.load(
                toCommentTarget(target)
            );
            validateConversationComments(snapshot.comments);
            if (!Number.isSafeInteger(snapshot.revision)
                || snapshot.revision < 0) {
                throw new ConversationCommentError('invalid');
            }
        } catch (_error) {
            return;
        }
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation) {
            return;
        }
        this.comments = cloneConversationComments(snapshot.comments);
        this.revision = snapshot.revision;
    }

    async locate(
        request: ConversationViewerLocateCommentMessage
    ): Promise<void> {
        const target = this.options.getTarget();
        const comment = this.comments.find(
            candidate => candidate.id === request.commentId
        );
        const targetMatches = Boolean(target)
            && request.subscriptionGeneration
                === this.options.getSubscriptionGeneration()
            && request.projectId === target?.projectId
            && request.provider === target?.provider
            && request.sessionId === target?.sessionId;
        const success = targetMatches && comment
            ? await this.options.navigateToInteraction(comment.interactionId)
            : false;
        await this.publishSettlement({
            type: 'conversation-viewer-locate-comment-result',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            commentId: request.commentId,
            success,
            ...(success ? {} : { error: 'stale' }),
        }, true);
    }

    private async handleOperation(
        request: ConversationViewerCommentMutationMessage
            | ConversationViewerSendCommentsMessage
    ): Promise<void> {
        const target = this.options.getTarget();
        if (!target || !this.options.getPanel()) {
            return;
        }
        const settlementKey = getSettlementKey(request);
        const settled = this.settlements.get(settlementKey);
        if (settled) {
            await this.publishSettlement(
                settled.operation === request.operation
                    ? settled
                    : {
                        ...settled,
                        operation: request.operation,
                        success: false,
                        revision: this.revision,
                        comments: cloneConversationComments(this.comments),
                        error: 'invalid',
                    },
                false
            );
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
        try {
            if (request.type === 'conversation-viewer-send-comments') {
                await this.sendComments(
                    target,
                    this.options.getSubscriptionGeneration(),
                    request.operation === 'sendComment'
                        ? (request.payload as { commentId: string }).commentId
                        : undefined
                );
            } else {
                await this.mutateComments(
                    request,
                    target,
                    this.options.getSubscriptionGeneration()
                );
            }
            await this.settleRequest(request, true);
            if (request.type === 'conversation-viewer-send-comments') {
                await this.focusSessionAfterSend(target);
            }
        } catch (error) {
            await this.settleRequest(
                request,
                false,
                toCommentErrorCode(error)
            );
        }
    }

    private async focusSessionAfterSend(
        target: ConversationViewerTarget
    ): Promise<void> {
        try {
            await Promise.resolve(this.options.focusSession?.({
                projectId: target.projectId,
                provider: target.provider,
                sessionId: target.sessionId,
            }));
        } catch (_error) {
            // The prompt is already staged and settled. Focus failure must not
            // encourage a retry that stages the same batch twice.
        }
    }

    private async mutateComments(
        request: ConversationViewerCommentMutationMessage,
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        let comments = cloneConversationComments(this.comments);
        let revision = this.revision;
        if (request.operation === 'add') {
            if (comments.length >= CONVERSATION_COMMENT_LIMITS.maxComments) {
                throw new ConversationCommentError('limit');
            }
            const payload = parseCommentInput(request.payload);
            if (payload.scope === 'session') {
                comments.push({
                    ...createConversationSessionComment(
                        randomBytes(16).toString('hex'),
                        payload.comment
                    ),
                    createdAt: this.now(),
                });
            } else {
                const message = this.options.getMessages().find(candidate =>
                    candidate.id === payload.messageId
                    && candidate.interactionId === payload.interactionId
                );
                if (!message) {
                    throw new ConversationCommentError('stale');
                }
                comments.push({
                    ...createConversationComment(
                        randomBytes(16).toString('hex'),
                        payload,
                        message
                    ),
                    createdAt: this.now(),
                });
            }
            revision += 1;
        } else if (request.operation === 'clearDone'
            || request.operation === 'clearAll') {
            if (!hasExactKeys(request.payload as object, [])) {
                throw new ConversationCommentError('invalid');
            }
            const remainingComments = clearConversationComments(
                comments,
                request.operation
            );
            if (remainingComments.length !== comments.length) {
                comments = remainingComments;
                revision += 1;
            }
        } else {
            const payload = parseExistingCommentPayload(
                request.operation,
                request.payload
            );
            const index = comments.findIndex(
                comment => comment.id === payload.commentId
            );
            if (index < 0) {
                throw new ConversationCommentError('stale');
            }
            if (request.operation === 'delete') {
                comments.splice(index, 1);
            } else {
                comments[index] = updateConversationComment(
                    comments[index],
                    payload.comment
                );
            }
            revision += 1;
        }
        const snapshot = { revision, comments };
        await this.persist(target, snapshot);
        this.commitPersisted(
            target,
            generation,
            request.expectedRevision,
            snapshot
        );
    }

    private async sendComments(
        target: ConversationViewerTarget,
        generation: number,
        commentId?: string
    ): Promise<void> {
        const openComments = this.comments.filter(
            comment => comment.status === 'open'
        );
        const targetComments = commentId
            ? openComments.filter(comment => comment.id === commentId)
            : openComments;
        if (commentId && targetComments.length !== 1) {
            // The card no longer exists or is no longer open.
            throw new ConversationCommentError('stale');
        }
        const prompt = buildConversationCommentsPrompt(targetComments);
        const previousSnapshot = this.snapshot;
        const sentSnapshot = {
            revision: this.revision + 1,
            comments: this.markDone(commentId ? new Set([commentId]) : null),
        };
        await this.persist(target, sentSnapshot);
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== previousSnapshot.revision) {
            await this.persist(target, previousSnapshot);
            throw new ConversationCommentError('stale');
        }
        try {
            await Promise.resolve(this.options.submitPrompt(
                { ...target },
                prompt
            ));
        } catch (error) {
            await this.persist(target, previousSnapshot);
            if (error instanceof ConversationCommentError) {
                throw error;
            }
            throw new ConversationCommentError('failed');
        }
        if (this.options.getTarget() !== target) {
            throw new ConversationCommentError('stale');
        }
        this.comments = sentSnapshot.comments;
        this.revision = sentSnapshot.revision;
    }

    private markDone(
        ids: Set<string> | null
    ): ConversationCommentDraft[] {
        const at = this.now();
        return this.comments.map(comment =>
            comment.status === 'open' && (!ids || ids.has(comment.id))
                ? { ...comment, status: 'done' as const, sentAt: at }
                : { ...comment });
    }

    private async persist(
        target: ConversationViewerTarget,
        snapshot: ConversationCommentSnapshot
    ): Promise<void> {
        if (!this.options.commentStore) {
            return;
        }
        try {
            await this.options.commentStore.save(
                toCommentTarget(target),
                snapshot
            );
        } catch (_error) {
            throw new ConversationCommentError('failed');
        }
    }

    private commitPersisted(
        target: ConversationViewerTarget,
        generation: number,
        expectedRevision: number,
        snapshot: ConversationCommentSnapshot
    ): void {
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== expectedRevision) {
            throw new ConversationCommentError('stale');
        }
        this.comments = snapshot.comments;
        this.revision = snapshot.revision;
    }

    private async settleRequest(
        request: ConversationViewerCommentMutationMessage
            | ConversationViewerSendCommentsMessage,
        success: boolean,
        error?: ConversationCommentError['code']
    ): Promise<void> {
        const settlement: ConversationViewerCommentsResultMessage = {
            type: 'conversation-viewer-comments-result',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: request.operation,
            success,
            revision: this.revision,
            comments: cloneConversationComments(this.comments),
            ...(error ? { error } : {}),
        };
        this.rememberSettlement(getSettlementKey(request), settlement);
        await this.publishSettlement(settlement, true);
    }

    private rememberSettlement(
        key: string,
        settlement: ConversationViewerCommentsResultMessage
    ): void {
        this.settlements.set(key, settlement);
        while (this.settlements.size > 100) {
            const oldest = this.settlements.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            this.settlements.delete(oldest);
        }
    }

    private async publishSettlement(
        settlement: ConversationViewerCommentsResultMessage
            | ConversationViewerLocateCommentResultMessage,
        rebuildOnFailure: boolean
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
        if (!delivered
            && rebuildOnFailure
            && this.options.getPanel() === panel) {
            this.options.rebuildLatestDocument();
        }
    }
}

function toCommentTarget(
    target: ConversationViewerTarget
): ConversationCommentTarget {
    return {
        projectId: target.projectId,
        provider: target.provider,
        sessionId: target.sessionId,
    };
}

function requestTargetsViewer(
    request: ConversationViewerCommentMutationMessage
        | ConversationViewerSendCommentsMessage,
    target: ConversationViewerTarget,
    subscriptionGeneration: number
): boolean {
    return request.subscriptionGeneration === subscriptionGeneration
        && request.projectId === target.projectId
        && request.provider === target.provider
        && request.sessionId === target.sessionId;
}

function getSettlementKey(
    request: ConversationViewerCommentMutationMessage
        | ConversationViewerSendCommentsMessage
): string {
    return JSON.stringify([
        request.projectId,
        request.provider,
        request.sessionId,
        request.requestId,
    ]);
}

function parseCommentInput(
    payload: unknown
): ConversationCommentSelection | ConversationCommentSessionNote {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ConversationCommentError('invalid');
    }
    const value = payload as Record<string, unknown>;
    if (hasExactKeys(value, ['scope', 'comment'])) {
        if (value.scope !== 'session' || typeof value.comment !== 'string') {
            throw new ConversationCommentError('invalid');
        }
        return value as unknown as ConversationCommentSessionNote;
    }
    if (!hasExactKeys(value, [
        'messageId', 'interactionId', 'quote', 'prefix', 'suffix', 'comment',
    ]) || typeof value.messageId !== 'string'
        || typeof value.interactionId !== 'string'
        || typeof value.quote !== 'string'
        || typeof value.prefix !== 'string'
        || typeof value.suffix !== 'string'
        || typeof value.comment !== 'string') {
        throw new ConversationCommentError('invalid');
    }
    return {
        scope: 'selection',
        messageId: value.messageId,
        interactionId: value.interactionId,
        quote: value.quote,
        prefix: value.prefix,
        suffix: value.suffix,
        comment: value.comment,
    };
}

function parseExistingCommentPayload(
    operation: 'update' | 'delete',
    payload: unknown
): { commentId: string; comment?: string } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ConversationCommentError('invalid');
    }
    const value = payload as Record<string, unknown>;
    const expected = operation === 'update'
        ? ['commentId', 'comment']
        : ['commentId'];
    if (!hasExactKeys(value, expected)
        || !isConversationViewerTargetId(value.commentId)
        || (operation === 'update' && typeof value.comment !== 'string')) {
        throw new ConversationCommentError('invalid');
    }
    return {
        commentId: value.commentId,
        ...(operation === 'update'
            ? { comment: value.comment as string }
            : {}),
    };
}

function toCommentErrorCode(
    error: unknown
): ConversationCommentError['code'] {
    return error instanceof ConversationCommentError
        ? error.code
        : 'failed';
}
