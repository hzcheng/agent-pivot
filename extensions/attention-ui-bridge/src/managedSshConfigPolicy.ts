'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const MANAGED_SSH_MARKER_BEGIN = '# >>> Agent Pivot managed SSH hosts (do not edit)';
export const MANAGED_SSH_MARKER_END = '# <<< Agent Pivot managed SSH hosts';

export interface ManagedSshFileIdentity {
    path: string;
    realPath: string;
    size: number;
    modifiedAtMs: number;
    mode: number;
    device: number;
    inode: number;
    uid?: number;
    gid?: number;
    checksum: string;
}

export interface ManagedSshDependencyFingerprint {
    rootPath: string;
    files: ManagedSshFileIdentity[];
    digest: string;
}

export interface ManagedSshScanResult {
    fingerprint?: ManagedSshDependencyFingerprint;
    files: Map<string, string>;
    issues: string[];
}

export interface ManagedSshConfigPolicyOptions {
    platform: NodeJS.Platform;
    maxDepth?: number;
    maxFiles?: number;
    maxBytes?: number;
    virtualFiles?: Map<string, string>;
}

export interface ManagedSshConfigFileSystem {
    readSecureFile(filePath: string): ManagedSshFileIdentity & { content: string };
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) { return JSON.stringify(value.map(item => JSON.parse(stableJson(item)))); }
    if (!value || typeof value !== 'object') { return JSON.stringify(value); }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
        sorted[key] = JSON.parse(stableJson(record[key]));
    }
    return JSON.stringify(sorted);
}

