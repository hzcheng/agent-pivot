'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationQuestionItem,
    ConversationQuestionOption,
} from './types';
import { truncateGraphemes } from './text';

function boundedText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? truncateGraphemes(trimmed, limit) : undefined;
}

/**
 * Bounds a provider-supplied options array into canonical question options.
 * Entries without a non-empty string label are dropped.
 */
export function boundQuestionOptions(
    rawOptions: unknown,
    labelKey: string = 'label',
    descriptionKey: string = 'description'
): ConversationQuestionOption[] {
    if (!Array.isArray(rawOptions)) {
        return [];
    }
    const options: ConversationQuestionOption[] = [];
    for (const rawOption of rawOptions) {
        if (options.length >= CONVERSATION_LIMITS.maxQuestionOptions) {
            break;
        }
        const record = rawOption && typeof rawOption === 'object'
            && !Array.isArray(rawOption)
            ? rawOption as Record<string, any>
            : undefined;
        const label = boundedText(
            record?.[labelKey],
            CONVERSATION_LIMITS.questionOptionLabelGraphemes
        );
        if (!label) {
            continue;
        }
        const description = boundedText(
            record?.[descriptionKey],
            CONVERSATION_LIMITS.questionOptionDescriptionGraphemes
        );
        options.push({
            label,
            ...(description !== undefined ? { description } : {}),
        });
    }
    return options;
}

/**
 * Applies catalog limits to question items built by a provider adapter.
 * Items without a non-empty question are dropped; options may be empty
 * when the prompt only offers a free-text affordance.
 */
export function boundQuestionItems(
    items: ConversationQuestionItem[]
): ConversationQuestionItem[] {
    const bounded: ConversationQuestionItem[] = [];
    for (const item of items) {
        if (bounded.length >= CONVERSATION_LIMITS.maxQuestionsPerBlock) {
            break;
        }
        const question = boundedText(
            item.question,
            CONVERSATION_LIMITS.questionTextGraphemes
        );
        if (!question) {
            continue;
        }
        const header = boundedText(
            item.header,
            CONVERSATION_LIMITS.questionHeaderGraphemes
        );
        const otherLabel = boundedText(
            item.otherLabel,
            CONVERSATION_LIMITS.questionOptionLabelGraphemes
        );
        bounded.push({
            question,
            ...(header !== undefined ? { header } : {}),
            options: item.options
                .slice(0, CONVERSATION_LIMITS.maxQuestionOptions),
            multiSelect: item.multiSelect === true,
            ...(otherLabel !== undefined ? { otherLabel } : {}),
            ...(item.answers
                ? {
                    answers: item.answers.map(answer => truncateGraphemes(
                        answer,
                        CONVERSATION_LIMITS.questionAnswerGraphemes
                    )),
                }
                : {}),
        });
    }
    return bounded;
}

/**
 * Best-effort source name from a provider tool-call id such as
 * "ExitPlanMode_27"; falls back when the id carries no tool name.
 */
export function deriveQuestionSource(
    toolCallId: string | undefined,
    fallback: string
): string {
    const match = typeof toolCallId === 'string'
        ? /^([A-Za-z][A-Za-z0-9]*)_\d+$/.exec(toolCallId)
        : null;
    const source = match?.[1] || fallback;
    return truncateGraphemes(
        source,
        CONVERSATION_LIMITS.questionSourceGraphemes
    );
}

/**
 * Splits a settled multi-select answer into individual labels when every
 * comma-separated part matches a known option label; otherwise keeps the
 * raw answer as a single entry.
 */
export function splitSettledAnswers(
    value: string,
    item: ConversationQuestionItem
): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    if (item.multiSelect && trimmed.includes(',')) {
        const parts = trimmed.split(',').map(part => part.trim())
            .filter(part => part);
        const labels = new Set(item.options.map(option => option.label));
        if (parts.length > 1
            && parts.every(part => labels.has(part))) {
            return parts.map(part => truncateGraphemes(
                part,
                CONVERSATION_LIMITS.questionAnswerGraphemes
            ));
        }
    }
    return [truncateGraphemes(
        trimmed,
        CONVERSATION_LIMITS.questionAnswerGraphemes
    )];
}
