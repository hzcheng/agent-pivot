'use strict';

import * as vscode from 'vscode';
import { AGENT_PIVOT_DASHBOARD_VIEW_ID } from '../constants';

const VISIBLE_VIEW_FAILURE_MESSAGE = 'Unexpected Agent Pivot view failure.';
const RETRY_BOOTSTRAP_MESSAGE_TYPE = 'retry-agent-pivot-bootstrap';
const FIRST_PAINT_MESSAGE_TYPE = 'agent-pivot-browser-first-paint';
const READY_DOCUMENT_MESSAGE_TYPE = 'open-workspaces-renderer-ready';
const BOOT_MESSAGE_VERSION = 1;
const READY_DOCUMENT_RECOVERY_MS = 30_000;

interface ReadyDocumentScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

const DEFAULT_READY_DOCUMENT_SCHEDULER: ReadyDocumentScheduler = {
    setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref();
        return handle;
    },
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface AgentPivotViewProviderOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderContent: (webview: vscode.Webview, documentGeneration: number) => string;
    renderError: (error: unknown) => string;
    onMessage: (message: unknown) => Promise<void>;
    onVisibleChanged: (visible: boolean) => void | Thenable<void> | Promise<void>;
    onVisiblePrepared?: () => void | Thenable<void> | Promise<void>;
    onDisposed: () => void | Thenable<void> | Promise<void>;
    logError: (message: string, error: unknown) => void;
}

export interface AgentPivotViewProviderBootOptions {
    getWebviewOptions: () => vscode.WebviewOptions;
    renderBootContent: (webview: vscode.Webview, generation: number) => string;
    renderBootError: (webview: vscode.Webview, generation: number) => string;
    onBootShellAssigned: (generation: number) => void;
    onRetry: () => void;
    onFirstPaint: (generation: number) => void;
    logError: (message: string, error: unknown) => void;
}

export type AgentPivotViewProviderConfiguration =
    | { mode: 'ready'; options: AgentPivotViewProviderOptions }
    | { mode: 'boot'; options: AgentPivotViewProviderBootOptions };

type ProviderLifecycle =
    | { kind: 'idle' }
    | {
        kind: 'booting';
        generation: number;
        firstPaintAcknowledged: boolean;
    }
    | { kind: 'failed'; generation: number; retryRequested: boolean }
    | { kind: 'ready'; options: AgentPivotViewProviderOptions };

