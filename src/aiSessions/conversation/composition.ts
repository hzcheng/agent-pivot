'use strict';

import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_PIVOT_DASHBOARD_VIEW_ID } from '../../constants';
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
import type { ConversationCommentStore } from './commentStore';
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
    ConversationViewerTarget,
} from './viewer';

export interface ConversationSessionOpenTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export type OpenLatestConversationResult =
    'opened' | 'unavailable' | 'empty' | 'unknownSession' | 'superseded';
export type FollowActiveConversationResult =
    OpenLatestConversationResult | 'closed';

export interface ConversationCapability {
    controller: ConversationHostController;
    viewer: ConversationViewerApi;
    availability: 'available' | 'unavailable';
    openLatestConversation(
        target: ConversationSessionOpenTarget
    ): Promise<OpenLatestConversationResult>;
    followActiveConversation(
        target: ConversationSessionOpenTarget
    ): Promise<FollowActiveConversationResult>;
    reconcile(): Promise<void>;
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
    getWorkspaceRootHostPaths?: () => readonly string[];
    submitPrompt: (
        target: ConversationViewerTarget,
        prompt: string
    ) => PromiseLike<void> | Promise<void>;
    focusSession?: (
        target: ConversationSessionOpenTarget
    ) => PromiseLike<void> | Promise<void>;
    commentStore?: ConversationCommentStore;
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
    internalFactories: Partial<ConversationCapabilityInternalFactories> = {}
): ConversationCapability {
    const ownership = createConstructionOwnership();
    try {
        return createAvailableConversationCapability(
            options,
            { ...DEFAULT_FACTORIES, ...internalFactories },
            ownership
        );
    } catch (_error) {
        ownership.dispose();
        reportUnavailable(options.onDiagnostic);
        return createUnavailableConversationCapability(options);
    }
}

