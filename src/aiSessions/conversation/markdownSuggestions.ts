'use strict';

/** Only an explicit, bounded JSON fence can become an actionable suggestion. */
export interface MarkdownSuggestionEnvelope {
    selectedText: string;
    replacement: string;
}

const MARKDOWN_SUGGESTION_FENCE = /(?:^|\n)```markdown-suggestion\s*\n([\s\S]{1,16384}?)\n```/g;

function parseMarkdownSuggestionPayload(payload: string): MarkdownSuggestionEnvelope | undefined {
    try {
        const value = JSON.parse(payload);
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).length !== 2
            || typeof value.selectedText !== 'string' || !value.selectedText
            || value.selectedText.length > 4000
            || typeof value.replacement !== 'string' || !value.replacement
            || value.replacement.length > 12000) { return undefined; }
        return { selectedText: value.selectedText, replacement: value.replacement };
    } catch (_error) {
        return undefined;
    }
}

export function parseMarkdownSuggestionEnvelope(
    markdown: unknown
): MarkdownSuggestionEnvelope | undefined {
    if (typeof markdown !== 'string' || markdown.length > 64_000) { return undefined; }
    MARKDOWN_SUGGESTION_FENCE.lastIndex = 0;
    const match = MARKDOWN_SUGGESTION_FENCE.exec(markdown);
    return match ? parseMarkdownSuggestionPayload(match[1]) : undefined;
}

/** The fence is a Host/Webview protocol detail, not reader-facing prose.
 * Remove only validated envelopes so ordinary fenced Markdown is preserved. */
export function stripMarkdownSuggestionEnvelope(markdown: unknown): string {
    if (typeof markdown !== 'string' || markdown.length > 64_000) { return ''; }
    let removed = false;
    MARKDOWN_SUGGESTION_FENCE.lastIndex = 0;
    const withoutEnvelope = markdown.replace(MARKDOWN_SUGGESTION_FENCE, (match, payload) => {
        if (!parseMarkdownSuggestionPayload(payload)) { return match; }
        removed = true;
        return '';
    });
    return removed ? withoutEnvelope.trim() : markdown;
}
