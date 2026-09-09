'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    CommentError,
    COMMENT_MAX_ID_LENGTH,
    createCommentValidators,
    fencedQuote,
    graphemeLength,
    isAiSessionProvider,
    isBoundedId,
    isOptionalTimestamp,
    isRecord,
    isTimestamp,
} from './commentPrimitives';

/** File-anchored comments deliberately outlive any individual conversation. */
export const DOCUMENT_COMMENT_LIMITS = Object.freeze({
    maxComments: 100,
    maxIdLength: COMMENT_MAX_ID_LENGTH,
    maxPathLength: 4096,
    maxQuoteGraphemes: 4_000,
    maxContextGraphemes: 480,
    maxCommentGraphemes: 4_000,
    maxHeadingDepth: 20,
    maxHeadingGraphemes: 240,
    maxPromptGraphemes: 16_000,
    // The whole file-backed snapshot is capped at 2 MiB. Keep the per-comment
    // envelope deliberately below that cap even with a full document of
    // comments, rather than accepting values that persistence must reject.
    maxDiscussionReplies: 8,
    maxDiscussionReplyGraphemes: 2_000,
    // The persisted envelope adds target/revision metadata and JSON escaping.
    // Keep the model budget below the 2 MiB file-store boundary so a valid
    // in-memory discussion never turns into an unreadable on-disk snapshot.
    maxSnapshotPayloadBytes: 1_750_000,
    maxLine: 10_000_000,
});

export interface MarkdownDocumentCommentTarget {
    projectId: string;
    /** Opaque Host-derived identity; never an absolute filesystem path. */
    workspaceRootId: string;
    relativePath: string;
}

export type MarkdownDocumentCommentStatus =
    | 'draft' | 'sending' | 'sent' | 'resolved' | 'outdated';

export interface MarkdownDocumentCommentAnchor {
    selectedText: string;
    prefix: string;
    suffix: string;
    headingPath: string[];
    rangeHint?: { startLine: number; endLine: number };
}

export interface MarkdownDocumentCommentConversationRef {
    provider: AiSessionProviderId;
    sessionId: string;
    messageId?: string;
}

/** A bounded AI reply retained with its file comment. The transcript can page
 * old cards out or be recreated; this is the durable document discussion. */
export interface MarkdownDocumentCommentReply {
    messageId: string;
    markdown: string;
    createdAt: number;
    provider?: AiSessionProviderId;
    sessionId?: string;
}

export interface MarkdownDocumentComment {
    id: string;
    documentVersion: string;
    anchor: MarkdownDocumentCommentAnchor;
    text: string;
    status: MarkdownDocumentCommentStatus;
    createdAt: number;
    updatedAt?: number;
    sentAt?: number;
    resolvedAt?: number;
    conversationRef?: MarkdownDocumentCommentConversationRef;
    discussion?: MarkdownDocumentCommentReply[];
}

export interface MarkdownDocumentCommentInput {
    documentVersion: unknown;
    anchor: unknown;
    text: unknown;
}

export class MarkdownDocumentCommentError extends CommentError {
    constructor(code: CommentError['code']) {
        super(code);
        this.name = 'MarkdownDocumentCommentError';
    }
}

const fail = (code: CommentError['code']) =>
    new MarkdownDocumentCommentError(code);
const validators = createCommentValidators(fail);

export function createMarkdownDocumentComment(
    id: string,
    input: MarkdownDocumentCommentInput,
    createdAt: number
): MarkdownDocumentComment {
    if (!isBoundedId(id) || !isTimestamp(createdAt)) {
        throw fail('invalid');
    }
    return {
        id,
        documentVersion: requireDocumentVersion(input?.documentVersion),
        anchor: parseMarkdownDocumentCommentAnchor(input?.anchor),
        text: validators.requireBoundedText(
            input?.text,
            DOCUMENT_COMMENT_LIMITS.maxCommentGraphemes
        ),
        status: 'draft',
        createdAt,
    };
}

export function updateMarkdownDocumentComment(
    comment: MarkdownDocumentComment,
    text: unknown,
    updatedAt: number
): MarkdownDocumentComment {
    validateMarkdownDocumentComment(comment);
    return {
        ...cloneMarkdownDocumentComment(comment),
        text: validators.requireBoundedText(
            text,
            DOCUMENT_COMMENT_LIMITS.maxCommentGraphemes
        ),
        updatedAt: validators.requireTimestamp(updatedAt),
        // An edited sent/outdated note needs an explicit re-send; it is not
        // silently treated as already delivered to an AI session.
        status: comment.status === 'resolved' ? 'resolved' : 'draft',
        ...(comment.status === 'resolved' ? {} : { sentAt: undefined }),
    };
}

