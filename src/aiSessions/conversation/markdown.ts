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

const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
    highlight: highlightCode,
});

markdown.validateLink = (url: string): boolean => {
    try {
        return new URL(url).protocol === 'https:';
    } catch (_error) {
        return false;
    }
};

export function renderConversationMarkdown(value: string): string {
    return markdown.render(value);
}