function checksum(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isAbsoluteLiteral(candidate: string, platform: NodeJS.Platform): boolean {
    if (!candidate || /[*?%$!~\0\r\n]/u.test(candidate)) { return false; }
    return platform === 'win32'
        ? path.win32.isAbsolute(candidate) && !candidate.startsWith('\\\\')
        : path.posix.isAbsolute(candidate);
}

function canonicalLexicalPath(candidate: string, platform: NodeJS.Platform): string {
    return platform === 'win32'
        ? path.win32.normalize(candidate).toLowerCase()
        : path.posix.normalize(candidate);
}

function tokenizeLine(line: string): string[] | null {
    const tokens: string[] = [];
    let token = '';
    let quote = '';
    let escaped = false;
    const push = () => {
        if (token) { tokens.push(token); token = ''; }
    };
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (escaped) {
            token += character;
            escaped = false;
        } else if (character === '\\') {
            const next = line[index + 1];
            if (next && /[\s"'\\#]/u.test(next)) { escaped = true; }
            else { token += character; }
        } else if (quote) {
            if (character === quote) { quote = ''; }
            else { token += character; }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '#') {
            break;
        } else if (/\s/u.test(character)) {
            push();
        } else {
            token += character;
        }
    }
    if (escaped || quote) { return null; }
    push();
    return tokens;
}

function parseDirective(tokens: string[]): { name: string; arguments: string[] } | null {
    if (!tokens.length) { return null; }
    const equals = tokens[0].indexOf('=');
    if (equals > 0) {
        return {
            name: tokens[0].slice(0, equals).toLowerCase(),
            arguments: [tokens[0].slice(equals + 1), ...tokens.slice(1)].filter(Boolean),
        };
    }
    if (tokens[1] === '=') {
        return { name: tokens[0].toLowerCase(), arguments: tokens.slice(2) };
    }
    return { name: tokens[0].toLowerCase(), arguments: tokens.slice(1) };
}

export function analyzeManagedInclude(
    content: string,
    expectedGeneratedPath: string,
): 'absent' | 'exact' | 'malformed' {
    const lines = content.split(/\r?\n/u);
    const starts = lines.reduce<number[]>((result, line, index) => {
        if (line === MANAGED_SSH_MARKER_BEGIN) { result.push(index); }
        return result;
    }, []);
    const ends = lines.reduce<number[]>((result, line, index) => {
        if (line === MANAGED_SSH_MARKER_END) { result.push(index); }
        return result;
    }, []);
    if (!starts.length && !ends.length) { return 'absent'; }
    if (starts.length !== 1 || ends.length !== 1 || ends[0] !== starts[0] + 2) {
        return 'malformed';
    }
    const tokens = tokenizeLine(lines[starts[0] + 1]);
    return tokens
        && tokens.length === 2
        && tokens[0].toLowerCase() === 'include'
        && tokens[1] === expectedGeneratedPath.replace(/\\/gu, '/')
        ? 'exact' : 'malformed';
}

export function insertManagedInclude(
    content: string,
    includeBlock: string,
    expectedGeneratedPath: string,
): string {
    const state = analyzeManagedInclude(content, expectedGeneratedPath);
    if (state === 'exact') { return content; }
    if (state === 'malformed') {
        throw new Error('The active SSH config contains a modified or duplicate Agent Pivot marker.');
    }
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normalizedBlock = includeBlock.replace(/\r?\n/gu, eol);
    const match = /^(?:[ \t]*)(?:Host|Match)(?:[ \t]*=|[ \t]|$)/imu.exec(content);
    if (!match) {
        const separator = content && !content.endsWith('\n') ? eol : '';
        return `${content}${separator}${normalizedBlock}${eol}`;
    }
    const prefix = content.slice(0, match.index);
    const suffix = content.slice(match.index);
    const separator = prefix && !prefix.endsWith('\n') ? eol : '';
    return `${prefix}${separator}${normalizedBlock}${eol}${suffix}`;
}

export function removeManagedInclude(
    content: string,
    expectedGeneratedPath: string,
): string {
    const state = analyzeManagedInclude(content, expectedGeneratedPath);
    if (state === 'absent') { return content; }
    if (state === 'malformed') {
        throw new Error('The active SSH config contains a modified or duplicate Agent Pivot marker.');
    }
    const lines: Array<{ text: string; start: number; end: number }> = [];
    let startOffset = 0;
    while (startOffset < content.length) {
        const newline = content.indexOf('\n', startOffset);
        const endOffset = newline < 0 ? content.length : newline + 1;
        lines.push({
            text: content.slice(startOffset, endOffset).replace(/\r?\n$/u, ''),
            start: startOffset,
            end: endOffset,
        });
        startOffset = endOffset;
    }
    const start = lines.findIndex(line => line.text === MANAGED_SSH_MARKER_BEGIN);
    const removeEnd = lines[start + 2].end;
    return `${content.slice(0, lines[start].start)}${content.slice(removeEnd)}`;
}

export class NodeManagedSshConfigFileSystem implements ManagedSshConfigFileSystem {
    readSecureFile(filePath: string): ManagedSshFileIdentity & { content: string } {
        const link = fs.lstatSync(filePath);
        if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) {
            throw new Error(`SSH config dependency is not a private regular file: ${filePath}`);
        }
        if (process.platform !== 'win32'
            && typeof link.uid === 'number'
            && typeof process.getuid === 'function'
            && link.uid !== process.getuid()) {
            throw new Error(`SSH config dependency has foreign ownership: ${filePath}`);
        }
        if (process.platform !== 'win32' && (link.mode & 0o022) !== 0) {
            throw new Error(`SSH config dependency has unsafe permissions: ${filePath}`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const after = fs.lstatSync(filePath);
        if (after.dev !== link.dev
            || after.ino !== link.ino
            || after.size !== link.size
            || after.mtimeMs !== link.mtimeMs
            || after.mode !== link.mode
            || after.nlink !== link.nlink
            || after.uid !== link.uid
            || after.gid !== link.gid) {
            throw new Error(`SSH config dependency changed while it was read: ${filePath}`);
        }
        const realPath = fs.realpathSync.native(filePath);
        return {
            path: filePath,
            realPath,
            size: Buffer.byteLength(content, 'utf8'),
            modifiedAtMs: link.mtimeMs,
            mode: link.mode,
            device: link.dev,
            inode: link.ino,
            ...(typeof link.uid === 'number' ? { uid: link.uid } : {}),
            ...(typeof link.gid === 'number' ? { gid: link.gid } : {}),
            checksum: checksum(content),
            content,
        };
    }
}

export function scanManagedSshConfigGraph(
    rootPath: string,
    fileSystem: ManagedSshConfigFileSystem,
    options: ManagedSshConfigPolicyOptions,
): ManagedSshScanResult {
    const maxDepth = options.maxDepth === undefined ? 8 : options.maxDepth;
    const maxFiles = options.maxFiles === undefined ? 32 : options.maxFiles;
    const maxBytes = options.maxBytes === undefined ? 1024 * 1024 : options.maxBytes;
    const files = new Map<string, string>();
    const identities: ManagedSshFileIdentity[] = [];
    const issues: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    let totalBytes = 0;

    const visit = (filePath: string, depth: number): void => {
        const key = canonicalLexicalPath(filePath, options.platform);
        if (visiting.has(key)) {
            issues.push(`include-cycle:${filePath}`);
            return;
        }
        if (visited.has(key)) { return; }
        if (depth > maxDepth) {
            issues.push(`include-depth:${filePath}`);
            return;
        }
        if (visited.size >= maxFiles) {
            issues.push('include-file-limit');
            return;
        }
        visiting.add(key);
        let identity: (ManagedSshFileIdentity & { content: string }) | undefined;
        const virtual = options.virtualFiles?.get(key);
        try {
            identity = virtual === undefined
                ? fileSystem.readSecureFile(filePath)
                : {
                    path: filePath,
                    realPath: filePath,
                    size: Buffer.byteLength(virtual, 'utf8'),
                    modifiedAtMs: 0,
                    mode: 0,
                    device: 0,
                    inode: 0,
                    checksum: checksum(virtual),
                    content: virtual,
                };
        } catch (_error) {
            issues.push(`unreadable:${filePath}`);
            visiting.delete(key);
            return;
        }
        totalBytes += identity.size;
        if (totalBytes > maxBytes) { issues.push('include-byte-limit'); }
        files.set(key, identity.content);
        identities.push({
            path: identity.path,
            realPath: identity.realPath,
            size: identity.size,
            modifiedAtMs: identity.modifiedAtMs,
            mode: identity.mode,
            device: identity.device,
            inode: identity.inode,
            ...(identity.uid === undefined ? {} : { uid: identity.uid }),
            ...(identity.gid === undefined ? {} : { gid: identity.gid }),
            checksum: identity.checksum,
        });
        for (const [lineNumber, line] of identity.content.split(/\r?\n/u).entries()) {
            const tokens = tokenizeLine(line);
            if (!tokens) {
                issues.push(`invalid-syntax:${filePath}:${lineNumber + 1}`);
                continue;
            }
            if (!tokens.length) { continue; }
            const directive = parseDirective(tokens);
            if (!directive) { continue; }
            if (directive.name === 'match'
                && directive.arguments.some(token => {
                    const normalized = token.toLowerCase();
                    return normalized === 'exec' || normalized.startsWith('exec=');
                })) {
                issues.push(`match-exec:${filePath}:${lineNumber + 1}`);
            }
            if (directive.name !== 'include') { continue; }
            if (!directive.arguments.length) {
                issues.push(`invalid-include:${filePath}:${lineNumber + 1}`);
                continue;
            }
            for (const included of directive.arguments) {
                if (!isAbsoluteLiteral(included, options.platform)) {
                    issues.push(`dynamic-include:${filePath}:${lineNumber + 1}`);
                    continue;
                }
                visit(included, depth + 1);
            }
        }
        visiting.delete(key);
        visited.add(key);
    };

    visit(rootPath, 0);
    const sortedIdentities = identities.sort((left, right) =>
        canonicalLexicalPath(left.path, options.platform)
            .localeCompare(canonicalLexicalPath(right.path, options.platform)));
    const uniqueIssues = Array.from(new Set(issues)).sort();
    return {
        files,
        issues: uniqueIssues,
        ...(uniqueIssues.length ? {} : {
            fingerprint: {
                rootPath,
                files: sortedIdentities,
                digest: checksum(stableJson(sortedIdentities)),
            },
        }),
    };
}
