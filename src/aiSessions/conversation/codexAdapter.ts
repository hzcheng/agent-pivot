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
    // Resolves the shared initialize handshake and returns the server
    // version. Concurrent callers attach to the same handshake; a caller's
    // abort cancels only its own wait, never the handshake. Cold-start
    // paths must await this before version-gating: getServerVersion() is
    // undefined until the first request triggers the handshake.
    ensureReady?(
        signal?: ConversationAbortSignal
    ): Promise<string | undefined>;
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
    // Goal-continuation turn ids mapped to their `/goal` objective, read
    // from the rollout transcript. The app-server strips the internal
    // goal user message from turn items, leaving goal turns with no
    // userMessage at all; without this map their whole content would have
    // no interaction to attach to and would silently drop.
    readGoalTurns?(
        sessionId: string
    ): ReadonlyMap<string, string> | undefined;
    // Rollout stat signature used solely as the validity signal for the
    // normalized-conversation cache: identical stat means the app-server
    // content cannot have changed, so the cached conversation is reused
    // without another full thread/read. An undefined/unreadable signature
    // bypasses the cache entirely.
    readContentSignature?(sessionId: string): string | undefined;
    // Rollout byte size. Pure optimization-choosing heuristic for the
    // windowed cold start (is paging worth it for this session) — the
    // framed app-server response size/duration cannot be inferred from
    // the source size, so this never feeds correctness or
    // fallback-feasibility decisions.
    readSourceBytes?(sessionId: string): number | undefined;
    readLifecycleSignal?(
        sessionId: string
    ): AiSessionLifecycleSignal | undefined;
    listSubagentThreads?(
        sessionId: string
    ): AiSessionCodexSubagentThread[] | Promise<AiSessionCodexSubagentThread[]>;
    // The context window declared by the session's Codex profile overlay, if
    // any. The app-server reports its built-in default for custom provider
    // models, so a declared profile value takes precedence for display. The
    // model (when known) lets the host match sessions started outside the
    // extension, which have no recorded profile decision.
    getSessionProfileContextWindow?(sessionId: string, model?: string): number | undefined;
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
// First-page latency separates the two server backends (spike
// measurements): the indexed paginated backend answers in tens of ms,
// while the legacy rollout-replay backend needs hundreds of ms PER PAGE —
// each page costs a full replay, as much as one full thread/read. A slow
// first page therefore ends the anchor walk immediately: further paging
// can only lose against the full-read fallback.
const PAGINATED_READ_SLOW_PAGE_MS = 250;
// Bounds for anchor walks on the fast paginated backend. Compaction makes
// the walk run to the end of the thread and rebuilds from the fetched
// pages — for huge paginated sessions a full thread/read would exceed the
// request timeout outright, so the walk must be allowed to be generous.
const PAGINATED_READ_WALK_TURN_LIMIT = 1024;
const PAGINATED_READ_WALK_BUDGET_MS = 3000;
// Windowed cold start (spikes/codex-cold-start): on a verified paginated
// backend, the first load of a large session lists every turn as a
// summary skeleton and materializes full items only for the tail window;
// older windows are fetched on demand through readPage/readSnapshot.
// Below this rollout size the plain thread/read cold start stays as is.
const COLD_START_WINDOW_MIN_SOURCE_BYTES = 4 * 1024 * 1024;
// Summary walk page size; one boundary cursor is recorded per page, so
// this is also the seek granularity of on-demand materialization.
const COLD_START_SUMMARY_PAGE_TURNS = 50;
// Legacy-verdict latency: the legacy replay backend costs a full replay
// PER PAGE (hundreds of ms), the indexed paginated backend answers in
// tens of ms. The verdict requires BOTH of the first two pages to be
// slow — a single jittery page must not decide. The handshake is already
// excluded (ensureReady settles before the walk starts).
const COLD_START_SLOW_PAGE_MS = 250;
// Runaway safety valves (resource bounds, not heuristics): a paginated
// backend serves flat ~tens-of-ms pages, so these trip only on
// server-side pathology.
const COLD_START_MAX_WALK_PAGES = 4000;
const COLD_START_MAX_WALK_MS = 120_000;
// Tail window materialized eagerly at cold start (~one retained viewer
// page set) and the full-turn page size of on-demand materialization
// (keeps single responses ~2MB even for the heaviest turns).
const COLD_START_TAIL_TURNS = 40;
const COLD_START_TAIL_BYTES = 1536 * 1024;
const COLD_START_MATERIALIZE_PAGE_TURNS = 8;
// Per-entry budget for materialized (full-chunk) characters, on the
// order of the viewer's retained window: scrolling history materializes
// chunks, and least-recently-used full chunks fall back to skeletons
// beyond this budget so a long browsing session cannot re-inflate the
// entry toward the whole conversation.
const WINDOWED_ENTRY_MATERIALIZED_CHARS = 4 * 1024 * 1024;

interface LoadedConversation {
    interactions: ConversationInteraction[];
    sourceRevision: string;
}

// One cold-start/reload's result plus the state a windowed entry must
// persist (see CachedLoadedConversation).
interface LoadConversationOutcome {
    value: LoadedConversation;
    turns?: LoadedConversationTurn[];
    characters: number;
    // Windowed entries must keep their basis across incremental reloads —
    // losing it would strand skeleton chunks without a materialization
    // path.
    revisionBasis?: 'full' | 'windowed';
    structureGen?: number;
    walkPages?: { startCursor?: string; turnCount: number }[];
    walkNewerTurns?: number;
    contentEpochSignature?: string;
}

// loadWindowed either loads, verdicts the backend as legacy replay (both
// first pages slow), or returns null when gated/failing transiently.
type WindowedLoadResult =
    | (LoadConversationOutcome & {
        turns: LoadedConversationTurn[];
        legacy?: false;
    })
    | { legacy: true }
    | null;

// loadIncremental either produces an outcome or asks the caller to
// rebuild a windowed entry through a fresh summary walk.
type IncrementalLoadResult =
    | (LoadConversationOutcome & {
        turns: LoadedConversationTurn[];
        rebuild?: false;
    })
    | { rebuild: true }
    | null;

// Per-turn normalized chunks of a cached root-thread conversation. Chunk
// interactions share objects with `value.interactions` (no string payload
// is duplicated); they let an incremental reload re-normalize only the
// turns that actually changed. `kind: 'skeleton'` chunks come from the
// windowed cold start's summary walk: they carry only the
// outline-level projection (first user message + turn fields) and are
// materialized into full chunks on demand.
interface LoadedConversationTurn {
    turnId: string;
    itemIds: string[];
    interactions: ConversationInteraction[];
    // Full chunks: hash of the normalized interactions. Skeleton chunks
    // leave this empty — they join reuse decisions via summaryFingerprint.
    fingerprint: string;
    // Hash of the turn's summary-level projection (turn fields + first
    // user message), derived identically from a summary page or a full
    // turn. Stable across materialization.
    summaryFingerprint: string;
    // The skeleton's summary item ids, kept on full chunks so a chunk
    // can be demoted back to a skeleton (freshness invalidation or the
    // materialized-window LRU) without another fetch.
    skeletonItemIds: string[];
    characters: number;
    kind: 'full' | 'skeleton';
    // Full chunks only: last time the chunk was materialized or covered
    // by a served page; drives the materialized-window LRU.
    lastTouchedAt?: number;
}

interface CachedLoadedConversation {
    value: LoadedConversation;
    contentSignature: string;
    characters: number;
    lastTouchedAt: number;
    turns?: LoadedConversationTurn[];
    // Windowed-entry state (undefined for full-read entries). The
    // windowed revision is a PROJECTION revision: it covers the
    // outline-level turn structure plus materialized content — never the
    // bytes of unmaterized turns, whose freshness is guaranteed by
    // fetching them live at materialization time.
    revisionBasis?: 'full' | 'windowed';
    // Bumped when materialization changes the interaction-id set of a
    // turn (a multi-user-message turn expanding). Keeps cursors truthful:
    // a changed id set must invalidate cursors anchored at new ids.
    structureGen?: number;
    // One entry per summary walk page (walk order = newest first),
    // giving each skeleton page the request cursor that reproduces it.
    walkPages?: { startCursor?: string; turnCount: number }[];
    // Turns appended after the walk: they shift every walked chunk's
    // newest-first index, so page mapping rebases by this count.
    walkNewerTurns?: number;
    // Stat signature as of the last observed projection change — the
    // content-epoch component of the windowed revision.
    contentEpochSignature?: string;
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
    goalTurns?: ReadonlyMap<string, string>;
}

