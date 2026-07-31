'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';

export interface AiSessionLifecycleSignalProvider {
    id: AiSessionProviderId;
    service: {
        getLifecycleSignals(
            requests: readonly AiSessionLifecycleRequest[]
        ): Record<string, AiSessionLifecycleSignal>;
    };
}

export type AiSessionLifecycleRequestsByProvider =
    Readonly<Partial<Record<AiSessionProviderId, readonly AiSessionLifecycleRequest[]>>>;

export type AiSessionLifecycleSignals =
    Readonly<Record<AiSessionProviderId, Readonly<Record<string, AiSessionLifecycleSignal>>>>;

export interface AiSessionLifecycleSignalReaderOptions {
    getProviders: () => readonly AiSessionLifecycleSignalProvider[];
    /**
     * Every consumer's requests, already attributed to the owning provider. The
     * reader merges them per provider, keeping the first run start seen for a
     * session so a stale duplicate cannot re-seek a cursor.
     */
    getRequests: () => readonly AiSessionLifecycleRequestsByProvider[];
}

/**
 * Reads provider lifecycle signals once for the union of every consumer.
 *
 * Provider services keep an incremental JSONL cursor per session and end
 * getLifecycleSignals by retaining only the sessions named in that call. When
 * the execution and attention passes each read on their own, whichever ran last
 * evicted the other's cursors and forced a full re-read of the session
 * transcript on the next pass. Merging the request sets keeps every cursor
 * alive, and handing one result to both passes means the running animation and
 * the attention dot are derived from the same observation rather than from two
 * reads taken moments apart.
 */
export class AiSessionLifecycleSignalReader {
    constructor(private readonly options: AiSessionLifecycleSignalReaderOptions) {
    }

    read(): AiSessionLifecycleSignals {
        const merged = new Map<AiSessionProviderId, Map<string, AiSessionLifecycleRequest>>();
        for (const byProvider of this.options.getRequests()) {
            for (const [providerId, requests] of Object.entries(byProvider || {})) {
                const owned = merged.get(providerId as AiSessionProviderId)
                    || new Map<string, AiSessionLifecycleRequest>();
                for (const request of requests || []) {
                    if (request?.sessionId && !owned.has(request.sessionId)) {
                        owned.set(request.sessionId, request);
                    }
                }
                merged.set(providerId as AiSessionProviderId, owned);
            }
        }

        const signals: Partial<Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>>> = {};
        for (const provider of this.options.getProviders()) {
            const requests = [...(merged.get(provider.id)?.values() || [])];
            signals[provider.id] = requests.length
                ? provider.service.getLifecycleSignals(requests)
                : {};
        }
        return signals as AiSessionLifecycleSignals;
    }
}