export function setMarkdownDocumentCommentStatus(
    comment: MarkdownDocumentComment,
    status: MarkdownDocumentCommentStatus,
    at: number,
    conversationRef?: MarkdownDocumentCommentConversationRef
): MarkdownDocumentComment {
    validateMarkdownDocumentComment(comment);
    if (!isDocumentCommentStatus(status) || !isTimestamp(at)
        || (conversationRef !== undefined
            && !isConversationRef(conversationRef))) {
        throw fail('invalid');
    }
    const next = cloneMarkdownDocumentComment(comment);
    next.status = status;
    if (status === 'sent') {
        next.sentAt = at;
        next.conversationRef = conversationRef
            ? { ...conversationRef } : next.conversationRef;
        delete next.resolvedAt;
    } else if (status === 'resolved') {
        next.resolvedAt = at;
    } else if (status === 'draft' || status === 'sending') {
        delete next.sentAt;
        delete next.resolvedAt;
    } else {
        delete next.resolvedAt;
    }
    return next;
}

export function buildMarkdownDocumentCommentPrompt(
    target: MarkdownDocumentCommentTarget,
    comment: MarkdownDocumentComment
): string {
    validateMarkdownDocumentCommentTarget(target);
    validateMarkdownDocumentComment(comment);
    const heading = comment.anchor.headingPath.length
        ? comment.anchor.headingPath.join(' > ')
        : '（未解析章节）';
    const prompt = [
        '请审阅下面这条 Markdown 文件批注。请围绕指定片段回答；若需要改写，先提出局部修改建议，不要直接假定文件已被写入。',
        '',
        `文件：${target.relativePath}`,
        `文件版本：${comment.documentVersion}`,
        `章节：${heading}`,
        '引用原文：',
        fencedQuote(comment.anchor.selectedText),
        ...(comment.anchor.prefix || comment.anchor.suffix ? [
            '邻近上下文：',
            fencedQuote([
                comment.anchor.prefix,
                comment.anchor.selectedText,
                comment.anchor.suffix,
            ].filter(Boolean).join('')),
        ] : []),
        '用户评论：',
        comment.text,
        `markdown-document-comment-id:${comment.id}`,
        '',
        '如果建议修改，请在回复末尾单独输出一个 markdown-suggestion fenced block，'
            + '其中 JSON 只能包含 selectedText 和 replacement；不要声称已写入文件。格式为：',
        '```markdown-suggestion',
        '{"selectedText":"引用原文的精确文本","replacement":"建议替换后的 Markdown"}',
        '```',
    ].join('\n');
    if (graphemeLength(prompt) > DOCUMENT_COMMENT_LIMITS.maxPromptGraphemes) {
        throw fail('tooLarge');
    }
    return prompt;
}

export function cloneMarkdownDocumentComment(
    comment: MarkdownDocumentComment
): MarkdownDocumentComment {
    return {
        ...comment,
        anchor: {
            ...comment.anchor,
            headingPath: [...comment.anchor.headingPath],
            ...(comment.anchor.rangeHint
                ? { rangeHint: { ...comment.anchor.rangeHint } } : {}),
        },
        ...(comment.conversationRef
            ? { conversationRef: { ...comment.conversationRef } } : {}),
        ...(comment.discussion ? {
            discussion: comment.discussion.map(reply => ({ ...reply })),
        } : {}),
    };
}

export function cloneMarkdownDocumentComments(
    comments: readonly MarkdownDocumentComment[]
): MarkdownDocumentComment[] {
    return comments.map(cloneMarkdownDocumentComment);
}

export function validateMarkdownDocumentComments(
    comments: readonly MarkdownDocumentComment[]
): void {
    if (!Array.isArray(comments)
        || comments.length > DOCUMENT_COMMENT_LIMITS.maxComments) {
        throw fail('invalid');
    }
    const ids = new Set<string>();
    comments.forEach(comment => {
        validateMarkdownDocumentComment(comment);
        if (ids.has(comment.id)) { throw fail('invalid'); }
        ids.add(comment.id);
    });
    if (Buffer.byteLength(JSON.stringify(comments), 'utf8')
        > DOCUMENT_COMMENT_LIMITS.maxSnapshotPayloadBytes) {
        throw fail('tooLarge');
    }
}

export function validateMarkdownDocumentCommentTarget(
    target: unknown
): asserts target is MarkdownDocumentCommentTarget {
    if (!isMarkdownDocumentCommentTarget(target)) { throw fail('invalid'); }
}

