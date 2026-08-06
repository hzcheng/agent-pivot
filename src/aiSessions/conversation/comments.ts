'use strict';

import type { AiSessionProviderId } from '../../models';
import type { ConversationMessage } from './types';

export const CONVERSATION_COMMENT_LIMITS = Object.freeze({
    maxComments: 20,
    maxIdLength: 512,
    maxQuoteGraphemes: 4_000,
    maxContextGraphemes: 240,
    maxCommentGraphemes: 4_000,
    maxPromptGraphemes: 32_000,
});

export interface ConversationCommentTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ConversationCommentDraft {
    id: string;
    scope?: 'session';
    messageId: string;
    interactionId: string;
    role: ConversationMessage['role'];
    quote: string;
    prefix: string;
    suffix: string;
    comment: string;
    status: ConversationCommentStatus;
    createdAt?: number;
    sentAt?: number;
}

export type ConversationCommentStatus = 'open' | 'done';

export interface ConversationCommentSelection {
    scope: 'selection';
    messageId: string;
    interactionId: string;
    quote: string;
    prefix: string;
    suffix: string;
    comment: string;
}

export interface ConversationCommentSessionNote {
    scope: 'session';
    comment: string;
}

export type ConversationCommentOperation =
    'add' | 'update' | 'delete' | 'reorder' | 'clearDone' | 'clearAll'
    | 'sendComments' | 'sendComment';

export type ConversationCommentClearOperation =
    'clearDone' | 'clearAll';

export class ConversationCommentError extends Error {
    constructor(
        readonly code: 'invalid' | 'stale' | 'limit' | 'tooLarge'
            | 'unavailable' | 'busy' | 'conflict' | 'failed'
    ) {
        super(code);
        this.name = 'ConversationCommentError';
    }
}

export function createConversationComment(
    id: string,
    selection: ConversationCommentSelection,
    message: ConversationMessage
): ConversationCommentDraft {
    if (!isBoundedId(id)
        || !isBoundedId(selection?.messageId)
        || !isBoundedId(selection?.interactionId)
        || selection.messageId !== message?.id
        || selection.interactionId !== message?.interactionId) {
        throw new ConversationCommentError('invalid');
    }
    return {
        id,
        messageId: message.id,
        interactionId: message.interactionId,
        role: message.role === 'progress' ? 'assistant' : message.role,
        quote: requireBoundedText(
            selection.quote,
            CONVERSATION_COMMENT_LIMITS.maxQuoteGraphemes
        ),
        prefix: optionalBoundedText(
            selection.prefix,
            CONVERSATION_COMMENT_LIMITS.maxContextGraphemes
        ),
        suffix: optionalBoundedText(
            selection.suffix,
            CONVERSATION_COMMENT_LIMITS.maxContextGraphemes
        ),
        comment: requireBoundedText(
            selection.comment,
            CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
        ),
        status: 'open',
    };
}

export function createConversationSessionComment(
    id: string,
    comment: unknown
): ConversationCommentDraft {
    if (!isBoundedId(id)) {
        throw new ConversationCommentError('invalid');
    }
    return {
        id,
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: requireBoundedText(
            comment,
            CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
        ),
        status: 'open',
    };
}

export function updateConversationComment(
    draft: ConversationCommentDraft,
    comment: unknown
): ConversationCommentDraft {
    const text = requireBoundedText(
        comment,
        CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
    );
    if (draft.status !== 'done') {
        return { ...draft, comment: text };
    }
    // Editing a done comment re-opens it so it can be sent again: the stale
    // send timestamp is dropped while the creation timestamp is preserved.
    const { sentAt: _sentAt, ...reopened } = draft;
    return { ...reopened, comment: text, status: 'open' };
}

export function markConversationCommentsDone(
    comments: readonly ConversationCommentDraft[],
    sentAt: number,
    onlyIds?: ReadonlySet<string>
): ConversationCommentDraft[] {
    return comments.map(comment => {
        validateDraft(comment);
        return comment.status === 'open'
            && (!onlyIds || onlyIds.has(comment.id))
            ? { ...comment, status: 'done', sentAt }
            : { ...comment };
    });
}

export function clearConversationComments(
    comments: readonly ConversationCommentDraft[],
    operation: ConversationCommentClearOperation
): ConversationCommentDraft[] {
    if (!Array.isArray(comments)
        || (operation !== 'clearDone' && operation !== 'clearAll')) {
        throw new ConversationCommentError('invalid');
    }
    return comments.filter(comment => {
        validateDraft(comment);
        return operation === 'clearAll' ? false : comment.status !== 'done';
    }).map(comment => ({ ...comment }));
}

export function reorderConversationComments(
    comments: readonly ConversationCommentDraft[],
    orderedCommentIds: readonly string[]
): ConversationCommentDraft[] {
    validateConversationComments(comments);
    if (!Array.isArray(orderedCommentIds)
        || orderedCommentIds.length !== comments.length) {
        throw new ConversationCommentError('invalid');
    }
    const commentsById = new Map(
        comments.map(comment => [comment.id, comment] as const)
    );
    const seen = new Set<string>();
    const reordered = orderedCommentIds.map(commentId => {
        if (typeof commentId !== 'string'
            || seen.has(commentId)
            || !commentsById.has(commentId)) {
            throw new ConversationCommentError('invalid');
        }
        seen.add(commentId);
        return { ...commentsById.get(commentId)! };
    });
    if (seen.size !== commentsById.size) {
        throw new ConversationCommentError('invalid');
    }
    return reordered;
}

