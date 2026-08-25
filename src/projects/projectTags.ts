'use strict';

/**
 * Tag normalization for saved projects. Tags are lightweight, user-typed
 * labels (`#frontend`, `urgent`, ...) attached to a project; they exist for
 * filtering and scanning, not as a managed taxonomy, so there is no central
 * tag registry -- valid tags are whatever projects carry, normalized.
 */

export const MAX_TAGS_PER_PROJECT = 8;
export const MAX_TAG_LENGTH = 32;

/**
 * Normalize a raw tag list: trim, strip a leading '#', drop empties and
 * overlong entries, dedupe case-insensitively (first spelling wins), and cap
 * the count. Non-string and non-array input yields an empty list.
 */
export function normalizeProjectTags(input: unknown): string[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const seen = new Set<string>();
    const tags: string[] = [];

    for (const entry of input) {
        if (typeof entry !== 'string') {
            continue;
        }

        const tag = entry.trim().replace(/^#+/, '').trim();
        if (!tag || tag.length > MAX_TAG_LENGTH) {
            continue;
        }

        const key = tag.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        tags.push(tag);

        if (tags.length >= MAX_TAGS_PER_PROJECT) {
            break;
        }
    }

    return tags;
}

/**
 * Parse a comma-separated tag input box value into normalized tags.
 */
export function parseProjectTagsInput(text: string): string[] {
    return normalizeProjectTags((text || '').split(','));
}
