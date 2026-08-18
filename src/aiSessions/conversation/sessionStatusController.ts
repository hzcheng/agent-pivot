'use strict';

import type * as vscode from 'vscode';

export interface ConversationSessionStatus {
    /** Running sessions across all windows. */
    runningSessions: number;
    /** Sessions needing attention across all windows. */
    attentionSessions: number;
    /** Running sessions in this window's workspace. */
    runningSessionsLocal: number;
    /** Sessions needing attention in this window's workspace. */
    attentionSessionsLocal: number;
}

export interface ConversationViewerSessionStatusMessage {
    type: 'conversation-viewer-session-status';
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    status: ConversationSessionStatus;
}

export interface ConversationSessionStatusControllerOptions {
    readStatus?: () => ConversationSessionStatus | undefined;
    getPanel: () => vscode.WebviewPanel | undefined;
    getSubscriptionGeneration: () => number;
    getCurrentRequestId: () => number;
    isSuspended: () => boolean;
    rebuildLatestDocument: () => void;
}

const MAX_SESSION_STATUS_COUNT = 100_000;

function sanitizeSessionCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(Math.floor(value), MAX_SESSION_STATUS_COUNT)
        : 0;
}

export function sanitizeConversationSessionStatus(
    status: ConversationSessionStatus | undefined
): ConversationSessionStatus {
    const runningSessions = sanitizeSessionCount(status?.runningSessions);
    const attentionSessions = sanitizeSessionCount(status?.attentionSessions);
    return {
        runningSessions,
        attentionSessions,
        // A window's own sessions are a subset of the cross-window total:
        // never let a desynced reader report more local than global.
        runningSessionsLocal: Math.min(
            sanitizeSessionCount(status?.runningSessionsLocal),
            runningSessions
        ),
        attentionSessionsLocal: Math.min(
            sanitizeSessionCount(status?.attentionSessionsLocal),
            attentionSessions
        ),
    };
}

export function formatConversationSessionStatusLabel(
    kind: 'running' | 'attention',
    localCount: number,
    totalCount: number
): string {
    const total = sanitizeSessionCount(totalCount);
    const local = Math.min(sanitizeSessionCount(localCount), total);
    if (total === 0) {
        return kind === 'running'
            ? 'No AI sessions running'
            : 'No AI sessions need attention';
    }
    if (kind === 'running') {
        return `${local} running in this window · ${total} across all windows`;
    }
    return `${local} need attention in this window · ${total} across all windows`;
}

export class ConversationSessionStatusController {
    private lastDeliveredKey: string | undefined;

    constructor(
        private readonly options: ConversationSessionStatusControllerOptions
    ) {}

    get snapshot(): ConversationSessionStatus | undefined {
        if (!this.options.readStatus) {
            return undefined;
        }
        try {
            return sanitizeConversationSessionStatus(this.options.readStatus());
        } catch (_error) {
            return undefined;
        }
    }

    async republish(): Promise<void> {
        this.lastDeliveredKey = undefined;
        return this.publish();
    }

    async publish(): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel || !this.options.readStatus || this.options.isSuspended()) {
            return;
        }
        const status = this.snapshot;
        if (!status) {
            return;
        }
        const deliveryKey = `${status.runningSessions}:${status.attentionSessions}`
            + `:${status.runningSessionsLocal}:${status.attentionSessionsLocal}`;
        if (deliveryKey === this.lastDeliveredKey) {
            return;
        }
        const generation = this.options.getSubscriptionGeneration();
        const message: ConversationViewerSessionStatusMessage = {
            type: 'conversation-viewer-session-status',
            version: 1,
            requestId: this.options.getCurrentRequestId(),
            subscriptionGeneration: generation,
            status,
        };
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(message);
        } catch (_error) {
            delivered = false;
        }
        if (delivered) {
            this.lastDeliveredKey = deliveryKey;
            return;
        }
        if (this.options.getPanel() === panel
            && this.options.getSubscriptionGeneration() === generation) {
            this.options.rebuildLatestDocument();
        }
    }
}
