'use strict';

import type { AiSessionProviderId } from '../../models';

export const PROJECT_COMMENT_LIMITS = Object.freeze({
    maxComments: 50,
    maxIdLength: 512,
    maxTextGraphemes: 4_000,
    maxQuoteGraphemes: 4_000,
    maxTagsPerComment: 5,
    maxTagGraphemes: 24,
    maxDistinctTags: 20,
    maxDispatchesPerComment: 20,
    maxPromptGraphemes: 32_000,
});

export interface ProjectCommentTarget {
    projectId: string;
}

export interface ProjectCommentSource {
    provider: AiSessionProviderId;
    sessionId: string;
    quote?: string;
}

export interface ProjectCommentDispatch {
    provider: AiSessionProviderId;
    sessionId: string;
    at: number;
}

export type ProjectCommentStatus = 'open' | 'done';

export interface ProjectComment {
    id: string;
    text: string;
    tags: string[];
    status: ProjectCommentStatus;
    createdAt: number;
    updatedAt?: number;
    doneAt?: number;
    source?: ProjectCommentSource;
    dispatches: ProjectCommentDispatch[];
}

export type ProjectCommentOperation =
    'add' | 'update' | 'delete' | 'setStatus' | 'addTag' | 'removeTag'
    | 'reorder' | 'sendProjectComment';

export class ProjectCommentError extends Error {
    constructor(
        readonly code: 'invalid' | 'stale' | 'limit' | 'tooLarge'
            | 'unavailable' | 'busy' | 'conflict' | 'failed'
    ) {
        super(code);
        this.name = 'ProjectCommentError';
    }
}

export interface ProjectCommentDraftInput {
    text: unknown;
    tags?: unknown;
    source?: unknown;
}

export function createProjectComment(
    id: string,
    input: ProjectCommentDraftInput,
    createdAt: number
): ProjectComment {
    if (!isBoundedId(id) || !isTimestamp(createdAt)) {
        throw new ProjectCommentError('invalid');
    }
    return {
        id,
        text: requireBoundedText(
            input?.text,
            PROJECT_COMMENT_LIMITS.maxTextGraphemes
        ),
        tags: normalizeProjectCommentTags(input?.tags ?? []),
        status: 'open',
        createdAt,
        ...(input?.source !== undefined
            ? { source: parseProjectCommentSource(input.source) }
            : {}),
        dispatches: [],
    };
}

export function updateProjectCommentText(
    comment: ProjectComment,
    text: unknown,
    updatedAt: number
): ProjectComment {
    // Editing a project comment never changes its status: done stays done.
    // Completion is a deliberate manual toggle, unlike session comments where
    // editing re-opens for a resend.
    return {
        ...comment,
        text: requireBoundedText(
            text,
            PROJECT_COMMENT_LIMITS.maxTextGraphemes
        ),
        updatedAt: requireTimestamp(updatedAt),
    };
}

export function setProjectCommentStatus(
    comment: ProjectComment,
    status: ProjectCommentStatus,
    at: number
): ProjectComment {
    if (status !== 'open' && status !== 'done') {
        throw new ProjectCommentError('invalid');
    }
    if (status === comment.status) {
        return { ...comment };
    }
    if (status === 'done') {
        return { ...comment, status, doneAt: requireTimestamp(at) };
    }
    const { doneAt: _doneAt, ...reopened } = comment;
    return { ...reopened, status };
}

export function addProjectCommentTag(
    comment: ProjectComment,
    tag: unknown
): ProjectComment {
    const normalized = normalizeProjectCommentTags([tag]);
    if (hasTag(comment.tags, normalized[0])) {
        return { ...comment };
    }
    if (comment.tags.length >= PROJECT_COMMENT_LIMITS.maxTagsPerComment) {
        throw new ProjectCommentError('limit');
    }
    return { ...comment, tags: [...comment.tags, normalized[0]] };
}

