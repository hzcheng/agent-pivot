'use strict';

import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import {
    claudeLogo,
    kimiLogo,
    openAiLogo,
} from '../../webviewIcons';
import type { ConversationViewerTarget } from './viewerTarget';
import type { ConversationSessionStatusKind } from './sessionStatusController';
import {
    CONVERSATION_LIMITS,
    ConversationAbortSignal,
    ConversationTelemetry,
} from './types';

type TimerHandle = unknown;

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
    /** Fires after each successful telemetry publish (changes-panel PRD
     * §5.4: the telemetry cycle is the changes collector's fallback). */
    onDidPublish?: (
        target: ConversationViewerTarget,
        telemetry: ConversationTelemetry | undefined
    ) => void;
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
}

export class ConversationTelemetryController {
    private telemetry?: ConversationTelemetry;
    private refreshTimer?: TimerHandle;
    private active?: {
        target: ConversationViewerTarget;
        generation: number;
        sessionId: string;
    };
    private refreshInFlight?: {
        target: ConversationViewerTarget;
        generation: number;
        sessionId: string;
        promise: Promise<void>;
    };

    constructor(
        private readonly options: ConversationTelemetryControllerOptions
    ) {}

    get snapshot(): ConversationTelemetry | undefined {
        return this.telemetry;
    }

    reset(): void {
        this.pause();
        this.telemetry = undefined;
    }

    activate(
        target: ConversationViewerTarget,
        generation: number,
        sessionId = target.sessionId
    ): void {
        this.pause();
        this.active = { target, generation, sessionId };
        if (!this.matchesRefresh(
            this.refreshInFlight,
            target,
            generation,
            sessionId
        )) {
            this.scheduleRefresh();
        }
    }

