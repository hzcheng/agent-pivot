'use strict';

import type { ManagedRevisionSlot } from '../../../src/projects/managedRemote/types';
import type { ManagedSshConsentCoordinator } from './managedSshConsentCoordinator';

export interface ManagedSshProjectionWorkerOptions {
    getCoordinator(): Promise<ManagedSshConsentCoordinator>;
    reportError(error: Error): void;
    finalize?(slot: ManagedRevisionSlot): Promise<void>;
    timeoutMs?: number;
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export class ManagedSshProjectionWorker {
    private latest?: ManagedRevisionSlot;
    private running?: Promise<void>;
    private readonly timeoutMs: number;

    constructor(private readonly options: ManagedSshProjectionWorkerOptions) {
        this.timeoutMs = options.timeoutMs === undefined ? 12_000 : options.timeoutMs;
    }

    schedule(slot: ManagedRevisionSlot): void {
        this.latest = slot;
        this.start();
    }

    async ensureReady(slot: ManagedRevisionSlot): Promise<void> {
        const coordinator = await this.options.getCoordinator();
        if (coordinator.isProjectionReady(slot)) {
            await this.options.finalize?.(slot);
            return;
        }
        this.schedule(slot);
        const running = this.running as Promise<void>;
        try {
            await this.withDeadline(running);
        } catch (error) {
            // Reconcile also audits the user's pre-existing SSH configuration.
            // A failed audit must not veto navigation when Remote - SSH can
            // already resolve the alias. run() has already reported the
            // failure, so swallow it here rather than reporting it twice.
            if (!this.isResolvable(coordinator, slot)) { throw error; }
            return;
        }
        if (!coordinator.isProjectionReady(slot)
            && !this.isResolvable(coordinator, slot)) {
            throw new Error('Managed SSH configuration is not ready. Try the action again.');
        }
    }

    private isResolvable(
        coordinator: ManagedSshConsentCoordinator,
        slot: ManagedRevisionSlot,
    ): boolean {
        return typeof coordinator.isProjectionResolvable === 'function'
            && coordinator.isProjectionResolvable(slot);
    }

    private start(): void {
        if (this.running) { return; }
        this.running = this.run().finally(() => {
            this.running = undefined;
            if (this.latest) { this.start(); }
        });
        void this.running.catch(() => undefined);
    }

    private async run(): Promise<void> {
        while (this.latest) {
            const slot = this.latest;
            this.latest = undefined;
            try {
                const coordinator = await this.options.getCoordinator();
                if (!coordinator.isProjectionReady(slot)) {
                    await coordinator.reconcile(slot);
                }
                await this.options.finalize?.(slot);
            } catch (error) {
                this.options.reportError(asError(error));
                if (!this.latest) { throw error; }
            }
        }
    }

    private withDeadline(operation: Promise<void>): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
                'Timed out preparing the local SSH configuration.',
            )), this.timeoutMs);
            operation.then(
                () => { clearTimeout(timer); resolve(); },
                error => { clearTimeout(timer); reject(error); },
            );
        });
    }
}
