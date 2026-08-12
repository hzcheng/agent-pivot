'use strict';

export const CODEX_PROFILE_CONFIG_SUFFIX = '.config.toml';
export const CODEX_PROFILE_NAME_MAX_LENGTH = 64;

/**
 * Basename-safety validation for a profile name. Unicode and inner spaces are
 * allowed; path separators, traversal segments, NUL bytes, leading dashes and
 * over-long names are rejected. The name is always passed to the CLI as a
 * separate argv element, never concatenated into a shell string.
 *
 * This module stays free of filesystem/process imports so any layer
 * (including type-only chains reachable from conversation adapters) may use
 * it.
 */
export function isValidCodexProfileName(name: unknown): name is string {
    if (typeof name !== 'string') {
        return false;
    }
    if (!name || name !== name.trim()) {
        return false;
    }
    if (name.length > CODEX_PROFILE_NAME_MAX_LENGTH) {
        return false;
    }
    if (name === '.' || name === '..' || name.startsWith('-')) {
        return false;
    }
    return !/[/\\\0]/.test(name);
}

export function sanitizeCodexProfileName(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return isValidCodexProfileName(trimmed) ? trimmed : null;
}
