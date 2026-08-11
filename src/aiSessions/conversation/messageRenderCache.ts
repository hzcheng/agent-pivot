'use strict';

import type { ConversationClockTime } from './text';
import type {
    ConversationMessage,
    ConversationResponseState,
} from './types';

/**
 * Per-message HTML render cache for the conversation viewer.
 *
 * Rendering the retained window (up to 100 interactions / 4 MiB) through
 * markdown-it and highlight.js on every publication dominated both session
 * switches and live refreshes. This cache makes publication cost
 * proportional to what actually changed.
 *
 * Correctness invariant: a message's HTML depends only on
 * - its content (replaced wholesale per interaction by the retention
 *   layer — retain()/mergeRefreshPage() must call invalidateInteraction()
 *   for every incoming interaction id), and
 * - the render signature below (session, thinking visibility, response
 *   state, and the already-computed clock text).
 *
 * The session id in the signature keeps deterministic message ids from
 * colliding across sessions when the viewer is reused for a switch.
 */
export class ConversationMessageRenderCache {
    private readonly entries = new Map<string, {
        signature: string;
        html: string;
        version: number;
    }>();
    private cachedBytes = 0;
    private renderVersion = 0;

    constructor(
        private readonly maxBytes = 8 * 1024 * 1024,
    ) {}

    /**
     * Returns the cached HTML for a message, rendering it on a miss. Every
     * (re)render advances a monotonically increasing version so callers can
     * mix (message id, signature, version) into a publication-level content
     * signature: within one viewer instance, a given (id, version) pair
     * always identifies exactly one rendered HTML string, which is what
     * makes delta publications safe without hashing message content.
     */
    render(
        messageId: string,
        signature: string,
        render: () => string
    ): { html: string; version: number } {
        const existing = this.entries.get(messageId);
        if (existing && existing.signature === signature) {
            // Refresh the recency order without touching the byte total.
            this.entries.delete(messageId);
            this.entries.set(messageId, existing);
            return existing;
        }
        const html = render();
        const version = ++this.renderVersion;
        if (existing) {
            this.cachedBytes -= existing.html.length;
            // Re-insert at the recency tail: a re-rendered entry is the
            // freshest, not the position it first occupied.
            this.entries.delete(messageId);
        }
        const entry = { signature, html, version };
        this.entries.set(messageId, entry);
        this.cachedBytes += html.length;
        while (this.cachedBytes > this.maxBytes && this.entries.size > 1) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined || oldestKey === messageId) {
                break;
            }
            const oldest = this.entries.get(oldestKey);
            if (oldest) {
                this.cachedBytes -= oldest.html.length;
            }
            this.entries.delete(oldestKey);
        }
        return entry;
    }

    invalidateInteraction(interactionId: string): void {
        const prefix = `${interactionId}:`;
        for (const [key, entry] of Array.from(this.entries)) {
            if (key.startsWith(prefix)) {
                this.cachedBytes -= entry.html.length;
                this.entries.delete(key);
            }
        }
    }

    clear(): void {
        this.entries.clear();
        this.cachedBytes = 0;
    }

    get trackedBytes(): number {
        return this.cachedBytes;
    }

    get size(): number {
        return this.entries.size;
    }
}

export interface ConversationMessageRenderContext {
    sessionId: string;
    showThinking: boolean;
    responseState?: ConversationResponseState;
    clock?: ConversationClockTime;
}

/**
 * Everything besides message content that can change the rendered HTML of
 * a single message. The clock text is computed per publication anyway, so
 * including it makes day-boundary label changes a natural cache miss.
 */
export function createMessageRenderSignature(
    context: ConversationMessageRenderContext
): string {
    return [
        context.sessionId,
        context.showThinking ? '1' : '0',
        context.responseState ?? '',
        context.clock?.label ?? '',
        context.clock?.title ?? '',
    ].join('\u0001');
}

/**
 * Collision-free publication content identity. The exact render stream
 * (every retained message's id, role, render signature, and render-cache
 * version, plus worklog markers) fully determines the published HTML, so
 * the registry maps that exact stream to a short opaque token. Unlike a
 * hash, the token sequence cannot collide: two identical tokens always
 * mean identical HTML within a viewer instance. The registry is bounded
 * with LRU eviction; an evicted stream simply mints a fresh token, which
 * only costs a missed Webview-side cache hit, never a wrong one.
 */
export class ConversationContentSignatureRegistry {
    private readonly tokens = new Map<string, string>();
    private nextToken = 0;

    constructor(private readonly maxEntries = 128) {}

    tokenFor(stream: string): string {
        const existing = this.tokens.get(stream);
        if (existing !== undefined) {
            this.tokens.delete(stream);
            this.tokens.set(stream, existing);
            return existing;
        }
        const token = `c${++this.nextToken}`;
        this.tokens.set(stream, token);
        while (this.tokens.size > this.maxEntries) {
            const oldestKey = this.tokens.keys().next().value;
            if (oldestKey === undefined || oldestKey === stream) {
                break;
            }
            this.tokens.delete(oldestKey);
        }
        return token;
    }

    clear(): void {
        this.tokens.clear();
    }

    get size(): number {
        return this.tokens.size;
    }
}

/**
 * Builds the exact render-stream string for a publication. Every fact
 * that can change the HTML appears exactly once per message, so two
 * streams are equal if and only if the rendered HTML is identical.
 */
export class ConversationContentStream {
    private readonly parts: string[] = [];

    mix(value: string): this {
        this.parts.push(value);
        return this;
    }

    mixMessage(
        message: ConversationMessage,
        signature: string,
        renderVersion: number
    ): this {
        return this.mix(message.id).mix(message.role).mix(signature)
            .mix(String(renderVersion));
    }

    toString(): string {
        return JSON.stringify(this.parts);
    }
}
