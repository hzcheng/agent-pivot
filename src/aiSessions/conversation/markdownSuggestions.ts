'use strict';

/** Only an explicit, bounded JSON fence can become an actionable suggestion. */
export interface MarkdownSuggestionEnvelope {
    selectedText: string;
    replacement: string;
}

export function parseMarkdownSuggestionEnvelope(
    markdown: unknown
): MarkdownSuggestionEnvelope | undefined {
    if (typeof markdown !== 'string' || markdown.length > 64_000) return undefined;
    const match = /^```markdown-suggestion\s*\n([\s\S]{1,16384}?)\n```\s*$/m.exec(markdown);
    if (!match) return undefined;
    try {
        const value = JSON.parse(match[1]);
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).length !== 2
            || typeof value.selectedText !== 'string' || !value.selectedText
            || value.selectedText.length > 4000
            || typeof value.replacement !== 'string' || !value.replacement
            || value.replacement.length > 12000) return undefined;
        return { selectedText: value.selectedText, replacement: value.replacement };
    } catch (_error) {
        return undefined;
    }
}
