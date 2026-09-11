'use strict';

import * as path from 'path';
import type { ConversationSessionOpenTarget, MarkdownReviewOpenResult } from '../aiSessions/conversation/composition';
import type { ConversationWorkspaceFileTarget } from '../aiSessions/conversation/markdown';

/** Canonical paths must share a root without crossing a nested repository. */
export async function isSameMarkdownReviewWorktree(
    root: string, file: string, hasGitBoundary: (directory: string) => Promise<boolean>
): Promise<boolean> {
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return false; }
    let directory = path.dirname(file);
    while (directory !== root) {
        if (await hasGitBoundary(directory)) { return false; }
        const parent = path.dirname(directory);
        if (parent === directory) { return false; }
        directory = parent;
    }
    return true;
}

export interface MarkdownReviewCandidate {
    target: ConversationSessionOpenTarget;
    file: ConversationWorkspaceFileTarget;
    label: string;
    description: string;
    preferred: boolean;
}

export interface MarkdownReviewDocument {
    fsPath: string;
    readonly isDirty: boolean;
    save(): PromiseLike<boolean>;
    position(): { line: number; column: number; selectionText?: string };
}

export interface MarkdownReviewCommandOptions {
    getDocument(resource?: unknown): Promise<MarkdownReviewDocument | undefined>;
    confirmSave(): Promise<boolean>;
    candidates(fsPath: string): Promise<MarkdownReviewCandidate[]>;
    choose(candidates: MarkdownReviewCandidate[]): Promise<MarkdownReviewCandidate | undefined>;
    open(candidate: MarkdownReviewCandidate, isCurrent: () => boolean): Promise<MarkdownReviewOpenResult>;
    reportFailure?(stage: string, error?: unknown): void;
    inform(message: string): unknown;
}

/** A command never creates a session, saves silently, or guesses another root. */
export class MarkdownReviewCommandController {
    private generation = 0;

    constructor(private readonly options: MarkdownReviewCommandOptions) {}

    async review(resource?: unknown): Promise<void> {
        const generation = ++this.generation;
        const current = () => this.generation === generation;
        const document = await this.options.getDocument(resource);
        if (!current()) { return; }
        if (!document || !document.fsPath.toLowerCase().endsWith('.md')) {
            this.options.inform('Open a saved Markdown (.md) file to review it in AI Conversation.');
            return;
        }
        if (document.isDirty) {
            const approved = await this.options.confirmSave();
            if (!current() || !approved) { return; }
            if (!await document.save() || document.isDirty) {
                this.options.inform('The document was not saved. Review was not opened with an older disk version.');
                return;
            }
        }
        if (!current()) { return; }
        const position = document.position();
        const candidates = await this.options.candidates(document.fsPath);
        if (!current()) { return; }
        if (!candidates.length) {
            this.options.inform('No AI session is associated with this file’s worktree. Open or start a session in that worktree, then review this document again.');
            return;
        }
        const preferred = candidates.filter(candidate => candidate.preferred);
        const selected = preferred.length === 1 ? preferred[0]
            : candidates.length === 1 ? candidates[0] : await this.options.choose(candidates);
        if (!current() || !selected) { return; }
        if (document.isDirty) {
            this.options.inform('The document changed while choosing a session. Save it and reopen review.');
            return;
        }
        let result: MarkdownReviewOpenResult;
        try {
            result = await this.options.open({ ...selected, file: { ...selected.file, ...position } }, current);
        } catch (error) {
            this.options.reportFailure?.('open-exception', error);
            if (current()) {
                this.options.inform('Document review could not be opened. See the Agent Pivot output for details.');
            }
            return;
        }
        if (!current() || result === true || result === 'cancelled') { return; }
        this.options.reportFailure?.(result);
        const messages = {
            'session-unavailable': 'The selected AI session is not available for document review. Refresh its conversation and try again.',
            'conversation-unavailable': 'The AI conversation could not be opened. See the Agent Pivot output for details.',
            'document-unavailable': 'The document could not be opened for review. Check that it still exists in the session worktree. See the Agent Pivot output for details.',
        };
        this.options.inform(messages[result]);
    }
}
