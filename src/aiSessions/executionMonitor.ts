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

interface Entry extends AiSessionExecutionSnapshot {
    lastSignalToken?: string;
    lastOccurredAtMs?: number;
}

export default class AiSessionExecutionMonitor {
    private readonly entries = new Map<string, Entry>();
    private readonly now: () => number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? (() => Date.now());
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
                entry = { state: 'stopped', stateChangedAt: this.now() };
                this.entries.set(input.key, entry);
            }

            const signal = input.signal;
            if (!acceptsLifecycleSignal(entry, signal)) {
                continue;
            }
            recordAcceptedLifecycleSignal(entry, signal);
            if (entry.state === signal.executionState) {
                continue;
            }
            entry.state = signal.executionState;
            entry.stateChangedAt = signal.occurredAtMs;
            changed.add(input.key);
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
