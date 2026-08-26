'use strict';

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
    boundQuestionItems,
    boundQuestionOptions,
    splitSettledAnswers,
} from './questions';
import { synthesizeFragmentDiff } from './diffs';
import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationCacheDiagnostics,
    ConversationError,
    ConversationFileDiff,
    ConversationHistoryRestartPoint,
    ConversationHistoryRestartSnapshot,
    ConversationInteraction,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationProviderAdapter,
    ConversationQuestionBlock,
    ConversationQuestionItem,
    ConversationSnapshot,
    ConversationSubagentEntry,
    ConversationTelemetry,
} from './types';
import {
    openValidatedConversationSource,
    OpenConversationSource,
} from './source';
import { appendConversationHistoryRestartPoint } from './historyRestartPoints';
import {
    isSubagentId,
    splitSubagentSessionId,
} from './subagentSessions';
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

// Claude Code JSONL records the resolved model but not its context-window
// size. Opus and Sonnet moved to a 1M default in 4.6; generation 5 frontier
// models also use 1M. Older models, including Haiku 4.5, retain 200k.
const CLAUDE_LEGACY_MAX_CONTEXT_TOKENS = 200_000;
const CLAUDE_LONG_MAX_CONTEXT_TOKENS = 1_000_000;

const MAX_LISTED_SUBAGENTS = 64;
const SUBAGENT_TRANSCRIPT_PATTERN = /^agent-([0-9a-z][0-9a-z-]{0,63})\.jsonl$/i;
const SUBAGENT_RUNNING_FRESHNESS_MS = 5 * 60 * 1000;
// A single record can exceed 200KB (large tool results); the read window
// must hold one full record plus the partial line cut by the window edge.
const SUBAGENT_RECORD_WINDOW_BYTES = 512 * 1024;

interface ClaudeConversationIndex extends AiSessionDisposable {
    source: OpenConversationSource;
    nextOffset: number;
    interactions: ConversationInteraction[];
    restartPoints: ConversationHistoryRestartPoint[];
    appendInteractionIndex?: number;
    telemetryModel?: string;
    telemetryContext?: ConversationContextUsage;
    telemetryCwd?: string;
    telemetryGitBranch?: string;
    toolTracker?: ToolCallTracker;
    /** tool_use id → question block, for tool_result answer pairing. */
    questionTracker?: Map<string, ConversationQuestionBlock>;
    /** Whether the most recent load read incrementally from the cache. */
    lastReadContinuation: boolean;
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

// A subagent resumed via SendMessage receives its follow-up instruction as
// a coordinator-authored user record; inside a subagent transcript that
// record is the dispatch turn of the next round and must stay visible.
function isCoordinatorDispatch(event: Record<string, any>): boolean {
    return asRecord(event.origin)?.kind === 'coordinator';
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

function maxContextTokens(model: string | undefined): number {
    const normalized = model?.trim().toLowerCase() ?? '';
    if (/(?:^|[.:/])claude-(?:(?:opus-4-(?:6|7|8))|sonnet-4-6|(?:fable|mythos|opus|sonnet)-5|mythos-preview)(?:-|$)/
        .test(normalized)) {
        return CLAUDE_LONG_MAX_CONTEXT_TOKENS;
    }
    return CLAUDE_LEGACY_MAX_CONTEXT_TOKENS;
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
        ...(interaction.assistantPhases
            ? { assistantPhases: interaction.assistantPhases.slice() }
            : {}),
        ...(interaction.toolCalls
            ? { toolCalls: interaction.toolCalls.slice() }
            : {}),
        ...(interaction.thinking
            ? { thinking: interaction.thinking.slice() }
            : {}),
        // Shares block objects with the previous load on purpose (same
        // pattern as toolCalls) so tracker references stay valid across
        // incremental loads when settlements mutate them.
        ...(interaction.plans
            ? { plans: interaction.plans.slice() }
            : {}),
        ...(interaction.questions
            ? { questions: interaction.questions.slice() }
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

function claudeQuestionItems(
    input: Record<string, any> | undefined
): ConversationQuestionItem[] {
    const rawQuestions = input?.questions;
    if (!Array.isArray(rawQuestions)) {
        return [];
    }
    return boundQuestionItems(rawQuestions.map(raw => {
        const record = asRecord(raw);
        return {
            question: typeof record?.question === 'string'
                ? record.question
                : '',
            ...(typeof record?.header === 'string'
                ? { header: record.header }
                : {}),
            options: boundQuestionOptions(record?.options),
            multiSelect: record?.multiSelect === true,
        };
    }));
}

/**
 * Synthesizes fragment diffs for Claude edit tools. Shapes probed from real
 * transcripts: Edit carries file_path/old_string/new_string, Write carries
 * file_path/content. Returns undefined for any other shape so the caller
 * keeps the generic raw-JSON rendering.
 */
function claudeToolDiffs(
    name: string,
    input: Record<string, any> | undefined
): ConversationFileDiff[] | undefined {
    if (!input
        || typeof input.file_path !== 'string'
        || !input.file_path) {
        return undefined;
    }
    if (name === 'Edit'
        && typeof input.old_string === 'string'
        && typeof input.new_string === 'string') {
        return [synthesizeFragmentDiff(
            input.file_path,
            'update',
            input.old_string,
            input.new_string
        )];
    }
    if (name === 'Write' && typeof input.content === 'string') {
        return [synthesizeFragmentDiff(
            input.file_path,
            'add',
            '',
            input.content
        )];
    }
    return undefined;
}

function settleClaudeQuestion(
    block: ConversationQuestionBlock,
    text: string
): void {
    if (/doesn't want to proceed|user rejected/i.test(text)) {
        block.outcome = 'rejected';
        return;
    }
    const answers = new Map<string, string>();
    const pattern = /"([^"]+)"="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        if (match[1] !== undefined && match[2] !== undefined) {
            answers.set(match[1], match[2]);
        }
    }
    if (answers.size) {
        block.questions = block.questions.map(item => {
            const value = answers.get(item.question);
            return value !== undefined
                ? { ...item, answers: splitSettledAnswers(value, item) }
                : item;
        });
    }
    block.outcome = 'answered';
}

export class ClaudeConversationAdapter implements ConversationProviderAdapter {
    private readonly cache: ConversationIndexCache<ClaudeConversationIndex>;
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private readonly revisionCounters = new Map<string, number>();
    private readonly loadQueues = new Map<string, Promise<void>>();
    private providerWatch?: AiSessionDisposable;
    private invalidationTimer?: TimerHandle;
    private disposed = false;

