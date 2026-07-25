'use strict';

import type { AiSessionDisposable } from '../types';
import { CONVERSATION_LIMITS, ConversationAbortError, ConversationAbortSignal, ConversationError } from './types';
import { isConversationSourceContinuation, OpenConversationSource } from './source';

export interface ConversationJsonlReadOptions {
    startOffset?: number;
    signal?: ConversationAbortSignal;
    now?: () => number;
    onRecord?: (record: ConversationJsonlRecord) => void;
}

export interface ConversationJsonlRecord {
    offset: number;
    value: unknown;
}

export interface ConversationJsonlReadResult {
    records: ConversationJsonlRecord[];
    nextOffset: number;
    malformedLines: number;
    oversizedLines: number;
    partial: boolean;
}

export async function getConversationReadStart(
    current: OpenConversationSource,
    previous?: {
        source: OpenConversationSource;
        nextOffset: number;
    }
): Promise<number> {
    const coldStart = Math.max(0, current.size - CONVERSATION_LIMITS.maxSourceBytes);
    if (!previous || !Number.isSafeInteger(previous.nextOffset)
        || previous.nextOffset < 0 || previous.nextOffset > previous.source.size
        || previous.nextOffset > current.size || previous.nextOffset < coldStart) {
        return coldStart;
    }
    return await isConversationSourceContinuation(previous.source, current)
        ? previous.nextOffset
        : coldStart;
}

function checkedStartOffset(size: number, value: number | undefined): number | undefined {
    if (!Number.isFinite(value) || Math.floor(value as number) !== value
        || (value as number) < 0 || (value as number) > size) {
        return undefined;
    }
    return value;
}

