'use strict';

import { randomBytes } from 'crypto';
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
import type { CommentErrorCode } from './commentPrimitives';
import type { ProjectCommentSnapshot, ProjectCommentStore } from './projectCommentStore';
import {
    QueuedCommentController,
    QueuedCommentControllerOptions,
    QueuedCommentResultBase,
} from './queuedCommentController';
import type { ConversationViewerTarget } from './viewerTarget';
import {
    ConversationViewerProjectCommentMutationMessage,
    ConversationViewerSendProjectCommentMessage,
    hasExactKeys,
    isConversationViewerTargetId,
} from './viewerProtocol';
import { isRecord } from './commentPrimitives';

interface ConversationViewerProjectCommentsResultMessage
    extends QueuedCommentResultBase<ProjectComment> {
    type: 'conversation-viewer-project-comments-result';
    operation: ConversationViewerProjectCommentMutationMessage['operation']
        | 'sendProjectComment'
        | 'sendProjectComments';
}

type ProjectCommentRequest = ConversationViewerProjectCommentMutationMessage
    | ConversationViewerSendProjectCommentMessage;

export interface ProjectCommentControllerOptions
    extends QueuedCommentControllerOptions {
    projectCommentStore?: ProjectCommentStore;
}

export class ProjectCommentController extends QueuedCommentController<
    ProjectComment,
    ProjectCommentTarget,
    ProjectCommentRequest,
    ConversationViewerProjectCommentsResultMessage
> {
    protected readonly options: ProjectCommentControllerOptions;

    constructor(options: ProjectCommentControllerOptions) {
        super(options);
        this.options = options;
    }

    protected readonly resultType
        : 'conversation-viewer-project-comments-result'
        = 'conversation-viewer-project-comments-result';

    protected getStore(): ProjectCommentStore | undefined {
        return this.options.projectCommentStore;
    }

    protected toStoreTarget(
        target: ConversationViewerTarget
    ): ProjectCommentTarget {
        return { projectId: target.projectId };
    }

    protected cloneComments(
        comments: readonly ProjectComment[]
    ): ProjectComment[] {
        return cloneProjectComments(comments);
    }

    protected validateComments(
        comments: readonly ProjectComment[]
    ): void {
        validateProjectComments(comments);
    }

    protected makeError(code: CommentErrorCode): ProjectCommentError {
        return new ProjectCommentError(code);
    }

    protected isSendRequest(request: ProjectCommentRequest): boolean {
        return request.type === 'conversation-viewer-send-project-comment';
    }

    protected sendCommentId(
        request: ProjectCommentRequest
    ): string | undefined {
        return request.type === 'conversation-viewer-send-project-comment'
            && request.operation === 'sendProjectComment'
            ? parseCommentIdPayload(request.payload).commentId
            : undefined;
    }

    protected applyMutation(
        request: ConversationViewerProjectCommentMutationMessage
    ): { comments: ProjectComment[]; changed: boolean } {
        let comments = cloneProjectComments(this.currentComments);
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
            return { comments, changed: true };
        }
        if (request.operation === 'reorder') {
            const orderedCommentIds = parseReorderPayload(request.payload);
            const reordered = reorderProjectComments(
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
                throw new ProjectCommentError('invalid');
            }
            const remainingComments = clearProjectComments(
                comments,
                request.operation
            );
            const changed = remainingComments.length !== comments.length;
            return { comments: changed ? remainingComments : comments, changed };
        }
        if (request.operation === 'delete') {
            const payload = parseCommentIdPayload(request.payload);
            const index = comments.findIndex(
                comment => comment.id === payload.commentId
            );
            if (index < 0) {
                throw new ProjectCommentError('stale');
            }
            comments.splice(index, 1);
            return { comments, changed: true };
        }
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
        if (JSON.stringify(next) === JSON.stringify(current)) {
            return { comments, changed: false };
        }
        comments[index] = next;
        return { comments, changed: true };
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

    protected buildSendPrompt(
        targetComments: readonly ProjectComment[],
        single: boolean
    ): string {
        return single
            ? buildProjectCommentPrompt(targetComments[0])
            : buildProjectCommentsPrompt(targetComments);
    }

    protected buildSendComments(
        targetComments: readonly ProjectComment[],
        target: ConversationViewerTarget
    ): ProjectComment[] {
        // Dispatch is recorded without closing the note: workspace notes
        // stay open until deliberately toggled done.
        const sentIds = new Set(targetComments.map(comment => comment.id));
        return this.currentComments.map(candidate =>
            sentIds.has(candidate.id)
                ? recordProjectCommentDispatch(candidate, {
                    provider: target.provider,
                    sessionId: target.sessionId,
                    at: this.now(),
                })
                : candidate
        );
    }
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