    constructor(private readonly options: ClaudeConversationAdapterOptions) {
        this.cache = new ConversationIndexCache(options.now);
    }

    async readSnapshot(
        sessionId: string,
        preferredInteractionId?: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot> {
        const loaded = await this.load(sessionId, signal);
        const outline = buildConversationOutline(
            'claude',
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
                    provider: 'claude',
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
        const subagentsRoot = subagentsRootFor(candidate.sourcePath);
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
            const match = dirent.isFile()
                ? SUBAGENT_TRANSCRIPT_PATTERN.exec(dirent.name)
                : null;
            if (!match || !isSubagentId(match[1])) {
                continue;
            }
            const entry = await readSubagentEntry(
                subagentsRoot,
                match[1],
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
        this.loadQueues.clear();
    }

    getCacheDiagnostics(
        sessionId: string
    ): ConversationCacheDiagnostics | undefined {
        const entry = this.cache.get(sessionId);
        if (!entry) {
            return undefined;
        }
        return {
            sourceSize: entry.source.size,
            cachedNextOffset: entry.nextOffset,
            cachedInteractions: entry.interactions.length,
            continuation: entry.lastReadContinuation,
            partial: entry.partial,
        };
    }

    /** Provider-owned candidates for the persistent history indexer. */
    getHistoryRestartPoints(
        sessionId: string
    ): ConversationHistoryRestartSnapshot | undefined {
        const entry = this.cache.get(sessionId);
        return entry && {
            sourceIdentity: entry.source.identity,
            sourceSize: entry.source.size,
            sourceRevision: `r${entry.revision}`,
            reducerVersion: 1,
            points: entry.restartPoints.map(point => ({ ...point })),
        };
    }

    private load(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<LoadedConversation> {
        // Warmup, telemetry polls, watch refreshes, and authoritative clicks
        // share one cache entry per session and each load commits it in
        // place. Serialize loads so a read can never capture a stale
        // nextOffset, flip a continuation into a suffix-only cold read, or
        // overwrite a newer commit with an older one.
        const queued = this.loadQueues.get(sessionId) || Promise.resolve();
        const run = queued.then(() => this.loadExclusive(sessionId, signal));
        // A rejected load must not jam the queue for the next caller.
        const settled = run.then(() => undefined, () => undefined);
        this.loadQueues.set(sessionId, settled);
        void settled.then(() => {
            if (this.loadQueues.get(sessionId) === settled) {
                this.loadQueues.delete(sessionId);
            }
        });
        return run;
    }

    private async loadExclusive(
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
                    subagentsRootFor(candidate.sourcePath),
                    `agent-${split.subagentId}.jsonl`
                ),
            }
            : candidate;
        const source = await openValidatedConversationSource(
            effectiveCandidate
        );
        if (!source) {
            throw new ConversationError('unavailable', 'missingSource');
        }
        const isSubagentTranscript = Boolean(split.subagentId);
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
            // See Kimi's equivalent guard. `continuing` verifies the old
            // prefix before reducer state and sparse candidates are reused.
            let restartPoints: ConversationHistoryRestartPoint[] = continuing
                ? previous.restartPoints
                : [];
            let ownsRestartPoints = !continuing;
            const addRestartPoint = (
                point: ConversationHistoryRestartPoint
            ): void => {
                if (!ownsRestartPoints) {
                    restartPoints = restartPoints.slice();
                    ownsRestartPoints = true;
                }
                appendConversationHistoryRestartPoint(restartPoints, point);
            };
            if (continuing) {
                interactions = cloneInteractions(previous.interactions);
                openInteractionIndex = previous.appendInteractionIndex;
                telemetryModel = previous.telemetryModel;
                telemetryContext = previous.telemetryContext;
                telemetryCwd = previous.telemetryCwd;
                telemetryGitBranch = previous.telemetryGitBranch;
            }
            // Kept on the cache entry so a tool_result arriving in a later
            // incremental load still pairs with its tool_use.
            const toolTracker = (continuing && previous?.toolTracker)
                || new ToolCallTracker();
            // Same persistence rationale as toolTracker: the tool_result
            // answering a question can land in a later incremental load.
            const questionTracker = (continuing && previous?.questionTracker)
                || new Map<string, ConversationQuestionBlock>();
            const finishInteraction = (
                state: 'complete' | 'interrupted' = 'complete'
            ): void => {
                if (openInteractionIndex === undefined) {
                    return;
                }
                interactions[openInteractionIndex].responseState = state;
                openInteractionIndex = undefined;
            };
            const stampActivity = (event: Record<string, unknown>): void => {
                if (openInteractionIndex === undefined) {
                    return;
                }
                const value = timestampValue(event.timestamp);
                if (value !== undefined) {
                    interactions[openInteractionIndex].completedAt = value;
                }
            };
            const normalizeRecord = (record: ConversationJsonlRecord): void => {
                const event = asRecord(record.value);
                // Subagent transcripts consist entirely of sidechain records;
                // the sidechain filter only applies to the main conversation.
                if (!event || (event.isSidechain && !split.subagentId)) {
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
                            maxTokens: maxContextTokens(telemetryModel),
                        };
                    }
                }
                if (event.type === 'user'
                    && message?.role === 'user'
                    && isUserInterrupt(message.content)) {
                    finishInteraction('interrupted');
                    timeoutOpenInteractionIndex = undefined;
                    toolTracker.discardPending();
                    questionTracker.clear();
                } else if (event.type === 'user'
                    && message?.role === 'user'
                    && openInteractionIndex !== undefined
                    && containsBlock(message.content, 'tool_result')) {
                    stampActivity(event);
                    contentBlocks(message.content).forEach(block => {
                        if (block.type !== 'tool_result') {
                            return;
                        }
                        const text = typeof block.content === 'string'
                            ? block.content
                            : contentBlocks(block.content)
                                .filter(part => part.type === 'text'
                                    && typeof part.text === 'string')
                                .map(part => part.text)
                                .join('\n');
                        const questionBlock =
                            typeof block.tool_use_id === 'string'
                                ? questionTracker.get(block.tool_use_id)
                                : undefined;
                        if (questionBlock) {
                            settleClaudeQuestion(questionBlock, text);
                            if (typeof block.tool_use_id === 'string') {
                                questionTracker.delete(block.tool_use_id);
                            }
                        } else {
                            toolTracker.finish(block.tool_use_id, text);
                        }
                    });
                } else if (event.type === 'user'
                    && message?.role === 'user'
                    && (isVisibleUserEvent(event)
                        || (isSubagentTranscript
                            && isCoordinatorDispatch(event)))
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
                    // A new visible user record seals the former turn. Any
                    // still-unpaired tool/question is orphaned rather than a
                    // dependency of this replay boundary.
                    toolTracker.discardPending();
                    questionTracker.clear();
                    if (interactions.some(
                        interaction => interaction.id === event.uuid
                    )) {
                        return;
                    }
                    if (!toolTracker.hasPending()
                        && questionTracker.size === 0
                        && event.uuid.length
                            <= CONVERSATION_LIMITS.maxHistoryRestartPointIdLength) {
                        addRestartPoint({
                            offset: record.offset,
                            interactionId: event.uuid,
                        });
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
                    stampActivity(event);
                    // Text and tool_use blocks share one ordered stream so
                    // tool entries interleave with text in arrival order.
                    const pushTextPart = (part: string): void => {
                        const text = visibleMessage(part);
                        if (text) {
                            interactions[openInteractionIndex]
                                .assistantMarkdown.push(text);
                        }
                    };
                    if (typeof message.content === 'string') {
                        pushTextPart(message.content);
                    } else {
                        contentBlocks(message.content).forEach(block => {
                            if (block.type === 'text'
                                && typeof block.text === 'string') {
                                pushTextPart(block.text);
                                return;
                            }
                            if (block.type === 'thinking'
                                && typeof block.thinking === 'string') {
                                const text = visibleMessage(block.thinking);
                                if (text) {
                                    const interaction =
                                        interactions[openInteractionIndex];
                                    (interaction.thinking ||= []).push({
                                        position: interaction
                                            .assistantMarkdown.length,
                                        text,
                                    });
                                }
                                return;
                            }
                            if (block.type !== 'tool_use'
                                || typeof block.name !== 'string'
                                || !block.name) {
                                return;
                            }
                            const input = asRecord(block.input);
                            const questionItems =
                                block.name === 'AskUserQuestion'
                                    ? claudeQuestionItems(input)
                                    : [];
                            const toolUseId = typeof block.id === 'string'
                                ? block.id
                                : '';
                            if (questionItems.length && toolUseId) {
                                const interaction =
                                    interactions[openInteractionIndex];
                                const questionBlock:
                                    ConversationQuestionBlock = {
                                        position: interaction
                                            .assistantMarkdown.length,
                                        source: 'AskUserQuestion',
                                        questions: questionItems,
                                    };
                                (interaction.questions ||= []).push(
                                    questionBlock
                                );
                                questionTracker.set(toolUseId, questionBlock);
                                return;
                            }
                            const editDiffs = claudeToolDiffs(block.name, input);
                            const baseSummary = buildToolCallSummary(
                                block.name,
                                input
                            );
                            toolTracker.begin(
                                interactions[openInteractionIndex],
                                typeof block.id === 'string'
                                    ? block.id
                                    : undefined,
                                block.name,
                                editDiffs && block.name === 'Edit'
                                    && input?.replace_all === true
                                    ? truncateGraphemes(
                                        `${baseSummary} (replace all)`,
                                        CONVERSATION_LIMITS
                                            .toolCallSummaryGraphemes - 1
                                    )
                                    : baseSummary,
                                editDiffs
                                    ? undefined
                                    : capToolCallDetail(
                                        JSON.stringify(input ?? {}, null, 2)
                                    ),
                                editDiffs
                            );
                        });
                    }
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
                previous.restartPoints = restartPoints;
                previous.appendInteractionIndex = appendInteractionIndex;
                previous.telemetryModel = telemetryModel;
                previous.telemetryContext = telemetryContext;
                previous.telemetryCwd = telemetryCwd;
                previous.telemetryGitBranch = telemetryGitBranch;
                previous.toolTracker = toolTracker;
                previous.questionTracker = questionTracker;
                previous.lastReadContinuation = continuing;
                previous.revision = revision;
                previous.partial = partial;
            } else {
                this.cache.set(sessionId, {
                    source,
                    nextOffset: result.nextOffset,
                    interactions,
                    restartPoints,
                    appendInteractionIndex,
                    telemetryModel,
                    telemetryContext,
                    telemetryCwd,
                    telemetryGitBranch,
                    toolTracker,
                    questionTracker,
                    lastReadContinuation: continuing,
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

interface SubagentMeta {
    description?: string;
    agentType?: string;
    toolUseId?: string;
    spawnDepth?: number;
    model?: string;
}

// Claude stores subagent transcripts beside the session file:
// <project>/<sessionId>.jsonl -> <project>/<sessionId>/subagents/.
function subagentsRootFor(sourcePath: string): string {
    const base = path.basename(sourcePath, path.extname(sourcePath));
    return path.join(path.dirname(sourcePath), base, 'subagents');
}

async function readSubagentEntry(
    subagentsRoot: string,
    id: string,
    now: number
): Promise<ConversationSubagentEntry | undefined> {
    const transcriptPath = path.join(subagentsRoot, `agent-${id}.jsonl`);
    let transcriptStat: fs.Stats;
    try {
        transcriptStat = await fs.promises.stat(transcriptPath);
    } catch (_error) {
        return undefined;
    }
    const meta = await readSubagentMeta(
        path.join(subagentsRoot, `agent-${id}.meta.json`)
    );
    // Only depth-1 agents (dispatched by the main session) are listed;
    // deeper nested agents stay visible inside their parent's transcript
    // as Task tool calls.
    if (typeof meta?.spawnDepth === 'number' && meta.spawnDepth > 1) {
        return undefined;
    }
    const [createdAt, completed] = await Promise.all([
        readSubagentCreatedAt(transcriptPath),
        readSubagentCompleted(transcriptPath, transcriptStat.size),
    ]);
    return {
        id,
        label: subagentLabel(meta, id),
        ...(meta?.agentType ? { agentType: meta.agentType } : {}),
        status: subagentStatus(completed, transcriptStat.mtimeMs, now),
        ...(createdAt !== undefined ? { createdAt } : {}),
        updatedAt: Math.floor(transcriptStat.mtimeMs),
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
    const agentType = typeof meta?.agentType === 'string'
        ? meta.agentType
        : '';
    return agentType ? `${agentType} · ${id}` : id;
}

function subagentStatus(
    completed: boolean,
    transcriptMtimeMs: number,
    now: number
): ConversationSubagentEntry['status'] {
    if (completed) {
        return 'idle';
    }
    // Claude records no status on disk: a mid-turn tail record only proves
    // liveness while the transcript is freshly written. A stale mid-turn
    // transcript means a crash OR a long quiet command — report quiet, not
    // failed, without positive death evidence.
    return now - transcriptMtimeMs <= SUBAGENT_RUNNING_FRESHNESS_MS
        ? 'running'
        : 'quiet';
}

async function readSubagentCreatedAt(
    transcriptPath: string
): Promise<number | undefined> {
    const head = await readFileWindow(
        transcriptPath,
        0,
        SUBAGENT_RECORD_WINDOW_BYTES
    );
    if (!head) {
        return undefined;
    }
    const newline = head.indexOf('\n');
    if (newline <= 0) {
        return undefined;
    }
    return recordTimestamp(head.slice(0, newline));
}

async function readSubagentCompleted(
    transcriptPath: string,
    fileSize: number
): Promise<boolean> {
    const length = Math.min(fileSize, SUBAGENT_RECORD_WINDOW_BYTES);
    if (!length) {
        return false;
    }
    const tail = await readFileWindow(
        transcriptPath,
        fileSize - length,
        length
    );
    if (!tail) {
        return false;
    }
    const lines = tail.split('\n');
    if (fileSize > length) {
        // The first line may be cut by the window edge; drop it.
        lines.shift();
    }
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line) {
            continue;
        }
        try {
            const record = asRecord(JSON.parse(line));
            const message = asRecord(record?.message);
            // An agent finishes with a final assistant message that calls
            // no tools; anything else as the tail means the turn was still
            // in flight when the transcript was last written.
            return record?.type === 'assistant'
                && message?.role === 'assistant'
                && !containsBlock(message.content, 'tool_use');
        } catch (_error) {
            return false;
        }
    }
    return false;
}

function recordTimestamp(line: string): number | undefined {
    try {
        const record = asRecord(JSON.parse(line));
        return timestampValue(record?.timestamp);
    } catch (_error) {
        return undefined;
    }
}

async function readFileWindow(
    filePath: string,
    position: number,
    length: number
): Promise<string | undefined> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.toString('utf8', 0, bytesRead);
    } catch (_error) {
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