export function buildConversationCommentsPrompt(
    comments: readonly ConversationCommentDraft[]
): string {
    if (!Array.isArray(comments)
        || comments.length < 1
        || comments.length > CONVERSATION_COMMENT_LIMITS.maxComments) {
        throw new ConversationCommentError('invalid');
    }
    const sections = comments.map((draft, index) => {
        validateDraft(draft);
        if (draft.scope === 'session') {
            return [
                `[批注 ${index + 1}]`,
                '范围：当前 Session',
                '我的问题或要求：',
                draft.comment,
            ].join('\n');
        }
        return [
            `[批注 ${index + 1}]`,
            `对话角色：${draft.role === 'user' ? '用户' : 'AI 助手'}`,
            '选中原文：',
            fencedQuote(draft.quote),
            '我的问题或要求：',
            draft.comment,
        ].join('\n');
    });
    const separatedSections: string[] = [];
    sections.forEach((section, index) => {
        separatedSections.push(section);
        if (index !== sections.length - 1) {
            separatedSections.push('');
        }
    });
    const prompt = [
        '请处理下面这些针对当前对话的批注。请逐项回应，保留批注编号；如果批注要求修改代码，请直接检查当前工作区并完成相应修改与验证。',
        '',
        ...separatedSections,
    ].join('\n');
    if (graphemeLength(prompt)
        > CONVERSATION_COMMENT_LIMITS.maxPromptGraphemes) {
        throw new ConversationCommentError('tooLarge');
    }
    return prompt;
}

export function cloneConversationComments(
    comments: readonly ConversationCommentDraft[]
): ConversationCommentDraft[] {
    return comments.map(comment => ({ ...comment }));
}

export function validateConversationComments(
    comments: readonly ConversationCommentDraft[]
): void {
    if (!Array.isArray(comments)
        || comments.length > CONVERSATION_COMMENT_LIMITS.maxComments) {
        throw new ConversationCommentError('invalid');
    }
    const ids = new Set<string>();
    comments.forEach(comment => {
        validateDraft(comment);
        if (ids.has(comment.id)) {
            throw new ConversationCommentError('invalid');
        }
        ids.add(comment.id);
    });
}

function validateDraft(draft: ConversationCommentDraft): void {
    if (!draft || !isBoundedId(draft.id)
        || (draft.scope !== undefined && draft.scope !== 'session')
        || (draft.status !== 'open' && draft.status !== 'done')
        || !isOptionalTimestamp(draft.createdAt)
        || !isOptionalTimestamp(draft.sentAt)) {
        throw new ConversationCommentError('invalid');
    }
    if (draft.scope === 'session') {
        if (draft.messageId !== ''
            || draft.interactionId !== ''
            || draft.role !== 'user'
            || draft.quote !== ''
            || draft.prefix !== ''
            || draft.suffix !== '') {
            throw new ConversationCommentError('invalid');
        }
        requireBoundedText(
            draft.comment,
            CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
        );
        return;
    }
    if (!isBoundedId(draft.messageId)
        || !isBoundedId(draft.interactionId)
        || (draft.role !== 'user' && draft.role !== 'assistant')) {
        throw new ConversationCommentError('invalid');
    }
    requireBoundedText(
        draft.quote,
        CONVERSATION_COMMENT_LIMITS.maxQuoteGraphemes
    );
    optionalBoundedText(
        draft.prefix,
        CONVERSATION_COMMENT_LIMITS.maxContextGraphemes
    );
    optionalBoundedText(
        draft.suffix,
        CONVERSATION_COMMENT_LIMITS.maxContextGraphemes
    );
    requireBoundedText(
        draft.comment,
        CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
    );
}

function requireBoundedText(value: unknown, max: number): string {
    if (typeof value !== 'string') {
        throw new ConversationCommentError('invalid');
    }
    const normalized = value.replace(/\r\n?/g, '\n').trim();
    if (!normalized || graphemeLength(normalized) > max) {
        throw new ConversationCommentError('invalid');
    }
    return normalized;
}

function optionalBoundedText(value: unknown, max: number): string {
    if (typeof value !== 'string') {
        throw new ConversationCommentError('invalid');
    }
    const normalized = value.replace(/\r\n?/g, '\n');
    if (graphemeLength(normalized) > max) {
        throw new ConversationCommentError('invalid');
    }
    return normalized;
}

function isOptionalTimestamp(value: unknown): boolean {
    return value === undefined
        || (typeof value === 'number'
            && Number.isSafeInteger(value)
            && value >= 0);
}

function graphemeLength(value: string): number {
    return Array.from(value).length;
}

function isBoundedId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= CONVERSATION_COMMENT_LIMITS.maxIdLength
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function fencedQuote(value: string): string {
    const matches = value.match(/`+/g) || [];
    const fenceLength = matches.reduce(
        (length, match) => Math.max(length, match.length + 1),
        3
    );
    const fence = '`'.repeat(fenceLength);
    return `${fence}text\n${value}\n${fence}`;
}
