'use strict';

export type NotifyChannel = 'ntfy' | 'telegram' | 'bark' | 'feishu'
    | 'dingtalk' | 'wecom' | 'slack' | 'discord' | 'custom';

export type NotifyReason = 'completed' | 'input-required' | 'failed';

export interface NotifySinkBase {
    id: string;
    channel: NotifyChannel;
    proxy: string | null;
}

export interface NtfySink extends NotifySinkBase {
    channel: 'ntfy';
    baseUrl: string;
    topic: string;
    token: string | null;
    priority: number;
}

export interface TelegramSink extends NotifySinkBase {
    channel: 'telegram';
    botToken: string;
    chatId: string;
}

export interface BarkSink extends NotifySinkBase {
    channel: 'bark';
    serverUrl: string;
    deviceKey: string;
}

export interface WebhookSink extends NotifySinkBase {
    channel: 'feishu' | 'wecom' | 'slack' | 'discord';
    url: string;
}

export interface DingtalkSink extends NotifySinkBase {
    channel: 'dingtalk';
    url: string;
    secret: string;
}

export interface CustomSink extends NotifySinkBase {
    channel: 'custom';
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyTemplate: string;
}

export type NotifySink = NtfySink | TelegramSink | BarkSink | WebhookSink
    | DingtalkSink | CustomSink;

export interface NotifyPolicy {
    reasons: NotifyReason[];
    minRunDurationMs: number;
    debounceMs: number;
    rateLimitPerMin: number;
    escalateAfterMs: number | null;
}

export interface NotifyRedaction {
    projectPathMode: 'basename' | 'full';
    includeSessionLabel: boolean;
}

export interface NotifyConfig {
    schemaVersion: 1;
    enabled: boolean;
    sinks: NotifySink[];
    policy: NotifyPolicy;
    redaction: NotifyRedaction;
}

export interface NotifyPayload {
    eventId: string;
    correlationId: string;
    providerId: string;
    reason: NotifyReason;
    projectLabel: string;
    sessionLabel: string;
    hostLabel: string;
    runStartedAtMs: number;
    occurredAtMs: number;
}

const MAX_STRING = 1024;
const REASONS: NotifyReason[] = ['completed', 'input-required', 'failed'];

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
    if (Object.keys(value).sort().join('\n') !== expected.slice().sort().join('\n')) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value || value.length > MAX_STRING) {
        throw new Error(`${label} must be a non-empty bounded string`);
    }
    return value;
}

function requireNullableString(value: unknown, label: string): string | null {
    return value === null ? null : requireString(value, label);
}

