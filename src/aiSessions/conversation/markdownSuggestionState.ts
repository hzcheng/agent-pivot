'use strict';

import * as fs from 'fs';
import { isAiSessionProvider, isBoundedId, isTimestamp } from './commentPrimitives';
import type { AiSessionProviderId } from '../../models';
import {
    isMarkdownDocumentCommentTarget,
    MarkdownDocumentCommentTarget,
} from './documentComments';
import { KeyedSnapshotFileStore } from './snapshotFileStore';

const STORE_DIRECTORY = ['markdown-suggestion-states', 'v1'].join('/');
const MAX_SUGGESTION_STATES = 100;

export type MarkdownSuggestionDisposition = 'dismissed' | 'applied' | 'outdated';

export interface MarkdownSuggestionState {
    provider: AiSessionProviderId;
    sessionId: string;
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
            || !isAiSessionProvider(state.provider) || !isBoundedId(state.sessionId)
            || !isBoundedId(state.messageId)
            || ids.has([state.provider, state.sessionId, state.messageId].join('\u0001'))
            || (state.disposition !== 'dismissed' && state.disposition !== 'applied'
                && state.disposition !== 'outdated')
            || !isTimestamp(state.updatedAt)) {
            throw new Error('Invalid Markdown suggestion state snapshot.');
        }
        ids.add([state.provider, state.sessionId, state.messageId].join('\u0001'));
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
            retainEmptySnapshot: true,
        }, now);
    }

    async save(
        target: MarkdownDocumentCommentTarget,
        snapshot: MarkdownSuggestionStateSnapshot
    ): Promise<void> {
        const release = await this.acquireTargetLock(target);
        try {
            const current = await this.loadStrict(target);
            if (current.revision >= snapshot.revision) {
                throw new Error('Markdown suggestion decisions changed in another window.');
            }
            await super.save(target, snapshot);
        } finally {
            await release();
        }
    }

    private async acquireTargetLock(target: MarkdownDocumentCommentTarget): Promise<() => Promise<void>> {
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        const lockPath = `${this.getSnapshotPath(target)}.lock`;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
                const handle = await fs.promises.open(lockPath, 'wx', 0o600);
                return async () => {
                    await handle.close().catch(() => undefined);
                    await fs.promises.unlink(lockPath).catch(() => undefined);
                };
            } catch (error) {
                if (!isAlreadyExists(error)) { throw error; }
                try {
                    const stat = await fs.promises.stat(lockPath);
                    if (Date.now() - stat.mtimeMs > 30_000) {
                        await fs.promises.unlink(lockPath).catch(() => undefined);
                        continue;
                    }
                } catch (_error) { /* The lock was released; retry below. */ }
                await new Promise<void>(resolve => setTimeout(resolve, 25));
            }
        }
        throw new Error('Markdown suggestion decisions are busy in another window.');
    }
}

function isAlreadyExists(error: unknown): boolean {
    return !!error && typeof error === 'object'
        && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
