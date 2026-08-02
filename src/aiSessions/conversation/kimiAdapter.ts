'use strict';

import { createHash } from 'crypto';
import type {
    AiSessionConversationSourceCandidate,
    AiSessionDisposable,
} from '../types';
import {
    ConversationIndexCache,
    ConversationJsonlRecord,
    getConversationReadStart,
    readConversationJsonl,
} from './jsonlReader';
import {
    buildConversationOutline,
    buildConversationPage,
} from './model';
import {
    buildUserPreview,
    buildVisibleUserInput,
    countGraphemes,
    normalizeVisibleText,
    truncateGraphemes,
    VisibleUserInputPart,
} from './text';
import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationError,
    ConversationInteraction,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationProviderAdapter,
    ConversationResponseState,
    ConversationTelemetry,
} from './types';
import {
    openValidatedConversationSource,
    OpenConversationSource,
} from './source';
import type {
    ConversationWorktreeInfo,
    ResolveWorktree,
} from './worktreeResolver';

const MAX_TELEMETRY_PATHS = 16;
const ABSOLUTE_PATH_PATTERN = /(?<![\w.~=-])\/(?:[\w.@+~-]+\/)*[\w.@+~-]+/g;

function extractAbsolutePaths(value: string): string[] {
    const paths = new Set<string>();
    const pattern = new RegExp(ABSOLUTE_PATH_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
        const candidate = match[0];
        if (candidate.length > 1 && candidate.length <= 1024
            && !candidate.startsWith('/dev/')) {
            paths.add(candidate);
        }
    }
    return Array.from(paths);
}

type TimerHandle = unknown;

export interface KimiConversationAdapterOptions {
    resolveSource(
        sessionId: string
    ): AiSessionConversationSourceCandidate | null;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    resolveWorktree?: ResolveWorktree;
}

type ConversationContextUsage = NonNullable<ConversationTelemetry['context']>;

interface KimiConversationIndex extends AiSessionDisposable {
    source: OpenConversationSource;
    nextOffset: number;
    interactions: ConversationInteraction[];
    openInteractionIndex?: number;
    telemetryContext?: ConversationContextUsage;
    telemetryPaths: string[];
    revision: number;
    partial: boolean;
}

interface LoadedConversation {
    interactions: ConversationInteraction[];
    sourceRevision: string;
    partial: boolean;
    telemetryContext?: ConversationContextUsage;
    telemetryPaths: string[];
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function timestampValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 10_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function cloneInteractions(
    interactions: readonly ConversationInteraction[]
): ConversationInteraction[] {
    return interactions.map(interaction => ({
        ...interaction,
        assistantMarkdown: interaction.assistantMarkdown.slice(),
    }));
}

function visibleMessage(value: string): string {
    const normalized = normalizeVisibleText(value);
    return countGraphemes(normalized) <= CONVERSATION_LIMITS.maxMessageGraphemes
        ? normalized
        : truncateGraphemes(
            normalized,
            CONVERSATION_LIMITS.maxMessageGraphemes - 1
        );
}

function interactionId(
    sessionId: string,
    offset: number,
    timestamp: unknown
): string {
    return `kimi-${createHash('sha256')
        .update(`${sessionId}\u0000${offset}\u0000${String(timestamp ?? '')}`)
        .digest('hex')
        .slice(0, 32)}`;
}

export class KimiConversationAdapter implements ConversationProviderAdapter {
    private readonly cache: ConversationIndexCache<KimiConversationIndex>;
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private readonly revisionCounters = new Map<string, number>();
    private providerWatch?: AiSessionDisposable;
    private invalidationTimer?: TimerHandle;
    private disposed = false;

    constructor(private readonly options: KimiConversationAdapterOptions) {
        this.cache = new ConversationIndexCache(options.now);
    }

