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
    boundQuestionItems,
    boundQuestionOptions,
    deriveQuestionSource,
    splitSettledAnswers,
} from './questions';
import { synthesizeFragmentDiff, synthesizeFragmentDiffs } from './diffs';
import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationCacheDiagnostics,
    ConversationError,
    ConversationFileDiff,
    ConversationInteraction,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationProviderAdapter,
    ConversationQuestionBlock,
    ConversationQuestionItem,
    ConversationQuestionOutcome,
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

function extractShellWorkingDirectories(
    value: string,
    baseCwd?: string
): string[] {
    const paths = new Set<string>();
    const pattern = new RegExp(SHELL_CD_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    // The Shell tool runs every command with cwd = session work_dir, so a
    // relative cd resolves against the session directory; within one
    // command, each resolved cd becomes the base for the next.
    let base = baseCwd;
    while ((match = pattern.exec(value)) !== null) {
        const candidate = match[1] || match[2] || match[3] || '';
        if (!candidate
            || candidate.startsWith('~')
            || candidate.includes('$')) {
            continue;
        }
        let resolved: string;
        if (candidate.startsWith('/')) {
            resolved = candidate;
        } else if (base) {
            resolved = path.resolve(base, candidate);
        } else {
            continue;
        }
        if (resolved.length > 1024) {
            continue;
        }
        paths.add(resolved);
        base = resolved;
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
    /** tool_call_id → question block, for QuestionRequest/ToolResult pairing. */
    questionTracker?: Map<string, ConversationQuestionBlock>;
    /** approval request id → gated tool_call_id, for ApprovalResponse. */
    approvalTracker?: Map<string, string>;
    pendingThinking?: { position: number; text: string } | null;
    /** Whether the most recent load read incrementally from the cache. */
    lastReadContinuation: boolean;
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

const KIMI_QUESTION_TOOL_NAMES = new Set(['ExitPlanMode', 'AskUserQuestion']);

/**
 * Synthesizes fragment diffs from Kimi edit-tool arguments. Shapes probed
 * from live wire.jsonl records: WriteFile carries path/content (+optional
 * mode 'append'); StrReplaceFile carries path plus `edit` as one object or
 * a list of {old, new} pairs. Returns undefined for any other shape so the
 * caller keeps the generic raw-JSON rendering.
 */
function kimiEditToolDiffs(
    name: string,
    args: Record<string, any> | undefined
): ConversationFileDiff[] | undefined {
    if (!args || typeof args.path !== 'string' || !args.path) {
        return undefined;
    }
    if (name === 'WriteFile' && typeof args.content === 'string') {
        return [synthesizeFragmentDiff(
            args.path,
            args.mode === 'append' ? 'update' : 'add',
            '',
            args.content
        )];
    }
    if (name === 'StrReplaceFile') {
        const rawEdits = Array.isArray(args.edit)
            ? args.edit
            : args.edit && typeof args.edit === 'object'
                ? [args.edit]
                : [];
        const pairs: Array<{ oldText: string; newText: string }> = [];
        for (const rawEdit of rawEdits) {
            const edit = asRecord(rawEdit);
            if (typeof edit?.old === 'string'
                && typeof edit?.new === 'string') {
                pairs.push({ oldText: edit.old, newText: edit.new });
            }
        }
        if (!pairs.length) {
            return undefined;
        }
        return [synthesizeFragmentDiffs(args.path, 'update', pairs)];
    }
    return undefined;
}

function kimiQuestionItemsFromRecords(
    rawQuestions: unknown
): ConversationQuestionItem[] {
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
            multiSelect: record?.multi_select === true,
            ...(typeof record?.other_label === 'string'
                ? { otherLabel: record.other_label }
                : {}),
        };
    }));
}

function kimiQuestionItemsFromToolArguments(
    name: string,
    args: Record<string, any> | undefined
): ConversationQuestionItem[] {
    if (!args) {
        return [];
    }
    if (Array.isArray(args.questions)) {
        return kimiQuestionItemsFromRecords(args.questions);
    }
    if (name === 'ExitPlanMode' && Array.isArray(args.options)) {
        return boundQuestionItems([{
            question: 'Approve this plan',
            options: boundQuestionOptions(args.options),
            multiSelect: false,
        }]);
    }
    return [];
}

function classifyKimiQuestionOutcome(
    output: string
): ConversationQuestionOutcome {
    if (/\bplan approved\b/i.test(output)) {
        return 'approved';
    }
    if (/\brevise\b/i.test(output)) {
        return 'revised';
    }
    if (/\bdismiss/i.test(output)) {
        return 'dismissed';
    }
    if (/\breject/i.test(output)) {
        return 'rejected';
    }
    return 'answered';
}

