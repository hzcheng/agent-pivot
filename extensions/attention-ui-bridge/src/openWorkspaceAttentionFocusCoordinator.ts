'use strict';

import * as fs from 'fs';

import {
    OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
    OpenWorkspaceAttentionFocusOutcome,
    OpenWorkspaceAttentionFocusRequest,
    validateOpenWorkspaceAttentionFocusRequest,
} from '../../../src/openWorkspaces/attentionFocusProtocol';
import { OpenWorkspaceAttentionFocusStore } from './openWorkspaceAttentionFocusStore';

const SCAN_INTERVAL_MS = 2_000;
const DELIVERY_WAIT_MS = 5_000;

interface WatcherLike {
    close(): void;
}

export interface OpenWorkspaceAttentionFocusCoordinatorDependencies {
    now(): number;
    deliverRequest(request: OpenWorkspaceAttentionFocusRequest): PromiseLike<unknown> | unknown;
    isNavigationWinner(navigationIdentity: string): Promise<boolean>;
    reportError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    createWatcher(directoryPath: string, onDidChange: () => void): WatcherLike;
    createStore?(rootDirectory: string): OpenWorkspaceAttentionFocusStore;
    deliveryWaitMs?: number;
}

export class OpenWorkspaceAttentionFocusCoordinator {
    private readonly store: OpenWorkspaceAttentionFocusStore;
    private readonly watcher: WatcherLike;
    private readonly intervalHandle: unknown;
    private scanFlight: Promise<void> | null = null;
    private scanRequested = false;
    private disposed = false;

    constructor(
        rootDirectory: string,
        private readonly dependencies: OpenWorkspaceAttentionFocusCoordinatorDependencies,
    ) {
        this.store = dependencies.createStore
            ? dependencies.createStore(rootDirectory)
            : new OpenWorkspaceAttentionFocusStore(rootDirectory);
        fs.mkdirSync(this.store.directoryPath, { recursive: true, mode: 0o700 });
        this.watcher = dependencies.createWatcher(
            this.store.directoryPath,
            () => this.requestDelivery(),
        );
        this.intervalHandle = dependencies.setInterval(
            () => this.requestDelivery(),
            SCAN_INTERVAL_MS,
        );
    }

    async submit(raw: unknown): Promise<OpenWorkspaceAttentionFocusOutcome> {
        this.ensureActive();
        const request = await this.store.submit(
            validateOpenWorkspaceAttentionFocusRequest(raw),
        );
        this.requestDelivery();
        const delivered = await this.store.waitForDelivery(
            request.requestId,
            this.dependencies.deliveryWaitMs ?? DELIVERY_WAIT_MS,
        );
        if (!delivered) {
            await this.store.cancel(request.requestId);
            throw new Error('open workspace attention focus request was not delivered in time');
        }
        return {
            protocolVersion: OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
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
            throw new Error('open workspace attention focus coordinator is disposed');
        }
    }
}
