'use strict';

import type { AgentPivotViewProviderOptions } from './viewProvider';
import { DashboardBootstrapResources } from './bootstrapResources';

export interface DashboardBootstrapControllerOptions {
    run: (
        generation: number,
        resources: DashboardBootstrapResources,
    ) => Promise<AgentPivotViewProviderOptions>;
    begin: (generation: number) => boolean;
    complete: (
        generation: number,
        options: AgentPivotViewProviderOptions,
    ) => boolean;
    fail: (generation: number) => boolean;
    transfer: (resources: DashboardBootstrapResources) => void;
    logDiagnostic: (event: Record<string, unknown>) => void;
    nowMs?: () => number;
}

type BootstrapState = 'idle' | 'booting' | 'ready' | 'failed' | 'disposed';

export class DashboardBootstrapController {
    private state: BootstrapState = 'idle';
    private generation = 0;
    private pendingResources?: DashboardBootstrapResources;

    constructor(
        private readonly options: DashboardBootstrapControllerOptions,
    ) {}

    start(): void {
        if (this.state !== 'idle') {
            return;
        }
        this.launch();
    }

    retry(): void {
        if (this.state !== 'failed') {
            return;
        }
        this.launch();
    }

    dispose(): void {
        if (this.state === 'disposed') {
            return;
        }

        this.state = 'disposed';
        this.generation++;
        const resources = this.pendingResources;
        this.pendingResources = undefined;
        this.disposeResources(resources);
    }

    private launch(): void {
        const generation = ++this.generation;
        this.state = 'booting';
        const resources = new DashboardBootstrapResources();
        this.pendingResources = resources;
        const startedAtMs = this.nowMs();
        if (!this.isCurrent(generation)) {
            return;
        }

        let began: boolean;
        try {
            began = this.options.begin(generation);
        } catch (_error) {
            this.handleFailure(generation, resources);
            return;
        }
        if (!this.isCurrent(generation)) {
            return;
        }
        if (!began) {
            this.handleFailure(generation, resources);
            return;
        }

        let running: Promise<AgentPivotViewProviderOptions>;
        try {
            running = this.options.run(generation, resources);
        } catch (_error) {
            this.handleFailure(generation, resources);
            return;
        }

        void Promise.resolve(running).then(
            options => {
                this.handleResult(generation, startedAtMs, resources, options);
            },
            _error => {
                this.handleFailure(generation, resources);
            },
        ).catch(_error => {
            this.handleFailure(generation, resources);
        });
    }

    private handleResult(
        generation: number,
        startedAtMs: number,
        resources: DashboardBootstrapResources,
        options: AgentPivotViewProviderOptions,
    ): void {
        if (!this.isCurrent(generation)) {
            this.disposeResources(resources);
            return;
        }

        let accepted: boolean;
        try {
            accepted = this.options.complete(generation, options);
        } catch (_error) {
            this.handleFailure(generation, resources);
            return;
        }

        if (!this.isCurrent(generation)) {
            if (this.pendingResources === resources) {
                this.pendingResources = undefined;
            }
            this.disposeResources(resources);
            return;
        }
        if (!accepted) {
            this.handleFailure(generation, resources);
            return;
        }

        this.state = 'ready';
        try {
            this.options.transfer(resources);
        } catch (_error) {
            if (this.isAdopted(generation)) {
                this.logFailure(generation);
            }
            return;
        }
        if (!this.isAdopted(generation)) {
            return;
        }
        if (this.pendingResources === resources) {
            this.pendingResources = undefined;
        }
        const finishedAtMs = this.nowMs();
        if (!this.isAdopted(generation)) {
            return;
        }
        this.logDiagnostic({
            event: 'agent-pivot-bootstrap-ready',
            generation,
            durationMs: Math.max(0, finishedAtMs - startedAtMs),
        });
    }

    private handleFailure(
        generation: number,
        resources?: DashboardBootstrapResources,
    ): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        if (this.pendingResources === resources) {
            this.pendingResources = undefined;
        }
        this.disposeResources(resources);
        this.state = 'failed';
        this.callFail(generation);
        this.logFailure(generation);
    }

    private isCurrent(generation: number): boolean {
        return this.state === 'booting' && this.generation === generation;
    }

    private isAdopted(generation: number): boolean {
        return this.state === 'ready' && this.generation === generation;
    }

    private callFail(generation: number): void {
        try {
            this.options.fail(generation);
        } catch (_error) {
            // Provider callbacks must not turn background bootstrap into rejection.
        }
    }

    private logFailure(generation: number): void {
        this.logDiagnostic({
            event: 'agent-pivot-bootstrap-failed',
            generation,
            category: 'dashboard-bootstrap',
        });
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        try {
            this.options.logDiagnostic(event);
        } catch (_error) {
            // Diagnostics must not affect bootstrap ownership or lifecycle.
        }
    }

    private disposeResources(resources?: DashboardBootstrapResources): void {
        if (!resources) {
            return;
        }
        try {
            resources.dispose();
        } catch (_error) {
            // Resource cleanup must not reject the background bootstrap promise.
        }
    }

    private nowMs(): number {
        try {
            const value = this.options.nowMs ? this.options.nowMs() : Date.now();
            return typeof value === 'number' && Number.isFinite(value) ? value : 0;
        } catch (_error) {
            return 0;
        }
    }
}
