'use strict';

import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import type { CommentErrorCode, CommentStatus } from './commentPrimitives';
import { CommentError } from './commentPrimitives';
import type { CommentSnapshot } from './snapshotFileStore';
import type { ConversationViewerTarget } from './viewerTarget';

/**
 * Shared resilience protocol for the comment-stack controllers: serialized
 * operations, optimistic revisions, persist → commit → rollback, idempotent
 * settlements with replay, and a rebuild fallback when the webview goes
 * away. Each stack supplies its model operations through the abstract
 * hooks; everything else lives here exactly once.
 */

export interface QueuedCommentRequestBase {
    type: string;
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: string;
    expectedRevision: number;
    payload: unknown;
}

export interface QueuedCommentResultBase<TComment> {
    type: string;
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: string;
    success: boolean;
    revision: number;
    comments: TComment[];
    error?: CommentErrorCode;
}

export interface QueuedCommentControllerOptions {
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

interface CommentSnapshotStore<TStoreTarget, TComment> {
    load(target: TStoreTarget): Promise<CommentSnapshot<TComment>>;
    save(
        target: TStoreTarget,
        snapshot: CommentSnapshot<TComment>
    ): Promise<void>;
}

export abstract class QueuedCommentController<
    TComment extends { id: string; status: CommentStatus },
    TStoreTarget,
    TRequest extends QueuedCommentRequestBase,
    TResult extends QueuedCommentResultBase<TComment>
> {
    private comments: TComment[] = [];
    private revision = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements = new Map<string, TResult>();

    constructor(
        protected readonly options: QueuedCommentControllerOptions
    ) {}

    protected now(): number {
        return this.options.now?.() ?? Date.now();
    }

    get snapshot(): CommentSnapshot<TComment> {
        return {
            revision: this.revision,
            comments: this.cloneComments(this.comments),
        };
    }

    reset(): void {
        this.comments = [];
        this.revision = 0;
        this.settlements.clear();
        this.onReset();
    }

    async drainMutations(): Promise<void> {
        await this.operationQueue;
    }

    enqueue(request: TRequest): Promise<void> {
        return this.enqueueTask(() => this.handleOperation(request));
    }

    /** Serializes an arbitrary task behind the queued mutations. */
    protected enqueueTask(operation: () => Promise<void>): Promise<void> {
        const queued = this.operationQueue.then(operation, operation);
        this.operationQueue = queued.catch(() => undefined);
        return queued;
    }

    async restore(
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        const store = this.getStore();
        if (!store) {
            return;
        }
        let snapshot: CommentSnapshot<TComment>;
        try {
            snapshot = await store.load(this.toStoreTarget(target));
            this.validateComments(snapshot.comments);
            if (!Number.isSafeInteger(snapshot.revision)
                || snapshot.revision < 0) {
                throw this.makeError('invalid');
            }
        } catch (_error) {
            return;
        }
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation) {
            return;
        }
        this.comments = this.cloneComments(snapshot.comments);
        this.revision = snapshot.revision;
    }

