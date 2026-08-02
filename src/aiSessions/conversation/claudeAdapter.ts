'use strict';

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

type TimerHandle = unknown;

export interface ClaudeConversationAdapterOptions {
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

// Claude Code JSONL does not record the context-window size; all current
// Claude models default to a 200k window.
const CLAUDE_DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

interface ClaudeConversationIndex extends AiSessionDisposable {
    source: OpenConversationSource;
    nextOffset: number;
    interactions: ConversationInteraction[];
    appendInteractionIndex?: number;
    telemetryModel?: string;
    telemetryContext?: ConversationContextUsage;
    telemetryCwd?: string;
    telemetryGitBranch?: string;
    revision: number;
    partial: boolean;
}

interface LoadedConversation {
    interactions: ConversationInteraction[];
    sourceRevision: string;
    partial: boolean;
    telemetryModel?: string;
    telemetryContext?: ConversationContextUsage;
    telemetryCwd?: string;
    telemetryGitBranch?: string;
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function contentBlocks(value: unknown): Array<Record<string, any>> {
    return Array.isArray(value)
        ? value.map(asRecord).filter(Boolean)
        : [];
}

function containsBlock(value: unknown, type: string): boolean {
    return contentBlocks(value).some(block => block.type === type);
}

function isVisibleUserEvent(event: Record<string, any>): boolean {
    const origin = asRecord(event.origin);
    return event.isMeta !== true
        && typeof event.sourceToolUseID !== 'string'
        && event.promptSource !== 'system'
        && (!origin || origin.kind === undefined || origin.kind === 'human');
}

function visibleInputParts(value: unknown): VisibleUserInputPart[] {
    if (typeof value === 'string') {
        return [{ kind: 'text', text: value }];
    }
    return contentBlocks(value).reduce<VisibleUserInputPart[]>(
        (parts, block) => {
            if (block.type === 'text' && typeof block.text === 'string') {
                parts.push({ kind: 'text', text: block.text });
            } else if (block.type === 'image'
                || block.type === 'document'
                || block.type === 'attachment') {
                parts.push({ kind: 'attachment' });
            }
            return parts;
        },
        []
    );
}

function visibleAssistantParts(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    return contentBlocks(value)
        .filter(block =>
            block.type === 'text' && typeof block.text === 'string'
        )
        .map(block => block.text);
}

function contextUsageTokens(value: unknown): number | undefined {
    const usage = asRecord(value);
    if (!usage) {
        return undefined;
    }
    const total = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.output_tokens,
    ].reduce<number>(
        (sum, part) => sum + (Number.isFinite(part) && part > 0
            ? Math.floor(part as number)
            : 0),
        0
    );
    return total > 0 ? total : undefined;
}

function isUserInterrupt(value: unknown): boolean {
    const textParts = Array.isArray(value)
        ? value.map(part => {
            if (typeof part === 'string') {
                return part;
            }
            const block = asRecord(part);
            return typeof block?.text === 'string' ? block.text : '';
        })
        : [typeof value === 'string' ? value : ''];
    // Claude Code emits sentinel variants such as '[Request interrupted by
    // user for tool use]' when a tool call is interrupted, so match the prefix.
    return textParts.some(
        text => text.trim().startsWith('[Request interrupted by user')
    );
}

function timestampValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
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

export class ClaudeConversationAdapter implements ConversationProviderAdapter {
    private readonly cache: ConversationIndexCache<ClaudeConversationIndex>;
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private readonly revisionCounters = new Map<string, number>();
    private providerWatch?: AiSessionDisposable;
    private invalidationTimer?: TimerHandle;
    private disposed = false;

    constructor(private readonly options: ClaudeConversationAdapterOptions) {
        this.cache = new ConversationIndexCache(options.now);
    }

