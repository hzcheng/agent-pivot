'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionLifecycleRequest } from './lifecycle';
import AiSessionExecutionMonitor from './executionMonitor';
import type { AiSessionExecutionSnapshot } from './executionMonitor';
import type {
    AiSessionLifecycleRequestsByProvider,
    AiSessionLifecycleSignals,
} from './lifecycleSignalReader';
import { getAiSessionKey } from './sessionHelpers';
import type { AiSessionActiveTerminalRuntime } from './types';

export interface AiSessionExecutionControllerOptions {
    getActiveSessions: () => AiSessionActiveTerminalRuntime[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    scheduleRefresh: (reason: string) => void;
    nowMs: () => number;
}

export class AiSessionExecutionController {
    private readonly monitor: AiSessionExecutionMonitor;

    constructor(private readonly options: AiSessionExecutionControllerOptions) {
        this.monitor = new AiSessionExecutionMonitor({ now: options.nowMs });
    }

    /** The sessions this controller needs signals for, for the shared reader to merge. */
    getLifecycleRequests(): AiSessionLifecycleRequestsByProvider {
        const requests: Partial<Record<AiSessionProviderId, AiSessionLifecycleRequest[]>> = {};
        for (const session of this.options.getActiveSessions()) {
            const owned = requests[session.provider] || [];
            owned.push({ sessionId: session.sessionId, runStartedAtMs: session.runStartedAtMs });
            requests[session.provider] = owned;
        }
        return requests;
    }

    evaluate(signals: AiSessionLifecycleSignals): void {
        const changedKeys = this.monitor.evaluate(this.options.getActiveSessions().map(session => ({
            key: this.getSessionKey(session.provider, session.sessionId),
            signal: signals?.[session.provider]?.[session.sessionId],
        })));
        if (changedKeys.length) {
            this.options.scheduleRefresh('execution');
        }
    }

    getSnapshot(): Record<string, AiSessionExecutionSnapshot> {
        return this.monitor.getSnapshot();
    }

    private getSessionKey(providerId: AiSessionProviderId, sessionId: string): string {
        return this.options.getSessionKey
            ? this.options.getSessionKey(providerId, sessionId)
            : getAiSessionKey(providerId, sessionId);
    }
}
