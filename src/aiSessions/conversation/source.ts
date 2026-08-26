'use strict';

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionConversationSourceCandidate } from '../types';
import type { ConversationAbortSignal } from './types';

const NO_FOLLOW_FLAG =
    (fs.constants as Record<string, number>).O_NOFOLLOW || 0;

export interface OpenConversationSource {
    canonicalProviderHome: string;
    canonicalPath: string;
    handle: fs.promises.FileHandle;
    size: number;
    mtimeMs: number;
    device?: number;
    inode?: number;
    birthtimeMs?: number;
    portableFirstHash?: string;
    portableLastHash?: string;
    identity: string;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith(`..${path.sep}`)
        && relative !== '..' && !path.isAbsolute(relative);
}

async function hashRange(
    handle: fs.promises.FileHandle,
    position: number,
    length: number
): Promise<string> {
    const buffer = Buffer.alloc(Math.max(0, length));
    const result = await handle.read(buffer, 0, buffer.length, position);
    return createHash('sha256')
        .update(buffer.subarray(0, result.bytesRead))
        .digest('hex');
}

/** Hashes an already validated physical JSONL record range. */
export async function digestConversationSourceRange(
    source: OpenConversationSource,
    startOffset: number,
    endOffset: number,
    signal?: ConversationAbortSignal
): Promise<string | undefined> {
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
        || startOffset < 0 || endOffset <= startOffset
        || endOffset > source.size
        || endOffset - startOffset > CONVERSATION_RECORD_PROOF_MAX_BYTES) {
        return undefined;
    }
    if (signal?.aborted) {
        return undefined;
    }
    const digest = await hashRange(source.handle, startOffset, endOffset - startOffset);
    return signal?.aborted ? undefined : digest;
}

/** Hashes one bounded background-index segment without allocating it whole. */
export async function digestConversationSourceSegment(
    source: OpenConversationSource,
    startOffset: number,
    endOffset: number,
    signal?: ConversationAbortSignal
): Promise<string | undefined> {
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
        || startOffset < 0 || endOffset <= startOffset
        || endOffset > source.size
        || endOffset - startOffset > CONVERSATION_HISTORY_SEGMENT_PROOF_MAX_BYTES) {
        return undefined;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = startOffset;
    while (offset < endOffset) {
        if (signal?.aborted) {
            return undefined;
        }
        const length = Math.min(buffer.length, endOffset - offset);
        const result = await source.handle.read(buffer, 0, length, offset);
        if (signal?.aborted || result.bytesRead <= 0) {
            return undefined;
        }
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
    }
    return hash.digest('hex');
}

const CONVERSATION_RECORD_PROOF_MAX_BYTES = 1024 * 1024 + 1;
// A 4 MiB requested slice may complete the physical line straddling its
// boundary. JSONL rejects lines over 1 MiB, so 8 MiB is a hard ceiling with
// room for format evolution while keeping verification bounded.
const CONVERSATION_HISTORY_SEGMENT_PROOF_MAX_BYTES = 10 * 1024 * 1024;

function hasStableFileIdentity(stat: fs.Stats): boolean {
    return Number.isFinite(stat.dev) && stat.dev > 0
        && Number.isFinite(stat.ino) && stat.ino > 0
        && Number.isFinite(stat.birthtimeMs);
}

function hasMatchingStableFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.birthtimeMs === right.birthtimeMs;
}

async function hasMatchingPortableEdges(
    handle: fs.promises.FileHandle,
    stat: fs.Stats,
    sourcePath: string,
    noFollowFlag: number
): Promise<boolean> {
    let verificationHandle: fs.promises.FileHandle;
    try {
        verificationHandle = await fs.promises.open(
            sourcePath,
            fs.constants.O_RDONLY | noFollowFlag
        );
        const verificationStat = await verificationHandle.stat();
        if (!verificationStat.isFile() || verificationStat.size !== stat.size) {
            return false;
        }
        const edgeBytes = Math.min(64 * 1024, stat.size);
        const [firstHash, lastHash, verificationFirstHash, verificationLastHash] = await Promise.all([
            hashRange(handle, 0, edgeBytes),
            hashRange(handle, Math.max(0, stat.size - edgeBytes), edgeBytes),
            hashRange(verificationHandle, 0, edgeBytes),
            hashRange(verificationHandle, Math.max(0, verificationStat.size - edgeBytes), edgeBytes),
        ]);
        return firstHash === verificationFirstHash && lastHash === verificationLastHash;
    } catch (_error) {
        return false;
    } finally {
        await verificationHandle?.close().catch(() => undefined);
    }
}