    async readOutline(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline> {
        const loaded = await this.load(sessionId, signal);
        return buildConversationOutline(
            'kimi',
            sessionId,
            loaded.sourceRevision,
            loaded.interactions,
            loaded.partial
        );
    }

    async readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage> {
        const loaded = await this.load(request.sessionId, signal);
        return buildConversationPage(
            loaded.interactions,
            { ...request, provider: 'kimi' },
            loaded.sourceRevision
        );
    }

    async readTelemetry(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined> {
        const loaded = await this.load(sessionId, signal);
        const worktree = await this.readWorktree(loaded);
        if (!loaded.telemetryContext && !worktree) {
            return undefined;
        }
        return {
            provider: 'kimi',
            sessionId,
            ...(worktree ? { worktree } : {}),
            context: loaded.telemetryContext
                ? { ...loaded.telemetryContext }
                : undefined,
            rateLimits: [],
        };
    }

    private async readWorktree(
        loaded: LoadedConversation
    ): Promise<ConversationWorktreeInfo | undefined> {
        if (!this.options.resolveWorktree) {
            return undefined;
        }
        for (let index = loaded.telemetryPaths.length - 1;
            index >= 0;
            index--) {
            const resolved = await this.options.resolveWorktree(
                loaded.telemetryPaths[index]
            );
            if (resolved) {
                return resolved;
            }
        }
        return undefined;
    }

    watch(sessionId: string, onChange: () => void): AiSessionDisposable {
        if (this.disposed) {
            return { dispose() {} };
        }
        let callbacks = this.subscriptions.get(sessionId);
        if (!callbacks) {
            callbacks = new Set();
            this.subscriptions.set(sessionId, callbacks);
        }
        const listener = (): void => onChange();
        callbacks.add(listener);
        const retained = this.cache.retain(sessionId);
        try {
            this.ensureProviderWatch();
        } catch (error) {
            callbacks.delete(listener);
            if (!callbacks.size) {
                this.subscriptions.delete(sessionId);
            }
            retained.dispose();
            throw error;
        }
        let active = true;
        return {
            dispose: () => {
                if (!active) {
                    return;
                }
                active = false;
                callbacks.delete(listener);
                if (!callbacks.size) {
                    this.subscriptions.delete(sessionId);
                }
                retained.dispose();
                this.releaseProviderWatchIfIdle();
            },
        };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.invalidationTimer !== undefined) {
            this.options.clearTimeout(this.invalidationTimer);
            this.invalidationTimer = undefined;
        }
        this.providerWatch?.dispose();
        this.providerWatch = undefined;
        this.subscriptions.clear();
        this.cache.clear();
        this.revisionCounters.clear();
    }

    private async load(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<LoadedConversation> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const candidate = this.options.resolveSource(sessionId);
        if (!candidate) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const source = await openValidatedConversationSource(candidate);
        if (!source) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const previous = this.cache.get(sessionId);
        let interactions: ConversationInteraction[] = [];
        let openInteractionIndex: number | undefined;
        let telemetryContext: ConversationContextUsage | undefined;
        let telemetryPaths: string[] = [];
        try {
            const startOffset = await getConversationReadStart(
                source,
                previous && {
                    source: previous.source,
                    nextOffset: previous.nextOffset,
                }
            );
            const continuing = Boolean(previous)
                && startOffset === previous.nextOffset;
            if (continuing) {
                interactions = cloneInteractions(previous.interactions);
                openInteractionIndex = previous.openInteractionIndex;
                telemetryContext = previous.telemetryContext;
                telemetryPaths = previous.telemetryPaths.slice();
            }
            const normalizeRecord = (record: ConversationJsonlRecord): void => {
                const envelope = asRecord(record.value);
                const event = asRecord(envelope?.message);
                if (!event) {
                    return;
                }
                if (event.type === 'TurnBegin') {
                    const payload = asRecord(event.payload);
                    const userInput = payload?.user_input;
                    const visibleInput = typeof userInput === 'string'
                        ? userInput
                        : Array.isArray(userInput)
                            ? buildVisibleUserInput(userInput.reduce(
                                (parts: VisibleUserInputPart[], rawPart: unknown) => {
                                    const part = asRecord(rawPart);
                                    if (part?.type === 'text'
                                        && typeof part.text === 'string') {
                                        parts.push({ kind: 'text', text: part.text });
                                    } else if (part && (
                                        part.type === 'image'
                                        || part.type === 'file'
                                        || part.type === 'attachment'
                                    )) {
                                        parts.push({ kind: 'attachment' });
                                    }
                                    return parts;
                                },
                                []
                            ))
                            : '';
                    const normalizedInput = visibleMessage(visibleInput);
                    if (normalizedInput) {
                        if (openInteractionIndex !== undefined) {
                            interactions[openInteractionIndex].responseState =
                                'interrupted';
                            openInteractionIndex = undefined;
                        }
                        const id = interactionId(
                            sessionId,
                            record.offset,
                            envelope?.timestamp
                        );
                        if (interactions.some(interaction => interaction.id === id)) {
                            return;
                        }
                        interactions.push({
                            id,
                            timestamp: timestampValue(envelope?.timestamp),
                            userMarkdown: normalizedInput,
                            userPreview: buildUserPreview(normalizedInput),
                            userGraphemeCount: countGraphemes(normalizedInput),
                            assistantMarkdown: [],
                            responseState: 'inProgress',
                        });
                        openInteractionIndex = interactions.length - 1;
                    }
                } else if (event.type === 'ContentPart') {
                    const payload = asRecord(event.payload);
                    if (openInteractionIndex !== undefined
                        && payload?.type === 'text'
                        && typeof payload.text === 'string') {
                        const text = visibleMessage(payload.text);
                        if (text) {
                            interactions[openInteractionIndex]
                                .assistantMarkdown.push(text);
                        }
                    }
                } else if (event.type === 'StatusUpdate') {
                    const payload = asRecord(event.payload);
                    const usedTokens = Number(payload?.context_tokens);
                    const maxTokens = Number(payload?.max_context_tokens);
                    if (Number.isFinite(usedTokens) && usedTokens >= 0
                        && Number.isFinite(maxTokens) && maxTokens > 0) {
                        telemetryContext = {
                            usedTokens: Math.floor(usedTokens),
                            maxTokens: Math.floor(maxTokens),
                        };
                    }
                } else if (event.type === 'ToolCall') {
                    const payload = asRecord(event.payload);
                    const toolFunction = asRecord(payload?.function);
                    const toolName = typeof toolFunction?.name === 'string'
                        ? toolFunction.name.toLowerCase()
                        : '';
                    if ((toolName === 'shell' || toolName === 'bash')
                        && typeof toolFunction?.arguments === 'string') {
                        try {
                            const args = asRecord(
                                JSON.parse(toolFunction.arguments)
                            );
                            if (typeof args?.command === 'string') {
                                telemetryPaths.push(
                                    ...extractAbsolutePaths(args.command)
                                );
                                if (telemetryPaths.length
                                    > MAX_TELEMETRY_PATHS) {
                                    telemetryPaths = telemetryPaths.slice(
                                        -MAX_TELEMETRY_PATHS
                                    );
                                }
                            }
                        } catch (_error) {
                            // Malformed tool arguments carry no path signal.
                        }
                    }
                } else if (event.type === 'TurnEnd') {
                    finishInteraction('complete');
                } else if (event.type === 'Interrupt'
                    || event.type === 'TurnInterrupt'
                    || event.type === 'TurnInterrupted') {
                    finishInteraction('interrupted');
                }
            };
            const finishInteraction = (
                state: ConversationResponseState
            ): void => {
                if (openInteractionIndex === undefined) {
                    return;
                }
                interactions[openInteractionIndex].responseState = state;
                openInteractionIndex = undefined;
            };

            let result;
            try {
                result = await readConversationJsonl(source, {
                    startOffset,
                    signal,
                    now: this.options.now,
                    onRecord: normalizeRecord,
                });
            } catch (error) {
                if (!(error instanceof ConversationError)
                    || error.code !== 'timeout') {
                    throw error;
                }
                const closed = interactions.filter(
                    (_interaction, index) => index !== openInteractionIndex
                );
                if (!closed.length) {
                    throw error;
                }
                const revision = (this.revisionCounters.get(sessionId)
                    || previous?.revision || 0) + 1;
                this.revisionCounters.set(sessionId, revision);
                return {
                    interactions: closed,
                    sourceRevision: `r${revision}`,
                    partial: true,
                    telemetryContext,
                    telemetryPaths,
                };
            }
            const partial = continuing ? previous.partial : result.partial;
            const changed = !previous
                || previous.source.identity !== source.identity
                || previous.source.portableFirstHash
                    !== source.portableFirstHash
                || previous.source.portableLastHash
                    !== source.portableLastHash
                || previous.nextOffset !== result.nextOffset
                || previous.partial !== partial;
            const revision = changed
                ? (this.revisionCounters.get(sessionId) || previous?.revision || 0) + 1
                : previous.revision;
            this.revisionCounters.set(sessionId, revision);
            if (previous) {
                previous.source = source;
                previous.nextOffset = result.nextOffset;
                previous.interactions = interactions;
                previous.openInteractionIndex = openInteractionIndex;
                previous.telemetryContext = telemetryContext;
                previous.telemetryPaths = telemetryPaths;
                previous.revision = revision;
                previous.partial = partial;
            } else {
                this.cache.set(sessionId, {
                    source,
                    nextOffset: result.nextOffset,
                    interactions,
                    openInteractionIndex,
                    telemetryContext,
                    telemetryPaths,
                    revision,
                    partial,
                    dispose() {},
                });
                const retainCount =
                    this.subscriptions.get(sessionId)?.size || 0;
                for (let index = 0; index < retainCount; index++) {
                    this.cache.retain(sessionId);
                }
            }
            return {
                interactions,
                sourceRevision: `r${revision}`,
                partial,
                telemetryContext,
                telemetryPaths,
            };
        } finally {
            await source.handle.close().catch(() => undefined);
        }
    }

    private ensureProviderWatch(): void {
        if (this.providerWatch) {
            return;
        }
        this.providerWatch = this.options.watchSessionChanges(
            () => this.scheduleInvalidation()
        );
    }

    private scheduleInvalidation(): void {
        if (this.invalidationTimer !== undefined || this.disposed) {
            return;
        }
        let firedSynchronously = false;
        const handle = this.options.setTimeout(() => {
            firedSynchronously = true;
            this.invalidationTimer = undefined;
            Array.from(this.subscriptions.values()).forEach(callbacks =>
                Array.from(callbacks).forEach(callback => callback())
            );
        }, CONVERSATION_LIMITS.invalidationDebounceMs);
        if (!firedSynchronously) {
            this.invalidationTimer = handle;
        }
    }

    private releaseProviderWatchIfIdle(): void {
        if (this.subscriptions.size) {
            return;
        }
        this.providerWatch?.dispose();
        this.providerWatch = undefined;
        if (this.invalidationTimer !== undefined) {
            this.options.clearTimeout(this.invalidationTimer);
            this.invalidationTimer = undefined;
        }
    }
}
