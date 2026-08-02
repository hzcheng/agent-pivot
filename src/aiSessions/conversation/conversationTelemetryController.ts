'use strict';

import * as vscode from 'vscode';
import type { ConversationViewerTarget } from './viewerTarget';
import {
    ConversationAbortSignal,
    ConversationTelemetry,
} from './types';

interface ConversationViewerTelemetryMessage {
    type: 'conversation-viewer-telemetry';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    telemetry: ConversationTelemetry | null;
}

export interface ConversationTelemetryControllerOptions {
    readTelemetry?: (
        provider: ConversationViewerTarget['provider'],
        sessionId: string,
        signal?: ConversationAbortSignal
    ) => Promise<ConversationTelemetry | undefined>;
    getPanel: () => vscode.WebviewPanel | undefined;
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    getCurrentRequestId: () => number;
    isSuspended: () => boolean;
    rebuildLatestDocument: () => void;
}

export class ConversationTelemetryController {
    private telemetry?: ConversationTelemetry;

    constructor(
        private readonly options: ConversationTelemetryControllerOptions
    ) {}

    get snapshot(): ConversationTelemetry | undefined {
        return this.telemetry;
    }

    reset(): void {
        this.telemetry = undefined;
    }

    async refresh(
        target: ConversationViewerTarget,
        generation: number,
        sessionId = target.sessionId
    ): Promise<void> {
        if (!this.options.readTelemetry) {
            return;
        }
        let telemetry: ConversationTelemetry | undefined;
        try {
            telemetry = await this.options.readTelemetry(
                target.provider,
                sessionId
            );
        } catch (_error) {
            telemetry = undefined;
        }
        const panel = this.options.getPanel();
        if (!panel
            || this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.options.isSuspended()) {
            return;
        }
        this.telemetry = telemetry;
        const message: ConversationViewerTelemetryMessage = {
            type: 'conversation-viewer-telemetry',
            version: 1,
            requestId: this.options.getCurrentRequestId(),
            subscriptionGeneration: generation,
            telemetry: telemetry || null,
        };
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(message);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered
            && this.options.getTarget() === target
            && this.options.getSubscriptionGeneration() === generation) {
            this.options.rebuildLatestDocument();
        }
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(
            value >= 10_000_000 ? 0 : 1
        )}m`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
    }
    return String(value);
}

function formatResetTime(resetsAt: number): string {
    const remainingMs = Math.max(0, resetsAt * 1000 - Date.now());
    const remainingMins = Math.max(1, Math.ceil(remainingMs / 60_000));
    if (remainingMins < 60) {
        return `${remainingMins}m`;
    }
    const remainingHours = Math.ceil(remainingMins / 60);
    if (remainingHours < 48) {
        return `${remainingHours}h`;
    }
    return `${Math.ceil(remainingHours / 24)}d`;
}

const WORKTREE_ICON_SVG = '<svg viewBox="0 0 16 16" width="11" height="11"'
    + ' aria-hidden="true" fill="none" stroke="currentColor"'
    + ' stroke-width="1.4"><circle cx="4.5" cy="3.5" r="1.8"/>'
    + '<circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5.5" r="1.8"/>'
    + '<path d="M4.5 5.3v5.4M11.5 7.3c0 2.4-2.6 2.8-4.7 3"/></svg>';

export function renderConversationTelemetry(
    telemetry: ConversationTelemetry | undefined
): string {
    const hasContext = Boolean(telemetry?.context);
    const hasModel = Boolean(telemetry?.model);
    const worktree = telemetry?.worktree;
    const hasWorktree = Boolean(worktree);
    const limits = telemetry?.rateLimits || [];
    const context = telemetry?.context;
    const contextPercent = context
        ? Math.max(0, Math.min(
            100,
            context.usedTokens / context.maxTokens * 100
        ))
        : 0;
    const limitMarkup = limits.map(limit => {
        const remaining = Math.max(0, 100 - limit.usedPercent);
        const reset = limit.resetsAt
            ? ` · resets in ${formatResetTime(limit.resetsAt)}`
            : '';
        const resetTitle = limit.resetsAt
            ? ` title="${escapeAttribute(
                new Date(limit.resetsAt * 1000).toLocaleString()
            )}"`
            : '';
        return `<div class="conversation-telemetry-meter">
            <span>${escapeHtml(limit.label)}</span>
            <progress max="100" value="${limit.usedPercent}"
                aria-label="${escapeAttribute(`${limit.label} usage`)}"></progress>
            <span${resetTitle}>${escapeHtml(
                `${Math.round(remaining)}% left${reset}`
            )}</span>
        </div>`;
    }).join('');
    const worktreeTitle = worktree
        ? worktree.missing
            ? `Worktree path no longer exists: ${worktree.worktreeRoot} (branch ${worktree.branch})`
            : `Working in worktree: ${worktree.worktreeRoot} (branch ${worktree.branch}) · Click to show changes in Source Control`
        : '';
    return `<section class="conversation-telemetry"
        data-conversation-telemetry aria-label="Session usage">
        <button type="button"
            class="conversation-telemetry-worktree${worktree?.missing
                ? ' conversation-telemetry-worktree-missing'
                : ''}"
            data-telemetry-worktree
            data-worktree-root="${escapeAttribute(
                worktree?.worktreeRoot || ''
            )}"
            title="${escapeAttribute(worktreeTitle)}"${hasWorktree
                ? ''
                : ' hidden'}>
            ${WORKTREE_ICON_SVG}<span data-telemetry-worktree-branch>${escapeHtml(
                worktree?.branch || ''
            )}</span>
        </button>
        <div class="conversation-telemetry-model"
            data-telemetry-model${hasModel ? '' : ' hidden'}>
            <span>Model</span>
            <strong data-telemetry-model-value>${escapeHtml(
                telemetry?.model || ''
            )}</strong>
        </div>
        <div class="conversation-telemetry-meter"
            data-telemetry-context${hasContext ? '' : ' hidden'}>
            <span>Context</span>
            <progress data-telemetry-context-progress
                max="${context?.maxTokens || 1}"
                value="${context?.usedTokens || 0}"
                aria-label="Context window usage"></progress>
            <span data-telemetry-context-value>${context
                ? escapeHtml(
                    `${Math.round(contextPercent)}% · ${formatTokenCount(
                        context.usedTokens
                    )} / ${formatTokenCount(context.maxTokens)}`
                )
                : ''}</span>
        </div>
        <div class="conversation-telemetry-limits"
            data-telemetry-limits>${limitMarkup}</div>
        <button type="button"
            class="conversation-telemetry-comments"
            data-telemetry-comments
            title="0 comments — click to review">Comments 0</button>
        <button type="button"
            class="conversation-telemetry-subagents"
            data-telemetry-subagents
            title="0 running of 0 subagents — click to view">Agents 0/0</button>
    </section>`;
}
