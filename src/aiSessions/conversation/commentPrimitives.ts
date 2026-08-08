'use strict';

import type { AiSessionProviderId } from '../../models';

/**
 * Shared primitives for the two comment stacks (session comments and
 * project-scoped workspace notes). Both stacks throw subclasses of
 * CommentError so callers can map every failure with a single instanceof
 * against the base class, regardless of which stack raised it.
 */

export type CommentErrorCode = 'invalid' | 'stale' | 'limit' | 'tooLarge'
    | 'unavailable' | 'busy' | 'conflict' | 'failed';

export class CommentError extends Error {
    constructor(readonly code: CommentErrorCode) {
        super(code);
        this.name = 'CommentError';
    }
}

/** Builds the stack-specific error instance thrown by shared validators. */
export type CommentErrorFactory = (code: CommentErrorCode) => CommentError;

export type CommentStatus = 'open' | 'done';

export type CommentClearOperation = 'clearDone' | 'clearAll';

/** Maximum length for project/session/comment identifiers across both stacks. */
export const COMMENT_MAX_ID_LENGTH = 512;

export function graphemeLength(value: string): number {
    return Array.from(value).length;
}

export function isBoundedId(
    value: unknown,
    maxLength: number = COMMENT_MAX_ID_LENGTH
): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

export function isAiSessionProvider(
    value: unknown
): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

