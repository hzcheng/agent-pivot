'use strict';

import MarkdownIt = require('markdown-it');
import { URL } from 'url';
import { parseUnifiedDiff } from './diffs';
import { renderConversationDiffs } from './diffRenderer';
import { CONVERSATION_RUN_COMMAND_MAX_TEXT_LENGTH } from './viewerProtocol';

// highlight.js 11 ships .d.ts syntax this repo's TS 4.0 toolchain cannot
// parse, so bind it through a plain require with a minimal local surface.
const hljs: {
    getLanguage(name: string): unknown;
    highlight(
        value: string,
        options: { language: string; ignoreIllegals: boolean }
    ): { value: string };
} = require('highlight.js/lib/common');

// KaTeX is intentionally rendered in the extension Host, with its trust
// boundary closed. The Webview receives only its generated static markup;
// it never evaluates TeX, HTML, or a model-supplied script.
const katex: {
    renderToString(value: string, options: {
        displayMode: boolean;
        output: 'html';
        throwOnError: boolean;
        trust: false;
    }): string;
} = require('katex');

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function highlightCode(
    value: string,
    lang: string,
    highlightedLines?: ReadonlySet<number>
): string {
    const safeLang = escapeHtml(lang || '');
    const className = `hljs${safeLang ? ` language-${safeLang}` : ''}`;
    const language = lang && hljs.getLanguage(lang) ? lang : '';
    if (highlightedLines && highlightedLines.size) {
        const lines = (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
        return `<pre class="conversation-code-numbered"><code class="${className}">${lines.map((line, index) => {
            const lineNumber = index + 1;
            let rendered = escapeHtml(line);
            if (language) {
                try {
                    rendered = hljs.highlight(line, {
                        language,
                        ignoreIllegals: true,
                    }).value;
                } catch (_error) {
                    // Keep the escaped source for an invalid single line.
                }
            }
            return `<span class="conversation-code-line${highlightedLines.has(lineNumber) ? ' conversation-code-line-highlighted' : ''}" data-conversation-code-line="${lineNumber}"><span class="conversation-code-line-number" aria-hidden="true">${lineNumber}</span><span class="conversation-code-line-content">${rendered}</span></span>`;
        }).join('')}</code></pre>`;
    }
    if (language) {
        try {
            const highlighted = hljs.highlight(value, {
                language,
                ignoreIllegals: true,
            }).value;
            return `<pre><code class="${className}">${highlighted}</code></pre>`;
        } catch (_error) {
            // Fall through to the escaped plain rendering.
        }
    }
    return `<pre><code class="${className}">${escapeHtml(value)}</code></pre>`;
}

function renderCodeBlock(value: string, info: string): string {
    const parsedInfo = parseCodeBlockInfo(info);
    const lang = parsedInfo.lang;
    if (/^(?:diff|patch|udiff|unified-diff)$/i.test(lang)) {
        const diffs = parseUnifiedDiff(value, 'Proposed changes');
        if (diffs.length) {
            return renderConversationDiffs(diffs);
        }
    }
    if (/^(?:chart|bar-chart|line-chart|pie-chart)$/i.test(lang)) {
        const chart = renderChart(value, lang);
        if (chart) {
            return chart;
        }
    }
    if (/^(?:json|jsonc|yaml|yml|xml|log|logs|console|stacktrace)$/i.test(lang)) {
        return renderStructuredCodeBlock(value, lang);
    }
    if (/^(?:math|latex|tex)$/i.test(lang)) {
        return renderMath(value, true);
    }
    if (/^(?:references|sources|evidence)$/i.test(lang)) {
        const references = renderReferences(value);
        if (references) {
            return references;
        }
    }
    const runnable = /^(?:bash|sh|shell|zsh)$/i.test(lang)
        && value.length > 0
        && value.length <= CONVERSATION_RUN_COMMAND_MAX_TEXT_LENGTH
        && !!value.trim()
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    const label = lang
        ? `<span class="conversation-code-lang">${escapeHtml(lang)}</span>`
        : '';
    return `<section class="conversation-code-block">`
        + `<section class="conversation-code-header">${label}`
        + '<span class="conversation-code-actions">'
        + (runnable
            ? '<button class="conversation-code-run" '
                + 'data-conversation-run-command '
                + 'title="Run command"></button>'
            : '')
        + '<button class="conversation-code-copy" title="Copy code">'
        + '</button></span></section>'
        + highlightCode(value, lang, parsedInfo.highlightedLines)
        + '</section>\n';
}

function parseCodeBlockInfo(info: string): {
    lang: string;
    highlightedLines?: ReadonlySet<number>;
} {
    const normalized = (info || '').trim();
    const lang = normalized.split(/\s+/)[0] || '';
    const specification = /\{([0-9,\s-]+)\}/.exec(normalized);
    if (!specification) {
        return { lang };
    }
    const highlightedLines = new Set<number>();
    for (const range of specification[1].split(',')) {
        const match = /^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(range);
        if (!match) {
            continue;
        }
        const first = Number(match[1]);
        const last = match[2] ? Number(match[2]) : first;
        if (!first || last < first || last - first > 200) {
            continue;
        }
        for (let line = first; line <= last && highlightedLines.size < 200; line += 1) {
            highlightedLines.add(line);
        }
    }
    return highlightedLines.size ? { lang, highlightedLines } : { lang };
}

interface ConversationReference {
    title: string;
    href: string;
    note?: string;
}

function renderReferences(value: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (_error) {
        return undefined;
    }
    const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
            ? (parsed as { items?: unknown }).items
            : undefined;
    if (!Array.isArray(items) || !items.length || items.length > 12) {
        return undefined;
    }
    const references: ConversationReference[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') {
            return undefined;
        }
        const record = item as { title?: unknown; href?: unknown; note?: unknown };
        if (typeof record.title !== 'string' || !record.title.trim()
            || record.title.length > 160 || typeof record.href !== 'string'
            || !markdown.validateLink(record.href)
            || (record.note !== undefined && (typeof record.note !== 'string'
                || record.note.length > 480))) {
            return undefined;
        }
        references.push({
            title: record.title,
            href: record.href,
            ...(typeof record.note === 'string' ? { note: record.note } : {}),
        });
    }
    return `<section class="conversation-references" aria-label="References">${references.map(reference =>
        `<article class="conversation-reference-card"><a class="conversation-reference-link" href="${escapeHtml(reference.href)}">${escapeHtml(reference.title)}</a>${reference.note ? `<span class="conversation-reference-note">${escapeHtml(reference.note)}</span>` : ''}</article>`
    ).join('')}</section>`;
}

