'use strict';

import * as vscode from 'vscode';
import { URL } from 'url';
import { createHttpsTransport, resolveProxy, sendWithRetry } from '../notify/httpClient';
import { buildNotifyRequest } from '../notify/templates';
import type { NotifyConfig } from '../notify/types';
import { NOTIFY_SECRET_KEY_PREFIX } from './credentials';
import type { NotifyOutput } from './output';

const CHANNEL_FIELDS: Record<string, string[]> = {
    ntfy: ['topic', 'token'],
    telegram: ['botToken', 'chatId'],
    bark: ['serverUrl', 'deviceKey'],
    feishu: ['url'],
    wecom: ['url'],
    slack: ['url'],
    discord: ['url'],
    dingtalk: ['url', 'secret'],
    custom: ['url'],
};

export interface NotifyCommandDeps {
    output: NotifyOutput;
    getConfig: () => NotifyConfig;
    globalProxy: () => string;
}

export interface NotifySecretStorage {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    onDidChange?: (listener: (event: { key: string }) => unknown) => vscode.Disposable;
}

// SecretStorage landed in VS Code 1.53 while the extension still targets 1.51,
// so reach for it structurally and degrade gracefully on older hosts.
export function resolveNotifySecretStorage(
    context: vscode.ExtensionContext
): NotifySecretStorage | null {
    return (context as unknown as { secrets?: NotifySecretStorage }).secrets || null;
}

const NOTIFY_CONFIG_SECTION = 'agentPivot';

// 无密骨架由命令代写入设置:凭据进 SecretStorage、骨架进 settings.json,
// 用户全程不需要手编 JSON。已存在的同名骨架不被覆写(防误清用户调优)。
async function ensureSinkSkeleton(channel: string, id: string): Promise<boolean> {
    const configuration = vscode.workspace.getConfiguration(NOTIFY_CONFIG_SECTION);
    const sinks = configuration.get<Array<Record<string, unknown>>>('notify.sinks', []);
    const existing = (sinks || []).find(sink => sink && sink.id === id);
    if (existing) {
        if (existing.channel !== channel) {
            vscode.window.showWarningMessage(
                `Agent Pivot: sink "${id}" already uses channel "${existing.channel}" in settings. `
                + 'Pick a different id, or fix agentPivot.notify.sinks first.');
            return false;
        }
        return true;
    }
    if (channel === 'custom') {
        // method/headers/bodyTemplate 是自由 JSON,无法引导;只存凭据并指路。
        vscode.window.showInformationMessage(
            'Agent Pivot: the credential was stored. Custom sinks additionally need "method", '
            + '"headers" and "bodyTemplate" in agentPivot.notify.sinks — see README → Notifications.');
        return true;
    }
    const skeleton: Record<string, unknown> = { id, channel, proxy: null };
    if (channel === 'ntfy') {
        const baseUrl = await vscode.window.showInputBox({
            prompt: 'ntfy base URL (self-hosted instance, or the public one)',
            value: 'https://ntfy.sh',
            ignoreFocusOut: true,
        });
        if (baseUrl === undefined) {
            return false;
        }
        skeleton.baseUrl = baseUrl.trim() || 'https://ntfy.sh';
        skeleton.priority = 4;
    }
    await configuration.update(
        'notify.sinks', [...(sinks || []), skeleton], vscode.ConfigurationTarget.Global);
    return true;
}

async function promptForSinkSecret(
    context: vscode.ExtensionContext
): Promise<void> {
    const secretStorage = resolveNotifySecretStorage(context);
    if (!secretStorage) {
        vscode.window.showWarningMessage(
            'Agent Pivot: notification credentials require VS Code 1.53 or newer.');
        return;
    }
    const channel = await vscode.window.showQuickPick(Object.keys(CHANNEL_FIELDS), {
        placeHolder: 'Notification channel',
    });
    if (!channel) {
        return;
    }
    const idInput = await vscode.window.showInputBox({
        prompt: 'Sink id — a short name for this target, e.g. "phone"',
        ignoreFocusOut: true,
    });
    const id = (idInput || '').trim();
    if (!id) {
        return;
    }
    if (!await ensureSinkSkeleton(channel, id)) {
        return;
    }
    const secret: Record<string, string | null> = {};
    for (const field of CHANNEL_FIELDS[channel]) {
        // ntfy 公共实例免鉴权,token 是少数允许为空的字段;Esc 仍是放弃整个流程。
        const optional = channel === 'ntfy' && field === 'token';
        const value = await vscode.window.showInputBox({
            prompt: `${channel} · ${field}${optional ? ' (optional — press Enter to leave empty)' : ''}`,
            password: true,
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            vscode.window.showInformationMessage(
                `Agent Pivot: setup for sink "${id}" cancelled — no credential was stored.`);
            return;
        }
        secret[field] = value || null;
    }
    await secretStorage.store(`${NOTIFY_SECRET_KEY_PREFIX}${id}`, JSON.stringify(secret));
    const configuration = vscode.workspace.getConfiguration(NOTIFY_CONFIG_SECTION);
    if (!configuration.get<boolean>('notify.enabled', false)) {
        const enable = await vscode.window.showInformationMessage(
            `Agent Pivot: sink "${id}" is ready. Notifications are currently disabled — enable them now?`,
            'Enable notifications');
        if (enable === 'Enable notifications') {
            // 知情确认弹窗由 refreshNotifyConfig 在配置生效时接住,不重复询问。
            await configuration.update('notify.enabled', true, vscode.ConfigurationTarget.Global);
        }
        return;
    }
    vscode.window.showInformationMessage(
        `Agent Pivot: sink "${id}" is ready. Credentials live in SecretStorage, the rest in settings.`
    );
}

export function registerNotifyCommands(
    context: vscode.ExtensionContext,
    deps: NotifyCommandDeps
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('agentPivot.notify.setWebhook',
            () => promptForSinkSecret(context)),
        vscode.commands.registerCommand('agentPivot.notify.showOutput',
            () => deps.output.show()),
        vscode.commands.registerCommand('agentPivot.notify.sendTest', async () => {
            const config = deps.getConfig();
            if (!config.sinks.length) {
                vscode.window.showWarningMessage(
                    'Agent Pivot: no notification sink is configured with credentials.');
                deps.output.show();
                return;
            }
            const transport = createHttpsTransport();
            const now = Date.now();
            const payload = {
                eventId: `test:${now}`,
                correlationId: 'TESTID',
                providerId: 'claude',
                reason: 'input-required' as const,
                projectLabel: 'agent-pivot',
                sessionLabel: 'notification test',
                hostLabel: require('os').hostname(),
                runStartedAtMs: now - 900000,
                occurredAtMs: now,
            };
            deps.output.show();
            for (const sink of config.sinks) {
                const request = buildNotifyRequest(sink, payload, now);
                const proxy = resolveProxy(sink.proxy, deps.globalProxy(), process.env, request.url);
                try {
                    const result = await sendWithRetry(transport, request, proxy, ms =>
                        new Promise(resolve => setTimeout(resolve, ms)));
                    deps.output.log(
                        `test ${sink.id} (${sink.channel}) -> status=${result.statusCode} `
                        + `proxy=${proxy ? 'yes' : 'no'} ${result.durationMs}ms host=${new URL(request.url).host}`
                    );
                } catch (error) {
                    deps.output.log(
                        `test ${sink.id} (${sink.channel}) -> FAILED proxy=${proxy ? 'yes' : 'no'} `
                        + `${(error as Error).message}`
                    );
                }
            }
        }),
    ];
}
