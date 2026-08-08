'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationFileDiff,
    ConversationToolCall,
} from './types';
import { capToolCallDetail } from './text';

interface ToolCallInteraction {
    assistantMarkdown: string[];
    toolCalls?: ConversationToolCall[];
}

/**
 * Accumulates tool-call events for one interaction stream. Calls land at
 * `position = assistantMarkdown.length` (the number of text chunks already
 * emitted), which lets the page builder interleave tools and text in
 * arrival order; results are paired back onto their call by provider id.
 */
export class ToolCallTracker {
    private readonly pending = new Map<string, ConversationToolCall>();

    begin(
        interaction: ToolCallInteraction,
        key: string | undefined,
        name: string,
        summary: string,
        detail?: string,
        diffs?: ConversationFileDiff[]
    ): void {
        const call: ConversationToolCall = {
            position: interaction.assistantMarkdown.length,
            name,
            summary,
            ...(detail ? { detail } : {}),
            ...(diffs && diffs.length
                ? {
                    diffs: diffs.slice(
                        0,
                        CONVERSATION_LIMITS.maxDiffsPerToolCall
                    ),
                }
                : {}),
        };
        (interaction.toolCalls ||= []).push(call);
        if (key) {
            this.pending.set(key, call);
        }
    }

    /** Attaches diff payloads to a still-pending call (approval previews). */
    attachDiffs(key: unknown, diffs: ConversationFileDiff[]): boolean {
        if (typeof key !== 'string' || !diffs.length) {
            return false;
        }
        const call = this.pending.get(key);
        if (!call) {
            return false;
        }
        call.diffs = (call.diffs ? call.diffs.concat(diffs) : diffs.slice())
            .slice(0, CONVERSATION_LIMITS.maxDiffsPerToolCall);
        return true;
    }

    /** Appends bounded detail without consuming the pending pairing. */
    appendDetail(key: unknown, text: string): boolean {
        if (typeof key !== 'string') {
            return false;
        }
        const call = this.pending.get(key);
        if (!call) {
            return false;
        }
        const capped = capToolCallDetail(text);
        if (!capped) {
            return true;
        }
        const combined = call.detail
            ? `${call.detail}\n---\n${capped}`
            : capped;
        call.detail = capToolCallDetail(combined) ?? call.detail;
        return true;
    }

    finish(key: unknown, output: string | undefined): void {
        if (typeof key !== 'string') {
            return;
        }
        const call = this.pending.get(key);
        if (!call) {
            return;
        }
        this.pending.delete(key);
        const capped = capToolCallDetail(output ?? '');
        if (!capped) {
            return;
        }
        const combined = call.detail
            ? `${call.detail}\n---\n${capped}`
            : capped;
        call.detail = capToolCallDetail(combined) ?? call.detail;
    }
}