export function isMarkdownDocumentCommentTarget(
    value: unknown
): value is MarkdownDocumentCommentTarget {
    return isRecord(value)
        && isBoundedId(value.projectId)
        && isBoundedId(value.workspaceRootId)
        && typeof value.relativePath === 'string'
        && value.relativePath.length > 0
        && value.relativePath.length <= DOCUMENT_COMMENT_LIMITS.maxPathLength
        && !/^[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(value.relativePath)
        && !/[\u0000-\u001f\u007f]/.test(value.relativePath);
}

export function validateMarkdownDocumentComment(
    comment: unknown
): asserts comment is MarkdownDocumentComment {
    if (!isRecord(comment)
        || !isBoundedId(comment.id)
        || !isDocumentCommentStatus(comment.status)
        || !isTimestamp(comment.createdAt)
        || !isOptionalTimestamp(comment.updatedAt)
        || !isOptionalTimestamp(comment.sentAt)
        || !isOptionalTimestamp(comment.resolvedAt)
        || (comment.conversationRef !== undefined
            && !isConversationRef(comment.conversationRef))
        || (comment.discussion !== undefined && !isDiscussion(comment.discussion))) {
        throw fail('invalid');
    }
    requireDocumentVersion(comment.documentVersion);
    parseMarkdownDocumentCommentAnchor(comment.anchor);
    validators.requireBoundedText(
        comment.text,
        DOCUMENT_COMMENT_LIMITS.maxCommentGraphemes
    );
}

function isDiscussion(value: unknown): value is MarkdownDocumentCommentReply[] {
    if (!Array.isArray(value) || value.length > DOCUMENT_COMMENT_LIMITS.maxDiscussionReplies) {
        return false;
    }
    const ids = new Set<string>();
    return value.every(reply => isRecord(reply)
        && isBoundedId(reply.messageId)
        && !ids.has(discussionReplyIdentity(reply))
        && (ids.add(discussionReplyIdentity(reply)), true)
        && typeof reply.markdown === 'string'
        && graphemeLength(reply.markdown) > 0
        && graphemeLength(reply.markdown) <= DOCUMENT_COMMENT_LIMITS.maxDiscussionReplyGraphemes
        && (reply.provider === undefined || isAiSessionProvider(reply.provider))
        && (reply.sessionId === undefined || isBoundedId(reply.sessionId))
        && isTimestamp(reply.createdAt));
}

function discussionReplyIdentity(reply: Record<string, unknown>): string {
    return [reply.provider || '', reply.sessionId || '', reply.messageId || ''].join('\u0001');
}

function requireDocumentVersion(value: unknown): string {
    if (typeof value !== 'string' || !value
        || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw fail('invalid');
    }
    return value;
}

function parseMarkdownDocumentCommentAnchor(
    value: unknown
): MarkdownDocumentCommentAnchor {
    if (!isRecord(value) || !Array.isArray(value.headingPath)) {
        throw fail('invalid');
    }
    if (value.headingPath.length > DOCUMENT_COMMENT_LIMITS.maxHeadingDepth) {
        throw fail('invalid');
    }
    const headingPath = value.headingPath.map(heading =>
        validators.requireBoundedText(
            heading,
            DOCUMENT_COMMENT_LIMITS.maxHeadingGraphemes
        )
    );
    const anchor: MarkdownDocumentCommentAnchor = {
        selectedText: validators.requireBoundedText(
            value.selectedText,
            DOCUMENT_COMMENT_LIMITS.maxQuoteGraphemes
        ),
        prefix: validators.optionalBoundedText(
            value.prefix,
            DOCUMENT_COMMENT_LIMITS.maxContextGraphemes
        ),
        suffix: validators.optionalBoundedText(
            value.suffix,
            DOCUMENT_COMMENT_LIMITS.maxContextGraphemes
        ),
        headingPath,
    };
    if (value.rangeHint !== undefined) {
        if (!isRecord(value.rangeHint)
            || !isBoundedLine(value.rangeHint.startLine)
            || !isBoundedLine(value.rangeHint.endLine)
            || value.rangeHint.endLine < value.rangeHint.startLine) {
            throw fail('invalid');
        }
        anchor.rangeHint = {
            startLine: value.rangeHint.startLine,
            endLine: value.rangeHint.endLine,
        };
    }
    return anchor;
}

function isBoundedLine(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && value >= 1 && value <= DOCUMENT_COMMENT_LIMITS.maxLine;
}

function isDocumentCommentStatus(
    value: unknown
): value is MarkdownDocumentCommentStatus {
    return value === 'draft' || value === 'sending' || value === 'sent'
        || value === 'resolved' || value === 'outdated';
}

function isConversationRef(
    value: unknown
): value is MarkdownDocumentCommentConversationRef {
    return isRecord(value)
        && isAiSessionProvider(value.provider)
        && isBoundedId(value.sessionId)
        && (value.messageId === undefined || isBoundedId(value.messageId));
}
