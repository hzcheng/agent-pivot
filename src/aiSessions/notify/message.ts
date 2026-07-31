'use strict';

import type { NotifyPayload, NotifyReason } from './types';

const PROVIDER_LABELS: Record<string, string> = {
    claude: 'Claude',
    codex: 'Codex',
    kimi: 'Kimi',
};

const REASON_TITLES: Record<NotifyReason, string> = {
    'input-required': '⏸ {provider} 在等你输入',
    completed: '✅ {provider} 已完成',
    failed: '⚠️ {provider} 执行失败',
};

const REASON_TEXT: Record<NotifyReason, string> = {
    'input-required': '需要输入',
    completed: '已完成',
    failed: '执行失败',
};

function providerLabel(providerId: string): string {
    return PROVIDER_LABELS[providerId] || providerId;
}

function durationText(payload: NotifyPayload): string {
    const minutes = Math.floor((payload.occurredAtMs - payload.runStartedAtMs) / 60000);
    return minutes >= 1 ? `已运行 ${minutes} 分钟` : '运行不足 1 分钟';
}

export function renderNotifyTitle(payload: NotifyPayload): string {
    return REASON_TITLES[payload.reason].replace('{provider}', providerLabel(payload.providerId));
}

export function renderNotifyBody(payload: NotifyPayload): string {
    const lines = [
        `项目  ${payload.projectLabel}`,
        `会话  ${payload.sessionLabel}`,
        `原因  ${REASON_TEXT[payload.reason]} · ${durationText(payload)}`,
        `主机  ${payload.hostLabel}`,
        `ID    #${payload.correlationId}`,
    ];
    return lines.join('\n');
}

export function renderMergedTitle(count: number): string {
    return `⏸ ${count} 个 AI 会话在等你`;
}

export function renderMergedBody(payloads: NotifyPayload[]): string {
    return payloads
        .map(payload => `· ${providerLabel(payload.providerId)} / ${payload.projectLabel} —— ${REASON_TEXT[payload.reason]}`)
        .join('\n');
}

export function notifyPriority(reason: NotifyReason): number {
    return reason === 'completed' ? 3 : 4;
}
