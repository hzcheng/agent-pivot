'use strict';

import { CONVERSATION_LIMITS } from './types';

type Segmenter = { segment(value: string): Iterable<{ segment: string }> };

let sharedSegmenter: Segmenter | null | undefined;
const COMPLEX_GRAPHEME_PATTERN = /[\p{M}\p{Cf}\r\u1100-\u11ff\ua960-\ua97f\ud7b0-\ud7ff\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u;

function segmenter(): Segmenter | undefined {
    if (sharedSegmenter !== undefined) {
        return sharedSegmenter || undefined;
    }
    const SegmenterCtor = (Intl as unknown as {
        Segmenter?: new (
            locale?: string,
            options?: { granularity: string }
        ) => Segmenter;
    }).Segmenter;
    sharedSegmenter = SegmenterCtor
        ? new SegmenterCtor(undefined, { granularity: 'grapheme' })
        : null;
    return sharedSegmenter || undefined;
}

function* graphemes(value: string): Iterable<string> {
    const resolved = segmenter();
    if (resolved) {
        for (const item of resolved.segment(value)) {
            yield item.segment;
        }
        return;
    }
    yield* value;
}

function hasComplexGraphemes(value: string): boolean {
    return COMPLEX_GRAPHEME_PATTERN.test(value);
}

function countSimpleCodePoints(value: string, stopAfter?: number): number {
    let count = 0;
    for (let index = 0; index < value.length;) {
        const codePoint = value.codePointAt(index)!;
        index += codePoint > 0xffff ? 2 : 1;
        count += 1;
        if (stopAfter !== undefined && count > stopAfter) {
            return count;
        }
    }
    return count;
}

function truncateSimpleCodePoints(value: string, limit: number): string {
    let count = 0;
    let index = 0;
    while (index < value.length && count < limit) {
        const codePoint = value.codePointAt(index)!;
        index += codePoint > 0xffff ? 2 : 1;
        count += 1;
    }
    return index < value.length ? `${value.slice(0, index)}…` : value;
}

export function countGraphemes(value: string): number {
    const source = String(value || '');
    if (!hasComplexGraphemes(source)) {
        return countSimpleCodePoints(source);
    }
    let count = 0;
    for (const _part of graphemes(source)) {
        count += 1;
    }
    return count;
}

export function hasAtMostGraphemes(value: string, limit: number): boolean {
    const source = String(value || '');
    const safeLimit = Math.max(0, Math.floor(limit));
    if (source.length <= safeLimit) {
        return true;
    }
    if (!hasComplexGraphemes(source)) {
        return countSimpleCodePoints(source, safeLimit) <= safeLimit;
    }
    let count = 0;
    for (const _part of graphemes(source)) {
        count += 1;
        if (count > safeLimit) {
            return false;
        }
    }
    return true;
}

export function truncateGraphemes(value: string, limit: number): string {
    const source = String(value || '');
    const safeLimit = Math.max(0, Math.floor(limit));
    if (source.length <= safeLimit) {
        return source;
    }
    if (!hasComplexGraphemes(source)) {
        return truncateSimpleCodePoints(source, safeLimit);
    }
    const parts: string[] = [];
    for (const part of graphemes(source)) {
        if (parts.length >= safeLimit) {
            return `${parts.join('')}…`;
        }
        parts.push(part);
    }
    return source;
}

export function normalizeVisibleText(value: string): string {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[\t ]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function buildUserPreview(value: string): string {
    const normalized = normalizeVisibleText(value);
    return hasAtMostGraphemes(
        normalized,
        CONVERSATION_LIMITS.previewGraphemes
    )
        ? normalized
        : truncateGraphemes(
            normalized,
            CONVERSATION_LIMITS.previewGraphemes - 1
        );
}

export function attachmentLabel(count: number): string {
    const safeCount = Math.max(1, Math.floor(count));
    return safeCount === 1 ? '[Attachment]' : `[${safeCount} Attachments]`;
}

export function buildToolCallSummary(
    name: string,
    args: Record<string, any> | undefined
): string {
    const candidate = args
        ? args.command ?? args.path ?? args.file_path ?? args.pattern
            ?? args.description ?? args.url ?? args.prompt
        : undefined;
    const argument = normalizeVisibleText(
        typeof candidate === 'string' ? candidate : ''
    ).replace(/\n+/g, ' ');
    const base = normalizeVisibleText(name);
    const combined = argument ? `${base} ${argument}` : base;
    return hasAtMostGraphemes(
        combined,
        CONVERSATION_LIMITS.toolCallSummaryGraphemes
    )
        ? combined
        : truncateGraphemes(
            combined,
            CONVERSATION_LIMITS.toolCallSummaryGraphemes - 1
        );
}

export function capToolCallDetail(value: string): string | undefined {
    const normalized = normalizeVisibleText(value);
    if (!normalized) {
        return undefined;
    }
    return hasAtMostGraphemes(
        normalized,
        CONVERSATION_LIMITS.toolCallDetailGraphemes
    )
        ? normalized
        : truncateGraphemes(
            normalized,
            CONVERSATION_LIMITS.toolCallDetailGraphemes - 1
        );
}

export type VisibleUserInputPart =
    { kind: 'text'; text: string } | { kind: 'attachment' };

export function buildVisibleUserInput(
    parts: readonly VisibleUserInputPart[]
): string {
    const visible: string[] = [];
    let attachments = 0;
    const flushAttachments = (): void => {
        if (attachments > 0) {
            visible.push(attachmentLabel(attachments));
            attachments = 0;
        }
    };
    parts.forEach(part => {
        if (part.kind === 'attachment') {
            attachments += 1;
            return;
        }
        flushAttachments();
        const text = normalizeVisibleText(part.text);
        if (text) {
            visible.push(text);
        }
    });
    flushAttachments();
    return normalizeVisibleText(visible.join(' '));
}
