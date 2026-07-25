'use strict';

import type { AiSessionProviderId } from '../models';

export interface AiSessionProviderSelection {
    primaryProvider: AiSessionProviderId;
    selectedProviders: AiSessionProviderId[];
}

export interface NormalizeAiSessionProviderSelectionInput {
    registeredProviders: readonly AiSessionProviderId[];
    primaryProvider?: unknown;
    selectedProviders?: unknown;
    sessionCounts?: Partial<Record<AiSessionProviderId, number>>;
}

export function normalizeAiSessionProviderSelection(
    input: NormalizeAiSessionProviderSelectionInput
): AiSessionProviderSelection {
    const registered = Array.from(new Set(input.registeredProviders));
    const registeredSet = new Set(registered);
    const requested = Array.isArray(input.selectedProviders)
        ? Array.from(new Set(input.selectedProviders.filter(
            (value): value is AiSessionProviderId =>
                typeof value === 'string' && registeredSet.has(value as AiSessionProviderId)
        )))
        : [];
    let primary = typeof input.primaryProvider === 'string'
        && registeredSet.has(input.primaryProvider as AiSessionProviderId)
        ? input.primaryProvider as AiSessionProviderId
        : undefined;

    if (!primary) {
        primary = requested[0]
            || registered.find(provider => Number(input.sessionCounts?.[provider] || 0) > 0)
            || registered[0]
            || 'codex';
    }
    const selected = requested.length ? requested : [primary];
    if (!selected.includes(primary)) {
        primary = selected[0];
    }

    return {
        primaryProvider: primary,
        selectedProviders: [
            primary,
            ...registered.filter(provider => provider !== primary && selected.includes(provider)),
        ],
    };
}
