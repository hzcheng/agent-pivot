'use strict';

const MAX_REMEMBERED_REQUEST_IDS = 100;

export interface OpenWorkspaceFocusBridgeRequest {
    requestId: string;
    targetNavigationIdentity: string;
}

export interface OpenWorkspaceFocusBridgeOutcome {
    requestId: string;
    targetNavigationIdentity: string;
}

export interface OpenWorkspaceFocusBridgeChannelOptions<
    Target,
    Request extends OpenWorkspaceFocusBridgeRequest,
    Outcome extends OpenWorkspaceFocusBridgeOutcome,
> {
    readonly requestCommand: string;
    readonly validateRequest: (raw: unknown) => Request;
    readonly createRequest: (input: {
        requestId: string;
        targetNavigationIdentity: string;
        target: Target;
        nowMs: number;
    }) => Request;
    readonly validateOutcome: (raw: unknown) => Outcome;
    readonly deliverRequest: (request: Request) => unknown;
    readonly prepareRequest: () => Promise<boolean>;
    readonly isDisposed: () => boolean;
    readonly createRequestId: () => string;
    readonly now: () => number;
    readonly executeCommand: (command: string, argument: unknown) => PromiseLike<unknown>;
    readonly reportError: (error: unknown) => void;
}

/**
 * Owns the main-extension side of one cross-window focus channel. Protocol
 * modules provide request and outcome validation; correlation, bounded
 * delivery de-duplication, retry eligibility, and failure isolation live here.
 */
export class OpenWorkspaceFocusBridgeChannel<
    Target,
    Request extends OpenWorkspaceFocusBridgeRequest,
    Outcome extends OpenWorkspaceFocusBridgeOutcome,
> {
    private readonly deliveredRequestIds = new Set<string>();

    constructor(
        private readonly options: OpenWorkspaceFocusBridgeChannelOptions<Target, Request, Outcome>,
    ) {}

    receive(raw: unknown): void {
        if (this.options.isDisposed()) {
            return;
        }
        let request: Request;
        try {
            request = this.options.validateRequest(raw);
        } catch (error) {
            // A malformed request cannot become deliverable on retry, so the
            // UI-host mailbox may consume it after this diagnostic.
            this.reportSafely(error);
            return;
        }
        if (this.deliveredRequestIds.has(request.requestId)) {
            return;
        }
        if (this.deliveredRequestIds.size >= MAX_REMEMBERED_REQUEST_IDS) {
            const oldest = this.deliveredRequestIds.values().next();
            if (!oldest.done) {
                this.deliveredRequestIds.delete(oldest.value);
            }
        }
        this.deliveredRequestIds.add(request.requestId);
        try {
            const task = this.options.deliverRequest(request);
            // Acceptance into the serialized navigation queue is delivery.
            // Later failures must not repeat a partially visible jump.
            void Promise.resolve(task).catch(error => this.reportSafely(error));
        } catch (error) {
            // A synchronous rejection means no action was queued. Remove the
            // ID so the UI-host mailbox can restore and retry its claim.
            this.deliveredRequestIds.delete(request.requestId);
            this.reportSafely(error);
            throw error;
        }
    }

    async request(targetNavigationIdentity: string, target: Target): Promise<boolean> {
        if (!await this.options.prepareRequest()) {
            return false;
        }
        let request: Request;
        try {
            request = this.options.createRequest({
                requestId: this.options.createRequestId(),
                targetNavigationIdentity,
                target,
                nowMs: this.options.now(),
            });
        } catch (error) {
            this.options.reportError(error);
            return false;
        }
        try {
            const outcome = this.options.validateOutcome(
                await this.options.executeCommand(this.options.requestCommand, request),
            );
            return outcome.requestId === request.requestId
                && outcome.targetNavigationIdentity === request.targetNavigationIdentity;
        } catch (error) {
            if (!this.options.isDisposed()) {
                this.options.reportError(error);
            }
            return false;
        }
    }

    private reportSafely(error: unknown): void {
        try {
            this.options.reportError(error);
        } catch (_reportError) {
            // Diagnostics must never change incoming delivery behavior.
        }
    }
}
