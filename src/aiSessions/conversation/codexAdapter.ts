'use strict';

import { createHash } from 'crypto';
import type {
    AiSessionCodexSubagentThread,
    AiSessionDisposable,
} from '../types';
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
}

export interface CodexConversationAdapterOptions {
    client: CodexConversationClient;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    resolveWorktree?: ResolveWorktree;
    readCurrentWorkdir?(sessionId: string): string | undefined;
    listSubagentThreads?(
        sessionId: string
    ): AiSessionCodexSubagentThread[] | Promise<AiSessionCodexSubagentThread[]>;
}

const MAX_LISTED_SUBAGENTS = 64;
const SUBAGENT_RUNNING_FRESHNESS_MS = 5 * 60 * 1000;

interface LoadedConversation {
    interactions: ConversationInteraction[];
    sourceRevision: string;
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
    return countGraphemes(normalized) <= CONVERSATION_LIMITS.maxMessageGraphemes
        ? normalized
        : truncateGraphemes(
            normalized,
            CONVERSATION_LIMITS.maxMessageGraphemes - 1
        );
}

function turnResponseState(value: string): ConversationResponseState {
    if (value === 'completed') {
        return 'complete';
    }
    if (value === 'active' || value === 'inProgress') {
        return 'inProgress';
    }
    if (value === 'failed' || value === 'cancelled') {
        return 'interrupted';
    }
    return 'unknown';
}

function normalizeThreadRead(
    value: unknown,
    sessionId: string,
    dispatch?: { label: string; timestamp?: number }
): ConversationInteraction[] {
    const result = asRecord(value);
    const thread = asRecord(result?.thread);
    if (!thread
        || typeof thread.id !== 'string'
        || thread.id !== sessionId
        || !Array.isArray(thread.turns)) {
        throw protocolError();
    }
    const turnIds = new Set<string>();
    const itemIds = new Set<string>();
    const interactions: ConversationInteraction[] = [];
    // A subagent thread exposes no userMessage for its dispatch prompt
    // (the app-server strips it), so seed one from the thread metadata to
    // give the subagent's agentMessages an interaction to attach to.
    let seededDispatchIndex: number | undefined;
    if (dispatch) {
        interactions.push({
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
        seededDispatchIndex = 0;
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
        const responseState = turnResponseState(turn.status);
        if (seededDispatchIndex !== undefined) {
            interactions[seededDispatchIndex].responseState = responseState;
        }
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
                    userMarkdown,
                    userPreview: buildUserPreview(userMarkdown),
                    userGraphemeCount: countGraphemes(userMarkdown),
                    assistantMarkdown: [],
                    responseState,
                });
                currentInteractionIndex = interactions.length - 1;
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
            } else if (item.type === 'agentMessage') {
                if (typeof item.text !== 'string') {
                    throw protocolError();
                }
                if (currentInteractionIndex === undefined) {
                    continue;
                }
                const assistantMarkdown = visibleMessage(item.text);
                if (assistantMarkdown) {
                    interactions[currentInteractionIndex]
                        .assistantMarkdown.push(assistantMarkdown);
                }
            }
        }
    }
    return interactions;
}

function fingerprintInteractions(
    interactions: readonly ConversationInteraction[]
): string {
    return createHash('sha256')
        .update(JSON.stringify(interactions), 'utf8')
        .digest('hex');
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
        const changes = Array.isArray(item.changes)
            ? item.changes.map(asRecord).filter(Boolean)
            : [];
        const first = changes[0];
        const changePath = typeof first?.path === 'string' ? first.path : '';
        const kindRecord = asRecord(first?.kind);
        const kind = typeof first?.kind === 'string'
            ? first.kind
            : typeof kindRecord?.type === 'string'
                ? kindRecord.type
                : '';
        const label = `${kind ? `${kind} ` : ''}${changePath}`.trim();
        const detail = capToolCallDetail(
            typeof first?.diff === 'string' ? first.diff : ''
        );
        return {
            name: 'fileChange',
            summary: buildToolCallSummary('fileChange', { path: label }),
            ...(detail ? { detail } : {}),
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
    const byId = asRecord(result?.rateLimitsByLimitId);
    const snapshots = byId
        ? Object.entries(byId).slice(0, 16)
        : [['codex', result?.rateLimits]];
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
    private disposed = false;

    constructor(private readonly options: CodexConversationAdapterOptions) {
        this.notificationWatch = options.client.watchNotifications?.(
            (method, params) => this.acceptNotification(method, params)
        );
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
            this.makeRoomForTelemetrySession(sessionId);
            this.telemetryCache.set(sessionId, {
                readAt: Date.now(),
                value,
            });
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
        const [resumeResult, limitsResult] = await Promise.all([
            this.options.client.request(
                'thread/resume',
                { threadId: sessionId },
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
        if (resumeResult.fulfilled) {
            const response = asRecord(resumeResult.value);
            if (typeof response?.model === 'string'
                && response.model.trim()) {
                telemetry.model = response.model.trim().slice(0, 128);
            }
        }
        const worktree = await this.readWorktree(sessionId, resumeResult);
        if (worktree) {
            telemetry.worktree = worktree;
        }
        const context = this.tokenUsageBySession.get(sessionId);
        if (context) {
            telemetry.context = { ...context };
        }
        return telemetry.model || telemetry.context || telemetry.worktree
            || telemetry.rateLimits.length
            ? telemetry
            : undefined;
    }

    private async readWorktree(
        sessionId: string,
        resumeResult: { fulfilled: true; value: unknown } | { fulfilled: false }
    ): Promise<ConversationWorktreeInfo | undefined> {
        if (!this.options.resolveWorktree) {
            return undefined;
        }
        // The current operating directory wins over the launch directory:
        // app-server exposes no exec items, so composition injects a
        // telemetry-only probe for the latest exec workdir.
        const currentWorkdir = this.options.readCurrentWorkdir?.(sessionId);
        if (currentWorkdir) {
            const resolved = await this.options.resolveWorktree(currentWorkdir);
            if (resolved) {
                return resolved;
            }
        }
        const response = resumeResult.fulfilled
            ? asRecord(resumeResult.value)
            : undefined;
        const cwd = typeof response?.cwd === 'string' && response.cwd
            ? response.cwd
            : undefined;
        return cwd ? this.options.resolveWorktree(cwd) : undefined;
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

    private async load(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<LoadedConversation> {
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
        let interactions: ConversationInteraction[];
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
            interactions = normalizeThreadRead(result, threadId, dispatch);
        } catch (error) {
            if (error instanceof ConversationError) {
                throw error;
            }
            throw protocolError();
        }
        return {
            interactions,
            sourceRevision: fingerprintInteractions(interactions),
        };
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
        return countGraphemes(normalized) <= 120
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
