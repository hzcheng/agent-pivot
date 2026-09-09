'use strict';

import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import type { Stats } from 'fs';
import {
    lstat as lstatPath, open as openFilePath, realpath as realpathPath,
    rename as renamePath, unlink as unlinkPath,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { TextDecoder } from 'util';
import { findUniqueMarkdownSuggestionAnchor } from './markdown';

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export interface WorkspaceMarkdownSuggestion {
    documentVersion: string;
    selectedText: string;
    prefix: string;
    suffix: string;
    replacement: string;
}

/**
 * Applies a small replacement through the already-open file descriptor. The
 * final pathname is never used for the write, so a worktree symlink swap after
 * validation cannot redirect an AI-initiated change outside the worktree.
 */
export async function applyValidatedWorkspaceMarkdownSuggestion(
    canonicalRoot: string,
    canonicalCandidate: string,
    suggestion: WorkspaceMarkdownSuggestion
): Promise<'applied' | 'stale' | 'failed'> {
    let handle: FileHandle | undefined;
    let directory: FileHandle | undefined;
    try {
        // Bind the candidate before opening it. On platforms without procfs,
        // comparing this identity with fstat(handle) prevents an ancestor
        // swap-open-restore attack from turning the descriptor into a file
        // outside the approved worktree.
        const expectedStat = await lstatPath(canonicalCandidate);
        if (!expectedStat.isFile()) { return 'stale'; }
        handle = await openFilePath(canonicalCandidate,
            fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
        const descriptorPath = await openedDescriptorPath(handle, canonicalCandidate);
        if (!isContained(canonicalRoot, descriptorPath)) {
            return 'stale';
        }
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_MARKDOWN_BYTES
            || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
            return 'stale';
        }
        const sourceBytes = await readBounded(handle, stat.size);
        if (sourceBytes.includes(0)) { return 'stale'; }
        let source: string;
        try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
        } catch (_error) {
            return 'stale';
        }
        if (createHash('sha256').update(sourceBytes).digest('hex') !== suggestion.documentVersion) {
            return 'stale';
        }
        const range = findUniqueMarkdownSuggestionAnchor(source, suggestion);
        if (!range) { return 'stale'; }
        const replacement = Buffer.from(source.slice(0, range.start)
            + suggestion.replacement + source.slice(range.end), 'utf8');
        if (replacement.length > MAX_MARKDOWN_BYTES || replacement.includes(0)) {
            return 'failed';
        }
        // This is optimistic concurrency, not a pathname check: verify the
        // descriptor still names the exact bytes we rendered immediately
        // before its contents are replaced. A detected competing write always
        // fails closed instead of silently overwriting the user's change.
        const beforeWrite = await handle.stat();
        if (beforeWrite.size !== stat.size
            || beforeWrite.mtimeMs !== stat.mtimeMs
            || beforeWrite.ctimeMs !== stat.ctimeMs) {
            return 'stale';
        }
        // Where the OS exposes a directory descriptor path, use it to keep
        // rename bound to the approved worktree even through an ancestor
        // swap. Other supported hosts still get an atomic rename and the
        // pre-open file identity checks above; they do not fall back to an
        // in-place truncate/write.
        const descriptorDirectory = process.platform === 'linux' || process.platform === 'darwin';
        if (descriptorDirectory) {
            directory = await openFilePath(path.dirname(canonicalCandidate),
                fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        }
        const directoryPath = directory
            ? await openedDescriptorPath(directory, path.dirname(canonicalCandidate))
            : path.dirname(canonicalCandidate);
        if (!isContained(canonicalRoot, directoryPath)) { return 'stale'; }
        const replacementResult = await replaceAtomicallyThroughDirectory(
            directory, directoryPath, path.basename(canonicalCandidate), stat, replacement
        );
        if (replacementResult !== 'applied') { return replacementResult; }
        return 'applied';
    } catch (_error) {
        return 'stale';
    } finally {
        await directory?.close().catch(() => undefined);
        await handle?.close().catch(() => undefined);
    }
}

async function openedDescriptorPath(handle: FileHandle, fallback: string): Promise<string> {
    // Linux exposes the exact opened object through procfs, including after an
    // ancestor pathname swap. Elsewhere, the caller binds fstat(handle) to a
    // pre-open lstat of this already-canonical path, so returning the approved
    // candidate is safe without re-resolving a mutable pathname.
    if (process.platform === 'linux') {
        return realpathPath(`/proc/self/fd/${handle.fd}`);
    }
    if (process.platform === 'darwin') {
        return realpathPath(`/dev/fd/${handle.fd}`);
    }
    return fallback;
}

function isContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`)
        && relative !== '..' && !path.isAbsolute(relative));
}

async function readBounded(handle: FileHandle, length: number): Promise<Buffer> {
    const contents = Buffer.alloc(length);
    let offset = 0;
    while (offset < contents.length) {
        const result = await handle.read(contents, offset, contents.length - offset, offset);
        if (!result.bytesRead) { break; }
        offset += result.bytesRead;
    }
    return contents.subarray(0, offset);
}

async function replaceAtomicallyThroughDirectory(
    directory: FileHandle | undefined,
    directoryPath: string,
    basename: string,
    expected: Stats,
    contents: Buffer
): Promise<'applied' | 'stale' | 'failed'> {
    const base = directory ? (process.platform === 'linux'
        ? `/proc/self/fd/${directory.fd}` : `/dev/fd/${directory.fd}`) : directoryPath;
    const target = `${base}/${basename}`;
    const temporary = `${base}/.agent-pivot-markdown-${process.pid}-${Date.now()}-${Math.random()
        .toString(16).slice(2)}`;
    let temporaryHandle: FileHandle | undefined;
    try {
        if (!await hasExpectedIdentity(target, expected)) {
            return 'stale';
        }
        temporaryHandle = await openFilePath(temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            expected.mode & 0o777);
        let offset = 0;
        while (offset < contents.length) {
            const result = await temporaryHandle.write(
                contents, offset, contents.length - offset, offset
            );
            if (!result.bytesWritten) { return 'failed'; }
            offset += result.bytesWritten;
        }
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        // Check again immediately before the only irreversible operation.
        // A concurrent editor save during temporary-file fsync fails closed.
        if (!await hasExpectedIdentity(target, expected)) { return 'stale'; }
        await renamePath(temporary, target);
        // The atomic rename has committed even if syncing the directory later
        // reports an I/O error. Do not falsely report failure and discard the
        // inverse action after the document has already changed.
        await directory?.sync().catch(() => undefined);
        return 'applied';
    } catch (_error) {
        return 'failed';
    } finally {
        await temporaryHandle?.close().catch(() => undefined);
        await unlinkPath(temporary).catch(() => undefined);
    }
}

async function hasExpectedIdentity(target: string, expected: Stats): Promise<boolean> {
    const current = await lstatPath(target);
    return current.isFile() && current.dev === expected.dev && current.ino === expected.ino
        && current.size === expected.size && current.mtimeMs === expected.mtimeMs
        && current.ctimeMs === expected.ctimeMs;
}
