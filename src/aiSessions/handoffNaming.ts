'use strict';

/**
 * Derives the display alias of a handoff (relay) chat so users can tell at a
 * glance that the new session continues an earlier one. A named source
 * becomes "<name> (N)" with the chain generation incremented; an unnamed
 * source becomes "Handoff from <Provider> · <short-id>". The result is
 * collision-free against the workspace's existing session names.
 */

/** Leave room for the generation suffix in the narrow session row label. */
const MAX_SOURCE_ALIAS_LENGTH = 48;

function sanitizeFragment(value: string | undefined): string {
    return String(value || '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

function uniqueAlias(candidate: string, existingNames: readonly string[]): string {
    const used = new Set<string>();
    for (const name of existingNames) {
        const clean = sanitizeFragment(name);
        if (clean) {
            used.add(clean);
        }
    }
    if (!used.has(candidate)) {
        return candidate;
    }
    // Continue the chain on collision instead of stacking suffixes:
    // "Auth fix (2)" taken -> "Auth fix (3)", never "Auth fix (2) (2)".
    const chain = /^(.*)\s+\((\d+)\)$/.exec(candidate);
    const base = chain && chain[1] ? chain[1] : candidate;
    let generation = chain ? Number(chain[2]) + 1 : 2;
    while (used.has(`${base} (${generation})`)) {
        generation += 1;
    }
    return `${base} (${generation})`;
}

export interface AiSessionHandoffNamingInput {
    /** Display alias of the source session, when it has one. */
    sourceName?: string;
    /** Human-readable label of the source provider, e.g. "Codex". */
    sourceProviderLabel: string;
    sourceSessionId: string;
    /** All session names currently visible in the workspace. */
    existingNames: readonly string[];
}

export function deriveHandoffSessionAlias(input: AiSessionHandoffNamingInput): string {
    const providerLabel = sanitizeFragment(input.sourceProviderLabel) || 'AI';
    const sessionId = sanitizeFragment(input.sourceSessionId);
    const sourceName = sanitizeFragment(input.sourceName);

    if (sourceName) {
        // A previous handoff already carries a generation suffix: continue
        // the chain ("Auth fix (2)" -> "Auth fix (3)") instead of nesting.
        const chain = /^(.*)\s+\((\d+)\)$/.exec(sourceName);
        const base = chain && chain[1] ? chain[1] : sourceName;
        const nextGeneration = chain ? Number(chain[2]) + 1 : 2;
        const candidate = `${base.slice(0, MAX_SOURCE_ALIAS_LENGTH).trim()} (${nextGeneration})`;
        return uniqueAlias(candidate, input.existingNames);
    }

    const shortId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
    const candidate = `Handoff from ${providerLabel}${shortId ? ` · ${shortId}` : ''}`;
    return uniqueAlias(candidate, input.existingNames);
}
