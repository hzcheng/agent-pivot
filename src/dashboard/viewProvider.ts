'use strict';

import * as vscode from 'vscode';

const VISIBLE_VIEW_FAILURE_MESSAGE = 'Unexpected Project Steward view failure.';

export interface SidebarStewardViewProviderOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderContent: (webview: vscode.Webview) => string;
    renderError: (error: unknown) => string;
    onMessage: (message: unknown) => Promise<void>;
    onVisibleChanged: (visible: boolean) => void | Thenable<void> | Promise<void>;
    onDisposed: () => void | Thenable<void> | Promise<void>;
    logError: (message: string, error: unknown) => void;
}

export class SidebarStewardViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'projectSteward.steward';

    private _view?: vscode.WebviewView;
    private viewGeneration = 0;
    private releaseCurrent?: () => Promise<void>;
    private releaseBarrier: Promise<void> = Promise.resolve();

    constructor(private readonly options: SidebarStewardViewProviderOptions) {
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
                    'Failed to dispose Project Steward view.',
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
                    'Failed to handle a Project Steward message.', sanitizedViewFailure()
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
        await this.prepareVisibility(webviewView, isCurrent);
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
                this.options.logError('Failed to render Project Steward view.', failure);
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
        if (!isCurrent()) {
            return;
        }
        try {
            await this.options.onVisibleChanged(webviewView.visible);
            if (!isCurrent()) {
                return;
            }
            if (webviewView.visible) {
                this.refresh();
            }
        } catch (_error) {
            if (!isCurrent()) {
                return;
            }
            const failure = sanitizedViewFailure();
            this.options.logError('Failed to prepare Project Steward view.', failure);
            if (webviewView.visible) {
                webviewView.webview.html = this.options.renderError(failure);
            }
        }
    }
}

function sanitizedViewFailure(): Error {
    return new Error(VISIBLE_VIEW_FAILURE_MESSAGE);
}
