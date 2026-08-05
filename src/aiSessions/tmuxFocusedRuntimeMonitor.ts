'use strict';

import type { TmuxFocusedRuntimeSyncResult } from './tmuxRuntimeBackend';

export const TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS = 1000;
const MAX_FOCUSED_RUNTIME_CHECK_DELAY_MS = 4000;

export interface TmuxFocusedRuntimeMonitorOptions<TTerminal> {
    isVisible(): boolean;
    getActiveTerminal(): TTerminal | null;
    syncFocusedRuntime(terminal: TTerminal): Promise<TmuxFocusedRuntimeSyncResult>;
    refresh(): void;
    onError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
    /** Test hook for the backoff cadence; defaults to Date.now. */
    nowMs?(): number;
}

export class TmuxFocusedRuntimeMonitor<TTerminal> {
    private interval: unknown = null;
    private inFlight: Promise<void> | null = null;
    private currentDelayMs = TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS;
    private nextTimerSyncAtMs = 0;
    private disposed = false;

    constructor(private readonly options: TmuxFocusedRuntimeMonitorOptions<TTerminal>) { }

    start(): void {
        if (this.disposed || this.interval !== null) {
            return;
        }
        this.interval = this.options.setInterval(
            () => this.requestFromTimer(),
            TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS
        );
    }

    // The timer keeps its 1s beat (and its pinned contract), but quiet periods
    // skip beats: unchanged results double the gap up to 4s, any change snaps
    // back to 1s. Each timer-driven sync still spawns a private tmux query, so
    // this is where the steady-state subprocess churn is saved.
    private requestFromTimer(): void {
        if (this.disposed) {
            return;
        }
        if (this.now() < this.nextTimerSyncAtMs) {
            return;
        }
        void this.runRequest(true);
    }

    private now(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    /** Explicit requests (focus/visibility events) run immediately at the fast cadence. */
    request(): Promise<void> {
        this.currentDelayMs = TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS;
        this.nextTimerSyncAtMs = 0;
        return this.runRequest(false);
    }

    private runRequest(fromTimer: boolean): Promise<void> {
        if (this.disposed || !this.options.isVisible()) {
            return Promise.resolve();
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            return Promise.resolve();
        }
        let tracked: Promise<void>;
        const clear = () => {
            if (this.inFlight === tracked) {
                this.inFlight = null;
            }
        };
        tracked = this.options.syncFocusedRuntime(terminal).then(result => {
            if (!this.disposed && result.changed && this.options.isVisible()
                && this.options.getActiveTerminal() === terminal) {
                this.options.refresh();
            }
            if (fromTimer && !this.disposed) {
                this.currentDelayMs = result.changed
                    ? TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS
                    : Math.min(this.currentDelayMs * 2, MAX_FOCUSED_RUNTIME_CHECK_DELAY_MS);
                this.nextTimerSyncAtMs = this.now() + this.currentDelayMs;
            }
        }, error => {
            try {
                this.options.onError(error);
            } catch (_reportError) {
                // Monitoring failures and diagnostic failures remain non-fatal.
            }
        }).then(clear, clear);
        this.inFlight = tracked;
        return tracked;
    }

    dispose(): void {
        this.disposed = true;
        if (this.interval !== null) {
            this.options.clearInterval(this.interval);
            this.interval = null;
        }
    }
}
