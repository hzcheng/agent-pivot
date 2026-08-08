'use strict';

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import {
    addProjectCommentTag,
    buildProjectCommentPrompt,
    buildProjectCommentsPrompt,
    clearProjectComments,
    cloneProjectComments,
    collectProjectCommentTagVocabulary,
    createProjectComment,
    PROJECT_COMMENT_LIMITS,
    ProjectComment,
    ProjectCommentError,
    ProjectCommentTarget,
    recordProjectCommentDispatch,
    removeProjectCommentTag,
    reorderProjectComments,
    setProjectCommentStatus,
    updateProjectCommentText,
    validateProjectComments,
} from './projectComments';
import type { ProjectCommentSnapshot, ProjectCommentStore } from './projectCommentStore';
import type { ConversationViewerTarget } from './viewerTarget';
import {
    ConversationViewerProjectCommentMutationMessage,
    ConversationViewerSendProjectCommentMessage,
    hasExactKeys,
    isConversationViewerTargetId,
} from './viewerProtocol';

interface ConversationViewerProjectCommentsResultMessage {
    type: 'conversation-viewer-project-comments-result';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: ConversationViewerTarget['provider'];
    sessionId: string;
    operation: ConversationViewerProjectCommentMutationMessage['operation']
        | 'sendProjectComment'
        | 'sendProjectComments';
    success: boolean;
    revision: number;
    comments: ProjectComment[];
    error?: ProjectCommentError['code'];
}

export interface ProjectCommentControllerOptions {
    projectCommentStore?: ProjectCommentStore;
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
    rebuildLatestDocument: () => void;
}

export class ProjectCommentController {
    private comments: ProjectComment[] = [];
    private revision = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements =
        new Map<string, ConversationViewerProjectCommentsResultMessage>();

    constructor(
        private readonly options: ProjectCommentControllerOptions
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    get snapshot(): ProjectCommentSnapshot {
        return {
            revision: this.revision,
            comments: cloneProjectComments(this.comments),
        };
    }

    reset(): void {
        this.comments = [];
        this.revision = 0;
        this.settlements.clear();
    }

    async drainMutations(): Promise<void> {
        await this.operationQueue;
    }

    enqueue(
        request: ConversationViewerProjectCommentMutationMessage
            | ConversationViewerSendProjectCommentMessage
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
        if (!this.options.projectCommentStore) {
            return;
        }
        let snapshot: ProjectCommentSnapshot;
        try {
            snapshot = await this.options.projectCommentStore.load(
                toProjectCommentTarget(target)
            );
            validateProjectComments(snapshot.comments);
            if (!Number.isSafeInteger(snapshot.revision)
                || snapshot.revision < 0) {
                throw new ProjectCommentError('invalid');
            }
        } catch (_error) {
            return;
        }
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation) {
            return;
        }
        this.comments = cloneProjectComments(snapshot.comments);
        this.revision = snapshot.revision;
    }

