'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    CONVERSATION_LIMITS,
    ConversationError,
    ConversationAssistantPhase,
    ConversationFileDiff,
    ConversationInteraction,
    ConversationMessage,
    ConversationOutline,
    ConversationPage,
    ConversationPageRequest,
    ConversationResponseState,
} from './types';
import { truncateUtf8Bytes } from './text';

export type EncodeConversationCursor = (
    anchorInteractionId: string,
    direction: 'before' | 'after'
) => string;

const PAGE_ENVELOPE_RESERVE_BYTES = 2 * 1024;
const OVERSIZED_TURN_OMISSION =
    'Work was omitted to keep this turn within the conversation size limit.';

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

/**
 * Deep-copies bounded file diffs. Shared by the page builder and the
 * message copy boundary so diffs survive every protocol hop.
 */
export function copyConversationDiffs(
    diffs: readonly ConversationFileDiff[]
): ConversationFileDiff[] {
    return diffs.map(diff => ({
        path: diff.path,
        ...(diff.kind !== undefined ? { kind: diff.kind } : {}),
        additions: diff.additions,
        deletions: diff.deletions,
        hunks: diff.hunks.map(hunk => ({
            ...(hunk.oldStart !== undefined
                ? { oldStart: hunk.oldStart }
                : {}),
            ...(hunk.newStart !== undefined
                ? { newStart: hunk.newStart }
                : {}),
            lines: hunk.lines.map(line => ({
                type: line.type,
                text: line.text,
            })),
            ...(hunk.truncatedLines !== undefined
                ? { truncatedLines: hunk.truncatedLines }
                : {}),
        })),
    }));
}

/**
 * Single deep-copy boundary for page messages. Every hop that re-emits a
 * message (coordinator transform, viewer publication) must go through this
 * so a new payload field cannot be silently dropped by one whitelist.
 */
