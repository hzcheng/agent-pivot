'use strict';

import type { CommentErrorCode, CommentStatus } from './commentPrimitives';
import { CommentError } from './commentPrimitives';
import {
    QueuedMutationController,
    QueuedMutationControllerOptions,
    QueuedMutationRequestBase,
    QueuedMutationResultBase,
} from './queuedMutationController';
import type { CommentSnapshot } from './snapshotFileStore';
import type { ConversationViewerTarget } from './viewerTarget';

/**
 * Comment-stack specialization of the queued mutation pipeline: adds the
 * mutate/send choreography (prompt building, done-marking or dispatch
 * recording, submit rollback, focus-after-send) on top of the shared
 * serialized operations, optimistic revisions, and idempotent settlements.
 * Each comment stack supplies its model operations through the abstract
 * hooks; everything else lives here exactly once.
 */

export interface QueuedCommentRequestBase extends QueuedMutationRequestBase {}

export interface QueuedCommentResultBase<TComment>
    extends QueuedMutationResultBase {
    comments: TComment[];
}

export interface QueuedCommentControllerOptions
    extends QueuedMutationControllerOptions {
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
}

export abstract class QueuedCommentController<
    TComment extends { id: string; status: CommentStatus },
    TStoreTarget,
    TRequest extends QueuedCommentRequestBase,
    TResult extends QueuedCommentResultBase<TComment>
> extends QueuedMutationController<
    TStoreTarget,
    CommentSnapshot<TComment>,
    TRequest,
    TResult
> {
    private comments: TComment[] = [];

    constructor(
        protected readonly options: QueuedCommentControllerOptions
    ) {
        super(options);
    }

    /** Read-only view for subclass mutation branches. */
    protected get currentComments(): readonly TComment[] {
        return this.comments;
    }

    protected clearState(): void {
        this.comments = [];
    }

    protected statePayload(): object {
        return { comments: this.cloneComments(this.comments) };
    }

    protected validateRestoredSnapshot(
        snapshot: CommentSnapshot<TComment>
    ): boolean {
        try {
            this.validateComments(snapshot.comments);
            return Number.isSafeInteger(snapshot.revision)
                && snapshot.revision >= 0;
        } catch (_error) {
            return false;
        }
    }

    protected applyRestoredSnapshot(
        snapshot: CommentSnapshot<TComment>
    ): void {
        this.comments = this.cloneComments(snapshot.comments);
    }

    protected async performRequest(
        request: TRequest,
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        if (this.isSendRequest(request)) {
            await this.sendComments(
                target,
                generation,
                this.sendCommentId(request)
            );
            return;
        }
        await this.mutateComments(request, target, generation);
    }

    protected async afterSuccessful(
        request: TRequest,
        target: ConversationViewerTarget
    ): Promise<void> {
        if (this.isSendRequest(request)) {
            await this.focusSessionAfterSend(target);
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
        const mutation = this.applyMutation(request);
        if (!mutation.changed) {
            // A no-op mutation (e.g. adding a duplicate tag) still settles
            // successfully, just without touching the persisted snapshot.
            return;
        }
        const snapshot = {
            revision: this.revision + 1,
            comments: mutation.comments,
        };
        const previousSnapshot = this.snapshot;
        await this.persist(target, snapshot);
        try {
            this.assertUnchanged(
                target,
                generation,
                request.expectedRevision
            );
        } catch (error) {
            await this.persist(target, previousSnapshot);
            throw error;
        }
        this.comments = snapshot.comments;
        this.revision = snapshot.revision;
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
        try {
            this.assertUnchanged(
                target,
                generation,
                previousSnapshot.revision
            );
        } catch (error) {
            await this.persist(target, previousSnapshot);
            throw error;
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
            throw this.makeError(this.toErrorCode(error));
        }
        if (this.options.getTarget() !== target) {
            throw this.makeError('stale');
        }
        this.comments = sentSnapshot.comments;
        this.revision = sentSnapshot.revision;
    }

    protected abstract cloneComments(
        comments: readonly TComment[]
    ): TComment[];

    protected abstract validateComments(
        comments: readonly TComment[]
    ): void;

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