    pause(): void {
        this.clearRefreshTimer();
        this.active = undefined;
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer !== undefined) {
            const clearTimer = this.options.clearTimer || (handle =>
                clearTimeout(handle as ReturnType<typeof setTimeout>)
            );
            clearTimer(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    refresh(
        target: ConversationViewerTarget,
        generation: number,
        sessionId = target.sessionId
    ): Promise<void> {
        if (this.matchesRefresh(
            this.refreshInFlight,
            target,
            generation,
            sessionId
        )) {
            return this.refreshInFlight.promise;
        }
        if (this.matchesRefresh(
            this.active,
            target,
            generation,
            sessionId
        )) {
            this.clearRefreshTimer();
        }
        const promise = this.readAndPublish(target, generation, sessionId);
        const refresh = { target, generation, sessionId, promise };
        this.refreshInFlight = refresh;
        return promise.finally(() => {
            if (this.refreshInFlight === refresh) {
                this.refreshInFlight = undefined;
            }
            if (this.matchesRefresh(
                this.active,
                target,
                generation,
                sessionId
            )) {
                this.scheduleRefresh();
            }
        });
    }

    private async readAndPublish(
        target: ConversationViewerTarget,
        generation: number,
        sessionId: string
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
        this.options.onDidPublish?.(target, telemetry);
    }

    private scheduleRefresh(): void {
        const active = this.active;
        const panel = this.options.getPanel();
        if (!active || !this.options.readTelemetry || !panel?.visible
            || this.options.isSuspended()) {
            return;
        }
        const setTimer = this.options.setTimer || setTimeout;
        this.refreshTimer = setTimer(() => {
            this.refreshTimer = undefined;
            void this.refresh(
                active.target,
                active.generation,
                active.sessionId
            );
        }, CONVERSATION_LIMITS.telemetryRefreshMs);
    }

    private matchesRefresh(
        candidate: {
            target: ConversationViewerTarget;
            generation: number;
            sessionId: string;
        } | undefined,
        target: ConversationViewerTarget,
        generation: number,
        sessionId: string
    ): boolean {
        return candidate?.target === target
            && candidate.generation === generation
            && candidate.sessionId === sessionId;
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

// Brand icons are the Simple Icons (CC0-1.0) logos shared with the
// dashboard Session cards.
const PROVIDER_ICON_CODEX_SVG = `<span data-provider-icon="codex"`
    + ` aria-hidden="true">${openAiLogo}</span>`;

const PROVIDER_ICON_KIMI_SVG = `<span data-provider-icon="kimi"`
    + ` aria-hidden="true">${kimiLogo}</span>`;

const PROVIDER_ICON_CLAUDE_SVG = `<span data-provider-icon="claude"`
    + ` aria-hidden="true">${claudeLogo}</span>`;

function providerLabel(provider: AiSessionProviderId): string {
    return provider === 'kimi'
        ? 'Kimi'
        : provider === 'claude' ? 'Claude' : 'Codex';
}

/** State suffix for the provider icon tooltip; mirrors the session-state
 * labels applied by the Webview telemetry script's setSessionState. */
function sessionStateLabel(kind: ConversationSessionStatusKind): string {
    if (kind === 'attention') {
        return 'Needs attention — click to clear';
    }
    return kind === 'running' ? 'Running' : 'Idle';
}

const MODEL_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35"'
    + ' stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="4" y="4" width="8" height="8" rx="2"/>'
    + '<path d="M6.5 1.8v2.1M9.5 1.8v2.1M6.5 12.1v2.1M9.5 12.1v2.1M1.8 6.5h2.1M12.1 6.5h2.1M1.8 9.5h2.1M12.1 9.5h2.1"/>'
    + '<path d="m6.5 8 1 1 2-2"/></svg>';

const CONTEXT_ICON_SVG = '<svg class="conversation-telemetry-ring-icon"'
    + ' viewBox="0 0 16 16" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.45" stroke-linecap="round">'
    + '<path d="M5.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1.5M10.5 3H12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1.5"/>'
    + '<path d="M6.5 6.2 8.3 8l-1.8 1.8"/></svg>';

const LIMIT_ICON_SVG = '<svg class="conversation-telemetry-ring-icon"'
    + ' viewBox="0 0 16 16" aria-hidden="true" fill="none"'
    + ' stroke="currentColor" stroke-width="1.35" stroke-linecap="round"'
    + ' stroke-linejoin="round"><rect x="2.5" y="3.5" width="11"'
    + ' height="10" rx="2"/><path d="M5 2v3M11 2v3M2.5 6.5h11"/>'
    + '<path d="M6.3 9h3.4l-2 3"/></svg>';

const POSITION_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35"'
    + ' stroke-linecap="round"><path d="M3 3.5h10M3 8h7M3 12.5h5"/>'
    + '<circle cx="12.2" cy="11.8" r="1.8"/></svg>';

const COMMENTS_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35"'
    + ' stroke-linejoin="round"><path d="M3.2 3h9.6A1.2 1.2 0 0 1 14 4.2v6.1a1.2 1.2 0 0 1-1.2 1.2H7l-3.4 2v-2H3.2A1.2 1.2 0 0 1 2 10.3V4.2A1.2 1.2 0 0 1 3.2 3Z"/>'
    + '<path d="M5 6.2h6M5 8.7h4"/></svg>';

const SUBAGENTS_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.35">'
    + '<circle cx="8" cy="3" r="1.7"/><circle cx="3.5" cy="12.5" r="1.7"/>'
    + '<circle cx="12.5" cy="12.5" r="1.7"/><path d="M8 4.7v3M8 7.7 4.5 11M8 7.7l3.5 3.3"/></svg>';

// Git branch glyph in the dashboard's house icon style (same geometry as
// webviewIcons.gitBranchAdd without the plus).
const CHANGES_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"'
    + ' fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="6" cy="5" r="2.1"/><circle cx="6" cy="19" r="2.1"/>'
    + '<circle cx="15" cy="7.5" r="2.1"/>'
    + '<path d="M6 7.1v9.8"/><path d="M6 15.5c0-3.2 2.9-5.3 6.8-5.8"/></svg>';

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}

function renderProgressRing(
    progressAttribute: string,
    percent: number,
    icon: string
): string {
    const rounded = Math.round(clampPercent(percent) * 10) / 10;
    const offset = Math.round((100 - rounded) * 10) / 10;
    return `<span class="conversation-telemetry-ring" aria-hidden="true">
        <svg class="conversation-telemetry-ring-progress" viewBox="0 0 36 36">
            <circle class="conversation-telemetry-ring-track"
                cx="18" cy="18" r="15.5" pathLength="100"></circle>
            <circle class="conversation-telemetry-ring-value"
                ${progressAttribute} cx="18" cy="18" r="15.5"
                pathLength="100" stroke-dasharray="100"
                stroke-dashoffset="${offset}"></circle>
        </svg>${icon}
    </span>`;
}

export function renderConversationTelemetry(
    telemetry: ConversationTelemetry | undefined,
    provider: AiSessionProviderId,
    sessionKind?: ConversationSessionStatusKind
): string {
    const providerTitle = `Provider · ${providerLabel(provider)}`
        + (sessionKind ? ` · ${sessionStateLabel(sessionKind)}` : '');
    const hasContext = Boolean(telemetry?.context);
    const hasModel = Boolean(telemetry?.model);
    const limits = telemetry?.rateLimits || [];
    const context = telemetry?.context;
    const contextPercent = context
        ? clampPercent(context.usedTokens / context.maxTokens * 100)
        : 0;
    const contextValue = `${Math.round(contextPercent)}%`;
    const contextDetails = context
        ? `Context window · ${contextValue} used\n${formatTokenCount(
            context.usedTokens
        )} / ${formatTokenCount(context.maxTokens)} tokens`
        : 'Context window';
    const limitMarkup = limits.map(limit => {
        const usedPercent = clampPercent(limit.usedPercent);
        const visibleValue = `${Math.round(usedPercent)}%`;
        const reset = limit.resetsAt
            ? ` · resets in ${formatResetTime(limit.resetsAt)}`
            : '';
        const details = `${limit.label} · ${visibleValue} used${reset}`;
        return `<div class="conversation-telemetry-usage conversation-telemetry-limit conversation-telemetry-tooltip"
            data-telemetry-limit data-telemetry-limit-id="${escapeAttribute(limit.id)}"
            role="meter" tabindex="0" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="${usedPercent}" aria-label="${escapeAttribute(details)}"
            data-tooltip="${escapeAttribute(details)}">
            ${renderProgressRing(
                'data-telemetry-limit-progress',
                usedPercent,
                LIMIT_ICON_SVG
            )}
            <strong data-telemetry-limit-value>${escapeHtml(visibleValue)}</strong>
        </div>`;
    }).join('');
    const modelTitle = telemetry?.model
        ? `Model · ${telemetry.model}`
        : 'Model';
    return `<section class="conversation-telemetry"
        data-conversation-telemetry aria-label="Session usage">
        <div class="conversation-telemetry-provider conversation-telemetry-tooltip"
            data-telemetry-provider data-provider="${escapeAttribute(provider)}"
            ${sessionKind
                ? `data-session-state="${escapeAttribute(sessionKind)}"`
                : ''}
            ${sessionKind === 'attention' ? 'role="button"' : ''}
            tabindex="0"
            aria-label="${escapeAttribute(providerTitle)}"
            data-tooltip="${escapeAttribute(providerTitle)}">
            ${PROVIDER_ICON_CODEX_SVG}${PROVIDER_ICON_KIMI_SVG}${PROVIDER_ICON_CLAUDE_SVG}
        </div>
        <div class="conversation-telemetry-model conversation-telemetry-tooltip"
            data-telemetry-model tabindex="0"
            aria-label="${escapeAttribute(modelTitle)}"
            data-tooltip="${escapeAttribute(modelTitle)}"${hasModel ? '' : ' hidden'}>
            ${MODEL_ICON_SVG}
            <strong data-telemetry-model-value>${escapeHtml(
                telemetry?.model || ''
            )}</strong>
        </div>
        <span class="conversation-telemetry-divider" aria-hidden="true"></span>
        <div class="conversation-telemetry-usage conversation-telemetry-context conversation-telemetry-tooltip"
            data-telemetry-context role="meter" aria-valuemin="0"
            tabindex="0" aria-valuemax="100" aria-valuenow="${contextPercent}"
            aria-label="${escapeAttribute(contextDetails)}"
            data-tooltip="${escapeAttribute(contextDetails)}"${hasContext ? '' : ' hidden'}>
            ${renderProgressRing(
                'data-telemetry-context-progress',
                contextPercent,
                CONTEXT_ICON_SVG
            )}
            <strong data-telemetry-context-value>${hasContext
                ? escapeHtml(contextValue)
                : ''}</strong>
        </div>
        <div class="conversation-telemetry-limits"
            data-telemetry-limits>${limitMarkup}</div>
        <span class="conversation-telemetry-spacer" aria-hidden="true"></span>
        <button type="button"
            class="conversation-telemetry-position conversation-telemetry-tooltip"
            data-conversation-position
            aria-pressed="false"
            aria-label="Input 0 of 0 — click to open the outline"
            data-tooltip="Input 0 of 0 — click to open the outline">
            ${POSITION_ICON_SVG}<span data-conversation-position-value>0/0</span>
        </button>
        <button type="button"
            class="conversation-telemetry-comments conversation-telemetry-tooltip"
            data-telemetry-comments
            aria-pressed="false"
            aria-label="0 open session comments · 0 open workspace notes — click to review"
            data-tooltip="0 open session comments · 0 open workspace notes — click to review">
            ${COMMENTS_ICON_SVG}<span data-telemetry-comments-value>0 · 0</span>
        </button>
        <button type="button"
            class="conversation-telemetry-subagents conversation-telemetry-tooltip"
            data-telemetry-subagents
            aria-pressed="false"
            aria-label="0 running of 0 subagents — click to view"
            data-tooltip="0 running of 0 subagents — click to view">
            ${SUBAGENTS_ICON_SVG}<span data-telemetry-subagents-value>0/0</span>
        </button>
        <button type="button"
            class="conversation-telemetry-changes conversation-telemetry-tooltip"
            data-telemetry-changes
            aria-pressed="false"
            aria-label="No changes — click to view"
            data-tooltip="No changes — click to view"
            hidden>
            ${CHANGES_ICON_SVG}<span data-telemetry-changes-value>0 · ↑0</span>
        </button>
    </section>`;
}
