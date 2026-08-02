'use strict';

import { CONVERSATION_LIMITS } from './types';

type Segmenter = { segment(value: string): Iterable<{ segment: string }> };

function graphemes(value: string): string[] {
    const SegmenterCtor = (Intl as unknown as {
        Segmenter?: new (
            locale?: string,
            options?: { granularity: string }
        ) => Segmenter;
    }).Segmenter;
    if (SegmenterCtor) {
        return Array.from(
            new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(value),
            item => item.segment
        );
    }
    return Array.from(value);
}

export function countGraphemes(value: string): number {
    return graphemes(String(value || '')).length;
}

export function truncateGraphemes(value: string, limit: number): string {
    const parts = graphemes(String(value || ''));
    const safeLimit = Math.max(0, Math.floor(limit));
    return parts.length <= safeLimit ? parts.join('') : `${parts.slice(0, safeLimit).join('')}…`;
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
    return countGraphemes(normalized) <= CONVERSATION_LIMITS.previewGraphemes
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
    return countGraphemes(combined) <= CONVERSATION_LIMITS.toolCallSummaryGraphemes
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
    return countGraphemes(normalized) <= CONVERSATION_LIMITS.toolCallDetailGraphemes
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
