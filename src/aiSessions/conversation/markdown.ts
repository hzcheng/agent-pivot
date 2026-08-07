'use strict';

import MarkdownIt = require('markdown-it');
import { URL } from 'url';

// highlight.js 11 ships .d.ts syntax this repo's TS 4.0 toolchain cannot
// parse, so bind it through a plain require with a minimal local surface.
const hljs: {
    getLanguage(name: string): unknown;
    highlight(
        value: string,
        options: { language: string; ignoreIllegals: boolean }
    ): { value: string };
} = require('highlight.js/lib/common');

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function highlightCode(value: string, lang: string): string {
    const safeLang = escapeHtml(lang || '');
    const className = `hljs${safeLang ? ` language-${safeLang}` : ''}`;
    const language = lang && hljs.getLanguage(lang) ? lang : '';
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
    const lang = (info || '').trim().split(/\s+/)[0] || '';
    const label = lang
        ? `<span class="conversation-code-lang">${escapeHtml(lang)}</span>`
        : '';
    return `<section class="conversation-code-block">${label}`
        + highlightCode(value, lang)
        + '<button class="conversation-code-copy" title="Copy code">'
        + '</button></section>\n';
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

const MAX_LOCAL_FILE_LINK_LENGTH = 4096;
const MAX_LOCAL_FILE_POSITION = 10_000_000;

export interface ConversationLocalFileTarget {
    fsPath: string;
    line: number;
    column: number;
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
    if (/[\u0000-\u001f\u007f]/.test(decoded)
        || decoded.includes('?')
        || decoded.includes('#')) {
        return undefined;
    }
    const position = decoded.match(/:([1-9]\d{0,7})(?::([1-9]\d{0,7}))?$/);
    const fsPath = position
        ? decoded.slice(0, position.index)
        : decoded;
    if (!(/^\/(?!\/)/.test(fsPath) || /^[A-Za-z]:[\\/]/.test(fsPath))) {
        return undefined;
    }
    const line = position ? Number(position[1]) : 1;
    const column = position?.[2] ? Number(position[2]) : 1;
    if (line > MAX_LOCAL_FILE_POSITION || column > MAX_LOCAL_FILE_POSITION) {
        return undefined;
    }
    return { fsPath, line, column };
}

markdown.validateLink = (url: string): boolean => {
    try {
        if (new URL(url).protocol === 'https:') {
            return true;
        }
    } catch (_error) {
        // Absolute filesystem paths are not URL values.
    }
    return Boolean(parseConversationLocalFileLink(url));
};

export function renderConversationMarkdown(value: string): string {
    return markdown.render(value);
}
