'use strict';

import { validateNotifyConfig, validateSink } from '../notify/types';
import type { NotifyConfig, NotifySink } from '../notify/types';

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

// policy/redaction 级配置非法时的安全兜底:整体关闭,绝不让异常穿透到激活路径。
const FALLBACK_CONFIG: NotifyConfig = {
    schemaVersion: 1,
    enabled: false,
    sinks: [],
    policy: {
        reasons: ['completed', 'input-required', 'failed'],
        minRunDurationMs: 0,
        debounceMs: 0,
        rateLimitPerMin: 1,
        escalateAfterMs: null,
    },
    redaction: {
        projectPathMode: 'basename',
        includeSessionLabel: true,
    },
};

export function assembleNotifyConfig(
    settings: NotifySettings,
    secrets: Record<string, string>,
    onLog?: (line: string) => void
): NotifyConfig {
    const sinks: NotifySink[] = [];
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
            onLog?.(`notify: dropped sink "${id}" (secret is not valid JSON)`);
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            onLog?.(`notify: dropped sink "${id}" (secret must be a JSON object)`);
            continue;
        }
        // 单个 sink 非法只丢自己:不能让一个配错的 sink 团灭其余 sink。
        try {
            sinks.push(validateSink({ proxy: null, ...skeleton, ...(parsed as Record<string, unknown>) }));
        } catch (error) {
            onLog?.(`notify: dropped sink "${id || '?'}" (${(error as Error).message})`);
        }
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
    } catch (error) {
        onLog?.(`notify: invalid policy or redaction settings (${(error as Error).message}), notifications disabled`);
        return FALLBACK_CONFIG;
    }
}
