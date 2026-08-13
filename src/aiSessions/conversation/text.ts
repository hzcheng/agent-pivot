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

export function truncateUtf8Bytes(value: string, limit: number): string {
    const source = String(value || '');
    const safeLimit = Math.max(0, Math.floor(limit));
    if (Buffer.byteLength(source, 'utf8') <= safeLimit) {
        return source;
    }
    const ellipsis = '…';
    const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8');
    if (safeLimit < ellipsisBytes) {
        return '';
    }
    const contentLimit = safeLimit - ellipsisBytes;
    const parts: string[] = [];
    let bytes = 0;
    for (const part of graphemes(source)) {
        const partBytes = Buffer.byteLength(part, 'utf8');
        if (bytes + partBytes > contentLimit) {
            break;
        }
        parts.push(part);
        bytes += partBytes;
    }
    return `${parts.join('')}${ellipsis}`;
}

export function normalizeVisibleText(value: string): string {
    const lines = String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '')
        .replace(/\r\n?/g, '\n')
        .split('\n');
    // Fenced code blocks carry meaning in their whitespace: keep every line
    // between the opening and closing fence verbatim instead of collapsing
    // it like prose. Fence markers follow the CommonMark shape (up to three
    // leading spaces, then a run of 3+ backticks or tildes), and an
    // unterminated fence runs to the end of the input, matching how the
    // Markdown renderer downstream treats it.
    const normalized: string[] = [];
    let fenceMarker = '';
    let fenceLength = 0;
    let previousProseBlank = false;
    for (const line of lines) {
        if (fenceMarker) {
            normalized.push(line);
            const closing = line.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
            if (closing
                && closing[1][0] === fenceMarker
                && closing[1].length >= fenceLength) {
                fenceMarker = '';
            }
            continue;
        }
        const prose = line.replace(/[\t ]+/g, ' ').trim();
        if (prose === '' && previousProseBlank) {
            continue;
        }
        previousProseBlank = prose === '';
        normalized.push(prose);
        const opening = prose.match(/^(`{3,}|~{3,})/);
        if (opening) {
            fenceMarker = opening[1][0];
            fenceLength = opening[1].length;
        }
    }
    return normalized.join('\n').trim();
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

/** Compact English turn-work duration, e.g. `45s`, `1m 20s`, `2h 03m`. */
export function formatWorkedDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    if (totalMinutes > 0) {
        return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
}

const CLOCK_MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface ConversationClockTime {
    /** Same-day `14:05`, older `Aug 6, 09:05`, other years `Dec 31 2025, 23:59`. */
    label: string;
    /** Full local timestamp, e.g. `2026-08-07 14:05:33`. */
    title: string;
}

function padClockPart(value: number): string {
    return String(value).padStart(2, '0');
}

/**
 * Deterministic 24h clock label for message action rows. `now` is injected
 * so the same-day decision stays testable.
 */
export function formatConversationClockTime(
    value: number | undefined,
    now: number
): ConversationClockTime | undefined {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return undefined;
    }
    const time = `${padClockPart(date.getHours())}`
        + `:${padClockPart(date.getMinutes())}`;
    const title = `${date.getFullYear()}-${padClockPart(date.getMonth() + 1)}`
        + `-${padClockPart(date.getDate())} ${time}`
        + `:${padClockPart(date.getSeconds())}`;
    const current = new Date(now);
    if (date.getFullYear() === current.getFullYear()
        && date.getMonth() === current.getMonth()
        && date.getDate() === current.getDate()) {
        return { label: time, title };
    }
    const month = CLOCK_MONTHS[date.getMonth()];
    const year = date.getFullYear() === current.getFullYear()
        ? ''
        : ` ${date.getFullYear()}`;
    return { label: `${month} ${date.getDate()}${year}, ${time}`, title };
}