export async function openValidatedConversationSource(
    candidate: AiSessionConversationSourceCandidate,
    options: {
        forcePortableIdentity?: boolean;
        noFollowFlag?: number;
        openFile?: (
            sourcePath: string,
            flags: number
        ) => Promise<fs.promises.FileHandle>;
    } = {}
): Promise<OpenConversationSource | null> {
    let canonicalProviderHome: string;
    let canonicalPath: string;
    try {
        canonicalProviderHome = await fs.promises.realpath(candidate.providerHome);
        canonicalPath = await fs.promises.realpath(candidate.sourcePath);
    } catch (_error) {
        return null;
    }
    if (!isInside(canonicalProviderHome, canonicalPath)) {
        return null;
    }
    let handle: fs.promises.FileHandle;
    try {
        const noFollowFlag = options.noFollowFlag === undefined
            ? NO_FOLLOW_FLAG
            : options.noFollowFlag;
        const openFile = options.openFile || fs.promises.open;
        handle = await openFile(
            canonicalPath,
            fs.constants.O_RDONLY | noFollowFlag
        );
        const pathAfterOpen = await fs.promises.realpath(canonicalPath);
        if (pathAfterOpen !== canonicalPath
            || !isInside(canonicalProviderHome, pathAfterOpen)) {
            await handle.close();
            return null;
        }
        const stat = await handle.stat();
        const pathStat = await fs.promises.stat(pathAfterOpen);
        if (!stat.isFile()) {
            await handle.close();
            return null;
        }
        const hasStableIdentity = hasStableFileIdentity(stat)
            && hasStableFileIdentity(pathStat);
        if (hasStableIdentity
            ? !hasMatchingStableFileIdentity(stat, pathStat)
            : !await hasMatchingPortableEdges(handle, stat, pathAfterOpen, noFollowFlag)) {
            await handle.close();
            return null;
        }
        const hasStableInode = !options.forcePortableIdentity
            && hasStableFileIdentity(stat);
        const edgeBytes = Math.min(64 * 1024, stat.size);
        const firstHash = await hashRange(handle, 0, edgeBytes);
        const lastHash = await hashRange(
            handle,
            Math.max(0, stat.size - edgeBytes),
            edgeBytes
        );
        const identity = hasStableInode
            ? `inode:${canonicalPath}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}`
            : `portable:${canonicalPath}:${stat.size}:${stat.mtimeMs}:${firstHash}:${lastHash}`;
        return {
            canonicalProviderHome,
            canonicalPath,
            handle,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            device: hasStableInode ? stat.dev : undefined,
            inode: hasStableInode ? stat.ino : undefined,
            birthtimeMs: hasStableInode ? stat.birthtimeMs : undefined,
            portableFirstHash: firstHash,
            portableLastHash: lastHash,
            identity,
        };
    } catch (_error) {
        await handle?.close().catch(() => undefined);
        return null;
    }
}

export async function isConversationSourceContinuation(
    previous: OpenConversationSource,
    current: OpenConversationSource
): Promise<boolean> {
    if (previous.canonicalPath !== current.canonicalPath
        || current.size < previous.size) {
        return false;
    }
    if (previous.portableFirstHash === undefined
        || previous.portableLastHash === undefined) {
        return false;
    }
    const edgeBytes = Math.min(64 * 1024, previous.size);
    const currentOldFirstHash = await hashRange(current.handle, 0, edgeBytes);
    const currentOldLastHash = await hashRange(
        current.handle,
        Math.max(0, previous.size - edgeBytes),
        edgeBytes
    );
    if (currentOldFirstHash !== previous.portableFirstHash
        || currentOldLastHash !== previous.portableLastHash) {
        return false;
    }
    if (previous.device !== undefined && previous.inode !== undefined
        && previous.birthtimeMs !== undefined
        && current.device !== undefined && current.inode !== undefined
        && current.birthtimeMs !== undefined) {
        return previous.device === current.device
            && previous.inode === current.inode
            && previous.birthtimeMs === current.birthtimeMs;
    }
    return true;
}
