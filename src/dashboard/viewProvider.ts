'use strict';

import * as vscode from 'vscode';
import { AGENT_PIVOT_DASHBOARD_VIEW_ID } from '../constants';

const VISIBLE_VIEW_FAILURE_MESSAGE = 'Unexpected Agent Pivot view failure.';

export interface AgentPivotViewProviderOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderContent: (webview: vscode.Webview) => string;
    renderError: (error: unknown) => string;
    onMessage: (message: unknown) => Promise<void>;
    onVisibleChanged: (visible: boolean) => void | Thenable<void> | Promise<void>;
    onVisiblePrepared?: () => void | Thenable<void> | Promise<void>;
    onDisposed: () => void | Thenable<void> | Promise<void>;
    logError: (message: string, error: unknown) => void;
}

export class AgentPivotViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = AGENT_PIVOT_DASHBOARD_VIEW_ID;

    private _view?: vscode.WebviewView;
    private viewGeneration = 0;
    private preparationGeneration = 0;
    private releaseCurrent?: () => Promise<void>;
    private releaseBarrier: Promise<void> = Promise.resolve();

    constructor(private readonly options: AgentPivotViewProviderOptions) {
    }

    async resolveWebviewView(webviewView: vscode.WebviewView, webviewContext: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): Promise<void> {
        const viewGeneration = ++this.viewGeneration;
        const previousRelease = this.releaseCurrent;
        this.releaseCurrent = undefined;
        this._view = undefined;
        if (previousRelease) {
            this.releaseBarrier = previousRelease();
        }
        await this.releaseBarrier;
        if (viewGeneration !== this.viewGeneration) {
            return;
        }

        this._view = webviewView;
        let disposed = false;
        let release: () => Promise<void>;
        release = async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            if (this._view === webviewView) {
                this._view = undefined;
            }
            if (this.releaseCurrent === release) {
                this.releaseCurrent = undefined;
            }
            try {
                await this.options.onDisposed();
            } catch (_error) {
                this.options.logError(
                    'Failed to dispose Agent Pivot view.',
                    sanitizedViewFailure()
                );
            }
        };
        this.releaseCurrent = release;
        const isCurrent = () =>
            !disposed && this._view === webviewView;
        webviewView.webview.options = this.options.getWebviewOptions();

        webviewView.webview.onDidReceiveMessage(async message => {
            if (!isCurrent()) {
                return;
            }
            try {
                await this.options.onMessage(message);
            } catch (_error) {
                if (!isCurrent()) {
                    return;
                }
                this.options.logError(
                    'Failed to handle an Agent Pivot message.', sanitizedViewFailure()
                );
            }
        });

        webviewView.onDidChangeVisibility(async () => {
            await this.prepareVisibility(webviewView, isCurrent);
        });
        if (typeof webviewView.onDidDispose === 'function') {
            webviewView.onDidDispose(async () => {
                await release();
            });
        }
        void this.prepareVisibility(webviewView, isCurrent);
    }

    get visible() {
        return Boolean(this._view?.visible);
    }

    refresh() {
        if (this._view) {
            try {
                this._view.webview.html = this.options.renderContent(this._view.webview);
            } catch (_error) {
                const failure = sanitizedViewFailure();
                this.options.logError('Failed to render Agent Pivot view.', failure);
                this._view.webview.html = this.options.renderError(failure);
            }
        }
    }

    postMessage(message: unknown): Thenable<boolean> {
        if (!this._view) {
            return Promise.resolve(false);
        }

        return this._view.webview.postMessage(message);
    }

    private async prepareVisibility(
        webviewView: vscode.WebviewView,
        isCurrent: () => boolean
    ): Promise<void> {
        const preparationGeneration = ++this.preparationGeneration;
        const isLatest = () =>
            isCurrent() && preparationGeneration === this.preparationGeneration;
        if (!isLatest()) {
            return;
        }
        if (webviewView.visible) {
            this.refresh();
        }
        try {
            await this.options.onVisibleChanged(webviewView.visible);
            if (!isLatest() || !webviewView.visible) {
                return;
            }
            await this.options.onVisiblePrepared?.();
        } catch (_error) {
            if (!isLatest()) {
                return;
            }
            const failure = sanitizedViewFailure();
            this.options.logError('Failed to prepare Agent Pivot view.', failure);
        }
    }
}

function sanitizedViewFailure(): Error {
    return new Error(VISIBLE_VIEW_FAILURE_MESSAGE);
}
