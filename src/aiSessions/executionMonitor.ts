'use strict';

import type { AiSessionExecutionState, AiSessionLifecycleSignal } from './lifecycle';
import {
    acceptsLifecycleSignal,
    recordAcceptedLifecycleSignal,
} from './lifecycleSignalAcceptance';

export interface AiSessionExecutionInput {
    key: string;
    signal?: AiSessionLifecycleSignal;
}

export interface AiSessionExecutionSnapshot {
    state: AiSessionExecutionState;
    stateChangedAt: number;
}

const DEFAULT_STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

interface Entry extends AiSessionExecutionSnapshot {
    lastSignalToken?: string;
    lastOccurredAtMs?: number;
    lastSignalAtMs: number;
}

export default class AiSessionExecutionMonitor {
    private readonly entries = new Map<string, Entry>();
    private readonly now: () => number;
    private readonly staleRunningTimeoutMs: number;

    constructor(options: { now?: () => number; staleRunningTimeoutMs?: number } = {}) {
        this.now = options.now ?? (() => Date.now());
        this.staleRunningTimeoutMs = options.staleRunningTimeoutMs ?? DEFAULT_STALE_RUNNING_TIMEOUT_MS;
    }

    evaluate(inputs: AiSessionExecutionInput[]): string[] {
        const seen = new Set<string>();
        const changed = new Set<string>();
        for (const input of inputs || []) {
            if (!input?.key) {
                continue;
            }
            seen.add(input.key);
            let entry = this.entries.get(input.key);
            if (!entry) {
                entry = { state: 'stopped', stateChangedAt: this.now(), lastSignalAtMs: this.now() };
                this.entries.set(input.key, entry);
            }

            const signal = input.signal;
            if (acceptsLifecycleSignal(entry, signal)) {
                recordAcceptedLifecycleSignal(entry, signal);
                entry.lastSignalAtMs = this.now();
                if (entry.state !== signal.executionState) {
                    entry.state = signal.executionState;
                    entry.stateChangedAt = signal.occurredAtMs;
                    changed.add(input.key);
                }
            }

            // Backstop: without a fresh transcript signal for the whole stale
            // window there is no evidence the session is still running. A
            // missed terminal event (for example an unrecognised interrupt
            // marker) would otherwise wedge the running state forever.
            if (entry.state === 'running'
                && this.now() - entry.lastSignalAtMs >= this.staleRunningTimeoutMs) {
                entry.state = 'stopped';
                entry.stateChangedAt = this.now();
                changed.add(input.key);
            }
        }

        for (const key of this.entries.keys()) {
            if (!seen.has(key)) {
                this.entries.delete(key);
                changed.add(key);
            }
        }
        return Array.from(changed);
    }

    getSnapshot(): Record<string, AiSessionExecutionSnapshot> {
        const snapshot: Record<string, AiSessionExecutionSnapshot> = {};
        for (const [key, entry] of this.entries) {
            snapshot[key] = { state: entry.state, stateChangedAt: entry.stateChangedAt };
        }
        return snapshot;
    }
}
