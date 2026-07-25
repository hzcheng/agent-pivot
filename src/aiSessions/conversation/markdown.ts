'use strict';

import MarkdownIt = require('markdown-it');
import { URL } from 'url';

const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
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
