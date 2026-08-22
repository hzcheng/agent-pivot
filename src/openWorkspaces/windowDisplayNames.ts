'use strict';

// Window-switcher display-name disambiguation (PRD: 同名窗口按最短唯一后缀消歧).
// Computed once over the final display names (after saved-project overrides),
// deterministically: same input set always yields the same names.

/** Parses a workspace navigationUri (file:// or vscode-remote://) into path segments. */
export function navigationUriToPathSegments(uri: string): string[] {
    if (!uri || uri.startsWith('untitled:')) {
        return [];
    }
    const match = uri.match(/^[a-z][a-z0-9+-]*:\/\/[^/]*(\/.*)$/i);
    const pathPart = match ? match[1] : uri;
    return decodeURIComponent(pathPart).split('/').filter(Boolean);
}

export interface WindowDisplayNameInput {
    id: string;
    /** Final display name, e.g. after saved-project name overrides. */
    name: string;
    /** Root-to-leaf path segments of the workspace (may be empty). */
    pathSegments: readonly string[];
}

function suffixLabel(segments: readonly string[]): string {
    return segments.join('/');
}

/**
 * Returns display names keyed by input id. Unique names pass through
 * unchanged; colliding names get the shortest path suffix (leaf-first) that
 * makes them unique within their collision group. Fully identical paths fall
 * back to a deterministic ordinal suffix.
 */
export function resolveWindowDisplayNames(
    inputs: readonly WindowDisplayNameInput[],
): ReadonlyMap<string, string> {
    const resolved = new Map<string, string>();
    const byName = new Map<string, WindowDisplayNameInput[]>();
    for (const input of inputs) {
        // The leaf segment usually duplicates the name itself; drop it so the
        // shortest-unique suffix starts from the parent directory.
        const trimmed = input.pathSegments.length > 0
            && input.pathSegments[input.pathSegments.length - 1] === input.name
            ? { ...input, pathSegments: input.pathSegments.slice(0, -1) }
            : input;
        const group = byName.get(trimmed.name);
        if (group) {
            group.push(trimmed);
        } else {
            byName.set(trimmed.name, [trimmed]);
        }
    }
    for (const [name, group] of byName) {
        if (group.length === 1) {
            resolved.set(group[0].id, name);
            continue;
        }
        // Deterministic order inside the collision group.
        const ordered = [...group].sort((left, right) => (left.id < right.id ? -1 : 1));
        const suffixLengths = new Map<string, number>();
        const maxDepth = Math.max(...ordered.map(item => item.pathSegments.length), 0);
        for (let depth = 1; depth <= maxDepth; depth += 1) {
            const seen = new Map<string, number>();
            for (const item of ordered) {
                if (suffixLengths.has(item.id)) {
                    continue;
                }
                if (item.pathSegments.length < depth) {
                    continue;
                }
                const suffix = suffixLabel(item.pathSegments.slice(-depth));
                seen.set(suffix, (seen.get(suffix) || 0) + 1);
            }
            for (const item of ordered) {
                if (suffixLengths.has(item.id) || item.pathSegments.length < depth) {
                    continue;
                }
                const suffix = suffixLabel(item.pathSegments.slice(-depth));
                if (seen.get(suffix) === 1) {
                    suffixLengths.set(item.id, depth);
                }
            }
            if (suffixLengths.size === ordered.length) {
                break;
            }
        }
        let ordinal = 1;
        const used = new Set<string>();
        for (const item of ordered) {
            const depth = suffixLengths.get(item.id);
            let display = depth !== undefined
                ? `${name} — ${suffixLabel(item.pathSegments.slice(-depth))}`
                : item.pathSegments.length > 0
                    ? `${name} — ${suffixLabel(item.pathSegments)}`
                    : `${name} (${ordinal + 1})`;
            while (used.has(display)) {
                ordinal += 1;
                display = `${name} (${ordinal})`;
            }
            used.add(display);
            resolved.set(item.id, display);
        }
    }
    return resolved;
}
