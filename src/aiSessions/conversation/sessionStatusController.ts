'use strict';

import type * as vscode from 'vscode';

export interface ConversationSessionStatus {
    runningSessions: number;
    attentionSessions: number;
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

function sanitizeSessionCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
}

export function sanitizeConversationSessionStatus(
    status: ConversationSessionStatus | undefined
): ConversationSessionStatus {
    return {
        runningSessions: sanitizeSessionCount(status?.runningSessions),
        attentionSessions: sanitizeSessionCount(status?.attentionSessions),
    };
}

export function formatConversationSessionStatusLabel(
    kind: 'running' | 'attention',
    count: number
): string {
    const safeCount = sanitizeSessionCount(count);
    if (kind === 'running') {
        if (safeCount === 0) {
            return 'No AI sessions running';
        }
        return safeCount === 1
            ? '1 AI session running across all windows'
            : `${safeCount} AI sessions running across all windows`;
    }
    if (safeCount === 0) {
        return 'No AI sessions need attention';
    }
    return safeCount === 1
        ? '1 AI session needs attention across all windows'
        : `${safeCount} AI sessions need attention across all windows`;
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

    async publish(): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel || !this.options.readStatus || this.options.isSuspended()) {
            return;
        }
        const status = this.snapshot;
        if (!status) {
            return;
        }
        const deliveryKey = `${status.runningSessions}:${status.attentionSessions}`;
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
