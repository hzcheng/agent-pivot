'use strict';

import * as fs from 'fs';

import {
    OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION,
    OpenWorkspaceRunningFocusOutcome,
    OpenWorkspaceRunningFocusRequest,
    validateOpenWorkspaceRunningFocusRequest,
} from '../../../src/openWorkspaces/runningFocusProtocol';
import { OpenWorkspaceRunningFocusStore } from './openWorkspaceRunningFocusStore';

const RUNNING_FOCUS_SCAN_INTERVAL_MS = 2_000;
const RUNNING_FOCUS_DELIVERY_WAIT_MS = 5_000;

interface OpenWorkspaceRunningFocusWatcher {
    close(): void;
}

export interface OpenWorkspaceRunningFocusCoordinatorDependencies {
    now(): number;
    deliverRequest(request: OpenWorkspaceRunningFocusRequest): PromiseLike<unknown> | unknown;
    isNavigationWinner(navigationIdentity: string): Promise<boolean>;
    reportError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    createWatcher(directoryPath: string, onDidChange: () => void): OpenWorkspaceRunningFocusWatcher;
    createStore?(rootDirectory: string): OpenWorkspaceRunningFocusStore;
    deliveryWaitMs?: number;
}

/**
 * Watches the shared running-focus mailbox and delivers each request to this
 * window's main extension only when this window is the navigation winner for
 * the request's target workspace — the same priority order direct navigation
 * uses, so the focus handoff lands in the window the user was switched to.
 * The winning window claims each request before delivery and receipts it only
 * after the main extension has accepted the handoff. Failed deliveries are
 * restored for retry until the submitter times out and cancels them.
 */
export class OpenWorkspaceRunningFocusCoordinator {
    private readonly store: OpenWorkspaceRunningFocusStore;
    private readonly watcher: OpenWorkspaceRunningFocusWatcher;
    private readonly intervalHandle: unknown;
    private scanFlight: Promise<void> | null = null;
    private scanRequested = false;
    private disposed = false;

    constructor(
        rootDirectory: string,
        private readonly dependencies: OpenWorkspaceRunningFocusCoordinatorDependencies,
    ) {
        this.store = dependencies.createStore
            ? dependencies.createStore(rootDirectory)
            : new OpenWorkspaceRunningFocusStore(rootDirectory);
        fs.mkdirSync(this.store.directoryPath, { recursive: true, mode: 0o700 });
        this.watcher = dependencies.createWatcher(
            this.store.directoryPath,
            () => this.requestDelivery(),
        );
        this.intervalHandle = dependencies.setInterval(
            () => this.requestDelivery(),
            RUNNING_FOCUS_SCAN_INTERVAL_MS,
        );
    }

    async submit(raw: unknown): Promise<OpenWorkspaceRunningFocusOutcome> {
        this.ensureActive();
        const request = await this.store.submit(
            validateOpenWorkspaceRunningFocusRequest(raw),
        );
        this.requestDelivery();
        const delivered = await this.store.waitForDelivery(
            request.requestId,
            this.dependencies.deliveryWaitMs ?? RUNNING_FOCUS_DELIVERY_WAIT_MS,
        );
        if (!delivered) {
            await this.store.cancel(request.requestId);
            throw new Error('open workspace running focus request was not delivered in time');
        }
        return {
            protocolVersion: OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION,
            requestId: request.requestId,
            targetNavigationIdentity: request.targetNavigationIdentity,
            delivered: true,
        };
    }

    requestDelivery(): void {
        if (this.disposed) {
            return;
        }
        void this.scanAndDeliver().catch(error => this.dependencies.reportError(error));
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.dependencies.clearInterval(this.intervalHandle);
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
        const requests = await this.store.scan(this.dependencies.now());
        for (const request of requests) {
            if (this.disposed) {
                return;
            }
            let winner = false;
            try {
                winner = await this.dependencies
                    .isNavigationWinner(request.targetNavigationIdentity);
            } catch (error) {
                this.dependencies.reportError(error);
                continue;
            }
            if (!winner || !await this.store.claim(request.requestId)) {
                continue;
            }
            try {
                await this.dependencies.deliverRequest(request);
                await this.store.complete(request.requestId);
            } catch (error) {
                this.dependencies.reportError(error);
                await this.store.restore(request.requestId);
            }
        }
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new Error('open workspace running focus coordinator is disposed');
        }
    }
}
