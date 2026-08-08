'use strict';

import { randomBytes } from 'crypto';
import {
    addConversationCommentTag,
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
    markConversationCommentsDone,
    removeConversationCommentTag,
    reorderConversationComments,
    updateConversationComment,
    validateConversationComments,
} from './comments';
import type { CommentErrorCode } from './commentPrimitives';
import type {
    ConversationCommentSnapshot,
    ConversationCommentStore,
} from './commentStore';
import {
    QueuedCommentController,
    QueuedCommentControllerOptions,
    QueuedCommentRequestBase,
    QueuedCommentResultBase,
} from './queuedCommentController';
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

interface ConversationViewerCommentsResultMessage
    extends QueuedCommentResultBase<ConversationCommentDraft> {
    type: 'conversation-viewer-comments-result';
    operation: ConversationCommentOperation;
}

type ConversationCommentRequest = ConversationViewerCommentMutationMessage
    | ConversationViewerSendCommentsMessage;

export interface ConversationCommentControllerOptions
    extends QueuedCommentControllerOptions {
    commentStore?: ConversationCommentStore;
    getMessages: () => ConversationMessage[];
    navigateToInteraction: (interactionId: string) => Promise<boolean>;
}

export class ConversationCommentController extends QueuedCommentController<
    ConversationCommentDraft,
    ConversationCommentTarget,
    ConversationCommentRequest,
    ConversationViewerCommentsResultMessage
> {
    protected readonly options: ConversationCommentControllerOptions;
    private mutationsFrozen = false;

    constructor(options: ConversationCommentControllerOptions) {
        super(options);
        this.options = options;
    }

    protected onReset(): void {
        this.mutationsFrozen = false;
    }

    async freezeMutations(): Promise<void> {
        this.mutationsFrozen = true;
        await this.drainMutations();
    }

    protected isMutationsFrozen(): boolean {
        return this.mutationsFrozen;
    }

    async locate(
        request: ConversationViewerLocateCommentMessage
    ): Promise<void> {
        // Locate reads the comment list, so it joins the mutation queue
        // instead of racing an in-flight mutation.
        return this.enqueueTask(() => this.performLocate(request));
    }

    private async performLocate(
        request: ConversationViewerLocateCommentMessage
    ): Promise<void> {
        const target = this.options.getTarget();
        const comment = this.currentComments.find(
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
            ...(success ? {} : { error: 'stale' as const }),
        }, true);
    }

    protected readonly resultType: 'conversation-viewer-comments-result'
        = 'conversation-viewer-comments-result';

    protected getStore(): ConversationCommentStore | undefined {
        return this.options.commentStore;
    }

    protected toStoreTarget(
        target: ConversationViewerTarget
    ): ConversationCommentTarget {
        return {
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
        };
    }

    protected cloneComments(
        comments: readonly ConversationCommentDraft[]
    ): ConversationCommentDraft[] {
        return cloneConversationComments(comments);
    }

    protected validateComments(
        comments: readonly ConversationCommentDraft[]
    ): void {
        validateConversationComments(comments);
    }

    protected makeError(code: CommentErrorCode): ConversationCommentError {
        return new ConversationCommentError(code);
    }

    protected isSendRequest(request: ConversationCommentRequest): boolean {
        return request.type === 'conversation-viewer-send-comments';
    }

    protected sendCommentId(
        request: ConversationCommentRequest
    ): string | undefined {
        return request.type === 'conversation-viewer-send-comments'
            && request.operation === 'sendComment'
            ? (request.payload as { commentId: string }).commentId
            : undefined;
    }

    protected applyMutation(
        request: ConversationViewerCommentMutationMessage
    ): { comments: ConversationCommentDraft[]; changed: boolean } {
        let comments = cloneConversationComments(this.currentComments);
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
            return { comments, changed: true };
        }
        if (request.operation === 'reorder') {
            const orderedCommentIds = parseReorderPayload(request.payload);
            const reordered = reorderConversationComments(
                comments,
                orderedCommentIds
            );
            const changed = reordered.some(
                (comment, index) => comment.id !== comments[index]?.id
            );
            return { comments: changed ? reordered : comments, changed };
        }
        if (request.operation === 'clearDone'
            || request.operation === 'clearAll') {
            if (!hasExactKeys(request.payload as object, [])) {
                throw new ConversationCommentError('invalid');
            }
            const remainingComments = clearConversationComments(
                comments,
                request.operation
            );
            const changed = remainingComments.length !== comments.length;
            return { comments: changed ? remainingComments : comments, changed };
        }
        if (request.operation === 'addTag'
            || request.operation === 'removeTag') {
            const payload = parseCommentTagPayload(request.payload);
            const index = comments.findIndex(
                comment => comment.id === payload.commentId
            );
            if (index < 0) {
                throw new ConversationCommentError('stale');
            }
            const next = request.operation === 'addTag'
                ? addConversationCommentTag(comments[index], payload.tag)
                : removeConversationCommentTag(comments[index], payload.tag);
            if (JSON.stringify(next) === JSON.stringify(comments[index])) {
                return { comments, changed: false };
            }
            comments[index] = next;
            return { comments, changed: true };
        }
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
        return { comments, changed: true };
    }

    protected buildSendPrompt(
        targetComments: readonly ConversationCommentDraft[]
    ): string {
        return buildConversationCommentsPrompt(targetComments);
    }

    protected buildSendComments(
        targetComments: readonly ConversationCommentDraft[]
    ): ConversationCommentDraft[] {
        const sentIds = new Set(targetComments.map(comment => comment.id));
        return markConversationCommentsDone(
            this.currentComments,
            this.now(),
            sentIds
        );
    }
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

function parseCommentTagPayload(
    payload: unknown
): { commentId: string; tag: string } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ConversationCommentError('invalid');
    }
    const value = payload as Record<string, unknown>;
    if (!hasExactKeys(value, ['commentId', 'tag'])
        || !isConversationViewerTargetId(value.commentId)
        || typeof value.tag !== 'string') {
        throw new ConversationCommentError('invalid');
    }
    return { commentId: value.commentId, tag: value.tag };
}

function parseReorderPayload(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ConversationCommentError('invalid');
    }
    const value = payload as Record<string, unknown>;
    if (!hasExactKeys(value, ['orderedCommentIds'])
        || !Array.isArray(value.orderedCommentIds)
        || value.orderedCommentIds.length
            > CONVERSATION_COMMENT_LIMITS.maxComments
        || !value.orderedCommentIds.every(isConversationViewerTargetId)) {
        throw new ConversationCommentError('invalid');
    }
    return [...value.orderedCommentIds];
}