export class AgentPivotViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = AGENT_PIVOT_DASHBOARD_VIEW_ID;

    private _view?: vscode.WebviewView;
    private viewGeneration = 0;
    private preparationGeneration = 0;
    private releaseCurrent?: () => Promise<void>;
    private releaseBarrier: Promise<void> = Promise.resolve();
    private lifecycle: ProviderLifecycle;
    private bootShellAssignedGeneration?: number;
    private completingBootstrapGeneration?: number;
    private readyDocumentGeneration = 0;
    private readyDocumentHandshakePending?: number;
    private readyDocumentRefreshQueued = false;
    private readyDocumentRecoveryAttempted = false;
    private readyDocumentRecoveryTimer?: unknown;

    constructor(
        private readonly configuration: AgentPivotViewProviderConfiguration,
        private readonly readyDocumentScheduler: ReadyDocumentScheduler =
            DEFAULT_READY_DOCUMENT_SCHEDULER,
    ) {
        this.lifecycle = configuration.mode === 'ready'
            ? { kind: 'ready', options: configuration.options }
            : { kind: 'idle' };
    }

    beginBootstrap(generation: number): boolean {
        if (this.configuration.mode !== 'boot'
            || this.completingBootstrapGeneration !== undefined
            || this.lifecycle.kind === 'ready'
            || !isPositiveSafeInteger(generation)
            || (this.lifecycle.kind !== 'idle'
                && generation <= this.lifecycle.generation)) {
            return false;
        }

        this.lifecycle = {
            kind: 'booting',
            generation,
            firstPaintAcknowledged: false,
        };
        this.refresh();
        return true;
    }

    completeBootstrap(
        generation: number,
        options: AgentPivotViewProviderOptions,
    ): boolean {
        if (this.lifecycle.kind !== 'booting'
            || this.lifecycle.generation !== generation
            || this.completingBootstrapGeneration !== undefined) {
            return false;
        }

        const webviewView = this._view;
        this.completingBootstrapGeneration = generation;
        try {
            if (webviewView) {
                const webviewOptions = options.getWebviewOptions();
                webviewView.webview.options = webviewOptions;
            }
            if (this.lifecycle.kind !== 'booting'
                || this.lifecycle.generation !== generation) {
                return false;
            }

            this.lifecycle = { kind: 'ready', options };
        } finally {
            this.completingBootstrapGeneration = undefined;
        }

        try {
            this.refresh();
        } catch (_error) {
            try {
                options.logError(
                    'Failed to render Agent Pivot view.',
                    sanitizedViewFailure(),
                );
            } catch (_logError) {
                // Ready adoption is terminal even when rendering diagnostics fail.
            }
        }
        if (webviewView) {
            void this.prepareVisibility(
                webviewView,
                () => this._view === webviewView,
            ).catch(_error => undefined);
        }
        return true;
    }

    failBootstrap(generation: number): boolean {
        if (this.completingBootstrapGeneration !== undefined
            || this.lifecycle.kind !== 'booting'
            || this.lifecycle.generation !== generation) {
            return false;
        }

        this.lifecycle = { kind: 'failed', generation, retryRequested: false };
        this.refresh();
        return true;
    }

    async resolveWebviewView(webviewView: vscode.WebviewView, webviewContext: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): Promise<void> {
        const viewGeneration = ++this.viewGeneration;
        this.resetReadyDocumentDelivery();
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
                this.resetReadyDocumentDelivery();
            }
            if (this.releaseCurrent === release) {
                this.releaseCurrent = undefined;
            }
            const options = this.readyOptions();
            if (!options) {
                return;
            }
            try {
                await options.onDisposed();
            } catch (_error) {
                options.logError(
                    'Failed to dispose Agent Pivot view.',
                    sanitizedViewFailure()
                );
            }
        };
        this.releaseCurrent = release;
        const isCurrent = () => !disposed && this._view === webviewView;
        webviewView.webview.options = this.getWebviewOptions();

        webviewView.webview.onDidReceiveMessage(async message => {
            if (!isCurrent()) {
                return;
            }
            await this.handleMessage(message, isCurrent);
        });

        webviewView.onDidChangeVisibility(async () => {
            await this.prepareVisibility(webviewView, isCurrent);
        });
        if (typeof webviewView.onDidDispose === 'function') {
            webviewView.onDidDispose(async () => {
                await release();
            });
        }
        if (this.lifecycle.kind === 'ready') {
            this.refresh();
            void this.prepareVisibility(webviewView, isCurrent);
            return;
        }
        this.refresh();
    }

    get visible() {
        return this.lifecycle.kind === 'ready' && Boolean(this._view?.visible);
    }

    refresh() {
        if (!this._view) {
            return;
        }
        if (this.lifecycle.kind === 'ready') {
            if (this.readyDocumentHandshakePending !== undefined) {
                this.readyDocumentRefreshQueued = true;
                // Repeated short retries can keep destroying a slow remote
                // document, so recovery is delayed and limited to one attempt.
                this.scheduleReadyDocumentRecovery();
                return;
            }
            this.renderReadyContent(this._view, this.lifecycle.options);
            return;
        }
        if (this.lifecycle.kind === 'booting') {
            this.renderBootContent(this._view, this.lifecycle.generation);
            return;
        }
        if (this.lifecycle.kind === 'failed') {
            this.renderBootError(this._view, this.lifecycle.generation);
        }
    }

    postMessage(message: unknown): Thenable<boolean> {
        if (!this._view) {
            return Promise.resolve(false);
        }

        return this._view.webview.postMessage(message);
    }

    private getWebviewOptions(): vscode.WebviewOptions {
        return this.lifecycle.kind === 'ready'
            ? this.lifecycle.options.getWebviewOptions()
            : this.bootOptions().getWebviewOptions();
    }

    private readyOptions(): AgentPivotViewProviderOptions | undefined {
        return this.lifecycle.kind === 'ready' ? this.lifecycle.options : undefined;
    }

    private bootOptions(): AgentPivotViewProviderBootOptions {
        if (this.configuration.mode !== 'boot') {
            throw new Error('Agent Pivot boot lifecycle is unavailable in ready mode.');
        }
        return this.configuration.options;
    }

    private async handleMessage(message: unknown, isCurrent: () => boolean): Promise<void> {
        if (this.lifecycle.kind === 'ready') {
            const readyDocumentMessage = parseReadyDocumentMessage(message);
            if (isReadyDocumentMessageCandidate(message)
                && (!readyDocumentMessage
                    || readyDocumentMessage.documentGeneration
                        !== this.readyDocumentHandshakePending)) {
                return;
            }
            const readyDocumentHandshake = readyDocumentMessage !== undefined;
            const refreshQueuedBeforeHandshake = readyDocumentHandshake
                && this.readyDocumentRefreshQueued;
            if (readyDocumentHandshake) {
                this.readyDocumentHandshakePending = undefined;
                this.readyDocumentRefreshQueued = false;
                this.readyDocumentRecoveryAttempted = false;
                this.clearReadyDocumentRecovery();
            }
            try {
                await this.lifecycle.options.onMessage(readyDocumentHandshake
                    ? {
                        type: READY_DOCUMENT_MESSAGE_TYPE,
                        version: BOOT_MESSAGE_VERSION,
                    }
                    : message);
            } catch (_error) {
                if (!isCurrent()) {
                    return;
                }
                this.lifecycle.options.logError(
                    'Failed to handle an Agent Pivot message.', sanitizedViewFailure()
                );
            }
            if (readyDocumentHandshake
                && refreshQueuedBeforeHandshake
                && isCurrent()
                && this.lifecycle.kind === 'ready'
                && this.readyDocumentHandshakePending === undefined) {
                this.refresh();
            }
            return;
        }

        try {
            if (this.lifecycle.kind === 'booting' && isFirstPaintMessage(
                message,
                this.lifecycle.generation,
            ) && !this.lifecycle.firstPaintAcknowledged) {
                this.lifecycle.firstPaintAcknowledged = true;
                this.bootOptions().onFirstPaint(this.lifecycle.generation);
                return;
            }
            if (this.lifecycle.kind === 'failed'
                && !this.lifecycle.retryRequested
                && isRetryBootstrapMessage(message)) {
                this.lifecycle.retryRequested = true;
                this.bootOptions().onRetry();
            }
        } catch (_error) {
            this.bootOptions().logError(
                'Failed to handle an Agent Pivot boot message.',
                sanitizedViewFailure(),
            );
        }
    }

    private renderReadyContent(
        webviewView: vscode.WebviewView,
        options: AgentPivotViewProviderOptions,
    ): void {
        this.clearReadyDocumentRecovery();
        const documentGeneration = ++this.readyDocumentGeneration;
        this.readyDocumentHandshakePending = documentGeneration;
        try {
            webviewView.webview.html = options.renderContent(
                webviewView.webview,
                documentGeneration,
            );
        } catch (_error) {
            this.readyDocumentHandshakePending = undefined;
            const failure = sanitizedViewFailure();
            options.logError('Failed to render Agent Pivot view.', failure);
            webviewView.webview.html = options.renderError(failure);
        }
    }

    private scheduleReadyDocumentRecovery(): void {
        if (this.readyDocumentRecoveryAttempted
            || this.readyDocumentRecoveryTimer !== undefined
            || this.readyDocumentHandshakePending === undefined) {
            return;
        }
        const viewGeneration = this.viewGeneration;
        const documentGeneration = this.readyDocumentHandshakePending;
        this.readyDocumentRecoveryTimer = this.readyDocumentScheduler.setTimeout(() => {
            this.readyDocumentRecoveryTimer = undefined;
            if (viewGeneration !== this.viewGeneration
                || !this._view
                || this.lifecycle.kind !== 'ready'
                || this.readyDocumentHandshakePending !== documentGeneration
                || !this.readyDocumentRefreshQueued
                || this.readyDocumentRecoveryAttempted) {
                return;
            }
            this.readyDocumentRecoveryAttempted = true;
            this.readyDocumentHandshakePending = undefined;
            this.readyDocumentRefreshQueued = false;
            this.refresh();
        }, READY_DOCUMENT_RECOVERY_MS);
    }

    private clearReadyDocumentRecovery(): void {
        if (this.readyDocumentRecoveryTimer === undefined) {
            return;
        }
        this.readyDocumentScheduler.clearTimeout(this.readyDocumentRecoveryTimer);
        this.readyDocumentRecoveryTimer = undefined;
    }

    private resetReadyDocumentDelivery(): void {
        this.clearReadyDocumentRecovery();
        this.readyDocumentHandshakePending = undefined;
        this.readyDocumentRefreshQueued = false;
        this.readyDocumentRecoveryAttempted = false;
    }

    private renderBootContent(webviewView: vscode.WebviewView, generation: number): void {
        try {
            webviewView.webview.html = this.bootOptions().renderBootContent(
                webviewView.webview,
                generation,
            );
        } catch (_error) {
            this.bootOptions().logError(
                'Failed to render Agent Pivot boot shell.',
                sanitizedViewFailure(),
            );
            this.renderBootError(webviewView, generation);
            return;
        }
        if (this.lifecycle.kind !== 'booting'
            || this.lifecycle.generation !== generation
            || this._view !== webviewView
            || this.bootShellAssignedGeneration === generation) {
            return;
        }
        this.bootShellAssignedGeneration = generation;
        try {
            this.bootOptions().onBootShellAssigned(generation);
        } catch (_error) {
            this.bootOptions().logError(
                'Failed to report Agent Pivot boot shell assignment.',
                sanitizedViewFailure(),
            );
        }
    }

    private renderBootError(webviewView: vscode.WebviewView, generation: number): void {
        try {
            webviewView.webview.html = this.bootOptions().renderBootError(
                webviewView.webview,
                generation,
            );
        } catch (_error) {
            this.bootOptions().logError(
                'Failed to render Agent Pivot boot failure.',
                sanitizedViewFailure(),
            );
        }
    }

    private async prepareVisibility(
        webviewView: vscode.WebviewView,
        isCurrent: () => boolean,
    ): Promise<void> {
        const options = this.readyOptions();
        if (!options) {
            return;
        }
        const visible = webviewView.visible;
        const preparationGeneration = ++this.preparationGeneration;
        const isLatest = () =>
            isCurrent() && preparationGeneration === this.preparationGeneration;
        if (!isLatest()) {
            return;
        }
        try {
            await options.onVisibleChanged(visible);
            if (!isLatest() || !visible || !webviewView.visible) {
                return;
            }
            await options.onVisiblePrepared?.();
        } catch (_error) {
            if (!isLatest()) {
                return;
            }
            const failure = sanitizedViewFailure();
            options.logError('Failed to prepare Agent Pivot view.', failure);
        }
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isExactMessage(message: unknown, keys: readonly string[]): message is Record<string, unknown> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
    }
    const actualKeys = Object.keys(message);
    return actualKeys.length === keys.length
        && actualKeys.every(key => keys.includes(key));
}

