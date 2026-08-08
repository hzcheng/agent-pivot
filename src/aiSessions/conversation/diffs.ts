'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationDiffHunk,
    ConversationDiffLine,
    ConversationFileDiff,
} from './types';
import { truncateGraphemes } from './text';

function boundDiffPath(value: string): string {
    return truncateGraphemes(
        value.trim(),
        CONVERSATION_LIMITS.diffPathGraphemes
    );
}

function boundLineText(value: string): string {
    return truncateGraphemes(
        value,
        CONVERSATION_LIMITS.diffLineGraphemes
    );
}

function splitLines(text: string): string[] {
    if (!text) {
        return [];
    }
    const lines = text.split('\n');
    // A single trailing newline terminates the last line; it is not an
    // extra empty line of content.
    if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

interface FileAccumulator {
    file: ConversationFileDiff;
    lineCount: number;
}

function newAccumulator(
    path: string,
    kind: string | undefined
): FileAccumulator {
    return {
        file: {
            path: boundDiffPath(path),
            ...(kind ? { kind } : {}),
            additions: 0,
            deletions: 0,
            hunks: [],
        },
        lineCount: 0,
    };
}

function pushLine(
    accumulator: FileAccumulator,
    hunk: ConversationDiffHunk,
    line: ConversationDiffLine
): void {
    if (accumulator.lineCount >= CONVERSATION_LIMITS.maxDiffLinesPerFile) {
        hunk.truncatedLines = (hunk.truncatedLines || 0) + 1;
        return;
    }
    hunk.lines.push({
        type: line.type,
        text: boundLineText(line.text),
    });
    accumulator.lineCount += 1;
    if (line.type === 'add') {
        accumulator.file.additions += 1;
    } else if (line.type === 'del') {
        accumulator.file.deletions += 1;
    }
}

function stripDiffPathPrefix(value: string): string {
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
    return trimmed.replace(/^[ab]\//, '');
}

/**
 * Parses unified diff text into bounded per-file diffs. Tolerates headerless
 * +/-/space line streams by grouping them under `fallbackPath`. Returns [] when
 * the text carries no diff content at all.
 */
export function parseUnifiedDiff(
    text: string,
    fallbackPath?: string,
    fallbackKind?: string
): ConversationFileDiff[] {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }
    const files: ConversationFileDiff[] = [];
    let current: FileAccumulator | undefined;
    let hunk: ConversationDiffHunk | undefined;
    let pendingKind: string | undefined;
    let sawDiffContent = false;
    const ensureCurrent = (): FileAccumulator | undefined => {
        if (!current) {
            if (!fallbackPath
                || files.length >= CONVERSATION_LIMITS.maxDiffsPerToolCall) {
                return undefined;
            }
            current = newAccumulator(fallbackPath, fallbackKind);
            files.push(current.file);
        }
        return current;
    };
    const ensureHunk = (): ConversationDiffHunk | undefined => {
        const accumulator = ensureCurrent();
        if (!accumulator) {
            return undefined;
        }
        if (!hunk) {
            hunk = { lines: [] };
            accumulator.file.hunks.push(hunk);
        }
        return hunk;
    };
    for (const rawLine of splitLines(text)) {
        if (rawLine.startsWith('--- ')) {
            const path = stripDiffPathPrefix(rawLine.slice(4));
            if (files.length < CONVERSATION_LIMITS.maxDiffsPerToolCall) {
                current = newAccumulator(path, pendingKind);
                files.push(current.file);
            } else {
                current = undefined;
            }
            pendingKind = undefined;
            hunk = undefined;
            sawDiffContent = true;
            continue;
        }
        if (rawLine.startsWith('+++ ')) {
            const path = stripDiffPathPrefix(rawLine.slice(4));
            const accumulator = ensureCurrent();
            if (accumulator && path !== '/dev/null') {
                accumulator.file.path = boundDiffPath(path);
            }
            sawDiffContent = true;
            continue;
        }
        if (rawLine.startsWith('@@')) {
            const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
            const accumulator = ensureCurrent();
            if (accumulator) {
                hunk = {
                    ...(match
                        ? {
                            oldStart: Number(match[1]),
                            newStart: Number(match[2]),
                        }
                        : {}),
                    lines: [],
                };
                accumulator.file.hunks.push(hunk);
            }
            sawDiffContent = true;
            continue;
        }
        if (rawLine.startsWith('diff --git')
            || rawLine.startsWith('index ')
            || rawLine.startsWith('\\')) {
            sawDiffContent = sawDiffContent || rawLine.startsWith('diff --git');
            continue;
        }
        if (rawLine.startsWith('new file mode')) {
            pendingKind = 'add';
            continue;
        }
        if (rawLine.startsWith('deleted file mode')) {
            pendingKind = 'delete';
            continue;
        }
        const marker = rawLine.charAt(0);
        if (marker === '+' || marker === '-' || marker === ' ') {
            const target = ensureHunk();
            if (!target) {
                continue;
            }
            sawDiffContent = true;
            pushLine(current!, target, {
                type: marker === '+'
                    ? 'add'
                    : marker === '-'
                        ? 'del'
                        : 'context',
                text: rawLine.slice(1),
            });
        }
    }
    if (!sawDiffContent) {
        return [];
    }
    return files.filter(file => file.hunks.length || file.path);
}

interface LcsCell {
    length: number;
}

/**
 * Synthesizes a fragment-level diff from an old/new text pair (the shape
 * Kimi approval previews and Claude Edit inputs carry). Line-level LCS when
 * both sides stay under the synthesis cap; otherwise degrades to a
 * delete-all/add-all pair of blocks.
 */
export function synthesizeFragmentDiff(
    path: string,
    kind: string | undefined,
    oldText: string,
    newText: string
): ConversationFileDiff {
    const oldLines = splitLines(typeof oldText === 'string' ? oldText : '');
    const newLines = splitLines(typeof newText === 'string' ? newText : '');
    const accumulator = newAccumulator(path, kind);
    const hunk: ConversationDiffHunk = { lines: [] };
    accumulator.file.hunks.push(hunk);
    if (oldLines.length > CONVERSATION_LIMITS.diffSynthesizeMaxLines
        || newLines.length > CONVERSATION_LIMITS.diffSynthesizeMaxLines) {
        for (const line of oldLines) {
            pushLine(accumulator, hunk, { type: 'del', text: line });
        }
        for (const line of newLines) {
            pushLine(accumulator, hunk, { type: 'add', text: line });
        }
        return accumulator.file;
    }
    const width = newLines.length + 1;
    const table: LcsCell[] = new Array(
        (oldLines.length + 1) * width
    );
    for (let index = 0; index < table.length; index += 1) {
        table[index] = { length: 0 };
    }
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            const cell = table[oldIndex * width + newIndex];
            if (oldLines[oldIndex] === newLines[newIndex]) {
                cell.length = table[(oldIndex + 1) * width + newIndex + 1]
                    .length + 1;
            } else {
                cell.length = Math.max(
                    table[(oldIndex + 1) * width + newIndex].length,
                    table[oldIndex * width + newIndex + 1].length
                );
            }
        }
    }
    const emitted: ConversationDiffLine[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            emitted.push({ type: 'context', text: oldLines[oldIndex] });
            oldIndex += 1;
            newIndex += 1;
        } else if (table[(oldIndex + 1) * width + newIndex].length
            >= table[oldIndex * width + newIndex + 1].length) {
            emitted.push({ type: 'del', text: oldLines[oldIndex] });
            oldIndex += 1;
        } else {
            emitted.push({ type: 'add', text: newLines[newIndex] });
            newIndex += 1;
        }
    }
    while (oldIndex < oldLines.length) {
        emitted.push({ type: 'del', text: oldLines[oldIndex] });
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        emitted.push({ type: 'add', text: newLines[newIndex] });
        newIndex += 1;
    }
    for (const line of emitted) {
        pushLine(accumulator, hunk, line);
    }
    return accumulator.file;
}
