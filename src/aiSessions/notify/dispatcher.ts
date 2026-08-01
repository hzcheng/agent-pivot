'use strict';

import { sendWithRetry } from './httpClient';
import type { HttpTransport } from './httpClient';
import { renderMergedBody, renderMergedTitle } from './message';
import { evaluateNotifyPolicy } from './policy';
import type { NotifiedEventStore } from './store';
import { buildNotifyRequest, buildNotifyRequestFromText } from './templates';
import type { NotifyRequest } from './templates';
import { resolveProxy } from './httpClient';
import type { NotifyConfig, NotifyPayload, NotifySink } from './types';

const MAX_QUEUE = 100;

export interface DispatcherDeps {
    transport: HttpTransport;
    store: NotifiedEventStore;
    nowMs: () => number;
    setTimeout: (handler: () => void | Promise<void>, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    sleep: (ms: number) => Promise<void>;
    globalProxy: () => string;
    env: Record<string, string | undefined>;
    onLog: (line: string) => void;
}

interface PendingEntry {
    payload: NotifyPayload;
    timer: unknown;
}

export class NotifyDispatcher {
    private config: NotifyConfig | null = null;
    private readonly pending = new Map<string, PendingEntry>();
    private readonly acknowledged = new Set<string>();
    private sendTimestamps: number[] = [];
    private inFlight: Promise<void> = Promise.resolve();

    constructor(private readonly deps: DispatcherDeps) {}

    setConfig(config: NotifyConfig): void {
        this.config = config;
    }

    enqueue(payload: NotifyPayload): void {
        if (!this.config?.enabled || !this.config.sinks.length) {
            return;
        }
        if (this.pending.has(payload.eventId) || this.deps.store.has(payload.eventId)) {
            return;
        }
        if (this.pending.size >= MAX_QUEUE) {
            const oldest = this.pending.keys().next().value;
            if (oldest !== undefined) {
                this.deps.clearTimeout(this.pending.get(oldest)?.timer);
                this.pending.delete(oldest);
                this.deps.onLog(`notify: queue overflow, dropped ${oldest}`);
            }
        }
        const timer = this.deps.setTimeout(
            () => this.release(payload.eventId),
            this.config.policy.debounceMs
        );
        this.pending.set(payload.eventId, { payload, timer });
    }

    cancel(eventIds: string[]): void {
        for (const eventId of eventIds) {
            this.acknowledged.add(eventId);
            const entry = this.pending.get(eventId);
            if (entry) {
                this.deps.clearTimeout(entry.timer);
                this.pending.delete(eventId);
            }
        }
    }

    flushForTest(): Promise<void> {
        return this.inFlight;
    }

    private release(eventId: string): Promise<void> {
        const entry = this.pending.get(eventId);
        this.pending.delete(eventId);
        if (!entry || !this.config) {
            return Promise.resolve();
        }
        this.inFlight = this.inFlight.then(() => this.deliver(entry.payload)).catch(() => undefined);
        return this.inFlight;
    }

    private recentSendCount(now: number): number {
        this.sendTimestamps = this.sendTimestamps.filter(timestamp => now - timestamp < 60000);
        return this.sendTimestamps.length;
    }

    private async deliver(payload: NotifyPayload): Promise<void> {
        const config = this.config;
        if (!config?.enabled) {
            return;
        }
        const now = this.deps.nowMs();
        const decision = evaluateNotifyPolicy(payload, config.policy, {
            alreadyNotified: this.deps.store.has(payload.eventId),
            acknowledged: this.acknowledged.has(payload.eventId),
            sentWithinLastMinute: this.recentSendCount(now),
        });
        if (decision.action === 'skip') {
            this.deps.onLog(`notify: skipped ${payload.correlationId} (${decision.reason})`);
            return;
        }
        const mergedPayloads = decision.action === 'merge' ? this.absorbPending(payload, now) : [];
        const requests = decision.action === 'merge'
            ? config.sinks.map(sink => this.buildMergedRequest(sink, payload, mergedPayloads, now))
            : config.sinks.map(sink => buildNotifyRequest(sink, payload, now));
        this.sendTimestamps.push(now);
        try {
            this.deps.store.record(payload.eventId, now);
            this.deps.store.save();
        } catch (error) {
            // 记不上账也比不发强:HOME 只读/磁盘满时照常投递,但必须留痕。
            this.deps.onLog(`notify: failed to persist notified store: ${(error as Error).message}`);
        }
        for (let index = 0; index < requests.length; index += 1) {
            await this.send(config.sinks[index], requests[index], payload.correlationId);
        }
    }

    private absorbPending(payload: NotifyPayload, now: number): NotifyPayload[] {
        const queued = Array.from(this.pending.values(), entry => entry.payload);
        for (const entry of this.pending.values()) {
            this.deps.clearTimeout(entry.timer);
            this.deps.store.record(entry.payload.eventId, now);
        }
        this.pending.clear();
        return [payload, ...queued];
    }

    private buildMergedRequest(
        sink: NotifySink,
        payload: NotifyPayload,
        all: NotifyPayload[],
        now: number
    ): NotifyRequest {
        return buildNotifyRequestFromText(
            sink,
            payload,
            renderMergedTitle(all),
            renderMergedBody(all),
            4,
            now
        );
    }

    private async send(sink: NotifySink, request: NotifyRequest, correlationId: string): Promise<void> {
        const proxy = resolveProxy(sink.proxy, this.deps.globalProxy(), this.deps.env, request.url);
        try {
            const result = await sendWithRetry(this.deps.transport, request, proxy, this.deps.sleep);
            this.deps.onLog(
                `notify: ${correlationId} -> ${sink.channel} status=${result.statusCode} `
                + `proxy=${result.viaProxy} ${result.durationMs}ms`
            );
        } catch (error) {
            this.deps.onLog(`notify: ${correlationId} -> ${sink.channel} failed: ${(error as Error).message}`);
        }
    }
}
