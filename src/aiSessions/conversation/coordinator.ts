'use strict';

import { randomBytes } from 'crypto';
import type { AiSessionProviderId } from '../../models';
import { getAiSessionKey } from '../sessionHelpers';
import type { AiSessionDisposable } from '../types';
import {
    applyActiveLifecycleToResponseState,
    applyStoppedLifecycleToResponseState,
} from './model';
import { countGraphemes } from './text';
import {
    CONVERSATION_LIMITS,
    ConversationAbortError,
    ConversationAbortSignal,
    ConversationError,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationProviderAdapter,
    ConversationSnapshot,
    ConversationSubagentEntry,
    ConversationTelemetry,
    SanitizedConversationDiagnostic,
} from './types';

type TimerHandle = unknown;

interface PublicRevision {
    nativeRevision: string;
    number: number;
    token: string;
}

interface StoredCursor {
    key: string;
    revision: string;
    anchorInteractionId: string;
    direction: 'before' | 'after';
}

interface WatchListener {
    callback: () => void | boolean | PromiseLike<void | boolean>;
}

interface SharedWatch {
    key: string;
    provider: AiSessionProviderId;
    sessionId: string;
    listeners: Set<WatchListener>;
    adapterSubscription: AiSessionDisposable;
    timer?: TimerHandle;
    dirtySinceMs?: number;
    inFlight?: Promise<void>;
    lastCompletionAtMs?: number;
}

export interface ConversationCoordinatorSubscription extends AiSessionDisposable {
    readonly opaqueConversationSubscription: true;
}

export interface ConversationCoordinatorOptions {
    adapters: Record<AiSessionProviderId, ConversationProviderAdapter>;
    now?: () => number;
    setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimeout?: (handle: TimerHandle) => void;
    createCursorId?: () => string;
    onDiagnostic?: (diagnostic: SanitizedConversationDiagnostic) => void;
}

const PUBLIC_ERROR_CODES = new Set([
    'unavailable',
    'staleRevision',
    'unsupportedVersion',
    'tooLarge',
    'timeout',
]);

const PUBLIC_ERROR_REASONS = new Set([
    'missingSource',
    'updateCodex',
    'unsupportedCodexProtocol',
    'reconnectingCodex',
    'codexRetryExhausted',
]);

const MAX_CURSORS_PER_SESSION = CONVERSATION_LIMITS.maxOutlineInteractions * 2;

export class ConversationCoordinator implements AiSessionDisposable {
    private readonly revisions = new Map<string, PublicRevision>();
    private readonly activeSessions = new Set<string>();
    private readonly stoppedSessions = new Set<string>();
    private readonly cursors = new Map<string, StoredCursor>();
    private readonly cursorKeysBySession = new Map<string, string[]>();
    private readonly watches = new Map<string, SharedWatch>();
    private readonly subscriptionOwners = new Map<
        ConversationCoordinatorSubscription,
        { watch: SharedWatch; listener: WatchListener }
    >();
    private disposed = false;

    constructor(private readonly options: ConversationCoordinatorOptions) {}

