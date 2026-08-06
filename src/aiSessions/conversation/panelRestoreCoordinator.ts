'use strict';

import type * as vscode from 'vscode';
import type { AiSessionDisposable } from '../types';
import type { ConversationCapability } from './composition';

interface PendingPanelRestore {
    panel: vscode.WebviewPanel;
    state: unknown;
    resolve: () => void;
}

export class ConversationPanelRestoreCoordinator implements AiSessionDisposable {
    private capability?: ConversationCapability;
    private pending: PendingPanelRestore[] = [];
    private disposed = false;

    restorePanel(
        panel: vscode.WebviewPanel,
        state: unknown
    ): Promise<void> {
        if (this.disposed) {
            panel.dispose();
            return Promise.resolve();
        }
        const capability = this.capability;
        if (capability) {
            return this.runRestore(capability, panel, state);
        }
        panel.webview.html = restoringDocument();
        return new Promise(resolve => {
            this.pending.push({ panel, state, resolve });
        });
    }

    connect(capability: ConversationCapability): AiSessionDisposable {
        if (this.disposed) {
            return { dispose() {} };
        }
        this.capability = capability;
        const pending = this.pending.splice(0);
        for (const restore of pending) {
            void this.runRestore(
                capability,
                restore.panel,
                restore.state
            ).finally(restore.resolve);
        }
        return {
            dispose: () => {
                if (this.capability === capability) {
                    this.capability = undefined;
                }
            },
        };
    }

    connectWhenReady(
        capability: ConversationCapability,
        authorityReady: PromiseLike<unknown>
    ): AiSessionDisposable {
        let active = true;
        let connection: AiSessionDisposable | undefined;
        void Promise.resolve(authorityReady).then(
            () => {
                if (active) {
                    connection = this.connect(capability);
                }
            },
            () => {
                if (active) {
                    this.failPending();
                }
            }
        );
        return {
            dispose: () => {
                active = false;
                connection?.dispose();
                connection = undefined;
            },
        };
    }

    failPending(): void {
        const pending = this.pending.splice(0);
        for (const restore of pending) {
            restore.panel.dispose();
            restore.resolve();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.capability = undefined;
        this.failPending();
    }

    private async runRestore(
        capability: ConversationCapability,
        panel: vscode.WebviewPanel,
        state: unknown
    ): Promise<void> {
        try {
            await capability.restorePanel(panel, state);
        } catch (_error) {
            panel.dispose();
        }
    }
}

function restoringDocument(): string {
    return '<!doctype html><html><head>'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<title>AI Conversation</title></head>'
        + '<body><p>Restoring conversation…</p></body></html>';
}
