'use strict';

import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import type {
    ActiveAiSessionViewModel,
    AiSessionDisposable,
    AiSessionService,
} from '../types';
import {
    ClaudeConversationAdapter,
    ClaudeConversationAdapterOptions,
} from './claudeAdapter';
import {
    CodexConversationAdapter,
    CodexConversationAdapterOptions,
    CodexConversationClient,
} from './codexAdapter';
import {
    CodexAppServerClient,
    CodexAppServerClientOptions,
} from './codexAppServerClient';
import {
    ConversationHostController,
    ConversationHostControllerOptions,
} from './conversationHostController';
import {
    ConversationCoordinator,
    ConversationCoordinatorOptions,
} from './coordinator';
import {
    KimiConversationAdapter,
    KimiConversationAdapterOptions,
} from './kimiAdapter';
import {
    ConversationError,
    ConversationProviderAdapter,
    SanitizedConversationDiagnostic,
} from './types';
import {
    ConversationViewer,
    ConversationViewerApi,
    ConversationViewerOptions,
} from './viewer';

export interface ConversationCapability {
    controller: ConversationHostController;
    viewer: ConversationViewerApi;
    availability: 'available' | 'unavailable';
    dispose(): void;
}

export interface ConversationCapabilityOptions {
    services: Record<AiSessionProviderId, AiSessionService>;
    resolveTarget: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string
    ) => ActiveAiSessionViewModel | null;
    publish: (message: unknown) => Thenable<boolean>;
    createPanel: typeof vscode.window.createWebviewPanel;
    openExternal: typeof vscode.env.openExternal;
    spawnCodex: typeof childProcess.spawn;
    now: () => number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    onDiagnostic: (event: SanitizedConversationDiagnostic) => void;
}

interface ConversationCapabilityInternalFactories {
    createCodexClient(
        options: CodexAppServerClientOptions
    ): CodexConversationClient;
    createCodexAdapter(
        options: CodexConversationAdapterOptions
    ): ConversationProviderAdapter;
    createKimiAdapter(
        options: KimiConversationAdapterOptions
    ): ConversationProviderAdapter;
    createClaudeAdapter(
        options: ClaudeConversationAdapterOptions
    ): ConversationProviderAdapter;
    createCoordinator(
        options: ConversationCoordinatorOptions
    ): ConversationCoordinator;
    createViewer(options: ConversationViewerOptions): ConversationViewerApi;
    createController(
        options: ConversationHostControllerOptions
    ): ConversationHostController;
}

const DEFAULT_FACTORIES: ConversationCapabilityInternalFactories = {
    createCodexClient: options => new CodexAppServerClient(options),
    createCodexAdapter: options => new CodexConversationAdapter(options),
    createKimiAdapter: options => new KimiConversationAdapter(options),
    createClaudeAdapter: options => new ClaudeConversationAdapter(options),
    createCoordinator: options => new ConversationCoordinator(options),
    createViewer: options => new ConversationViewer(options),
    createController: options => new ConversationHostController(options),
};

export function createConversationCapability(
    options: ConversationCapabilityOptions
): ConversationCapability;
export function createConversationCapability(
    options: ConversationCapabilityOptions,
    internalFactories?: Partial<ConversationCapabilityInternalFactories>
): ConversationCapability;
export function createConversationCapability(
    options: ConversationCapabilityOptions,
    internalFactories: Partial<ConversationCapabilityInternalFactories> = {}
): ConversationCapability {
    const ownedDuringConstruction: AiSessionDisposable[] = [];
    try {
        return createAvailableConversationCapability(
            options,
            { ...DEFAULT_FACTORIES, ...internalFactories },
            ownedDuringConstruction
        );
    } catch (_error) {
        disposeAll(ownedDuringConstruction.reverse());
        reportUnavailable(options.onDiagnostic);
        return createUnavailableConversationCapability(options);
    }
}