    async readOutline(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline> {
        const loaded = await this.load(sessionId, signal);
        return buildConversationOutline(
            'claude',
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
            { ...request, provider: 'claude' },
            loaded.sourceRevision
        );
    }

    async readTelemetry(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined> {
        const loaded = await this.load(sessionId, signal);
        const worktree = await this.readWorktree(loaded);
        if (!loaded.telemetryModel && !loaded.telemetryContext && !worktree) {
            return undefined;
        }
        return {
            provider: 'claude',
            sessionId,
            model: loaded.telemetryModel,
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
        const cwd = loaded.telemetryCwd;
        if (!cwd) {
            return undefined;
        }
        if (this.options.resolveWorktree) {
            const resolved = await this.options.resolveWorktree(cwd);
            if (resolved) {
                return resolved;
            }
        }
        // The path is gone (worktree deleted) but Claude logs the branch.
        if (loaded.telemetryGitBranch) {
            return {
                branch: loaded.telemetryGitBranch,
                worktreeRoot: cwd,
                repoRoot: cwd,
                missing: true,
            };
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
        let timeoutOpenInteractionIndex: number | undefined;
        let telemetryModel: string | undefined;
        let telemetryContext: ConversationContextUsage | undefined;
        let telemetryCwd: string | undefined;
        let telemetryGitBranch: string | undefined;
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
                openInteractionIndex = previous.appendInteractionIndex;
                telemetryModel = previous.telemetryModel;
                telemetryContext = previous.telemetryContext;
                telemetryCwd = previous.telemetryCwd;
                telemetryGitBranch = previous.telemetryGitBranch;
            }
            const finishInteraction = (
                state: 'complete' | 'interrupted' = 'complete'
            ): void => {
                if (openInteractionIndex === undefined) {
                    return;
                }
                interactions[openInteractionIndex].responseState = state;
                openInteractionIndex = undefined;
            };
            const normalizeRecord = (record: ConversationJsonlRecord): void => {
                const event = asRecord(record.value);
                if (!event || event.isSidechain) {
                    return;
                }
                const message = asRecord(event.message);
                if (typeof event.cwd === 'string' && event.cwd) {
                    telemetryCwd = event.cwd;
                }
                if (typeof event.gitBranch === 'string' && event.gitBranch) {
                    telemetryGitBranch = event.gitBranch;
                }
                if (event.type === 'assistant'
                    && message?.role === 'assistant') {
                    if (typeof message.model === 'string'
                        && message.model.trim()) {
                        telemetryModel = message.model.trim().slice(0, 128);
                    }
                    const usedTokens = contextUsageTokens(message.usage);
                    if (usedTokens) {
                        telemetryContext = {
                            usedTokens,
                            maxTokens: CLAUDE_DEFAULT_MAX_CONTEXT_TOKENS,
                        };
                    }
                }
                if (event.type === 'user'
                    && message?.role === 'user'
                    && isUserInterrupt(message.content)) {
                    finishInteraction('interrupted');
                    timeoutOpenInteractionIndex = undefined;
                } else if (event.type === 'user'
                    && message?.role === 'user'
                    && isVisibleUserEvent(event)
                    && !event.sourceToolAssistantUUID
                    && !event.toolUseResult
                    && !containsBlock(message.content, 'tool_result')) {
                    if (typeof event.uuid !== 'string' || !event.uuid) {
                        return;
                    }
                    const visibleInput = visibleMessage(buildVisibleUserInput(
                        visibleInputParts(message.content)
                    ));
                    if (!visibleInput) {
                        return;
                    }
                    finishInteraction();
                    timeoutOpenInteractionIndex = undefined;
                    if (interactions.some(
                        interaction => interaction.id === event.uuid
                    )) {
                        return;
                    }
                    interactions.push({
                        id: event.uuid,
                        timestamp: timestampValue(event.timestamp),
                        userMarkdown: visibleInput,
                        userPreview: buildUserPreview(visibleInput),
                        userGraphemeCount: countGraphemes(visibleInput),
                        assistantMarkdown: [],
                        responseState: 'inProgress',
                    });
                    openInteractionIndex = interactions.length - 1;
                    timeoutOpenInteractionIndex = openInteractionIndex;
                } else if (event.type === 'assistant'
                    && message?.role === 'assistant'
                    && openInteractionIndex !== undefined) {
                    visibleAssistantParts(message.content).forEach(part => {
                        const text = visibleMessage(part);
                        if (text) {
                            interactions[openInteractionIndex]
                                .assistantMarkdown.push(text);
                        }
                    });
                }
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
                    (_interaction, index) =>
                        index !== timeoutOpenInteractionIndex
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
                    telemetryModel,
                    telemetryContext,
                    telemetryCwd,
                    telemetryGitBranch,
                };
            }
            const appendInteractionIndex = openInteractionIndex;
            finishInteraction();
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
                previous.appendInteractionIndex = appendInteractionIndex;
                previous.telemetryModel = telemetryModel;
                previous.telemetryContext = telemetryContext;
                previous.telemetryCwd = telemetryCwd;
                previous.telemetryGitBranch = telemetryGitBranch;
                previous.revision = revision;
                previous.partial = partial;
            } else {
                this.cache.set(sessionId, {
                    source,
                    nextOffset: result.nextOffset,
                    interactions,
                    appendInteractionIndex,
                    telemetryModel,
                    telemetryContext,
                    telemetryCwd,
                    telemetryGitBranch,
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
                telemetryModel,
                telemetryContext,
                telemetryCwd,
                telemetryGitBranch,
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
