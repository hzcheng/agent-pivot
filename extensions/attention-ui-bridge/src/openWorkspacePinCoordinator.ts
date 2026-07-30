'use strict';

import * as fs from 'fs';

import {
    OpenWorkspacePinSetOutcome,
    OpenWorkspacePinSnapshot,
} from '../../../src/openWorkspaces/pinProtocol';
import { OpenWorkspacePinStore } from './openWorkspacePinStore';

const PIN_SCAN_INTERVAL_MS = 2_000;

interface OpenWorkspacePinWatcher {
    close(): void;
}

export interface OpenWorkspacePinCoordinatorDependencies {
    now(): number;
    deliverSnapshot(snapshot: OpenWorkspacePinSnapshot): PromiseLike<unknown> | unknown;
    reportError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    createWatcher(directoryPath: string, onDidChange: () => void): OpenWorkspacePinWatcher;
    createStore?(rootDirectory: string): OpenWorkspacePinStore;
}

export class OpenWorkspacePinCoordinator {
    private readonly store: OpenWorkspacePinStore;
    private readonly watcher: OpenWorkspacePinWatcher;
    private readonly intervalHandle: unknown;
    private lastDeliveredRevision = '';
    private scanFlight: Promise<OpenWorkspacePinSnapshot> | null = null;
    private scanRequested = false;
    private disposed = false;

    constructor(
        rootDirectory: string,
        private readonly dependencies: OpenWorkspacePinCoordinatorDependencies,
    ) {
        this.store = dependencies.createStore
            ? dependencies.createStore(rootDirectory)
            : new OpenWorkspacePinStore(rootDirectory);
        fs.mkdirSync(this.store.directoryPath, { recursive: true, mode: 0o700 });
        this.watcher = dependencies.createWatcher(
            this.store.directoryPath,
            () => this.requestDelivery(),
        );
        this.intervalHandle = dependencies.setInterval(
            () => this.requestDelivery(),
            PIN_SCAN_INTERVAL_MS,
        );
    }

    async getSnapshot(): Promise<OpenWorkspacePinSnapshot> {
        return this.store.scan();
    }

    async setPinned(raw: unknown): Promise<OpenWorkspacePinSetOutcome> {
        this.ensureActive();
        const outcome = await this.store.setPinned(raw, this.dependencies.now());
        try {
            await this.deliver(outcome.snapshot, true);
        } catch (error) {
            // The mutation is already durable and the command response carries the
            // authoritative snapshot. Periodic delivery will retry other windows.
            this.dependencies.reportError(error);
        }
        return outcome;
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

    private scanAndDeliver(): Promise<OpenWorkspacePinSnapshot> {
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

    private async runQueuedScans(): Promise<OpenWorkspacePinSnapshot> {
        let snapshot = await this.store.scan();
        do {
            this.scanRequested = false;
            await this.deliver(snapshot, false);
            if (this.scanRequested && !this.disposed) {
                snapshot = await this.store.scan();
            }
        } while (this.scanRequested && !this.disposed);
        return snapshot;
    }

    private async deliver(
        snapshot: OpenWorkspacePinSnapshot,
        force: boolean,
    ): Promise<void> {
        if (this.disposed
            || (!force && snapshot.revision === this.lastDeliveredRevision)) {
            return;
        }
        await this.dependencies.deliverSnapshot(snapshot);
        if (!this.disposed) {
            this.lastDeliveredRevision = snapshot.revision;
        }
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new Error('open workspace pin coordinator is disposed');
        }
    }
}