export function removeProjectCommentTag(
    comment: ProjectComment,
    tag: unknown
): ProjectComment {
    if (typeof tag !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    if (!hasTag(comment.tags, tag)) {
        return { ...comment };
    }
    const needle = tag.trim().toLowerCase();
    return {
        ...comment,
        tags: comment.tags.filter(
            candidate => candidate.toLowerCase() !== needle
        ),
    };
}

export function reorderProjectComments(
    comments: readonly ProjectComment[],
    orderedCommentIds: readonly string[]
): ProjectComment[] {
    validateProjectComments(comments);
    if (!Array.isArray(orderedCommentIds)
        || orderedCommentIds.length !== comments.length) {
        throw new ProjectCommentError('invalid');
    }
    const commentsById = new Map(
        comments.map(comment => [comment.id, comment] as const)
    );
    const seen = new Set<string>();
    const reordered = orderedCommentIds.map(commentId => {
        if (typeof commentId !== 'string'
            || seen.has(commentId)
            || !commentsById.has(commentId)) {
            throw new ProjectCommentError('invalid');
        }
        seen.add(commentId);
        return { ...commentsById.get(commentId)! };
    });
    if (seen.size !== commentsById.size) {
        throw new ProjectCommentError('invalid');
    }
    return reordered;
}

export function recordProjectCommentDispatch(
    comment: ProjectComment,
    dispatch: ProjectCommentDispatch
): ProjectComment {
    if (!isProjectCommentDispatch(dispatch)) {
        throw new ProjectCommentError('invalid');
    }
    const dispatches = [...comment.dispatches, { ...dispatch }]
        .slice(-PROJECT_COMMENT_LIMITS.maxDispatchesPerComment);
    return { ...comment, dispatches };
}

export function buildProjectCommentPrompt(
    comment: ProjectComment
): string {
    validateProjectComment(comment);
    const header = comment.tags.length
        ? `[项目笔记]（标签：${comment.tags.join('、')}）`
        : '[项目笔记]';
    const sections: string[] = [header, comment.text];
    if (comment.source) {
        const sourceLines = [
            `出处（来自 ${comment.source.provider} session 的记录）：`,
        ];
        if (comment.source.quote) {
            sourceLines.push(fencedQuote(comment.source.quote));
        }
        sections.push(sourceLines.join('\n'));
    }
    const prompt = [
        '请处理下面这条项目笔记。如果笔记要求修改代码，请直接检查当前工作区并完成相应修改与验证。',
        '',
        ...sections,
    ].join('\n');
    if (graphemeLength(prompt) > PROJECT_COMMENT_LIMITS.maxPromptGraphemes) {
        throw new ProjectCommentError('tooLarge');
    }
    return prompt;
}

export function collectProjectCommentTagVocabulary(
    comments: readonly ProjectComment[]
): string[] {
    const seen = new Set<string>();
    const vocabulary: string[] = [];
    comments.forEach(comment => {
        comment.tags.forEach(tag => {
            const key = tag.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                vocabulary.push(tag);
            }
        });
    });
    return vocabulary;
}

export function cloneProjectComments(
    comments: readonly ProjectComment[]
): ProjectComment[] {
    return comments.map(comment => ({
        ...comment,
        tags: [...comment.tags],
        ...(comment.source ? { source: { ...comment.source } } : {}),
        dispatches: comment.dispatches.map(dispatch => ({ ...dispatch })),
    }));
}

export function validateProjectComments(
    comments: readonly ProjectComment[]
): void {
    if (!Array.isArray(comments)
        || comments.length > PROJECT_COMMENT_LIMITS.maxComments) {
        throw new ProjectCommentError('invalid');
    }
    const ids = new Set<string>();
    comments.forEach(comment => {
        validateProjectComment(comment);
        if (ids.has(comment.id)) {
            throw new ProjectCommentError('invalid');
        }
        ids.add(comment.id);
    });
    if (collectProjectCommentTagVocabulary(comments).length
        > PROJECT_COMMENT_LIMITS.maxDistinctTags) {
        throw new ProjectCommentError('invalid');
    }
}