function createAvailableConversationCapability(
    options: ConversationCapabilityOptions,
    factories: ConversationCapabilityInternalFactories,
    ownedDuringConstruction: AiSessionDisposable[]
): ConversationCapability {
    const codexClient = factories.createCodexClient({
        spawn: options.spawnCodex as unknown as CodexAppServerClientOptions['spawn'],
        resolveExecutable: () => 'codex',
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    });
    ownedDuringConstruction.push(codexClient);
    const adapters: Record<AiSessionProviderId, ConversationProviderAdapter> = {
        codex: factories.createCodexAdapter({
            client: codexClient,
            watchSessionChanges: onDidChange =>
                options.services.codex.watchSessionChanges(onDidChange),
            setTimeout: options.setTimer,
            clearTimeout: options.clearTimer,
        }),
        kimi: factories.createKimiAdapter({
            resolveSource: sessionId =>
                options.services.kimi.resolveConversationSource?.(sessionId)
                || null,
            watchSessionChanges: onDidChange =>
                options.services.kimi.watchSessionChanges(onDidChange),
            now: options.now,
            setTimeout: options.setTimer,
            clearTimeout: options.clearTimer,
        }),
        claude: factories.createClaudeAdapter({
            resolveSource: sessionId =>
                options.services.claude.resolveConversationSource?.(sessionId)
                || null,
            watchSessionChanges: onDidChange =>
                options.services.claude.watchSessionChanges(onDidChange),
            now: options.now,
            setTimeout: options.setTimer,
            clearTimeout: options.clearTimer,
        }),
    };
    ownedDuringConstruction.push(
        adapters.codex,
        adapters.kimi,
        adapters.claude
    );
    const coordinator = factories.createCoordinator({
        adapters,
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    });
    ownedDuringConstruction.push(coordinator);
    const viewer = factories.createViewer({
        createPanel: options.createPanel,
        readOutline: coordinator.readOutline.bind(coordinator),
        readPage: coordinator.readPage.bind(coordinator),
        watch: coordinator.watch.bind(coordinator),
        restoreFocus: () => undefined,
        openExternal: options.openExternal,
        mediaUri: getConversationMediaUri,
    });
    ownedDuringConstruction.push(viewer);
    const controller = factories.createController({
        coordinator,
        resolveTarget: options.resolveTarget,
        publish: message => options.publish(message),
        openViewer: async (target, authoritativeTarget) => {
            await viewer.open({
                ...target,
                displayName: typeof authoritativeTarget.name === 'string'
                    && authoritativeTarget.name.trim()
                    ? authoritativeTarget.name
                    : `${target.provider} conversation`,
                duplicateDisplayName: false,
            });
        },
    });
    ownedDuringConstruction.push(controller);
    let disposed = false;
    return {
        controller,
        viewer,
        availability: 'available',
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeAll([controller, viewer, coordinator]);
        },
    };
}

function createUnavailableConversationCapability(
    options: ConversationCapabilityOptions
): ConversationCapability {
    const coordinator = {
        setSessionStopped() {},
        async readOutline() {
            throw new ConversationError('unavailable');
        },
        watch() {
            throw new ConversationError('unavailable');
        },
        releaseSubscription() {},
    } as unknown as ConversationCoordinator;
    const viewer: ConversationViewerApi = {
        async open() {},
        async refresh() {},
        dispose() {},
    };
    const controller = new ConversationHostController({
        coordinator,
        resolveTarget: () => null,
        publish: message => options.publish(message),
        openViewer: async () => undefined,
    });
    let disposed = false;
    return {
        controller,
        viewer,
        availability: 'unavailable',
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            controller.dispose();
            viewer.dispose();
        },
    };
}

function getConversationMediaUri(fileName: string): vscode.Uri {
    const mediaRoot = path.basename(__dirname) === 'conversation'
        ? path.resolve(__dirname, '..', '..', '..', 'media')
        : path.resolve(__dirname, '..', 'media');
    return vscode.Uri.file(path.join(mediaRoot, fileName));
}

function reportUnavailable(
    onDiagnostic: ConversationCapabilityOptions['onDiagnostic']
): void {
    try {
        onDiagnostic({
            event: 'conversation-read',
            category: 'unavailable',
        });
    } catch (_error) {
        // Optional diagnostics never block Dashboard activation.
    }
}

function disposeAll(disposables: readonly AiSessionDisposable[]): void {
    const seen = new Set<AiSessionDisposable>();
    for (const disposable of disposables) {
        if (!disposable || seen.has(disposable)) {
            continue;
        }
        seen.add(disposable);
        try {
            disposable.dispose();
        } catch (_error) {
            // One optional capability resource cannot block the remaining cleanup.
        }
    }
}
