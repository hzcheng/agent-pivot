'use strict';

/**
 * The historical side of an append-only conversation source.
 *
 * `OpenConversationSource.identity` deliberately includes size and mtime so
 * normal adapter caches notice a new tail immediately.  That is the wrong
 * identity for an index which is allowed to survive an append: this epoch
 * only changes when the underlying file instance (or the portable prefix)
 * changes.
 */
export interface ConversationHistorySourceEpoch {
    readonly value: string;
}

export interface ConversationHistoryScanTicket {
    readonly epoch: ConversationHistorySourceEpoch;
    readonly token: number;
    readonly startOffset: number;
}

export interface ConversationHistoryCheckpoint<TState> {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly state: TState;
    readonly estimatedBytes: number;
}

export interface ConversationHistoryCoverage {
    readonly epoch: ConversationHistorySourceEpoch | undefined;
    readonly nextOffset: number;
    readonly checkpointCount: number;
    readonly estimatedBytes: number;
}

/**
 * A small, deliberately provider-agnostic transaction log for a background
 * JSONL reducer.  Provider adapters keep their own reducer state in each
 * checkpoint; this class owns only epoch, frontier and late-result safety.
 */
export class ConversationHistoryIndex<TState> {
    private epoch: ConversationHistorySourceEpoch | undefined;
    private nextOffset = 0;
    private token = 0;
    private estimatedBytes = 0;
    private readonly checkpoints: ConversationHistoryCheckpoint<TState>[] = [];

    constructor(private readonly maxBytes: number) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
            throw new Error('maxBytes must be a positive safe integer');
        }
    }

    coverage(): ConversationHistoryCoverage {
        return {
            epoch: this.epoch,
            nextOffset: this.nextOffset,
            checkpointCount: this.checkpoints.length,
            estimatedBytes: this.estimatedBytes,
        };
    }

    checkpointSnapshot(): readonly ConversationHistoryCheckpoint<TState>[] {
        return this.checkpoints.slice();
    }

    /**
     * Starts (or supersedes) a scan.  Reusing an epoch is intentionally opt
     * in: stable inode identity alone does not prove that a source was merely
     * appended (a truncate or in-place rewrite may keep the same inode).
     * The caller owns both the continuation verification and cancelling I/O.
     */
    begin(
        epoch: ConversationHistorySourceEpoch,
        canReuseCoveredPrefix = false
    ): ConversationHistoryScanTicket {
        if (this.epoch?.value !== epoch.value || !canReuseCoveredPrefix) {
            this.reset(epoch);
        }
        this.token += 1;
        return {
            epoch,
            token: this.token,
            startOffset: this.nextOffset,
        };
    }

    /**
     * Atomically appends a completed reducer checkpoint.  A late task cannot
     * advance a new epoch, a replacement task, or a newer frontier.
     */
    commit(
        ticket: ConversationHistoryScanTicket,
        checkpoint: ConversationHistoryCheckpoint<TState>
    ): boolean {
        if (ticket.token !== this.token
            || ticket.epoch.value !== this.epoch?.value
            || ticket.startOffset !== this.nextOffset
            || checkpoint.startOffset !== this.nextOffset
            || !Number.isSafeInteger(checkpoint.endOffset)
            || checkpoint.endOffset <= checkpoint.startOffset
            || !Number.isSafeInteger(checkpoint.estimatedBytes)
            || checkpoint.estimatedBytes < 0
            || checkpoint.estimatedBytes > this.maxBytes
            || this.estimatedBytes + checkpoint.estimatedBytes > this.maxBytes) {
            return false;
        }
        this.checkpoints.push(checkpoint);
        this.nextOffset = checkpoint.endOffset;
        this.estimatedBytes += checkpoint.estimatedBytes;
        return true;
    }

    /** Invalidates active tickets before dropping stale reducer state. */
    invalidate(): void {
        this.token += 1;
        this.reset(undefined);
    }

    private reset(epoch: ConversationHistorySourceEpoch | undefined): void {
        this.epoch = epoch;
        this.nextOffset = 0;
        this.estimatedBytes = 0;
        this.checkpoints.length = 0;
    }
}

/**
 * Stable across append-only growth, unlike OpenConversationSource.identity.
 * A caller must still verify append continuity before resuming I/O; this
 * value simply makes an append distinct from replacement at commit time.
 */
export function conversationHistorySourceEpoch(source: {
    canonicalPath: string;
    device?: number;
    inode?: number;
    birthtimeMs?: number;
    portableFirstHash?: string;
}): ConversationHistorySourceEpoch {
    if (source.device !== undefined && source.inode !== undefined
        && source.birthtimeMs !== undefined) {
        return {
            value: `inode:${source.canonicalPath}:${source.device}:${source.inode}:${source.birthtimeMs}`,
        };
    }
    return {
        value: `portable:${source.canonicalPath}:${source.portableFirstHash || ''}`,
    };
}