export function validateProjectComment(comment: ProjectComment): void {
    if (!comment || !isBoundedId(comment.id)
        || (comment.status !== 'open' && comment.status !== 'done')
        || !isTimestamp(comment.createdAt)
        || !isOptionalTimestamp(comment.updatedAt)
        || !isOptionalTimestamp(comment.doneAt)
        || (comment.status === 'done' && comment.doneAt === undefined)
        || !Array.isArray(comment.tags)
        || comment.tags.length > PROJECT_COMMENT_LIMITS.maxTagsPerComment
        || !Array.isArray(comment.dispatches)
        || comment.dispatches.length
            > PROJECT_COMMENT_LIMITS.maxDispatchesPerComment) {
        throw new ProjectCommentError('invalid');
    }
    requireBoundedText(comment.text, PROJECT_COMMENT_LIMITS.maxTextGraphemes);
    const seenTags = new Set<string>();
    comment.tags.forEach(tag => {
        if (!isBoundedTag(tag) || seenTags.has(tag.toLowerCase())) {
            throw new ProjectCommentError('invalid');
        }
        seenTags.add(tag.toLowerCase());
    });
    if (comment.source !== undefined) {
        validateProjectCommentSource(comment.source);
    }
    comment.dispatches.forEach(dispatch => {
        if (!isProjectCommentDispatch(dispatch)) {
            throw new ProjectCommentError('invalid');
        }
    });
}

export function normalizeProjectCommentTags(value: unknown): string[] {
    if (!Array.isArray(value)
        || value.length > PROJECT_COMMENT_LIMITS.maxTagsPerComment) {
        throw new ProjectCommentError('invalid');
    }
    // Case-insensitive duplicates collapse onto the first occurrence, which
    // keeps its original casing.
    const seen = new Set<string>();
    const normalized: string[] = [];
    value.forEach(candidate => {
        if (typeof candidate !== 'string') {
            throw new ProjectCommentError('invalid');
        }
        const tag = candidate.replace(/\s+/g, ' ').trim();
        if (!isBoundedTag(tag)) {
            throw new ProjectCommentError('invalid');
        }
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            normalized.push(tag);
        }
    });
    return normalized;
}

function hasTag(tags: readonly string[], tag: string): boolean {
    const needle = tag.toLowerCase();
    return tags.some(candidate => candidate.toLowerCase() === needle);
}

function parseProjectCommentSource(value: unknown): ProjectCommentSource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProjectCommentError('invalid');
    }
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate);
    const hasQuote = candidate.quote !== undefined;
    if (keys.length !== (hasQuote ? 3 : 2)
        || !isAiSessionProvider(candidate.provider)
        || !isBoundedId(candidate.sessionId)) {
        throw new ProjectCommentError('invalid');
    }
    const source: ProjectCommentSource = {
        provider: candidate.provider,
        sessionId: candidate.sessionId,
    };
    if (hasQuote) {
        source.quote = requireBoundedText(
            candidate.quote,
            PROJECT_COMMENT_LIMITS.maxQuoteGraphemes
        );
    }
    return source;
}

function validateProjectCommentSource(source: ProjectCommentSource): void {
    parseProjectCommentSource(source);
}

function isProjectCommentDispatch(
    value: unknown
): value is ProjectCommentDispatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return Object.keys(candidate).length === 3
        && isAiSessionProvider(candidate.provider)
        && isBoundedId(candidate.sessionId)
        && isTimestamp(candidate.at);
}

function isAiSessionProvider(
    value: unknown
): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isBoundedTag(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && graphemeLength(value) <= PROJECT_COMMENT_LIMITS.maxTagGraphemes
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireBoundedText(value: unknown, max: number): string {
    if (typeof value !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    const normalized = value.replace(/\r\n?/g, '\n').trim();
    if (!normalized || graphemeLength(normalized) > max) {
        throw new ProjectCommentError('invalid');
    }
    return normalized;
}

function isTimestamp(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function requireTimestamp(value: unknown): number {
    if (!isTimestamp(value)) {
        throw new ProjectCommentError('invalid');
    }
    return value;
}

function isOptionalTimestamp(value: unknown): boolean {
    return value === undefined || isTimestamp(value);
}

function graphemeLength(value: string): number {
    return Array.from(value).length;
}

function isBoundedId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= PROJECT_COMMENT_LIMITS.maxIdLength
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