export function copyConversationMessage(
    message: ConversationMessage
): ConversationMessage {
    return {
        id: message.id,
        interactionId: message.interactionId,
        role: message.role,
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
                    ...(message.tool.diffs
                        ? { diffs: copyConversationDiffs(message.tool.diffs) }
                        : {}),
                },
            }
            : {}),
        ...(message.thinking
            ? { thinking: { text: message.thinking.text } }
            : {}),
        ...(message.plan
            ? {
                plan: {
                    markdown: message.plan.markdown,
                    ...(message.plan.filePath !== undefined
                        ? { filePath: message.plan.filePath }
                        : {}),
                },
            }
            : {}),
        ...(message.question
            ? {
                question: {
                    source: message.question.source,
                    questions: message.question.questions.map(item => ({
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
                    ...(message.question.outcome !== undefined
                        ? { outcome: message.question.outcome }
                        : {}),
                },
            }
            : {}),
    };
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

function serializedMessageBytes(message: ConversationMessage): number {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

/** Free-form display content eligible for byte-budget truncation. */
const CONTENT_STRING_FIELDS = new Set([
    'markdown',
    'text',
    'detail',
    'question',
    'label',
    'description',
    'otherLabel',
]);

function contentStringFields(
    value: unknown,
    fields: Array<{
        get(): string;
        set(value: string): void;
    }> = []
): Array<{ get(): string; set(value: string): void }> {
    if (!value || typeof value !== 'object') {
        return fields;
    }
    const record = value as Record<string, any>;
    for (const property of Object.keys(record)) {
        const child = record[property];
        if (typeof child === 'string') {
            // Only content fields shrink. Identifiers and structural
            // strings (tool names, diff paths, plan file paths, question
            // sources, outcomes) must survive bounding verbatim.
            if (CONTENT_STRING_FIELDS.has(property)) {
                fields.push({
                    get: () => record[property],
                    set: next => {
                        record[property] = next;
                    },
                });
            }
        } else if (child && typeof child === 'object') {
            contentStringFields(child, fields);
        }
    }
    return fields;
}

function boundMessageToBytes(
    message: ConversationMessage,
    maxBytes: number
): ConversationMessage | undefined {
    const bounded = copyConversationMessage(message);
    if (serializedMessageBytes(bounded) <= maxBytes) {
        return bounded;
    }
    const fields = contentStringFields(bounded);
    let minimumFieldBytes = 32;
    while (serializedMessageBytes(bounded) > maxBytes) {
        const currentBytes = serializedMessageBytes(bounded);
        const ratio = Math.max(0.1, Math.min(0.9, maxBytes / currentBytes * 0.9));
        let changed = false;
        for (const field of fields) {
            const value = field.get();
            const valueBytes = Buffer.byteLength(value, 'utf8');
            if (valueBytes <= minimumFieldBytes) {
                continue;
            }
            const nextLimit = Math.max(
                minimumFieldBytes,
                Math.floor(valueBytes * ratio)
            );
            const next = truncateUtf8Bytes(value, nextLimit);
            if (next !== value) {
                field.set(next);
                changed = true;
            }
        }
        if (changed) {
            continue;
        }
        if (minimumFieldBytes > Buffer.byteLength('…', 'utf8')) {
            minimumFieldBytes = Buffer.byteLength('…', 'utf8');
            continue;
        }
        return undefined;
    }
    return bounded;
}

function semanticEndpointIndices(
    messages: readonly ConversationMessage[]
): number[] {
    const latestByRole = new Map<ConversationMessage['role'], number>();
    for (let index = 1; index < messages.length; index += 1) {
        const role = messages[index].role;
        if (role === 'assistant' || role === 'question' || role === 'plan') {
            latestByRole.set(role, index);
        }
    }
    if (latestByRole.size > 0) {
        return Array.from(latestByRole.values()).sort((left, right) => left - right);
    }
    return messages.length > 1 ? [messages.length - 1] : [];
}

function allocateMessageBudgets(
    rawBytes: readonly number[],
    totalBudget: number
): number[] {
    const budgets = Array(rawBytes.length).fill(0) as number[];
    const unassigned = new Set(rawBytes.map((_bytes, index) => index));
    let remaining = totalBudget;
    while (unassigned.size > 0) {
        const share = Math.floor(remaining / unassigned.size);
        const fitting = Array.from(unassigned).filter(
            index => rawBytes[index] <= share
        );
        if (fitting.length === 0) {
            for (const index of unassigned) {
                budgets[index] = share;
            }
            let remainder = remaining - share * unassigned.size;
            for (const index of unassigned) {
                if (remainder <= 0) {
                    break;
                }
                budgets[index] += 1;
                remainder -= 1;
            }
            break;
        }
        for (const index of fitting) {
            budgets[index] = rawBytes[index];
            remaining -= rawBytes[index];
            unassigned.delete(index);
        }
    }
    return budgets;
}

/**
 * Deterministically converges one interaction's messages into the page byte
 * budget: the user input and the latest assistant, plan, and question
 * endpoints stay visible, everything else is byte-truncated or replaced by
 * an explicit omission notice. Never throws; the page builder's shrink loop
 * only decides how many interactions fit, never whether one can.
 */
function boundInteractionMessages(
    messages: readonly ConversationMessage[],
    state: {
        interactionId: string;
        responseState: ConversationResponseState;
        timestamp?: number;
        completedAt?: number;
    },
    maxBytes: number
): { messages: ConversationMessage[]; serializedBytes: number } {
    const serializedMessages = messages.map(message => JSON.stringify(message));
    const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({
        messages: [],
        state,
    }), 'utf8');
    const fullBytes = emptyEnvelopeBytes + serializedMessages.reduce(
        (total, message, index) => total
            + Buffer.byteLength(message, 'utf8')
            + (index > 0 ? 1 : 0),
        0
    );
    if (fullBytes <= maxBytes) {
        return { messages: messages.slice(), serializedBytes: fullBytes };
    }

    const user = messages[0];
    const endpointIndices = semanticEndpointIndices(messages);
    const preservedEntries = [
        ...(user ? [{ index: 0, message: user }] : []),
        ...endpointIndices.map(index => ({ index, message: messages[index] })),
    ];
    const omission: ConversationMessage = {
        id: `${state.interactionId}:progress:omitted`,
        interactionId: state.interactionId,
        role: 'progress',
        timestamp: user?.timestamp,
        markdown: OVERSIZED_TURN_OMISSION,
    };
    const omissionBytes = serializedMessageBytes(omission);
    const preservedCount = preservedEntries.length;
    const contentBudget = Math.max(0,
        maxBytes - emptyEnvelopeBytes - omissionBytes - preservedCount
    );
    const preservedBudgets = allocateMessageBudgets(
        preservedEntries.map(entry => serializedMessageBytes(entry.message)),
        contentBudget
    );
    const retained = new Map<number, ConversationMessage>();
    preservedEntries.forEach((entry, entryIndex) => {
        const bounded = boundMessageToBytes(
            entry.message,
            preservedBudgets[entryIndex]
        );
        if (bounded) {
            retained.set(entry.index, bounded);
        }
    });
    const boundedUser = retained.get(0);
    if (boundedUser) {
        retained.delete(0);
    }
    let serializedBytes = emptyEnvelopeBytes + omissionBytes;
    if (boundedUser) {
        serializedBytes += serializedMessageBytes(boundedUser);
    }
    for (const message of retained.values()) {
        serializedBytes += serializedMessageBytes(message);
    }
    serializedBytes += retained.size + (boundedUser ? 1 : 0);
    for (let index = messages.length - 1; index >= (user ? 1 : 0); index -= 1) {
        if (retained.has(index)) {
            continue;
        }
        const messageBytes = Buffer.byteLength(serializedMessages[index], 'utf8')
            + 1;
        if (serializedBytes + messageBytes > maxBytes) {
            continue;
        }
        retained.set(index, messages[index]);
        serializedBytes += messageBytes;
    }
    const bounded = [
        ...(boundedUser ? [boundedUser] : []),
        omission,
        ...Array.from(retained.entries())
            .sort((left, right) => left[0] - right[0])
            .map(([, message]) => message),
    ];
    return { messages: bounded, serializedBytes };
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
                        ...(toolCall.diffs
                            ? { diffs: copyConversationDiffs(toolCall.diffs) }
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
        const state = {
            interactionId: interaction.id,
            responseState: interaction.responseState,
            ...(interaction.timestamp !== undefined
                ? { timestamp: interaction.timestamp }
                : {}),
            ...(interaction.completedAt !== undefined
                ? { completedAt: interaction.completedAt }
                : {}),
        };
        const bounded = boundInteractionMessages(
            messagesForInteraction(interaction),
            state,
            CONVERSATION_LIMITS.maxPageBytes - PAGE_ENVELOPE_RESERVE_BYTES
        );
        const block = {
            messages: bounded.messages,
            state,
            serializedBytes: bounded.serializedBytes,
        };
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
