'use strict';

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import type { CommentErrorCode } from './commentPrimitives';
import {
    buildMarkdownDocumentCommentPrompt,
    cloneMarkdownDocumentComments,
    createMarkdownDocumentComment,
    DOCUMENT_COMMENT_LIMITS,
    MarkdownDocumentComment,
    MarkdownDocumentCommentError,
    MarkdownDocumentCommentStatus,
    MarkdownDocumentCommentTarget,
    setMarkdownDocumentCommentStatus,
    updateMarkdownDocumentComment,
    validateMarkdownDocumentComments,
} from './documentComments';
import type { MarkdownDocumentCommentStore } from './documentCommentStore';
import type {
    ConversationViewerDocumentCommentMutationMessage,
    ConversationViewerSendDocumentCommentMessage,
} from './viewerProtocol';
import type { ConversationViewerTarget } from './viewerTarget';
import { hasExactKeys } from './viewerProtocol';
import { isRecord } from './commentPrimitives';

type DocumentCommentRequest = ConversationViewerDocumentCommentMutationMessage
    | ConversationViewerSendDocumentCommentMessage;

export interface MarkdownDocumentCommentContext {
    target: MarkdownDocumentCommentTarget;
    documentVersion: string;
    markdown?: string;
    viewerTarget: ConversationViewerTarget;
    subscriptionGeneration: number;
}

export interface MarkdownDocumentCommentControllerOptions {
    documentCommentStore?: MarkdownDocumentCommentStore;
    submitPrompt: (
        target: ConversationViewerTarget,
        prompt: string
    ) => PromiseLike<void> | Promise<void>;
    focusSession?: (
        target: Pick<ConversationViewerTarget, 'projectId' | 'provider' | 'sessionId'>
    ) => PromiseLike<void> | Promise<void>;
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    getPanel: () => vscode.WebviewPanel | undefined;
    /** A settlement that could not be delivered is recovered through the
     * Host-authoritative workspace publication, never left pending in the
     * Webview. */
    onPublicationFailure?: (message: object) => PromiseLike<void> | Promise<void> | void;
    now?: () => number;
}

/**
 * File comments have an identity independent of a conversation, while each
 * mutation still has to be tied to the particular conversation document that
 * rendered the affordance. This controller keeps that boundary Host-owned.
 */
export class MarkdownDocumentCommentController {
    private context?: MarkdownDocumentCommentContext;
    private comments: MarkdownDocumentComment[] = [];
    private revision = 0;
    private activation = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements = new Map<string, object>();

    constructor(private readonly options: MarkdownDocumentCommentControllerOptions) {}

    get snapshot(): { revision: number; comments: MarkdownDocumentComment[] } {
        return { revision: this.revision, comments: cloneMarkdownDocumentComments(this.comments) };
    }

    reset(): void {
        this.activation += 1;
        this.context = undefined;
        this.comments = [];
        this.revision = 0;
        this.settlements.clear();
    }

