'use strict';

import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { lstat as lstatPath, open as openFilePath, realpath as realpathPath } from 'fs/promises';
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
        try {
            await replaceDescriptorContents(handle, replacement);
        } catch (_error) {
            // Preserve the previous bytes when a partial descriptor write
            // fails. If recovery fails as well, the operation is explicitly a
            // failure and never reported as applied.
            try { await replaceDescriptorContents(handle, sourceBytes); } catch (_restoreError) { /* no-op */ }
            return 'failed';
        }
        return 'applied';
    } catch (_error) {
        return 'stale';
    } finally {
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

async function replaceDescriptorContents(handle: FileHandle, contents: Buffer): Promise<void> {
    await handle.truncate(0);
    let offset = 0;
    while (offset < contents.length) {
        const result = await handle.write(contents, offset, contents.length - offset, offset);
        if (!result.bytesWritten) { throw new Error('Could not write Markdown document.'); }
        offset += result.bytesWritten;
    }
    await handle.sync();
}
