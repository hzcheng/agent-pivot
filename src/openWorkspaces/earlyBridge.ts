'use strict';

import type { OpenWorkspaceAggregate } from './protocol';
import type { OpenWorkspaceBridgeStatus } from './bridgeClient';
import type { OpenWorkspacePinSnapshot } from './pinProtocol';
import type { OpenWorkspaceRunningFocusRequest } from './runningFocusProtocol';
import type { OpenWorkspaceAttentionFocusRequest } from './attentionFocusProtocol';

export interface OpenWorkspaceBridgeHandlers {
    onAggregate: (aggregate: OpenWorkspaceAggregate) => unknown;
    onStatusChange: (status: OpenWorkspaceBridgeStatus) => void;
    onPinSnapshot: (snapshot: OpenWorkspacePinSnapshot) => unknown;
    onRunningFocusRequest: (request: OpenWorkspaceRunningFocusRequest) => unknown;
    onAttentionFocusRequest: (request: OpenWorkspaceAttentionFocusRequest) => unknown;
    onError: (error: unknown) => void;
}

export interface EarlyOpenWorkspaceBridgeOptions<TClient> {
    createClient: (handlers: OpenWorkspaceBridgeHandlers) => TClient;
    logError: (message: string, error: unknown) => void;
}

/**
 * Owns the Open Windows bridge client across bootstrap generations so its
 * cross-host handshake can start immediately instead of after the dashboard is
 * built.
 *
 * The handshake is a round trip to the UI host and measured 0.6-1.3s, but the
 * client used to be constructed 590-1055ms into bootstrap, so that round trip
 * ran strictly after all local work rather than alongside it. Creating the
 * client first means aggregates can arrive before the dashboard controller
 * exists, so state that lands early is buffered (latest wins, since every one
 * of these values is a snapshot) and replayed on adoption.
 *
 * The client also outlives a bootstrap generation. Re-adopting after a retry
 * reuses it rather than registering its commands a second time, which would
 * throw.
 */
export class EarlyOpenWorkspaceBridge<TClient> {
    private readonly client: TClient;
    private handlers: OpenWorkspaceBridgeHandlers | null = null;
    private pendingAggregate: OpenWorkspaceAggregate | null = null;
    private pendingStatus: OpenWorkspaceBridgeStatus | null = null;
    private pendingPinSnapshot: OpenWorkspacePinSnapshot | null = null;

    constructor(private readonly options: EarlyOpenWorkspaceBridgeOptions<TClient>) {
        this.client = options.createClient({
            onAggregate: aggregate => this.deliver(
                'aggregate',
                handlers => handlers.onAggregate(aggregate),
                () => { this.pendingAggregate = aggregate; },
            ),
            onStatusChange: status => this.deliver(
                'status',
                handlers => handlers.onStatusChange(status),
                () => { this.pendingStatus = status; },
            ),
            onPinSnapshot: snapshot => this.deliver(
                'pin snapshot',
                handlers => handlers.onPinSnapshot(snapshot),
                () => { this.pendingPinSnapshot = snapshot; },
            ),
            // Focus hand-offs are mailbox actions. Rejecting before adoption
            // keeps the claim retryable; acknowledging a drop would let the
            // source switch windows before any local jump was queued.
            onRunningFocusRequest: request => this.deliver(
                'running focus request',
                handlers => handlers.onRunningFocusRequest(request),
                () => {
                    const error = new Error(
                        'running focus request cannot be delivered before adoption',
                    );
                    this.options.logError(
                        'Agent Pivot open workspace bridge received a running focus request before adoption.',
                        error,
                    );
                    throw error;
                },
            ),
            onAttentionFocusRequest: request => this.deliver(
                'attention focus request',
                handlers => handlers.onAttentionFocusRequest(request),
                () => {
                    const error = new Error(
                        'attention focus request cannot be delivered before adoption',
                    );
                    this.options.logError(
                        'Agent Pivot open workspace bridge received an attention focus request before adoption.',
                        error,
                    );
                    throw error;
                },
            ),
            // Errors are diagnostics about a moment that has passed. Replaying
            // them later would report a stale outage as a fresh one.
            onError: error => this.deliver(
                'error',
                handlers => handlers.onError(error),
                () => this.options.logError(
                    'Agent Pivot open workspace bridge failed before adoption.',
                    error,
                ),
            ),
        });
    }

    getClient(): TClient {
        return this.client;
    }

    adopt(handlers: OpenWorkspaceBridgeHandlers): TClient {
        this.handlers = handlers;
        const status = this.pendingStatus;
        const pinSnapshot = this.pendingPinSnapshot;
        const aggregate = this.pendingAggregate;
        this.pendingStatus = null;
        this.pendingPinSnapshot = null;
        this.pendingAggregate = null;
        // Status first so the section stops claiming it is still connecting,
        // then the pin snapshot the aggregate's cards are rendered against.
        if (status !== null) {
            this.replay('status', () => handlers.onStatusChange(status));
        }
        if (pinSnapshot !== null) {
            this.replay('pin snapshot', () => handlers.onPinSnapshot(pinSnapshot));
        }
        if (aggregate !== null) {
            this.replay('aggregate', () => handlers.onAggregate(aggregate));
        }
        return this.client;
    }

    /** Returns to buffering when a bootstrap generation is disposed. */
    release(): void {
        this.handlers = null;
    }

    private deliver(
        kind: string,
        toHandlers: (handlers: OpenWorkspaceBridgeHandlers) => unknown,
        buffer: () => void,
    ): void {
        const handlers = this.handlers;
        if (!handlers) {
            buffer();
            return;
        }
        this.replay(kind, () => toHandlers(handlers));
    }

    private replay(kind: string, run: () => unknown): void {
        try {
            run();
        } catch (error) {
            // A failed hand-off must not propagate into the bridge client's
            // delivery acknowledgement, and must not re-buffer: the handlers
            // already own this value and would receive it twice on retry.
            this.options.logError(
                `Agent Pivot open workspace bridge ${kind} handling failed.`,
                error,
            );
        }
    }
}
