'use strict';

import type { AiSessionProviderId } from '../../models';
import { getAiSessionKey } from '../sessionHelpers';
import {
    ConversationCoordinator,
    ConversationCoordinatorSubscription,
} from './coordinator';
import {
    CONVERSATION_LIMITS,
    ConversationAbortController,
    ConversationError,
    ConversationOutline,
    ConversationPublicError,
    ConversationResponseEnvelope,
} from './types';

export interface AiSessionConversationOutlineRequestMessage {
    type: 'request-ai-session-conversation-outline';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface AiSessionConversationOutlineResultMessage
    extends ConversationResponseEnvelope<ConversationOutline> {
    type: 'ai-session-conversation-outline-result';
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface AiSessionConversationOpenMessage {
    type: 'open-ai-session-conversation';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
}

export interface AiSessionConversationCancelMessage {
    type: 'cancel-ai-session-conversation';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ConversationViewerOpenTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
}

export interface ConversationAuthoritativeTarget {
    projectId?: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    focused: boolean;
    executionState?: string;
    [key: string]: unknown;
}

export interface ConversationHostControllerOptions {
    coordinator: ConversationCoordinator;
    resolveTarget: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string
    ) => ConversationAuthoritativeTarget | null;
    publish: (
        message: AiSessionConversationOutlineResultMessage
    ) => void | PromiseLike<unknown>;
    openViewer: (
        target: ConversationViewerOpenTarget,
        authoritativeTarget: ConversationAuthoritativeTarget
    ) => void | PromiseLike<void>;
}

interface OutlineSubscriptionState {
    identity: string;
    request: AiSessionConversationOutlineRequestMessage;
    readSequence: number;
    abortController: ConversationAbortController;
    subscription?: ConversationCoordinatorSubscription;
    outline?: ConversationOutline;
}

const OUTLINE_KEYS = new Set([
    'type',
    'version',
    'requestId',
    'subscriptionGeneration',
    'projectId',
    'provider',
    'sessionId',
]);

const OPEN_KEYS = new Set([
    ...OUTLINE_KEYS,
    'interactionId',
    'expectedRevision',
]);

export class ConversationHostController {
    private readonly states = new Map<string, OutlineSubscriptionState>();
    private readonly generationFloors = new Map<string, number>();
    private visible = true;
    private disposed = false;

    constructor(private readonly options: ConversationHostControllerOptions) {}

    async handleOutline(message: unknown): Promise<void> {
        const request = parseOutlineRequest(message);
        if (!request || this.disposed || !this.visible) {
            return;
        }
        const identity = getControllerIdentity(request);
        const generationFloor = this.generationFloors.get(identity);
        const current = this.states.get(identity);
        if ((generationFloor !== undefined
                && request.subscriptionGeneration < generationFloor)
            || (current
                && (request.subscriptionGeneration < current.request.subscriptionGeneration
                    || (request.subscriptionGeneration
                            === current.request.subscriptionGeneration
                        && request.requestId <= current.request.requestId)))) {
            return;
        }

        this.generationFloors.set(
            identity,
            Math.max(generationFloor || 0, request.subscriptionGeneration)
        );
        if (current) {
            this.cancelState(current);
        }
        const state: OutlineSubscriptionState = {
            identity,
            request,
            readSequence: 0,
            abortController: new ConversationAbortController(),
        };
        this.states.set(identity, state);

        const target = this.resolveFocusedTarget(request);
        if (!target) {
            await this.publishErrorIfCurrent(state, new ConversationError('unavailable'));
            this.removeStateIfCurrent(state);
            return;
        }
        this.options.coordinator.setSessionStopped(
            request.provider,
            request.sessionId,
            target.executionState === 'stopped'
        );
        await this.refreshState(state, true);
    }

    async handleOpen(message: unknown): Promise<void> {
        const request = parseOpenRequest(message);
        if (!request || this.disposed) {
            return;
        }
        const identity = getControllerIdentity(request);
        const state = this.states.get(identity);
        if (!state
            || request.subscriptionGeneration
                !== state.request.subscriptionGeneration
            || request.expectedRevision !== state.outline?.sourceRevision
            || !state.outline.interactions.some(
                interaction => interaction.id === request.interactionId
            )) {
            return;
        }
        const target = this.resolveExactTarget(request);
        if (!target) {
            return;
        }
        try {
            await this.options.openViewer({
                projectId: request.projectId,
                provider: request.provider,
                sessionId: request.sessionId,
                interactionId: request.interactionId,
                expectedRevision: request.expectedRevision,
            }, target);
        } catch (_error) {
            // Viewer failures remain isolated from the sidebar message router.
        }
    }

