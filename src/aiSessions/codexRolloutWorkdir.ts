'use strict';

import * as fs from 'fs';

// Stream cold reads and cache completed records; never retain transcript text.
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_ROLLOUTS = 64;
interface RolloutCacheEntry {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    offset: number;
    fingerprint: Buffer;
    value: CodexRolloutTelemetry;
}
const cache = new Map<string, RolloutCacheEntry>();
const reads = new Map<string, Promise<CodexRolloutTelemetry | undefined>>();

const WORKDIR_PATTERN = /\bworkdir\b"?\s*:\s*"([^"]+)"/;

export interface CodexRolloutTelemetry {
    model?: string;
    context?: {
        usedTokens: number;
        maxTokens: number;
    };
    currentWorkdir?: string;
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function acceptRecord(line: string, value: CodexRolloutTelemetry): void {
    let record: Record<string, any> | undefined;
    try { record = asRecord(JSON.parse(line)); } catch { return; }
    const payload = asRecord(record?.payload);
    if (record?.type === 'turn_context' && typeof payload?.model === 'string'
        && payload.model.trim()) {
        value.model = payload.model.trim().slice(0, 128);
    }
    if (record?.type === 'event_msg' && payload?.type === 'token_count') {
        const info = asRecord(payload.info);
        const last = asRecord(info?.last_token_usage);
        if (Number.isSafeInteger(last?.total_tokens) && last.total_tokens >= 0
            && Number.isSafeInteger(info?.model_context_window)
            && info.model_context_window > 0) {
            value.context = {
                usedTokens: last.total_tokens,
                maxTokens: info.model_context_window,
            };
        }
    }
    if (typeof payload?.input === 'string') {
        const match = WORKDIR_PATTERN.exec(payload.input);
        if (match?.[1]) {
            value.currentWorkdir = match[1];
        }
    }
}

function copy(value: CodexRolloutTelemetry): CodexRolloutTelemetry | undefined {
    return Object.keys(value).length ? {
        ...value,
        ...(value.context ? { context: { ...value.context } } : {}),
    } : undefined;
}

async function scanRollout(rolloutPath: string): Promise<CodexRolloutTelemetry | undefined> {
    const file = await fs.promises.open(rolloutPath, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile()) {
            return undefined;
        }
        const previous = cache.get(rolloutPath);
        let continuing = previous && previous.dev === stat.dev && previous.ino === stat.ino
            && stat.size >= previous.size
            && (stat.size !== previous.size || stat.mtimeMs === previous.mtimeMs);
        if (continuing) {
            const probe = Buffer.alloc(previous.fingerprint.length);
            await file.read(probe, 0, probe.length, previous.offset - probe.length);
            continuing = probe.equals(previous.fingerprint);
        }
        if (continuing && previous.size === stat.size) {
            return copy(previous.value);
        }
        const value = continuing ? copy(previous.value) || {} : {};
        let offset = continuing ? previous.offset : 0;
        let committedOffset = offset;
        let pending = Buffer.alloc(0);
        let oversized = false;
        const buffer = Buffer.alloc(READ_CHUNK_BYTES);
        while (offset < stat.size) {
            const { bytesRead } = await file.read(buffer, 0,
                Math.min(buffer.length, stat.size - offset), offset);
            if (!bytesRead) {
                throw new Error('Rollout changed during telemetry read');
            }
            let start = 0;
            for (let end = 0; end < bytesRead; end++) {
                if (buffer[end] !== 10) {
                    continue;
                }
                const part = buffer.subarray(start, end);
                if (!oversized && pending.length + part.length <= MAX_RECORD_BYTES) {
                    acceptRecord(Buffer.concat([pending, part]).toString('utf8'), value);
                }
                pending = Buffer.alloc(0);
                oversized = false;
                committedOffset = offset + end + 1;
                start = end + 1;
            }
            const tail = buffer.subarray(start, bytesRead);
            if (!oversized && pending.length + tail.length <= MAX_RECORD_BYTES) {
                pending = Buffer.concat([pending, tail]);
            } else {
                pending = Buffer.alloc(0);
                oversized = true;
            }
            offset += bytesRead;
        }
        const fingerprint = Buffer.alloc(Math.min(128, committedOffset));
        await file.read(fingerprint, 0, fingerprint.length, committedOffset - fingerprint.length);
        cache.delete(rolloutPath);
        cache.set(rolloutPath, {
            dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
            offset: committedOffset, fingerprint, value,
        });
        while (cache.size > MAX_CACHED_ROLLOUTS) {
            cache.delete(cache.keys().next().value);
        }
        return copy(value);
    } finally {
        await file.close();
    }
}

export async function readCodexRolloutTelemetry(
    rolloutPath: string
): Promise<CodexRolloutTelemetry | undefined> {
    if (!rolloutPath) {
        return undefined;
    }
    const existing = reads.get(rolloutPath);
    if (existing) {
        return existing.then(value => value && copy(value));
    }
    const read = scanRollout(rolloutPath);
    reads.set(rolloutPath, read);
    try { return await read; } finally { reads.delete(rolloutPath); }
}

/**
 * Telemetry-only probe: app-server does not expose exec items, so the latest
 * exec workdir is read from the incremental rollout scan. Conversation content
 * remains app-server-only; this probe never feeds messages or outline data.
 */
export async function readCodexRolloutWorkdir(
    rolloutPath: string
): Promise<string | undefined> {
    return (await readCodexRolloutTelemetry(rolloutPath))?.currentWorkdir;
}