    async readOutline(
        provider: AiSessionProviderId,
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline> {
        const adapter = this.getAdapter(provider);
        try {
            const outline = await adapter.readOutline(sessionId, signal);
            throwIfAborted(signal);
            this.validateOutline(outline, provider, sessionId);
            const revision = this.observeRevision(
                getAiSessionKey(provider, sessionId),
                outline.sourceRevision
            );
            return this.projectOutline(
                outline,
                provider,
                sessionId,
                revision.token
            );
        } catch (error) {
            throw this.toSafeError(provider, error);
        }
    }

    async readSnapshot(
        provider: AiSessionProviderId,
        sessionId: string,
        preferredInteractionId?: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot> {
        const adapter = this.getAdapter(provider);
        const key = getAiSessionKey(provider, sessionId);
        try {
            let snapshot: ConversationSnapshot;
            if (adapter.readSnapshot) {
                snapshot = await adapter.readSnapshot(
                    sessionId,
                    preferredInteractionId,
                    signal
                );
            } else {
                const outline = await adapter.readOutline(sessionId, signal);
                snapshot = { outline };
            }
            throwIfAborted(signal);
            this.validateOutline(snapshot.outline, provider, sessionId);
            if (snapshot.page) {
                this.validatePage(snapshot.page, provider, sessionId);
                if (snapshot.page.sourceRevision
                    !== snapshot.outline.sourceRevision) {
                    throw new ConversationError('staleRevision');
                }
            }
            const observed = this.observeRevision(
                key,
                snapshot.outline.sourceRevision
            );
            return {
                outline: this.projectOutline(
                    snapshot.outline,
                    provider,
                    sessionId,
                    observed.token
                ),
                ...(snapshot.page ? {
                    page: this.projectPage(
                        snapshot.page,
                        provider,
                        sessionId,
                        key,
                        observed
                    ),
                } : {}),
            };
        } catch (error) {
            throw this.toSafeError(provider, error);
        }
    }

    async readSubagents(
        provider: AiSessionProviderId,
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSubagentEntry[]> {
        const adapter = this.getAdapter(provider);
        if (typeof adapter.readSubagents !== 'function') {
            return [];
        }
        try {
            return await adapter.readSubagents(sessionId, signal);
        } catch (_error) {
            // The subagent list is a sidebar convenience; a listing failure
            // must never break the authoritative conversation itself.
            return [];
        }
    }

    async readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage> {
        const adapter = this.getAdapter(request.provider);
        const key = getAiSessionKey(request.provider, request.sessionId);
        const revision = this.revisions.get(key);
        let anchorInteractionId = request.anchorInteractionId;
        let direction = request.direction;
        if (request.expectedRevision
            && (!revision || request.expectedRevision !== revision.token)) {
            throw new ConversationError('staleRevision');
        }
        if (request.cursor) {
            const stored = this.cursors.get(request.cursor);
            if (!stored
                || stored.key !== key
                || !revision
                || stored.revision !== revision.token
                || stored.direction !== request.direction
                || stored.anchorInteractionId !== request.anchorInteractionId) {
                throw new ConversationError('staleRevision');
            }
            anchorInteractionId = stored.anchorInteractionId;
            direction = stored.direction;
        }
        const limit = Number.isFinite(request.limit)
            ? Math.max(1, Math.min(
                CONVERSATION_LIMITS.maxPageInteractions,
                Math.floor(request.limit)
            ))
            : CONVERSATION_LIMITS.maxPageInteractions;
        try {
            const page = await adapter.readPage({
                provider: request.provider,
                sessionId: request.sessionId,
                anchorInteractionId,
                direction,
                limit,
                expectedRevision: revision?.nativeRevision,
            }, signal);
            throwIfAborted(signal);
            this.validatePage(page, request.provider, request.sessionId);
            const observed = this.observeRevision(key, page.sourceRevision);
            if (revision && observed.nativeRevision !== revision.nativeRevision) {
                throw new ConversationError('staleRevision');
            }
            return this.projectPage(
                page,
                request.provider,
                request.sessionId,
                key,
                observed
            );
        } catch (error) {
            throw this.toSafeError(request.provider, error);
        }
    }

    async readTelemetry(
        provider: AiSessionProviderId,
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined> {
        const adapter = this.getAdapter(provider);
        if (!adapter.readTelemetry) {
            return undefined;
        }
        try {
            const telemetry = await adapter.readTelemetry(sessionId, signal);
            if (!telemetry
                || telemetry.provider !== provider
                || telemetry.sessionId !== sessionId) {
                return undefined;
            }
            return telemetry;
        } catch (_error) {
            return undefined;
        }
    }

    watch(
        provider: AiSessionProviderId,
        sessionId: string,
        onChange: () => void | boolean | PromiseLike<void | boolean>
    ): ConversationCoordinatorSubscription {
        const adapter = this.getAdapter(provider);
        const key = getAiSessionKey(provider, sessionId);
        let watch = this.watches.get(key);
        if (!watch) {
            const listeners = new Set<WatchListener>();
            try {
                const created: SharedWatch = {
                    key,
                    provider,
                    sessionId,
                    listeners,
                    adapterSubscription: null,
                };
                created.adapterSubscription = adapter.watch(
                    sessionId,
                    () => this.scheduleInvalidation(created)
                );
                watch = created;
                this.watches.set(key, watch);
            } catch (error) {
                throw this.toSafeError(provider, error);
            }
        }
        const listener = { callback: onChange };
        watch.listeners.add(listener);
        let subscription: ConversationCoordinatorSubscription;
        subscription = {
            opaqueConversationSubscription: true,
            dispose: () => this.releaseSubscription(subscription),
        };
        this.subscriptionOwners.set(subscription, { watch, listener });
        return subscription;
    }

    releaseSubscription(subscription: ConversationCoordinatorSubscription): void {
        const ownership = this.subscriptionOwners.get(subscription);
        if (!ownership) {
            return;
        }
        this.subscriptionOwners.delete(subscription);
        ownership.watch.listeners.delete(ownership.listener);
        if (!ownership.watch.listeners.size) {
            this.disposeWatch(ownership.watch);
        }
    }

    setSessionStopped(
        provider: AiSessionProviderId,
        sessionId: string,
        stopped: boolean
    ): void {
        const key = getAiSessionKey(provider, sessionId);
        if (stopped) {
            this.activeSessions.delete(key);
            this.stoppedSessions.add(key);
        } else {
            this.stoppedSessions.delete(key);
            this.activeSessions.add(key);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        Array.from(this.watches.values()).forEach(watch => this.disposeWatch(watch));
        this.subscriptionOwners.clear();
        this.revisions.clear();
        this.activeSessions.clear();
        this.stoppedSessions.clear();
        this.cursors.clear();
        this.cursorKeysBySession.clear();
        new Set(Object.values(this.options.adapters)).forEach(adapter => {
            try {
                adapter.dispose();
            } catch (_error) {
                // Adapter disposal is isolated from the remaining providers.
            }
        });
    }

    private getAdapter(provider: AiSessionProviderId): ConversationProviderAdapter {
        const adapter = this.options.adapters[provider];
        if (this.disposed || !adapter) {
            throw new ConversationError('unavailable');
        }
        return adapter;
    }

    private projectOutline(
        outline: ConversationOutline,
        provider: AiSessionProviderId,
        sessionId: string,
        publicRevision: string
    ): ConversationOutline {
        const key = getAiSessionKey(provider, sessionId);
        return {
            provider,
            sessionId,
            sourceRevision: publicRevision,
            interactions: outline.interactions.map((interaction, index) => ({
                id: interaction.id,
                providerTurnId: interaction.providerTurnId,
                timestamp: interaction.timestamp,
                userPreview: interaction.userPreview,
                userGraphemeCount: interaction.userGraphemeCount,
                responseState: applyActiveLifecycleToResponseState(
                    applyStoppedLifecycleToResponseState(
                        interaction.responseState,
                        this.stoppedSessions.has(key)
                    ),
                    this.activeSessions.has(key),
                    index === outline.interactions.length - 1
                ),
            })),
            totalInteractions: outline.totalInteractions,
            partial: outline.partial,
        };
    }

    private projectPage(
        page: ConversationPage,
        provider: AiSessionProviderId,
        sessionId: string,
        key: string,
        observed: PublicRevision
    ): ConversationPage {
        const stopped = this.stoppedSessions.has(key);
        const active = this.activeSessions.has(key);
        const activeInferredInteractionId = active
            && provider !== 'codex'
            && page.isEnd
            ? page.interactionStates[page.interactionStates.length - 1]
                .interactionId
            : undefined;
        const result: ConversationPage = {
            provider,
            sessionId,
            sourceRevision: observed.token,
            anchorInteractionId: page.anchorInteractionId,
            messages: page.messages.map(message => ({
                id: message.id,
                interactionId: message.interactionId,
                role: message.role === 'assistant'
                    && message.interactionId === activeInferredInteractionId
                    ? 'progress'
                    : message.role,
                timestamp: message.timestamp,
                markdown: message.markdown,
                ...(message.tool
                    ? {
                        tool: {
                            name: message.tool.name,
                            summary: message.tool.summary,
                            ...(message.tool.detail !== undefined
                                ? { detail: message.tool.detail }
                                : {}),
                        },
                    }
                    : {}),
                ...(message.thinking
                    ? { thinking: { text: message.thinking.text } }
                    : {}),
            })),
            interactionStates: page.interactionStates.map((state, index) => ({
                interactionId: state.interactionId,
                responseState: applyActiveLifecycleToResponseState(
                    applyStoppedLifecycleToResponseState(
                        state.responseState,
                        stopped
                    ),
                    active,
                    page.isEnd && index === page.interactionStates.length - 1
                ),
            })),
            previousCursor: page.previousCursor === undefined
                ? undefined
                : this.storeCursor(
                    key,
                    observed.token,
                    page.interactionStates[0].interactionId,
                    'before'
                ),
            nextCursor: page.nextCursor === undefined
                ? undefined
                : this.storeCursor(
                    key,
                    observed.token,
                    page.interactionStates[page.interactionStates.length - 1]
                        .interactionId,
                    'after'
                ),
            isStart: page.isStart,
            isEnd: page.isEnd,
        };
        if (Buffer.byteLength(JSON.stringify(result), 'utf8')
            > CONVERSATION_LIMITS.maxPageBytes) {
            throw new ConversationError('tooLarge');
        }
        return result;
    }

    private observeRevision(key: string, nativeRevision: string): PublicRevision {
        const current = this.revisions.get(key);
        if (current?.nativeRevision === nativeRevision) {
            return current;
        }
        const nextNumber = (current?.number || 0) + 1;
        const next = {
            nativeRevision,
            number: nextNumber,
            token: `r${nextNumber}`,
        };
        this.revisions.set(key, next);
        this.clearCursors(key);
        return next;
    }

    private storeCursor(
        key: string,
        revision: string,
        anchorInteractionId: string,
        direction: 'before' | 'after'
    ): string {
        let token: string;
        do {
            token = this.options.createCursorId
                ? this.options.createCursorId()
                : `c${randomBytes(18).toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/g, '')}`;
        } while (!token || this.cursors.has(token));
        this.cursors.set(token, {
            key,
            revision,
            anchorInteractionId,
            direction,
        });
        const keys = this.cursorKeysBySession.get(key) || [];
        keys.push(token);
        while (keys.length > MAX_CURSORS_PER_SESSION) {
            this.cursors.delete(keys.shift());
        }
        this.cursorKeysBySession.set(key, keys);
        return token;
    }

    private clearCursors(key: string): void {
        const keys = this.cursorKeysBySession.get(key) || [];
        keys.forEach(cursor => this.cursors.delete(cursor));
        this.cursorKeysBySession.delete(key);
    }

    private scheduleInvalidation(watch: SharedWatch): void {
        if (this.disposed || this.watches.get(watch.key) !== watch) {
            return;
        }
        if (watch.dirtySinceMs === undefined) {
            watch.dirtySinceMs = this.now();
        }
        if (watch.timer !== undefined || watch.inFlight) {
            return;
        }
        this.scheduleDirtyWatch(watch);
    }

    private scheduleDirtyWatch(watch: SharedWatch): void {
        if (watch.dirtySinceMs === undefined
            || this.disposed
            || this.watches.get(watch.key) !== watch) {
            return;
        }
        const now = this.now();
        const debounceDeadline = watch.dirtySinceMs
            + CONVERSATION_LIMITS.invalidationDebounceMs;
        const rateFloor = watch.lastCompletionAtMs === undefined
            ? debounceDeadline
            : watch.lastCompletionAtMs
                + CONVERSATION_LIMITS.invalidationMinIntervalMs;
        const deadline = Math.max(debounceDeadline, rateFloor);
        let firedSynchronously = false;
        const timer = this.setTimer(() => {
            firedSynchronously = true;
            watch.timer = undefined;
            if (this.disposed || this.watches.get(watch.key) !== watch) {
                return;
            }
            void this.runDirtyWatch(watch);
        }, Math.max(0, deadline - now));
        if (!firedSynchronously) {
            watch.timer = timer;
        }
    }

    private async runDirtyWatch(watch: SharedWatch): Promise<void> {
        if (watch.dirtySinceMs === undefined
            || watch.inFlight
            || this.disposed
            || this.watches.get(watch.key) !== watch) {
            return;
        }
        watch.dirtySinceMs = undefined;
        const inFlight = Promise.resolve().then(() => Promise.all(
            Array.from(watch.listeners).map(async listener => {
                try {
                    return await listener.callback() !== false;
                } catch (_error) {
                    this.emitDiagnostic(watch.provider, 'unavailable');
                    return false;
                }
            })
        )).then(completed => {
            if (completed.some(Boolean)
                && !this.disposed
                && this.watches.get(watch.key) === watch) {
                watch.lastCompletionAtMs = this.now();
            }
        });
        watch.inFlight = inFlight;
        await inFlight;
        if (watch.inFlight !== inFlight) {
            return;
        }
        watch.inFlight = undefined;
        if (watch.dirtySinceMs !== undefined
            && !this.disposed
            && this.watches.get(watch.key) === watch) {
            this.scheduleDirtyWatch(watch);
        }
    }

    private disposeWatch(watch: SharedWatch): void {
        if (watch.timer !== undefined) {
            this.clearTimer(watch.timer);
            watch.timer = undefined;
        }
        watch.dirtySinceMs = undefined;
        try {
            watch.adapterSubscription.dispose();
        } catch (_error) {
            this.emitDiagnostic(watch.provider, 'unavailable');
        }
        this.watches.delete(watch.key);
        for (const [subscription, ownership] of this.subscriptionOwners) {
            if (ownership.watch === watch) {
                this.subscriptionOwners.delete(subscription);
            }
        }
        watch.listeners.clear();
    }

    private validateOutline(
        outline: ConversationOutline,
        provider: AiSessionProviderId,
        sessionId: string
    ): void {
        if (!outline
            || outline.provider !== provider
            || outline.sessionId !== sessionId
            || typeof outline.sourceRevision !== 'string'
            || !outline.sourceRevision
            || !isDenseOwnArray(outline.interactions)
            || outline.interactions.length
                > CONVERSATION_LIMITS.maxOutlineInteractions
            || !outline.interactions.every(interaction => (
                Boolean(interaction)
                && typeof interaction.id === 'string'
                && Boolean(interaction.id)
                && (interaction.providerTurnId === undefined
                    || typeof interaction.providerTurnId === 'string')
                && (interaction.timestamp === undefined
                    || (typeof interaction.timestamp === 'number'
                        && Number.isFinite(interaction.timestamp)))
                && typeof interaction.userPreview === 'string'
                && countGraphemes(interaction.userPreview)
                    <= CONVERSATION_LIMITS.previewGraphemes
                && Number.isSafeInteger(interaction.userGraphemeCount)
                && interaction.userGraphemeCount >= 0
                && interaction.userGraphemeCount
                    <= CONVERSATION_LIMITS.maxMessageGraphemes
                && isResponseState(interaction.responseState)
            ))
            || !Number.isSafeInteger(outline.totalInteractions)
            || outline.totalInteractions < 0
            || outline.totalInteractions < outline.interactions.length
            || typeof outline.partial !== 'boolean') {
            throw new ConversationError('unavailable');
        }
        if (!hasUniqueValues(outline.interactions.map(
            interaction => interaction.id
        ))) {
            throw new ConversationError('unavailable');
        }
    }

    private validatePage(
        page: ConversationPage,
        provider: AiSessionProviderId,
        sessionId: string
    ): void {
        if (!page
            || page.provider !== provider
            || page.sessionId !== sessionId
            || typeof page.sourceRevision !== 'string'
            || !page.sourceRevision
            || typeof page.anchorInteractionId !== 'string'
            || !page.anchorInteractionId
            || !isDenseOwnArray(page.messages)
            || !page.messages.every(message => (
                Boolean(message)
                && typeof message.id === 'string'
                && Boolean(message.id)
                && typeof message.interactionId === 'string'
                && Boolean(message.interactionId)
                && (message.role === 'user' || message.role === 'assistant'
                    || message.role === 'progress'
                    || (message.role === 'tool'
                        && Boolean(message.tool)
                        && typeof message.tool.name === 'string'
                        && Boolean(message.tool.name)
                        && countGraphemes(message.tool.name)
                            <= CONVERSATION_LIMITS.toolCallSummaryGraphemes
                        && typeof message.tool.summary === 'string'
                        && countGraphemes(message.tool.summary)
                            <= CONVERSATION_LIMITS.toolCallSummaryGraphemes
                        && (message.tool.detail === undefined
                            || (typeof message.tool.detail === 'string'
                                && countGraphemes(message.tool.detail)
                                    <= CONVERSATION_LIMITS.toolCallDetailGraphemes)))
                    || (message.role === 'thinking'
                        && Boolean(message.thinking)
                        && typeof message.thinking.text === 'string'
                        && countGraphemes(message.thinking.text)
                            <= CONVERSATION_LIMITS.maxMessageGraphemes))
                && (message.timestamp === undefined
                    || (typeof message.timestamp === 'number'
                        && Number.isFinite(message.timestamp)))
                && typeof message.markdown === 'string'
                && countGraphemes(message.markdown)
                    <= CONVERSATION_LIMITS.maxMessageGraphemes
            ))
            || !isDenseOwnArray(page.interactionStates)
            || !page.interactionStates.length
            || page.interactionStates.length > CONVERSATION_LIMITS.maxPageInteractions
            || !page.interactionStates.every(state => (
                Boolean(state)
                && typeof state.interactionId === 'string'
                && Boolean(state.interactionId)
                && isResponseState(state.responseState)
            ))
            || (page.previousCursor !== undefined
                && typeof page.previousCursor !== 'string')
            || (page.nextCursor !== undefined
                && typeof page.nextCursor !== 'string')
            || typeof page.isStart !== 'boolean'
            || typeof page.isEnd !== 'boolean') {
            throw new ConversationError('unavailable');
        }
        const interactionIds = page.interactionStates.map(
            state => state.interactionId
        );
        const messageIds = page.messages.map(message => message.id);
        const interactionIdSet = new Set(interactionIds);
        if (!hasUniqueValues(interactionIds)
            || !hasUniqueValues(messageIds)
            || !interactionIdSet.has(page.anchorInteractionId)
            || !page.messages.every(message =>
                interactionIdSet.has(message.interactionId))
            || page.isStart !== (page.previousCursor === undefined)
            || page.isEnd !== (page.nextCursor === undefined)) {
            throw new ConversationError('unavailable');
        }
    }

    private toSafeError(
        provider: AiSessionProviderId,
        error: unknown
    ): ConversationError | ConversationAbortError {
        if (error instanceof ConversationAbortError
            || (Boolean(error)
                && typeof error === 'object'
                && (error as { name?: unknown }).name === 'AbortError')) {
            return new ConversationAbortError();
        }
        if (error instanceof ConversationError && PUBLIC_ERROR_CODES.has(error.code)) {
            this.emitDiagnostic(provider, this.categoryForError(error.code));
            return new ConversationError(
                error.code,
                PUBLIC_ERROR_REASONS.has(error.reason) ? error.reason : undefined,
                Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0
                    ? error.retryAfterMs
                    : undefined
            );
        }
        this.emitDiagnostic(provider, 'unavailable');
        return new ConversationError('unavailable');
    }

    private categoryForError(
        code: ConversationError['code']
    ): SanitizedConversationDiagnostic['category'] {
        switch (code) {
            case 'timeout':
                return 'timeout';
            case 'tooLarge':
                return 'oversized';
            case 'unsupportedVersion':
                return 'protocol';
            case 'staleRevision':
                return 'malformed';
            default:
                return 'unavailable';
        }
    }

    private emitDiagnostic(
        provider: AiSessionProviderId,
        category: SanitizedConversationDiagnostic['category']
    ): void {
        try {
            this.options.onDiagnostic?.({
                event: 'conversation-read',
                provider,
                category,
            });
        } catch (_error) {
            // Diagnostic sinks cannot affect conversation reads.
        }
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }

    private setTimer(callback: () => void, delayMs: number): TimerHandle {
        return this.options.setTimeout
            ? this.options.setTimeout(callback, delayMs)
            : setTimeout(callback, delayMs);
    }

    private clearTimer(handle: TimerHandle): void {
        if (this.options.clearTimeout) {
            this.options.clearTimeout(handle);
        } else {
            clearTimeout(handle as NodeJS.Timeout);
        }
    }
}

function isResponseState(value: unknown): boolean {
    return value === 'complete'
        || value === 'inProgress'
        || value === 'interrupted'
        || value === 'unknown';
}

function isDenseOwnArray(value: unknown): value is unknown[] {
    if (!Array.isArray(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            return false;
        }
    }
    return true;
}

function hasUniqueValues(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

function throwIfAborted(signal?: ConversationAbortSignal): void {
    if (signal?.aborted) {
        throw new ConversationAbortError();
    }
}
