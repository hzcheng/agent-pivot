'use strict';

import * as path from 'path';
import type * as vscode from 'vscode';
import { NotifyDispatcher } from './notify/dispatcher';
import { createHttpsTransport } from './notify/httpClient';
import { NotifiedEventStore } from './notify/store';
import type { NotifyConfig } from './notify/types';
import { registerNotifyCommands, resolveNotifySecretStorage } from './notifyIntegration/commands';
import { assembleNotifyConfig, NOTIFY_SECRET_KEY_PREFIX } from './notifyIntegration/credentials';
import { createNotifyOutputChannel } from './notifyIntegration/output';
import type { NotifyOutput } from './notifyIntegration/output';

export interface NotifyConfigurationOptions {
    context: vscode.ExtensionContext;
    getConfiguration: () => vscode.WorkspaceConfiguration;
    configurationTargetGlobal: vscode.ConfigurationTarget;
    homedir: () => string;
    env: NodeJS.ProcessEnv;
    nowMs: () => number;
    setTimeout: (handler: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    sleep: (ms: number) => Promise<void>;
    showWarningMessage: (
        message: string,
        options: vscode.MessageOptions,
        ...items: string[]
    ) => Thenable<string | undefined>;
}

export interface NotifyConfiguration {
    output: NotifyOutput;
    dispatcher: NotifyDispatcher;
    getConfig: () => NotifyConfig | null;
    /** Refreshes the assembled config; never throws (keeps the previous one). */
    refresh: () => Promise<void>;
    dispose(): void;
}

/**
 * Owns the notification configuration wiring: the output channel, the notified
 * event store, the dispatcher, the consent-gated config assembly with secret
 * storage, the secret-change listener, and the notify palette commands.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts. Behaviour is
 * unchanged; notify delivery has manual acceptance coverage in
 * docs/manual-tests/notification-delivery.md. The factory subscribes the
 * secret listener before the dashboard runs the first `refresh()`, so a secret
 * write during bootstrap now triggers one extra idempotent refresh instead of
 * being missed.
 */
export function createNotifyConfiguration(
    options: NotifyConfigurationOptions
): NotifyConfiguration {
    const context = options.context;
    const getConfiguration = options.getConfiguration;
    const showWarningMessage = options.showWarningMessage;
    const notifyOutput = createNotifyOutputChannel();
    const notifiedStore = new NotifiedEventStore(
        path.join(options.homedir(), '.agent-pivot', 'notified.json'));
    notifiedStore.load();
    let currentNotifyConfig: NotifyConfig | null = null;
    const notifyDispatcher = new NotifyDispatcher({
        transport: createHttpsTransport(),
        store: notifiedStore,
        nowMs: () => options.nowMs(),
        setTimeout: (handler, ms) => options.setTimeout(handler, ms),
        clearTimeout: handle => options.clearTimeout(handle),
        sleep: ms => options.sleep(ms),
        globalProxy: () => getConfiguration().get<string>('notify.proxy', ''),
        env: options.env,
        onLog: line => notifyOutput.log(line),
    });
    const refreshNotifyConfig = async (): Promise<void> => {
        try {
            await refreshNotifyConfigUnsafe();
        } catch (error) {
            // 通知配置刷新绝不能让 Dashboard 激活/运行崩溃;保留上一份配置。
            notifyOutput.log(`notify: config refresh failed: ${(error as Error).message}`);
        }
    };
    const refreshNotifyConfigUnsafe = async (): Promise<void> => {
        const configuration = getConfiguration();
        const enabled = configuration.get<boolean>('notify.enabled', false);
        if (enabled && !context.globalState.get<boolean>('agentPivot.notify.consented')) {
            const choice = await showWarningMessage(
                'Agent Pivot will send project names, session names and status to the '
                + 'notification endpoints you configure. No code or file contents are sent. Continue?',
                { modal: true },
                'Enable notifications'
            );
            if (choice !== 'Enable notifications') {
                await configuration.update(
                    'notify.enabled', false, options.configurationTargetGlobal);
                return;
            }
            await context.globalState.update('agentPivot.notify.consented', true);
        }
        const skeletons = configuration.get<Array<Record<string, unknown>>>('notify.sinks', []);
        const secretStorage = resolveNotifySecretStorage(context);
        const secrets: Record<string, string> = {};
        for (const skeleton of skeletons) {
            const id = typeof skeleton.id === 'string' ? skeleton.id : '';
            if (!id) {
                continue;
            }
            const stored = secretStorage
                ? await secretStorage.get(`${NOTIFY_SECRET_KEY_PREFIX}${id}`)
                : undefined;
            if (stored) {
                secrets[id] = stored;
            }
        }
        const assembled = assembleNotifyConfig({
            enabled,
            sinks: skeletons,
            reasons: configuration.get<string[]>('notify.reasons',
                ['completed', 'input-required', 'failed']),
            minRunDurationMs: configuration.get<number>('notify.minRunDurationMs', 60000),
            debounceMs: configuration.get<number>('notify.debounceMs', 5000),
            rateLimitPerMin: configuration.get<number>('notify.rateLimitPerMin', 6),
            escalateAfterMs: configuration.get<number>('notify.escalateAfterMs', 0),
            projectPathMode: configuration.get<string>('notify.projectPathMode', 'basename'),
            includeSessionLabel: configuration.get<boolean>('notify.includeSessionLabel', true),
        }, secrets, line => notifyOutput.log(line));
        currentNotifyConfig = assembled;
        notifyDispatcher.setConfig(assembled);
    };
    // 凭据写入不触发配置变化事件,必须单独监听,否则存完凭据后 dispatcher
    // 仍拿着存凭据之前装配的空 sinks 配置,直到下次配置变更或重载。
    const notifySecretChanges = resolveNotifySecretStorage(context);
    const onNotifySecretChange = notifySecretChanges?.onDidChange;
    const disposables: vscode.Disposable[] = [];
    if (onNotifySecretChange) {
        disposables.push(onNotifySecretChange(event => {
            if (event.key.startsWith(NOTIFY_SECRET_KEY_PREFIX)) {
                void refreshNotifyConfig();
            }
        }));
    }
    disposables.push(...registerNotifyCommands(context, {
        output: notifyOutput,
        getConfig: () => currentNotifyConfig || assembleNotifyConfig({
            enabled: false, sinks: [], reasons: [], minRunDurationMs: 0,
            debounceMs: 0, rateLimitPerMin: 1, escalateAfterMs: 0,
            projectPathMode: 'basename', includeSessionLabel: true,
        }, {}),
        globalProxy: () => getConfiguration().get<string>('notify.proxy', ''),
    }));
    return {
        output: notifyOutput,
        dispatcher: notifyDispatcher,
        getConfig: () => currentNotifyConfig,
        refresh: refreshNotifyConfig,
        dispose: () => {
            disposables.forEach(disposable => disposable.dispose());
            notifyOutput.dispose();
        },
    };
}
