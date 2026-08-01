'use strict';

import { validateNotifyConfig } from '../notify/types';
import type { NotifyConfig } from '../notify/types';

export const NOTIFY_SECRET_KEY_PREFIX = 'agentPivot.notify.sink.';

export interface NotifySettings {
    enabled: boolean;
    sinks: Array<Record<string, unknown>>;
    reasons: string[];
    minRunDurationMs: number;
    debounceMs: number;
    rateLimitPerMin: number;
    escalateAfterMs: number;
    projectPathMode: string;
    includeSessionLabel: boolean;
}

export function assembleNotifyConfig(
    settings: NotifySettings,
    secrets: Record<string, string>
): NotifyConfig {
    const sinks: Array<Record<string, unknown>> = [];
    for (const skeleton of settings.sinks || []) {
        const id = typeof skeleton.id === 'string' ? skeleton.id : '';
        const raw = id ? secrets[id] : undefined;
        if (!raw) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (_error) {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }
        sinks.push({ proxy: null, ...skeleton, ...(parsed as Record<string, unknown>) });
    }

    const candidate = {
        schemaVersion: 1,
        enabled: Boolean(settings.enabled),
        sinks,
        policy: {
            reasons: settings.reasons,
            minRunDurationMs: settings.minRunDurationMs,
            debounceMs: settings.debounceMs,
            rateLimitPerMin: settings.rateLimitPerMin,
            escalateAfterMs: settings.escalateAfterMs > 0 ? settings.escalateAfterMs : null,
        },
        redaction: {
            projectPathMode: settings.projectPathMode,
            includeSessionLabel: settings.includeSessionLabel,
        },
    };

    try {
        return validateNotifyConfig(candidate);
    } catch (_error) {
        return validateNotifyConfig({ ...candidate, sinks: [] });
    }
}