    private async handleOperation(request: TRequest): Promise<void> {
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
                        comments: this.cloneComments(this.comments),
                        error: 'invalid',
                    } as TResult,
                false
            );
            return;
        }
        if (this.isMutationsFrozen()
            || !requestTargetsViewer(
                request,
                target,
                this.options.getSubscriptionGeneration()
            )
            || request.expectedRevision !== this.revision) {
            await this.settleRequest(request, false, 'stale');
            return;
        }
        try {
            if (this.isSendRequest(request)) {
                await this.sendComments(
                    target,
                    this.options.getSubscriptionGeneration(),
                    this.sendCommentId(request)
                );
            } else {
                await this.mutateComments(
                    request,
                    target,
                    this.options.getSubscriptionGeneration()
                );
            }
            await this.settleRequest(request, true);
            if (this.isSendRequest(request)) {
                await this.focusSessionAfterSend(target);
            }
        } catch (error) {
            await this.settleRequest(
                request,
                false,
                this.toErrorCode(error)
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
            // The prompt is already staged and settled. Focus failure must
            // not encourage a retry that stages the same batch twice.
        }
    }

    private async mutateComments(
        request: TRequest,
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        const { comments, changed } = this.applyMutation(request);
        if (!changed) {
            // A no-op mutation (e.g. adding a duplicate tag) still settles
            // successfully, just without touching the persisted snapshot.
            return;
        }
        const snapshot = { revision: this.revision + 1, comments };
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
            throw this.makeError('stale');
        }
        const prompt = this.buildSendPrompt(targetComments, Boolean(commentId));
        const previousSnapshot = this.snapshot;
        const sentSnapshot = {
            revision: this.revision + 1,
            comments: this.buildSendComments(targetComments, target),
        };
        await this.persist(target, sentSnapshot);
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== previousSnapshot.revision) {
            await this.persist(target, previousSnapshot);
            throw this.makeError('stale');
        }
        try {
            await Promise.resolve(this.options.submitPrompt(
                { ...target },
                prompt
            ));
        } catch (error) {
            await this.persist(target, previousSnapshot);
            // submitPrompt surfaces submission.ts failures; both stacks'
            // error classes share the CommentError base, so user-actionable
            // codes survive the cross-stack hop.
            throw error instanceof CommentError
                ? this.makeError(error.code)
                : this.makeError('failed');
        }
        if (this.options.getTarget() !== target) {
            throw this.makeError('stale');
        }
        this.comments = sentSnapshot.comments;
        this.revision = sentSnapshot.revision;
    }

    private async persist(
        target: ConversationViewerTarget,
        snapshot: CommentSnapshot<TComment>
    ): Promise<void> {
        const store = this.getStore();
        if (!store) {
            return;
        }
        try {
            await store.save(this.toStoreTarget(target), snapshot);
        } catch (_error) {
            throw this.makeError('failed');
        }
    }

    private commitPersisted(
        target: ConversationViewerTarget,
        generation: number,
        expectedRevision: number,
        snapshot: CommentSnapshot<TComment>
    ): void {
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== expectedRevision) {
            throw this.makeError('stale');
        }
        this.comments = snapshot.comments;
        this.revision = snapshot.revision;
    }

    private async settleRequest(
        request: TRequest,
        success: boolean,
        error?: CommentErrorCode
    ): Promise<void> {
        const settlement = {
            type: this.resultType,
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: request.operation,
            success,
            revision: this.revision,
            comments: this.cloneComments(this.comments),
            ...(error ? { error } : {}),
        } as TResult;
        this.rememberSettlement(getSettlementKey(request), settlement);
        await this.publishSettlement(settlement, true);
    }

    private rememberSettlement(key: string, settlement: TResult): void {
        this.settlements.set(key, settlement);
        while (this.settlements.size > 100) {
            const oldest = this.settlements.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            this.settlements.delete(oldest);
        }
    }

    protected async publishSettlement(
        settlement: object,
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

    protected toErrorCode(error: unknown): CommentErrorCode {
        return error instanceof CommentError
            ? error.code
            : 'failed';
    }

    /** Read-only view for subclass mutation branches. */
    protected get currentComments(): readonly TComment[] {
        return this.comments;
    }

    /** Hook for subclass state cleared alongside the base state. */
    protected onReset(): void {}

    /** Frozen stacks reject mutations as 'stale' (session rebind windows). */
    protected isMutationsFrozen(): boolean {
        return false;
    }

    protected abstract readonly resultType: TResult['type'];

    protected abstract getStore():
        CommentSnapshotStore<TStoreTarget, TComment> | undefined;

    protected abstract toStoreTarget(
        target: ConversationViewerTarget
    ): TStoreTarget;

    protected abstract cloneComments(
        comments: readonly TComment[]
    ): TComment[];

    protected abstract validateComments(
        comments: readonly TComment[]
    ): void;

    protected abstract makeError(code: CommentErrorCode): CommentError;

    protected abstract isSendRequest(request: TRequest): boolean;

    /** The single-send target id, or undefined for a batch send. */
    protected abstract sendCommentId(request: TRequest): string | undefined;

    /**
     * Pure mutation branch: starts from a clone of the current comments and
     * reports whether anything actually changed.
     */
    protected abstract applyMutation(
        request: TRequest
    ): { comments: TComment[]; changed: boolean };

    protected abstract buildSendPrompt(
        targetComments: readonly TComment[],
        single: boolean
    ): string;

    /** The post-send comment list (done-marking, dispatch recording, …). */
    protected abstract buildSendComments(
        targetComments: readonly TComment[],
        target: ConversationViewerTarget
    ): TComment[];
}

function requestTargetsViewer(
    request: QueuedCommentRequestBase,
    target: ConversationViewerTarget,
    subscriptionGeneration: number
): boolean {
    return request.subscriptionGeneration === subscriptionGeneration
        && request.projectId === target.projectId
        && request.provider === target.provider
        && request.sessionId === target.sessionId;
}

function getSettlementKey(request: QueuedCommentRequestBase): string {
    return JSON.stringify([
        request.projectId,
        request.provider,
        request.sessionId,
        request.requestId,
    ]);
}
