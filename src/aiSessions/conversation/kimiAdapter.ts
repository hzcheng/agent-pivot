'use strict';

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
    appendConversationAssistantText,
    buildConversationOutline,
    buildConversationPage,
} from './model';
import {
    buildToolCallSummary,
    buildUserPreview,
    buildVisibleUserInput,
    capToolCallDetail,
    countGraphemes,
    hasAtMostGraphemes,
    normalizeVisibleText,
    truncateGraphemes,
    VisibleUserInputPart,
} from './text';
import { ToolCallTracker } from './toolCalls';
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
    ConversationSnapshot,
    ConversationSubagentEntry,
    ConversationTelemetry,
} from './types';
import {
    isSubagentId,
    splitSubagentSessionId,
} from './subagentSessions';
import {
    openValidatedConversationSource,
    OpenConversationSource,
} from './source';
import type {
    ConversationWorktreeInfo,
    ResolveWorktree,
} from './worktreeResolver';

const MAX_TELEMETRY_PATHS = 16;
const SHELL_CD_PATTERN = /(?:^|&&|\|\||;|\n)\s*cd(?:\s+--)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const MAX_LISTED_SUBAGENTS = 64;
const SUBAGENT_DIRECTORY_PATTERN = /^[0-9a-z][0-9a-z-]{0,63}$/i;
const SUBAGENT_RUNNING_FRESHNESS_MS = 5 * 60 * 1000;

function extractShellWorkingDirectories(value: string): string[] {
    const paths = new Set<string>();
    const pattern = new RegExp(SHELL_CD_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
        const candidate = match[1] || match[2] || match[3] || '';
        if (candidate.startsWith('/') && candidate.length <= 1024) {
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
    toolTracker?: ToolCallTracker;
    pendingThinking?: { position: number; text: string } | null;
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
        ...(interaction.assistantPhases
            ? { assistantPhases: interaction.assistantPhases.slice() }
            : {}),
        ...(interaction.toolCalls
            ? { toolCalls: interaction.toolCalls.slice() }
            : {}),
        ...(interaction.thinking
            ? { thinking: interaction.thinking.slice() }
            : {}),
    }));
}

