'use strict';

import type * as vscode from 'vscode';

/** The session lifecycle groups the header status buttons cycle through. */
export type ConversationSessionStatusKind = 'running' | 'attention' | 'idle';

export interface ConversationSessionStatus {
    /** Running sessions across all windows. */
    runningSessions: number;
    /** Sessions needing attention across all windows. */
    attentionSessions: number;
    /** Running sessions in this window's workspace. */
    runningSessionsLocal: number;
    /** Sessions needing attention in this window's workspace. */
    attentionSessionsLocal: number;
    /** Idle sessions in this window's workspace. */
    idleSessionsLocal: number;
    /** Lifecycle group of the session the viewer currently shows, when that
     * session is live in this window; undefined for history-only views. */
    currentSessionKind?: ConversationSessionStatusKind;
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

const SESSION_STATUS_KINDS: readonly ConversationSessionStatusKind[] = [
    'running',
    'attention',
    'idle',
];

function sanitizeSessionKind(
    value: unknown
): ConversationSessionStatusKind | undefined {
    return SESSION_STATUS_KINDS.includes(value as ConversationSessionStatusKind)
        ? value as ConversationSessionStatusKind
        : undefined;
}

export function sanitizeConversationSessionStatus(
    status: ConversationSessionStatus | undefined
): ConversationSessionStatus {
    const runningSessions = sanitizeSessionCount(status?.runningSessions);
    const attentionSessions = sanitizeSessionCount(status?.attentionSessions);
    const sanitized: ConversationSessionStatus = {
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
        idleSessionsLocal: sanitizeSessionCount(status?.idleSessionsLocal),
    };
    // Keep the key absent (not undefined) when the viewed session is not a
    // live local session: posted messages and snapshots stay byte-stable.
    const currentSessionKind = sanitizeSessionKind(status?.currentSessionKind);
    if (currentSessionKind) {
        sanitized.currentSessionKind = currentSessionKind;
    }
    return sanitized;
}

export function formatConversationSessionStatusLabel(
    kind: ConversationSessionStatusKind,
    localCount: number
): string {
    const local = sanitizeSessionCount(localCount);
    if (kind === 'running') {
        return local === 0
            ? 'No AI sessions running in this window'
            : `${local} running in this window · click to switch to the next`;
    }
    if (kind === 'attention') {
        return local === 0
            ? 'No AI sessions need attention in this window'
            : `${local} need attention in this window · click to switch to the next`;
    }
    return local === 0
        ? 'No idle AI sessions in this window'
        : `${local} idle in this window · click to switch to the next`;
}

export class ConversationSessionStatusController {
    private lastDeliveredKey: string | undefined;
    private publishFlight: Promise<void> = Promise.resolve();

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
        return this.enqueuePublish(true);
    }

    async publish(): Promise<void> {
        return this.enqueuePublish(false);
    }

    /**
     * Open-workspace and attention bridge callbacks can arrive concurrently.
     * Serialize their reads and deliveries so a status captured before the
     * later lifecycle edge cannot be posted after the newer status with the
     * same viewer request id.
     */
    private enqueuePublish(force: boolean): Promise<void> {
        const publish = async () => {
            if (force) {
                this.lastDeliveredKey = undefined;
            }
            await this.publishLatest();
        };
        const queued = this.publishFlight.then(publish, publish);
        this.publishFlight = queued.then(() => undefined, () => undefined);
        return queued;
    }

    private async publishLatest(): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel || !this.options.readStatus || this.options.isSuspended()) {
            return;
        }
        const status = this.snapshot;
        if (!status) {
            return;
        }
        const deliveryKey = `${status.runningSessions}:${status.attentionSessions}`
            + `:${status.runningSessionsLocal}:${status.attentionSessionsLocal}`
            + `:${status.idleSessionsLocal}`
            + `:${status.currentSessionKind || ''}`;
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
