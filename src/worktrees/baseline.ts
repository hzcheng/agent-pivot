'use strict';

import type { MemberBaseline, WorktreeBaselineSource } from './types';

const MAX_BASELINE_REF_LENGTH = 1024;

/**
 * Accepts full hex object names (40-char SHA-1 or 64-char SHA-256).
 * A frozen baseline is always a full-length commit id.
 */
export function isBaselineCommitSha(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function isSafeBaselineRef(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_BASELINE_REF_LENGTH
        && !value.startsWith('-')
        && !/[\0\r\n]/u.test(value);
}

function parseBaselineSource(value: unknown): WorktreeBaselineSource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === 'commit') {
        return Object.freeze({ kind: 'commit' });
    }
    if ((candidate.kind === 'branch' || candidate.kind === 'tag')
        && isSafeBaselineRef(candidate.fullRef)) {
        return Object.freeze({
            kind: candidate.kind,
            fullRef: candidate.fullRef,
        });
    }
    return null;
}

/**
 * Parses a persisted baseline. Returns null for anything malformed —
 * callers drop or degrade the owning record rather than guessing.
 */
export function parseMemberBaseline(value: unknown): MemberBaseline | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (!isBaselineCommitSha(candidate.commitSha)
        || typeof candidate.capturedAt !== 'number'
        || !Number.isSafeInteger(candidate.capturedAt)
        || candidate.capturedAt < 0) {
        return null;
    }
    const source = parseBaselineSource(candidate.source);
    if (!source) {
        return null;
    }
    return Object.freeze({
        commitSha: candidate.commitSha,
        capturedAt: candidate.capturedAt,
        source,
    });
}

export function cloneMemberBaseline(baseline: MemberBaseline): MemberBaseline {
    return Object.freeze({
        commitSha: baseline.commitSha,
        capturedAt: baseline.capturedAt,
        source: { ...baseline.source },
    });
}

export function memberBaselinesEqual(
    left: MemberBaseline,
    right: MemberBaseline
): boolean {
    if (left.commitSha !== right.commitSha
        || left.capturedAt !== right.capturedAt
        || left.source.kind !== right.source.kind) {
        return false;
    }
    if (left.source.kind === 'commit' || right.source.kind === 'commit') {
        return left.source.kind === right.source.kind;
    }
    return (left.source as { fullRef: string }).fullRef
        === (right.source as { fullRef: string }).fullRef;
}
