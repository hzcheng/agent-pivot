'use strict';

/**
 * Converts a Codex profile-v2 file (`<CODEX_HOME>/<name>.config.toml`) into
 * `codex app-server -c key=value` overrides.
 *
 * `codex app-server` rejects `--profile` outright ("--profile only applies
 * to runtime commands"), while a remote-mode TUI never sends the profile's
 * `model_provider` to the server — so the companion must be launched with
 * the profile content applied as top-priority `-c` overrides. That matches
 * legacy `[profiles.<name>]` overlay semantics: the profile's keys win over
 * the base config.toml, and unrelated base keys still apply.
 *
 * The parser below exists to find top-level entry boundaries and to REJECT
 * constructs that cannot be represented as a flat `-c` list. Values pass
 * through verbatim from the source text; nothing is re-serialized, so a
 * string/number/array/datetime keeps its exact bytes. Unsupported input
 * (arrays of tables, quoted key segments, malformed syntax) throws —
 * callers fall back to the ordinary terminal path.
 */

export class CodexProfileOverrideError extends Error {}

interface Section {
    // Dotted path segments of the current [table] header.
    path: string[];
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Flattens TOML source text into `dotted.key=value` override strings.
 * Throws CodexProfileOverrideError on anything outside the supported
 * document subset.
 */
export function flattenCodexProfileToml(source: string): string[] {
    if (source.length > 256 * 1024) {
        throw new CodexProfileOverrideError('profile file too large');
    }
    const entries: string[] = [];
    let section: Section = { path: [] };
    let index = 0;
    const length = source.length;

    const fail = (message: string): never => {
        throw new CodexProfileOverrideError(`${message} at offset ${index}`);
    };

    const skipInlineWhitespaceAndComments = (multiline: boolean): void => {
        for (;;) {
            const char = source[index];
            if (char === ' ' || char === '\t' || (multiline && (char === '\n' || char === '\r'))) {
                index++;
            } else if (char === '#') {
                while (index < length && source[index] !== '\n') { index++; }
            } else {
                return;
            }
        }
    };

    const readString = (): void => {
        const quote = source[index];
        if (quote !== '"' && quote !== "'") { fail('expected string'); }
        const triple = source.slice(index, index + 3) === quote.repeat(3);
        index += triple ? 3 : 1;
        for (;;) {
            if (index >= length) { fail('unterminated string'); }
            if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
                index += 3;
                return;
            }
            if (!triple && source[index] === quote) {
                index++;
                return;
            }
            if (!triple && (source[index] === '\n')) { fail('unterminated single-line string'); }
            if (quote === '"' && source[index] === '\\') { index++; }
            index++;
        }
    };

    const readKeySegment = (): string => {
        const char = source[index];
        if (char === '"' || char === "'") {
            // Quoted key segments cannot survive codex's dotted -c parser
            // reliably; reject rather than silently mis-nest.
            throw new CodexProfileOverrideError('quoted key segments are unsupported');
        }
        const start = index;
        while (index < length && /[A-Za-z0-9_-]/.test(source[index])) { index++; }
        if (index === start) { fail('expected key'); }
        return source.slice(start, index);
    };

    const readKeyPath = (): string[] => {
        const segments = [readKeySegment()];
        for (;;) {
            skipInlineWhitespaceAndComments(false);
            if (source[index] !== '.') { break; }
            index++;
            skipInlineWhitespaceAndComments(false);
            segments.push(readKeySegment());
        }
        return segments;
    };

    // Reads a value starting at index; returns the raw source text. Handles
    // strings, arrays, inline tables, and scalar tokens.
    const readValue = (): string => {
        const start = index;
        const char = source[index];
        if (char === '"' || char === "'") {
            readString();
            return source.slice(start, index);
        }
        if (char === '[' || char === '{') {
            const open = char;
            const close = open === '[' ? ']' : '}';
            let depth = 0;
            for (;;) {
                if (index >= length) { fail('unterminated collection'); }
                const current = source[index];
                if (current === '"' || current === "'") {
                    readString();
                    continue;
                }
                if (current === '#') {
                    while (index < length && source[index] !== '\n') { index++; }
                    continue;
                }
                if (current === open) { depth++; }
                if (current === close) { depth--; }
                index++;
                if (depth === 0) { break; }
            }
            return source.slice(start, index);
        }
        // Scalar token: read to end of line.
        const tokenStart = index;
        while (index < length && source[index] !== '\n' && source[index] !== '#') { index++; }
        const token = source.slice(tokenStart, index).trim();
        if (!token) { fail('missing value'); }
        return token;
    };

    while (index < length) {
        skipInlineWhitespaceAndComments(true);
        if (index >= length) { break; }
        const char = source[index];
        if (char === '[') {
            if (source[index + 1] === '[') {
                throw new CodexProfileOverrideError(
                    'arrays of tables cannot be expressed as -c overrides'
                );
            }
            index++;
            skipInlineWhitespaceAndComments(false);
            section = { path: readKeyPath() };
            skipInlineWhitespaceAndComments(false);
            if (source[index] !== ']') { fail('expected closing bracket'); }
            index++;
            continue;
        }
        const keyPath = readKeyPath();
        skipInlineWhitespaceAndComments(false);
        if (source[index] !== '=') { fail('expected ='); }
        index++;
        skipInlineWhitespaceAndComments(false);
        const value = readValue();
        entries.push([...section.path, ...keyPath].join('.') + '=' + value);
    }
    return entries;
}
