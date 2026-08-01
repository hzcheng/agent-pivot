'use strict';

import type { AiSessionAttentionReason, AiSessionLifecycleSignal } from './lifecycle';
import {
    acceptsLifecycleSignal,
    recordAcceptedLifecycleSignal,
} from './lifecycleSignalAcceptance';
import { createAttentionEventId } from './notify/eventIdentity';

export { AiSessionAttentionReason } from './lifecycle';
export type AiSessionAttentionState = 'pending' | 'running' | 'idle' | 'needsAttention' | 'acknowledged';

export interface AiSessionAttentionInput {
    key: string;
    eventKey?: string;
    signal?: AiSessionLifecycleSignal;
    observedAt?: number;
}

export interface AiSessionAttentionEvent {
    eventId: string;
    key: string;
    reason: AiSessionAttentionReason;
    generation: number;
    detectedAt: number;
}

export interface AiSessionAttentionSnapshot {
    state: AiSessionAttentionState;
    stateChangedAt: number;
    event?: AiSessionAttentionEvent;
}

interface Entry extends AiSessionAttentionSnapshot {
    lastSignalToken?: string;
    lastOccurredAtMs?: number;
    generation: number;
}

export interface AiSessionAttentionMonitorOptions {
    now?: () => number;
}

export default class AiSessionAttentionMonitor {
    private readonly entries = new Map<string, Entry>();
    private readonly now: () => number;
    private cancelledEventIds: string[] = [];

    constructor(options: AiSessionAttentionMonitorOptions = {}) {
        this.now = options.now ?? (() => Date.now());
    }

    evaluate(inputs: AiSessionAttentionInput[]): AiSessionAttentionEvent[] {
        const now = this.now();
        const seen = new Set<string>();
        const events: AiSessionAttentionEvent[] = [];
        for (const input of inputs || []) {
            if (!input?.key) {
                continue;
            }
            seen.add(input.key);
            let observedAt = input.observedAt ?? now;
            let entry = this.entries.get(input.key);
            if (!entry) {
                entry = { state: 'pending', stateChangedAt: observedAt, generation: 0 };
                this.entries.set(input.key, entry);
            }

            let signal = input.signal;
            if (!acceptsLifecycleSignal(entry, signal)) {
                continue;
            }
            recordAcceptedLifecycleSignal(entry, signal);
            entry.stateChangedAt = observedAt;

            if (signal.phase === 'running' || signal.phase === 'idle') {
                entry.state = signal.phase;
                if (entry.event) {
                    this.cancelledEventIds.push(entry.event.eventId);
                    entry.event = undefined;
                }
                continue;
            }
            if (signal.phase !== 'needsAttention' || !signal.reason) {
                continue;
            }

            entry.generation += 1;
            entry.state = 'needsAttention';
            const event: AiSessionAttentionEvent = {
                eventId: createAttentionEventId(input.eventKey || input.key, signal.reason, signal.token),
                key: input.key,
                reason: signal.reason,
                generation: entry.generation,
                detectedAt: now,
            };
            entry.event = event;
            events.push(event);
        }

        for (const [key, entry] of this.entries) {
            if (!seen.has(key) && entry.state !== 'needsAttention') {
                this.entries.delete(key);
            }
        }
        return events;
    }

    acknowledge(eventIds: string[]): void {
        const ids = new Set(eventIds || []);
        for (const entry of this.entries.values()) {
            if (entry.event && ids.has(entry.event.eventId) && entry.state === 'needsAttention') {
                entry.state = 'acknowledged';
                entry.stateChangedAt = this.now();
            }
        }
    }

    discard(keys: string[]): void {
        for (const key of new Set(keys || [])) {
            const entry = this.entries.get(key);
            if (entry?.event) {
                this.cancelledEventIds.push(entry.event.eventId);
            }
            this.entries.delete(key);
        }
    }

    consumeCancelledEventIds(): string[] {
        const cancelled = this.cancelledEventIds;
        this.cancelledEventIds = [];
        return cancelled;
    }

    clear(): void {
        this.entries.clear();
    }

    getSnapshot(): Record<string, AiSessionAttentionSnapshot> {
        const result: Record<string, AiSessionAttentionSnapshot> = {};
        for (const [key, entry] of this.entries) {
            result[key] = { state: entry.state, stateChangedAt: entry.stateChangedAt, event: entry.event };
        }
        return result;
    }
}