export async function readConversationJsonl(
    source: OpenConversationSource,
    options?: ConversationJsonlReadOptions
): Promise<ConversationJsonlReadResult> {
    const normalizedOptions = options || {};
    const now = normalizedOptions.now || Date.now;
    const deadline = now() + CONVERSATION_LIMITS.jsonlScanTimeoutMs;
    const checkDeadline = (): void => {
        if (now() >= deadline) {
            throw new ConversationError('timeout');
        }
    };
    const requestedStart = checkedStartOffset(source.size, normalizedOptions.startOffset);
    const startOffset = requestedStart === undefined
        ? Math.max(0, source.size - CONVERSATION_LIMITS.maxSourceBytes)
        : requestedStart;
    const discardInitialPartialLine = requestedStart === undefined && startOffset > 0;
    const records: ConversationJsonlRecord[] = [];
    let malformedLines = 0;
    let oversizedLines = 0;
    let readOffset = startOffset;
    let lineStart = startOffset;
    let lineBytes = 0;
    let oversized = false;
    let initialPartial = discardInitialPartialLine;
    const fragments: Buffer[] = [];
    let bytesSinceYield = 0;

    const checkAbort = (): void => {
        if (normalizedOptions.signal?.aborted) {
            throw new ConversationAbortError();
        }
    };
    const resetLine = (nextLineStart: number): void => {
        lineStart = nextLineStart;
        lineBytes = 0;
        oversized = false;
        fragments.length = 0;
    };
    const appendLineBytes = (fragment: Buffer): void => {
        if (!fragment.length || oversized) {
            return;
        }
        lineBytes += fragment.length;
        if (lineBytes > CONVERSATION_LIMITS.maxLineBytes) {
            oversized = true;
            fragments.length = 0;
            return;
        }
        fragments.push(Buffer.from(fragment));
    };
    const finishLine = (): void => {
        if (initialPartial) {
            initialPartial = false;
            resetLine(readOffset);
            return;
        }
        if (oversized) {
            oversizedLines += 1;
            resetLine(readOffset);
            return;
        }
        if (!lineBytes) {
            resetLine(readOffset);
            return;
        }
        let record: ConversationJsonlRecord;
        try {
            record = {
                offset: lineStart,
                value: JSON.parse(Buffer.concat(fragments).toString('utf8')),
            };
        } catch (_error) {
            malformedLines += 1;
            resetLine(readOffset);
            return;
        }
        records.push(record);
        normalizedOptions.onRecord?.(record);
        resetLine(readOffset);
    };

    while (readOffset < source.size) {
        checkAbort();
        checkDeadline();
        const length = Math.min(CONVERSATION_LIMITS.readChunkBytes, source.size - readOffset);
        const buffer = Buffer.alloc(length);
        const result = await source.handle.read(buffer, 0, length, readOffset);
        checkDeadline();
        if (result.bytesRead <= 0) {
            break;
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        let chunkIndex = 0;
        while (chunkIndex < chunk.length) {
            const newlineIndex = chunk.indexOf(0x0a, chunkIndex);
            if (newlineIndex < 0) {
                if (!initialPartial) {
                    appendLineBytes(chunk.subarray(chunkIndex));
                }
                break;
            }
            if (!initialPartial) {
                appendLineBytes(chunk.subarray(chunkIndex, newlineIndex));
            }
            readOffset += newlineIndex + 1 - chunkIndex;
            finishLine();
            chunkIndex = newlineIndex + 1;
        }
        if (chunkIndex < chunk.length) {
            readOffset += chunk.length - chunkIndex;
        } else if (chunkIndex === chunk.length) {
            // The last byte was a newline and has already advanced readOffset.
        }
        bytesSinceYield += result.bytesRead;
        if (bytesSinceYield >= CONVERSATION_LIMITS.yieldEveryBytes) {
            checkAbort();
            checkDeadline();
            await new Promise<void>(resolve => setImmediate(resolve));
            checkDeadline();
            bytesSinceYield = 0;
        }
    }
    if (!initialPartial && lineBytes) {
        if (oversized) {
            oversizedLines += 1;
        } else {
            let record: ConversationJsonlRecord;
            try {
                record = {
                    offset: lineStart,
                    value: JSON.parse(Buffer.concat(fragments).toString('utf8')),
                };
            } catch (_error) {
                malformedLines += 1;
                record = undefined;
            }
            if (record) {
                records.push(record);
                normalizedOptions.onRecord?.(record);
            }
        }
    }
    return {
        records,
        nextOffset: readOffset,
        malformedLines,
        oversizedLines,
        partial: startOffset > 0,
    };
}

export class ConversationIndexCache<T extends { dispose(): void }> {
    private readonly entries = new Map<string, {
        value: T;
        lastUsedAt: number;
        retainCount: number;
    }>();

    constructor(private readonly now: () => number) {}

    set(key: string, value: T): void {
        this.delete(key);
        this.entries.set(key, { value, lastUsedAt: this.now(), retainCount: 0 });
        this.evict();
    }

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            entry.lastUsedAt = this.now();
        }
        return entry?.value;
    }

    retain(key: string): AiSessionDisposable {
        const entry = this.entries.get(key);
        if (entry) {
            entry.retainCount += 1;
        }
        return {
            dispose: () => {
                const current = this.entries.get(key);
                if (current) {
                    current.retainCount = Math.max(0, current.retainCount - 1);
                    current.lastUsedAt = this.now();
                    this.evict();
                }
            },
        };
    }

    clear(): void {
        Array.from(this.entries.values()).forEach(entry => entry.value.dispose());
        this.entries.clear();
    }

    private delete(key: string): void {
        this.entries.get(key)?.value.dispose();
        this.entries.delete(key);
    }

    private evict(): void {
        const inactive = Array.from(this.entries.entries())
            .filter(([, entry]) => entry.retainCount === 0)
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        inactive
            .filter(([, entry], index) =>
                this.now() - entry.lastUsedAt > CONVERSATION_LIMITS.inactiveIndexTtlMs
                || index < inactive.length
                    - CONVERSATION_LIMITS.inactiveIndexLimitPerProvider
            )
            .forEach(([key]) => this.delete(key));
    }
}
