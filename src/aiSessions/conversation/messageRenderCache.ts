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
    }>();
    private cachedBytes = 0;

    constructor(
        private readonly maxBytes = 8 * 1024 * 1024,
    ) {}

    render(
        messageId: string,
        signature: string,
        render: () => string
    ): string {
        const existing = this.entries.get(messageId);
        if (existing && existing.signature === signature) {
            // Refresh the recency order without touching the byte total.
            this.entries.delete(messageId);
            this.entries.set(messageId, existing);
            return existing.html;
        }
        const html = render();
        if (existing) {
            this.cachedBytes -= existing.html.length;
        }
        this.entries.set(messageId, { signature, html });
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
        return html;
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
 * Composes a publication-level content signature from the ordered stream
 * of per-message facts that fully determine the final HTML, without
 * re-hashing the HTML itself. FNV-1a over a few kilobytes of small strings
 * is effectively free compared to rendering.
 */
export class ConversationContentSignature {
    private hash = 0x811c9dc5;

    mix(value: string): this {
        for (let index = 0; index < value.length; index++) {
            this.hash ^= value.charCodeAt(index);
            this.hash = Math.imul(this.hash, 0x01000193);
        }
        this.hash ^= 0xff;
        this.hash = Math.imul(this.hash, 0x01000193);
        return this;
    }

    mixMessage(
        message: ConversationMessage,
        signature: string
    ): this {
        return this.mix(message.id).mix(message.role).mix(signature);
    }

    toString(): string {
        return (this.hash >>> 0).toString(16);
    }
}