function extractKimiSelectedApproach(output: string): string | undefined {
    const match = /Selected approach:\s*"([^"]+)"/.exec(output);
    return match?.[1];
}

function applyKimiQuestionSettlement(
    block: ConversationQuestionBlock,
    output: string | undefined
): void {
    if (output === undefined) {
        return;
    }
    if (block.source === 'AskUserQuestion') {
        let parsed: Record<string, any> | undefined;
        try {
            parsed = asRecord(JSON.parse(output));
        } catch (_error) {
            parsed = undefined;
        }
        const answers = asRecord(parsed?.answers);
        if (answers) {
            block.questions = block.questions.map(item => {
                const value = answers[item.question];
                return typeof value === 'string'
                    ? { ...item, answers: splitSettledAnswers(value, item) }
                    : item;
            });
        }
        block.outcome = 'answered';
        return;
    }
    block.outcome = classifyKimiQuestionOutcome(output);
    if (block.outcome === 'approved' && block.questions.length) {
        const approach = extractKimiSelectedApproach(output);
        if (approach) {
            block.questions = block.questions.map((item, index) => index === 0
                ? {
                    ...item,
                    answers: [truncateGraphemes(
                        approach,
                        CONVERSATION_LIMITS.questionAnswerGraphemes
                    )],
                }
                : item);
        }
    }
}

