'use strict';

import { isBoundedId, isTimestamp } from './commentPrimitives';
import {
    isMarkdownDocumentCommentTarget,
    MarkdownDocumentCommentTarget,
} from './documentComments';
import { KeyedSnapshotFileStore } from './snapshotFileStore';

const STORE_DIRECTORY = ['markdown-suggestion-states', 'v1'].join('/');
const MAX_SUGGESTION_STATES = 100;

export type MarkdownSuggestionDisposition = 'dismissed' | 'applied' | 'outdated';

export interface MarkdownSuggestionState {
    messageId: string;
    disposition: MarkdownSuggestionDisposition;
    updatedAt: number;
}

export interface MarkdownSuggestionStateSnapshot {
    revision: number;
    suggestions: MarkdownSuggestionState[];
}

export interface MarkdownSuggestionStateStore {
    load(target: MarkdownDocumentCommentTarget): Promise<MarkdownSuggestionStateSnapshot>;
    save(
        target: MarkdownDocumentCommentTarget,
        snapshot: MarkdownSuggestionStateSnapshot
    ): Promise<void>;
}

export function validateMarkdownSuggestionStates(states: unknown): asserts states is MarkdownSuggestionState[] {
    if (!Array.isArray(states) || states.length > MAX_SUGGESTION_STATES) {
        throw new Error('Invalid Markdown suggestion state snapshot.');
    }
    const ids = new Set<string>();
    for (const state of states) {
        if (!state || typeof state !== 'object' || Array.isArray(state)
            || !isBoundedId(state.messageId) || ids.has(state.messageId)
            || (state.disposition !== 'dismissed' && state.disposition !== 'applied'
                && state.disposition !== 'outdated')
            || !isTimestamp(state.updatedAt)) {
            throw new Error('Invalid Markdown suggestion state snapshot.');
        }
        ids.add(state.messageId);
    }
}

export function cloneMarkdownSuggestionStates(
    states: readonly MarkdownSuggestionState[]
): MarkdownSuggestionState[] {
    validateMarkdownSuggestionStates(states);
    return states.map(state => ({ ...state }));
}

/** Host-owned suggestion decisions survive reader recreation and are keyed
 * by the same project/root/path identity as durable document comments. */
export class MarkdownSuggestionStateFileStore extends KeyedSnapshotFileStore<
    MarkdownDocumentCommentTarget,
    MarkdownSuggestionState,
    MarkdownSuggestionStateSnapshot
> implements MarkdownSuggestionStateStore {

    constructor(globalStoragePath: string, now: () => number = () => Date.now()) {
        super(globalStoragePath, STORE_DIRECTORY, {
            isValidTarget: isMarkdownDocumentCommentTarget,
            targetsMatch: (persisted, target) =>
                persisted.projectId === target.projectId
                && persisted.workspaceRootId === target.workspaceRootId
                && persisted.relativePath === target.relativePath,
            digestIdentity: target => [
                target.projectId,
                target.workspaceRootId,
                target.relativePath,
            ],
            payloadKey: 'suggestions',
            itemsOf: snapshot => snapshot.suggestions,
            buildSnapshot: (revision, suggestions) => ({ revision, suggestions }),
            validateItems: validateMarkdownSuggestionStates,
            cloneItems: cloneMarkdownSuggestionStates,
            invalidSnapshotMessage: 'Invalid Markdown suggestion state snapshot.',
            invalidPersistedMessage: 'Invalid persisted Markdown suggestion state snapshot.',
            maxSnapshotBytes: 128 * 1024,
        }, now);
    }
}
