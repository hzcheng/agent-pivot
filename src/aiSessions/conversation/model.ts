'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    CONVERSATION_LIMITS,
    ConversationError,
    ConversationInteraction,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationResponseState,
} from './types';

export type EncodeConversationCursor = (
    anchorInteractionId: string,
    direction: 'before' | 'after'
) => string;

export function buildConversationOutline(
    provider: AiSessionProviderId,
    sessionId: string,
    sourceRevision: string,
    interactions: readonly ConversationInteraction[],
    partial: boolean
): ConversationOutline {
    const summaries = interactions.map(interaction => ({
        id: interaction.id,
        providerTurnId: interaction.providerTurnId,
        timestamp: interaction.timestamp,
        userPreview: interaction.userPreview,
        userGraphemeCount: interaction.userGraphemeCount,
        responseState: interaction.responseState,
    }));
    return {
        provider,
        sessionId,
        sourceRevision,
        interactions: summaries.slice(-CONVERSATION_LIMITS.maxOutlineInteractions),
        totalInteractions: summaries.length,
        partial: partial
            || summaries.length > CONVERSATION_LIMITS.maxOutlineInteractions,
    };
}

export function applyStoppedLifecycleToResponseState(
    state: ConversationResponseState,
    stopped: boolean
): ConversationResponseState {
    return stopped && state === 'inProgress' ? 'interrupted' : state;
}

export function buildConversationPage(
    interactions: readonly ConversationInteraction[],
    request: ConversationPageRequest,
    sourceRevision: string,
    encodeCursor: EncodeConversationCursor = () => ''
): ConversationPage {
    if (request.expectedRevision && request.expectedRevision !== sourceRevision) {
        throw new ConversationError('staleRevision');
    }
    const anchorIndex = interactions.findIndex(
        interaction => interaction.id === request.anchorInteractionId
    );
    if (anchorIndex < 0) {
        throw new ConversationError('staleRevision');
    }
    const limit = Math.max(1, Math.min(
        CONVERSATION_LIMITS.maxPageInteractions,
        Math.floor(request.limit || CONVERSATION_LIMITS.maxPageInteractions)
    ));
    let start: number;
    let end: number;
    if (request.direction === 'before') {
        end = anchorIndex;
        start = Math.max(0, end - limit);
    } else if (request.direction === 'after') {
        start = anchorIndex + 1;
        end = Math.min(interactions.length, start + limit);
    } else {
        start = Math.max(0, anchorIndex - Math.floor((limit - 1) / 2));
        end = Math.min(interactions.length, start + limit);
        start = Math.max(0, end - limit);
    }
    if (start >= end) {
        throw new ConversationError('staleRevision');
    }
    const pageAnchorInteractionId = request.direction === 'before'
        ? interactions[end - 1].id
        : interactions[start].id;
    const messagesForRange = (): ConversationMessage[] => interactions.slice(start, end).reduce(
        (messages: ConversationMessage[], interaction) => {
            messages.push({
                id: `${interaction.id}:user`,
                interactionId: interaction.id,
                role: 'user',
                timestamp: interaction.timestamp,
                markdown: interaction.userMarkdown,
            });
            const toolCalls = interaction.toolCalls || [];
            const pushToolCallsAt = (position: number): void => {
                toolCalls.forEach((toolCall, toolIndex) => {
                    if (toolCall.position !== position) {
                        return;
                    }
                    messages.push({
                        id: `${interaction.id}:tool:${toolIndex}`,
                        interactionId: interaction.id,
                        role: 'tool',
                        timestamp: interaction.timestamp,
                        markdown: '',
                        tool: {
                            name: toolCall.name,
                            summary: toolCall.summary,
                            ...(toolCall.detail !== undefined
                                ? { detail: toolCall.detail }
                                : {}),
                        },
                    });
                });
            };
            interaction.assistantMarkdown.forEach((markdown, index) => {
                pushToolCallsAt(index);
                messages.push({
                    id: `${interaction.id}:assistant:${index}`,
                    interactionId: interaction.id,
                    role: 'assistant',
                    timestamp: interaction.timestamp,
                    markdown,
                });
            });
            pushToolCallsAt(interaction.assistantMarkdown.length);
            return messages;
        },
        []
    );
    const makePage = (): ConversationPage => ({
        provider: request.provider,
        sessionId: request.sessionId,
        sourceRevision,
        anchorInteractionId: request.direction === 'around'
            ? request.anchorInteractionId
            : pageAnchorInteractionId,
        messages: messagesForRange(),
        interactionStates: interactions.slice(start, end).map(interaction => ({
            interactionId: interaction.id,
            responseState: interaction.responseState,
        })),
        previousCursor: start > 0 ? encodeCursor(interactions[start].id, 'before') : undefined,
        nextCursor: end < interactions.length
            ? encodeCursor(interactions[end - 1].id, 'after')
            : undefined,
        isStart: start === 0,
        isEnd: end === interactions.length,
    });
    let page = makePage();
    while (Buffer.byteLength(JSON.stringify(page), 'utf8') > CONVERSATION_LIMITS.maxPageBytes
        && end - start > 1) {
        if (request.direction === 'before') {
            start += 1;
        } else if (request.direction === 'after') {
            end -= 1;
        } else if (anchorIndex - start > end - 1 - anchorIndex) {
            start += 1;
        } else {
            end -= 1;
        }
        page = makePage();
    }
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > CONVERSATION_LIMITS.maxPageBytes) {
        throw new ConversationError('tooLarge');
    }
    return page;
}