function createAvailableConversationCapability(
    options: ConversationCapabilityOptions,
    factories: ConversationCapabilityInternalFactories,
    ownership: ConstructionOwnership
): ConversationCapability {
    const codexClient = ownership.own(factories.createCodexClient({
        spawn: options.spawnCodex as unknown as CodexAppServerClientOptions['spawn'],
        resolveExecutable: () => 'codex',
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    }));
    const codexAdapter = ownership.own(factories.createCodexAdapter({
        client: codexClient,
        watchSessionChanges: onDidChange =>
            options.services.codex.watchSessionChanges(onDidChange),
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
    }));
    ownership.transfer(codexClient);
    const kimiAdapter = ownership.own(factories.createKimiAdapter({
        resolveSource: sessionId =>
            options.services.kimi.resolveConversationSource?.(sessionId)
            || null,
        watchSessionChanges: onDidChange =>
            options.services.kimi.watchSessionChanges(onDidChange),
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
    }));
    const claudeAdapter = ownership.own(factories.createClaudeAdapter({
        resolveSource: sessionId =>
            options.services.claude.resolveConversationSource?.(
                sessionId,
                getWorkspaceRootHostPaths(options)
            ) || null,
        watchSessionChanges: onDidChange =>
            options.services.claude.watchSessionChanges(onDidChange),
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
    }));
    const adapters: Record<AiSessionProviderId, ConversationProviderAdapter> = {
        codex: codexAdapter,
        kimi: kimiAdapter,
        claude: claudeAdapter,
    };
    const coordinator = ownership.own(factories.createCoordinator({
        adapters,
        now: options.now,
        setTimeout: options.setTimer,
        clearTimeout: options.clearTimer,
        onDiagnostic: options.onDiagnostic,
    }));
    ownership.transfer(codexAdapter);
    ownership.transfer(kimiAdapter);
    ownership.transfer(claudeAdapter);
    const viewer = ownership.own(factories.createViewer({
        createPanel: options.createPanel,
        readOutline: coordinator.readOutline.bind(coordinator),
        readPage: coordinator.readPage.bind(coordinator),
        readTelemetry: coordinator.readTelemetry.bind(coordinator),
        watch: coordinator.watch.bind(coordinator),
        restoreFocus: target => restoreConversationFocus(options, target),
        openExternal: options.openExternal,
        mediaUri: getConversationMediaUri,
        submitPrompt: options.submitPrompt,
        focusSession: options.focusSession,
        commentStore: options.commentStore,
    }));
    let viewerIntentGeneration = 0;
    const controller = ownership.own(factories.createController({
        coordinator,
        resolveTarget: options.resolveTarget,
        publish: message => options.publish(message),
        openViewer: async (target, authoritativeTarget) => {
            viewerIntentGeneration += 1;
            await viewer.open({
                ...target,
                displayName: authoritativeTarget.conversationDisplayName
                    || (typeof authoritativeTarget.name === 'string'
                        && authoritativeTarget.name.trim()
                        ? authoritativeTarget.name.trim()
                        : `${target.provider} conversation`),
                duplicateDisplayName:
                    authoritativeTarget.duplicateConversationDisplayName
                    === true,
            });
        },
    }));
    let disposed = false;
    return {
        controller,
        viewer,
        availability: 'available',
        openLatestConversation: target => {
            const intentGeneration = ++viewerIntentGeneration;
            return openLatestConversation(
                options,
                coordinator,
                viewer,
                target,
                () => intentGeneration === viewerIntentGeneration
            );
        },
        async followActiveConversation(
            target: ConversationSessionOpenTarget
        ): Promise<FollowActiveConversationResult> {
            if (!viewer.isOpen()) {
                return 'closed';
            }
            const intentGeneration = ++viewerIntentGeneration;
            const resolution = await resolveLatestConversationTarget(
                options,
                coordinator,
                target
            );
            if (intentGeneration !== viewerIntentGeneration) {
                return 'superseded';
            }
            if (!resolution.viewerTarget) {
                return resolution.result;
            }
            if (!viewer.isOpen()) {
                return 'closed';
            }
            return await viewer.follow(resolution.viewerTarget)
                ? 'opened'
                : 'closed';
        },
        async reconcile(): Promise<void> {
            if (disposed) {
                return;
            }
            try {
                controller.reconcile();
                await viewer.reconcileAuthority(target => {
                    const authoritativeTarget = resolveExactTarget(
                        options,
                        target
                    );
                    if (!authoritativeTarget) {
                        return false;
                    }
                    coordinator.setSessionStopped(
                        target.provider,
                        target.sessionId,
                        authoritativeTarget.executionState === 'stopped'
                    );
                    return true;
                });
            } catch (_error) {
                reportUnavailable(options.onDiagnostic);
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            viewerIntentGeneration += 1;
            ownership.dispose();
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
        isOpen: () => false,
        async open() {},
        async follow() {
            return false;
        },
        async refresh() {},
        async reconcileAuthority() {},
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
        async openLatestConversation(): Promise<OpenLatestConversationResult> {
            return 'unavailable';
        },
        async followActiveConversation(): Promise<FollowActiveConversationResult> {
            return 'unavailable';
        },
        async reconcile(): Promise<void> {
            if (!disposed) {
                controller.reconcile();
            }
        },
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

async function openLatestConversation(
    options: ConversationCapabilityOptions,
    coordinator: ConversationCoordinator,
    viewer: ConversationViewerApi,
    target: ConversationSessionOpenTarget,
    isCurrent: () => boolean
): Promise<OpenLatestConversationResult> {
    const resolution = await resolveLatestConversationTarget(
        options,
        coordinator,
        target
    );
    if (!isCurrent()) {
        return 'superseded';
    }
    if (!resolution.viewerTarget) {
        return resolution.result;
    }
    await viewer.open(resolution.viewerTarget);
    return 'opened';
}

interface LatestConversationTargetResolution {
    result: OpenLatestConversationResult;
    viewerTarget?: ConversationViewerTarget;
}

async function resolveLatestConversationTarget(
    options: ConversationCapabilityOptions,
    coordinator: ConversationCoordinator,
    target: ConversationSessionOpenTarget
): Promise<LatestConversationTargetResolution> {
    const authoritativeTarget = resolveExactTarget(options, target);
    if (!authoritativeTarget) {
        return { result: 'unknownSession' };
    }
    coordinator.setSessionStopped(
        target.provider,
        target.sessionId,
        authoritativeTarget.executionState === 'stopped'
    );
    let outline;
    try {
        outline = await coordinator.readOutline(
            target.provider,
            target.sessionId
        );
    } catch (_error) {
        return { result: 'unavailable' };
    }
    const latest = outline.interactions[outline.interactions.length - 1];
    if (!latest) {
        return { result: 'empty' };
    }
    const displayMetadata = authoritativeTarget as ActiveAiSessionViewModel & {
        conversationDisplayName?: string;
        duplicateConversationDisplayName?: boolean;
    };
    const trimmedName = String(authoritativeTarget.name || '').trim();
    return {
        result: 'opened',
        viewerTarget: {
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
            interactionId: latest.id,
            expectedRevision: outline.sourceRevision,
            displayName: displayMetadata.conversationDisplayName
                || (trimmedName || `${target.provider} conversation`),
            duplicateDisplayName:
                displayMetadata.duplicateConversationDisplayName === true,
        },
    };
}

function resolveExactTarget(
    options: ConversationCapabilityOptions,
    target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }
): ActiveAiSessionViewModel | null {
    let authoritativeTarget: ActiveAiSessionViewModel | null;
    try {
        authoritativeTarget = options.resolveTarget(
            target.projectId,
            target.provider,
            target.sessionId
        );
    } catch (_error) {
        return null;
    }
    const projectedTarget = authoritativeTarget as
        | (ActiveAiSessionViewModel & { projectId?: string })
        | null;
    if (!projectedTarget
        || authoritativeTarget.provider !== target.provider
        || authoritativeTarget.sessionId !== target.sessionId
        || (projectedTarget.projectId !== undefined
            && projectedTarget.projectId !== target.projectId)) {
        return null;
    }
    return authoritativeTarget;
}

async function restoreConversationFocus(
    options: ConversationCapabilityOptions,
    target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
        interactionId: string;
    }
): Promise<void> {
    try {
        await vscode.commands.executeCommand(`${AGENT_PIVOT_DASHBOARD_VIEW_ID}.focus`);
    } catch (_error) {
        // Publishing the semantic fallback remains useful if reveal fails.
    }
    try {
        await options.publish({
            type: 'focus-ai-session-conversation-origin',
            version: 1,
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
            interactionId: target.interactionId,
        });
    } catch (_error) {
        // Hidden or disposed sidebar delivery is an expected no-op.
    }
}

function getWorkspaceRootHostPaths(
    options: ConversationCapabilityOptions
): readonly string[] {
    try {
        const paths = options.getWorkspaceRootHostPaths?.();
        return Array.isArray(paths)
            ? paths.filter(candidate => typeof candidate === 'string')
            : [];
    } catch (_error) {
        return [];
    }
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

interface ConstructionOwnership {
    own<TDisposable extends AiSessionDisposable>(
        disposable: TDisposable
    ): TDisposable;
    transfer(disposable: AiSessionDisposable): void;
    dispose(): void;
}

function createConstructionOwnership(): ConstructionOwnership {
    const owned: AiSessionDisposable[] = [];
    let disposed = false;
    return {
        own<TDisposable extends AiSessionDisposable>(
            disposable: TDisposable
        ): TDisposable {
            owned.push(disposable);
            return disposable;
        },
        transfer(disposable: AiSessionDisposable): void {
            const index = owned.indexOf(disposable);
            if (index >= 0) {
                owned.splice(index, 1);
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeAll(owned.slice().reverse());
            owned.length = 0;
        },
    };
}
