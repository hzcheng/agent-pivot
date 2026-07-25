'use strict';

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionConversationSourceCandidate } from '../types';

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
        if (noFollowFlag === 0
            && Number.isFinite(stat.dev) && stat.dev > 0
            && Number.isFinite(stat.ino) && stat.ino > 0
            && (stat.dev !== pathStat.dev
                || stat.ino !== pathStat.ino
                || stat.birthtimeMs !== pathStat.birthtimeMs)) {
            await handle.close();
            return null;
        }
        const hasStableInode = !options.forcePortableIdentity
            && Number.isFinite(stat.dev) && stat.dev > 0
            && Number.isFinite(stat.ino) && stat.ino > 0;
        const edgeBytes = Math.min(64 * 1024, stat.size);
        const firstHash = hasStableInode
            ? ''
            : await hashRange(handle, 0, edgeBytes);
        const lastHash = hasStableInode
            ? ''
            : await hashRange(handle, Math.max(0, stat.size - edgeBytes), edgeBytes);
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
            portableFirstHash: hasStableInode ? undefined : firstHash,
            portableLastHash: hasStableInode ? undefined : lastHash,
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
    if (previous.device !== undefined && previous.inode !== undefined
        && previous.birthtimeMs !== undefined
        && current.device !== undefined && current.inode !== undefined
        && current.birthtimeMs !== undefined) {
        return previous.device === current.device
            && previous.inode === current.inode
            && previous.birthtimeMs === current.birthtimeMs;
    }
    if (previous.portableFirstHash === undefined
        || previous.portableLastHash === undefined
        || current.portableFirstHash === undefined) {
        return false;
    }
    const edgeBytes = Math.min(64 * 1024, previous.size);
    const currentOldFirstHash = await hashRange(current.handle, 0, edgeBytes);
    const currentOldLastHash = await hashRange(
        current.handle,
        Math.max(0, previous.size - edgeBytes),
        edgeBytes
    );
    return currentOldFirstHash === previous.portableFirstHash
        && currentOldLastHash === previous.portableLastHash;
}