    async activate(context: MarkdownDocumentCommentContext): Promise<void> {
        const activation = ++this.activation;
        this.context = context;
        this.comments = [];
        this.revision = 0;
        this.settlements.clear();
        const store = this.options.documentCommentStore;
        if (!store) { return; }
        let snapshot: { revision: number; comments: MarkdownDocumentComment[] };
        try {
            snapshot = await store.load(context.target);
            validateMarkdownDocumentComments(snapshot.comments);
            if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
                return;
            }
        } catch (_error) {
            return;
        }
        if (!this.isContextCurrent(context, activation)) { return; }
        let comments = cloneMarkdownDocumentComments(snapshot.comments);
        const outdated = comments.map(comment => comment.documentVersion === context.documentVersion
            ? comment
            : relocateMarkdownDocumentComment(comment, context));
        const changed = JSON.stringify(outdated) !== JSON.stringify(comments);
        if (changed) {
            const next = { revision: snapshot.revision + 1, comments: outdated };
            try {
                await store.save(context.target, next);
            } catch (_error) {
                // Preserve the original, valid snapshot when status repair
                // cannot be made durable. The user can still read it.
                if (!this.isContextCurrent(context, activation)) { return; }
                this.comments = comments;
                this.revision = snapshot.revision;
                return;
            }
            if (!this.isContextCurrent(context, activation)) { return; }
            comments = outdated;
            snapshot = next;
        }
        this.comments = comments;
        this.revision = snapshot.revision;
    }

    enqueue(request: DocumentCommentRequest): Promise<void> {
        const queued = this.operationQueue.then(
            () => this.handle(request),
            () => this.handle(request)
        );
        this.operationQueue = queued.catch(() => undefined);
        return queued;
    }

    /** Persist assistant cards with their document comment, rather than making
     * the document discussion depend on whichever transcript page is live. */
    recordReplies(replies: ReadonlyArray<{
        commentId: string;
        messageId: string;
        markdown: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }>): Promise<void> {
        const queued = this.operationQueue.then(
            () => this.persistReplies(replies),
            () => this.persistReplies(replies)
        );
        this.operationQueue = queued.catch(() => undefined);
        return queued;
    }

    private async persistReplies(replies: ReadonlyArray<{
        commentId: string;
        messageId: string;
        markdown: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }>): Promise<void> {
        if (!this.context || !replies.length) { return; }
        const next = cloneMarkdownDocumentComments(this.comments);
        let changed = false;
        for (const reply of replies) {
            if (typeof reply.commentId !== 'string' || typeof reply.messageId !== 'string'
                || typeof reply.markdown !== 'string' || !reply.markdown.trim()
                || typeof reply.provider !== 'string' || typeof reply.sessionId !== 'string') {
                continue;
            }
            const index = next.findIndex(comment => comment.id === reply.commentId);
            if (index < 0) { continue; }
            const comment = next[index];
            const discussion = comment.discussion ? comment.discussion.map(item => ({ ...item })) : [];
            if (discussion.some(item => item.messageId === reply.messageId
                && item.provider === reply.provider && item.sessionId === reply.sessionId)) {
                continue;
            }
            discussion.push({
                messageId: reply.messageId,
                markdown: reply.markdown,
                createdAt: this.now(),
                provider: reply.provider,
                sessionId: reply.sessionId,
            });
            // Validation is deliberately performed by commit(), including all
            // bounds on model output and persisted discussion size.
            comment.discussion = discussion.slice(-DOCUMENT_COMMENT_LIMITS.maxDiscussionReplies);
            changed = true;
        }
        if (changed) {
            await this.commit(next, this.revision);
        }
    }

    private async handle(request: DocumentCommentRequest): Promise<void> {
        const key = this.settlementKey(request);
        const remembered = this.settlements.get(key);
        if (remembered) {
            await this.publish(remembered);
            return;
        }
        if (!this.matches(request)
            || (request.expectedRevision !== this.revision
                && request.operation !== 'add')) {
            await this.settle(request, false, 'stale');
            return;
        }
        try {
            if (request.type === 'conversation-viewer-send-document-comment') {
                await this.send(request);
            } else {
                await this.mutate(request);
            }
            await this.settle(request, true);
        } catch (error) {
            await this.settle(request, false, this.errorCode(error));
        }
    }

    private async mutate(request: ConversationViewerDocumentCommentMutationMessage): Promise<void> {
        if (request.operation === 'add') {
            await this.addWithRebase(request);
            return;
        }
        const next = cloneMarkdownDocumentComments(this.comments);
        const payload = parseExistingPayload(request);
        const index = next.findIndex(comment => comment.id === payload.commentId);
        if (index < 0) { throw new MarkdownDocumentCommentError('stale'); }
        if (request.operation === 'delete') {
            next.splice(index, 1);
        } else if (request.operation === 'update') {
            next[index] = updateMarkdownDocumentComment(next[index], payload.text, this.now());
        } else {
            next[index] = setMarkdownDocumentCommentStatus(
                next[index], payload.status, this.now(),
                payload.status === 'sent' && this.context ? {
                    provider: this.context.viewerTarget.provider,
                    sessionId: this.context.viewerTarget.sessionId,
                } : undefined
            );
        }
        await this.commit(next, request.expectedRevision);
    }

    private async addWithRebase(
        request: ConversationViewerDocumentCommentMutationMessage
    ): Promise<void> {
        if (!hasExactKeys(request.payload as object, ['anchor', 'text'])) {
            throw new MarkdownDocumentCommentError('invalid');
        }
        const created = withDerivedRangeHint(createMarkdownDocumentComment(
            randomBytes(16).toString('hex'),
            {
                documentVersion: request.document.documentVersion,
                ...(request.payload as { anchor: unknown; text: unknown }),
            },
            this.now()
        ), this.context?.markdown);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (this.comments.length >= DOCUMENT_COMMENT_LIMITS.maxComments) {
                throw new MarkdownDocumentCommentError('limit');
            }
            const expectedRevision = this.revision;
            const next = cloneMarkdownDocumentComments(this.comments);
            next.unshift(created);
            try {
                await this.commit(next, expectedRevision);
                return;
            } catch (error) {
                if (!(error instanceof MarkdownDocumentCommentError)
                    || error.code !== 'failed'
                    || !await this.reloadAdvancedSnapshot(expectedRevision)) {
                    throw error;
                }
            }
        }
        throw new MarkdownDocumentCommentError('failed');
    }

    private async reloadAdvancedSnapshot(expectedRevision: number): Promise<boolean> {
        const context = this.context;
        const store = this.options.documentCommentStore;
        if (!context || !store) { return false; }
        try {
            const snapshot = await store.load(context.target);
            validateMarkdownDocumentComments(snapshot.comments);
            if (!this.isContextCurrent(context, this.activation)
                || snapshot.revision <= expectedRevision) {
                return false;
            }
            this.comments = cloneMarkdownDocumentComments(snapshot.comments);
            this.revision = snapshot.revision;
            return true;
        } catch (_error) {
            return false;
        }
    }

    private async send(request: ConversationViewerSendDocumentCommentMessage): Promise<void> {
        if (!hasExactKeys(request.payload, ['commentId'])) {
            throw new MarkdownDocumentCommentError('invalid');
        }
        const index = this.comments.findIndex(comment => comment.id === request.payload.commentId);
        const comment = this.comments[index];
        const context = this.context;
        if (!context || !comment || comment.status !== 'draft') {
            throw new MarkdownDocumentCommentError('stale');
        }
        const next = cloneMarkdownDocumentComments(this.comments);
        // Persist an explicit outbox state before handing the prompt to the
        // provider. A provider failure can never leave a durable "sent"
        // record for a prompt it did not receive.
        next[index] = setMarkdownDocumentCommentStatus(comment, 'sending', this.now());
        const prior = this.snapshot;
        await this.commit(next, request.expectedRevision);
        try {
            await Promise.resolve(this.options.submitPrompt(
                { ...context.viewerTarget },
                buildMarkdownDocumentCommentPrompt(context.target, next[index])
            ));
        } catch (error) {
            // A rollback is a second durable write. If it also fails, retain
            // the truthful outbox state rather than inventing a sent result.
            await this.restorePrior(prior);
            throw error;
        }
        const sent = cloneMarkdownDocumentComments(this.comments);
        const sentIndex = sent.findIndex(candidate => candidate.id === comment.id);
        if (sentIndex < 0 || sent[sentIndex].status !== 'sending') {
            throw new MarkdownDocumentCommentError('stale');
        }
        sent[sentIndex] = setMarkdownDocumentCommentStatus(sent[sentIndex], 'sent', this.now(), {
            provider: context.viewerTarget.provider,
            sessionId: context.viewerTarget.sessionId,
        });
        await this.commit(sent, this.revision);
        try {
            await Promise.resolve(this.options.focusSession?.(context.viewerTarget));
        } catch (_error) {
            // A submitted prompt is durable; focus is an optional convenience.
        }
    }

    private async commit(comments: MarkdownDocumentComment[], expectedRevision: number): Promise<void> {
        const context = this.context;
        if (!context || this.revision !== expectedRevision) {
            throw new MarkdownDocumentCommentError('stale');
        }
        validateMarkdownDocumentComments(comments);
        const next = { revision: this.revision + 1, comments };
        try {
            await this.options.documentCommentStore?.save(context.target, next);
        } catch (_error) {
            throw new MarkdownDocumentCommentError('failed');
        }
        if (!this.isContextCurrent(context, this.activation) || this.revision !== expectedRevision) {
            // Best effort repair: do not let an obsolete document persist an
            // unacknowledged mutation after a target handoff.
            await this.options.documentCommentStore?.save(context.target, this.snapshot).catch(() => undefined);
            throw new MarkdownDocumentCommentError('stale');
        }
        this.comments = cloneMarkdownDocumentComments(comments);
        this.revision = next.revision;
    }

    private async restorePrior(snapshot: { revision: number; comments: MarkdownDocumentComment[] }): Promise<boolean> {
        const context = this.context;
        if (!context) { return false; }
        try {
            // The outbox transition already advanced the shared revision.
            // Roll back the contents through a newer revision so another
            // window's CAS cannot mistake recovery for a stale overwrite.
            const restored = {
                revision: this.revision + 1,
                comments: snapshot.comments,
            };
            await this.options.documentCommentStore?.save(context.target, restored);
            if (this.context === context) {
                this.comments = cloneMarkdownDocumentComments(restored.comments);
                this.revision = restored.revision;
            }
        } catch (_error) {
            // Keep the durable outbox state visible too. It is the only
            // authoritative record and is intentionally not a false sent
            // result.
            return false;
        }
        return this.context === context;
    }

    private matches(request: DocumentCommentRequest): boolean {
        const context = this.context;
        const target = this.options.getTarget();
        return Boolean(context && target && target === context.viewerTarget
            && this.options.getSubscriptionGeneration() === context.subscriptionGeneration
            && request.subscriptionGeneration === context.subscriptionGeneration
            && request.projectId === target.projectId
            && request.provider === target.provider
            && request.sessionId === target.sessionId
            && request.document.workspaceRootId === context.target.workspaceRootId
            && request.document.relativePath === context.target.relativePath
            && request.document.documentVersion === context.documentVersion);
    }

    private isContextCurrent(context: MarkdownDocumentCommentContext, activation: number): boolean {
        return this.context === context && this.activation === activation
            && this.options.getTarget() === context.viewerTarget
            && this.options.getSubscriptionGeneration() === context.subscriptionGeneration;
    }

    private async settle(request: DocumentCommentRequest, success: boolean, error?: CommentErrorCode): Promise<void> {
        const message = {
            type: 'conversation-viewer-document-comments-result',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: request.operation,
            success,
            revision: this.revision,
            document: { ...request.document },
            comments: cloneMarkdownDocumentComments(this.comments),
            ...(error ? { error } : {}),
        };
        this.settlements.set(this.settlementKey(request), message);
        while (this.settlements.size > 100) {
            const oldest = this.settlements.keys().next().value;
            if (typeof oldest !== 'string') { break; }
            this.settlements.delete(oldest);
        }
        await this.publish(message);
    }

    private async publish(message: object): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel) { return; }
        try {
            if (await panel.webview.postMessage(message)) { return; }
        } catch (_error) { /* Recover below through the authoritative surface. */ }
        try { await this.options.onPublicationFailure?.(message); } catch (_error) { /* no-op */ }
    }

    private settlementKey(request: DocumentCommentRequest): string {
        return JSON.stringify([request.projectId, request.provider, request.sessionId,
            request.document.workspaceRootId, request.document.relativePath, request.requestId]);
    }

    private now(): number { return this.options.now?.() ?? Date.now(); }

    private errorCode(error: unknown): CommentErrorCode {
        return error instanceof MarkdownDocumentCommentError ? error.code : 'failed';
    }
}

