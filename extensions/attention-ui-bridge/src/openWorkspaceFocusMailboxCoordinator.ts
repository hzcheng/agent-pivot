'use strict';

import * as fs from 'fs';

import {
    OpenWorkspaceFocusMailboxRequest,
    OpenWorkspaceFocusMailboxStoreLike,
} from './openWorkspaceFocusMailboxStore';

const SCAN_INTERVAL_MS = 2_000;
const DELIVERY_WAIT_MS = 5_000;

export interface OpenWorkspaceFocusMailboxWatcher {
    close(): void;
}

export interface OpenWorkspaceFocusMailboxCoordinatorDependencies<
    Request extends OpenWorkspaceFocusMailboxRequest,
> {
    now(): number;
    deliverRequest(request: Request): PromiseLike<unknown> | unknown;
    isNavigationWinner(navigationIdentity: string): Promise<boolean>;
    reportError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    createWatcher(
        directoryPath: string,
        onDidChange: () => void,
    ): OpenWorkspaceFocusMailboxWatcher;
    deliveryWaitMs?: number;
}

export interface OpenWorkspaceFocusMailboxCoordinatorOptions<
    Request extends OpenWorkspaceFocusMailboxRequest,
    Outcome,
> {
    readonly store: OpenWorkspaceFocusMailboxStoreLike<Request>;
    readonly dependencies: OpenWorkspaceFocusMailboxCoordinatorDependencies<Request>;
    readonly validateRequest: (raw: unknown) => Request;
    readonly createOutcome: (request: Request) => Outcome;
    readonly deliveryTimeoutMessage: string;
    readonly disposedMessage: string;
}

/**
 * Owns the shared request-delivery state machine for cross-window focus.
 * Protocol wrappers provide their request validation, outcome, and mailbox;
 * claim, retry, receipt, and single-flight scan behavior live only here.
 */
export class OpenWorkspaceFocusMailboxCoordinator<
    Request extends OpenWorkspaceFocusMailboxRequest,
    Outcome,
> {
    private readonly watcher: OpenWorkspaceFocusMailboxWatcher;
    private readonly intervalHandle: unknown;
    private scanFlight: Promise<void> | null = null;
    private scanRequested = false;
    private disposed = false;

    constructor(private readonly options: OpenWorkspaceFocusMailboxCoordinatorOptions<Request, Outcome>) {
        fs.mkdirSync(options.store.directoryPath, { recursive: true, mode: 0o700 });
        this.watcher = options.dependencies.createWatcher(
            options.store.directoryPath,
            () => this.requestDelivery(),
        );
        this.intervalHandle = options.dependencies.setInterval(
            () => this.requestDelivery(),
            SCAN_INTERVAL_MS,
        );
    }

    async submit(raw: unknown): Promise<Outcome> {
        this.ensureActive();
        const request = await this.options.store.submit(
            this.options.validateRequest(raw),
        );
        this.requestDelivery();
        const delivered = await this.options.store.waitForDelivery(
            request.requestId,
            this.options.dependencies.deliveryWaitMs ?? DELIVERY_WAIT_MS,
        );
        if (!delivered) {
            await this.options.store.cancel(request.requestId);
            throw new Error(this.options.deliveryTimeoutMessage);
        }
        return this.options.createOutcome(request);
    }

    requestDelivery(): void {
        if (this.disposed) {
            return;
        }
        void this.scanAndDeliver().catch(error => this.options.dependencies.reportError(error));
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.options.dependencies.clearInterval(this.intervalHandle);
        this.watcher.close();
    }

    private scanAndDeliver(): Promise<void> {
        if (this.scanFlight) {
            this.scanRequested = true;
            return this.scanFlight;
        }
        const flight = this.runQueuedScans();
        this.scanFlight = flight;
        void flight.then(
            () => { if (this.scanFlight === flight) this.scanFlight = null; },
            () => { if (this.scanFlight === flight) this.scanFlight = null; },
        );
        return flight;
    }

    private async runQueuedScans(): Promise<void> {
        do {
            this.scanRequested = false;
            await this.scanOnce();
        } while (this.scanRequested && !this.disposed);
    }

    private async scanOnce(): Promise<void> {
        const requests = await this.options.store.scan(this.options.dependencies.now());
        for (const request of requests) {
            if (this.disposed) {
                return;
            }
            let winner = false;
            try {
                winner = await this.options.dependencies
                    .isNavigationWinner(request.targetNavigationIdentity);
            } catch (error) {
                this.options.dependencies.reportError(error);
                continue;
            }
            if (!winner || !await this.options.store.claim(request.requestId)) {
                continue;
            }
            try {
                await this.options.dependencies.deliverRequest(request);
                await this.options.store.complete(request.requestId);
            } catch (error) {
                this.options.dependencies.reportError(error);
                await this.options.store.restore(request.requestId);
            }
        }
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new Error(this.options.disposedMessage);
        }
    }
}