    private async handleOperation(
        request: ConversationViewerProjectCommentMutationMessage
            | ConversationViewerSendProjectCommentMessage
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
                        comments: cloneProjectComments(this.comments),
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
            if (request.type === 'conversation-viewer-send-project-comment') {
                await this.sendProjectComment(
                    target,
                    this.options.getSubscriptionGeneration(),
                    request.operation === 'sendProjectComment'
                        ? parseCommentIdPayload(request.payload).commentId
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
            if (request.type === 'conversation-viewer-send-project-comment') {
                await this.focusSessionAfterSend(target);
            }
        } catch (error) {
            await this.settleRequest(
                request,
                false,
                toProjectCommentErrorCode(error)
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
            // encourage a retry that stages the same note twice.
        }
    }

    private async mutateComments(
        request: ConversationViewerProjectCommentMutationMessage,
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        let comments = cloneProjectComments(this.comments);
        let revision = this.revision;
        let changed = false;
        if (request.operation === 'add') {
            if (comments.length >= PROJECT_COMMENT_LIMITS.maxComments) {
                throw new ProjectCommentError('limit');
            }
            const payload = parseAddPayload(request.payload);
            const comment = createProjectComment(
                randomBytes(16).toString('hex'),
                payload,
                this.now()
            );
            this.assertTagVocabularyBudget(comments, comment.tags);
            // New notes land at the top; the array order is the display
            // order once manual reordering enters the picture.
            comments.unshift(comment);
            changed = true;
        } else if (request.operation === 'reorder') {
            const orderedCommentIds = parseReorderPayload(request.payload);
            const reordered = reorderProjectComments(
                comments,
                orderedCommentIds
            );
            if (reordered.some(
                (comment, index) => comment.id !== comments[index]?.id
            )) {
                comments = reordered;
                changed = true;
            }
        } else if (request.operation === 'clearDone'
            || request.operation === 'clearAll') {
            if (!hasExactKeys(request.payload as object, [])) {
                throw new ProjectCommentError('invalid');
            }
            const remainingComments = clearProjectComments(
                comments,
                request.operation
            );
            if (remainingComments.length !== comments.length) {
                comments = remainingComments;
                changed = true;
            }
        } else if (request.operation === 'delete') {
            const payload = parseCommentIdPayload(request.payload);
            const index = comments.findIndex(
                comment => comment.id === payload.commentId
            );
            if (index < 0) {
                throw new ProjectCommentError('stale');
            }
            comments.splice(index, 1);
            changed = true;
        } else {
            const commentId = parseMutationCommentId(request);
            const index = comments.findIndex(
                comment => comment.id === commentId
            );
            if (index < 0) {
                throw new ProjectCommentError('stale');
            }
            const current = comments[index];
            let next: ProjectComment;
            if (request.operation === 'update') {
                next = updateProjectCommentText(
                    current,
                    parseUpdatePayload(request.payload).text,
                    this.now()
                );
            } else if (request.operation === 'setStatus') {
                next = setProjectCommentStatus(
                    current,
                    parseSetStatusPayload(request.payload).status,
                    this.now()
                );
            } else if (request.operation === 'addTag') {
                const tag = parseTagPayload(request.payload).tag;
                this.assertTagVocabularyBudget(comments, [tag]);
                next = addProjectCommentTag(current, tag);
            } else {
                next = removeProjectCommentTag(
                    current,
                    parseTagPayload(request.payload).tag
                );
            }
            changed = JSON.stringify(next) !== JSON.stringify(current);
            comments[index] = next;
        }
        if (!changed) {
            return;
        }
        revision += 1;
        const snapshot = { revision, comments };
        const previousSnapshot = this.snapshot;
        await this.persist(target, snapshot);
        try {
            this.commitPersisted(
                target,
                generation,
                request.expectedRevision,
                snapshot
            );
        } catch (error) {
            await this.persist(target, previousSnapshot);
            throw error;
        }
    }

    private assertTagVocabularyBudget(
        comments: readonly ProjectComment[],
        incoming: readonly string[]
    ): void {
        const vocabulary = collectProjectCommentTagVocabulary(comments)
            .map(tag => tag.toLowerCase());
        const known = new Set(vocabulary);
        let distinct = vocabulary.length;
        incoming.forEach(tag => {
            const key = tag.trim().toLowerCase();
            if (!known.has(key)) {
                known.add(key);
                distinct += 1;
            }
        });
        if (distinct > PROJECT_COMMENT_LIMITS.maxDistinctTags) {
            throw new ProjectCommentError('limit');
        }
    }

    private async sendProjectComment(
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
            throw new ProjectCommentError('stale');
        }
        const prompt = commentId
            ? buildProjectCommentPrompt(targetComments[0])
            : buildProjectCommentsPrompt(targetComments);
        const previousSnapshot = this.snapshot;
        const sentIds = new Set(targetComments.map(comment => comment.id));
        const sentSnapshot = {
            revision: this.revision + 1,
            comments: this.comments.map(candidate =>
                sentIds.has(candidate.id)
                    ? recordProjectCommentDispatch(candidate, {
                        provider: target.provider,
                        sessionId: target.sessionId,
                        at: this.now(),
                    })
                    : candidate
            ),
        };
        await this.persist(target, sentSnapshot);
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== previousSnapshot.revision) {
            await this.persist(target, previousSnapshot);
            throw new ProjectCommentError('stale');
        }
        try {
            await Promise.resolve(this.options.submitPrompt(
                { ...target },
                prompt
            ));
        } catch (error) {
            await this.persist(target, previousSnapshot);
            if (error instanceof ProjectCommentError) {
                throw error;
            }
            // submitPrompt surfaces submission.ts failures as
            // ConversationCommentError; preserve those user-actionable codes.
            const code = (error as { code?: unknown })?.code;
            if (code === 'unavailable' || code === 'busy'
                || code === 'conflict') {
                throw new ProjectCommentError(code);
            }
            throw new ProjectCommentError('failed');
        }
        if (this.options.getTarget() !== target) {
            throw new ProjectCommentError('stale');
        }
        this.comments = sentSnapshot.comments;
        this.revision = sentSnapshot.revision;
    }

    private async persist(
        target: ConversationViewerTarget,
        snapshot: ProjectCommentSnapshot
    ): Promise<void> {
        if (!this.options.projectCommentStore) {
            return;
        }
        try {
            await this.options.projectCommentStore.save(
                toProjectCommentTarget(target),
                snapshot
            );
        } catch (_error) {
            throw new ProjectCommentError('failed');
        }
    }

