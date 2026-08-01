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
}

// SecretStorage landed in VS Code 1.53 while the extension still targets 1.51,
// so reach for it structurally and degrade gracefully on older hosts.
export function resolveNotifySecretStorage(
    context: vscode.ExtensionContext
): NotifySecretStorage | null {
    return (context as unknown as { secrets?: NotifySecretStorage }).secrets || null;
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
    const id = await vscode.window.showInputBox({
        prompt: 'Sink id — must match the id used in agentPivot.notify.sinks',
        ignoreFocusOut: true,
    });
    if (!id) {
        return;
    }
    const secret: Record<string, string | null> = {};
    for (const field of CHANNEL_FIELDS[channel]) {
        const value = await vscode.window.showInputBox({
            prompt: `${channel} · ${field}`,
            password: true,
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            return;
        }
        secret[field] = value || null;
    }
    await secretStorage.store(`${NOTIFY_SECRET_KEY_PREFIX}${id}`, JSON.stringify(secret));
    vscode.window.showInformationMessage(
        `Agent Pivot: credentials stored for sink "${id}". They are kept in VS Code SecretStorage, not in settings.json.`
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