export function isTimestamp(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

export function isOptionalTimestamp(value: unknown): boolean {
    return value === undefined || isTimestamp(value);
}

export function isBoundedTag(
    value: unknown,
    maxGraphemes: number
): value is string {
    return typeof value === 'string'
        && value.length > 0
        && graphemeLength(value) <= maxGraphemes
        && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Fences a quote for prompt embedding, outgrowing any backtick runs inside. */
export function fencedQuote(value: string): string {
    const matches = value.match(/`+/g) || [];
    const fenceLength = matches.reduce(
        (length, match) => Math.max(length, match.length + 1),
        3
    );
    const fence = '`'.repeat(fenceLength);
    return `${fence}text\n${value}\n${fence}`;
}

/**
 * Binds the throwing validators to one stack's error class so each model
 * keeps throwing its own public error type while sharing the implementation.
 */
export function createCommentValidators(fail: CommentErrorFactory): {
    requireBoundedText: (value: unknown, max: number) => string;
    optionalBoundedText: (value: unknown, max: number) => string;
    requireTimestamp: (value: unknown) => number;
    normalizeTag: (value: unknown, maxGraphemes: number) => string;
} {
    return {
        requireBoundedText(value: unknown, max: number): string {
            if (typeof value !== 'string') {
                throw fail('invalid');
            }
            const normalized = value.replace(/\r\n?/g, '\n').trim();
            if (!normalized || graphemeLength(normalized) > max) {
                throw fail('invalid');
            }
            return normalized;
        },
        optionalBoundedText(value: unknown, max: number): string {
            if (typeof value !== 'string') {
                throw fail('invalid');
            }
            const normalized = value.replace(/\r\n?/g, '\n');
            if (graphemeLength(normalized) > max) {
                throw fail('invalid');
            }
            return normalized;
        },
        requireTimestamp(value: unknown): number {
            if (!isTimestamp(value)) {
                throw fail('invalid');
            }
            return value;
        },
        normalizeTag(value: unknown, maxGraphemes: number): string {
            if (typeof value !== 'string') {
                throw fail('invalid');
            }
            const normalized = value.replace(/\s+/g, ' ').trim();
            if (!isBoundedTag(normalized, maxGraphemes)) {
                throw fail('invalid');
            }
            return normalized;
        },
    };
}

/** Case-insensitive membership check; the needle is expected pre-trimmed. */
export function hasCommentTag(
    tags: readonly string[],
    tag: string
): boolean {
    const needle = tag.toLowerCase();
    return tags.some(candidate => candidate.toLowerCase() === needle);
}

/**
 * Appends an already-normalized tag. Returns the original array reference
 * when the tag is already present (case-insensitive), so callers can keep
 * their no-op semantics; throws 'limit' at the per-comment cap.
 */
export function withCommentTag(
    tags: readonly string[],
    tag: string,
    maxTags: number,
    fail: CommentErrorFactory
): string[] {
    if (hasCommentTag(tags, tag)) {
        return tags as string[];
    }
    if (tags.length >= maxTags) {
        throw fail('limit');
    }
    return [...tags, tag];
}

/** Removes a tag case-insensitively; the needle is trimmed first. */
export function withoutCommentTag(
    tags: readonly string[],
    tag: string
): string[] {
    const needle = tag.trim().toLowerCase();
    return tags.filter(candidate => candidate.toLowerCase() !== needle);
}

/**
 * Normalizes user-supplied tag input: whitespace collapses, case-insensitive
 * duplicates fold onto the first occurrence (which keeps its casing).
 */
export function normalizeCommentTags(
    value: unknown,
    maxTags: number,
    maxGraphemes: number,
    fail: CommentErrorFactory
): string[] {
    if (!Array.isArray(value) || value.length > maxTags) {
        throw fail('invalid');
    }
    const validators = createCommentValidators(fail);
    const seen = new Set<string>();
    const normalized: string[] = [];
    value.forEach(candidate => {
        const tag = validators.normalizeTag(candidate, maxGraphemes);
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            normalized.push(tag);
        }
    });
    return normalized;
}

/**
 * Strict persisted-state check: every tag must be valid and free of
 * case-insensitive duplicates. Complement of the lenient input path.
 */
export function assertValidCommentTags(
    tags: readonly string[],
    maxTags: number,
    maxGraphemes: number,
    fail: CommentErrorFactory
): void {
    if (!Array.isArray(tags) || tags.length > maxTags) {
        throw fail('invalid');
    }
    const seen = new Set<string>();
    tags.forEach(tag => {
        if (typeof tag !== 'string'
            || !tag.trim()
            || !isBoundedTag(tag, maxGraphemes)
            || seen.has(tag.toLowerCase())) {
            throw fail('invalid');
        }
        seen.add(tag.toLowerCase());
    });
}

/** Host-authoritative reorder: the id list must be an exact permutation. */
export function reorderCommentsByIds<T extends { id: string }>(options: {
    comments: readonly T[];
    orderedCommentIds: readonly string[];
    validate: (comments: readonly T[]) => void;
    fail: CommentErrorFactory;
}): T[] {
    const { comments, orderedCommentIds, validate, fail } = options;
    validate(comments);
    if (!Array.isArray(orderedCommentIds)
        || orderedCommentIds.length !== comments.length) {
        throw fail('invalid');
    }
    const commentsById = new Map(
        comments.map(comment => [comment.id, comment] as const)
    );
    const seen = new Set<string>();
    const reordered = orderedCommentIds.map(commentId => {
        if (typeof commentId !== 'string'
            || seen.has(commentId)
            || !commentsById.has(commentId)) {
            throw fail('invalid');
        }
        seen.add(commentId);
        return { ...commentsById.get(commentId)! };
    });
    if (seen.size !== commentsById.size) {
        throw fail('invalid');
    }
    return reordered;
}

/**
 * clearDone keeps open comments; clearAll empties the list. Only the kept
 * comments are validated: a corrupt in-memory entry must never block the
 * user from clearing it away.
 */
export function clearCommentsByStatus<T extends { status: CommentStatus }>(
    options: {
        comments: readonly T[];
        operation: CommentClearOperation;
        validateKept: (comment: T) => void;
        clone: (comment: T) => T;
        fail: CommentErrorFactory;
    }
): T[] {
    const { comments, operation, validateKept, clone, fail } = options;
    if (!Array.isArray(comments)
        || (operation !== 'clearDone' && operation !== 'clearAll')) {
        throw fail('invalid');
    }
    const kept = comments.filter(
        comment => operation === 'clearDone' && comment.status !== 'done'
    );
    kept.forEach(validateKept);
    return kept.map(clone);
}