// Deterministic interaction id for a goal-continuation turn's synthesized
// input. Stable across the skeleton and full paths so anchors survive
// materialization, matching the userMessage-based id rule.
function goalInteractionId(turnId: string): string {
    return `${turnId}-goal`;
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
    // Goal-continuation turns carry no userMessage (the app-server strips
    // the injected internal goal prompt), so their content items would
    // otherwise have no interaction to attach to and silently drop.
    // Synthesize the `/goal` input lazily, only for turns the rollout scan
    // identified as goal continuations; unknown internal turn kinds keep
    // the previous drop behavior.
    const ensureContentInteraction = (): number | undefined => {
        if (currentInteractionIndex !== undefined) {
            return currentInteractionIndex;
        }
        const objective = typeof turn.id === 'string'
            ? context.goalTurns?.get(turn.id)
            : undefined;
        if (!objective) {
            return undefined;
        }
        const userMarkdown = visibleMessage(`/goal ${objective}`);
        interactions.push({
            id: goalInteractionId(turn.id as string),
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
        return currentInteractionIndex;
    };
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
            const targetIndex = ensureContentInteraction();
            if (targetIndex === undefined) {
                continue;
            }
            // App-server exposes readable summaries separately from raw
            // reasoning content. Only the summary is safe viewer output;
            // never fall back to `content` or legacy `text` fields.
            const text = normalizeReasoningSummary(item.summary);
            if (text) {
                const interaction = interactions[targetIndex];
                (interaction.thinking ||= []).push({
                    position: interaction.assistantMarkdown.length,
                    text,
                });
            }
        } else if (item.type === 'commandExecution'
            || item.type === 'fileChange') {
            const targetIndex = ensureContentInteraction();
            if (targetIndex === undefined) {
                continue;
            }
            const tool = normalizeToolItem(item);
            if (!tool) {
                continue;
            }
            const interaction = interactions[targetIndex];
            (interaction.toolCalls ||= []).push({
                position: interaction.assistantMarkdown.length,
                ...tool,
            });
        } else if (item.type === 'plan') {
            const targetIndex = ensureContentInteraction();
            if (targetIndex === undefined) {
                continue;
            }
            const planText = typeof item.text === 'string'
                ? visibleMessage(item.text)
                : '';
            if (!planText) {
                continue;
            }
            const interaction = interactions[targetIndex];
            (interaction.plans ||= []).push({
                position: interaction.assistantMarkdown.length,
                markdown: planText,
            });
        } else if (item.type === 'agentMessage') {
            if (typeof item.text !== 'string') {
                throw protocolError();
            }
            const targetIndex = ensureContentInteraction();
            if (targetIndex === undefined) {
                continue;
            }
            const text = visibleMessage(item.text);
            if (!text) {
                continue;
            }
            const interaction = interactions[targetIndex];
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
    dispatch?: { label: string; timestamp?: number },
    goalTurns?: ReadonlyMap<string, string>
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
        goalTurns,
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

// Stable JSON with sorted object keys: the fingerprint input for
// summary-level turn projections (whose `error` field is a nested object).
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        return `{${keys.map(key =>
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// Raw text of a userMessage item (no visible-message capping): the
// summary and full views carry the item verbatim (spike-verified), so
// raw text keeps the fingerprint identical across both derivations.
function rawUserMessageText(item: Record<string, any>): string {
    if (!Array.isArray(item.content)) {
        return '';
    }
    let text = '';
    for (const rawPart of item.content) {
        const part = asRecord(rawPart);
        if (part?.type === 'text' && typeof part.text === 'string') {
            text += part.text;
        }
    }
    return text;
}

// Hash of a turn's summary-level projection: turn fields plus the FIRST
// userMessage. Mirrors the server projection's summary rule
// (first_user_item_id, schema-verified in spikes/codex-cold-start).
// The final agentMessage is deliberately EXCLUDED: the summary view
// omits it for interrupted turns and can otherwise diverge from the full
// view (real-data probe: 9/218 turns), while the user side is verbatim
// everywhere. Content changes still move the revision through the
// content-epoch (stat) component; this fingerprint only pins the
// outline-level turn structure.
function turnSummaryFingerprint(turn: Record<string, any>): string {
    let firstUser: { id: string; text: string } | null = null;
    for (const rawItem of turn.items as unknown[]) {
        const item = asRecord(rawItem);
        if (!item || typeof item.id !== 'string') {
            continue;
        }
        if (item.type === 'userMessage') {
            firstUser = { id: item.id, text: rawUserMessageText(item) };
            break;
        }
    }
    return createHash('sha256')
        .update(canonicalJson({
            id: turn.id,
            status: turn.status,
            startedAt: turn.startedAt ?? null,
            completedAt: turn.completedAt ?? null,
            error: turn.error ?? null,
            firstUser,
        }), 'utf8')
        .digest('hex');
}

// The windowed revision: a PROJECTION revision covering the outline-level
// turn structure (summary fingerprints) and the materialized content
// epoch (stat signature as of the last observed change), plus the
// structure generation (interaction-id set changes). Materializing a
// skeleton without an id-set change alters none of the inputs, so
// retained-page cursors survive scrolling-driven materialization.
// Rebuilds a full chunk's interactions into skeleton form (the
// outline-level projection of its FIRST interaction) and demotes it.
// Demotion is how materialized content re-enters the
// "fetched live before it is shown" state: the summary fingerprint and
// skeleton item ids are inherited, so the projection revision only moves
// when the demotion shrinks the interaction-id set (an expanded
// multi-user-message turn), which the caller reports through the
// structure generation.
function demoteToSkeleton(
    chunk: LoadedConversationTurn
): LoadedConversationTurn {
    const first = chunk.interactions[0];
    const interactions: ConversationInteraction[] = first
        ? [{
            id: first.id,
            ...(first.providerTurnId !== undefined
                ? { providerTurnId: first.providerTurnId } : {}),
            ...(first.timestamp !== undefined
                ? { timestamp: first.timestamp } : {}),
            ...(first.completedAt !== undefined
                ? { completedAt: first.completedAt } : {}),
            userMarkdown: first.userMarkdown,
            userPreview: first.userPreview,
            userGraphemeCount: first.userGraphemeCount,
            assistantMarkdown: [],
            responseState: first.responseState,
        }]
        : [];
    return {
        turnId: chunk.turnId,
        kind: 'skeleton',
        interactions,
        itemIds: [...chunk.skeletonItemIds],
        fingerprint: '',
        summaryFingerprint: chunk.summaryFingerprint,
        skeletonItemIds: [...chunk.skeletonItemIds],
        characters: conversationCharacters(interactions),
    };
}

function composeWindowedRevision(
    contentEpochSignature: string,
    turns: readonly LoadedConversationTurn[],
    structureGen: number
): string {
    return createHash('sha256')
        .update(`${contentEpochSignature}|${structureGen}|`, 'utf8')
        .update(turns.map(turn => turn.summaryFingerprint).join(':'), 'utf8')
        .digest('hex');
}

// Builds the skeleton chunk content for one turn from its summary view:
// zero or one interaction mirroring normalizeTurnItems' userMessage
// branch exactly (same id, same visible-text filtering, same timing and
// response state), minus all assistant content. The skeleton interaction
// id equals the id the full path assigns, so anchors survive
// materialization.
function skeletonTurnInteractions(
    turn: Record<string, any>,
    goalTurns?: ReadonlyMap<string, string>
): { interactions: ConversationInteraction[]; itemIds: string[] } {
    let userItem: Record<string, any> | undefined;
    let agentItemId: string | undefined;
    for (const rawItem of turn.items as unknown[]) {
        const item = asRecord(rawItem);
        if (!item
            || typeof item.id !== 'string'
            || !item.id
            || typeof item.type !== 'string') {
            throw protocolError();
        }
        if (item.type === 'userMessage' && !userItem) {
            userItem = item;
        } else if (item.type === 'agentMessage') {
            agentItemId = item.id;
        }
    }
    const itemIds = userItem
        ? (agentItemId ? [userItem.id as string, agentItemId]
            : [userItem.id as string])
        : (agentItemId ? [agentItemId] : []);
    if (!userItem) {
        // Goal-continuation turn: the app-server stripped its internal
        // user message, so project the same synthesized `/goal`
        // interaction the full path assigns (same id, same label) —
        // anchors then survive materialization.
        const objective = typeof turn.id === 'string'
            ? goalTurns?.get(turn.id)
            : undefined;
        if (objective) {
            const userMarkdown = visibleMessage(`/goal ${objective}`);
            return {
                interactions: [{
                    id: goalInteractionId(turn.id as string),
                    providerTurnId: turn.id,
                    ...turnTiming(turn),
                    userMarkdown,
                    userPreview: buildUserPreview(userMarkdown),
                    userGraphemeCount: countGraphemes(userMarkdown),
                    assistantMarkdown: [],
                    responseState: turnResponseState(turn.status),
                }],
                itemIds,
            };
        }
        return { interactions: [], itemIds };
    }
    if (!Array.isArray(userItem.content)) {
        throw protocolError();
    }
    const parts: VisibleUserInputPart[] = [];
    for (const rawPart of userItem.content) {
        const part = asRecord(rawPart);
        if (!part || typeof part.type !== 'string') {
            throw protocolError();
        }
        if (part.type === 'text') {
            if (typeof part.text !== 'string') {
                throw protocolError();
            }
            parts.push({ kind: 'text', text: part.text });
        } else if (part.type === 'image' || part.type === 'audio') {
            if (typeof part.url !== 'string') {
                throw protocolError();
            }
            parts.push({ kind: 'attachment' });
        } else if (part.type === 'localImage' || part.type === 'localAudio') {
            if (typeof part.path !== 'string') {
                throw protocolError();
            }
            parts.push({ kind: 'attachment' });
        }
    }
    const userMarkdown = visibleMessage(buildVisibleUserInput(parts));
    if (!userMarkdown) {
        return { interactions: [], itemIds };
    }
    return {
        interactions: [{
            id: userItem.id as string,
            providerTurnId: turn.id,
            ...turnTiming(turn),
            userMarkdown,
            userPreview: buildUserPreview(userMarkdown),
            userGraphemeCount: countGraphemes(userMarkdown),
            assistantMarkdown: [],
            responseState: turnResponseState(turn.status),
        }],
        itemIds,
    };
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
    private readonly materializationQueues = new Map<
        string,
        Promise<void>
    >();
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
        let working = loaded;
        const entry = this.loadedConversationCache.get(sessionId);
        if (entry?.revisionBasis === 'windowed' && entry.turns?.length) {
            const interactions = entry.value.interactions;
            const selectedId = preferredInteractionId
                && interactions.some(
                    interaction => interaction.id === preferredInteractionId
                )
                ? preferredInteractionId
                : interactions[interactions.length - 1]?.id;
            if (selectedId) {
                // The snapshot's page must never contain skeletons:
                // materialize around the selected interaction first.
                working = await this.materializeAround(
                    sessionId,
                    entry as CachedLoadedConversation
                        & { turns: LoadedConversationTurn[] },
                    selectedId,
                    'around',
                    signal
                ) ?? working;
            }
        }
        const outline = buildConversationOutline(
            'codex',
            sessionId,
            working.sourceRevision,
            working.interactions,
            false
        );
        const selected = outline.interactions.find(interaction =>
            interaction.id === preferredInteractionId
        ) || outline.interactions[outline.interactions.length - 1];
        if (!selected) {
            return { outline };
        }
        const pageRequest: ConversationPageRequest = {
            provider: 'codex',
            sessionId,
            anchorInteractionId: selected.id,
            direction: 'around',
            expectedRevision: working.sourceRevision,
            limit: CONVERSATION_LIMITS.maxPageInteractions,
        };
        const page = buildConversationPage(
            working.interactions,
            pageRequest,
            working.sourceRevision
        );
        return {
            outline,
            page: entry?.revisionBasis === 'windowed' && entry.turns?.length
                ? await this.ensurePageFreeOfSkeletons(
                    sessionId,
                    entry as CachedLoadedConversation
                        & { turns: LoadedConversationTurn[] },
                    page,
                    pageRequest,
                    signal
                )
                : page,
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
        let working = loaded;
        let expectedRevision = request.expectedRevision;
        const entry = this.loadedConversationCache.get(request.sessionId);
        if (entry?.revisionBasis === 'windowed' && entry.turns?.length) {
            const revisionBefore = entry.value.sourceRevision;
            working = await this.materializeAround(
                request.sessionId,
                entry as CachedLoadedConversation
                    & { turns: LoadedConversationTurn[] },
                request.anchorInteractionId,
                request.direction,
                signal,
                request.limit
            ) ?? working;
            if (entry.value.sourceRevision !== revisionBefore) {
                // Materialization changed the revision under the client's
                // expectation (a turn expanded its interaction-id set):
                // do not pin the expected revision — the coordinator
                // observes the new revision and settles its cursors.
                expectedRevision = undefined;
            }
        }
        const page = buildConversationPage(
            working.interactions,
            { ...request, provider: 'codex', expectedRevision },
            working.sourceRevision
        );
        if (entry?.revisionBasis === 'windowed' && entry.turns?.length) {
            return this.ensurePageFreeOfSkeletons(
                request.sessionId,
                entry as CachedLoadedConversation
                    & { turns: LoadedConversationTurn[] },
                page,
                { ...request, provider: 'codex' },
                signal
            );
        }
        return page;
    }

    // Materializes every skeleton chunk overlapping the page range around
    // an anchor interaction. Returns the up-to-date (lifecycle-applied)
    // conversation, or undefined when the anchor cannot be resolved — in
    // which case buildConversationPage produces the canonical
    // staleRevision.
    private async materializeAround(
        sessionId: string,
        entry: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        anchorInteractionId: string,
        direction: ConversationPageRequest['direction'],
        signal: ConversationAbortSignal | undefined,
        limit?: number
    ): Promise<LoadedConversation | undefined> {
        if (!entry.turns.some(chunk => chunk.kind === 'skeleton')) {
            return this.withRunningLifecycle(sessionId, entry.value);
        }
        const interactions = entry.value.interactions;
        const anchorIndex = interactions.findIndex(
            interaction => interaction.id === anchorInteractionId
        );
        if (anchorIndex < 0) {
            return undefined;
        }
        // Interaction index → chunk index (zero-interaction chunks never
        // contain the anchor and are skipped by the walk).
        let chunkIndex = 0;
        let remaining = anchorIndex;
        while (chunkIndex < entry.turns.length - 1
            && remaining >= entry.turns[chunkIndex].interactions.length) {
            remaining -= entry.turns[chunkIndex].interactions.length;
            chunkIndex += 1;
        }
        const pageLimit = Math.max(1, Math.min(
            CONVERSATION_LIMITS.maxPageInteractions,
            Math.floor(limit || CONVERSATION_LIMITS.maxPageInteractions)
        ));
        // Skeleton chunks hold at most one interaction, so an interaction
        // radius maps directly onto chunks; the margin absorbs full
        // chunks with several interactions.
        const margin = 5;
        let fromChunk: number;
        let toChunk: number;
        if (direction === 'before') {
            fromChunk = chunkIndex - 2 * pageLimit - margin;
            toChunk = chunkIndex - 1;
        } else if (direction === 'after') {
            fromChunk = chunkIndex + 1;
            toChunk = chunkIndex + 2 * pageLimit + margin;
        } else {
            fromChunk = chunkIndex - pageLimit - margin;
            toChunk = chunkIndex + pageLimit + margin;
        }
        await this.enqueueMaterialization(
            sessionId,
            entry,
            { fromChunk, toChunk },
            signal
        );
        // Serving a window keeps its full chunks alive for the LRU.
        const touchedAt = this.now();
        for (let index = Math.max(0, fromChunk);
            index <= Math.min(entry.turns.length - 1, toChunk);
            index += 1) {
            const chunk = entry.turns[index];
            if (chunk.kind === 'full') {
                chunk.lastTouchedAt = touchedAt;
            }
        }
        return this.withRunningLifecycle(sessionId, entry.value);
    }

    // Interaction ids still backed by skeleton chunks. Anything in this
    // set must never reach the webview (a skeleton renders as an empty
    // assistant response).
    private skeletonInteractionIds(
        turns: readonly LoadedConversationTurn[]
    ): Set<string> {
        const ids = new Set<string>();
        for (const chunk of turns) {
            if (chunk.kind === 'skeleton') {
                for (const interaction of chunk.interactions) {
                    ids.add(interaction.id);
                }
            }
        }
        return ids;
    }

    // Absolute backstop for the radius heuristic: if a built page still
    // references a skeleton-owned interaction (pathological expansion
    // shifts), materialize the whole skeleton set and rebuild the page
    // once. Correctness over laziness; expected to never run.
    private async ensurePageFreeOfSkeletons(
        sessionId: string,
        entry: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        page: ConversationPage,
        request: ConversationPageRequest,
        signal: ConversationAbortSignal | undefined
    ): Promise<ConversationPage> {
        const skeletonIds = this.skeletonInteractionIds(entry.turns);
        if (!skeletonIds.size
            || !page.interactionStates.some(
                state => skeletonIds.has(state.interactionId)
            )) {
            return page;
        }
        await this.enqueueMaterialization(
            sessionId,
            entry,
            { fromChunk: 0, toChunk: entry.turns.length - 1 },
            signal
        );
        const working = this.withRunningLifecycle(sessionId, entry.value);
        // The revision may have moved (expansions); do not pin the
        // request's expectation on the rebuild.
        return buildConversationPage(
            working.interactions,
            { ...request, provider: 'codex', expectedRevision: undefined },
            working.sourceRevision
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
            telemetry.context = this.applyProfileContextWindow(
                sessionId,
                rollout?.model,
                context
            );
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
                telemetry.context = this.applyProfileContextWindow(
                    sessionId,
                    rollout.model || telemetry.model,
                    rollout.context
                );
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
        this.materializationQueues.clear();
        this.subscriptions.clear();
        this.options.client.dispose();
    }

    private applyProfileContextWindow(
        sessionId: string,
        model: string | undefined,
        context: { usedTokens: number; maxTokens: number }
    ): { usedTokens: number; maxTokens: number } {
        const override = this.options.getSessionProfileContextWindow?.(sessionId, model);
        return typeof override === 'number'
            && Number.isSafeInteger(override)
            && override > 0
            ? { ...context, maxTokens: override }
            : { ...context };
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
        const context = this.applyProfileContextWindow(
            params.threadId,
            this.telemetryCache.get(params.threadId)?.value?.model,
            {
                usedTokens: Math.floor(last.totalTokens),
                maxTokens: Math.floor(usage.modelContextWindow),
            }
        );
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
                return Promise.resolve(
                    this.withRunningLifecycle(sessionId, cached.value)
                );
            }
            // A stale or unverifiable entry is released immediately rather
            // than lingering beside — or instead of — its replacement.
            this.deleteLoadedConversationCacheEntry(sessionId, cached);
        }
        const generation = this.conversationCacheGeneration;
        const startedAt = this.now();
        return this.loadConversation(sessionId, cached, signal, signature).then(outcome => {
            if (!this.disposed
                && generation === this.conversationCacheGeneration
                && signature !== undefined
                && (outcome.kind === 'incremental'
                    || outcome.kind === 'windowed'
                    || outcome.characters >= LARGE_CONVERSATION_CACHE_CHARS
                    || this.now() - startedAt
                        >= LARGE_CONVERSATION_CACHE_MIN_READ_MS)) {
                this.storeLoadedConversationCacheEntry(sessionId, {
                    value: outcome.value,
                    contentSignature: signature,
                    characters: outcome.characters,
                    lastTouchedAt: this.now(),
                    turns: outcome.turns,
                    revisionBasis: outcome.revisionBasis
                        ?? (outcome.kind === 'windowed'
                            ? 'windowed'
                            : (outcome.turns ? 'full' : undefined)),
                    structureGen: outcome.structureGen,
                    walkPages: outcome.walkPages,
                    walkNewerTurns: outcome.walkNewerTurns,
                    contentEpochSignature: outcome.contentEpochSignature,
                });
            }
            return this.withRunningLifecycle(sessionId, outcome.value);
        });
    }

    // The rollout lifecycle is external, time-varying state — never part of
    // the cached content. It is re-applied to the cached base interactions
    // on every read, so a stopped/started session reflects the current
    // signal even when the conversation bytes (and revision) are unchanged.
    private withRunningLifecycle(
        sessionId: string,
        value: LoadedConversation
    ): LoadedConversation {
        const split = splitSubagentSessionId(sessionId);
        if (split.subagentId || !value.interactions.length) {
            return value;
        }
        const interactions = this.promoteRunningLifecycle(
            split.sessionId,
            value.interactions
        );
        return interactions === value.interactions
            ? value
            : { interactions, sourceRevision: value.sourceRevision };
    }

    private async loadConversation(
        sessionId: string,
        stale: CachedLoadedConversation | undefined,
        signal: ConversationAbortSignal | undefined,
        signature: string | undefined
    ): Promise<LoadConversationOutcome & {
        kind: 'fresh' | 'incremental' | 'windowed';
    }> {
        const split = splitSubagentSessionId(sessionId);
        const windowedEntry = stale?.revisionBasis === 'windowed'
            && !!stale.turns?.length;
        if (stale?.turns?.length
            && !split.subagentId
            && this.paginatedReadsUsable()) {
            const incremental = await this.loadIncremental(
                sessionId,
                stale as CachedLoadedConversation
                    & { turns: LoadedConversationTurn[] },
                signal,
                signature
            );
            if (incremental && incremental.rebuild !== true) {
                return { ...incremental, kind: 'incremental' };
            }
            // A windowed entry never falls back to the full read: the
            // session's size may exceed the request timeout outright.
            // Anchor loss (compaction) or any incremental failure re-walks
            // the summary pages instead.
            if ((incremental?.rebuild === true) || windowedEntry) {
                const rebuilt = await this.loadWindowed(
                    sessionId,
                    signal,
                    true
                );
                if (rebuilt && rebuilt.legacy !== true) {
                    return { ...rebuilt, kind: 'windowed' };
                }
            }
        }
        if (!split.subagentId) {
            const windowed = await this.loadWindowed(sessionId, signal, false);
            if (windowed && windowed.legacy !== true) {
                return { ...windowed, kind: 'windowed' };
            }
            if (windowed?.legacy === true) {
                // Legacy replay backend: one full read beats per-page
                // replays. When the read cannot complete (timeout /
                // tooLarge), the slow walk is the only remaining path —
                // huge legacy sessions become openable (slowly) instead
                // of failing outright.
                try {
                    const fresh = await this.loadFresh(sessionId, signal);
                    return { ...fresh, kind: 'fresh' };
                } catch (error) {
                    if (error instanceof ConversationError
                        && (error.code === 'timeout'
                            || error.code === 'tooLarge')) {
                        const forced = await this.loadWindowed(
                            sessionId,
                            signal,
                            true
                        );
                        if (forced && forced.legacy !== true) {
                            return { ...forced, kind: 'windowed' };
                        }
                    }
                    throw error;
                }
            }
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
     * Reloads a cached root-thread conversation by paging the thread tail
     * through thread/turns/list. When the cached anchor turn survives, only
     * the turns from the anchor forward are re-normalized; when the (fast,
     * indexed) walk reaches the end of the thread without it, the whole
     * conversation is rebuilt from the fetched pages. Returns null — so the
     * caller falls back to a full thread/read — on slow (legacy replay)
     * backends, over-budget walks, anomalous pages, transient transport
     * errors ('unavailable'/'timeout'), or content the stable path would
     * equally reject. Method-level rejections and malformed pages
     * additionally disable the paginated path for the lifetime of this
     * adapter; transient errors do not.
     */
    private async loadIncremental(
        sessionId: string,
        cached: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        signal: ConversationAbortSignal | undefined,
        signature: string | undefined
    ): Promise<IncrementalLoadResult> {
        const isWindowed = cached.revisionBasis === 'windowed';
        const anchorTurnId = cached.turns[cached.turns.length - 1].turnId;
        const fetched: Record<string, any>[] = [];
        let cursor: string | undefined;
        let anchorIndex = -1;
        const walkStartedAt = this.now();
        let firstPageMs: number | undefined;
        for (;;) {
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
                if (error instanceof ConversationError
                    && (error.code === 'unavailable'
                        || error.code === 'timeout')) {
                    // Transient transport failure (child restart, an
                    // unrelated request timing out the shared child): fall
                    // back for this load without retiring the accelerator.
                    return null;
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
            if (firstPageMs === undefined) {
                firstPageMs = this.now() - walkStartedAt;
            }
            fetched.push(...pageTurns);
            anchorIndex = fetched.findIndex(turn => turn.id === anchorTurnId);
            if (anchorIndex >= 0) {
                break;
            }
            if (!nextCursor) {
                break;
            }
            if (pageTurns.length === 0) {
                // An empty page with a live cursor is outside the verified
                // pagination semantics: settle on the stable full read
                // rather than rebuilding from a possibly truncated walk.
                return null;
            }
            if (firstPageMs >= PAGINATED_READ_SLOW_PAGE_MS) {
                return null;
            }
            if (isWindowed
                && anchorIndex < 0
                && fetched.length >= 3 * PAGINATED_READ_PAGE_SIZE) {
                // The anchor is the tail turn: absent from the first pages,
                // the tail was rewritten (compaction). Rebuild through a
                // fresh summary walk — rebuilding a huge windowed entry
                // from full pages would defeat the whole design.
                return { rebuild: true };
            }
            if (fetched.length >= PAGINATED_READ_WALK_TURN_LIMIT
                || this.now() - walkStartedAt
                    >= PAGINATED_READ_WALK_BUDGET_MS) {
                return isWindowed ? { rebuild: true } : null;
            }
            cursor = nextCursor;
        }
        // `fetched` is newest-first. When the anchor survived, only the
        // turns from the anchor forward are re-normalized (the anchor may
        // have grown since it was cached). When the walk ran to the end of
        // the thread without it, the tail was rewritten
        // (compaction/rollback): windowed entries rebuild through a fresh
        // summary walk, while full entries rebuild every chunk from the
        // fetched pages — the paginated backend serves them cheaply, and
        // a full thread/read of a huge paginated session would exceed the
        // request timeout outright.
        if (anchorIndex < 0 && isWindowed) {
            return { rebuild: true };
        }
        // Windowed freshness closure: a moved stat means any materialized
        // chunk the anchor walk does not re-verify can hold stale content
        // (in-place history edits exist: updated_at_ordinal). Demote kept
        // full chunks back to skeletons — they re-materialize live before
        // they are shown again. The anchor chunk itself is re-fetched
        // below, so it is never demoted here. Full-basis entries keep
        // their exact previous behavior.
        let demotedMaterialized = false;
        let demotionShrunkIdSets = false;
        let kept = anchorIndex >= 0 ? cached.turns.slice(0, -1) : [];
        if (isWindowed && anchorIndex >= 0) {
            kept = kept.map(chunk => {
                if (chunk.kind !== 'full') {
                    return chunk;
                }
                demotedMaterialized = true;
                const demotedChunk = demoteToSkeleton(chunk);
                if (demotedChunk.interactions.length
                    !== chunk.interactions.length) {
                    demotionShrunkIdSets = true;
                }
                return demotedChunk;
            });
        }
        const reloaded = (anchorIndex >= 0
            ? fetched.slice(0, anchorIndex + 1)
            : fetched
        ).reverse();
        const turns = this.normalizeReloadedTurns(
            kept,
            reloaded,
            this.goalTurns(sessionId)
        );
        if (!turns) {
            return null;
        }
        if (isWindowed) {
            // Projection revision: unchanged when neither the outline-level
            // turn structure nor any materialized chunk's content moved.
            // Any demotion counts as a change: demoted content was not
            // re-verified, so the revision must move and let the viewer
            // re-read visible pages (they re-materialize fresh).
            let unchanged = !demotedMaterialized
                && turns.length === cached.turns.length;
            for (let index = 0; unchanged && index < turns.length; index += 1) {
                const next = turns[index];
                const prev = cached.turns[index];
                unchanged = next.summaryFingerprint === prev.summaryFingerprint
                    && (next.kind === 'skeleton'
                        ? prev.kind === 'skeleton'
                        : next.fingerprint === prev.fingerprint);
            }
            if (unchanged) {
                return {
                    value: cached.value,
                    turns: cached.turns,
                    characters: cached.characters,
                    revisionBasis: 'windowed',
                    structureGen: cached.structureGen,
                    walkPages: cached.walkPages,
                    walkNewerTurns: cached.walkNewerTurns,
                    contentEpochSignature: cached.contentEpochSignature,
                };
            }
            const structureGen = (cached.structureGen ?? 0)
                + (demotionShrunkIdSets ? 1 : 0);
            const epochSignature = signature
                ?? cached.contentEpochSignature
                ?? '';
            const sourceRevision = composeWindowedRevision(
                epochSignature,
                turns,
                structureGen
            );
            const characters = turns.reduce(
                (sum, turn) => sum + turn.characters,
                0
            );
            const interactions = turns.reduce<ConversationInteraction[]>(
                (all, turn) => all.concat(turn.interactions),
                []
            );
            return {
                value: { interactions, sourceRevision },
                turns,
                characters,
                revisionBasis: 'windowed',
                structureGen,
                walkPages: cached.walkPages,
                // Anchor reloads replace the tail in place; every turn
                // beyond the cached length is new since the walk.
                walkNewerTurns: (cached.walkNewerTurns ?? 0)
                    + Math.max(0, turns.length - cached.turns.length),
                contentEpochSignature: epochSignature,
            };
        }
        const sourceRevision = composeConversationRevision(turns);
        const characters = turns.reduce(
            (sum, turn) => sum + turn.characters,
            0
        );
        if (sourceRevision === cached.value.sourceRevision) {
            // The stat moved but the visible content did not: keep the
            // cached value (its identity is pinned to the revision) and its
            // chunks (their interactions share the value's objects), and
            // let the caller re-anchor the entry to the new signature.
            return {
                value: cached.value,
                turns: cached.turns,
                characters: cached.characters,
            };
        }
        const interactions = turns.reduce<ConversationInteraction[]>(
            (all, turn) => all.concat(turn.interactions),
            []
        );
        return { value: { interactions, sourceRevision }, turns, characters };
    }

    // Normalizes re-fetched turns (chronological) on top of the kept cached
    // chunks, preserving the full read's thread-wide turn-id and item-id
    // invariants. Returns null when the content conflicts with the kept
    // history or would equally fail the stable path, so the caller falls
    // back to a full read that settles (or canonically rejects) it.
    private normalizeReloadedTurns(
        kept: LoadedConversationTurn[],
        reloaded: Record<string, any>[],
        goalTurns?: ReadonlyMap<string, string>
    ): LoadedConversationTurn[] | null {
        const itemIds = new Set<string>();
        for (const chunk of kept) {
            for (const itemId of chunk.itemIds) {
                itemIds.add(itemId);
            }
        }
        const knownTurnIds = new Set(kept.map(chunk => chunk.turnId));
        const rebuilt: LoadedConversationTurn[] = [];
        try {
            for (const turn of reloaded) {
                if (knownTurnIds.has(turn.id)) {
                    return null;
                }
                knownTurnIds.add(turn.id);
                const context: NormalizeTurnContext = {
                    interactions: [],
                    itemIds,
                    newItemIds: [],
                    seededDispatchTimingComplete: true,
                    goalTurns,
                };
                normalizeTurnItems(turn, context);
                rebuilt.push({
                    turnId: turn.id,
                    interactions: context.interactions,
                    itemIds: context.newItemIds,
                    fingerprint: fingerprintInteractions(context.interactions),
                    summaryFingerprint: turnSummaryFingerprint(turn),
                    skeletonItemIds: skeletonTurnInteractions(
                        turn,
                        goalTurns
                    ).itemIds,
                    characters: conversationCharacters(context.interactions),
                    kind: 'full' as const,
                    lastTouchedAt: this.now(),
                });
            }
        } catch (_error) {
            return null;
        }
        return [...kept, ...rebuilt];
    }

    /**
     * Windowed cold start (spikes/codex-cold-start): lists every turn as a
     * summary skeleton (flat ~tens-of-ms pages on the indexed paginated
     * backend), then materializes full items only for the tail window.
     * Older turns materialize on demand through readPage/readSnapshot.
     *
     * Returns null when the path is gated (unverified server version, no
     * content signature, small rollout, transient transport failure) — the
     * caller then uses the stable full thread/read. A `{legacy: true}`
     * verdict means both first summary pages cost a full replay each, so a
     * single full read is cheaper; `force` skips that verdict (used when
     * the full read already failed, or when re-walking a windowed entry).
     * Method-level rejections and malformed pages disable the paginated
     * path for the lifetime of this adapter.
     */
    private async loadWindowed(
        sessionId: string,
        signal: ConversationAbortSignal | undefined,
        force: boolean
    ): Promise<WindowedLoadResult> {
        // One retry against a source that moved mid-load: the closure
        // checks in the attempt reject mixed-epoch entries, and the
        // retry simply re-walks under a fresh signature.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await this.loadWindowedAttempt(
                sessionId,
                signal,
                force
            );
            if (result !== 'stale') {
                return result;
            }
        }
        return null;
    }

    private async loadWindowedAttempt(
        sessionId: string,
        signal: ConversationAbortSignal | undefined,
        force: boolean
    ): Promise<WindowedLoadResult | 'stale'> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        if (this.paginatedReadsDisabled) {
            return null;
        }
        const client = this.options.client;
        if (typeof client.ensureReady !== 'function'
            || typeof this.options.readSourceBytes !== 'function') {
            return null;
        }
        // The handshake MUST complete before version gating: the version
        // is unknown until initialize returns, and its cost must not
        // contaminate the per-page latency the legacy verdict relies on.
        let version: string | undefined;
        try {
            version = await client.ensureReady(signal);
        } catch (error) {
            if (error instanceof ConversationAbortError
                || error?.name === 'AbortError') {
                throw error;
            }
            if (this.disposed) {
                throw new ConversationError('unavailable', 'reconnectingCodex');
            }
            return null;
        }
        if (version === undefined
            || !PAGINATED_READ_SERVER_VERSIONS.has(version)) {
            return null;
        }
        const sourceBytes = this.options.readSourceBytes(sessionId);
        if (sourceBytes === undefined
            || sourceBytes < COLD_START_WINDOW_MIN_SOURCE_BYTES) {
            return null;
        }
        // No content signature, no windowing: the revision's content epoch
        // and every commit rule below depend on it.
        const signature = this.contentSignature(sessionId);
        if (signature === undefined) {
            return null;
        }

        // Summary walk, newest first. Every page boundary cursor is
        // recorded so any walk page can later be re-fetched in full view.
        const pages: {
            turns: Record<string, any>[];
            nextCursor?: string;
            startCursor?: string;
        }[] = [];
        let cursor: string | undefined;
        const walkStartedAt = this.now();
        const recentPageMs: number[] = [];
        for (;;) {
            if (pages.length >= COLD_START_MAX_WALK_PAGES
                || this.now() - walkStartedAt >= COLD_START_MAX_WALK_MS) {
                // Runaway safety valve (resource bound, not a heuristic):
                // a paginated backend serves flat fast pages, so this can
                // only trip on server-side pathology.
                throw new ConversationError('tooLarge');
            }
            const pageStartedAt = this.now();
            let page: unknown;
            try {
                page = await client.request('thread/turns/list', {
                    threadId: sessionId,
                    cursor,
                    limit: COLD_START_SUMMARY_PAGE_TURNS,
                    sortDirection: 'desc',
                    itemsView: 'summary',
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
                if (error instanceof ConversationError
                    && (error.code === 'unavailable'
                        || error.code === 'timeout')) {
                    return null;
                }
                this.paginatedReadsDisabled = true;
                return null;
            }
            const pageMs = this.now() - pageStartedAt;
            let parsed: ReturnType<typeof parseTurnsListPage>;
            try {
                parsed = parseTurnsListPage(page);
            } catch (_error) {
                this.paginatedReadsDisabled = true;
                return null;
            }
            pages.push({
                turns: parsed.turns,
                nextCursor: parsed.nextCursor,
                startCursor: cursor,
            });
            recentPageMs.push(pageMs);
            // Legacy verdict: the median of the recent pages (up to 3,
            // at least 2 — a two-page window takes the SMALLER, i.e.
            // both pages must be slow) costs a full replay each. A fast
            // first page followed by sustained replay pricing verdicts
            // on page three; a single jittery page never does.
            if (!force && recentPageMs.length >= 2) {
                const windowMs = recentPageMs.slice(-3).sort((a, b) => a - b);
                if (windowMs[Math.floor((windowMs.length - 1) / 2)]
                    >= COLD_START_SLOW_PAGE_MS) {
                    return { legacy: true };
                }
            }
            if (!parsed.nextCursor) {
                break;
            }
            if (parsed.turns.length === 0) {
                // Empty page with a live cursor: outside the verified
                // pagination semantics — settle on the stable full read.
                this.paginatedReadsDisabled = true;
                return null;
            }
            cursor = parsed.nextCursor;
        }
        // Walk closure: the stat signature must still be the one the walk
        // started under, or the skeleton set mixes epochs.
        if (this.contentSignature(sessionId) !== signature) {
            return 'stale';
        }

        // Skeleton chunks in chronological order. Summary item ids join
        // the thread-wide duplicate-item invariant from the start.
        const chunks: LoadedConversationTurn[] = [];
        const itemIds = new Set<string>();
        const turnIds = new Set<string>();
        const goalTurns = this.goalTurns(sessionId);
        try {
            for (let pageIndex = pages.length - 1; pageIndex >= 0; pageIndex -= 1) {
                const pageTurns = pages[pageIndex].turns;
                for (let index = pageTurns.length - 1; index >= 0; index -= 1) {
                    const turn = pageTurns[index];
                    if (turnIds.has(turn.id)) {
                        throw protocolError();
                    }
                    turnIds.add(turn.id);
                    const skeleton = skeletonTurnInteractions(turn, goalTurns);
                    for (const itemId of skeleton.itemIds) {
                        if (itemIds.has(itemId)) {
                            throw protocolError();
                        }
                        itemIds.add(itemId);
                    }
                    chunks.push({
                        turnId: turn.id,
                        kind: 'skeleton',
                        interactions: skeleton.interactions,
                        itemIds: skeleton.itemIds,
                        fingerprint: '',
                        summaryFingerprint: turnSummaryFingerprint(turn),
                        skeletonItemIds: [...skeleton.itemIds],
                        characters: conversationCharacters(
                            skeleton.interactions
                        ),
                    });
                }
            }
        } catch (_error) {
            this.paginatedReadsDisabled = true;
            return null;
        }

        // Eagerly materialize the tail window (~one retained viewer page
        // set) so the initial snapshot needs no second round trip. Every
        // landed page is checked against the walk's signature.
        const tail = await this.materializeTailWindow(
            sessionId,
            chunks,
            itemIds,
            signal,
            signature,
            goalTurns
        );
        if (tail === 'stale') {
            return 'stale';
        }
        if (!tail) {
            return null;
        }
        if (this.contentSignature(sessionId) !== signature) {
            return 'stale';
        }
        const structureGen = 0;
        const sourceRevision = composeWindowedRevision(
            signature,
            chunks,
            structureGen
        );
        const interactions = chunks.reduce<ConversationInteraction[]>(
            (all, chunk) => all.concat(chunk.interactions),
            []
        );
        return {
            value: { interactions, sourceRevision },
            turns: chunks,
            characters: chunks.reduce((sum, chunk) => sum + chunk.characters, 0),
            structureGen,
            walkPages: pages.map(page => ({
                startCursor: page.startCursor,
                turnCount: page.turns.length,
            })),
            walkNewerTurns: 0,
            contentEpochSignature: signature,
        };
    }

    // One thread/turns/list page with the failure taxonomy shared by every
    // paginated call: abort/disposal propagate, transient transport
    // failures return null for a one-off fallback, and method-level
    // rejections or malformed pages retire the accelerator.
    private async requestTurnsPage(
        params: Record<string, unknown>,
        signal: ConversationAbortSignal | undefined
    ): Promise<{ turns: Record<string, any>[]; nextCursor?: string } | null> {
        let page: unknown;
        try {
            page = await this.options.client.request(
                'thread/turns/list',
                params,
                signal
            );
        } catch (error) {
            if (error instanceof ConversationAbortError
                || error?.name === 'AbortError') {
                throw error;
            }
            if (this.disposed) {
                throw new ConversationError('unavailable', 'reconnectingCodex');
            }
            if (error instanceof ConversationError
                && (error.code === 'unavailable'
                    || error.code === 'timeout')) {
                return null;
            }
            this.paginatedReadsDisabled = true;
            return null;
        }
        try {
            return parseTurnsListPage(page);
        } catch (_error) {
            this.paginatedReadsDisabled = true;
            return null;
        }
    }

    // Normalizes one full-view turn over the skeleton chunk of the same
    // turn id and commits it as a full chunk. The thread-wide item-id
    // invariant is preserved: the turn's items are checked against every
    // other chunk's ids (the replaced skeleton's own two summary ids are
    // an expected subset of the full turn and are exempted). Returns
    // 'skipped' for turns the walk never saw or already-full chunks, and
    // 'expanded' when the full turn's interaction-id set differs from the
    // skeleton's prediction (a multi-user-message turn).
    private commitFullTurn(
        chunks: LoadedConversationTurn[],
        chunkIndexByTurnId: Map<string, number>,
        itemIds: Set<string>,
        turn: Record<string, any>,
        goalTurns?: ReadonlyMap<string, string>
    ): 'committed' | 'skipped' | 'expanded' {
        const index = chunkIndexByTurnId.get(turn.id);
        if (index === undefined) {
            return 'skipped';
        }
        const existing = chunks[index];
        if (existing.kind === 'full') {
            return 'skipped';
        }
        const ownIds = new Set(existing.itemIds);
        // A response-spanning item can be projected into different turns
        // by fetches taken at different times (observed on a live 183MB
        // session: a reasoning item shared between turns 90 and 218).
        // Colliding with another chunk's ids means the fetched page and
        // the cached skeleton set come from different projection epochs —
        // NOT a protocol violation. Report it as staleness so the caller
        // re-reads a consistent snapshot, never circuit-breaking the
        // accelerator on a transient.
        for (const rawItem of turn.items as unknown[]) {
            const item = asRecord(rawItem);
            if (item
                && typeof item.id === 'string'
                && item.id
                && itemIds.has(item.id)
                && !ownIds.has(item.id)) {
                throw new ConversationError('staleRevision');
            }
        }
        const context: NormalizeTurnContext = {
            interactions: [],
            itemIds: new Set(
                [...itemIds].filter(itemId => !ownIds.has(itemId))
            ),
            newItemIds: [],
            seededDispatchTimingComplete: true,
            goalTurns,
        };
        normalizeTurnItems(turn, context);
        for (const itemId of context.newItemIds) {
            itemIds.add(itemId);
        }
        chunks[index] = {
            turnId: turn.id,
            kind: 'full',
            interactions: context.interactions,
            itemIds: context.newItemIds,
            fingerprint: fingerprintInteractions(context.interactions),
            // A mismatch with the skeleton's fingerprint means the source
            // moved mid-load; taking the fresh one is safe because the
            // stat signature check reconciles the entry on the next load.
            summaryFingerprint: turnSummaryFingerprint(turn),
            skeletonItemIds: [...existing.skeletonItemIds],
            characters: conversationCharacters(context.interactions),
            lastTouchedAt: this.now(),
        };
        const predicted = existing.interactions.map(interaction => interaction.id);
        const actual = context.interactions.map(interaction => interaction.id);
        const expanded = predicted.length !== actual.length
            || actual.some((id, position) => predicted[position] !== id);
        return expanded ? 'expanded' : 'committed';
    }

    // Fetches full turns descending from the tail and commits them until
    // the turn/byte budget is exhausted. Returns false on transient
    // failure (caller falls back) and 'stale' when the source moved
    // under the walk's signature mid-flight.
    private async materializeTailWindow(
        sessionId: string,
        chunks: LoadedConversationTurn[],
        itemIds: Set<string>,
        signal: ConversationAbortSignal | undefined,
        signature: string,
        goalTurns?: ReadonlyMap<string, string>
    ): Promise<boolean | 'stale'> {
        const chunkIndexByTurnId = new Map(
            chunks.map((chunk, index) => [chunk.turnId, index] as const)
        );
        let cursor: string | undefined;
        let fetchedTurns = 0;
        let fetchedBytes = 0;
        for (;;) {
            const parsed = await this.requestTurnsPage({
                threadId: sessionId,
                cursor,
                limit: COLD_START_MATERIALIZE_PAGE_TURNS,
                sortDirection: 'desc',
                itemsView: 'full',
            }, signal);
            if (!parsed) {
                return false;
            }
            if (this.contentSignature(sessionId) !== signature) {
                return 'stale';
            }
            if (parsed.turns.length === 0) {
                return true;
            }
            try {
                for (const turn of parsed.turns) {
                    fetchedBytes += JSON.stringify(turn).length;
                    fetchedTurns += 1;
                    this.commitFullTurn(
                        chunks,
                        chunkIndexByTurnId,
                        itemIds,
                        turn,
                        goalTurns
                    );
                }
            } catch (error) {
                if (error instanceof ConversationError
                    && error.code === 'staleRevision') {
                    // Mixed projection epochs; the wrapper re-walks once.
                    return 'stale';
                }
                this.paginatedReadsDisabled = true;
                return false;
            }
            if (!parsed.nextCursor
                || fetchedTurns >= COLD_START_TAIL_TURNS
                || fetchedBytes >= COLD_START_TAIL_BYTES) {
                return true;
            }
            cursor = parsed.nextCursor;
        }
    }

    // Serialized on-demand materialization for readPage/readSnapshot.
    // Requests for one session queue up; a request re-checks coverage
    // when it acquires the queue (earlier requests may have covered its
    // range), and each fetched page commits only while the entry still
    // matches its load-time stat signature and cache slot — a session-
    // scoped validity rule that needs no global generation.
    private enqueueMaterialization(
        sessionId: string,
        entry: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        range: { fromChunk: number; toChunk: number },
        signal: ConversationAbortSignal | undefined
    ): Promise<void> {
        const previous = this.materializationQueues.get(sessionId)
            ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() =>
            this.runMaterialization(sessionId, entry, range, signal));
        this.materializationQueues.set(sessionId, next);
        const cleanup = () => {
            if (this.materializationQueues.get(sessionId) === next) {
                this.materializationQueues.delete(sessionId);
            }
        };
        next.then(cleanup, cleanup);
        return next;
    }

    private async runMaterialization(
        sessionId: string,
        entry: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        range: { fromChunk: number; toChunk: number },
        signal: ConversationAbortSignal | undefined
    ): Promise<void> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        if (signal?.aborted) {
            throw new ConversationAbortError();
        }
        const chunks = entry.turns;
        const walkPages = entry.walkPages ?? [];
        if (!walkPages.length) {
            return;
        }
        const from = Math.max(0, range.fromChunk);
        const to = Math.min(chunks.length - 1, range.toChunk);
        const targets: number[] = [];
        for (let index = from; index <= to; index += 1) {
            if (chunks[index].kind === 'skeleton') {
                targets.push(index);
            }
        }
        if (!targets.length) {
            return;
        }
        const chunkIndexByTurnId = new Map(
            chunks.map((chunk, index) => [chunk.turnId, index] as const)
        );
        // Maps a chunk index to its summary walk page (page 0 = newest).
        // Turns appended after the walk shift the newest-first index, so
        // rebase by their count; they are full chunks themselves and can
        // never be skeleton targets.
        const walkNewerTurns = entry.walkNewerTurns ?? 0;
        const pageOfChunk = (chunkIndex: number): number => {
            let descIndex = chunks.length - 1 - chunkIndex - walkNewerTurns;
            let page = 0;
            while (page < walkPages.length - 1
                && descIndex >= walkPages[page].turnCount) {
                descIndex -= walkPages[page].turnCount;
                page += 1;
            }
            return page;
        };
        // Group target chunks by their walk page.
        const targetsByPage = new Map<number, number[]>();
        for (const chunkIndex of targets) {
            const page = pageOfChunk(chunkIndex);
            const list = targetsByPage.get(page) ?? [];
            list.push(chunkIndex);
            targetsByPage.set(page, list);
        }
        const itemIds = new Set<string>();
        for (const chunk of chunks) {
            for (const itemId of chunk.itemIds) {
                itemIds.add(itemId);
            }
        }
        for (const [page, pageTargets] of targetsByPage) {
            let covered = new Set(
                pageTargets.filter(index => chunks[index].kind === 'full')
            );
            let cursor = walkPages[page].startCursor;
            while (covered.size < pageTargets.length) {
                if (signal?.aborted) {
                    throw new ConversationAbortError();
                }
                // Commit rule, checked per page BEFORE the fetch and
                // again AFTER the page lands: the adapter must be alive,
                // and the entry must still sit in its cache slot under
                // its load-time signature. The source moving mid-flight
                // must never see its content committed under the old
                // epoch.
                if (this.disposed) {
                    throw new ConversationError(
                        'unavailable',
                        'reconnectingCodex'
                    );
                }
                if (this.loadedConversationCache.get(sessionId) !== entry
                    || this.contentSignature(sessionId)
                        !== entry.contentSignature) {
                    throw new ConversationError('staleRevision');
                }
                const parsed = await this.requestTurnsPage({
                    threadId: sessionId,
                    cursor,
                    limit: COLD_START_MATERIALIZE_PAGE_TURNS,
                    sortDirection: 'desc',
                    itemsView: 'full',
                }, signal);
                if (!parsed) {
                    throw new ConversationError('unavailable', 'missingSource');
                }
                if (this.disposed) {
                    throw new ConversationError(
                        'unavailable',
                        'reconnectingCodex'
                    );
                }
                if (this.loadedConversationCache.get(sessionId) !== entry
                    || this.contentSignature(sessionId)
                        !== entry.contentSignature) {
                    throw new ConversationError('staleRevision');
                }
                if (parsed.turns.length === 0) {
                    throw new ConversationError('staleRevision');
                }
                let expanded = false;
                try {
                    for (const turn of parsed.turns) {
                        if (this.commitFullTurn(
                            chunks,
                            chunkIndexByTurnId,
                            itemIds,
                            turn,
                            this.goalTurns(sessionId)
                        ) === 'expanded') {
                            expanded = true;
                        }
                    }
                } catch (error) {
                    if (error instanceof ConversationError
                        && error.code === 'staleRevision') {
                        // Mixed projection epochs: drop the entry so the
                        // next read re-walks a consistent snapshot. The
                        // accelerator survives.
                        this.deleteLoadedConversationCacheEntry(
                            sessionId,
                            entry
                        );
                        throw error;
                    }
                    this.paginatedReadsDisabled = true;
                    throw error instanceof ConversationError
                        ? error
                        : protocolError();
                }
                covered = new Set(
                    pageTargets.filter(index => chunks[index].kind === 'full')
                );
                this.commitMaterializedEntry(entry, expanded, from, to);
                if (!parsed.nextCursor) {
                    break;
                }
                cursor = parsed.nextCursor;
            }
        }
    }

    // Rebuilds a windowed entry's flat interaction array and revision
    // after one materialization page, keeps the character accounting in
    // sync, and enforces the per-entry materialized-window budget: the
    // least-recently-touched full chunks outside the protected ranges
    // (the served range and the tail window zone) demote back to
    // skeletons, so long browsing cannot re-inflate the entry toward the
    // whole conversation.
    private commitMaterializedEntry(
        entry: CachedLoadedConversation
            & { turns: LoadedConversationTurn[] },
        expanded: boolean,
        protectFrom: number,
        protectTo: number
    ): void {
        let characters = entry.turns.reduce(
            (sum, chunk) => sum + chunk.characters,
            0
        );
        this.loadedConversationCacheChars += characters - entry.characters;
        entry.characters = characters;
        if (expanded) {
            entry.structureGen = (entry.structureGen ?? 0) + 1;
        }
        if (characters > WINDOWED_ENTRY_MATERIALIZED_CHARS) {
            const tailFrom = Math.max(
                0,
                entry.turns.length - COLD_START_TAIL_TURNS
            );
            const candidates: number[] = [];
            for (let index = 0; index < entry.turns.length; index += 1) {
                if (index >= tailFrom
                    || (index >= protectFrom && index <= protectTo)) {
                    continue;
                }
                if (entry.turns[index].kind === 'full') {
                    candidates.push(index);
                }
            }
            candidates.sort((left, right) =>
                (entry.turns[left].lastTouchedAt ?? 0)
                - (entry.turns[right].lastTouchedAt ?? 0));
            let shrunkIdSets = false;
            for (const index of candidates) {
                if (entry.characters <= WINDOWED_ENTRY_MATERIALIZED_CHARS) {
                    break;
                }
                const before = entry.turns[index];
                const demoted = demoteToSkeleton(before);
                if (demoted.interactions.length
                    !== before.interactions.length) {
                    shrunkIdSets = true;
                }
                entry.turns[index] = demoted;
                entry.characters -= before.characters - demoted.characters;
                this.loadedConversationCacheChars -= before.characters
                    - demoted.characters;
            }
            if (shrunkIdSets) {
                entry.structureGen = (entry.structureGen ?? 0) + 1;
            }
        }
        const sourceRevision = composeWindowedRevision(
            entry.contentEpochSignature ?? entry.contentSignature,
            entry.turns,
            entry.structureGen ?? 0
        );
        entry.value = {
            interactions: entry.turns.reduce<ConversationInteraction[]>(
                (all, chunk) => all.concat(chunk.interactions),
                []
            ),
            sourceRevision,
        };
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
            normalized = normalizeThreadRead(
                result,
                threadId,
                dispatch,
                split.subagentId ? undefined : this.goalTurns(sessionId)
            );
        } catch (error) {
            if (error instanceof ConversationError) {
                throw error;
            }
            throw protocolError();
        }
        const turns: LoadedConversationTurn[] = normalized.turns.map(chunk => ({
            ...chunk,
            fingerprint: fingerprintInteractions(chunk.interactions),
            // Full-read entries compose the revision from full
            // fingerprints only; the summary projection is not tracked
            // and full-basis chunks are never demoted.
            summaryFingerprint: '',
            skeletonItemIds: [],
            characters: conversationCharacters(chunk.interactions),
            kind: 'full' as const,
        }));
        // App Server instances do not share live turn state. When another
        // extension owns the running turn, thread/read can persist it as
        // interrupted even while its rollout is still receiving events.
        // Keep the protocol fingerprint content-only, then let the rollout's
        // authoritative lifecycle promote the latest visible interaction.
        const sourceRevision = composeConversationRevision(turns);
        return {
            value: { interactions: normalized.interactions, sourceRevision },
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

    // Best-effort rollout probe; goal labels must never block readability.
    private goalTurns(
        sessionId: string
    ): ReadonlyMap<string, string> | undefined {
        try {
            return this.options.readGoalTurns?.(sessionId);
        } catch (_error) {
            return undefined;
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