export class KimiConversationAdapter implements ConversationProviderAdapter {
    private readonly cache: ConversationIndexCache<KimiConversationIndex>;
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private readonly revisionCounters = new Map<string, number>();
    private readonly loadQueues = new Map<string, Promise<void>>();
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
            // Same persistence rationale as toolTracker: a QuestionRequest
            // or ToolResult can land in a later incremental load.
            const questionTracker = (continuing && previous?.questionTracker)
                || new Map<string, ConversationQuestionBlock>();
            const approvalTracker = (continuing && previous?.approvalTracker)
                || new Map<string, string>();
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
                            const interaction =
                                interactions[openInteractionIndex];
                            (interaction.plans ||= []).push({
                                position: interaction.assistantMarkdown.length,
                                markdown: content,
                                ...(typeof payload.file_path === 'string'
                                    && payload.file_path
                                    ? {
                                        filePath: truncateGraphemes(
                                            payload.file_path,
                                            CONVERSATION_LIMITS
                                                .planFilePathGraphemes
                                        ),
                                    }
                                    : {}),
                            });
                        }
                    }
                } else if (event.type === 'QuestionRequest') {
                    flushThinking();
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    if (openInteractionIndex !== undefined) {
                        const toolCallId =
                            typeof payload?.tool_call_id === 'string'
                                ? payload.tool_call_id
                                : '';
                        const items = kimiQuestionItemsFromRecords(
                            payload?.questions
                        );
                        if (items.length) {
                            const existing = toolCallId
                                ? questionTracker.get(toolCallId)
                                : undefined;
                            if (existing) {
                                const settled = new Map<string, string[]>();
                                for (const oldItem of existing.questions) {
                                    if (oldItem.answers) {
                                        settled.set(
                                            oldItem.question,
                                            oldItem.answers
                                        );
                                    }
                                }
                                existing.questions = items.map(item => {
                                    const answers = settled.get(item.question);
                                    return answers
                                        ? { ...item, answers }
                                        : item;
                                });
                            } else {
                                const interaction =
                                    interactions[openInteractionIndex];
                                const block: ConversationQuestionBlock = {
                                    position: interaction
                                        .assistantMarkdown.length,
                                    source: deriveQuestionSource(
                                        toolCallId || undefined,
                                        'QuestionRequest'
                                    ),
                                    questions: items,
                                };
                                (interaction.questions ||= []).push(block);
                                if (toolCallId) {
                                    questionTracker.set(toolCallId, block);
                                }
                            }
                        }
                    }
                } else if (event.type === 'ApprovalRequest') {
                    flushThinking();
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    if (openInteractionIndex !== undefined) {
                        const toolCallId =
                            typeof payload?.tool_call_id === 'string'
                                ? payload.tool_call_id
                                : '';
                        const requestId = typeof payload?.id === 'string'
                            ? payload.id
                            : '';
                        const display = Array.isArray(payload?.display)
                            ? payload.display
                            : [];
                        const diffs: ConversationFileDiff[] = [];
                        for (const rawBlock of display) {
                            const block = asRecord(rawBlock);
                            if (diffs.length
                                >= CONVERSATION_LIMITS.maxDiffsPerToolCall) {
                                break;
                            }
                            if (block?.type !== 'diff'
                                || typeof block.path !== 'string'
                                || !block.path
                                || typeof block.old_text !== 'string'
                                || typeof block.new_text !== 'string') {
                                continue;
                            }
                            diffs.push(synthesizeFragmentDiff(
                                block.path,
                                'update',
                                block.old_text,
                                block.new_text
                            ));
                        }
                        const sender = typeof payload?.sender === 'string'
                            && payload.sender
                            ? payload.sender
                            : 'Approval';
                        const description =
                            typeof payload?.description === 'string'
                                ? payload.description
                                : '';
                        const attached = diffs.length > 0
                            && toolCallId !== ''
                            && toolTracker.attachDiffs(toolCallId, diffs);
                        if (!attached && (diffs.length || description)) {
                            // The gated call is not pending (older wire
                            // shapes): the approval becomes its own entry.
                            const summary = truncateGraphemes(
                                `${sender}: ${description}`.trim(),
                                CONVERSATION_LIMITS.toolCallSummaryGraphemes - 1
                            );
                            toolTracker.begin(
                                interactions[openInteractionIndex],
                                toolCallId || undefined,
                                sender,
                                summary,
                                undefined,
                                diffs.length ? diffs : undefined
                            );
                        }
                        if (requestId && toolCallId) {
                            approvalTracker.set(requestId, toolCallId);
                        }
                    }
                } else if (event.type === 'ApprovalResponse') {
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    const requestId = typeof payload?.request_id === 'string'
                        ? payload.request_id
                        : '';
                    const response = typeof payload?.response === 'string'
                        ? payload.response
                        : '';
                    const feedback = typeof payload?.feedback === 'string'
                        && payload.feedback.trim()
                        ? ` — ${payload.feedback.trim()}`
                        : '';
                    const toolCallId = requestId
                        ? approvalTracker.get(requestId)
                        : undefined;
                    if (toolCallId && response) {
                        toolTracker.appendDetail(
                            toolCallId,
                            `Approval: ${response}${feedback}`
                        );
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
                                        args.command,
                                        effectiveCandidate.cwd
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
                        const toolCallId = typeof payload?.id === 'string'
                            ? payload.id
                            : '';
                        const questionItems = KIMI_QUESTION_TOOL_NAMES.has(
                            toolFunction.name
                        )
                            ? kimiQuestionItemsFromToolArguments(
                                toolFunction.name,
                                args
                            )
                            : [];
                        if (questionItems.length && toolCallId) {
                            const interaction =
                                interactions[openInteractionIndex];
                            const block: ConversationQuestionBlock = {
                                position: interaction.assistantMarkdown.length,
                                source: truncateGraphemes(
                                    toolFunction.name,
                                    CONVERSATION_LIMITS.questionSourceGraphemes
                                ),
                                questions: questionItems,
                            };
                            (interaction.questions ||= []).push(block);
                            questionTracker.set(toolCallId, block);
                        } else {
                            const editDiffs = kimiEditToolDiffs(
                                toolFunction.name,
                                args
                            );
                            toolTracker.begin(
                                interactions[openInteractionIndex],
                                typeof payload?.id === 'string'
                                    ? payload.id
                                    : undefined,
                                toolFunction.name,
                                buildToolCallSummary(toolFunction.name, args),
                                editDiffs
                                    ? undefined
                                    : capToolCallDetail(
                                        typeof toolFunction.arguments === 'string'
                                            ? toolFunction.arguments
                                            : ''
                                    ),
                                editDiffs
                            );
                        }
                    }
                } else if (event.type === 'ToolResult') {
                    stampActivity(envelope);
                    const payload = asRecord(event.payload);
                    const returnValue = asRecord(payload?.return_value);
                    const output = typeof returnValue?.output === 'string'
                        ? returnValue.output
                        : undefined;
                    const toolCallId = typeof payload?.tool_call_id === 'string'
                        ? payload.tool_call_id
                        : undefined;
                    const questionBlock = toolCallId
                        ? questionTracker.get(toolCallId)
                        : undefined;
                    if (questionBlock) {
                        applyKimiQuestionSettlement(questionBlock, output);
                    } else {
                        toolTracker.finish(payload?.tool_call_id, output);
                    }
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
                previous.questionTracker = questionTracker;
                previous.approvalTracker = approvalTracker;
                previous.pendingThinking = pendingThinking;
                previous.lastReadContinuation = continuing;
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
                    questionTracker,
                    approvalTracker,
                    pendingThinking,
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