function isRetryBootstrapMessage(message: unknown): boolean {
    return isExactMessage(message, ['type', 'version'])
        && message.type === RETRY_BOOTSTRAP_MESSAGE_TYPE
        && message.version === BOOT_MESSAGE_VERSION;
}

function isFirstPaintMessage(message: unknown, generation: number): boolean {
    return isExactMessage(message, ['type', 'version', 'generation'])
        && message.type === FIRST_PAINT_MESSAGE_TYPE
        && message.version === BOOT_MESSAGE_VERSION
        && message.generation === generation;
}

function isReadyDocumentMessageCandidate(message: unknown): boolean {
    return Boolean(message)
        && typeof message === 'object'
        && !Array.isArray(message)
        && (message as Record<string, unknown>).type === READY_DOCUMENT_MESSAGE_TYPE;
}

function parseReadyDocumentMessage(message: unknown): {
    documentGeneration: number;
} | undefined {
    if (!isExactMessage(message, ['type', 'version', 'documentGeneration'])
        || message.type !== READY_DOCUMENT_MESSAGE_TYPE
        || message.version !== BOOT_MESSAGE_VERSION
        || !isPositiveSafeInteger(message.documentGeneration)) {
        return undefined;
    }
    return { documentGeneration: message.documentGeneration };
}

function sanitizedViewFailure(): Error {
    return new Error(VISIBLE_VIEW_FAILURE_MESSAGE);
}
