'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationHistoryIndexSlice,
    ConversationHistoryIndexSliceRequest,
    ConversationHistoryRestartSnapshot,
    ConversationInteraction,
} from './types';

export interface ConversationHistoryIndexState {
    sourceIdentity: string;
    sourceSize: number;
    sourceRevision: string;
    reducerVersion: 1;
    sourceEpoch: string;
    sourceFirstHash: string;
    sourceLastHash: string;
    nextOffset: number;
    /** Last reducer-safe restart retained by this entry. */
    restartOffset: number;
    restartInteractionCount: number;
    restartInteractionId?: string;
    restartRecordEndOffset?: number;
    restartRecordDigest?: string;
    /** Exact contiguous byte segments that prove the retained prefix. */
    prefixSegments: ConversationHistoryIndexSegmentProof[];
    interactions: ConversationInteraction[];
    complete: boolean;
    /** The bounded index cannot safely provide a complete paging source. */
    saturated: boolean;
    /** A range budget ended before a provider-proved restart boundary. */
    blocked: boolean;
}

export interface ConversationHistoryIndexSegmentProof {
    startOffset: number;
    endOffset: number;
    digest: string;
}

export interface ConversationHistoryIndexStatus {
    sourceRevision: string;
    complete: boolean;
    saturated: boolean;
    blocked: boolean;
}

export type ReadConversationHistoryIndexSlice = (
    request: ConversationHistoryIndexSliceRequest,
    signal?: ConversationAbortSignal
) => Promise<ConversationHistoryIndexSlice | undefined>;

interface ConversationHistoryIndexEntry extends ConversationHistoryIndexState {
    taskToken: number;
    serializedBytes: number;
}

function sameSnapshot(
    left: Pick<ConversationHistoryRestartSnapshot,
        'sourceIdentity' | 'sourceSize' | 'sourceRevision' | 'reducerVersion'>,
    right: Pick<ConversationHistoryRestartSnapshot,
        'sourceIdentity' | 'sourceSize' | 'sourceRevision' | 'reducerVersion'>
): boolean {
    return left.sourceIdentity === right.sourceIdentity
        && left.sourceSize === right.sourceSize
        && left.sourceRevision === right.sourceRevision
        && left.reducerVersion === right.reducerVersion;
}

function cloneInteractions(
    interactions: readonly ConversationInteraction[]
): ConversationInteraction[] {
    return interactions.map(interaction => ({
        ...interaction,
        assistantMarkdown: interaction.assistantMarkdown.slice(),
        ...(interaction.assistantPhases
            ? { assistantPhases: interaction.assistantPhases.slice() }
            : {}),
        ...(interaction.toolCalls
            ? { toolCalls: interaction.toolCalls.slice() }
            : {}),
        ...(interaction.thinking
            ? { thinking: interaction.thinking.slice() }
            : {}),
        ...(interaction.plans
            ? { plans: interaction.plans.slice() }
            : {}),
        ...(interaction.questions
            ? { questions: interaction.questions.slice() }
            : {}),
    }));
}

function serializedInteractionBytes(
    interactions: readonly ConversationInteraction[]
): number {
    return interactions.reduce((total, interaction) => total + Buffer.byteLength(
        JSON.stringify(interaction),
        'utf8'
    ), 0);
}

function hasContiguousPrefixProof(
    segments: readonly ConversationHistoryIndexSegmentProof[],
    endOffset: number
): boolean {
    let expectedOffset = 0;
    for (const segment of segments) {
        if (!Number.isSafeInteger(segment.startOffset)
            || !Number.isSafeInteger(segment.endOffset)
            || segment.startOffset !== expectedOffset
            || segment.endOffset <= segment.startOffset
            || !segment.digest) {
            return false;
        }
        expectedOffset = segment.endOffset;
    }
    return expectedOffset === endOffset;
}

