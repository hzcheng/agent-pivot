'use strict';

import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { open as openFilePath, realpath as realpathPath } from 'fs/promises';
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
        handle = await openFilePath(canonicalCandidate,
            fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
        const descriptorPath = await openedDescriptorPath(handle, canonicalCandidate);
        if (!isContained(canonicalRoot, descriptorPath)) {
            return 'stale';
        }
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_MARKDOWN_BYTES) {
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
    // ancestor pathname swap. Other platforms still get the final no-follow
    // descriptor plus a fresh canonical path check; they fail closed if that
    // object no longer resolves inside the expected worktree.
    if (process.platform === 'linux') {
        return realpathPath(`/proc/self/fd/${handle.fd}`);
    }
    return realpathPath(fallback);
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