function visibleMessage(value: string): string {
    const normalized = normalizeVisibleText(value);
    return hasAtMostGraphemes(
        normalized,
        CONVERSATION_LIMITS.maxMessageGraphemes
    )
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

    async readSnapshot(
        sessionId: string,
        preferredInteractionId?: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot> {
        const loaded = await this.load(sessionId, signal);
        const outline = buildConversationOutline(
            'kimi',
            sessionId,
            loaded.sourceRevision,
            loaded.interactions,
            loaded.partial
        );
        const selected = outline.interactions.find(interaction =>
            interaction.id === preferredInteractionId
        ) || outline.interactions[outline.interactions.length - 1];
        return {
            outline,
            ...(selected ? {
                page: buildConversationPage(loaded.interactions, {
                    provider: 'kimi',
                    sessionId,
                    anchorInteractionId: selected.id,
                    direction: 'around',
                    expectedRevision: loaded.sourceRevision,
                    limit: CONVERSATION_LIMITS.maxPageInteractions,
                }, loaded.sourceRevision),
            } : {}),
        };
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

    async readSubagents(
        sessionId: string,
        _signal?: ConversationAbortSignal
    ): Promise<ConversationSubagentEntry[]> {
        if (this.disposed) {
            return [];
        }
        const split = splitSubagentSessionId(sessionId);
        if (split.subagentId) {
            return [];
        }
        const candidate = this.options.resolveSource(split.sessionId);
        if (!candidate) {
            return [];
        }
        const subagentsRoot = path.join(
            path.dirname(candidate.sourcePath),
            'subagents'
        );
        let dirents: fs.Dirent[];
        try {
            dirents = await fs.promises.readdir(subagentsRoot, {
                withFileTypes: true,
            });
        } catch (_error) {
            return [];
        }
        const now = Date.now();
        const entries: ConversationSubagentEntry[] = [];
        for (const dirent of dirents) {
            if (entries.length >= MAX_LISTED_SUBAGENTS) {
                break;
            }
            if (!dirent.isDirectory()
                || !SUBAGENT_DIRECTORY_PATTERN.test(dirent.name)) {
                continue;
            }
            const entry = await readSubagentEntry(
                path.join(subagentsRoot, dirent.name),
                dirent.name,
                now
            );
            if (entry) {
                entries.push(entry);
            }
        }
        entries.sort((left, right) =>
            (left.createdAt ?? left.updatedAt ?? 0)
            - (right.createdAt ?? right.updatedAt ?? 0));
        return entries;
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
        const split = splitSubagentSessionId(sessionId);
        if (split.subagentId && !isSubagentId(split.subagentId)) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const candidate = this.options.resolveSource(split.sessionId);
        if (!candidate) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const effectiveCandidate = split.subagentId
            ? {
                providerHome: candidate.providerHome,
                sourcePath: path.join(
                    path.dirname(candidate.sourcePath),
                    'subagents',
                    split.subagentId,
                    'wire.jsonl'
                ),
                cwd: candidate.cwd,
            }
            : candidate;
        const source = await openValidatedConversationSource(
            effectiveCandidate
        );
        if (!source) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const previous = this.cache.get(sessionId);
        let interactions: ConversationInteraction[] = [];
        let openInteractionIndex: number | undefined;
        let telemetryContext: ConversationContextUsage | undefined;
        let telemetryPaths: string[] = effectiveCandidate.cwd
            ? [effectiveCandidate.cwd]
            : [];
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
            // Kept on the cache entry so a ToolResult arriving in a later
            // incremental load still pairs with its ToolCall.
            const toolTracker = (continuing && previous?.toolTracker)
                || new ToolCallTracker();
            // Consecutive think deltas merge into one block per run.
            let pendingThinking: { position: number; text: string } | null =
                (continuing && previous?.pendingThinking) || null;
            const flushThinking = (): void => {
                if (!pendingThinking || openInteractionIndex === undefined) {
                    pendingThinking = null;
                    return;
                }
                const text = visibleMessage(pendingThinking.text);
                if (text) {
                    const interaction = interactions[openInteractionIndex];
                    (interaction.thinking ||= []).push({
                        position: pendingThinking.position,
                        text,
                    });
                }
                pendingThinking = null;
            };
            const normalizeRecord = (record: ConversationJsonlRecord): void => {
                const envelope = asRecord(record.value);
                const event = asRecord(envelope?.message);
                if (!event) {
                    return;
                }
                if (event.type === 'TurnBegin') {
                    flushThinking();
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
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    const thinkText = payload?.type === 'think'
                        ? typeof payload.think === 'string'
                            ? payload.think
                            : typeof payload.text === 'string'
                                ? payload.text
                                : undefined
                        : undefined;
                    if (openInteractionIndex !== undefined
                        && thinkText !== undefined) {
                        if (!pendingThinking) {
                            pendingThinking = {
                                position: interactions[openInteractionIndex]
                                    .assistantMarkdown.length,
                                text: '',
                            };
                        }
                        pendingThinking.text += thinkText;
                        return;
                    }
                    flushThinking();
                    if (openInteractionIndex !== undefined
                        && payload?.type === 'text'
                        && typeof payload.text === 'string') {
                        const text = visibleMessage(payload.text);
                        if (text) {
                            appendConversationAssistantText(
                                interactions[openInteractionIndex],
                                text
                            );
                        }
                    }
                } else if (event.type === 'PlanDisplay') {
                    flushThinking();
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    if (openInteractionIndex !== undefined
                        && typeof payload?.content === 'string') {
                        const content = visibleMessage(payload.content);
                        if (content) {
                            appendConversationAssistantText(
                                interactions[openInteractionIndex],
                                content,
                                'progress'
                            );
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
                    flushThinking();
                    stampActivity(envelope);
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
                                    ...extractShellWorkingDirectories(
                                        args.command
                                    )
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
                    if (openInteractionIndex !== undefined
                        && typeof toolFunction?.name === 'string'
                        && toolFunction.name) {
                        let args: Record<string, any> | undefined;
                        try {
                            args = typeof toolFunction.arguments === 'string'
                                ? asRecord(JSON.parse(toolFunction.arguments))
                                : undefined;
                        } catch (_error) {
                            args = undefined;
                        }
                        toolTracker.begin(
                            interactions[openInteractionIndex],
                            typeof payload?.id === 'string'
                                ? payload.id
                                : undefined,
                            toolFunction.name,
                            buildToolCallSummary(toolFunction.name, args),
                            capToolCallDetail(
                                typeof toolFunction.arguments === 'string'
                                    ? toolFunction.arguments
                                    : ''
                            )
                        );
                    }
                } else if (event.type === 'ToolResult') {
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    const returnValue = asRecord(payload?.return_value);
                    toolTracker.finish(
                        payload?.tool_call_id,
                        typeof returnValue?.output === 'string'
                            ? returnValue.output
                            : undefined
                    );
                } else if (event.type === 'TurnEnd') {
                    stampActivity(envelope);
                    finishInteraction('complete');
                } else if (event.type === 'Interrupt'
                    || event.type === 'TurnInterrupt'
                    || event.type === 'TurnInterrupted') {
                    stampActivity(envelope);
                    finishInteraction('interrupted');
                }
            };
            const finishInteraction = (
                state: ConversationResponseState
            ): void => {
                flushThinking();
                if (openInteractionIndex === undefined) {
                    return;
                }
                interactions[openInteractionIndex].responseState = state;
                openInteractionIndex = undefined;
            };
            const stampActivity = (
                envelope: Record<string, unknown> | undefined
            ): void => {
                if (!envelope || openInteractionIndex === undefined) {
                    return;
                }
                const value = timestampValue(envelope.timestamp);
                if (value !== undefined) {
                    interactions[openInteractionIndex].completedAt = value;
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
                previous.toolTracker = toolTracker;
                previous.pendingThinking = pendingThinking;
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
                    toolTracker,
                    pendingThinking,
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

interface SubagentMeta {
    description?: string;
    subagent_type?: string;
    status?: string;
    created_at?: number;
}

async function readSubagentEntry(
    directory: string,
    id: string,
    now: number
): Promise<ConversationSubagentEntry | undefined> {
    let wireStat: fs.Stats;
    try {
        wireStat = await fs.promises.stat(path.join(directory, 'wire.jsonl'));
    } catch (_error) {
        return undefined;
    }
    const meta = await readSubagentMeta(path.join(directory, 'meta.json'));
    return {
        id,
        label: subagentLabel(meta, id),
        ...(meta?.subagent_type ? { agentType: meta.subagent_type } : {}),
        status: subagentStatus(meta?.status, wireStat.mtimeMs, now),
        ...(Number.isFinite(meta?.created_at)
            ? { createdAt: Math.floor((meta?.created_at as number) * 1000) }
            : {}),
        updatedAt: Math.floor(wireStat.mtimeMs),
    };
}

async function readSubagentMeta(
    metaPath: string
): Promise<SubagentMeta | undefined> {
    try {
        const parsed: unknown = JSON.parse(
            await fs.promises.readFile(metaPath, 'utf8')
        );
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        return parsed as SubagentMeta;
    } catch (_error) {
        return undefined;
    }
}

function subagentLabel(meta: SubagentMeta | undefined, id: string): string {
    const description = typeof meta?.description === 'string'
        ? normalizeVisibleText(meta?.description ?? '')
        : '';
    if (description) {
        return hasAtMostGraphemes(description, 120)
            ? description
            : truncateGraphemes(description, 119);
    }
    const agentType = typeof meta?.subagent_type === 'string'
        ? meta.subagent_type
        : '';
    return agentType ? `${agentType} · ${id}` : id;
}

function subagentStatus(
    rawStatus: string | undefined,
    wireMtimeMs: number,
    now: number
): ConversationSubagentEntry['status'] {
    if (rawStatus === 'failed' || rawStatus === 'killed') {
        return rawStatus;
    }
    if (rawStatus === 'running_foreground'
        || rawStatus === 'running_background') {
        // A crashed CLI never resets meta.json, and a long quiet command
        // looks identical to a crash: only a freshly written wire proves
        // the subagent is alive; staleness alone is not death evidence.
        return now - wireMtimeMs <= SUBAGENT_RUNNING_FRESHNESS_MS
            ? 'running'
            : 'quiet';
    }
    return 'idle';
}