function snapshot(entry: ConversationHistoryIndexEntry): ConversationHistoryIndexState {
    return {
        sourceIdentity: entry.sourceIdentity,
        sourceSize: entry.sourceSize,
        sourceRevision: entry.sourceRevision,
        reducerVersion: entry.reducerVersion,
        sourceEpoch: entry.sourceEpoch,
        sourceFirstHash: entry.sourceFirstHash,
        sourceLastHash: entry.sourceLastHash,
        nextOffset: entry.nextOffset,
        restartOffset: entry.restartOffset,
        restartInteractionCount: entry.restartInteractionCount,
        ...(entry.restartInteractionId !== undefined
            ? { restartInteractionId: entry.restartInteractionId }
            : {}),
        ...(entry.restartRecordEndOffset !== undefined
            ? { restartRecordEndOffset: entry.restartRecordEndOffset }
            : {}),
        ...(entry.restartRecordDigest !== undefined
            ? { restartRecordDigest: entry.restartRecordDigest }
            : {}),
        prefixSegments: entry.prefixSegments.map(segment => ({ ...segment })),
        interactions: cloneInteractions(entry.interactions),
        complete: entry.complete,
        saturated: entry.saturated,
        blocked: entry.blocked,
    };
}

/**
 * Owns the non-provider-specific part of background history indexing.
 * Reducers remain in their adapters; this class admits a completed immutable
 * segment only when the original entry, source epoch, request frontier, and
 * task token still all match.
 */
export class ConversationHistoryIndex {
    private readonly entries = new Map<string, ConversationHistoryIndexEntry>();

