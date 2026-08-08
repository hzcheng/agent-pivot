'use strict';

import type { AiSessionProviderId } from '../../models';
import type { ConversationMessage } from './types';
import {
    assertValidCommentTags,
    clearCommentsByStatus,
    CommentError,
    CommentStatus,
    COMMENT_MAX_ID_LENGTH,
    createCommentValidators,
    fencedQuote,
    graphemeLength,
    hasCommentTag,
    isBoundedId,
    isOptionalTimestamp,
    reorderCommentsByIds,
    withCommentTag,
    withoutCommentTag,
} from './commentPrimitives';

export const CONVERSATION_COMMENT_LIMITS = Object.freeze({
    maxComments: 20,
    maxIdLength: COMMENT_MAX_ID_LENGTH,
    maxQuoteGraphemes: 4_000,
    maxContextGraphemes: 240,
    maxCommentGraphemes: 4_000,
    maxPromptGraphemes: 32_000,
    maxTagsPerComment: 5,
    maxTagGraphemes: 24,
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
    tags?: string[];
    createdAt?: number;
    sentAt?: number;
}

export type ConversationCommentStatus = CommentStatus;

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

export const CONVERSATION_COMMENT_MUTATION_OPERATIONS = Object.freeze([
    'add', 'update', 'delete', 'reorder', 'clearDone', 'clearAll',
    'addTag', 'removeTag',
] as const);

export type ConversationCommentMutationOperation =
    typeof CONVERSATION_COMMENT_MUTATION_OPERATIONS[number];

export const CONVERSATION_COMMENT_SEND_OPERATIONS = Object.freeze([
    'sendComments', 'sendComment',
] as const);

export type ConversationCommentSendOperation =
    typeof CONVERSATION_COMMENT_SEND_OPERATIONS[number];

export type ConversationCommentOperation =
    ConversationCommentMutationOperation | ConversationCommentSendOperation;

export type ConversationCommentClearOperation =
    'clearDone' | 'clearAll';

export class ConversationCommentError extends CommentError {
    constructor(code: CommentError['code']) {
        super(code);
        this.name = 'ConversationCommentError';
    }
}

const commentValidators = createCommentValidators(
    code => new ConversationCommentError(code)
);
const requireBoundedText = commentValidators.requireBoundedText;
const optionalBoundedText = commentValidators.optionalBoundedText;
const normalizeCommentTag = commentValidators.normalizeTag;

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
    return clearCommentsByStatus({
        comments,
        operation,
        validateKept: validateDraft,
        clone: comment => ({ ...comment }),
        fail: code => new ConversationCommentError(code),
    });
}

export function reorderConversationComments(
    comments: readonly ConversationCommentDraft[],
    orderedCommentIds: readonly string[]
): ConversationCommentDraft[] {
    return reorderCommentsByIds({
        comments,
        orderedCommentIds,
        validate: validateConversationComments,
        fail: code => new ConversationCommentError(code),
    });
}

export function addConversationCommentTag(
    draft: ConversationCommentDraft,
    tag: unknown
): ConversationCommentDraft {
    const normalized = normalizeCommentTag(
        tag,
        CONVERSATION_COMMENT_LIMITS.maxTagGraphemes
    );
    const tags = draft.tags ?? [];
    return {
        ...draft,
        tags: withCommentTag(
            tags,
            normalized,
            CONVERSATION_COMMENT_LIMITS.maxTagsPerComment,
            code => new ConversationCommentError(code)
        ),
    };
}

export function removeConversationCommentTag(
    draft: ConversationCommentDraft,
    tag: unknown
): ConversationCommentDraft {
    if (typeof tag !== 'string') {
        throw new ConversationCommentError('invalid');
    }
    const tags = draft.tags ?? [];
    if (!hasCommentTag(tags, tag.trim())) {
        return { ...draft };
    }
    return { ...draft, tags: withoutCommentTag(tags, tag) };
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
    return comments.map(comment => ({
        ...comment,
        ...(comment.tags ? { tags: [...comment.tags] } : {}),
    }));
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
    validateDraftTags(draft.tags);
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

function validateDraftTags(tags: string[] | undefined): void {
    if (tags === undefined) {
        return;
    }
    assertValidCommentTags(
        tags,
        CONVERSATION_COMMENT_LIMITS.maxTagsPerComment,
        CONVERSATION_COMMENT_LIMITS.maxTagGraphemes,
        code => new ConversationCommentError(code)
    );
}
