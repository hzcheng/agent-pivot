'use strict';

import { createHash } from 'crypto';
import type { AiSessionDisposable } from '../types';
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
} from './types';

type TimerHandle = unknown;

export interface CodexConversationClient extends AiSessionDisposable {
    request<T = unknown>(
        method: string,
        params: unknown,
        signal?: ConversationAbortSignal
    ): Promise<T>;
}

export interface CodexConversationAdapterOptions {
    client: CodexConversationClient;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

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
    sessionId: string
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
        let currentInteractionIndex: number | undefined;
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

export class CodexConversationAdapter implements ConversationProviderAdapter {
    private readonly subscriptions = new Map<string, Set<() => void>>();
    private providerWatch?: AiSessionDisposable;
    private invalidationTimer?: TimerHandle;
    private disposed = false;

    constructor(private readonly options: CodexConversationAdapterOptions) {}

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
        this.subscriptions.clear();
        this.options.client.dispose();
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
        let result: unknown;
        try {
            result = await this.options.client.request('thread/read', {
                threadId: sessionId,
                includeTurns: true,
            }, signal);
        } catch (error) {
            if (error instanceof ConversationError
                || error?.name === 'AbortError') {
                throw error;
            }
            throw protocolError();
        }
        let interactions: ConversationInteraction[];
        try {
            interactions = normalizeThreadRead(result, sessionId);
        } catch (_error) {
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