    state(key: string): ConversationHistoryIndexState | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            // Map insertion order is the LRU order. Reinsert the same object
            // so in-flight token/object identity remains valid.
            this.entries.delete(key);
            this.entries.set(key, entry);
        }
        return entry ? snapshot(entry) : undefined;
    }

    /** Lightweight foreground status; never clones indexed conversation data. */
    status(key: string): ConversationHistoryIndexStatus | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return {
            sourceRevision: entry.sourceRevision,
            complete: entry.complete,
            saturated: entry.saturated,
            blocked: entry.blocked,
        };
    }

    /** Internal immutable-by-convention source for foreground page builders. */
    completedInteractions(
        key: string,
        sourceRevision: string
    ): ConversationInteraction[] | undefined {
        const entry = this.entries.get(key);
        if (!entry || !entry.complete || entry.sourceRevision !== sourceRevision) {
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.interactions;
    }

    invalidate(key: string): void {
        const entry = this.entries.get(key);
        if (entry) {
            entry.taskToken += 1;
            this.entries.delete(key);
        }
    }

    async advance(
        key: string,
        source: ConversationHistoryRestartSnapshot,
        readSlice: ReadConversationHistoryIndexSlice,
        signal?: ConversationAbortSignal
    ): Promise<ConversationHistoryIndexState | undefined> {
        let entry = this.entries.get(key);
        if (!entry || !sameSnapshot(entry, source)) {
            const continuation = entry && source.continuationOf;
            const canContinue = !!continuation
                && continuation.sourceIdentity === entry.sourceIdentity
                && continuation.sourceSize === entry.sourceSize
                && continuation.sourceRevision === entry.sourceRevision
                && continuation.reducerVersion === entry.reducerVersion
                && source.sourceEpoch === entry.sourceEpoch
                && source.sourceSize >= entry.sourceSize
                && entry.restartOffset <= entry.sourceSize
                && entry.restartInteractionCount <= entry.interactions.length
                && hasContiguousPrefixProof(
                    entry.prefixSegments.filter(segment =>
                        segment.endOffset <= entry.restartOffset),
                    entry.restartOffset
                );
            const retained = canContinue
                ? entry.interactions.slice(0, entry.restartInteractionCount)
                : [];
            entry = {
                sourceIdentity: source.sourceIdentity,
                sourceSize: source.sourceSize,
                sourceRevision: source.sourceRevision,
                reducerVersion: source.reducerVersion,
                sourceEpoch: source.sourceEpoch,
                sourceFirstHash: source.sourceFirstHash,
                sourceLastHash: source.sourceLastHash,
                nextOffset: canContinue ? entry.restartOffset : 0,
                restartOffset: canContinue ? entry.restartOffset : 0,
                restartInteractionCount: retained.length,
                ...(canContinue && entry.restartInteractionId !== undefined
                    ? { restartInteractionId: entry.restartInteractionId }
                    : {}),
                ...(canContinue && entry.restartRecordEndOffset !== undefined
                    ? { restartRecordEndOffset: entry.restartRecordEndOffset }
                    : {}),
                ...(canContinue && entry.restartRecordDigest !== undefined
                    ? { restartRecordDigest: entry.restartRecordDigest }
                    : {}),
                prefixSegments: canContinue
                    ? entry.prefixSegments
                        .filter(segment => segment.endOffset <= entry.restartOffset)
                        .map(segment => ({ ...segment }))
                    : [],
                interactions: retained,
                complete: false,
                saturated: false,
                blocked: false,
                taskToken: 0,
                serializedBytes: serializedInteractionBytes(retained),
            };
            this.entries.set(key, entry);
            this.evictEntries();
        }
        if (entry.complete || entry.saturated || entry.blocked || signal?.aborted) {
            return snapshot(entry);
        }
        const taskToken = ++entry.taskToken;
        const startOffset = entry.nextOffset;
        const slice = await readSlice({
            sourceIdentity: source.sourceIdentity,
            sourceSize: source.sourceSize,
            sourceRevision: source.sourceRevision,
            reducerVersion: source.reducerVersion,
            startOffset,
        }, signal);
        if (!slice || signal?.aborted
            || this.entries.get(key) !== entry
            || entry.taskToken !== taskToken
            || !sameSnapshot(slice, source)
            || slice.startOffset !== startOffset) {
            return undefined;
        }
        if (slice.blocked) {
            if (slice.complete || slice.nextOffset !== undefined
                || slice.interactions.length) {
                return undefined;
            }
            entry.blocked = true;
            this.releaseUnusablePayload(entry);
            return snapshot(entry);
        }
        if (slice.complete) {
            if (slice.nextOffset !== undefined
                || typeof slice.completeSegmentDigest !== 'string'
                || !slice.completeSegmentDigest) {
                return undefined;
            }
        } else if (!Number.isSafeInteger(slice.nextOffset)
            || slice.nextOffset <= startOffset
            || slice.nextOffset > source.sourceSize
            || typeof slice.restartInteractionId !== 'string'
            || !slice.restartInteractionId
            || !Number.isSafeInteger(slice.restartRecordEndOffset)
            || slice.restartRecordEndOffset <= slice.nextOffset
            || slice.restartRecordEndOffset > source.sourceSize
            || typeof slice.restartRecordDigest !== 'string'
            || !slice.restartRecordDigest
            || typeof slice.restartSegmentDigest !== 'string'
            || !slice.restartSegmentDigest) {
            return undefined;
        }
        const known = new Set(entry.interactions.map(interaction => interaction.id));
        const additions = slice.interactions.filter(interaction => {
            if (known.has(interaction.id)) {
                return false;
            }
            known.add(interaction.id);
            return true;
        });
        const additionBytes = serializedInteractionBytes(additions);
        if (entry.interactions.length + additions.length
            > CONVERSATION_LIMITS.maxHistoryIndexInteractions
            || entry.serializedBytes + additionBytes
                > CONVERSATION_LIMITS.maxHistoryIndexBytes) {
            // Do not publish a prefix as though it were a contiguous history
            // source. The foreground tail remains authoritative until a
            // future, segment-backed protocol can page beyond this bound.
            entry.saturated = true;
            this.releaseUnusablePayload(entry);
            return snapshot(entry);
        }
        entry.interactions.push(...cloneInteractions(additions));
        entry.serializedBytes += additionBytes;
        entry.nextOffset = slice.complete
            ? source.sourceSize
            : slice.nextOffset as number;
        if (slice.complete) {
            entry.prefixSegments.push({
                startOffset,
                endOffset: source.sourceSize,
                digest: slice.completeSegmentDigest as string,
            });
        } else {
            entry.restartOffset = entry.nextOffset;
            entry.restartInteractionCount = entry.interactions.length;
            entry.restartInteractionId = slice.restartInteractionId;
            entry.restartRecordEndOffset = slice.restartRecordEndOffset;
            entry.restartRecordDigest = slice.restartRecordDigest;
            entry.prefixSegments.push({
                startOffset,
                endOffset: entry.restartOffset,
                digest: slice.restartSegmentDigest,
            });
        }
        entry.complete = slice.complete;
        return snapshot(entry);
    }

    private releaseUnusablePayload(entry: ConversationHistoryIndexEntry): void {
        entry.interactions = [];
        entry.serializedBytes = 0;
        entry.prefixSegments = [];
        entry.nextOffset = 0;
        entry.restartOffset = 0;
        entry.restartInteractionCount = 0;
        entry.restartInteractionId = undefined;
        entry.restartRecordEndOffset = undefined;
        entry.restartRecordDigest = undefined;
    }

    private evictEntries(): void {
        while (this.entries.size > 8) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) {
                return;
            }
            const entry = this.entries.get(oldest);
            if (entry) {
                entry.taskToken += 1;
            }
            this.entries.delete(oldest);
        }
    }
}