function renderStructuredCodeBlock(value: string, lang: string): string {
    const normalized = /^(?:json|jsonc)$/i.test(lang)
        ? formatJson(value)
        : value;
    const collapsed = normalized.length > 2_000;
    const label = /^(?:log|logs|console|stacktrace)$/i.test(lang)
        ? 'Log output'
        : `${lang.toUpperCase()} data`;
    return `<details class="conversation-structured-block"${collapsed ? '' : ' open'}>`
        + `<summary>${escapeHtml(label)}${collapsed ? ' · collapsed long output' : ''}</summary>`
        + `<section class="conversation-code-block">${highlightCode(normalized, lang)}</section>`
        + '</details>\n';
}

function formatJson(value: string): string {
    try {
        return JSON.stringify(JSON.parse(value), undefined, 2);
    } catch (_error) {
        return value;
    }
}

interface ConversationChartData {
    title?: string;
    labels: string[];
    values: number[];
    type: 'bar' | 'line' | 'pie';
}

function renderChart(value: string, lang: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (_error) {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
    }
    const record = parsed as {
        title?: unknown;
        labels?: unknown;
        values?: unknown;
        type?: unknown;
    };
    if (!Array.isArray(record.labels) || !Array.isArray(record.values)
        || !record.labels.length || record.labels.length !== record.values.length
        || record.labels.length > 20
        || !record.labels.every(label => typeof label === 'string'
            && label.length <= 120)
        || !record.values.every(item => typeof item === 'number'
            && Number.isFinite(item) && item >= 0)) {
        return undefined;
    }
    const requestedType = typeof record.type === 'string'
        ? record.type.toLowerCase()
        : lang.toLowerCase().replace(/-chart$/, '');
    const type = requestedType === 'chart' ? 'bar' : requestedType;
    if (type !== 'bar' && type !== 'line' && type !== 'pie') {
        return undefined;
    }
    const chart: ConversationChartData = {
        title: typeof record.title === 'string' ? record.title.slice(0, 160) : undefined,
        labels: record.labels as string[],
        values: record.values as number[],
        type,
    };
    const title = chart.title && chart.title.trim()
        ? `<span class="conversation-chart-title">${escapeHtml(chart.title)}</span>`
        : '';
    const graphic = chart.type === 'line'
        ? renderLineChartGraphic(chart)
        : chart.type === 'pie'
            ? renderPieChartGraphic(chart)
            : renderBarChartGraphic(chart);
    const rows = renderChartRows(chart);
    return `<section class="conversation-chart conversation-chart-${chart.type}" role="group" aria-label="${escapeHtml(chart.title || `${chart.type} chart`)}">${title}${graphic}${rows}</section>`;
}

