'use strict';

import { createHash } from 'crypto';
import type {
    AiSessionCodexSubagentThread,
    AiSessionDisposable,
} from '../types';
import type { AiSessionLifecycleSignal } from '../lifecycle';
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
import { parseUnifiedDiff } from './diffs';
import {
    CONVERSATION_LIMITS,
    ConversationAbortError,
    ConversationAbortSignal,
    ConversationError,
    ConversationFileDiff,
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
import type {
    ConversationWorktreeInfo,
    ResolveWorktree,
} from './worktreeResolver';

type TimerHandle = unknown;

export interface CodexConversationClient extends AiSessionDisposable {
    request<T = unknown>(
        method: string,
        params: unknown,
        signal?: ConversationAbortSignal
    ): Promise<T>;
    watchNotifications?(
        listener: (method: string, params: unknown) => void
    ): AiSessionDisposable;
    // Sanitized `major.minor` server version captured at initialize time,
    // when the client exposes it. Gates version-sensitive protocol
    // accelerators such as thread/turns/list.
    getServerVersion?(): string | undefined;
}

interface CodexRolloutTelemetrySnapshot {
    model?: string;
    context?: {
        usedTokens: number;
        maxTokens: number;
    };
    currentWorkdir?: string;
}

export interface CodexConversationAdapterOptions {
    client: CodexConversationClient;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    resolveWorktree?: ResolveWorktree;
    readRolloutTelemetry?(
        sessionId: string
    ): CodexRolloutTelemetrySnapshot | undefined;
    // Rollout stat signature used solely as the validity signal for the
    // normalized-conversation cache: identical stat means the app-server
    // content cannot have changed, so the cached conversation is reused
    // without another full thread/read. An undefined/unreadable signature
    // bypasses the cache entirely.
    readContentSignature?(sessionId: string): string | undefined;
    readLifecycleSignal?(
        sessionId: string
    ): AiSessionLifecycleSignal | undefined;
    listSubagentThreads?(
        sessionId: string
    ): AiSessionCodexSubagentThread[] | Promise<AiSessionCodexSubagentThread[]>;
    now?(): number;
}

const MAX_LISTED_SUBAGENTS = 64;
const SUBAGENT_RUNNING_FRESHNESS_MS = 5 * 60 * 1000;
const LARGE_CONVERSATION_CACHE_CHARS = 512 * 1024;
// A read this expensive is worth caching even when its visible text stays
// below the character gate (tool-record-heavy threads normalize little
// visible text but still pay the full transfer and normalize cost).
const LARGE_CONVERSATION_CACHE_MIN_READ_MS = 100;
const LARGE_CONVERSATION_CACHE_ENTRIES = 2;
// Total cached visible-text characters across entries: the hard memory
// bound for the cache (roughly 16MiB of string payload).
const LARGE_CONVERSATION_CACHE_BUDGET_CHARS = 8 * 1024 * 1024;
// Entries unused for this long are released on the next read.
const LARGE_CONVERSATION_CACHE_IDLE_MS = 10 * 60 * 1000;
// Server versions whose thread/turns/list behavior was verified against a
// real app-server (spikes/codex-paginated-read). The method is gated behind
// the experimentalApi capability and may drift at any release, so paginated
// reloads only run on verified versions and fall back to a full thread/read
// on any anomaly.
const PAGINATED_READ_SERVER_VERSIONS = new Set(['0.147']);
const PAGINATED_READ_PAGE_SIZE = 4;
// How many turns an incremental reload walks back looking for the cached
// anchor turn before treating the tail as rewritten (compaction/rollback)
// and falling back to a full read.
const PAGINATED_READ_WALK_LIMIT = 64;

interface LoadedConversation {
    interactions: ConversationInteraction[];
    sourceRevision: string;
}

// Per-turn normalized chunks of a cached root-thread conversation. Chunk
// interactions share objects with `value.interactions` (no string payload
// is duplicated); they let an incremental reload re-normalize only the
// turns that actually changed.
interface LoadedConversationTurn {
    turnId: string;
    itemIds: string[];
    interactions: ConversationInteraction[];
    fingerprint: string;
    characters: number;
}

interface CachedLoadedConversation {
    value: LoadedConversation;
    contentSignature: string;
    characters: number;
    lastTouchedAt: number;
    turns?: LoadedConversationTurn[];
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function protocolError(): ConversationError {
    return new ConversationError(
        'unsupportedVersion',
        'unsupportedCodexProtocol'
    );
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

function normalizeReasoningSummary(value: unknown): string | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const summary = value
        .filter((part): part is string => typeof part === 'string')
        .join('\n\n');
    const visible = visibleMessage(summary);
    return visible || undefined;
}

function turnResponseState(value: string): ConversationResponseState {
    if (value === 'completed') {
        return 'complete';
    }
    if (value === 'active' || value === 'inProgress') {
        return 'inProgress';
    }
    if (value === 'failed' || value === 'cancelled' || value === 'interrupted') {
        return 'interrupted';
    }
    return 'unknown';
}

function epochSecondsToMs(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    const milliseconds = Math.floor(value * 1000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function turnTiming(
    turn: Record<string, any>
): Pick<ConversationInteraction, 'timestamp' | 'completedAt'> {
    const timestamp = epochSecondsToMs(turn.startedAt);
    if (timestamp === undefined) {
        return {};
    }
    let completedAt: number | undefined;
    if (typeof turn.durationMs === 'number'
        && Number.isFinite(turn.durationMs)
        && turn.durationMs >= 0) {
        const preciseCompletion = timestamp + Math.floor(turn.durationMs);
        if (Number.isSafeInteger(preciseCompletion)) {
            completedAt = preciseCompletion;
        }
    }
    if (completedAt === undefined) {
        const providerCompletion = epochSecondsToMs(turn.completedAt);
        if (providerCompletion !== undefined
            && providerCompletion >= timestamp) {
            completedAt = providerCompletion;
        }
    }
    return {
        timestamp,
        ...(completedAt !== undefined ? { completedAt } : {}),
    };
}

function appendTurnTiming(
    interaction: ConversationInteraction,
    timing: Pick<ConversationInteraction, 'timestamp' | 'completedAt'>
): boolean {
    if (timing.timestamp === undefined || timing.completedAt === undefined) {
        return false;
    }
    const timestamp = interaction.timestamp !== undefined
        && Number.isSafeInteger(interaction.timestamp)
        ? interaction.timestamp
        : timing.timestamp;
    interaction.timestamp = timestamp;
    const turnDuration = timing.completedAt - timing.timestamp;
    const accumulatedDuration = interaction.completedAt !== undefined
        && interaction.completedAt >= timestamp
        ? interaction.completedAt - timestamp
        : 0;
    const completedAt = timestamp + accumulatedDuration + turnDuration;
    if (!Number.isSafeInteger(completedAt)) {
        return false;
    }
    interaction.completedAt = completedAt;
    return true;
}

// Mutable state shared across the per-turn normalization passes of one
// thread. `itemIds` rejects duplicate item ids thread-wide; `newItemIds`
// collects the ids contributed by the current turn so a cached turn chunk
// can be re-normalized without tripping its own ids.
interface NormalizeTurnContext {
    interactions: ConversationInteraction[];
    itemIds: Set<string>;
    newItemIds: string[];
    seededDispatchIndex?: number;
    seededDispatchTimingComplete: boolean;
}

function normalizeTurnItems(
    turn: Record<string, any>,
    context: NormalizeTurnContext
): void {
    const interactions = context.interactions;
    const itemIds = context.itemIds;
    const seededDispatchIndex = context.seededDispatchIndex;
    const responseState = turnResponseState(turn.status);
    if (seededDispatchIndex !== undefined) {
        interactions[seededDispatchIndex].responseState = responseState;
    }
    const timing = turnTiming(turn);
    let timingAssigned = false;
    let currentInteractionIndex: number | undefined = seededDispatchIndex;
    for (const rawItem of turn.items) {
        const item = asRecord(rawItem);
        if (!item
            || typeof item.id !== 'string'
            || !item.id
            || itemIds.has(item.id)
            || typeof item.type !== 'string') {
            throw protocolError();
        }
        itemIds.add(item.id);
        context.newItemIds.push(item.id);
        if (item.type === 'userMessage') {
            currentInteractionIndex = undefined;
            if (!Array.isArray(item.content)) {
                throw protocolError();
            }
            const parts: VisibleUserInputPart[] = [];
            for (const rawPart of item.content) {
                const part = asRecord(rawPart);
                if (!part || typeof part.type !== 'string') {
                    throw protocolError();
                }
                if (part.type === 'text') {
                    if (typeof part.text !== 'string') {
                        throw protocolError();
                    }
                    parts.push({ kind: 'text', text: part.text });
                } else if (
                    part.type === 'image'
                    || part.type === 'audio'
                ) {
                    if (typeof part.url !== 'string') {
                        throw protocolError();
                    }
                    parts.push({ kind: 'attachment' });
                } else if (
                    part.type === 'localImage'
                    || part.type === 'localAudio'
                ) {
                    if (typeof part.path !== 'string') {
                        throw protocolError();
                    }
                    parts.push({ kind: 'attachment' });
                }
            }
            const userMarkdown = visibleMessage(
                buildVisibleUserInput(parts)
            );
            if (!userMarkdown) {
                continue;
            }
            interactions.push({
                id: item.id,
                providerTurnId: turn.id,
                ...(!timingAssigned ? timing : {}),
                userMarkdown,
                userPreview: buildUserPreview(userMarkdown),
                userGraphemeCount: countGraphemes(userMarkdown),
                assistantMarkdown: [],
                responseState,
            });
            currentInteractionIndex = interactions.length - 1;
            timingAssigned = true;
        } else if (item.type === 'reasoning') {
            if (currentInteractionIndex === undefined) {
                continue;
            }
            // App-server exposes readable summaries separately from raw
            // reasoning content. Only the summary is safe viewer output;
            // never fall back to `content` or legacy `text` fields.
            const text = normalizeReasoningSummary(item.summary);
            if (text) {
                const interaction = interactions[currentInteractionIndex];
                (interaction.thinking ||= []).push({
                    position: interaction.assistantMarkdown.length,
                    text,
                });
            }
        } else if (item.type === 'commandExecution'
            || item.type === 'fileChange') {
            if (currentInteractionIndex === undefined) {
                continue;
            }
            const tool = normalizeToolItem(item);
            if (!tool) {
                continue;
            }
            const interaction = interactions[currentInteractionIndex];
            (interaction.toolCalls ||= []).push({
                position: interaction.assistantMarkdown.length,
                ...tool,
            });
        } else if (item.type === 'plan') {
            if (currentInteractionIndex === undefined) {
                continue;
            }
            const planText = typeof item.text === 'string'
                ? visibleMessage(item.text)
                : '';
            if (!planText) {
                continue;
            }
            const interaction = interactions[currentInteractionIndex];
            (interaction.plans ||= []).push({
                position: interaction.assistantMarkdown.length,
                markdown: planText,
            });
        } else if (item.type === 'agentMessage') {
            if (typeof item.text !== 'string') {
                throw protocolError();
            }
            if (currentInteractionIndex === undefined) {
                continue;
            }
            const text = visibleMessage(item.text);
            if (!text) {
                continue;
            }
            const interaction = interactions[currentInteractionIndex];
            if (item.phase === 'commentary') {
                appendConversationAssistantText(
                    interaction,
                    text,
                    'progress'
                );
            } else {
                appendConversationAssistantText(interaction, text);
            }
        }
    }
    if (seededDispatchIndex !== undefined && !timingAssigned) {
        // A Codex subagent transcript can span several provider turns
        // while still representing one synthetic dispatch interaction.
        // Sum active turn durations so the UI reports actual work time,
        // excluding idle gaps between those turns.
        if (context.seededDispatchTimingComplete
            && !appendTurnTiming(
                interactions[seededDispatchIndex],
                timing
            )) {
            context.seededDispatchTimingComplete = false;
            delete interactions[seededDispatchIndex].completedAt;
        }
    }
}

// One provider turn's contribution to a conversation: the interactions it
// created (a subagent turn can instead mutate the seeded dispatch
// interaction, captured separately) plus the item ids it consumed.
interface NormalizedConversationTurn {
    turnId: string;
    interactions: ConversationInteraction[];
    itemIds: string[];
}

function normalizeThreadRead(
    value: unknown,
    sessionId: string,
    dispatch?: { label: string; timestamp?: number }
): {
    interactions: ConversationInteraction[];
    turns: NormalizedConversationTurn[];
} {
    const result = asRecord(value);
    const thread = asRecord(result?.thread);
    if (!thread
        || typeof thread.id !== 'string'
        || thread.id !== sessionId
        || !Array.isArray(thread.turns)) {
        throw protocolError();
    }
    const turnIds = new Set<string>();
    const context: NormalizeTurnContext = {
        interactions: [],
        itemIds: new Set<string>(),
        newItemIds: [],
        seededDispatchTimingComplete: true,
    };
    const turns: NormalizedConversationTurn[] = [];
    // A subagent thread exposes no userMessage for its dispatch prompt
    // (the app-server strips it), so seed one from the thread metadata to
    // give the subagent's agentMessages an interaction to attach to.
    if (dispatch) {
        context.interactions.push({
            id: `${sessionId}-dispatch`,
            ...(dispatch.timestamp !== undefined
                ? { timestamp: dispatch.timestamp }
                : {}),
            userMarkdown: dispatch.label,
            userPreview: buildUserPreview(dispatch.label),
            userGraphemeCount: countGraphemes(dispatch.label),
            assistantMarkdown: [],
            responseState: 'unknown',
        });
        context.seededDispatchIndex = 0;
    }
    for (const rawTurn of thread.turns) {
        const turn = asRecord(rawTurn);
        if (!turn
            || typeof turn.id !== 'string'
            || !turn.id
            || turnIds.has(turn.id)
            || typeof turn.status !== 'string'
            || !Array.isArray(turn.items)) {
            throw protocolError();
        }
        turnIds.add(turn.id);
        context.newItemIds = [];
        const startIndex = context.interactions.length;
        normalizeTurnItems(turn, context);
        turns.push({
            turnId: turn.id,
            interactions: context.interactions.slice(startIndex),
            itemIds: context.newItemIds,
        });
    }
    if (dispatch) {
        // The seed interaction is mutated by later turns, so its chunk is
        // captured after the loop with its final state. Keeping it as chunk
        // zero makes the chunk list partition the flat interaction array.
        turns.unshift({
            turnId: '',
            interactions: [context.interactions[0]],
            itemIds: [],
        });
    }
    return { interactions: context.interactions, turns };
}

function fingerprintInteractions(
    interactions: readonly ConversationInteraction[]
): string {
    return createHash('sha256')
        .update(JSON.stringify(interactions), 'utf8')
        .digest('hex');
}

// The conversation revision is composed from per-turn fingerprints so an
// incremental reload only hashes the turns it re-read. The composition is
// opaque downstream and identical across the full and incremental paths for
// identical content.
function composeConversationRevision(
    turns: readonly LoadedConversationTurn[]
): string {
    return createHash('sha256')
        .update(turns.map(turn => turn.fingerprint).join(':'), 'utf8')
        .digest('hex');
}

function conversationCharacters(
    interactions: readonly ConversationInteraction[]
): number {
    let characters = 0;
    for (const interaction of interactions) {
        characters += interaction.userMarkdown?.length || 0;
        for (const markdown of interaction.assistantMarkdown) {
            characters += markdown.length;
        }
        for (const tool of interaction.toolCalls || []) {
            characters += (tool.summary?.length || 0)
                + (tool.detail?.length || 0);
        }
        for (const thinking of interaction.thinking || []) {
            characters += thinking.text?.length || 0;
        }
    }
    return characters;
}

// Validates one thread/turns/list page. Turn-level checks mirror
// normalizeThreadRead so a turn that passes here is safe to feed into
// normalizeTurnItems.
function parseTurnsListPage(
    value: unknown
): { turns: Record<string, any>[]; nextCursor?: string } {
    const page = asRecord(value);
    if (!page || !Array.isArray(page.data)) {
        throw protocolError();
    }
    if (page.nextCursor !== undefined
        && page.nextCursor !== null
        && typeof page.nextCursor !== 'string') {
        throw protocolError();
    }
    const turns: Record<string, any>[] = [];
    for (const rawTurn of page.data) {
        const turn = asRecord(rawTurn);
        if (!turn
            || typeof turn.id !== 'string'
            || !turn.id
            || typeof turn.status !== 'string'
            || !Array.isArray(turn.items)) {
            throw protocolError();
        }
        turns.push(turn);
    }
    return {
        turns,
        nextCursor: typeof page.nextCursor === 'string'
            ? page.nextCursor
            : undefined,
    };
}

function normalizeToolItem(
    item: Record<string, any>
): { name: string; summary: string; detail?: string } | undefined {
    if (item.type === 'commandExecution') {
        const command = typeof item.command === 'string' ? item.command : '';
        const detail = capToolCallDetail(
            typeof item.aggregatedOutput === 'string'
                ? item.aggregatedOutput
                : ''
        );
        return {
            name: 'commandExecution',
            summary: buildToolCallSummary('commandExecution', { command }),
            ...(detail ? { detail } : {}),
        };
    }
    if (item.type === 'fileChange') {
        const rawChanges = Array.isArray(item.changes)
            ? item.changes
            : [];
        const entries = rawChanges
            .map(asRecord)
            .filter(Boolean)
            .map(change => {
                const kindRecord = asRecord(change.kind);
                return {
                    path: typeof change.path === 'string' ? change.path : '',
                    kind: typeof change.kind === 'string'
                        ? change.kind
                        : typeof kindRecord?.type === 'string'
                            ? kindRecord.type
                            : '',
                    diff: typeof change.diff === 'string' && change.diff
                        ? change.diff
                        : undefined,
                };
            });
        const first = entries[0];
        const label = `${first?.kind ? `${first.kind} ` : ''}${first?.path || ''}`.trim();
        const extraCount = Math.max(0, rawChanges.length - 1);
        const summary = buildToolCallSummary('fileChange', {
            path: extraCount > 0
                ? `${label} (+${extraCount} more)`
                : label,
        });
        const diffs: ConversationFileDiff[] = [];
        let rawDetail = '';
        for (const entry of entries.slice(
            0,
            CONVERSATION_LIMITS.maxDiffsPerToolCall
        )) {
            if (!entry.path) {
                continue;
            }
            if (!entry.diff) {
                // No diff payload: still surface the file row itself.
                diffs.push({
                    path: truncateGraphemes(
                        entry.path.trim(),
                        CONVERSATION_LIMITS.diffPathGraphemes - 1
                    ),
                    ...(entry.kind ? { kind: entry.kind } : {}),
                    additions: 0,
                    deletions: 0,
                    hunks: [],
                });
                continue;
            }
            const parsed = parseUnifiedDiff(
                entry.diff,
                entry.path,
                entry.kind || undefined
            );
            if (!parsed.length) {
                // Unparseable diff text stays visible as raw detail.
                rawDetail = rawDetail || entry.diff;
                continue;
            }
            for (const file of parsed) {
                if (diffs.length >= CONVERSATION_LIMITS.maxDiffsPerToolCall) {
                    break;
                }
                if (!file.kind && entry.kind) {
                    file.kind = entry.kind;
                }
                diffs.push(file);
            }
        }
        return {
            name: 'fileChange',
            summary,
            ...(rawDetail ? { detail: capToolCallDetail(rawDetail) } : {}),
            ...(diffs.length ? { diffs } : {}),
        };
    }
    return undefined;
}

function rateLimitLabel(durationMins: number | undefined): string {
    if (durationMins === 10_080) {
        return 'Week';
    }
    if (durationMins && durationMins % 60 === 0) {
        return `${durationMins / 60}h`;
    }
    return durationMins ? `${durationMins}m` : 'Limit';
}

function normalizeRateLimits(value: unknown): ConversationTelemetry['rateLimits'] {
    const result = asRecord(value);
    const canonical = asRecord(result?.rateLimits);
    const byId = asRecord(result?.rateLimitsByLimitId);
    const byIdEntries = byId
        ? Object.entries(byId).slice(0, 16)
        : [];
    const canonicalById = byIdEntries.find(([fallbackId, rawSnapshot]) => {
        const snapshot = asRecord(rawSnapshot);
        return fallbackId === 'codex' || snapshot?.limitId === 'codex';
    });
    const snapshots = canonical
        ? [['codex', canonical] as [string, unknown]]
        : canonicalById ? [canonicalById] : byIdEntries;
    const limits: ConversationTelemetry['rateLimits'] = [];
    const seen = new Set<string>();
    for (const [fallbackId, rawSnapshot] of snapshots) {
        const snapshot = asRecord(rawSnapshot);
        if (!snapshot) {
            continue;
        }
        const limitId = typeof snapshot.limitId === 'string'
            && snapshot.limitId
            ? snapshot.limitId.slice(0, 128)
            : fallbackId.slice(0, 128);
        for (const [kind, rawWindow] of [
            ['primary', snapshot.primary],
            ['secondary', snapshot.secondary],
        ] as const) {
            const window = asRecord(rawWindow);
            if (!window || !Number.isFinite(window.usedPercent)) {
                continue;
            }
            const duration = Number.isFinite(window.windowDurationMins)
                && window.windowDurationMins > 0
                ? Math.floor(window.windowDurationMins)
                : undefined;
            const id = `${limitId}:${kind}`;
            const dedupeKey = `${duration || 'unknown'}:${kind}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            limits.push({
                id,
                label: rateLimitLabel(duration),
                usedPercent: Math.max(
                    0,
                    Math.min(100, Number(window.usedPercent))
                ),
                windowDurationMins: duration,
                resetsAt: Number.isFinite(window.resetsAt)
                    && window.resetsAt > 0
                    ? Math.floor(window.resetsAt)
                    : undefined,
            });
        }
    }
    return limits
        .sort((left, right) =>
            (left.windowDurationMins || Number.MAX_SAFE_INTEGER)
            - (right.windowDurationMins || Number.MAX_SAFE_INTEGER))
        .slice(0, 4);
}

export class CodexConversationAdapter implements ConversationProviderAdapter {
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private providerWatch?: AiSessionDisposable;
    private invalidationTimer?: TimerHandle;
    private readonly tokenUsageBySession = new Map<string, {
        usedTokens: number;
        maxTokens: number;
    }>();
    private readonly notificationWatch?: AiSessionDisposable;
    private readonly telemetryCache = new Map<string, {
        readAt: number;
        value?: ConversationTelemetry;
    }>();
    private readonly telemetryReads = new Map<
        string,
        Promise<ConversationTelemetry | undefined>
    >();
    private readonly loadedConversationCache = new Map<
        string,
        CachedLoadedConversation
    >();
    private loadedConversationCacheChars = 0;
    private conversationCacheGeneration = 0;
    private disposed = false;
    // Circuit breaker for the experimental thread/turns/list accelerator:
    // once the server rejects the method or answers with a malformed page,
    // the paginated path is disabled for the lifetime of this adapter and
    // every reload uses the stable full thread/read instead.
    private paginatedReadsDisabled = false;

    constructor(private readonly options: CodexConversationAdapterOptions) {
        this.notificationWatch = options.client.watchNotifications?.(
            (method, params) => this.acceptNotification(method, params)
        );
    }

    async readSnapshot(
        sessionId: string,
        preferredInteractionId?: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot> {
        const loaded = await this.load(sessionId, signal);
        const outline = buildConversationOutline(
            'codex',
            sessionId,
            loaded.sourceRevision,
            loaded.interactions,
            false
        );
        const selected = outline.interactions.find(interaction =>
            interaction.id === preferredInteractionId
        ) || outline.interactions[outline.interactions.length - 1];
        return {
            outline,
            ...(selected ? {
                page: buildConversationPage(loaded.interactions, {
                    provider: 'codex',
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
            'codex',
            sessionId,
            loaded.sourceRevision,
            loaded.interactions,
            false
        );
    }

    async readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage> {
        const loaded = await this.load(request.sessionId, signal);
        return buildConversationPage(
            loaded.interactions,
            { ...request, provider: 'codex' },
            loaded.sourceRevision
        );
    }

    async readSubagents(
        sessionId: string,
        _signal?: ConversationAbortSignal
    ): Promise<ConversationSubagentEntry[]> {
        if (this.disposed) {
            return [];
        }
        const split = splitSubagentSessionId(sessionId);
        if (split.subagentId
            || typeof this.options.listSubagentThreads !== 'function') {
            return [];
        }
        let threads: AiSessionCodexSubagentThread[];
        try {
            threads = await this.options.listSubagentThreads(split.sessionId);
        } catch (_error) {
            return [];
        }
        const now = Date.now();
        const entries: ConversationSubagentEntry[] = [];
        for (const thread of threads) {
            if (entries.length >= MAX_LISTED_SUBAGENTS
                || !isSubagentId(thread.id)) {
                continue;
            }
            const base = subagentPathBase(thread.agentPath);
            entries.push({
                id: thread.id,
                label: subagentLabel(thread),
                ...(base ? { agentType: base } : {}),
                status: subagentStatus(
                    thread.completed,
                    thread.fileMtimeMs,
                    now
                ),
                ...(thread.createdAt !== undefined
                    ? { createdAt: Math.floor(thread.createdAt) }
                    : {}),
                updatedAt: Math.floor(thread.fileMtimeMs),
            });
        }
        entries.sort((left, right) =>
            (left.createdAt ?? left.updatedAt ?? 0)
            - (right.createdAt ?? right.updatedAt ?? 0));
        return entries;
    }

    async readTelemetry(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined> {
        const cached = this.telemetryCache.get(sessionId);
        if (cached
            && Date.now() - cached.readAt
            < CONVERSATION_LIMITS.telemetryRefreshMs) {
            cached.value = await this.refreshCachedTelemetry(
                sessionId,
                cached.value
            );
            return cached.value;
        }
        const existing = this.telemetryReads.get(sessionId);
        if (existing) {
            return existing;
        }
        const read = this.loadTelemetry(sessionId, signal);
        this.telemetryReads.set(sessionId, read);
        try {
            const value = await read;
            if (!this.disposed) {
                this.makeRoomForTelemetrySession(sessionId);
                this.telemetryCache.set(sessionId, {
                    readAt: Date.now(),
                    value,
                });
            }
            return value;
        } finally {
            if (this.telemetryReads.get(sessionId) === read) {
                this.telemetryReads.delete(sessionId);
            }
        }
    }

    private async loadTelemetry(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined> {
        const rollout = this.readRolloutTelemetrySnapshot(sessionId);
        const [threadReadResult, limitsResult] = await Promise.all([
            this.options.client.request(
                'thread/read',
                { threadId: sessionId, includeTurns: false },
                signal
            ).then(
                value => ({ fulfilled: true as const, value }),
                () => ({ fulfilled: false as const })
            ),
            this.options.client.request(
                'account/rateLimits/read',
                undefined,
                signal
            ).then(
                value => ({ fulfilled: true as const, value }),
                () => ({ fulfilled: false as const })
            ),
        ]);
        const telemetry: ConversationTelemetry = {
            provider: 'codex',
            sessionId,
            rateLimits: limitsResult.fulfilled
                ? normalizeRateLimits(limitsResult.value)
                : [],
        };
        if (rollout?.model) {
            telemetry.model = rollout.model;
        }
        const worktree = await this.readWorktree(
            threadReadResult,
            rollout?.currentWorkdir
        );
        if (worktree) {
            telemetry.worktree = worktree;
        }
        const context = rollout?.context
            || this.tokenUsageBySession.get(sessionId);
        if (context) {
            telemetry.context = { ...context };
        }
        return telemetry.model || telemetry.context || telemetry.worktree
            || telemetry.rateLimits.length
            ? telemetry
            : undefined;
    }

    private async readWorktree(
        threadReadResult: { fulfilled: true; value: unknown }
            | { fulfilled: false },
        currentWorkdir: string | undefined
    ): Promise<ConversationWorktreeInfo | undefined> {
        if (!this.options.resolveWorktree) {
            return undefined;
        }
        // The current operating directory wins over the launch directory:
        // app-server exposes no exec items, so composition injects a
        // telemetry-only probe for the latest exec workdir.
        if (currentWorkdir) {
            const resolved = await this.options.resolveWorktree(currentWorkdir);
            if (resolved) {
                return resolved;
            }
        }
        const response = threadReadResult.fulfilled
            ? asRecord(threadReadResult.value)
            : undefined;
        const thread = asRecord(response?.thread);
        const cwd = typeof thread?.cwd === 'string' && thread.cwd
            ? thread.cwd
            : undefined;
        return cwd ? this.options.resolveWorktree(cwd) : undefined;
    }

    private readRolloutTelemetrySnapshot(
        sessionId: string
    ): CodexRolloutTelemetrySnapshot | undefined {
        try {
            return this.options.readRolloutTelemetry?.(sessionId);
        } catch (_error) {
            return undefined;
        }
    }

    private async refreshCachedTelemetry(
        sessionId: string,
        telemetry: ConversationTelemetry | undefined
    ): Promise<ConversationTelemetry | undefined> {
        const rollout = this.readRolloutTelemetrySnapshot(sessionId);
        if (rollout?.model || rollout?.context) {
            telemetry = telemetry || {
                provider: 'codex',
                sessionId,
                rateLimits: [],
            };
            if (rollout.model) {
                telemetry.model = rollout.model;
            }
            if (rollout.context) {
                telemetry.context = { ...rollout.context };
            }
        }
        if (!rollout?.currentWorkdir || !this.options.resolveWorktree) {
            return telemetry;
        }
        let worktree: ConversationWorktreeInfo | undefined;
        try {
            worktree = await this.options.resolveWorktree(
                rollout.currentWorkdir
            );
        } catch (_error) {
            return telemetry;
        }
        if (!worktree) {
            return telemetry;
        }
        if (telemetry) {
            telemetry.worktree = worktree;
            return telemetry;
        }
        return {
            provider: 'codex',
            sessionId,
            worktree,
            rateLimits: [],
        };
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
        try {
            this.ensureProviderWatch();
        } catch (error) {
            callbacks.delete(listener);
            if (!callbacks.size) {
                this.subscriptions.delete(sessionId);
            }
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
        this.notificationWatch?.dispose();
        this.tokenUsageBySession.clear();
        this.telemetryCache.clear();
        this.telemetryReads.clear();
        this.invalidateLoadedConversationCache();
        this.loadedConversationCache.clear();
        this.loadedConversationCacheChars = 0;
        this.subscriptions.clear();
        this.options.client.dispose();
    }

    private acceptNotification(method: string, value: unknown): void {
        if (method !== 'thread/tokenUsage/updated') {
            return;
        }
        const params = asRecord(value);
        const usage = asRecord(params?.tokenUsage);
        const last = asRecord(usage?.last);
        if (typeof params?.threadId !== 'string'
            || !params.threadId
            || params.threadId.length > 256
            || !Number.isFinite(last?.totalTokens)
            || last.totalTokens < 0
            || !Number.isFinite(usage?.modelContextWindow)
            || usage.modelContextWindow <= 0) {
            return;
        }
        const context = {
            usedTokens: Math.floor(last.totalTokens),
            maxTokens: Math.floor(usage.modelContextWindow),
        };
        this.makeRoomForTelemetrySession(params.threadId);
        this.tokenUsageBySession.set(params.threadId, context);
        const cached = this.telemetryCache.get(params.threadId);
        if (cached?.value) {
            cached.value.context = { ...context };
        }
    }

    private makeRoomForTelemetrySession(sessionId: string): void {
        if (this.telemetryCache.has(sessionId)
            || this.tokenUsageBySession.has(sessionId)) {
            return;
        }
        const sessionIds = Array.from(new Set([
            ...this.telemetryCache.keys(),
            ...this.tokenUsageBySession.keys(),
        ]));
        if (sessionIds.length
            < CONVERSATION_LIMITS.inactiveIndexLimitPerProvider) {
            return;
        }
        const oldest = sessionIds[0];
        if (typeof oldest === 'string') {
            this.telemetryCache.delete(oldest);
            this.tokenUsageBySession.delete(oldest);
        }
    }

    private load(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<LoadedConversation> {
        if (signal?.aborted) {
            return Promise.reject(new ConversationAbortError());
        }
        this.evictIdleLoadedConversations();
        // The rollout stat signature is captured before the (potentially
        // multi-second) provider read: an append landing mid-read makes the
        // next probe mismatch and forces a fresh read, so the entry can
        // never serve content newer than what it claims.
        const signature = this.contentSignature(sessionId);
        const cached = this.loadedConversationCache.get(sessionId);
        if (cached) {
            if (signature !== undefined
                && signature === cached.contentSignature) {
                cached.lastTouchedAt = this.now();
                this.loadedConversationCache.delete(sessionId);
                this.loadedConversationCache.set(sessionId, cached);
                return Promise.resolve(cached.value);
            }
            // A stale or unverifiable entry is released immediately rather
            // than lingering beside — or instead of — its replacement.
            this.deleteLoadedConversationCacheEntry(sessionId, cached);
        }
        const generation = this.conversationCacheGeneration;
        const startedAt = this.now();
        return this.loadConversation(sessionId, cached, signal).then(outcome => {
            if (!this.disposed
                && generation === this.conversationCacheGeneration
                && signature !== undefined
                && (outcome.kind === 'incremental'
                    || outcome.characters >= LARGE_CONVERSATION_CACHE_CHARS
                    || this.now() - startedAt
                        >= LARGE_CONVERSATION_CACHE_MIN_READ_MS)) {
                this.storeLoadedConversationCacheEntry(sessionId, {
                    value: outcome.value,
                    contentSignature: signature,
                    characters: outcome.characters,
                    lastTouchedAt: this.now(),
                    turns: outcome.turns,
                });
            }
            return outcome.value;
        });
    }

    private async loadConversation(
        sessionId: string,
        stale: CachedLoadedConversation | undefined,
        signal?: ConversationAbortSignal
    ): Promise<{
        value: LoadedConversation;
        turns?: LoadedConversationTurn[];
        characters: number;
        kind: 'fresh' | 'incremental';
    }> {
        const split = splitSubagentSessionId(sessionId);
        if (stale?.turns?.length
            && !split.subagentId
            && this.paginatedReadsUsable()) {
            const incremental = await this.loadIncremental(
                sessionId,
                stale as CachedLoadedConversation
                    & { turns: LoadedConversationTurn[] },
                signal
            );
            if (incremental) {
                return { ...incremental, kind: 'incremental' };
            }
        }
        if (stale) {
            // A stale or unverifiable entry is released rather than
            // lingering beside — or instead of — its replacement.
            this.deleteLoadedConversationCacheEntry(sessionId, stale);
        }
        const fresh = await this.loadFresh(sessionId, signal);
        return { ...fresh, kind: 'fresh' };
    }

    private paginatedReadsUsable(): boolean {
        if (this.paginatedReadsDisabled) {
            return false;
        }
        const version = this.options.client.getServerVersion?.();
        return version !== undefined
            && PAGINATED_READ_SERVER_VERSIONS.has(version);
    }

    /**
     * Reloads a cached root-thread conversation by fetching only the tail of
     * the thread through thread/turns/list. Returns null when the tail was
     * rewritten (compaction/rollback) or the content would equally fail the
     * stable path — the caller then falls back to a full thread/read. Any
     * transport- or page-level anomaly additionally disables the paginated
     * path for the lifetime of this adapter.
     */
    private async loadIncremental(
        sessionId: string,
        cached: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        signal?: ConversationAbortSignal
    ): Promise<{
        value: LoadedConversation;
        turns: LoadedConversationTurn[];
        characters: number;
    } | null> {
        const anchorTurnId = cached.turns[cached.turns.length - 1].turnId;
        const fetched: Record<string, any>[] = [];
        let cursor: string | undefined;
        let anchorIndex = -1;
        while (anchorIndex < 0 && fetched.length < PAGINATED_READ_WALK_LIMIT) {
            let page: unknown;
            try {
                page = await this.options.client.request('thread/turns/list', {
                    threadId: sessionId,
                    cursor,
                    limit: PAGINATED_READ_PAGE_SIZE,
                    sortDirection: 'desc',
                    itemsView: 'full',
                }, signal);
            } catch (error) {
                if (error instanceof ConversationAbortError
                    || error?.name === 'AbortError') {
                    throw error;
                }
                if (this.disposed) {
                    throw new ConversationError(
                        'unavailable',
                        'reconnectingCodex'
                    );
                }
                this.paginatedReadsDisabled = true;
                return null;
            }
            let pageTurns: Record<string, any>[];
            let nextCursor: string | undefined;
            try {
                ({ turns: pageTurns, nextCursor } = parseTurnsListPage(page));
            } catch (_error) {
                this.paginatedReadsDisabled = true;
                return null;
            }
            fetched.push(...pageTurns);
            anchorIndex = fetched.findIndex(turn => turn.id === anchorTurnId);
            if (!nextCursor || pageTurns.length === 0) {
                break;
            }
            cursor = nextCursor;
        }
        if (anchorIndex < 0) {
            return null;
        }
        // `fetched` is newest-first: re-read the anchor turn (it may have
        // grown since it was cached) plus every turn appended after it,
        // in chronological order.
        const replaced = fetched.slice(0, anchorIndex + 1).reverse();
        const kept = cached.turns.slice(0, -1);
        const itemIds = new Set<string>();
        for (const chunk of kept) {
            for (const itemId of chunk.itemIds) {
                itemIds.add(itemId);
            }
        }
        const keptTurnIds = new Set(kept.map(chunk => chunk.turnId));
        const newTurns: LoadedConversationTurn[] = [];
        try {
            for (const turn of replaced) {
                if (keptTurnIds.has(turn.id)) {
                    // A supposedly immutable earlier turn reappeared: the
                    // history was rewritten, which only a full read settles.
                    return null;
                }
                const context: NormalizeTurnContext = {
                    interactions: [],
                    itemIds,
                    newItemIds: [],
                    seededDispatchTimingComplete: true,
                };
                normalizeTurnItems(turn, context);
                newTurns.push({
                    turnId: turn.id,
                    interactions: context.interactions,
                    itemIds: context.newItemIds,
                    fingerprint: fingerprintInteractions(context.interactions),
                    characters: conversationCharacters(context.interactions),
                });
            }
        } catch (_error) {
            // Content the stable path would reject as well: fall back so the
            // full read surfaces the canonical error.
            return null;
        }
        const turns = [...kept, ...newTurns];
        const sourceRevision = composeConversationRevision(turns);
        const characters = turns.reduce(
            (sum, turn) => sum + turn.characters,
            0
        );
        if (sourceRevision === cached.value.sourceRevision) {
            // The stat moved but the visible content did not: keep the
            // cached value (its identity is pinned to the revision) and let
            // the caller re-anchor the entry to the new signature.
            return { value: cached.value, turns, characters };
        }
        const interactions = this.promoteRunningLifecycle(
            sessionId,
            turns.reduce<ConversationInteraction[]>(
                (all, turn) => all.concat(turn.interactions),
                []
            )
        );
        return { value: { interactions, sourceRevision }, turns, characters };
    }

    private storeLoadedConversationCacheEntry(
        sessionId: string,
        entry: CachedLoadedConversation
    ): void {
        const previous = this.loadedConversationCache.get(sessionId);
        if (previous) {
            this.deleteLoadedConversationCacheEntry(sessionId, previous);
        }
        this.loadedConversationCache.set(sessionId, entry);
        this.loadedConversationCacheChars += entry.characters;
        while ((this.loadedConversationCache.size
                > LARGE_CONVERSATION_CACHE_ENTRIES
            || this.loadedConversationCacheChars
                > LARGE_CONVERSATION_CACHE_BUDGET_CHARS)
            && this.loadedConversationCache.size > 1) {
            const oldest = this.loadedConversationCache.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            const evicted = this.loadedConversationCache.get(oldest);
            if (evicted) {
                this.deleteLoadedConversationCacheEntry(oldest, evicted);
            }
        }
    }

    private deleteLoadedConversationCacheEntry(
        sessionId: string,
        entry: CachedLoadedConversation
    ): void {
        if (this.loadedConversationCache.get(sessionId) === entry) {
            this.loadedConversationCache.delete(sessionId);
            this.loadedConversationCacheChars -= entry.characters;
        }
    }

    private evictIdleLoadedConversations(): void {
        const now = this.now();
        for (const [sessionId, entry] of this.loadedConversationCache) {
            if (now - entry.lastTouchedAt
                > LARGE_CONVERSATION_CACHE_IDLE_MS) {
                this.deleteLoadedConversationCacheEntry(sessionId, entry);
            }
        }
    }

    private contentSignature(sessionId: string): string | undefined {
        try {
            const split = splitSubagentSessionId(sessionId);
            return this.options.readContentSignature?.(
                split.subagentId || split.sessionId
            );
        } catch (_error) {
            // A failing probe must never break a read: degrade to an
            // always-fresh full provider read instead.
            return undefined;
        }
    }

    private invalidateLoadedConversationCache(): void {
        // Entries self-validate against the rollout stat on every read, so
        // an invalidation only needs to guard reads currently in flight
        // from caching a change they raced.
        this.conversationCacheGeneration += 1;
    }

    private async loadFresh(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<{
        value: LoadedConversation;
        turns?: LoadedConversationTurn[];
        characters: number;
    }> {
        if (this.disposed) {
            throw new ConversationError(
                'unavailable',
                'reconnectingCodex'
            );
        }
        const split = splitSubagentSessionId(sessionId);
        if (split.subagentId && !isSubagentId(split.subagentId)) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const threadId = split.subagentId || split.sessionId;
        let result: unknown;
        try {
            result = await this.options.client.request('thread/read', {
                threadId,
                includeTurns: true,
            }, signal);
        } catch (error) {
            if (error instanceof ConversationError
                || error?.name === 'AbortError') {
                throw error;
            }
            // A missing or unreadable subagent thread is a missing source,
            // not a protocol failure of the parent conversation.
            throw split.subagentId
                ? new ConversationError('unavailable', 'missingSource')
                : protocolError();
        }
        let normalized: ReturnType<typeof normalizeThreadRead>;
        try {
            if (split.subagentId) {
                const thread = asRecord(asRecord(result)?.thread);
                if (thread?.parentThreadId !== split.sessionId) {
                    throw new ConversationError('unavailable', 'missingSource');
                }
            }
            const dispatch = split.subagentId
                ? subagentDispatch(
                    asRecord(asRecord(result)?.thread),
                    threadId
                )
                : undefined;
            normalized = normalizeThreadRead(result, threadId, dispatch);
        } catch (error) {
            if (error instanceof ConversationError) {
                throw error;
            }
            throw protocolError();
        }
        const turns: LoadedConversationTurn[] = normalized.turns.map(chunk => ({
            ...chunk,
            fingerprint: fingerprintInteractions(chunk.interactions),
            characters: conversationCharacters(chunk.interactions),
        }));
        // App Server instances do not share live turn state. When another
        // extension owns the running turn, thread/read can persist it as
        // interrupted even while its rollout is still receiving events.
        // Keep the protocol fingerprint content-only, then let the rollout's
        // authoritative lifecycle promote the latest visible interaction.
        const sourceRevision = composeConversationRevision(turns);
        const interactions = split.subagentId || !normalized.interactions.length
            ? normalized.interactions
            : this.promoteRunningLifecycle(
                split.sessionId,
                normalized.interactions
            );
        return {
            value: { interactions, sourceRevision },
            // Turn chunks only serve the incremental paginated reload path,
            // which is limited to root threads: a subagent's seeded dispatch
            // interaction accumulates items across turns, so its chunks are
            // not independently re-normalizable.
            turns: split.subagentId ? undefined : turns,
            characters: turns.reduce((sum, turn) => sum + turn.characters, 0),
        };
    }

    private promoteRunningLifecycle(
        sessionId: string,
        interactions: ConversationInteraction[]
    ): ConversationInteraction[] {
        let lifecycleSignal: AiSessionLifecycleSignal | undefined;
        try {
            lifecycleSignal = this.options.readLifecycleSignal?.(sessionId);
        } catch (_error) {
            // Lifecycle enrichment is best effort. Protocol content must
            // remain readable if the rollout disappears during a refresh.
        }
        if (lifecycleSignal?.executionState !== 'running'
            || !interactions.length) {
            return interactions;
        }
        const latest = interactions[interactions.length - 1];
        return [
            ...interactions.slice(0, -1),
            { ...latest, responseState: 'inProgress' },
        ];
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
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
            // Invalidate right before notifying, not on every watch event: a
            // streaming session fires events continuously, and clearing the
            // large-conversation cache per event forced every amplified read
            // (switch, revalidation, warmup) into a full thread/read.
            this.invalidateLoadedConversationCache();
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
            // The canceled debounce still represents a real change event;
            // its invalidation must not be silently dropped.
            this.invalidateLoadedConversationCache();
        }
    }
}

function subagentAgentPath(
    thread: Record<string, any> | undefined
): string | undefined {
    const spawn = asRecord(asRecord(asRecord(thread?.source)?.subAgent)
        ?.thread_spawn);
    return typeof spawn?.agent_path === 'string' && spawn.agent_path
        ? spawn.agent_path
        : undefined;
}

function subagentPathBase(agentPath: string | undefined): string {
    if (!agentPath) {
        return '';
    }
    const segments = agentPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
}

function subagentLabel(
    thread: Pick<AiSessionCodexSubagentThread, 'id' | 'agentNickname' | 'agentPath'>
): string {
    const base = subagentPathBase(thread.agentPath);
    const label = thread.agentNickname
        ? `${thread.agentNickname} · ${base}`
        : base;
    const normalized = normalizeVisibleText(label);
    if (normalized) {
        return hasAtMostGraphemes(normalized, 120)
            ? normalized
            : truncateGraphemes(normalized, 119);
    }
    return thread.id;
}

function subagentDispatch(
    thread: Record<string, any> | undefined,
    threadId: string
): { label: string; timestamp?: number } {
    const createdAtSeconds = typeof thread?.createdAt === 'number'
        && Number.isFinite(thread.createdAt)
        ? thread.createdAt
        : undefined;
    return {
        label: subagentLabel({
            id: threadId,
            agentNickname: typeof thread?.agentNickname === 'string'
                ? thread.agentNickname
                : undefined,
            agentPath: subagentAgentPath(thread),
        }),
        ...(createdAtSeconds !== undefined
            ? { timestamp: Math.floor(createdAtSeconds * 1000) }
            : {}),
    };
}

function subagentStatus(
    completed: boolean,
    transcriptMtimeMs: number,
    now: number
): ConversationSubagentEntry['status'] {
    if (completed) {
        return 'idle';
    }
    // A crashed CLI leaves a stale transcript without task_complete
    // behind, but so does a long quiet command: only a freshly written
    // rollout proves the subagent is alive; staleness alone is not death
    // evidence, so report quiet rather than failed.
    return now - transcriptMtimeMs <= SUBAGENT_RUNNING_FRESHNESS_MS
        ? 'running'
        : 'quiet';
}