/**
 * Rendered Markdown has no source-map positions. When a selection maps to one
 * unambiguous source line, retain that line as a conservative third relocation
 * signal. We never guess for multi-line/ambiguous selections: the quote and
 * heading evidence remain the authority in those cases.
 */
function withDerivedRangeHint(
    comment: MarkdownDocumentComment,
    markdown: string | undefined
): MarkdownDocumentComment {
    if (!markdown || comment.anchor.rangeHint || !comment.anchor.selectedText) {
        return comment;
    }
    const quote = comment.anchor.selectedText;
    const lines = markdown.split(/\r?\n/);
    const matches = lines.reduce<number[]>((result, line, index) => {
        if (normalizeAnchorText(line).includes(quote)) { result.push(index + 1); }
        return result.length > 1 ? result.slice(0, 2) : result;
    }, []);
    if (matches.length !== 1) { return comment; }
    return {
        ...comment,
        anchor: {
            ...comment.anchor,
            rangeHint: { startLine: matches[0], endLine: matches[0] },
        },
    };
}

function relocateMarkdownDocumentComment(
    comment: MarkdownDocumentComment,
    context: MarkdownDocumentCommentContext
): MarkdownDocumentComment {
    const markdown = String(context.markdown || '');
    const source = normalizeAnchorText(markdown);
    const quote = comment.anchor.selectedText;
    // Relocation intentionally progresses from strongest to weaker evidence.
    // Context must be exact first; a heading only disambiguates a unique quote
    // within that section, then a persisted source-line hint does the same.
    if (matchingAnchorOccurrences(source, quote, comment.anchor.prefix, comment.anchor.suffix).length === 1
        || matchesUniqueHeadingSection(markdown, quote, comment.anchor.headingPath)
        || matchesUniqueRangeHint(markdown, quote, comment.anchor.rangeHint)) {
        return {
            ...cloneMarkdownDocumentComments([comment])[0],
            documentVersion: context.documentVersion,
        };
    }
    return setMarkdownDocumentCommentStatus(comment, 'outdated', Date.now());
}

