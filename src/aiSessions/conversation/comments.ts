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
    messageId: string;
    interactionId: string;
    role: ConversationMessage['role'];
    quote: string;
    prefix: string;
    suffix: string;
    comment: string;
}

export interface ConversationCommentSelection {
    messageId: string;
    interactionId: string;
    quote: string;
    prefix: string;
    suffix: string;
    comment: string;
}

export type ConversationCommentOperation =
    'add' | 'update' | 'delete' | 'sendComments';

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
        role: message.role,
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
    };
}

export function updateConversationComment(
    draft: ConversationCommentDraft,
    comment: unknown
): ConversationCommentDraft {
    return {
        ...draft,
        comment: requireBoundedText(
            comment,
            CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes
        ),
    };
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

function validateDraft(draft: ConversationCommentDraft): void {
    if (!draft
        || !isBoundedId(draft.id)
        || !isBoundedId(draft.messageId)
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