function renderBarChartGraphic(chart: ConversationChartData): string {
    const values = chart.values;
    const maximum = Math.max(...values, 1);
    return chart.labels.map((label, index) => {
        const valueNumber = values[index];
        const percent = Math.round(valueNumber / maximum * 1000) / 10;
        return `<span class="conversation-chart-row"><span class="conversation-chart-label">${escapeHtml(label)}</span><progress class="conversation-chart-bar" max="100" value="${percent}">${percent}%</progress><span class="conversation-chart-value">${valueNumber}</span></span>`;
    }).join('');
}

function renderLineChartGraphic(chart: ConversationChartData): string {
    const maximum = Math.max(...chart.values, 1);
    const denominator = Math.max(chart.values.length - 1, 1);
    const points = chart.values.map((value, index) => {
        const x = Math.round(index / denominator * 1000) / 10;
        const y = Math.round((100 - value / maximum * 100) * 10) / 10;
        return `${x},${y}`;
    }).join(' ');
    return `<svg class="conversation-chart-graphic" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="3" points="${points}"></polyline></svg>`;
}

function renderPieChartGraphic(chart: ConversationChartData): string {
    const total = chart.values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        return '<span class="conversation-chart-empty">No values to display</span>';
    }
    const colors = ['#4daafc', '#73c991', '#e2c08d', '#f48771', '#c586c0', '#9cdcfe'];
    let offset = 25;
    const slices = chart.values.map((value, index) => {
        const length = Math.round(value / total * 10000) / 100;
        const slice = `<circle cx="50" cy="50" r="42" fill="none" stroke="${colors[index % colors.length]}" stroke-width="16" pathLength="100" stroke-dasharray="${length} ${100 - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 50 50)"></circle>`;
        offset += length;
        return slice;
    }).join('');
    return `<svg class="conversation-chart-graphic conversation-chart-pie-graphic" viewBox="0 0 100 100" aria-hidden="true">${slices}</svg>`;
}

function renderChartRows(chart: ConversationChartData): string {
    if (chart.type === 'bar') {
        return '';
    }
    return `<span class="conversation-chart-key">${chart.labels.map((label, index) => `<span class="conversation-chart-key-row"><span class="conversation-chart-key-label">${escapeHtml(label)}</span><span class="conversation-chart-value">${chart.values[index]}</span></span>`).join('')}</span>`;
}

function renderMath(value: string, displayMode: boolean): string {
    if (!value || value.length > 10_000 || /[\u0000-\u001f\u007f]/.test(value)) {
        return renderMathFallback(value, displayMode);
    }
    try {
        const rendered = katex.renderToString(value, {
            displayMode,
            output: 'html',
            throwOnError: true,
            trust: false,
        });
        return `<${displayMode ? 'section' : 'span'} class="conversation-math${displayMode ? ' conversation-math-display' : ''}">${rendered}</${displayMode ? 'section' : 'span'}>`;
    } catch (_error) {
        return renderMathFallback(value, displayMode);
    }
}

function renderMathFallback(value: string, displayMode: boolean): string {
    return `<${displayMode ? 'section' : 'span'} class="conversation-math-fallback">${escapeHtml(value)}</${displayMode ? 'section' : 'span'}>`;
}

const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
});

markdown.renderer.rules.fence = (tokens, index) =>
    renderCodeBlock(tokens[index].content, tokens[index].info);
markdown.renderer.rules.code_block = (tokens, index) =>
    renderCodeBlock(tokens[index].content, '');
