'use strict';

import type { AiSessionProviderId } from '../../models';
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
    isAiSessionProvider,
    isBoundedId,
    isOptionalTimestamp,
    isRecord,
    isTimestamp,
    normalizeCommentTags,
    reorderCommentsByIds,
    withCommentTag,
    withoutCommentTag,
} from './commentPrimitives';

export const PROJECT_COMMENT_LIMITS = Object.freeze({
    maxComments: 50,
    maxIdLength: COMMENT_MAX_ID_LENGTH,
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

export type ProjectCommentStatus = CommentStatus;

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

export const PROJECT_COMMENT_MUTATION_OPERATIONS = Object.freeze([
    'add', 'update', 'delete', 'setStatus', 'addTag', 'removeTag',
    'reorder', 'clearDone', 'clearAll',
] as const);

export type ProjectCommentMutationOperation =
    typeof PROJECT_COMMENT_MUTATION_OPERATIONS[number];

export const PROJECT_COMMENT_SEND_OPERATIONS = Object.freeze([
    'sendProjectComment', 'sendProjectComments',
] as const);

export type ProjectCommentSendOperation =
    typeof PROJECT_COMMENT_SEND_OPERATIONS[number];

export type ProjectCommentOperation = ProjectCommentMutationOperation
    | ProjectCommentSendOperation;

export type ProjectCommentClearOperation = 'clearDone' | 'clearAll';

export class ProjectCommentError extends CommentError {
    constructor(code: CommentError['code']) {
        super(code);
        this.name = 'ProjectCommentError';
    }
}

const projectCommentFail = (code: CommentError['code']) =>
    new ProjectCommentError(code);
const commentValidators = createCommentValidators(projectCommentFail);
const requireBoundedText = commentValidators.requireBoundedText;
const requireTimestamp = commentValidators.requireTimestamp;

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
    return {
        ...comment,
        tags: withCommentTag(
            comment.tags,
            normalized[0],
            PROJECT_COMMENT_LIMITS.maxTagsPerComment,
            projectCommentFail
        ),
    };
}

export function removeProjectCommentTag(
    comment: ProjectComment,
    tag: unknown
): ProjectComment {
    if (typeof tag !== 'string') {
        throw new ProjectCommentError('invalid');
    }
    if (!hasCommentTag(comment.tags, tag.trim())) {
        return { ...comment };
    }
    return { ...comment, tags: withoutCommentTag(comment.tags, tag) };
}

export function reorderProjectComments(
    comments: readonly ProjectComment[],
    orderedCommentIds: readonly string[]
): ProjectComment[] {
    return reorderCommentsByIds({
        comments,
        orderedCommentIds,
        validate: validateProjectComments,
        fail: projectCommentFail,
    });
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

export function clearProjectComments(
    comments: readonly ProjectComment[],
    operation: ProjectCommentClearOperation
): ProjectComment[] {
    return clearCommentsByStatus({
        comments,
        operation,
        validateKept: validateProjectComment,
        clone: comment => ({
            ...comment,
            tags: [...comment.tags],
            dispatches: comment.dispatches.map(dispatch => ({ ...dispatch })),
        }),
        fail: projectCommentFail,
    });
}

export function buildProjectCommentsPrompt(
    comments: readonly ProjectComment[]
): string {
    if (!Array.isArray(comments)
        || comments.length < 1
        || comments.length > PROJECT_COMMENT_LIMITS.maxComments) {
        throw new ProjectCommentError('invalid');
    }
    const sections = comments.map((comment, index) => {
        validateProjectComment(comment);
        const header = comment.tags.length
            ? `[项目笔记 ${index + 1}]（标签：${comment.tags.join('、')}）`
            : `[项目笔记 ${index + 1}]`;
        const lines = [header, comment.text];
        if (comment.source) {
            const sourceLines = [
                `出处（来自 ${comment.source.provider} session 的记录）：`,
            ];
            if (comment.source.quote) {
                sourceLines.push(fencedQuote(comment.source.quote));
            }
            lines.push(sourceLines.join('\n'));
        }
        return lines.join('\n');
    });
    const prompt = [
        '请处理下面这些项目笔记。请逐项回应，保留笔记编号；如果笔记要求修改代码，请直接检查当前工作区并完成相应修改与验证。',
        '',
        ...sections,
    ].join('\n\n');
    if (graphemeLength(prompt) > PROJECT_COMMENT_LIMITS.maxPromptGraphemes) {
        throw new ProjectCommentError('tooLarge');
    }
    return prompt;
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
        || !Array.isArray(comment.dispatches)
        || comment.dispatches.length
            > PROJECT_COMMENT_LIMITS.maxDispatchesPerComment) {
        throw new ProjectCommentError('invalid');
    }
    requireBoundedText(comment.text, PROJECT_COMMENT_LIMITS.maxTextGraphemes);
    assertValidCommentTags(
        comment.tags,
        PROJECT_COMMENT_LIMITS.maxTagsPerComment,
        PROJECT_COMMENT_LIMITS.maxTagGraphemes,
        projectCommentFail
    );
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
    // Case-insensitive duplicates collapse onto the first occurrence, which
    // keeps its original casing.
    return normalizeCommentTags(
        value,
        PROJECT_COMMENT_LIMITS.maxTagsPerComment,
        PROJECT_COMMENT_LIMITS.maxTagGraphemes,
        projectCommentFail
    );
}

function parseProjectCommentSource(value: unknown): ProjectCommentSource {
    if (!isRecord(value)) {
        throw new ProjectCommentError('invalid');
    }
    const keys = Object.keys(value);
    const hasQuote = value.quote !== undefined;
    if (keys.length !== (hasQuote ? 3 : 2)
        || !isAiSessionProvider(value.provider)
        || !isBoundedId(value.sessionId)) {
        throw new ProjectCommentError('invalid');
    }
    const source: ProjectCommentSource = {
        provider: value.provider,
        sessionId: value.sessionId,
    };
    if (hasQuote) {
        source.quote = requireBoundedText(
            value.quote,
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
    if (!isRecord(value)) {
        return false;
    }
    return Object.keys(value).length === 3
        && isAiSessionProvider(value.provider)
        && isBoundedId(value.sessionId)
        && isTimestamp(value.at);
}