function normalizeAnchorText(value: string): string {
    // Webview anchors intentionally describe what the reader sees, not the
    // Markdown delimiters that happened to produce it. Keep this conservative
    // projection aligned with common inline/block Markdown so a harmless
    // formatting change cannot strand a comment; ambiguity still fails closed.
    return value
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, '$1$2')
        .replace(/(^|[^\w_])_([^_]+)_(?=[^\w_]|$)/g, '$1$2')
        .replace(/\s+/g, ' ').trim();
}

function matchingAnchorOccurrences(
    source: string,
    quote: string,
    prefix: string,
    suffix: string
): number[] {
    if (!quote) { return []; }
    const matches: number[] = [];
    let start = source.indexOf(quote);
    while (start >= 0 && matches.length < 2) {
        const before = source.slice(Math.max(0, start - prefix.length), start);
        const end = start + quote.length;
        const after = source.slice(end, end + suffix.length);
        if ((!prefix || before === prefix) && (!suffix || after === suffix)) {
            matches.push(start);
        }
        start = source.indexOf(quote, start + 1);
    }
    return matches;
}

function matchesUniqueHeadingSection(
    markdown: string,
    quote: string,
    headingPath: readonly string[]
): boolean {
    if (!quote || !headingPath.length) { return false; }
    const lines = markdown.split(/\r?\n/);
    const headings: Array<{ line: number; level: number; text: string }> = [];
    lines.forEach((line, lineIndex) => {
        const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (match) {
            headings.push({ line: lineIndex, level: match[1].length, text: normalizeAnchorText(match[2]) });
        }
    });
    const candidates = headings.filter(heading => {
        if (heading.text !== headingPath[headingPath.length - 1]) { return false; }
        const trail: string[] = [];
        for (let index = headings.indexOf(heading); index >= 0 && trail.length < headingPath.length; index -= 1) {
            const candidate = headings[index];
            if (candidate.level <= heading.level - trail.length) {
                trail.unshift(candidate.text);
            }
        }
        return trail.join('\u0001') === headingPath.map(normalizeAnchorText).join('\u0001');
    });
    if (candidates.length !== 1) { return false; }
    const section = candidates[0];
    const end = headings.slice(headings.indexOf(section) + 1)
        .find(heading => heading.level <= section.level)?.line ?? lines.length;
    return matchingAnchorOccurrences(normalizeAnchorText(lines.slice(section.line, end).join('\n')),
        quote, '', '').length === 1;
}