function requireNumber(value: unknown, label: string, min: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
        throw new Error(`${label} must be a finite number >= ${min}`);
    }
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean`);
    }
    return value;
}

export function validateSink(value: unknown): NotifySink {
    const sink = requireObject(value, 'notify sink');
    const id = requireString(sink.id, 'notify sink id');
    const proxy = requireNullableString(sink.proxy === undefined ? null : sink.proxy, 'notify sink proxy');
    switch (sink.channel) {
        case 'ntfy':
            exactKeys(sink, ['id', 'channel', 'proxy', 'baseUrl', 'topic', 'token', 'priority'], 'ntfy sink');
            return {
                id, channel: 'ntfy', proxy,
                baseUrl: requireString(sink.baseUrl, 'ntfy sink baseUrl'),
                topic: requireString(sink.topic, 'ntfy sink topic'),
                token: requireNullableString(sink.token, 'ntfy sink token'),
                priority: requireNumber(sink.priority, 'ntfy sink priority', 1),
            };
        case 'telegram':
            exactKeys(sink, ['id', 'channel', 'proxy', 'botToken', 'chatId'], 'telegram sink');
            return {
                id, channel: 'telegram', proxy,
                botToken: requireString(sink.botToken, 'telegram sink botToken'),
                chatId: requireString(sink.chatId, 'telegram sink chatId'),
            };
        case 'bark':
            exactKeys(sink, ['id', 'channel', 'proxy', 'serverUrl', 'deviceKey'], 'bark sink');
            return {
                id, channel: 'bark', proxy,
                serverUrl: requireString(sink.serverUrl, 'bark sink serverUrl'),
                deviceKey: requireString(sink.deviceKey, 'bark sink deviceKey'),
            };
        case 'feishu':
        case 'wecom':
        case 'slack':
        case 'discord':
            exactKeys(sink, ['id', 'channel', 'proxy', 'url'], `${sink.channel} sink`);
            return {
                id, channel: sink.channel, proxy,
                url: requireString(sink.url, `${sink.channel} sink url`),
            };
        case 'dingtalk':
            exactKeys(sink, ['id', 'channel', 'proxy', 'url', 'secret'], 'dingtalk sink');
            return {
                id, channel: 'dingtalk', proxy,
                url: requireString(sink.url, 'dingtalk sink url'),
                secret: requireString(sink.secret, 'dingtalk sink secret'),
            };
        case 'custom': {
            exactKeys(sink, ['id', 'channel', 'proxy', 'url', 'method', 'headers', 'bodyTemplate'], 'custom sink');
            const headers = requireObject(sink.headers, 'custom sink headers');
            for (const [key, headerValue] of Object.entries(headers)) {
                requireString(headerValue, `custom sink header ${key}`);
            }
            return {
                id, channel: 'custom', proxy,
                url: requireString(sink.url, 'custom sink url'),
                method: requireString(sink.method, 'custom sink method'),
                headers: headers as Record<string, string>,
                bodyTemplate: requireString(sink.bodyTemplate, 'custom sink bodyTemplate'),
            };
        }
        default:
            throw new Error('notify sink channel is unsupported');
    }
}

function validatePolicy(value: unknown): NotifyPolicy {
    const policy = requireObject(value, 'notify policy');
    exactKeys(policy, ['reasons', 'minRunDurationMs', 'debounceMs', 'rateLimitPerMin', 'escalateAfterMs'], 'notify policy');
    if (!Array.isArray(policy.reasons) || !policy.reasons.length
        || policy.reasons.some(reason => !REASONS.includes(reason as NotifyReason))) {
        throw new Error('notify policy reasons are invalid');
    }
    return {
        reasons: Array.from(new Set(policy.reasons as NotifyReason[])).sort(),
        minRunDurationMs: requireNumber(policy.minRunDurationMs, 'notify policy minRunDurationMs', 0),
        debounceMs: requireNumber(policy.debounceMs, 'notify policy debounceMs', 0),
        rateLimitPerMin: requireNumber(policy.rateLimitPerMin, 'notify policy rateLimitPerMin', 1),
        escalateAfterMs: policy.escalateAfterMs === null
            ? null
            : requireNumber(policy.escalateAfterMs, 'notify policy escalateAfterMs', 1),
    };
}

export function validateNotifyConfig(value: unknown): NotifyConfig {
    const record = requireObject(value, 'notify config');
    exactKeys(record, ['schemaVersion', 'enabled', 'sinks', 'policy', 'redaction'], 'notify config');
    if (record.schemaVersion !== 1) {
        throw new Error('notify config schemaVersion is incompatible');
    }
    if (!Array.isArray(record.sinks) || record.sinks.length > 32) {
        throw new Error('notify config sinks are invalid');
    }
    const redaction = requireObject(record.redaction, 'notify redaction');
    exactKeys(redaction, ['projectPathMode', 'includeSessionLabel'], 'notify redaction');
    if (redaction.projectPathMode !== 'basename' && redaction.projectPathMode !== 'full') {
        throw new Error('notify redaction projectPathMode is invalid');
    }
    return {
        schemaVersion: 1,
        enabled: requireBoolean(record.enabled, 'notify config enabled'),
        sinks: record.sinks.map(validateSink),
        policy: validatePolicy(record.policy),
        redaction: {
            projectPathMode: redaction.projectPathMode,
            includeSessionLabel: requireBoolean(redaction.includeSessionLabel, 'notify redaction includeSessionLabel'),
        },
    };
}