markdown.renderer.rules.text = (tokens, index) => {
    const insideLink = tokens.slice(0, index).reduce((depth, token) =>
        token.type === 'link_open'
            ? depth + 1
            : token.type === 'link_close'
                ? depth - 1
                : depth, 0) > 0;
    const value = tokens[index].content;
    if (insideLink) {
        return escapeHtml(value);
    }
    // Most Conversation prose contains no file-reference delimiter. Avoid a
    // global path regexp over multi-megabyte streaming messages unless one
    // can possibly be present.
    if (!/[\/:#]/.test(value)) {
        return escapeHtml(value);
    }
    const pattern = /((?:[A-Za-z0-9_@][A-Za-z0-9_@.+-]*\/)*[A-Za-z0-9_@][A-Za-z0-9_@.+-]*\.(?:[A-Za-z0-9_@+_-][A-Za-z0-9_@.+-]*[A-Za-z0-9_@+_-]|[A-Za-z0-9_@+_-])(?::[1-9]\d{0,7}(?::[1-9]\d{0,7})?|#L[1-9]\d{0,7}(?::[1-9]\d{0,7})?)?)/g;
    let output = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
        const reference = match[1];
        const index = match.index;
        output += escapeHtml(value.slice(cursor, index));
        const preceding = index > 0 ? value.charAt(index - 1) : '';
        const following = value.charAt(index + reference.length);
        const hasPosition = /(?::[1-9]\d{0,7}(?::[1-9]\d{0,7})?|#L[1-9]\d{0,7}(?::[1-9]\d{0,7})?)$/.test(reference);
        output += !/[.\\/]/.test(preceding)
            && !/[:?#]/.test(following)
            && (reference.includes('/') || hasPosition)
            && parseConversationWorkspaceFileLink(reference)
            ? `<a href="${escapeHtml(reference)}">${escapeHtml(reference)}</a>`
            : escapeHtml(reference);
        cursor = index + reference.length;
    }
    return output + escapeHtml(value.slice(cursor));
};

markdown.block.ruler.before('fence', 'conversation-math-block', (
    state: any,
    startLine: number,
    endLine: number,
    silent: boolean
) => {
    const lineStart = state.bMarks[startLine] + state.tShift[startLine];
    const lineEnd = state.eMarks[startLine];
    if (state.src.slice(lineStart, lineEnd).trim() !== '$$') {
        return false;
    }
    let closeLine = startLine + 1;
    while (closeLine < endLine) {
        const closeStart = state.bMarks[closeLine] + state.tShift[closeLine];
        if (state.src.slice(closeStart, state.eMarks[closeLine]).trim() === '$$') {
            break;
        }
        closeLine += 1;
    }
    if (closeLine >= endLine || closeLine === startLine + 1) {
        return false;
    }
    if (silent) {
        return true;
    }
    const expressionStart = state.bMarks[startLine + 1];
    const expressionEnd = state.bMarks[closeLine] - 1;
    const token = state.push('html_block', '', 0);
    token.content = renderMath(
        state.src.slice(expressionStart, expressionEnd),
        true
    ) + '\n';
    token.map = [startLine, closeLine + 1];
    state.line = closeLine + 1;
    return true;
});

markdown.inline.ruler.before('text', 'conversation-math', (
    state: any,
    silent: boolean
) => {
    const source = state.src as string;
    const start = state.pos as number;
    if (source.charCodeAt(start) !== 0x24 || source.charCodeAt(start + 1) === 0x24) {
        return false;
    }
    const close = source.indexOf('$', start + 1);
    if (close <= start + 1 || close - start > 10_001
        || /\n/.test(source.slice(start + 1, close))) {
        return false;
    }
    const expression = source.slice(start + 1, close);
    if (!silent) {
        const token = state.push('html_inline', '', 0);
        token.content = renderMath(expression, false);
    }
    state.pos = close + 1;
    return true;
});

const MAX_LOCAL_FILE_LINK_LENGTH = 4096;
const MAX_LOCAL_FILE_POSITION = 10_000_000;

export interface ConversationLocalFileTarget {
    fsPath: string;
    line: number;
    column: number;
}

export interface ConversationWorkspaceFileTarget {
    relativePath: string;
    line: number;
    column: number;
}

function parseConversationFilePosition(value: string): {
    path: string;
    line: number;
    column: number;
} | undefined {
    const colon = value.match(/:([1-9]\d{0,7})(?::([1-9]\d{0,7}))?$/);
    const hash = colon ? undefined : value.match(/#L([1-9]\d{0,7})(?::([1-9]\d{0,7}))?$/);
    const position = colon || hash;
    const path = position ? value.slice(0, position.index) : value;
    const line = position ? Number(position[1]) : 1;
    const column = position?.[2] ? Number(position[2]) : 1;
    if (line > MAX_LOCAL_FILE_POSITION || column > MAX_LOCAL_FILE_POSITION) {
        return undefined;
    }
    return { path, line, column };
}

export function parseConversationLocalFileLink(
    value: string
): ConversationLocalFileTarget | undefined {
    if (!value || value.length > MAX_LOCAL_FILE_LINK_LENGTH) {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch (_error) {
        return undefined;
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('?')) {
        return undefined;
    }
    const position = parseConversationFilePosition(decoded);
    if (!position) {
        return undefined;
    }
    const fsPath = position.path;
    if (!(/^\/(?!\/)/.test(fsPath) || /^[A-Za-z]:[\\/]/.test(fsPath))) {
        return undefined;
    }
    return { fsPath, line: position.line, column: position.column };
}

export function parseConversationWorkspaceFileLink(
    value: string
): ConversationWorkspaceFileTarget | undefined {
    if (!value || value.length > MAX_LOCAL_FILE_LINK_LENGTH) {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch (_error) {
        return undefined;
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('?')) {
        return undefined;
    }
    const position = parseConversationFilePosition(decoded);
    if (!position || !position.path.includes('.')
        || /^(?:\/|[A-Za-z]:[\\/])/.test(position.path)) {
        return undefined;
    }
    const segments = position.path.split(/[\\/]/);
    if (!segments.length || segments.some(segment => !segment
        || segment === '.' || segment === '..'
        || !/^[A-Za-z0-9_@.+-]+$/.test(segment))) {
        return undefined;
    }
    return {
        relativePath: segments.join('/'),
        line: position.line,
        column: position.column,
    };
}

markdown.validateLink = (url: string): boolean => {
    try {
        if (new URL(url).protocol === 'https:') {
            return true;
        }
    } catch (_error) {
        // Absolute filesystem paths are not URL values.
    }
    return Boolean(parseConversationLocalFileLink(url)
        || parseConversationWorkspaceFileLink(url));
};

export function renderConversationMarkdown(value: string): string {
    return renderAdmonitions(renderTaskLists(renderSortableTables(markdown.render(value))));
}

function renderSortableTables(html: string): string {
    return html.replace(/<table>([\s\S]*?)<\/table>/g, (_match, content: string) => {
        let column = 0;
        const headers = content.replace(/<th\b([^>]*)>([\s\S]*?)<\/th>/g, (
            _header,
            attributes: string,
            label: string
        ) => {
            const index = column;
            column += 1;
            return `<th class="${tableAlignmentClass(attributes)}" aria-sort="none"><button class="conversation-table-sort" type="button" data-conversation-sort-column="${index}" title="Sort column">${label}<span aria-hidden="true">↕</span></button></th>`;
        });
        return `<table class="conversation-data-table">${headers.replace(
            /<td\b([^>]*)>/g,
            (_cell, attributes: string) => `<td class="${tableAlignmentClass(attributes)}">`
        )}</table>`;
    });
}

function tableAlignmentClass(attributes: string): string {
    const alignment = /text-align\s*:\s*(left|center|right)/i.exec(attributes);
    return alignment ? `conversation-table-align-${alignment[1].toLowerCase()}` : '';
}

function renderTaskLists(html: string): string {
    return html.replace(
        /<li>\s*\[([ xX])\]\s+/g,
        (_match, state: string) => {
            const completed = state.toLowerCase() === 'x';
            return `<li class="conversation-task-item"><span class="conversation-task-checkbox${completed ? ' conversation-task-checkbox-checked' : ''}" aria-hidden="true">${completed ? '✓' : ''}</span><span class="conversation-task-state">${completed ? 'Completed' : 'Not completed'}</span>`;
        }
    );
}

function renderAdmonitions(html: string): string {
    return html.replace(
        /<blockquote>\s*<p>\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
        (_match, kind: string, body: string) => {
            const normalized = kind.toLowerCase();
            return `<section class="conversation-callout conversation-callout-${normalized}"><span class="conversation-callout-label">${escapeHtml(kind)}</span><section class="conversation-callout-body">${body}</section></section>`;
        }
    );
}