    cancel(message: unknown): void {
        const request = parseCancelRequest(message);
        if (!request || this.disposed) {
            return;
        }
        const identity = getControllerIdentity(request);
        const current = this.states.get(identity);
        if (!current
            || request.subscriptionGeneration
                <= current.request.subscriptionGeneration) {
            return;
        }
        this.generationFloors.set(identity, request.subscriptionGeneration);
        this.cancelState(current);
    }

    reconcile(): void {
        if (this.disposed) {
            return;
        }
        for (const state of Array.from(this.states.values())) {
            const target = this.resolveFocusedTarget(state.request);
            if (!target) {
                this.generationFloors.set(
                    state.identity,
                    Math.max(
                        this.generationFloors.get(state.identity) || 0,
                        state.request.subscriptionGeneration + 1
                    )
                );
                this.cancelState(state);
                continue;
            }
            this.options.coordinator.setSessionStopped(
                state.request.provider,
                state.request.sessionId,
                target.executionState === 'stopped'
            );
        }
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) {
            return;
        }
        this.visible = visible;
        if (!visible) {
            this.cancelAll();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.visible = false;
        this.cancelAll();
        this.generationFloors.clear();
    }

    private async refreshState(
        state: OutlineSubscriptionState,
        initial: boolean
    ): Promise<void> {
        if (!this.isCurrent(state)) {
            return;
        }
        state.abortController.abort();
        const abortController = new ConversationAbortController();
        state.abortController = abortController;
        const readSequence = ++state.readSequence;
        try {
            const outline = await this.options.coordinator.readOutline(
                state.request.provider,
                state.request.sessionId,
                abortController.signal
            );
            if (!this.isCurrent(state, readSequence)
                || outline.provider !== state.request.provider
                || outline.sessionId !== state.request.sessionId) {
                return;
            }
            const target = this.resolveFocusedTarget(state.request);
            if (!target || !this.isCurrent(state, readSequence)) {
                this.removeStateIfCurrent(state);
                return;
            }
            this.options.coordinator.setSessionStopped(
                state.request.provider,
                state.request.sessionId,
                target.executionState === 'stopped'
            );
            const delivered = await this.publishIfCurrent(state, outline, readSequence);
            if (!delivered || !this.isCurrent(state, readSequence)) {
                if (initial) {
                    this.removeStateIfCurrent(state);
                }
                return;
            }
            state.outline = outline;
            if (initial && !state.subscription) {
                try {
                    state.subscription = this.options.coordinator.watch(
                        state.request.provider,
                        state.request.sessionId,
                        () => {
                            void this.refreshState(state, false);
                        }
                    );
                } catch (_error) {
                    // A watch failure does not invalidate a successful bounded read.
                }
            }
        } catch (error) {
            if (!this.isCurrent(state, readSequence)
                || isAbortError(error)) {
                return;
            }
            if (!this.resolveFocusedTarget(state.request)) {
                this.removeStateIfCurrent(state);
                return;
            }
            await this.publishErrorIfCurrent(state, toPublicConversationError(error));
            if (initial) {
                this.removeStateIfCurrent(state);
            }
        }
    }

    private async publishIfCurrent(
        state: OutlineSubscriptionState,
        outline: ConversationOutline,
        readSequence: number
    ): Promise<boolean> {
        if (!this.isCurrent(state, readSequence)) {
            return false;
        }
        return this.publish({
            type: 'ai-session-conversation-outline-result',
            version: 1,
            requestId: state.request.requestId,
            subscriptionGeneration: state.request.subscriptionGeneration,
            projectId: state.request.projectId,
            provider: state.request.provider,
            sessionId: state.request.sessionId,
            payload: outline,
        });
    }

    private async publishErrorIfCurrent(
        state: OutlineSubscriptionState,
        error: ConversationError
    ): Promise<boolean> {
        if (!this.isCurrent(state)) {
            return false;
        }
        return this.publish({
            type: 'ai-session-conversation-outline-result',
            version: 1,
            requestId: state.request.requestId,
            subscriptionGeneration: state.request.subscriptionGeneration,
            projectId: state.request.projectId,
            provider: state.request.provider,
            sessionId: state.request.sessionId,
            error: error.toPublicError(),
        });
    }

    private async publish(
        message: AiSessionConversationOutlineResultMessage
    ): Promise<boolean> {
        try {
            await this.options.publish(message);
            return true;
        } catch (_error) {
            return false;
        }
    }

    private resolveFocusedTarget(
        request: Pick<
            AiSessionConversationOutlineRequestMessage,
            'projectId' | 'provider' | 'sessionId'
        >
    ): ConversationAuthoritativeTarget | null {
        const target = this.resolveExactTarget(request);
        return target?.focused === true ? target : null;
    }