function matchesUniqueRangeHint(
    markdown: string,
    quote: string,
    rangeHint: MarkdownDocumentComment['anchor']['rangeHint']
): boolean {
    if (!quote || !rangeHint) { return false; }
    const matches: number[] = [];
    const lines = markdown.split(/\r?\n/);
    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (lineNumber < rangeHint.startLine || lineNumber > rangeHint.endLine) { return; }
        if (normalizeAnchorText(line).indexOf(quote) >= 0) { matches.push(lineNumber); }
    });
    return matches.length === 1;
}

function parseExistingPayload(request: ConversationViewerDocumentCommentMutationMessage): {
    commentId: string;
    text?: unknown;
    status?: MarkdownDocumentCommentStatus;
} {
    const payload = request.payload;
    if (!isRecord(payload) || typeof payload.commentId !== 'string') {
        throw new MarkdownDocumentCommentError('invalid');
    }
    if (request.operation === 'delete') {
        if (!hasExactKeys(payload, ['commentId'])) { throw new MarkdownDocumentCommentError('invalid'); }
    } else if (request.operation === 'update') {
        if (!hasExactKeys(payload, ['commentId', 'text'])) { throw new MarkdownDocumentCommentError('invalid'); }
    } else if (!hasExactKeys(payload, ['commentId', 'status'])
        || (payload.status !== 'draft' && payload.status !== 'sent'
            && payload.status !== 'resolved' && payload.status !== 'outdated')) {
        throw new MarkdownDocumentCommentError('invalid');
    }
    return payload as { commentId: string; text?: unknown; status?: MarkdownDocumentCommentStatus };
}
