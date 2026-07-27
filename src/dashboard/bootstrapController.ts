'use strict';

import type { AgentPivotViewProviderOptions } from './viewProvider';
import { DashboardBootstrapResources } from './bootstrapResources';

export interface DashboardBootstrapResult {
    readonly options: AgentPivotViewProviderOptions;
    readonly resources: DashboardBootstrapResources;
}

export interface DashboardBootstrapControllerOptions {
    run: (generation: number) => Promise<DashboardBootstrapResult>;
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
        const startedAtMs = this.nowMs();
        this.state = 'booting';

        let began: boolean;
        try {
            began = this.options.begin(generation);
        } catch (_error) {
            this.handleFailure(generation);
            return;
        }
        if (!began) {
            this.state = 'failed';
            return;
        }

        let running: Promise<DashboardBootstrapResult>;
        try {
            running = this.options.run(generation);
        } catch (_error) {
            this.handleFailure(generation);
            return;
        }

        void Promise.resolve(running).then(
            result => {
                this.handleResult(generation, startedAtMs, result);
            },
            _error => {
                this.handleFailure(generation);
            },
        );
    }

    private handleResult(
        generation: number,
        startedAtMs: number,
        result: DashboardBootstrapResult,
    ): void {
        if (!this.isCurrent(generation)) {
            this.disposeResources(result.resources);
            return;
        }

        this.pendingResources = result.resources;
        let accepted: boolean;
        try {
            accepted = this.options.complete(generation, result.options);
        } catch (_error) {
            this.pendingResources = undefined;
            this.disposeResources(result.resources);
            this.handleFailure(generation);
            return;
        }

        if (!accepted || !this.isCurrent(generation)) {
            this.pendingResources = undefined;
            this.disposeResources(result.resources);
            if (this.state !== 'disposed') {
                this.state = 'failed';
            }
            return;
        }

        this.state = 'ready';
        try {
            this.options.transfer(result.resources);
        } catch (_error) {
            this.pendingResources = undefined;
            this.disposeResources(result.resources);
            this.state = 'failed';
            this.callFail(generation);
            this.logFailure(generation);
            return;
        }
        this.pendingResources = undefined;
        this.logDiagnostic({
            event: 'agent-pivot-bootstrap-ready',
            generation,
            durationMs: Math.max(0, this.nowMs() - startedAtMs),
        });
    }

    private handleFailure(generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        this.state = 'failed';
        this.callFail(generation);
        this.logFailure(generation);
    }

    private isCurrent(generation: number): boolean {
        return this.state === 'booting' && this.generation === generation;
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
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