    private resolveExactTarget(
        request: Pick<
            AiSessionConversationOutlineRequestMessage,
            'projectId' | 'provider' | 'sessionId'
        >
    ): ConversationAuthoritativeTarget | null {
        let target: ConversationAuthoritativeTarget;
        try {
            target = this.options.resolveTarget(
                request.projectId,
                request.provider,
                request.sessionId
            );
        } catch (_error) {
            return null;
        }
        if (!target
            || target.provider !== request.provider
            || target.sessionId !== request.sessionId
            || (target.projectId !== undefined
                && target.projectId !== request.projectId)) {
            return null;
        }
        return target;
    }

    private isCurrent(
        state: OutlineSubscriptionState,
        readSequence?: number
    ): boolean {
        return !this.disposed
            && this.visible
            && this.states.get(state.identity) === state
            && (readSequence === undefined || state.readSequence === readSequence);
    }

    private cancelState(state: OutlineSubscriptionState): void {
        if (this.states.get(state.identity) === state) {
            this.states.delete(state.identity);
        }
        state.abortController.abort();
        if (state.subscription) {
            this.options.coordinator.releaseSubscription(state.subscription);
            state.subscription = undefined;
        }
        state.outline = undefined;
    }

    private removeStateIfCurrent(state: OutlineSubscriptionState): void {
        if (this.states.get(state.identity) === state) {
            this.cancelState(state);
        }
    }

    private cancelAll(): void {
        for (const state of Array.from(this.states.values())) {
            this.generationFloors.set(
                state.identity,
                Math.max(
                    this.generationFloors.get(state.identity) || 0,
                    state.request.subscriptionGeneration + 1
                )
            );
            this.cancelState(state);
        }
    }
}

function parseOutlineRequest(
    message: unknown
): AiSessionConversationOutlineRequestMessage | null {
    if (!hasExactKeys(message, OUTLINE_KEYS)
        || message.type !== 'request-ai-session-conversation-outline') {
        return null;
    }
    const envelope = parseIdentityEnvelope(message);
    return envelope
        ? { type: 'request-ai-session-conversation-outline', ...envelope }
        : null;
}

function parseOpenRequest(message: unknown): AiSessionConversationOpenMessage | null {
    if (!hasExactKeys(message, OPEN_KEYS)
        || message.type !== 'open-ai-session-conversation') {
        return null;
    }
    const envelope = parseIdentityEnvelope(message);
    const interactionId = parseNonEmptyString(message.interactionId);
    const expectedRevision = parseNonEmptyString(message.expectedRevision);
    return envelope && interactionId && expectedRevision
        ? {
            type: 'open-ai-session-conversation',
            ...envelope,
            interactionId,
            expectedRevision,
        }
        : null;
}

function parseCancelRequest(
    message: unknown
): AiSessionConversationCancelMessage | null {
    if (!hasExactKeys(message, OUTLINE_KEYS)
        || message.type !== 'cancel-ai-session-conversation') {
        return null;
    }
    const envelope = parseIdentityEnvelope(message);
    return envelope
        ? { type: 'cancel-ai-session-conversation', ...envelope }
        : null;
}

function parseIdentityEnvelope(message: Record<string, unknown>): Omit<
    AiSessionConversationOutlineRequestMessage,
    'type'
> | null {
    if (message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || Number(message.requestId) < CONVERSATION_LIMITS.minRequestId
        || !Number.isSafeInteger(message.subscriptionGeneration)
        || Number(message.subscriptionGeneration) < 0
        || !isProvider(message.provider)) {
        return null;
    }
    const projectId = parseNonEmptyString(message.projectId);
    const sessionId = parseNonEmptyString(message.sessionId);
    if (!projectId || !sessionId) {
        return null;
    }
    return {
        version: 1,
        requestId: Number(message.requestId),
        subscriptionGeneration: Number(message.subscriptionGeneration),
        projectId,
        provider: message.provider,
        sessionId,
    };
}

function hasExactKeys(
    value: unknown,
    expectedKeys: Set<string>
): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length === expectedKeys.size
        && keys.every(key => expectedKeys.has(key));
}

function parseNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}

function isProvider(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function getControllerIdentity(request: {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}): string {
    return `${request.projectId.length}:${request.projectId}:${
        getAiSessionKey(request.provider, request.sessionId)
    }`;
}

function isAbortError(error: unknown): boolean {
    return Boolean(error)
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'AbortError';
}

function toPublicConversationError(error: unknown): ConversationError {
    if (error instanceof ConversationError) {
        const publicError: ConversationPublicError = error.toPublicError();
        return new ConversationError(
            publicError.code,
            publicError.reason,
            publicError.retryAfterMs
        );
    }
    return new ConversationError('unavailable');
}
