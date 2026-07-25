'use strict';

import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';

export const CONVERSATION_LIMITS = Object.freeze({
    previewGraphemes: 160,
    maxOutlineInteractions: 2_000,
    maxPageInteractions: 20,
    maxPageBytes: 512 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    readChunkBytes: 256 * 1024,
    yieldEveryBytes: 4 * 1024 * 1024,
    maxLineBytes: 1024 * 1024,
    jsonlScanTimeoutMs: 5_000,
    maxMessageGraphemes: 64_000,
    maxViewerInteractions: 100,
    maxViewerBytes: 4 * 1024 * 1024,
    maxCodexResponseBytes: 16 * 1024 * 1024,
    codexRequestTimeoutMs: 10_000,
    invalidationDebounceMs: 250,
    invalidationMinIntervalMs: 1_000,
    autoScrollThresholdPx: 8,
    minRequestId: 1,
    inactiveIndexLimitPerProvider: 8,
    inactiveIndexTtlMs: 10 * 60 * 1000,
});

export type ConversationResponseState =
    'complete' | 'inProgress' | 'interrupted' | 'unknown';

export interface ConversationInteraction {
    id: string;
    providerTurnId?: string;
    timestamp?: number;
    userMarkdown: string;
    userPreview: string;
    userGraphemeCount: number;
    assistantMarkdown: string[];
    responseState: ConversationResponseState;
}

export interface ConversationOutline {
    provider: AiSessionProviderId;
    sessionId: string;
    sourceRevision: string;
    interactions: Array<Omit<ConversationInteraction,
        'userMarkdown' | 'assistantMarkdown'>>;
    totalInteractions: number;
    partial: boolean;
}

export interface ConversationPageRequest {
    provider: AiSessionProviderId;
    sessionId: string;
    anchorInteractionId: string;
    direction: 'around' | 'before' | 'after';
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
}

export interface ConversationMessage {
    id: string;
    interactionId: string;
    role: 'user' | 'assistant';
    timestamp?: number;
    markdown: string;
}

export interface ConversationPage {
    provider: AiSessionProviderId;
    sessionId: string;
    sourceRevision: string;
    anchorInteractionId: string;
    messages: ConversationMessage[];
    interactionStates: Array<{
        interactionId: string;
        responseState: ConversationResponseState;
    }>;
    previousCursor?: string;
    nextCursor?: string;
    isStart: boolean;
    isEnd: boolean;
}

export interface ConversationPublicError {
    code: 'unavailable' | 'staleRevision' | 'unsupportedVersion'
        | 'tooLarge' | 'timeout';
    reason?: 'missingSource' | 'updateCodex' | 'unsupportedCodexProtocol'
        | 'reconnectingCodex' | 'codexRetryExhausted';
    retryAfterMs?: number;
}

export class ConversationError extends Error {
    constructor(
        readonly code: ConversationPublicError['code'],
        readonly reason?: ConversationPublicError['reason'],
        readonly retryAfterMs?: number
    ) {
        super(code);
        this.name = 'ConversationError';
    }

    toPublicError(): ConversationPublicError {
        return {
            code: this.code,
            reason: this.reason,
            retryAfterMs: this.retryAfterMs,
        };
    }
}

export class ConversationAbortError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

export interface ConversationRequestEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload: T;
}

export interface ConversationResponseEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload?: T;
    error?: ConversationPublicError;
}

export interface SanitizedConversationDiagnostic {
    event: 'conversation-source' | 'conversation-read'
        | 'codex-conversation-app-server';
    provider?: AiSessionProviderId;
    category: 'spawn' | 'timeout' | 'protocol' | 'oversized' | 'exit'
        | 'unavailable' | 'malformed' | 'partial';
    count?: number;
    durationMs?: number;
    version?: string;
}

export interface ConversationAbortSignal {
    readonly aborted: boolean;
    onAbort(listener: () => void): AiSessionDisposable;
}

export class ConversationAbortController {
    private abortedValue = false;
    private readonly listeners = new Set<() => void>();
    readonly signal: ConversationAbortSignal;

    constructor() {
        const controller = this;
        this.signal = {
            get aborted(): boolean {
                return controller.abortedValue;
            },
            onAbort(listener: () => void): AiSessionDisposable {
                return controller.subscribe(listener);
            },
        };
    }

    abort(): void {
        if (this.abortedValue) {
            return;
        }
        this.abortedValue = true;
        const listeners = Array.from(this.listeners);
        this.listeners.clear();
        listeners.forEach(listener => listener());
    }

    private subscribe(listener: () => void): AiSessionDisposable {
        if (this.abortedValue) {
            listener();
            return { dispose() {} };
        }
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }
}

export interface ConversationProviderAdapter extends AiSessionDisposable {
    readOutline(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline>;
    readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage>;
    watch(sessionId: string, onChange: () => void): AiSessionDisposable;
}
