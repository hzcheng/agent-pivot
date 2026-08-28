'use strict';

import type {
    ConversationDiffHunk,
    ConversationDiffLine,
    ConversationFileDiff,
} from './types';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

interface DiffSide {
    line?: ConversationDiffLine;
    number?: number;
}

const DIFF_VISIBLE_CONTEXT_LINES = 3;

function renderDiffSide(side: DiffSide, position: 'old' | 'new'): string {
    if (!side.line) {
        return `<span class="conversation-diff-side conversation-diff-side-${position} conversation-diff-side-empty" aria-hidden="true"></span>`;
    }
    const marker = side.line.type === 'add'
        ? '+'
        : side.line.type === 'del'
            ? '-'
            : ' ';
    const number = side.number === undefined ? '' : String(side.number);
    return `<span class="conversation-diff-side conversation-diff-side-${position} conversation-diff-line conversation-diff-line-${side.line.type}"><span class="conversation-diff-line-number">${number}</span><span class="conversation-diff-line-text">${marker}${escapeHtml(side.line.text)}</span></span>`;
}

function renderDiffRow(oldSide: DiffSide, newSide: DiffSide): string {
    return `<span class="conversation-diff-row">${renderDiffSide(oldSide, 'old')}${renderDiffSide(newSide, 'new')}</span>`;
}

function renderContextRows(
    lines: ConversationDiffLine[],
    oldStart: number | undefined,
    newStart: number | undefined
): string {
    return lines.map((line, index) => renderDiffRow(
        { line, number: oldStart === undefined ? undefined : oldStart + index },
        { line, number: newStart === undefined ? undefined : newStart + index }
    )).join('');
}

function renderDiffHunk(hunk: ConversationDiffHunk): string {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const rows: string[] = [];
    let index = 0;
    while (index < hunk.lines.length) {
        const line = hunk.lines[index];
        if (line.type === 'context') {
            const context: ConversationDiffLine[] = [];
            while (index < hunk.lines.length
                && hunk.lines[index].type === 'context') {
                context.push(hunk.lines[index]);
                index += 1;
            }
            const currentOldLine = oldLine;
            const currentNewLine = newLine;
            if (context.length <= DIFF_VISIBLE_CONTEXT_LINES * 2) {
                rows.push(renderContextRows(context, currentOldLine, currentNewLine));
            } else {
                const leading = context.slice(0, DIFF_VISIBLE_CONTEXT_LINES);
                const hidden = context.slice(
                    DIFF_VISIBLE_CONTEXT_LINES,
                    -DIFF_VISIBLE_CONTEXT_LINES
                );
                const trailing = context.slice(-DIFF_VISIBLE_CONTEXT_LINES);
                rows.push(renderContextRows(leading, currentOldLine, currentNewLine));
                rows.push(`<details class="conversation-diff-context"><summary>… ${hidden.length} unchanged lines</summary><section class="conversation-diff-context-grid">${renderContextRows(hidden, currentOldLine === undefined ? undefined : currentOldLine + leading.length, currentNewLine === undefined ? undefined : currentNewLine + leading.length)}</section></details>`);
                rows.push(renderContextRows(
                    trailing,
                    currentOldLine === undefined
                        ? undefined
                        : currentOldLine + leading.length + hidden.length,
                    currentNewLine === undefined
                        ? undefined
                        : currentNewLine + leading.length + hidden.length
                ));
            }
            if (oldLine !== undefined) {
                oldLine += context.length;
            }
            if (newLine !== undefined) {
                newLine += context.length;
            }
            continue;
        }

        const deleted: ConversationDiffLine[] = [];
        const added: ConversationDiffLine[] = [];
        while (index < hunk.lines.length
            && hunk.lines[index].type !== 'context') {
            const changed = hunk.lines[index];
            if (changed.type === 'del') {
                deleted.push(changed);
            }
            if (changed.type === 'add') {
                added.push(changed);
            }
            index += 1;
        }
        const rowCount = Math.max(deleted.length, added.length);
        for (let row = 0; row < rowCount; row += 1) {
            const old = deleted[row];
            const next = added[row];
            rows.push(renderDiffRow(
                old ? { line: old, number: oldLine } : {},
                next ? { line: next, number: newLine } : {}
            ));
            if (old && oldLine !== undefined) {
                oldLine += 1;
            }
            if (next && newLine !== undefined) {
                newLine += 1;
            }
        }
    }
    const header = hunk.oldStart !== undefined && hunk.newStart !== undefined
        ? `<span class="conversation-diff-line-hunk">@@ -${hunk.oldStart} +${hunk.newStart} @@</span>`
        : '';
    const truncated = hunk.truncatedLines
        ? `<span class="conversation-diff-line-truncated">… ${hunk.truncatedLines} more lines</span>`
        : '';
    return `<section class="conversation-diff-hunk">${header}<section class="conversation-diff-grid">${rows.join('')}</section>${truncated}</section>`;
}

function renderConversationDiffFile(diff: ConversationFileDiff, index: number): string {
    const kind = diff.kind
        ? `<span class="conversation-diff-kind conversation-diff-kind-${escapeHtml(diff.kind)}">${escapeHtml(diff.kind)}</span>`
        : '';
    const hunks = diff.hunks.map(renderDiffHunk).join('');
    return `<section class="conversation-diff-file" data-conversation-diff-file-id="${index}"><section class="conversation-diff-file-header"><span class="conversation-diff-path" title="${escapeHtml(diff.path)}">${escapeHtml(diff.path)}</span>${kind}<span class="conversation-diff-counts"><span class="conversation-diff-count-add">+${diff.additions}</span> <span class="conversation-diff-count-del">−${diff.deletions}</span></span><button class="conversation-diff-context-toggle" type="button" data-conversation-diff-context-toggle aria-pressed="false" title="Show changes only">Changes only</button></section>${hunks}</section>`;
}

export function renderConversationDiffs(diffs: ConversationFileDiff[]): string {
    return `<section class="conversation-diff">${diffs.map(renderConversationDiffFile).join('')}</section>`;
}
