'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    CONVERSATION_LIMITS,
    ConversationError,
    ConversationAssistantPhase,
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

export function applyActiveLifecycleToResponseState(
    state: ConversationResponseState,
    active: boolean,
    latest: boolean
): ConversationResponseState {
    return active && latest
        ? 'inProgress'
        : state;
}

export function appendConversationAssistantText(
    interaction: ConversationInteraction,
    markdown: string,
    phase: ConversationAssistantPhase = 'answer'
): void {
    const index = interaction.assistantMarkdown.length;
    interaction.assistantMarkdown.push(markdown);
    if (phase === 'progress' && !interaction.assistantPhases) {
        interaction.assistantPhases = Array(index).fill('answer');
    }
    interaction.assistantPhases?.push(phase);
}

function assistantPhase(
    interaction: ConversationInteraction,
    index: number
): ConversationAssistantPhase {
    const explicit = interaction.assistantPhases?.[index];
    if (explicit) {
        return explicit;
    }
    return interaction.toolCalls?.some(toolCall => toolCall.position > index)
        ? 'progress'
        : 'answer';
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
    const messagesForInteraction = (
        interaction: ConversationInteraction
    ): ConversationMessage[] => {
        const messages: ConversationMessage[] = [{
            id: `${interaction.id}:user`,
            interactionId: interaction.id,
            role: 'user',
            timestamp: interaction.timestamp,
            markdown: interaction.userMarkdown,
        }];
        const toolCalls = interaction.toolCalls || [];
        const thinkingBlocks = interaction.thinking || [];
        const planBlocks = interaction.plans || [];
        const questionBlocks = interaction.questions || [];
        const pushAnchoredAt = (position: number): void => {
            planBlocks.forEach((block, blockIndex) => {
                if (block.position !== position) {
                    return;
                }
                messages.push({
                    id: `${interaction.id}:plan:${blockIndex}`,
                    interactionId: interaction.id,
                    role: 'plan',
                    timestamp: interaction.timestamp,
                    markdown: '',
                    plan: {
                        markdown: block.markdown,
                        ...(block.filePath !== undefined
                            ? { filePath: block.filePath }
                            : {}),
                    },
                });
            });
            questionBlocks.forEach((block, blockIndex) => {
                if (block.position !== position) {
                    return;
                }
                messages.push({
                    id: `${interaction.id}:question:${blockIndex}`,
                    interactionId: interaction.id,
                    role: 'question',
                    timestamp: interaction.timestamp,
                    markdown: '',
                    question: {
                        source: block.source,
                        questions: block.questions.map(item => ({
                            question: item.question,
                            ...(item.header !== undefined
                                ? { header: item.header }
                                : {}),
                            options: item.options.map(option => ({
                                label: option.label,
                                ...(option.description !== undefined
                                    ? { description: option.description }
                                    : {}),
                            })),
                            multiSelect: item.multiSelect,
                            ...(item.otherLabel !== undefined
                                ? { otherLabel: item.otherLabel }
                                : {}),
                            ...(item.answers !== undefined
                                ? { answers: [...item.answers] }
                                : {}),
                        })),
                        ...(block.outcome !== undefined
                            ? { outcome: block.outcome }
                            : {}),
                    },
                });
            });
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
            thinkingBlocks.forEach((block, blockIndex) => {
                if (block.position !== position) {
                    return;
                }
                messages.push({
                    id: `${interaction.id}:thinking:${blockIndex}`,
                    interactionId: interaction.id,
                    role: 'thinking',
                    timestamp: interaction.timestamp,
                    markdown: '',
                    thinking: { text: block.text },
                });
            });
        };
        interaction.assistantMarkdown.forEach((markdown, index) => {
            pushAnchoredAt(index);
            const phase = assistantPhase(interaction, index);
            messages.push({
                id: `${interaction.id}:${phase === 'progress'
                    ? 'progress'
                    : 'assistant'}:${index}`,
                interactionId: interaction.id,
                role: phase === 'progress' ? 'progress' : 'assistant',
                timestamp: interaction.timestamp,
                markdown,
            });
        });
        pushAnchoredAt(interaction.assistantMarkdown.length);
        return messages;
    };
    const blocks = new Map<number, {
        messages: ConversationMessage[];
        state: {
            interactionId: string;
            responseState: ConversationResponseState;
            timestamp?: number;
            completedAt?: number;
        };
        serializedBytes: number;
    }>();
    let estimatedBytes = 0;
    for (let index = start; index < end; index += 1) {
        const interaction = interactions[index];
        const block = {
            messages: messagesForInteraction(interaction),
            state: {
                interactionId: interaction.id,
                responseState: interaction.responseState,
                ...(interaction.timestamp !== undefined
                    ? { timestamp: interaction.timestamp }
                    : {}),
                ...(interaction.completedAt !== undefined
                    ? { completedAt: interaction.completedAt }
                    : {}),
            },
            serializedBytes: 0,
        };
        block.serializedBytes = Buffer.byteLength(JSON.stringify({
            messages: block.messages,
            state: block.state,
        }), 'utf8');
        blocks.set(index, block);
        estimatedBytes += block.serializedBytes;
    }
    const shrinkRange = (): void => {
        let removedIndex: number;
        if (request.direction === 'before') {
            removedIndex = start;
            start += 1;
        } else if (request.direction === 'after') {
            end -= 1;
            removedIndex = end;
        } else if (anchorIndex - start > end - 1 - anchorIndex) {
            removedIndex = start;
            start += 1;
        } else {
            end -= 1;
            removedIndex = end;
        }
        estimatedBytes -= blocks.get(removedIndex)?.serializedBytes || 0;
    };
    const PAGE_ENVELOPE_RESERVE_BYTES = 2 * 1024;
    while (estimatedBytes
        > CONVERSATION_LIMITS.maxPageBytes - PAGE_ENVELOPE_RESERVE_BYTES
        && end - start > 1) {
        shrinkRange();
    }
    const makePage = (): ConversationPage => {
        const messages: ConversationMessage[] = [];
        const interactionStates: Array<{
            interactionId: string;
            responseState: ConversationResponseState;
            timestamp?: number;
            completedAt?: number;
        }> = [];
        for (let index = start; index < end; index += 1) {
            const block = blocks.get(index)!;
            for (const message of block.messages) {
                messages.push(message);
            }
            interactionStates.push(block.state);
        }
        return {
            provider: request.provider,
            sessionId: request.sessionId,
            sourceRevision,
            anchorInteractionId: request.direction === 'around'
                ? request.anchorInteractionId
                : pageAnchorInteractionId,
            messages,
            interactionStates,
            previousCursor: start > 0
                ? encodeCursor(interactions[start].id, 'before')
                : undefined,
            nextCursor: end < interactions.length
                ? encodeCursor(interactions[end - 1].id, 'after')
                : undefined,
            isStart: start === 0,
            isEnd: end === interactions.length,
        };
    };
    let page = makePage();
    let pageBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    while (pageBytes > CONVERSATION_LIMITS.maxPageBytes
        && end - start > 1) {
        shrinkRange();
        page = makePage();
        pageBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    }
    if (pageBytes > CONVERSATION_LIMITS.maxPageBytes) {
        throw new ConversationError('tooLarge');
    }
    return page;
}