    private commitPersisted(
        target: ConversationViewerTarget,
        generation: number,
        expectedRevision: number,
        snapshot: ProjectCommentSnapshot
    ): void {
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== expectedRevision) {
            throw new ProjectCommentError('stale');
        }
        this.comments = snapshot.comments;
        this.revision = snapshot.revision;
    }

    private async settleRequest(
        request: ConversationViewerProjectCommentMutationMessage
            | ConversationViewerSendProjectCommentMessage,
        success: boolean,
        error?: ProjectCommentError['code']
    ): Promise<void> {
        const settlement: ConversationViewerProjectCommentsResultMessage = {
            type: 'conversation-viewer-project-comments-result',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: request.operation,
            success,
            revision: this.revision,
            comments: cloneProjectComments(this.comments),
            ...(error ? { error } : {}),
        };
        this.rememberSettlement(getSettlementKey(request), settlement);
        await this.publishSettlement(settlement, true);
    }

    private rememberSettlement(
        key: string,
        settlement: ConversationViewerProjectCommentsResultMessage
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
        settlement: ConversationViewerProjectCommentsResultMessage,
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

function toProjectCommentTarget(
    target: ConversationViewerTarget
): ProjectCommentTarget {
    return { projectId: target.projectId };
}

function requestTargetsViewer(
    request: ConversationViewerProjectCommentMutationMessage
        | ConversationViewerSendProjectCommentMessage,
    target: ConversationViewerTarget,
    subscriptionGeneration: number
): boolean {
    return request.subscriptionGeneration === subscriptionGeneration
        && request.projectId === target.projectId
        && request.provider === target.provider
        && request.sessionId === target.sessionId;
}

function getSettlementKey(
    request: ConversationViewerProjectCommentMutationMessage
        | ConversationViewerSendProjectCommentMessage
): string {
    return JSON.stringify([
        request.projectId,
        request.provider,
        request.sessionId,
        request.requestId,
    ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMutationCommentId(
    request: ConversationViewerProjectCommentMutationMessage
): string {
    if (request.operation === 'update') {
        return parseUpdatePayload(request.payload).commentId;
    }
    if (request.operation === 'setStatus') {
        return parseSetStatusPayload(request.payload).commentId;
    }
    if (request.operation === 'addTag'
        || request.operation === 'removeTag') {
        return parseTagPayload(request.payload).commentId;
    }
    return parseCommentIdPayload(request.payload).commentId;
}

function parseReorderPayload(payload: unknown): string[] {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['orderedCommentIds'])
        || !Array.isArray(payload.orderedCommentIds)
        || payload.orderedCommentIds.length
            > PROJECT_COMMENT_LIMITS.maxComments
        || !payload.orderedCommentIds.every(
            isConversationViewerTargetId
        )) {
        throw new ProjectCommentError('invalid');
    }
    return [...payload.orderedCommentIds];
}

function parseCommentIdPayload(payload: unknown): { commentId: string } {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['commentId'])
        || !isConversationViewerTargetId(payload.commentId)) {
        throw new ProjectCommentError('invalid');
    }
    return { commentId: payload.commentId };
}

function parseAddPayload(payload: unknown): {
    text: string;
    tags?: string[];
    source?: unknown;
} {
    if (!isRecord(payload) || typeof payload.text !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    const keys = Object.keys(payload);
    const allowed = ['text', 'tags', 'source'];
    if (!keys.every(key => allowed.includes(key))) {
        throw new ProjectCommentError('invalid');
    }
    if (payload.tags !== undefined
        && (!Array.isArray(payload.tags)
            || !payload.tags.every(tag => typeof tag === 'string'))) {
        throw new ProjectCommentError('invalid');
    }
    return {
        text: payload.text,
        ...(payload.tags !== undefined
            ? { tags: payload.tags as string[] }
            : {}),
        ...(payload.source !== undefined ? { source: payload.source } : {}),
    };
}

function parseUpdatePayload(
    payload: unknown
): { commentId: string; text: string } {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['commentId', 'text'])
        || !isConversationViewerTargetId(payload.commentId)
        || typeof payload.text !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    return { commentId: payload.commentId, text: payload.text };
}

function parseSetStatusPayload(
    payload: unknown
): { commentId: string; status: 'open' | 'done' } {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['commentId', 'status'])
        || !isConversationViewerTargetId(payload.commentId)
        || (payload.status !== 'open' && payload.status !== 'done')) {
        throw new ProjectCommentError('invalid');
    }
    return { commentId: payload.commentId, status: payload.status };
}

function parseTagPayload(
    payload: unknown
): { commentId: string; tag: string } {
    if (!isRecord(payload)
        || !hasExactKeys(payload, ['commentId', 'tag'])
        || !isConversationViewerTargetId(payload.commentId)
        || typeof payload.tag !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    return { commentId: payload.commentId, tag: payload.tag };
}

function toProjectCommentErrorCode(
    error: unknown
): ProjectCommentError['code'] {
    return error instanceof ProjectCommentError
        ? error.code
        : 'failed';
}
