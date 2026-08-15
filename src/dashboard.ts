'use strict';
import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { Project, ProjectRemoteType, StewardInfos, ReopenStewardReason, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
import {
    getEffectiveRunningCardAnimation,
    getEffectiveRunningIconAnimation,
} from './webview/runningAnimationImages';
import { getSkillsPanelContent } from './webview/webviewSkillContent';
import {
    AGENT_PIVOT_CONFIG_SECTION,
    AGENT_PIVOT_CONVERSATION_VIEW_TYPE,
    AGENT_PIVOT_DASHBOARD_VIEW_ID,
    USER_CANCELED,
    RelevantExtensions,
    REOPEN_KEY,
    WSL_DEFAULT_REGEX,
} from './constants';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import { TodoService } from './todos/service';
import { createTodoPanelCapability } from './todos/todoPanelCapability';
import { PromptDashboardController } from './prompts/dashboardController';
import { initializePromptMementoStore, PromptService } from './prompts/service';
import { PromptTerminalCommandController } from './prompts/terminalCommandController';
import { getAiPanelContent, getPromptSurfaceContent } from './prompts/webviewContent';
import { createSkillPanelCapability } from './skills/skillPanelCapability';
import { SkillGroupStore } from './skills/skillGroupStore';
import FileService from './services/fileService';
import CodexSessionService from './services/codexSessionService';
import { ProcCodexRootThreadObserver } from './aiSessions/codexRootThreadObserver';
import KimiSessionService from './services/kimiSessionService';
import ClaudeSessionService from './services/claudeSessionService';
import { showWorktreeInSourceControl } from './services/sourceControl';
import ProjectWindowColorService from './services/projectWindowColorService';
import AiSessionAliasStore from './aiSessions/aliasStore';
import AiSessionProfileStore from './aiSessions/sessionProfileStore';
import AiSessionProfileController from './aiSessions/sessionProfileController';
import { resolveDefaultCodexProfileDecision } from './aiSessions/sessionProfileController';
import {
    CodexProfileSupportProbe,
    codexProfileFileExists,
    listCodexConfigProfiles,
    readCodexProfileContextWindow,
    readCodexProfileContextWindowForModel,
} from './aiSessions/codexProfiles';
import AiSessionAliasController from './aiSessions/aliasController';
import AiSessionPinStore from './aiSessions/pinStore';
import AiSessionPinController from './aiSessions/pinController';
import {
    ConversationCommentFileStore,
} from './aiSessions/conversation/commentStore';
import {
    ProjectCommentFileStore,
} from './aiSessions/conversation/projectCommentStore';
import {
    ConversationBookmarkFileStore,
} from './aiSessions/conversation/bookmarkStore';
import {
    ConversationSessionRebindCoordinator,
    hasCommittedConversationSessionRuntimeRebind,
} from './aiSessions/conversation/sessionRebindCoordinator';
import AiSessionWorkspaceStateStore from './aiSessions/workspaceStateStore';
import ActiveAiSessionTerminalHighlighter from './aiSessions/activeTerminalHighlight';
import AttentionBridgeClient from './aiSessions/attentionBridgeClient';
import {
    getAttentionProjectKey,
    getAttentionProjectPath,
    getLogicalAttentionSessionKey,
} from './aiSessions/attentionProject';
import { buildAttentionQueue } from './aiSessions/attentionQueue';
import type {
    AttentionQueue,
    AttentionQueueWorkspace,
    AttentionQueueWorkspaceSession,
} from './aiSessions/attentionQueue';
import {
    createAttentionStatusBarController,
} from './aiSessions/attentionStatusBarController';
import type {
    AttentionStatusBarController,
} from './aiSessions/attentionStatusBarController';
import {
    createAttentionQueueJumpHandler,
} from './dashboard/attentionQueueJump';
import {
    createRunningSessionJumpHandler,
} from './dashboard/runningSessionJump';
import { createSessionNavigationCoordinator } from './dashboard/sessionNavigationCoordinator';
import { createSessionNavigationFocusExecutor } from './dashboard/sessionNavigationFocusExecutor';
import {
    createAiSessionQuickSwitchHandlers,
} from './dashboard/sessionQuickSwitch';
import {
    createWorktreeOrSessionSwitchHandler,
} from './dashboard/worktreeQuickSwitch';
import { parseAiSessionCreationWorktreeKey } from './aiSessions/worktreeCreationTarget';
import {
    createAiSessionMruTracker,
} from './aiSessions/sessionMru';
import {
    buildRunningSessionQueue,
} from './aiSessions/runningQueue';
import { getAiSessionKey } from './aiSessions/sessionHelpers';
import { createAiSessionProviderRegistry } from './aiSessions/providers';
import { ProviderDirectoryCapabilityProbe } from './aiSessions/providerDirectoryCapability';
import type {
    BoundedChildProcessOptions,
    BoundedChildProcessResult,
} from './aiSessions/providerDirectoryCapability';
import { getAiSessionComparableCwd as getProviderAiSessionComparableCwd, getAiSessionTerminalName as getProviderAiSessionTerminalName } from './aiSessions/sessionPaths';
import { getAiSessionTerminalCandidates } from './aiSessions/terminalCandidates';
import { AiSessionReadCoordinator } from './aiSessions/readCoordinator';
import AiSessionTerminalService from './aiSessions/terminalService';
import AiSessionTerminalBindingStore from './aiSessions/terminalBindingStore';
import { readAiSessionLaunchOptions, readCodexDefaultProfile } from './aiSessions/launchOptions';
import { readAiSessionRuntimeConfiguration } from './aiSessions/runtimeConfiguration';
import { DirectTerminalRuntimeBackend } from './aiSessions/directTerminalRuntimeBackend';
import { AiSessionRuntimeCoordinator } from './aiSessions/runtimeCoordinator';
import type { AiSessionTmuxFallbackContext } from './aiSessions/runtimeCoordinator';
import type { AiSessionRuntimeSnapshot } from './aiSessions/runtimeTypes';
import { cloneAiSessionRuntimeIdentity, TmuxRuntimeUnavailableError } from './aiSessions/runtimeTypes';
import type { AiSessionRuntimeIdentity } from './aiSessions/runtimeTypes';
import { TmuxClient, TmuxClientError } from './aiSessions/tmuxClient';
import { TmuxRuntimeBindingStore } from './aiSessions/tmuxRuntimeBindingStore';
import { TmuxAttachBindingStore } from './aiSessions/tmuxAttachBindingStore';
import {
    isCurrentRuntimeMarker,
    TmuxRuntimeDiscovery,
} from './aiSessions/tmuxRuntimeDiscovery';
import { TmuxRuntimeBackend } from './aiSessions/tmuxRuntimeBackend';
import { TmuxFocusedRuntimeMonitor } from './aiSessions/tmuxFocusedRuntimeMonitor';
import { withTmuxCreationLock } from './aiSessions/tmuxCreationLock';
import type { AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, WorkspaceAiSessionActionTarget } from './aiSessions/types';
import {
    buildAiSessionPresentationState,
    getRenderedCurrentWorkspaceNavigationIdentity,
} from './aiSessions/presentationMessage';
import {
    ConversationCapability,
    createConversationCapability,
} from './aiSessions/conversation/composition';
import {
    ConversationPanelRestoreCoordinator,
} from './aiSessions/conversation/panelRestoreCoordinator';
import {
    withConversationDisplayMetadata,
} from './aiSessions/conversation/displayMetadata';
import {
    submitConversationPrompt,
} from './aiSessions/conversation/submission';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { AiSessionExecutionController } from './aiSessions/executionController';
import {
    AiSessionAttentionController,
} from './aiSessions/attentionController';
import { createAiSessionStatusCapability } from './aiSessions/statusCapability';
import { createAiSessionRuntimeSettlementCapability } from './aiSessions/runtimeSettlementCapability';
import { createAiSessionAttentionEventCapability } from './aiSessions/attentionEventCapability';
import { createNotifyConfiguration } from './aiSessions/notifyConfiguration';
import { registerSponsorCommand, showSponsorOptions } from './sponsor';
import { buildNotifyPayload } from './aiSessions/notifyIntegration/notifier';
import {
    getLastPartOfPath,
    isUriString,
    parsePathAsUri,
} from './projects/openProjectService';
import { findSavedProjectForOpenProject } from './projects/openProjectMatcher';
import { getWorkspacePath as resolveWorkspacePath } from './projects/workspaceHelpers';
import RemoteProjectResolver from './projects/remoteProjectResolver';
import GitRepositoryDetector from './projects/gitRepositoryDetector';
import { AddProjectsFromFolderController } from './projects/addProjectsFromFolderController';
import { CurrentProjectDetailsResolver } from './projects/currentProjectDetails';
import { FavoriteProjectController } from './projects/favoriteProjectController';
import { GroupCommandController } from './projects/groupCommandController';
import { queryGroupName } from './projects/groupPrompts';
import { ProjectManualEditController } from './projects/projectManualEditController';
import { ProjectMutationController } from './projects/projectMutationController';
import { ProjectOpenController } from './projects/projectOpenController';
import { ProjectOrderController } from './projects/projectOrderController';
import { ProjectPromptController } from './projects/projectPromptController';
import { ProjectRemovalController } from './projects/projectRemovalController';
import { createProjectMessageHandlers, createProjectSurfaceRefresh } from './projects/projectMessageHandlers';
import { AgentPivotViewProvider } from './dashboard/viewProvider';
import type { AgentPivotViewProviderOptions } from './dashboard/viewProvider';
import { DashboardBootstrapController } from './dashboard/bootstrapController';
import { DashboardBootstrapResources } from './dashboard/bootstrapResources';
import { getDashboardBootContent } from './dashboard/bootContent';
import { getAgentPivotConfiguration } from './dashboard/configuration';
import { DashboardCommandRegistration } from './dashboard/commandRegistration';
import { ActiveTerminalFileReferenceController } from './dashboard/activeTerminalFileReference';
import DashboardDiagnostics from './dashboard/diagnostics';
import { getErrorContent } from './dashboard/errorContent';
import { GroupCollapseController } from './dashboard/groupCollapseController';
import { DashboardLifecycleController } from './dashboard/lifecycleController';
import { createDashboardMessageRouter } from './dashboard/messageRouter';
import { createDashboardMessageHandlers } from './dashboard/messageHandlers';
import { createSessionControllerComposition } from './aiSessions/sessionControllerComposition';
import { ProjectsPanelController } from './dashboard/projectsPanelController';
import {
    DashboardRuntimeController,
    revealAgentPivotDashboard,
} from './dashboard/runtimeController';
import { DashboardStartupController, settleMigration } from './dashboard/startupController';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import OpenWorkspaceBridgeClient from './openWorkspaces/bridgeClient';
import { EarlyOpenWorkspaceBridge } from './openWorkspaces/earlyBridge';
import {
    createOpenWorkspacePublication,
    sumOpenWorkspaceRunningAiSessionCounts,
} from './openWorkspaces/projection';
import type { OpenWorkspaceAggregate } from './openWorkspaces/protocol';
import { OpenWorkspaceDashboardController } from './openWorkspaces/dashboardController';
import { WorkspaceNavigationController } from './openWorkspaces/navigationController';
import {
    WorkspaceNavigationQuickPickController,
} from './openWorkspaces/navigationQuickPickController';
import { OpenWorkspacePinController } from './openWorkspaces/pinController';
import { OpenWorkspaceController } from './openWorkspaces/workspaceController';
import { WorkspaceContextResolver } from './workspaces/contextResolver';
import { WorkspacePrimaryRootStore } from './workspaces/primaryRootStore';
import { PendingWorkspaceSaveStore } from './workspaces/pendingWorkspaceSaveStore';
import { SavedWorkspaceProjectAdapter } from './workspaces/savedWorkspaceProjectAdapter';
import { WorkspacePendingSessionPromotionController } from './workspaces/pendingSessionPromotionController';
import {
    CurrentWorkspaceSessionAuthority,
} from './workspaces/currentWorkspaceSessionAuthority';
import { hasWorkspaceRuntimeContinuity } from './workspaces/runtimeOwnership';
import {
    AiSessionProjectionCoordinator,
    AiSessionPresentationTransaction,
    WorkspaceSessionHydrationController,
} from './workspaces/sessionHydrationController';
import { isWorkspaceHostPathContained } from './workspaces/sessionAssignment';
import type { OpenWorkspace } from './workspaces/types';
import { buildWorkspaceDashboardSearchCatalog } from './webview/dashboardViewModel';
import { GitWorktreeDiscovery } from './worktrees/gitWorktreeDiscovery';
import {
    GitApiLike,
    GitRepositoryStateMonitor,
} from './worktrees/gitRepositoryStateMonitor';
import { WorktreeSnapshotCoordinator } from './worktrees/snapshotCoordinator';
import { worktreeKeysEqual } from './worktrees/types';
import { WorktreeBaseRefStore } from './worktrees/baseRefStore';
import { WorktreeGroupManifestStore } from './worktrees/groupManifestStore';
import { reconcileWorktreeGroupManifest } from './worktrees/groupManifestReconciliation';
import { IsolatedSessionController } from './worktrees/isolatedSessionController';
import { WorktreeProvisioningStore } from './worktrees/provisioningStore';
import { normalizeWorktreeDirectory } from './worktrees/provisioningPlan';
import { GitWorktreeProvisioner } from './worktrees/gitWorktreeProvisioner';
import {
    WorktreeGroupCreationController,
} from './worktrees/groupCreationController';
import {
    acceptedWorktreeGroupCreationSettlement,
    acceptedWorktreeGroupMemberSettlement,
    parseConfirmWorktreeGroupRequest,
    parseOpenWorktreeGroupFormRequest,
    parsePreviewWorktreeGroupRequest,
    parseWorktreeGroupMemberRequest,
    settledWorktreeGroupCreationSettlement,
    settledWorktreeGroupMemberSettlement,
} from './worktrees/groupCreationProtocol';
import {
    normalizeWorktreeSetupCommand,
    WorktreeSetupRunner,
} from './worktrees/worktreeSetupRunner';
import { ManagedWorktreeRemovalController } from './worktrees/managedWorktreeRemovalController';
import {
    acceptedManagedWorktreeRemovalSettlement,
    parseManagedWorktreeRemovalRequest,
    settledManagedWorktreeRemovalSettlement,
} from './worktrees/removalProtocol';
import {
    acceptedWorktreeGroupPrimarySettlement,
    parseSetWorktreeGroupPrimaryRequest,
    settledWorktreeGroupPrimarySettlement,
} from './worktrees/groupPrimaryProtocol';
import {
    acceptedIsolatedSessionSettlement,
    cancelledMutationSettlement,
    parseIsolatedSessionRequest,
    settledIsolatedSessionSettlement,
} from './worktrees/provisioningProtocol';

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
const AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS = 10000;
const AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;
const DASHBOARD_BOOTSTRAP_PHASE_ORDER = [
    'skill-scan',
    'tmux-persisted-inactive-restore',
    'direct-terminal-restore',
    'tmux-attach-restore',
    'tmux-restore-wait',
    'startup-sequence',
];
// Captured while this module is still being required, so the gap to
// `activate()` separates our own module load from everything VS Code does
// before calling us (notably activating the UI-host bridge dependency).
const DASHBOARD_MODULE_LOADED_AT_MS = performance.now();
let activeAiSessionAttentionBridgeClient: AttentionBridgeClient | null = null;
let activeOpenWorkspaceBridgeClient: OpenWorkspaceBridgeClient | null = null;

function resolveAiProviderExecutable(commandName: string): string | null {
    if (!commandName) {
        return null;
    }
    if (path.isAbsolute(commandName)) {
        return existsSync(commandName) ? commandName : null;
    }

    const windows = process.platform === 'win32';
    const pathValue = process.env.PATH || process.env.Path || '';
    const extensions = windows
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = path.join(directory, `${commandName}${extension}`);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

function runBoundedAiProviderHelp(
    executable: string,
    args: readonly string[],
    options: BoundedChildProcessOptions
): Promise<BoundedChildProcessResult> {
    return new Promise(resolve => {
        childProcess.execFile(executable, [...args], {
            timeout: options.timeoutMs,
            maxBuffer: options.maxOutputBytes,
            encoding: 'utf8',
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const childError = error as unknown as NodeJS.ErrnoException & {
                code?: string | number;
                killed?: boolean;
            };
            resolve({
                exitCode: error
                    ? (typeof childError.code === 'number' ? childError.code : null)
                    : 0,
                stdout: typeof stdout === 'string' ? stdout : '',
                stderr: typeof stderr === 'string' ? stderr : '',
                timedOut: Boolean(error && childError.killed),
            });
        });
    });
}

async function getVsCodeGitApiForWorktreeMonitoring(): Promise<GitApiLike | undefined> {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) {
        return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = (exports as { getAPI?: (version: number) => unknown } | undefined)
        ?.getAPI?.(1) as GitApiLike | undefined;
    return api && Array.isArray(api.repositories)
        && typeof api.onDidOpenRepository === 'function'
        && typeof api.onDidCloseRepository === 'function'
        ? api
        : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const monotonicNowMs = () => performance.now();
    const activationStartedAtMs = monotonicNowMs();
    const outputChannel = vscode.window.createOutputChannel('Agent Pivot');
    context.subscriptions.push(outputChannel);
    const dashboardDiagnostics = new DashboardDiagnostics({
        outputChannel,
        globalStoragePath: context.globalStoragePath,
    });
    dashboardDiagnostics.logDashboardDiagnostic({
        event: 'agent-pivot-activation-entered',
        sinceModuleLoadMs: Math.max(
            0,
            Math.round(activationStartedAtMs - DASHBOARD_MODULE_LOADED_AT_MS),
        ),
    });

    let bootstrapController: DashboardBootstrapController | undefined;
    const provider = new AgentPivotViewProvider({
        mode: 'boot',
        options: {
            getWebviewOptions: () =>
                getDashboardWebviewOptions(context.extensionPath, vscode.Uri.file),
            renderBootContent: (webview, generation) =>
                getDashboardBootContent(webview, { kind: 'booting', generation }),
            renderBootError: (webview, generation) =>
                getDashboardBootContent(webview, { kind: 'failed', generation }),
            onBootShellAssigned: generation => {
                dashboardDiagnostics.logDashboardDiagnostic({
                    event: 'agent-pivot-boot-shell-assigned',
                    generation,
                });
            },
            onRetry: () => bootstrapController?.retry(),
            onFirstPaint: generation => {
                dashboardDiagnostics.logDashboardDiagnostic({
                    event: 'agent-pivot-browser-first-paint',
                    generation,
                    durationMs: Math.max(
                        0,
                        monotonicNowMs() - activationStartedAtMs,
                    ),
                });
            },
            logError: (message, error) =>
                dashboardDiagnostics.logError(message, error),
        },
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AGENT_PIVOT_DASHBOARD_VIEW_ID,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
            },
        ),
    );
    const conversationPanelRestore = new ConversationPanelRestoreCoordinator();
    context.subscriptions.push(conversationPanelRestore);
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(
        AGENT_PIVOT_CONVERSATION_VIEW_TYPE,
        {
            deserializeWebviewPanel: (panel, state) =>
                conversationPanelRestore.restorePanel(panel, state),
        }
    ));

    // Created before bootstrap so its cross-host handshake round trip overlaps
    // the local dashboard build instead of queueing behind it. The publication
    // is derived straight from VS Code state; the accurate AI session count
    // follows on the first real publish once hydration exists.
    const earlyOpenWorkspaceBridge = new EarlyOpenWorkspaceBridge<OpenWorkspaceBridgeClient>({
        createClient: handlers => new OpenWorkspaceBridgeClient(
            createOpenWorkspacePublication(
                new WorkspaceContextResolver().resolve({
                    workspaceFile: vscode.workspace.workspaceFile,
                    workspaceFolders: vscode.workspace.workspaceFolders,
                    workspaceName: vscode.workspace.name,
                    remoteName: vscode.env.remoteName,
                }),
                0,
            ),
            handlers.onAggregate,
            handlers.onError,
            {
                reportDiagnostic: event =>
                    dashboardDiagnostics.logOpenWorkspaceDiagnostic('Workspace', event),
                reportBridgeDiagnostic: event =>
                    dashboardDiagnostics.logOpenWorkspaceDiagnostic('Bridge', event),
                onStatusChange: handlers.onStatusChange,
                onPinSnapshot: handlers.onPinSnapshot,
                onRunningFocusRequest: handlers.onRunningFocusRequest,
                onAttentionFocusRequest: handlers.onAttentionFocusRequest,
            },
        ),
        logError: (message, error) => dashboardDiagnostics.logError(message, error),
    });
    activeOpenWorkspaceBridgeClient = earlyOpenWorkspaceBridge.getClient();
    context.subscriptions.push({
        dispose: () => {
            if (activeOpenWorkspaceBridgeClient === earlyOpenWorkspaceBridge.getClient()) {
                activeOpenWorkspaceBridgeClient = null;
            }
            void earlyOpenWorkspaceBridge.getClient().shutdown();
        },
    });

    const dashboardCommandRegistration =
        new DashboardCommandRegistration<vscode.Disposable>({
            registerCommand: (command, callback) =>
                vscode.commands.registerCommand(command, callback),
            pushSubscription: disposable => context.subscriptions.push(disposable),
            openWhileUnavailable: () => revealAgentPivotDashboard({
                executeCommand: (command, ...args) =>
                    vscode.commands.executeCommand(command, ...args),
                viewType: AGENT_PIVOT_DASHBOARD_VIEW_ID,
            }),
        });
    dashboardCommandRegistration.register();
    context.subscriptions.push(dashboardCommandRegistration);

    bootstrapController = new DashboardBootstrapController({
        run: async (generation, resources) => {
            try {
                const options = await initializeDashboard(
                    context,
                    provider,
                    resources,
                    dashboardDiagnostics,
                    generation,
                    dashboardCommandRegistration,
                    conversationPanelRestore,
                    earlyOpenWorkspaceBridge,
                );
                return options;
            } catch (error) {
                dashboardDiagnostics.logError(
                    'Failed to initialize Agent Pivot dashboard.',
                    error,
                );
                throw error;
            }
        },
        begin: generation => provider.beginBootstrap(generation),
        complete: (generation, options) => {
            const accepted = provider.completeBootstrap(generation, options);
            if (!accepted) {
                dashboardCommandRegistration.discard(generation);
                return false;
            }
            return dashboardCommandRegistration.activate(generation);
        },
        fail: generation => {
            dashboardCommandRegistration.discard(generation);
            conversationPanelRestore.failPending();
            return provider.failBootstrap(generation);
        },
        transfer: resources => resources.transferTo(context.subscriptions),
        logDiagnostic: event =>
            dashboardDiagnostics.logDashboardDiagnostic(event),
        nowMs: monotonicNowMs,
    });
    context.subscriptions.push(bootstrapController);
    bootstrapController.start();

async function initializeDashboard(
    context: vscode.ExtensionContext,
    provider: AgentPivotViewProvider,
    resources: DashboardBootstrapResources,
    dashboardDiagnostics: DashboardDiagnostics,
    bootstrapGeneration: number,
    dashboardCommandRegistration: DashboardCommandRegistration<vscode.Disposable>,
    conversationPanelRestore: ConversationPanelRestoreCoordinator,
    earlyOpenWorkspaceBridge: EarlyOpenWorkspaceBridge<OpenWorkspaceBridgeClient>,
): Promise<AgentPivotViewProviderOptions> {
    const ownResource = <T extends { dispose(): unknown }>(factory: () => T): T => {
        let resource: T | undefined;
        resources.own({
            dispose: () => resource?.dispose(),
        });
        resource = factory();
        return resource;
    };
    const ownTimer = <T>(start: () => T, cancel: (handle: T) => void): T => {
        let handle: T | undefined;
        resources.own({
            dispose: () => {
                if (handle !== undefined) {
                    cancel(handle);
                }
            },
        });
        handle = start();
        return handle;
    };
    const logError = (message: string, error: unknown) => dashboardDiagnostics.logError(message, error);
    const logAiSessionDiagnostic = (event: Record<string, unknown>) => dashboardDiagnostics.logAiSessionDiagnostic(event);
    const logDashboardDiagnostic = (event: Record<string, unknown>) => dashboardDiagnostics.logDashboardDiagnostic(event);
    const logOpenWorkspaceDiagnostic = (component: string, event: unknown) => dashboardDiagnostics.logOpenWorkspaceDiagnostic(component, event);
    const logOpenWorkspaceBridgeError = (error: unknown) => dashboardDiagnostics.logOpenWorkspaceBridgeError(error);
    const bootstrapPhaseTimings: Record<string, number> = {};
    for (const phase of DASHBOARD_BOOTSTRAP_PHASE_ORDER) {
        bootstrapPhaseTimings[phase] = 0;
    }
    const timeBootstrapPhase = async <T>(
        phase: string,
        run: () => T | Promise<T>
    ): Promise<T> => {
        const startedAtMs = Date.now();
        try {
            return await run();
        } finally {
            bootstrapPhaseTimings[phase] = Math.max(0, Date.now() - startedAtMs);
        }
    };
    let settleStorageMigration: (available: boolean) => void = () => undefined;
    let storageMigrationSettled = false;
    const storageMigrationReady = new Promise<boolean>(resolve => {
        settleStorageMigration = available => {
            if (storageMigrationSettled) {
                return;
            }
            storageMigrationSettled = true;
            resolve(available);
        };
    });
    resources.own({ dispose: () => settleStorageMigration(false) });
    const runAfterStorageMigration = async <T>(run: () => T | PromiseLike<T>): Promise<T> => {
        const available = await storageMigrationReady;
        resources.assertActive();
        if (!available) {
            throw new Error('Agent Pivot storage migration did not complete.');
        }
        return run();
    };
    const storageMutationMessageTypes = new Set([
        'save-current-workspace',
        'save-project',
        'add-project',
        'import-from-other-storage',
        'reordered-projects',
        'reordered-favorites',
        'remove-project',
        'edit-project',
        'color-project',
        'favorite-project',
        'edit-group',
        'remove-group',
        'add-group',
    ]);
    const messageRequiresStorageMigration = (message: unknown): boolean => {
        if (!message || typeof message !== 'object') {
            return false;
        }
        const messageType = (message as { type?: unknown }).type;
        return typeof messageType === 'string'
            && (messageType.startsWith('todo-')
                || storageMutationMessageTypes.has(messageType));
    };

    const colorService = new ColorService(context);
    const projectService = new ProjectService(context, colorService, {
        onDiagnostic: event => logDashboardDiagnostic(event),
        onConflict: projectIds => {
            logDashboardDiagnostic({
                event: 'project-catalog-sync-conflict-recovered',
                projectIds,
            });
            void vscode.window.showInformationMessage(
                'Agent Pivot recovered projects from a sync conflict.'
            );
        },
    });
    const todoService = new TodoService(context);
    const promptConfiguration = getAgentPivotConfiguration();
    const promptStore = await initializePromptMementoStore({
        globalState: context.globalState,
        readLegacySetting: () =>
            promptConfiguration.inspect<unknown>('promptData')?.globalValue,
    });
    resources.assertActive();
    const promptService = new PromptService({
        readSetting: promptStore.readSetting,
        writeGlobalSetting: promptStore.writeGlobalSetting,
        createId: () => randomBytes(16).toString('hex'),
        logDiagnostic: event => logDashboardDiagnostic({ event: 'prompt-store', ...event }),
    });
    const getWorkspaceRootPaths = (): string[] =>
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const promptDashboardController = new PromptDashboardController({
        service: promptService,
        confirmDelete: async prompt => {
            const choice = await vscode.window.showWarningMessage(
                `Delete Prompt "${prompt.name}"?`,
                { modal: true },
                'Delete'
            );
            return choice === 'Delete';
        },
        renderPromptSurface: getPromptSurfaceContent,
        renderAiPanel: snapshot => getAiPanelContent(
            snapshot,
            getSkillsPanelContent(
                skillPanel.getRecords(),
                skillPanel.getPanelView(),
            ),
        ),
    });
    const skillPanel = ownResource(() => createSkillPanelCapability({
        getHomeDir: () => os.homedir(),
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        getWorkspaceRoots: getWorkspaceRootPaths,
        hasWorkspace: () => Boolean(vscode.workspace.workspaceFolders?.length),
        groupStore: new SkillGroupStore(context.globalState),
        readGlobalStorePath: () => getAgentPivotConfiguration().get<string>(
            'skills.globalStorePath',
            '~/.skills',
        ),
        writeGlobalStorePath: value => getAgentPivotConfiguration().update(
            'skills.globalStorePath',
            value,
            vscode.ConfigurationTarget.Global,
        ),
        postMessage: message => provider.postMessage(message),
        refreshDashboard: () => provider.refresh(),
        isVisible: () => provider.visible,
        showInputBox: options => vscode.window.showInputBox(options),
        showQuickPickMany: <T extends vscode.QuickPickItem>(
            items: readonly T[],
            quickPickOptions: vscode.QuickPickOptions
        ) => vscode.window.showQuickPick(
            [...items],
            { ...quickPickOptions, canPickMany: true } as vscode.QuickPickOptions & { canPickMany: true }
        ),
        showWarningMessage: (message, messageOptions, ...items) => messageOptions
            ? vscode.window.showWarningMessage(message, messageOptions, ...items)
            : vscode.window.showWarningMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        openTextFile: fsPath => vscode.window.showTextDocument(vscode.Uri.file(fsPath)),
        logError,
    }));
    timeBootstrapPhase('skill-scan', () => skillPanel.start());
    const todoPanel = ownResource(() => createTodoPanelCapability({
        provider,
        todoService,
        getSearchCatalog: () => buildWorkspaceDashboardSearchCatalog(
            projectService.getGroups(),
            getOpenWorkspaceCards(),
            todoService.getSearchItems(),
            skillPanel.getRecords(),
        ),
        getConfiguration: () => getAgentPivotConfiguration(),
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: (message, messageOptions, ...items) =>
            vscode.window.showWarningMessage(message, messageOptions, ...items),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logError,
    }));
    const projectSurface = createProjectSurfaceRefresh({
        getProjectsPanelController: () => projectsPanelController,
        getOpenWorkspaceDashboardController: () => openWorkspaceDashboardController,
        publishOpenWorkspace: () => openWorkspaceController.publish(),
        syncProjectColorToCurrentWindow: project =>
            dashboardRuntimeController.applyProjectColorToCurrentWindow(project),
    });
    const groupCollapseController = new GroupCollapseController({
        state: context.globalState,
        projectService,
    });
    const groupCommandController = new GroupCommandController({
        projectService,
        promptGroupName: defaultText => queryGroupName(vscode.window, defaultText),
        promptGroupToRemove: () => projectPromptController.queryGroup(),
        confirmRemoveGroup: groupName => vscode.window.showWarningMessage(`Remove ${groupName}?`, { modal: true }, 'Remove'),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
        userCanceledToken: USER_CANCELED,
    });
    const projectWindowColorService = new ProjectWindowColorService(context);
    const fileService = new FileService(context);
    const gitRepositoryDetector = new GitRepositoryDetector();
    const projectOpenController = new ProjectOpenController({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getPrependVscodeUrlToWslRemotes: () => stewardInfos.config.prependVscodeUrlToWslRemotes,
        getProjectPathType: projectPath => fileService.getProjectPathType(projectPath),
        getFoldersFromWorkspaceFile: workspaceFilePath => fileService.getFoldersFromWorkspaceFile(workspaceFilePath),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        updateWorkspaceFolders: (start, deleteCount, ...workspaceFoldersToAdd) => vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...workspaceFoldersToAdd),
        updateReopenReason: reason => context.globalState.update(REOPEN_KEY, reason),
        fileUri: projectPath => vscode.Uri.file(projectPath),
        parseUri: projectPath => vscode.Uri.parse(projectPath),
    });
    const projectPromptController = new ProjectPromptController({
        getGroups: () => projectService.getGroups(),
        addGroup: name => projectService.addGroup(name),
        removeGroup: (groupId, skipConfirmation) => projectService.removeGroup(groupId, skipConfirmation),
        isFile: projectPath => fileService.isFile(projectPath),
        isFolderGitRepo: projectPath => isFolderGitRepo(projectPath),
        getRandomColor: () => colorService.getRandomColor(),
        getColorName: colorCode => colorService.getColorName(colorCode),
        getRecentColors: () => colorService.getRecentColors(),
        getRemoteSshExtensionInstalled: () => stewardInfos.relevantExtensionsInstalls.remoteSSH,
        showInputBox: options => vscode.window.showInputBox(options),
        showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
        showOpenDialog: options => vscode.window.showOpenDialog(options),
    });
    const projectMutationController = new ProjectMutationController({
        getCurrentWorkspacePath: () => resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
        getCurrentProjectDetailsForSave: () => currentProjectDetailsResolver.getCurrentProjectDetailsForSave(),
        getProjectDetailsForSave: uri => currentProjectDetailsResolver.getProjectDetailsForSave(uri),
        getProjectsFlat: () => projectService.getProjectsFlat(),
        getProjectAndGroup: projectId => projectService.getProjectAndGroup(projectId),
        addProjectToGroup: (project, groupId) => projectService.addProject(project, groupId),
        updateProject: (projectId, project) => projectService.updateProject(projectId, project),
        removeGroup: (groupId, skipConfirmation) => projectService.removeGroup(groupId, skipConfirmation),
        getRandomColor: () => colorService.getRandomColor(),
        isFolderGitRepo,
        prompt: projectPromptController,
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
    });
    const favoriteProjectController = new FavoriteProjectController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
    });
    const projectOrderController = new ProjectOrderController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
    });
    const projectRemovalController = new ProjectRemovalController({
        getProject: projectId => projectService.getProject(projectId),
        getProjectsFlat: () => projectService.getProjectsFlat(),
        showProjectPicker: projectPicks => vscode.window.showQuickPick(projectPicks),
        confirmRemoveProject: projectName => vscode.window.showWarningMessage(`Remove ${projectName}?`, { modal: true }, 'Remove'),
        removeProject: projectId => projectService.removeProject(projectId),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
        postCommandRemoval: () => { void dashboardRuntimeController.revealAgentPivotDashboard(); },
    });
    const projectManualEditController = new ProjectManualEditController({
        getGroups: () => projectService.getGroups(),
        getTempFilePath: () => `${context.globalStoragePath}/Agent Pivot Projects.json`,
        writeTextFile: (filePath, content) => fileService.writeTextFile(filePath, content),
        fileUri: filePath => vscode.Uri.file(filePath),
        openTextDocument: uri => vscode.workspace.openTextDocument(uri),
        showTextDocument: document => vscode.window.showTextDocument(document),
        onWillSaveTextDocument: listener => vscode.workspace.onWillSaveTextDocument(listener),
        saveGroups: (groups, baselineGroups) =>
            projectService.saveGroupsFromManualEdit(groups, baselineGroups),
        executeCommand: command => vscode.commands.executeCommand(command),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        postSave: () => {
            projectSurface.refreshAfterMutation();
            void dashboardRuntimeController.revealAgentPivotDashboard();
        },
    });
    const addProjectsFromFolderController = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => resolveWorkspacePath(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders),
        parsePathAsUri,
        showOpenDialog: options => vscode.window.showOpenDialog(options),
        getFolders: folderPath => fileService.getFolders(folderPath),
        addGroup: groupName => projectService.addGroup(groupName),
        addProject: (project, groupId) => projectService.addProject(project, groupId),
        getRandomColor: () => colorService.getRandomColor(),
        isFolderGitRepo,
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
        userCanceledToken: USER_CANCELED,
    });
    const codexSessionService = new CodexSessionService();
    const kimiSessionService = new KimiSessionService();
    const claudeSessionService = new ClaudeSessionService();
    const remoteProjectResolver = new RemoteProjectResolver(logError);
    const currentProjectDetailsResolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getRemoteName: () => vscode.env.remoteName,
        getProjectDetailsForSave: (workspaceUri, remoteName) => remoteProjectResolver.getProjectDetailsForSave(workspaceUri, remoteName),
    });
    const aiSessionServices: Record<AiSessionProviderId, AiSessionService> = {
        codex: codexSessionService,
        kimi: kimiSessionService,
        claude: claudeSessionService,
    };
    const aiSessionProviderRegistry = createAiSessionProviderRegistry(aiSessionServices);
    const aiSessionProviders = aiSessionProviderRegistry.providers();
    const aiSessionReadCoordinator = new AiSessionReadCoordinator(
        aiSessionProviders,
        logAiSessionDiagnostic
    );
    const aiSessionAliasStore = new AiSessionAliasStore(context.globalStoragePath);
    const aiSessionAliasController = new AiSessionAliasController({
        store: aiSessionAliasStore,
        isProviderId: isAiSessionProviderId,
        getSessionKey: getAiSessionPinKey,
        getProviderResult: (providerId, options) => aiSessionReadCoordinator.getProviderResult(providerId, options),
        logError,
        showSaveError: () => vscode.window.showErrorMessage("Could not save the chat name."),
    });
    const aiSessionProfileStore = new AiSessionProfileStore(context.globalStoragePath);
    const aiSessionProfileController = new AiSessionProfileController({
        store: aiSessionProfileStore,
        isProviderId: isAiSessionProviderId,
        getSessionKey: getAiSessionPinKey,
        logError,
        showSaveError: () => vscode.window.showErrorMessage('Could not save the Codex session profile.'),
        lastUsedMemento: context.globalState,
        isProfileAvailable: name => codexProfileFileExists(name),
    });
    const codexProfileSupportProbe = new CodexProfileSupportProbe({
        executable: resolveAiProviderExecutable('codex') || 'codex',
        memento: context.globalState,
    });
    const conversationCommentStore = new ConversationCommentFileStore(
        context.globalStoragePath
    );
    const workspaceContextResolver = new WorkspaceContextResolver();
    const currentWorkspaceSessionAuthority =
        new CurrentWorkspaceSessionAuthority(
            context.globalState,
            error => logError(
                'Failed to persist current workspace Session authority.',
                error
            )
        );
    const activationWorkspace = workspaceContextResolver.resolve({
        workspaceFile: vscode.workspace.workspaceFile,
        workspaceFolders: vscode.workspace.workspaceFolders,
        workspaceName: vscode.workspace.name,
        remoteName: vscode.env.remoteName,
    });
    if (activationWorkspace) {
        currentWorkspaceSessionAuthority.getProjectId({
            workspaceNavigationIdentity:
                activationWorkspace.navigationIdentity,
            workspaceScopeIdentity: activationWorkspace.scopeIdentity,
        });
    }
    const projectCommentStore = new ProjectCommentFileStore(
        context.globalStoragePath
    );
    const conversationBookmarkStore = new ConversationBookmarkFileStore(
        context.globalStoragePath
    );
    let followConversationSessionRebind = (
        _previous: { projectId: string; provider: AiSessionProviderId; sessionId: string },
        _next: { projectId: string; provider: AiSessionProviderId; sessionId: string }
    ): Promise<boolean> => Promise.resolve(false);
    let freezeConversationSessionMetadata = (
        _target: { projectId: string; provider: AiSessionProviderId; sessionId: string }
    ): Promise<boolean> => Promise.resolve(false);
    const aiSessionTerminalBindingStore = new AiSessionTerminalBindingStore(context.workspaceState, error =>
        logError('Failed to persist AI session terminal ownership.', error)
    );
    const aiSessionTerminalService = new AiSessionTerminalService(
        context.globalStoragePath,
        aiSessionProviders,
        undefined,
        undefined,
        aiSessionTerminalBindingStore
    );
    let aiSessionRuntimeConfiguration = readAiSessionRuntimeConfiguration(getAgentPivotConfiguration());
    const tmuxRuntimeStore = new TmuxRuntimeBindingStore(
        path.join(context.globalStoragePath, 'ai-session-tmux-runtimes'),
        () => Date.now(),
        operation => withTmuxCreationLock(
            context.globalStoragePath,
            'runtime-binding-final-records',
            operation
        )
    );
    const conversationSessionRebindCoordinator =
        new ConversationSessionRebindCoordinator({
            globalStoragePath: context.globalStoragePath,
            commentStore: conversationCommentStore,
            bookmarkStore: conversationBookmarkStore,
            isRuntimeRebindCommitted: async (previous, next) =>
                hasCommittedConversationSessionRuntimeRebind(
                    (await tmuxRuntimeStore.listKnown()).map(binding => ({
                        provider: binding.provider,
                        sessionId: binding.sessionId,
                        projectId: currentWorkspaceSessionAuthority.getProjectId({
                            workspaceScopeIdentity:
                                binding.workspaceScopeIdentity,
                            workspaceNavigationIdentity:
                                binding.workspaceNavigationIdentity,
                        }),
                    })),
                    previous,
                    next
                ),
            onResult: (kind, result) => logAiSessionDiagnostic({
                event: 'conversation-session-rebind-metadata',
                kind,
                result,
            }),
            onFailure: (kind, error) => logAiSessionRuntimeFailure(
                `copy-conversation-${kind}-for-rebind`,
                error
            ),
        });
    const conversationViewerCommentStore = {
        load: (target: { projectId: string; provider: AiSessionProviderId; sessionId: string }) =>
            conversationCommentStore.load(
                conversationSessionRebindCoordinator.resolve(target)
            ),
        save: (
            target: { projectId: string; provider: AiSessionProviderId; sessionId: string },
            snapshot: Parameters<typeof conversationCommentStore.save>[1]
        ) => conversationCommentStore.save(
            conversationSessionRebindCoordinator.resolve(target),
            snapshot
        ),
    };
    const conversationViewerBookmarkStore = {
        load: (target: { projectId: string; provider: AiSessionProviderId; sessionId: string }) =>
            conversationBookmarkStore.load(
                conversationSessionRebindCoordinator.resolve(target)
            ),
        save: (
            target: { projectId: string; provider: AiSessionProviderId; sessionId: string },
            snapshot: Parameters<typeof conversationBookmarkStore.save>[1]
        ) => conversationBookmarkStore.save(
            conversationSessionRebindCoordinator.resolve(target),
            snapshot
        ),
    };
    const conversationSessionRebindRestoreTask =
        conversationSessionRebindCoordinator.restore().catch(error => {
            logAiSessionRuntimeFailure(
                'restore-conversation-session-rebinds',
                error
            );
        });
    const tmuxAttachBindingStore = new TmuxAttachBindingStore(context.workspaceState, error => {
        logAiSessionRuntimeFailure('persist-attach-binding', error);
    });
    const tmuxClient = new TmuxClient(aiSessionRuntimeConfiguration.tmuxPath);
    const tmuxRuntimeDiscovery = new TmuxRuntimeDiscovery({
        client: tmuxClient,
        bindingStore: tmuxRuntimeStore,
        codexRootThreadObserver: new ProcCodexRootThreadObserver(),
        onSessionRebinding: async (previous, next) => {
            const projectId = currentWorkspaceSessionAuthority.getProjectId(
                previous
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceNavigationIdentity
                    !== next.workspaceNavigationIdentity) {
                throw new Error('Invalid conversation Session rebind identity.');
            }
            await conversationSessionRebindCoordinator.prepare({
                projectId,
                provider: previous.provider,
                sessionId: previous.sessionId,
            }, {
                projectId,
                provider: next.provider,
                sessionId: next.sessionId,
            });
        },
        onSessionRebound: async (previous, next) => {
            aiSessionAliasController.copyForRebind(
                previous.provider,
                previous.sessionId || '',
                next.sessionId || ''
            );
            aiSessionProfileController.copyForRebind(
                previous.provider,
                previous.sessionId || '',
                next.sessionId || ''
            );
            const projectId = currentWorkspaceSessionAuthority.getProjectId(
                previous
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceNavigationIdentity
                    !== next.workspaceNavigationIdentity) {
                return;
            }
            const previousTarget = {
                projectId,
                provider: previous.provider,
                sessionId: previous.sessionId,
            };
            const nextTarget = {
                projectId,
                provider: next.provider,
                sessionId: next.sessionId,
            };
            await freezeConversationSessionMetadata(previousTarget);
            try {
                await conversationSessionRebindCoordinator.commit(
                    previousTarget,
                    nextTarget
                );
            } catch (error) {
                logAiSessionRuntimeFailure(
                    'migrate-conversation-session-rebind',
                    error
                );
            }
            if (conversationSessionRebindCoordinator.resolve(previousTarget)
                .sessionId !== nextTarget.sessionId) {
                return;
            }
            try {
                await followConversationSessionRebind(
                    previousTarget,
                    nextTarget
                );
            } catch (error) {
                logAiSessionRuntimeFailure(
                    'follow-conversation-session-rebind',
                    error
                );
            }
        },
        markerIsCurrent: isCurrentRuntimeMarker,
    });
    const persistedInactiveRestoreTask = (async (): Promise<void> => {
        try {
            await timeBootstrapPhase('tmux-persisted-inactive-restore', () =>
                tmuxRuntimeDiscovery.loadPersistedInactive());
        } catch (error) {
            logAiSessionRuntimeFailure('restore-inactive-runtimes', error);
        }
    })();
    resources.assertActive();
    const directTerminalRuntimeBackend = new DirectTerminalRuntimeBackend(aiSessionTerminalService);
    const tmuxRuntimeBackend = new TmuxRuntimeBackend<vscode.Terminal>({
        platform: process.platform,
        client: tmuxClient,
        discovery: tmuxRuntimeDiscovery,
        runtimeStore: tmuxRuntimeStore,
        attachStore: tmuxAttachBindingStore,
        getTerminals: () => vscode.window.terminals,
        withCreationLock: (key, operation) => withTmuxCreationLock(context.globalStoragePath, key, operation),
        createTerminal: options => vscode.window.createTerminal(options),
        nowMs: () => Date.now(),
        getAttachTerminalName: getAiSessionTmuxAttachTerminalName,
    });
    let publishRestoredTmuxAttachTerminal = (): void => undefined;
    let aiSessionProjectionCoordinator: AiSessionProjectionCoordinator<vscode.Terminal>;
    const aiSessionAttentionEvent = ownResource(() => createAiSessionAttentionEventCapability({
        tmuxRuntimeDiscovery,
        tmuxRuntimeBackend,
        tmuxRuntimeStore,
        aiSessionTerminalService,
        getRuntimeConfiguration: () => aiSessionRuntimeConfiguration,
        getCurrentOpenWorkspace: () => getCurrentOpenWorkspace(),
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        isVisible: () => provider.visible,
        assertActive: () => resources.assertActive(),
        createBridgeClient: (onAggregate, onError) => new AttentionBridgeClient(onAggregate, onError),
        onDidOpenTerminal: callback => vscode.window.onDidOpenTerminal(callback),
        onDidChangeActiveTerminal: callback => vscode.window.onDidChangeActiveTerminal(callback),
        onDidCloseTerminal: callback => vscode.window.onDidCloseTerminal(callback),
        logError,
        logAiSessionRuntimeFailure,
        getRuntimeCoordinator: () => aiSessionRuntimeCoordinator,
        getAttentionController: () => aiSessionAttentionController,
        runSafeLifecycleTask: (operation, task) =>
            aiSessionRuntimeSettlement.runSafeLifecycleTask(operation, task),
        evaluateLifecycleTick: () => evaluateAiSessionLifecycleTick(),
        refreshViewsNow: reason => { void aiSessionDashboardController.refreshNow(reason); },
        scheduleRefresh: reason => aiSessionDashboardController.scheduleRefresh(reason),
        postOpenWorkspacesUpdated: () => openWorkspaceDashboardController?.postUpdated(),
        getActiveTerminalHighlighter: () => activeAiSessionTerminalHighlighter,
        getTmuxFocusedRuntimeMonitor: () => tmuxFocusedRuntimeMonitor,
        publishRestoredAttachTerminal: () => publishRestoredTmuxAttachTerminal(),
    }));
    const evaluateAiSessionAttention = aiSessionAttentionEvent.evaluateAttention;
    const hasLiveTmuxOwnership = aiSessionAttentionEvent.hasLiveTmuxOwnership;
    const getAiSessionRuntimeById = aiSessionAttentionEvent.getRuntimeById;
    const getAiSessionRuntimeCollision = aiSessionAttentionEvent.getRuntimeCollision;
    const getFocusedAiSessionRuntimeIdentity = aiSessionAttentionEvent.getFocusedRuntimeIdentity;
    const runtimeBelongsToCurrentWorkspace = aiSessionAttentionEvent.belongsToCurrentWorkspace;
    const refreshAiSessionViewsIncrementally = aiSessionAttentionEvent.refreshViewsIncrementally;
    const acknowledgeAiSessionAttentionEventIds = aiSessionAttentionEvent.acknowledgeEventIds;
    const acknowledgeAiSessionAttention = aiSessionAttentionEvent.acknowledgeAttention;
    const publishDeferredTmuxRestoreIfReady = aiSessionAttentionEvent.publishDeferredRestoreIfReady;
    ownResource(() => aiSessionAttentionEvent.registerTerminalRestoreHandler());
    const aiSessionRuntimeCoordinator = new AiSessionRuntimeCoordinator<vscode.Terminal>({
        direct: directTerminalRuntimeBackend,
        tmux: tmuxRuntimeBackend,
        getConfiguration: () => ({ ...aiSessionRuntimeConfiguration }),
        chooseTmuxFallback: chooseAiSessionTmuxFallback,
        hasLiveTmuxOwnership,
        hasKnownTmuxHint: async identity => Boolean(identity.sessionId
            && await tmuxRuntimeStore.getKnown(identity.provider, identity.sessionId,
                identity.workspaceScopeIdentity)),
        clearKnownTmuxHint: async identity => {
            if (identity.sessionId) {
                await tmuxRuntimeStore.removeKnown(identity.provider, identity.sessionId,
                    identity.workspaceScopeIdentity);
            }
        },
    });
    const directTerminalRestoreTask = timeBootstrapPhase('direct-terminal-restore', () =>
        aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals));
    const directTerminalRestoreOutcomeTask = directTerminalRestoreTask.then(
        () => ({ outcome: 'restored' as const }),
        error => ({ outcome: 'failed' as const, error }),
    );
    const tmuxRestoreTask = persistedInactiveRestoreTask.then(
        async (): Promise<'restored' | 'failed' | 'disposed'> => {
            try {
                resources.assertActive();
            } catch (_error) {
                return 'disposed';
            }
            try {
                await timeBootstrapPhase('tmux-attach-restore', () =>
                    tmuxRuntimeBackend.restoreAttachTerminals(vscode.window.terminals));
                return 'restored';
            } catch (error) {
                logAiSessionRuntimeFailure('restore-attach-terminals', error);
                return 'failed';
            }
        });
    // Persisted discovery and Direct restoration start concurrently. Runtime
    // recovery is always post-render work: process ID resolution, filesystem
    // scans, and a delayed Extension Host timer must never gate ready HTML.
    bootstrapPhaseTimings['tmux-restore-wait'] = 0;
    resources.assertActive();
    logDashboardDiagnostic({
        event: 'agent-pivot-bootstrap-tmux-restore-deferred',
        generation: bootstrapGeneration,
        budgetMs: 0,
    });
    const publishDeferredRuntimeRestore = (
        outcome: 'restored' | 'failed' | 'disposed',
    ): void => {
        try {
            resources.assertActive();
        } catch (_error) {
            return;
        }
        aiSessionAttentionEvent.setDeferredRestoreSettled();
        logDashboardDiagnostic({
            event: 'agent-pivot-bootstrap-tmux-restore-settled',
            generation: bootstrapGeneration,
            outcome,
        });
        publishDeferredTmuxRestoreIfReady();
    };
    void tmuxRestoreTask.then(
        publishDeferredRuntimeRestore,
        error => {
            logAiSessionRuntimeFailure('restore-attach-terminals', error);
            publishDeferredRuntimeRestore('failed');
        },
    );
    const aiSessionPinStore = new AiSessionPinStore(context.globalStoragePath);
    const aiSessionPinController = new AiSessionPinController({
        store: aiSessionPinStore,
        getSessionKey: getAiSessionPinKey,
        logError,
        showUpdateError: () => vscode.window.showErrorMessage('Could not update the pinned chat.'),
    });
    const aiSessionWorkspaceStateStore = new AiSessionWorkspaceStateStore(context.globalState, isAiSessionProviderId);
    const workspacePrimaryRootStore = new WorkspacePrimaryRootStore(context.globalState);
    let openWorkspaceController: OpenWorkspaceController;
    let openWorkspaceDashboardController: OpenWorkspaceDashboardController<vscode.Terminal>;
    let projectsPanelController: ProjectsPanelController | undefined;
    let workspaceNavigationController: WorkspaceNavigationController;
    let openWorkspacePinController: OpenWorkspacePinController;
    const resolveCurrentOpenWorkspace = (): OpenWorkspace | null => workspaceContextResolver.resolve({
        workspaceFile: vscode.workspace.workspaceFile,
        workspaceFolders: vscode.workspace.workspaceFolders,
        workspaceName: vscode.workspace.name,
        remoteName: vscode.env.remoteName,
    });
    const getCurrentOpenWorkspace = (): OpenWorkspace | null => openWorkspaceController
        ? openWorkspaceController.getCurrentWorkspace()
        : resolveCurrentOpenWorkspace();
    const worktreeBaseRefStore = new WorktreeBaseRefStore(context.globalState);
    const worktreeProvisioningStore = new WorktreeProvisioningStore(
        context.globalState,
        () => normalizeWorktreeDirectory(
            getAgentPivotConfiguration().get<unknown>('worktreeDirectory', '.worktrees'))
    );
    const worktreeSetupRunner = new WorktreeSetupRunner();
    const worktreeGroupManifestStore = new WorktreeGroupManifestStore(context.globalState);
    const gitWorktreeDiscovery = new GitWorktreeDiscovery({
        getBaseRef: repositoryKey => worktreeBaseRefStore.get(repositoryKey),
    });
    const getPriorityWorktreeKeys = (): import('./worktrees/types').WorktreeKey[] => [
        ...aiSessionRuntimeCoordinator.getActive(),
        ...aiSessionRuntimeCoordinator.getPending(),
    ].reduce((keys, runtime) => {
        const key = runtime.identity.worktreeKey;
        if (key && !keys.some(candidate => worktreeKeysEqual(candidate, key))) {
            keys.push({ ...key });
        }
        return keys;
    }, [] as import('./worktrees/types').WorktreeKey[]);
    const getWorktreePrioritySignature = (): string => JSON.stringify(
        getPriorityWorktreeKeys()
            .map(key => [key.repositoryKey, key.canonicalWorktreePath])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    );
    let requestedWorktreePrioritySignature = getWorktreePrioritySignature();
    const worktreeSnapshotCoordinator = ownResource(() =>
        new WorktreeSnapshotCoordinator({
            load: async () => {
                const loadStartedAt = Date.now();
                const workspace = getCurrentOpenWorkspace();
                const snapshot = await gitWorktreeDiscovery.discover({
                    workspaceRoots: workspace?.roots || [],
                    priorityWorktreeKeys: getPriorityWorktreeKeys(),
                });
                for (const repository of snapshot.repositories) {
                    if (repository.baseRef) {
                        try {
                            await worktreeBaseRefStore.rememberInitial(
                                repository.repositoryKey, repository.baseRef);
                        } catch (error) {
                            // Discovery remains usable when VS Code cannot
                            // persist the initial preference. A later refresh
                            // can retry without discarding the Git snapshot.
                            logError('Failed to remember the worktree base ref.', error);
                        }
                    }
                }
                // Reconcile against the workspace captured when this load
                // started: if the user switched workspaces mid-discovery,
                // this snapshot belongs to the old one and must not leak
                // into the new workspace's manifest bucket.
                if (workspace
                    && getCurrentOpenWorkspace()?.navigationIdentity
                        === workspace.navigationIdentity) {
                    try {
                        await reconcileWorktreeGroupManifest({
                            store: worktreeGroupManifestStore,
                            workspaceIdentity: workspace.navigationIdentity,
                            snapshot,
                            recoveryRecords: worktreeProvisioningStore.read(),
                            activeGroupMemberIds:
                                isolatedSessionController?.getActiveGroupMemberIds() || [],
                            onError: (message, error) => logError(message, error),
                        });
                        // Tombstones protect half-initialized worktrees from
                        // ready seeding; once the physical worktree is gone
                        // from the snapshot, the tombstone has served its
                        // purpose.
                        const snapshotPaths = new Set<string>();
                        const discoveredRepositories = new Set<string>();
                        for (const repository of snapshot.repositories) {
                            discoveredRepositories.add(repository.repositoryKey);
                            for (const worktree of repository.worktrees) {
                                snapshotPaths.add(
                                    `${worktree.key.repositoryKey} ${worktree.key.canonicalWorktreePath}`);
                            }
                        }
                        // Prune through the controller: it drops in-memory
                        // copies before the store write, so a queued
                        // replace can never resurrect a pruned tombstone.
                        await isolatedSessionController
                            ?.pruneTombstones(
                                snapshotPaths,
                                snapshot.truncatedWorktreeCount > 0,
                                loadStartedAt,
                                discoveredRepositories)
                            .catch(error => logError(
                                'Failed to prune provisioning tombstones.', error));
                    } catch (error) {
                        // Reconciliation is additive bookkeeping; discovery
                        // stays usable when persistence is unavailable.
                        logError('Failed to reconcile the worktree group manifest.', error);
                    }
                }
                return snapshot;
            },
            setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
            clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
        }));
    const gitRepositoryStateMonitor = ownResource(() =>
        new GitRepositoryStateMonitor({
            getApi: getVsCodeGitApiForWorktreeMonitoring,
            onDidChange: () => worktreeSnapshotCoordinator.invalidate('git-state'),
            onError: error => logError(
                'Failed to subscribe to Git repository state changes.', error),
        }));
    void gitRepositoryStateMonitor.start();
    const savedWorkspaceProjectAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: resolveCurrentOpenWorkspace,
        pendingStore: new PendingWorkspaceSaveStore(context.globalState),
        getProjectDetailsForSave: navigationUri =>
            currentProjectDetailsResolver.getProjectDetailsForSave(vscode.Uri.parse(navigationUri)),
        saveWorkspaceProject: details => projectMutationController.saveWorkspaceProject(details),
        executeSaveWorkspaceAs: () => Promise.resolve(
            vscode.commands.executeCommand('workbench.action.saveWorkspaceAs')
        ),
    });
    const workspacePendingSessionPromotionController =
        new WorkspacePendingSessionPromotionController<vscode.Terminal>({
            providers: aiSessionProviders,
            getSessionKey: getAiSessionKey,
            runtimeCoordinator: aiSessionRuntimeCoordinator,
            setAlias: (providerId, sessionId, alias) =>
                aiSessionAliasController.set(providerId, sessionId, alias),
            setSessionProfile: (providerId, pendingId, sessionId) =>
                aiSessionProfileController.settlePending(providerId, pendingId, sessionId),
            syncActiveRuntime: () => activeAiSessionTerminalHighlighter.sync(),
            evaluateExecution: () => evaluateAiSessionLifecycleTick(),
            scheduleRefresh: () => refreshAiSessionViewsIncrementally(),
            logDiagnostic: logAiSessionDiagnostic,
        });
    let isolatedSessionController: IsolatedSessionController | undefined;
    const workspaceSessionHydrationController = new WorkspaceSessionHydrationController<vscode.Terminal>({
        providers: aiSessionProviders,
        readCoordinator: aiSessionReadCoordinator,
        incrementalScanMaxFiles: AI_SESSION_INCREMENTAL_SCAN_MAX_FILES,
        getRefreshReason: () => currentAiSessionRefreshReason,
        getSessionComparableCwd: (providerId, session) =>
            getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders),
        getPinnedSessions: () => aiSessionPinController.getAll(),
        getAliases: () => aiSessionAliasController.getAll(),
        getProfiles: () => aiSessionProfileController.getAll(),
        getPendingProfiles: () => aiSessionProfileController.getPendingAll(),
        getProfileAvailability: () => aiSessionProfileController.getAvailability(),
        getQuickCreateProfile: () => {
            const decision = resolveDefaultCodexProfileDecision({
                getLastUsed: () => aiSessionProfileController.getLastUsed(),
                getCodexDefaultProfile: () => readCodexDefaultProfile(vscode.workspace),
                isCodexProfileFileAvailable: name => codexProfileFileExists(name),
            });
            return decision?.kind === 'profile' ? decision.name : undefined;
        },
        getQuickCreateProvider: scopeIdentity =>
            aiSessionWorkspaceStateStore.getQuickCreateProviders()[scopeIdentity],
        getSelectedSurface: scopeIdentity =>
            aiSessionWorkspaceStateStore.getSelectedSurfaces()[scopeIdentity],
        getProviderSelection: scopeIdentity => {
            const stored = aiSessionWorkspaceStateStore.getProviderSelections()[scopeIdentity];
            if (stored) {
                return stored;
            }
            const legacy = aiSessionWorkspaceStateStore.getActiveProviders()[scopeIdentity];
            return legacy
                ? { primaryProvider: legacy, selectedProviders: [legacy] }
                : undefined;
        },
        getExpanded: scopeIdentity => aiSessionWorkspaceStateStore.getExpandedWorkspaces().has(scopeIdentity),
        getProjectionSnapshot: () => aiSessionProjectionCoordinator.capture(),
        getProvisioningWorktrees: navigationIdentity =>
            isolatedSessionController?.getVisibleRows(navigationIdentity) || [],
        getWorktreeGroups: navigationIdentity =>
            worktreeGroupManifestStore.listGroups(navigationIdentity),
        onDidReadSessions: (workspace, sessionResults, reason) => {
            void workspacePendingSessionPromotionController.promote(
                workspace,
                sessionResults,
                reason
            );
        },
        logDiagnostic: logAiSessionDiagnostic,
    });
    const providerDirectoryCapability = new ProviderDirectoryCapabilityProbe({
        resolveExecutable: commandName => resolveAiProviderExecutable(commandName),
        run: (executable, args, options) => runBoundedAiProviderHelp(executable, args, options),
    }, message => outputChannel.appendLine(message));
    const {
        aiSessionCommandController,
        aiSessionCreationController,
        aiSessionArchiveController,
        aiSessionTerminalCommandController,
        aiSessionResumeController,
    } = createSessionControllerComposition({
        getCurrentWorkspaceActionTarget,
        getCurrentOpenWorkspace,
        getWorktreeSnapshot: () => worktreeSnapshotCoordinator.getSnapshot(),
        getWorktreeGroupPeerKeys: (navigationIdentity, key) => {
            const group = worktreeGroupManifestStore.findGroupByWorktreeKey(
                navigationIdentity, key);
            if (!group) {
                return null;
            }
            // Group sessions write every ready, non-detached member worktree
            // (PRD §5.5); the requested key's own path is covered by the
            // primary worktree bindings. Keys are revalidated against the
            // live snapshot and file system before entering the scope.
            return group.members
                .filter(member => member.state === 'ready' && !member.detached
                    && !!member.worktreeKey
                    && !worktreeKeysEqual(member.worktreeKey, key))
                .map(member => ({ ...member.worktreeKey! }));
        },
        isWorktreeGroupProvisioning: (navigationIdentity, key) => {
            const group = worktreeGroupManifestStore.findGroupByWorktreeKey(
                navigationIdentity, key);
            return !!group && group.members.some(member =>
                member.state === 'planned' || member.state === 'provisioning');
        },
        getRegisteredAiSessionProvider,
        getRegisteredAiSessionProviders,
        getAiSessionRuntimeById,
        getAiSessionRuntimeCollision,
        getLaunchOptions: () => readAiSessionLaunchOptions(vscode.workspace),
        aiSessionProfileController,
        getCodexDefaultProfile: () => readCodexDefaultProfile(vscode.workspace),
        getCodexProfileSupport: () => codexProfileSupportProbe.isSupported(),
        listCodexProfiles: () => listCodexConfigProfiles(process.env, os.homedir(), logError),
        isCodexProfileFileAvailable: name => codexProfileFileExists(name),
        openSettings: query => vscode.commands.executeCommand('workbench.action.openSettings', query),
        refreshAiSessionViewsIncrementally,
        scheduleNewAiSessionRefresh,
        logAiSessionRuntimeFailure,
        logError,
        getAiSessionPinKey,
        postBatchArchiveCompletion,
        aiSessionWorkspaceStateStore,
        workspacePrimaryRootStore,
        aiSessionPinController,
        aiSessionAliasController,
        aiSessionRuntimeCoordinator,
        aiSessionTerminalService,
        aiSessionReadCoordinator,
        aiSessionProviders,
        providerDirectoryCapability,
        syncActiveRuntime: () => activeAiSessionTerminalHighlighter.sync(),
        runSafeLifecycleTask: (operation, task) =>
            aiSessionRuntimeSettlement.runSafeLifecycleTask(operation, task),
        acknowledgeAttention: identity => acknowledgeAiSessionAttention(identity),
        postMessage: message => provider.postMessage(message),
        appendOutput: message => outputChannel.appendLine(message),
        getActiveEditorUri: () => vscode.window.activeTextEditor?.document.uri,
        isWorkspaceTrusted: () => (
            vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean }
        ).isTrusted !== false,
        showInputBox: options => vscode.window.showInputBox(options),
        showQuickPick: (items, quickPickOptions) => vscode.window.showQuickPick(items, quickPickOptions),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showWarningWithItems: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
        showModalWarning: (message, action) => vscode.window.showWarningMessage(message, { modal: true }, action),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        writeClipboard: value => vscode.env.clipboard.writeText(value),
        focusTerminalView: () => vscode.commands.executeCommand('workbench.action.terminal.focus'),
        nowMs: () => Date.now(),
    });
    const worktreeGroupProvisioner = new GitWorktreeProvisioner();
    isolatedSessionController = new IsolatedSessionController({
        provisioner: worktreeGroupProvisioner,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getWorktreeSnapshot: () => worktreeSnapshotCoordinator.getSnapshot(),
        getActiveEditorPath: () => vscode.window.activeTextEditor?.document.uri.fsPath,
        isProviderId: isAiSessionProviderId,
        isWorkspaceTrusted: () => (
            vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean }
        ).isTrusted !== false,
        showInputBox: options => vscode.window.showInputBox(options),
        showQuickPick: (items, quickPickOptions) =>
            vscode.window.showQuickPick(items, quickPickOptions),
        refreshWorktreeSnapshot: () => worktreeSnapshotCoordinator.refresh('provisioning'),
        getSetupCommand: () => normalizeWorktreeSetupCommand(
            getAgentPivotConfiguration().get<unknown>('worktreeSetupCommand', [])),
        getWorktreeDirectory: () => normalizeWorktreeDirectory(
            getAgentPivotConfiguration().get<unknown>('worktreeDirectory', '.worktrees')),
        runSetup: (_plan, worktreeKey, isCancelled, command) =>
            worktreeSetupRunner.run(command, worktreeKey.canonicalWorktreePath, isCancelled),
        publishRows: () => refreshAiSessionViewsIncrementally(),
        recoveredOperations: worktreeProvisioningStore.read(),
        persistOperations: operations => worktreeProvisioningStore.replace(operations),
        persistTombstones: records =>
            worktreeProvisioningStore.appendTombstones(records),
        pruneTombstones: (paths, truncated, startedAt, repositories) =>
            worktreeProvisioningStore.pruneTombstones(
                paths, truncated, startedAt, repositories),
        onPersistenceError: error => logError(
            'Could not persist isolated worktree provisioning recovery state.', error),
        recordProvisionedWorktree: async info => {
            const target = getCurrentWorkspaceActionTarget(info.projectId);
            if (!target) {
                const error = new Error('The workspace is unavailable for manifest recording.');
                (error as Error & { code?: string }).code = 'manifest-unavailable';
                throw error;
            }
            // Save Workspace As can reuse a legacy projectId for a different
            // workspace; never write the old operation into the new bucket.
            if (info.navigationIdentity
                && target.workspace.navigationIdentity !== info.navigationIdentity) {
                const error = new Error('The workspace changed since provisioning started.');
                (error as Error & { code?: string }).code = 'manifest-unavailable';
                throw error;
            }
            const bucket = target.workspace.navigationIdentity;
            // A completed provisioning clears any tombstone claiming the
            // worktree is half-initialized.
            isolatedSessionController?.removeTombstonesForWorktree(
                info.worktreeKey.repositoryKey,
                info.worktreeKey.canonicalWorktreePath);
            if (info.groupId && info.memberId) {
                // Group creation (M2): the group already exists with this
                // member planned; mark the member ready and apply the
                // confirmed primary choice once its member is ready.
                await worktreeGroupManifestStore.updateMember(
                    bucket, info.groupId, info.memberId, {
                        state: 'ready',
                        worktreeKey: info.worktreeKey,
                    });
                if (info.preferredPrimary) {
                    await worktreeGroupManifestStore.setPrimaryMember(
                        bucket, info.groupId, info.memberId);
                }
                return;
            }
            if (worktreeGroupManifestStore.findGroupByWorktreeKey(bucket, info.worktreeKey)) {
                return;
            }
            await worktreeGroupManifestStore.createGroup(bucket, {
                displayName: info.plan.taskName,
                suggestedSlug: info.plan.slug,
                members: [{
                    repositoryKey: info.plan.repositoryKey,
                    worktreeKey: info.worktreeKey,
                    branchName: info.plan.branchName,
                    path: info.worktreeKey.canonicalWorktreePath,
                    state: 'ready',
                }],
            });
        },
    });
    let managedWorktreeRemovalController: ManagedWorktreeRemovalController;
    let currentAiSessionRefreshReason = 'refresh';
    const worktreeGroupCreationController = new WorktreeGroupCreationController({
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getWorktreeSnapshot: () => worktreeSnapshotCoordinator.getSnapshot(),
        listLocalBranches: commandCwd =>
            worktreeGroupProvisioner.listLocalBranches(commandCwd),
        isBranchAvailable: (commandCwd, branchName) =>
            worktreeGroupProvisioner.isBranchAvailable(commandCwd, branchName),
        isPathAvailable: worktreePath =>
            worktreeGroupProvisioner.isPathAvailable(worktreePath),
        preflightPlan: plan => worktreeGroupProvisioner.preflightPlan(plan),
        // Resource-scoped per repository (PRD §6.1): a cross-repo group can
        // mix Node/Java/Go stacks, so each member reads its own folder's
        // setup override.
        getSetupCommand: repositoryKey => {
            const workspace = getCurrentOpenWorkspace();
            const repository = worktreeSnapshotCoordinator.getSnapshot()
                ?.repositories.find(candidate =>
                    candidate.repositoryKey === repositoryKey);
            const binding = repository?.rootBindings.find(candidate =>
                workspace?.roots.some(root => root.id === candidate.workspaceRootId));
            const root = workspace?.roots.find(candidate =>
                candidate.id === binding?.workspaceRootId);
            return normalizeWorktreeSetupCommand(
                getAgentPivotConfiguration(
                    root ? vscode.Uri.parse(root.uri) : undefined
                ).get<unknown>('worktreeSetupCommand', []));
        },
        getWorktreeDirectory: () => normalizeWorktreeDirectory(
            getAgentPivotConfiguration().get<unknown>('worktreeDirectory', '.worktrees')),
        getActiveEditorPath: () => vscode.window.activeTextEditor?.document.uri.fsPath,
        manifestStore: worktreeGroupManifestStore,
        startMemberOperation: input =>
            isolatedSessionController!.startGroupMember(input),
        retryMemberOperation: (operationId, projectId) =>
            isolatedSessionController!.retry(operationId, projectId),
        dismissMemberOperation: (operationId, projectId) =>
            isolatedSessionController!.dismiss(operationId, projectId),
        hasMemberOperation: operationId =>
            isolatedSessionController!.hasOperation(operationId),
        memberDismissNeedsTombstone: operationId =>
            isolatedSessionController!.memberDismissNeedsTombstone(operationId),
        isTombstoneStoreFull: () =>
            isolatedSessionController!.isTombstoneStoreFull(),
        writeSyntheticTombstone: input =>
            isolatedSessionController!.writeSyntheticTombstone(input),
        onDidChange: () => {
            void aiSessionDashboardController.refreshNow(
                'worktree-group-creation', { fallbackToFullRefresh: false });
        },
    });
    const notifyConfiguration = ownResource(() => createNotifyConfiguration({
        context,
        getConfiguration: () => getAgentPivotConfiguration(),
        configurationTargetGlobal: vscode.ConfigurationTarget.Global,
        homedir: () => os.homedir(),
        env: process.env,
        nowMs: () => Date.now(),
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        showWarningMessage: (message, messageOptions, ...items) =>
            vscode.window.showWarningMessage(message, messageOptions, ...items),
    }));
    const notifyOutput = notifyConfiguration.output;
    const notifyDispatcher = notifyConfiguration.dispatcher;
    await notifyConfiguration.refresh();
    ownResource(() => registerSponsorCommand());
    const locateAttentionSession = (key: string) => {
        const target = getCurrentWorkspaceActionTargetWithoutCardId();
        if (!target) {
            return null;
        }
        // settlement 路径的事件 key 是复合 attentionKey,先归一化为逻辑会话键再查。
        const logicalKey = getLogicalAttentionSessionKey(key);
        for (const provider of getRegisteredAiSessionProviders()) {
            for (const session of target.sessions.sessionsByProvider[provider.id] || []) {
                if (getAiSessionKey(provider.id, session.id) !== logicalKey) {
                    continue;
                }
                const runtime = getAiSessionRuntimeById(provider.id, session.id);
                if (!runtime) {
                    return null;
                }
                const root = target.workspace.roots.find(r => r.id === session.primaryRootId)
                    || target.workspace.roots[0];
                return { providerId: provider.id, session, runtime, rootPath: root?.hostPath || '' };
            }
        }
        return null;
    };
    let attentionStatusBarController: AttentionStatusBarController | undefined;
    const aiSessionAttentionController = new AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>({
        isEnabled: () => getAgentPivotConfiguration().get<boolean>('aiSessionAttention.enabled', true) !== false,
        getWorkspaceIdentity: () => getCurrentOpenWorkspace()?.scopeIdentity || null,
        getWorkspaceTarget: getCurrentWorkspaceActionTargetWithoutCardId,
        getProviders: getRegisteredAiSessionProviders,
        getRuntimeById: getAiSessionRuntimeById,
        publish: (items, forceHeartbeat) => aiSessionAttentionEvent.publish(items, forceHeartbeat),
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        onAttentionEvents: events => {
            for (const event of events) {
                const located = locateAttentionSession(event.key);
                if (!located) {
                    notifyOutput.log(`notify: dropped ${event.eventId} (session not found for key ${event.key})`);
                    continue;
                }
                notifyDispatcher.enqueue(buildNotifyPayload(event, {
                    providerId: located.providerId,
                    projectLabel: located.rootPath,
                    sessionLabel: located.session.name || located.session.id,
                    hostLabel: os.hostname(),
                    runStartedAtMs: located.runtime.runStartedAtMs,
                    projectPathMode: getAgentPivotConfiguration()
                        .get<'basename' | 'full'>('notify.projectPathMode', 'basename'),
                    includeSessionLabel: getAgentPivotConfiguration()
                        .get<boolean>('notify.includeSessionLabel', true),
                }));
            }
        },
        onAttentionAcknowledged: eventIds => notifyDispatcher.cancel(eventIds),
        onAttentionCancelled: eventIds => notifyDispatcher.cancel(eventIds),
        onEffectiveAggregateChanged: () => {
            attentionStatusBarController?.refresh(buildCurrentAttentionQueue());
            void conversationCapability?.viewer.publishSessionStatus();
        },
        nowMs: () => Date.now(),
    });
    const aiSessionExecutionController = new AiSessionExecutionController({
        getActiveSessions: () => aiSessionRuntimeCoordinator.getActive()
            .filter(runtime => runtimeBelongsToCurrentWorkspace(runtime)
                && runtime.state !== 'conflict' && Boolean(runtime.identity.sessionId))
            .map(runtime => ({
                provider: runtime.identity.provider,
                sessionId: runtime.identity.sessionId as string,
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                cwd: runtime.identity.cwd,
                runStartedAtMs: runtime.runStartedAtMs,
            })),
        getSessionKey: getAiSessionKey,
        scheduleRefresh: reason => {
            scheduleAiSessionRefresh(reason);
            if (openWorkspaceController) {
                openWorkspaceController.publish();
            }
        },
        nowMs: () => Date.now(),
    });
    aiSessionProjectionCoordinator = new AiSessionProjectionCoordinator<vscode.Terminal>({
        getWorktreeSnapshot: () => {
            const prioritySignature = getWorktreePrioritySignature();
            if (prioritySignature !== requestedWorktreePrioritySignature) {
                requestedWorktreePrioritySignature = prioritySignature;
                worktreeSnapshotCoordinator.invalidate('runtime-priority');
            }
            return worktreeSnapshotCoordinator.getSnapshot();
        },
        getActiveRuntimes: () => aiSessionRuntimeCoordinator.getActive(),
        getPendingRuntimes: () => aiSessionRuntimeCoordinator.getPending(),
        getExecutionSnapshot: () => aiSessionExecutionController.getSnapshot(),
        getFocusedIdentity: () => getFocusedAiSessionRuntimeIdentity(),
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
    });
    const aiSessionStatus = ownResource(() => createAiSessionStatusCapability({
        getProviders: getRegisteredAiSessionProviders,
        getLifecycleRequests: () => [
            aiSessionExecutionController.getLifecycleRequests(),
            aiSessionAttentionController.getLifecycleRequests(),
        ],
        evaluateExecution: signals => aiSessionExecutionController.evaluate(signals),
        evaluateAttentionSignals: signals => aiSessionAttentionController.evaluate([], signals),
        evaluateAttentionRuntimes: () => evaluateAiSessionAttention(),
        onFailure: () => logAiSessionDiagnostic({
            event: 'runtime-lifecycle-task-failed',
            operation: 'evaluate-attention-lifecycle-edge',
            category: 'unexpected',
        }),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    }));
    const evaluateAiSessionLifecycleTick = (): void => aiSessionStatus.tick();
    const aiSessionRuntimeSettlement = ownResource(() => createAiSessionRuntimeSettlementCapability({
        runtimeBelongsToCurrentWorkspace,
        evaluateAttention: evaluateAiSessionAttention,
        tmuxRuntimeDiscovery,
        aiSessionTerminalService,
        refreshAiSessionViewsIncrementally,
        syncActiveTerminalHighlighter: () => activeAiSessionTerminalHighlighter.sync(),
        logDiagnostic: logAiSessionDiagnostic,
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    }));
    const runSafeAiSessionRuntimeLifecycleTask = aiSessionRuntimeSettlement.runSafeLifecycleTask;
    const queueAiSessionRuntimeSettlements = aiSessionRuntimeSettlement.queueSettlements;
    aiSessionAttentionEvent.startBridgeClient();
    resources.own({
        dispose: () => {
            if (activeAiSessionAttentionBridgeClient === aiSessionAttentionEvent.bridgeClient) {
                activeAiSessionAttentionBridgeClient = null;
            }
        },
    });
    activeAiSessionAttentionBridgeClient = aiSessionAttentionEvent.bridgeClient;
    ownTimer(
        () => setTimeout(() => {
            void runSafeAiSessionRuntimeLifecycleTask(
                'evaluate-attention-startup', evaluateAiSessionAttention
            );
        }, 0),
        handle => clearTimeout(handle),
    );
    ownTimer(
        () => setTimeout(evaluateAiSessionLifecycleTick, 0),
        handle => clearTimeout(handle),
    );
    let conversationCapability: ConversationCapability;
    const aiSessionDashboardController = ownResource(() => new AiSessionDashboardController<
        AiSessionPresentationTransaction<vscode.Terminal>
    >({
        providerIds: aiSessionProviders.map(provider => provider.id),
        isVisible: () => provider.visible,
        invalidateCache: providerId => invalidateAiSessionCache(providerId),
        watchSessionChanges: (providerId, onDidChange) => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(onDidChange),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillPanel.getRecords(),
        getCards: projection => getOpenWorkspaceCards(projection),
        getRunningCardAnimation: () => getEffectiveRunningCardAnimation(getAgentPivotConfiguration()),
        getRunningIconAnimation: () => getEffectiveRunningIconAnimation(getAgentPivotConfiguration()),
        beginProjection: reason => {
            aiSessionAttentionController.invalidateWorkspaceTarget();
            currentAiSessionRefreshReason = reason;
            const transaction = aiSessionProjectionCoordinator.captureNext(
                getCurrentOpenWorkspace()
            );
            return transaction;
        },
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        logError,
        logDiagnostic: logAiSessionDiagnostic,
        afterRefresh: () => {
            currentAiSessionRefreshReason = 'refresh';
            void conversationCapability.reconcile();
        },
        debounceMs: AI_SESSION_REFRESH_DEBOUNCE_MS,
        watcherRefreshMinIntervalMs: AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS,
        newSessionRefreshDelaysMs: NEW_AI_SESSION_REFRESH_DELAYS_MS,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: handle => clearTimeout(handle),
    }));
    managedWorktreeRemovalController = new ManagedWorktreeRemovalController({
        getSnapshot: () => worktreeSnapshotCoordinator.getSnapshot(),
        isProjectTarget: projectId => !!getCurrentWorkspaceActionTarget(projectId),
        isActive: key => getPriorityWorktreeKeys().some(candidate =>
            worktreeKeysEqual(candidate, key)),
        isOpenWorkspace: key => (getCurrentOpenWorkspace()?.roots || []).some(root =>
            isWorkspaceHostPathContained(key.canonicalWorktreePath, root.hostPath)),
        isProvisioning: key => isolatedSessionController!.getRows().some(row =>
            row.repositoryKey === key.repositoryKey
            && row.proposedPath === key.canonicalWorktreePath),
        confirm: (message, action) => vscode.window.showWarningMessage(
            message, { modal: true }, action),
        getWorkspaceIdentity: projectId =>
            getCurrentWorkspaceActionTarget(projectId)?.workspace.navigationIdentity ?? null,
        refresh: async (removedKey, workspaceIdentity) => {
            // Retire the manifest member before any snapshot/view refresh:
            // the physical directory is already gone at this point, and a
            // failed retirement must surface as a partial outcome instead of
            // leaving a ghost group behind. The bucket identity was captured
            // when the removal started, so a workspace switch cannot divert it.
            if (workspaceIdentity) {
                const group = worktreeGroupManifestStore.findGroupByWorktreeKey(
                    workspaceIdentity, removedKey);
                const member = group?.members.find(candidate => candidate.worktreeKey
                    && worktreeKeysEqual(candidate.worktreeKey, removedKey));
                if (group && member) {
                    await worktreeGroupManifestStore.removeMember(
                        workspaceIdentity, group.groupId, member.memberId);
                }
            }
            await worktreeSnapshotCoordinator.refresh('managed-worktree-removed');
            const delivered = await provider.postMessage(
                aiSessionDashboardController.getUpdatedMessage('managed-worktree-removed'));
            if (!delivered) {
                throw new Error('Managed worktree refresh was not delivered.');
            }
        },
    });
    void directTerminalRestoreOutcomeTask.then(result => {
        if (result.outcome === 'restored') {
            try {
                resources.assertActive();
            } catch (_error) {
                return;
            }
            void aiSessionDashboardController.refreshNow(
                'direct-bootstrap-restore',
                { fallbackToFullRefresh: false },
            );
            return;
        }
        try {
            resources.assertActive();
        } catch (_error) {
            return;
        }
        logAiSessionRuntimeFailure(
            'restore-persisted-terminals', result.error, 'vscode'
        );
    });
    conversationCapability = ownResource(() => createConversationCapability({
        services: aiSessionServices,
        resolveTarget: (projectId, providerId, sessionId) => {
            const target = getCurrentWorkspaceActionTarget(projectId);
            const activeSessions = target?.sessions.activeSessions || [];
            const activeSession = activeSessions.find(session =>
                session.provider === providerId
                && session.sessionId === sessionId
            );
            if (activeSession) {
                return withConversationDisplayMetadata(
                    activeSession,
                    activeSessions
                );
            }
            // History rows resolve too (PRD §6.4): a session whose runtime
            // is gone — including one whose worktree was deleted — must
            // still open its read-only conversation. The viewer reads the
            // transcript from disk; it never needed a live runtime.
            const historySession = (
                target?.sessions.sessionsByProvider[providerId] || []
            ).find(session => session.id === sessionId);
            return historySession
                ? withConversationDisplayMetadata(
                    {
                        provider: providerId,
                        sessionId: historySession.id,
                        name: historySession.name,
                        focused: false,
                        executionState: 'stopped',
                    },
                    activeSessions
                )
                : null;
        },
        resolveActiveTargets: projectId =>
            getCurrentWorkspaceActionTarget(projectId)
                ?.sessions.activeSessions || [],
        resolveWorkspaceName: projectId =>
            getCurrentWorkspaceActionTarget(projectId)
                ?.workspace.displayName || '',
        getWorkspaceRootHostPaths: () =>
            getCurrentWorkspaceActionTargetWithoutCardId()
                ?.workspace.roots.map(root => root.hostPath) || [],
        publish: message => provider.postMessage(message),
        createPanel: vscode.window.createWebviewPanel,
        openExternal: vscode.env.openExternal,
        openLocalFile: async targetFile => {
            const position = new vscode.Position(
                targetFile.line - 1,
                targetFile.column - 1
            );
            await vscode.window.showTextDocument(
                vscode.Uri.file(targetFile.fsPath),
                { selection: new vscode.Range(position, position) }
            );
        },
        showWorktreeInSourceControl: (worktreeRoot: string) =>
            showWorktreeInSourceControl(worktreeRoot),
        insertIntoActiveTerminal: async text => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) {
                vscode.window.showWarningMessage(
                    'No active terminal is available to receive the selection.'
                );
                return;
            }
            await Promise.resolve(terminal.sendText(text, false));
            terminal.show();
        },
        spawnCodex: childProcess.spawn,
        now: () => Date.now(),
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        onDiagnostic: event => logAiSessionDiagnostic({ ...event }),
        commentStore: conversationViewerCommentStore,
        projectCommentStore,
        bookmarkStore: conversationViewerBookmarkStore,
        resolveReboundTarget: target =>
            conversationSessionRebindCoordinator.resolve(target),
        getShowThinking: () => getAgentPivotConfiguration()
            .get<unknown>('aiConversation.showThinking', false) === true,
        getCodexSessionProfileContextWindow: (sessionId, model) => {
            const decision = aiSessionProfileController.getDecision('codex', sessionId);
            if (decision?.kind === 'profile') {
                const declared = readCodexProfileContextWindow(decision.name);
                if (declared) {
                    return declared;
                }
            }
            // Sessions started outside the extension (e.g. codex CLI -p) have
            // no recorded decision: match their rollout model against the
            // profiles' declared models instead.
            return model
                ? readCodexProfileContextWindowForModel(model)
                : undefined;
        },
        readSessionStatus: () => ({
            runningSessions: sumOpenWorkspaceRunningAiSessionCounts(
                latestOpenWorkspaceAggregate
            ),
            attentionSessions: aiSessionAttentionController
                .getEffectiveAggregate()?.sessions.length ?? 0,
        }),
        submitPrompt: (viewerTarget, prompt) => submitConversationPrompt({
            getWorkspaceTarget: getCurrentWorkspaceActionTarget,
            getRuntime: getAiSessionRuntimeById,
            resume: (projectId, providerId, sessionId, rootId, resumePrompt) =>
                aiSessionResumeController.resumeProjectSession(
                    projectId,
                    providerId,
                    sessionId,
                    rootId,
                    resumePrompt
                ),
        }, viewerTarget, prompt),
        focusSession: viewerTarget =>
            aiSessionTerminalCommandController.focusActive(
                viewerTarget.projectId,
                viewerTarget.provider,
                viewerTarget.sessionId
            ),
        syncSession: viewerTarget =>
            aiSessionTerminalCommandController.focusActive(
                viewerTarget.projectId,
                viewerTarget.provider,
                viewerTarget.sessionId,
                { revealTerminal: false }
            ),
        setConversationFocusContext: focused =>
            vscode.commands.executeCommand(
                'setContext',
                'agentPivot.aiConversationFocus',
                focused
            ),
    }));
    followConversationSessionRebind = (previous, next) =>
        conversationCapability.rebindSession(previous, next);
    freezeConversationSessionMetadata = target =>
        conversationCapability.freezeSessionMetadata(target);
    resources.own(conversationPanelRestore.connectWhenReady(
        conversationCapability,
        Promise.all([
            directTerminalRestoreOutcomeTask,
            tmuxRestoreTask,
            conversationSessionRebindRestoreTask,
        ])
    ));
    const conversationHandlers = {
        'open-active-ai-session-conversation': async (e: Record<string, unknown>) => {
            if (e.version !== 1
                || (e.provider !== 'codex' && e.provider !== 'kimi' && e.provider !== 'claude')
                || typeof e.projectId !== 'string' || !e.projectId.trim()
                || typeof e.sessionId !== 'string' || !e.sessionId.trim()) {
                return;
            }
            await openAiSessionConversationWithFeedback({
                projectId: e.projectId,
                provider: e.provider,
                sessionId: e.sessionId,
            });
        },
    };
    const projectHandlers = createProjectMessageHandlers({
        projectService,
        projectOpenController,
        projectMutationController,
        projectOrderController,
        favoriteProjectController,
        projectRemovalController,
        groupCommandController,
        groupCollapseController,
        getWorkspaceNavigationController: () => workspaceNavigationController,
        getOpenWorkspacePinController: () => openWorkspacePinController,
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
        acknowledgeAiSessionAttentionEventIds,
        refreshAfterMutation: projectSurface.refreshAfterMutation,
        showWarningMessage: message => vscode.window.showWarningMessage(message),
    });

    const dashboardMessageHandlers = createDashboardMessageHandlers({
        postMessage: message => provider.postMessage(message),
        getStewardInfos: () => stewardInfos,
        projectService,
        promptDashboardController,
        getPromptTerminalCommandController: () => promptTerminalCommandController,
        aiSessionCommandController,
        aiSessionTerminalCommandController,
        conversationCapability,
        aiSessionArchiveController,
        acknowledgeAiSessionAttentionEventIds,
        logOpenWorkspaceDiagnostic,
        refreshStewardViews,
        onOpenWorkspacesRendererReady: () => {
            openWorkspaceDashboardController.invalidatePendingUpdates();
            void openWorkspaceDashboardController.postUpdated({
                fallbackToFullRefresh: false,
            });
        },
        requestActiveAiSessionTerminalHighlight: () => activeAiSessionTerminalHighlighter.request(),
        showAgentPivotSettings,
        showBridgeExtension: () => vscode.commands.executeCommand(
            'workbench.extensions.action.showExtensionsWithIds',
            ['hzcheng.agent-pivot-attention-ui-bridge'],
        ),
        showSponsorOptions,
        showWarningMessage: message => vscode.window.showWarningMessage(message),
    });
    const isolatedSessionHandlers = {
        'start-isolated-session': async (message: unknown) => {
            const request = parseIsolatedSessionRequest(message);
            if (!request || request.type !== 'start-isolated-session') {
                return;
            }
            await provider.postMessage(acceptedIsolatedSessionSettlement(request));
            const outcome = await isolatedSessionController!.start(
                request.requestId, request.projectId, request.sourceWorktree);
            await provider.postMessage(settledIsolatedSessionSettlement(request, outcome));
        },
        'retry-isolated-session': async (message: unknown) => {
            const request = parseIsolatedSessionRequest(message);
            if (!request || request.type !== 'retry-isolated-session') {
                return;
            }
            await provider.postMessage(acceptedIsolatedSessionSettlement(request));
            const outcome = await isolatedSessionController!.retry(
                request.operationId, request.projectId);
            await provider.postMessage(settledIsolatedSessionSettlement(request, outcome));
        },
        'cancel-isolated-session': async (message: unknown) => {
            const request = parseIsolatedSessionRequest(message);
            if (!request || request.type !== 'cancel-isolated-session') {
                return;
            }
            await provider.postMessage(acceptedIsolatedSessionSettlement(request));
            const accepted = isolatedSessionController!.cancel(
                request.operationId, request.projectId);
            await provider.postMessage(cancelledMutationSettlement(request, accepted));
        },
        'dismiss-isolated-session': async (message: unknown) => {
            const request = parseIsolatedSessionRequest(message);
            if (!request || request.type !== 'dismiss-isolated-session') {
                return;
            }
            await provider.postMessage(acceptedIsolatedSessionSettlement(request));
            const accepted = await isolatedSessionController!.dismiss(
                request.operationId, request.projectId);
            await provider.postMessage(cancelledMutationSettlement(request, accepted));
        },
        'open-worktree-group-form': async (message: unknown) => {
            const request = parseOpenWorktreeGroupFormRequest(message);
            if (!request) {
                return;
            }
            const repositories = await worktreeGroupCreationController
                .listRepositoryOptions(request.projectId);
            // Branch-from-here (PRD §6.1): resolve the seed worktree's
            // branch so the form can prefill the base-ref override.
            const seedWorktree = request.seedRepositoryKey
                && request.seedWorktreePath
                ? worktreeSnapshotCoordinator.getSnapshot()?.repositories
                    .find(candidate =>
                        candidate.repositoryKey === request.seedRepositoryKey)
                    ?.worktrees.find(candidate =>
                        candidate.key.canonicalWorktreePath
                            === request.seedWorktreePath)
                : undefined;
            await provider.postMessage({
                type: 'worktree-group-form-state',
                version: 1,
                projectId: request.projectId,
                ...(request.seedRepositoryKey && seedWorktree?.branchRef
                    ? {
                        seed: {
                            repositoryKey: request.seedRepositoryKey,
                            baseRef: seedWorktree.branchRef,
                        },
                    }
                    : {}),
                repositories,
            });
        },
        'preview-worktree-group': async (message: unknown) => {
            const request = parsePreviewWorktreeGroupRequest(message);
            if (!request) {
                return;
            }
            const preview = await worktreeGroupCreationController.preview(
                request.projectId, request.displayName, request.selections);
            await provider.postMessage({
                type: 'worktree-group-preview',
                version: 1,
                requestId: request.requestId,
                projectId: request.projectId,
                previewId: preview.previewId,
                slug: preview.slug,
                ...(preview.formError ? { formError: preview.formError } : {}),
                members: preview.members,
            });
        },
        'confirm-worktree-group': async (message: unknown) => {
            const request = parseConfirmWorktreeGroupRequest(message);
            if (!request) {
                return;
            }
            await provider.postMessage(
                acceptedWorktreeGroupCreationSettlement(request));
            // Every accepted request owes exactly one terminal settlement —
            // the webview keeps its confirm button pending until it lands.
            const result = await worktreeGroupCreationController.confirm({
                projectId: request.projectId,
                previewId: request.previewId,
                displayName: request.displayName,
                members: request.members,
                ...(request.primaryRepositoryKey
                    ? { primaryRepositoryKey: request.primaryRepositoryKey }
                    : {}),
            }).catch(error => {
                logError('Failed to confirm the worktree group creation.', error);
                return { kind: 'failed' as const, errorCode: 'unexpected-error' };
            });
            await provider.postMessage(
                settledWorktreeGroupCreationSettlement(request, result));
        },
        'retry-worktree-group-member': async (message: unknown) => {
            const request = parseWorktreeGroupMemberRequest(message);
            if (!request || request.type !== 'retry-worktree-group-member') {
                return;
            }
            await provider.postMessage(
                acceptedWorktreeGroupMemberSettlement(request));
            const outcome = await worktreeGroupCreationController.retryMember(
                request.projectId, request.groupId, request.memberId)
                .catch(error => {
                    logError('Failed to retry the worktree group member.', error);
                    return {
                        kind: 'failed' as const,
                        operationId: request.memberId,
                        errorCode: 'unexpected-error',
                    };
                });
            await provider.postMessage(settledWorktreeGroupMemberSettlement(
                request,
                outcome.kind === 'succeeded'
                    ? { kind: 'settled' }
                    : { kind: 'failed', errorCode: outcome.errorCode }));
        },
        'dismiss-worktree-group-member': async (message: unknown) => {
            const request = parseWorktreeGroupMemberRequest(message);
            if (!request || request.type !== 'dismiss-worktree-group-member') {
                return;
            }
            await provider.postMessage(
                acceptedWorktreeGroupMemberSettlement(request));
            const dismissed = await worktreeGroupCreationController.dismissMember(
                request.projectId, request.groupId, request.memberId)
                .catch(error => {
                    logError('Failed to dismiss the worktree group member.', error);
                    return 'unavailable' as const;
                });
            await provider.postMessage(settledWorktreeGroupMemberSettlement(
                request,
                dismissed === 'dismissed'
                    ? { kind: 'settled' }
                    : {
                        kind: 'failed',
                        errorCode: dismissed === 'store-full'
                            ? 'store-full' : 'dismiss-unavailable',
                    }));
        },
        'remove-managed-worktree': async (message: unknown) => {
            const request = parseManagedWorktreeRemovalRequest(message);
            if (!request) {
                return;
            }
            await provider.postMessage(acceptedManagedWorktreeRemovalSettlement(request));
            const outcome = await managedWorktreeRemovalController.remove(
                request.projectId,
                {
                    repositoryKey: request.repositoryKey,
                    canonicalWorktreePath: request.worktreePath,
                }
            );
            await provider.postMessage(
                settledManagedWorktreeRemovalSettlement(request, outcome));
        },
        'merge-worktree-groups': async (message: unknown) => {
            // Migration-suggested group → group merge (PRD §6.5): the webview
            // submits only the source group; the host stays authoritative by
            // re-deriving same-slug candidates and confirming via QuickPick.
            const request = (message && typeof message === 'object')
                ? message as { projectId?: unknown; sourceGroupId?: unknown }
                : {};
            if (typeof request.projectId !== 'string'
                || typeof request.sourceGroupId !== 'string'
                || !request.sourceGroupId) {
                return;
            }
            const target = getCurrentWorkspaceActionTarget(request.projectId);
            if (!target) {
                return;
            }
            const bucket = target.workspace.navigationIdentity;
            const groups = worktreeGroupManifestStore.listGroups(bucket);
            const source = groups.find(group => group.groupId === request.sourceGroupId);
            if (!source) {
                return;
            }
            const candidates = groups.filter(group =>
                group.groupId !== source.groupId
                && group.suggestedSlug === source.suggestedSlug);
            if (candidates.length === 0) {
                return;
            }
            type MergePick = vscode.QuickPickItem & { groupId: string };
            const picks: MergePick[] = candidates.map(group => ({
                label: group.displayName,
                description: group.members.map(member => member.branchName).join(' · '),
                groupId: group.groupId,
            }));
            const chosen = await vscode.window.showQuickPick(picks, {
                placeHolder: `Merge "${source.displayName}" into…`,
            });
            if (!chosen) {
                return;
            }
            try {
                await worktreeGroupManifestStore.mergeGroups(
                    bucket, chosen.groupId, source.groupId);
            } catch (error) {
                const code = (error as { code?: string })?.code || 'merge-failed';
                void vscode.window.showWarningMessage(
                    code === 'repository-conflict'
                        ? 'These groups cannot be merged: both contain a worktree of the same repository. Remove one of them first.'
                        : 'The groups could not be merged. Try again.');
                return;
            }
            void aiSessionDashboardController.refreshNow('worktree-groups-merged', {
                fallbackToFullRefresh: false,
            });
        },
        'set-worktree-group-primary': async (message: unknown) => {
            const request = parseSetWorktreeGroupPrimaryRequest(message);
            if (!request) {
                return;
            }
            // The webview keeps the button disabled from the accepted
            // settlement until a terminal one arrives: every accepted
            // request owes exactly one settled/failed settlement, because
            // the authoritative refresh alone is fire-and-forget.
            await provider.postMessage(acceptedWorktreeGroupPrimarySettlement(request));
            const target = getCurrentWorkspaceActionTarget(request.projectId);
            if (!target) {
                await provider.postMessage(settledWorktreeGroupPrimarySettlement(
                    request, { kind: 'failed', errorCode: 'workspace-unavailable' }));
                return;
            }
            try {
                await worktreeGroupManifestStore.setPrimaryMember(
                    target.workspace.navigationIdentity, request.groupId, request.memberId);
            } catch (error) {
                logError('Failed to set the worktree group primary member.', error);
                void vscode.window.showWarningMessage(
                    'Agent Pivot: could not set the primary worktree. Refresh the dashboard and try again.');
                const errorCode = (error as { code?: string })?.code || 'set-primary-failed';
                await provider.postMessage(settledWorktreeGroupPrimarySettlement(
                    request, {
                        kind: 'failed',
                        errorCode: /^[a-z0-9-]{1,64}$/.test(errorCode)
                            ? errorCode : 'set-primary-failed',
                    }));
                await aiSessionDashboardController.refreshNow(
                    'worktree-group-primary-failed', { fallbackToFullRefresh: false });
                return;
            }
            await provider.postMessage(settledWorktreeGroupPrimarySettlement(
                request, { kind: 'settled' }));
            await aiSessionDashboardController.refreshNow('worktree-group-primary-changed', {
                fallbackToFullRefresh: false,
            });
        },
    };

    const dashboardMessageRouter = createDashboardMessageRouter({
        getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id),
        saveCurrentWorkspace: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
        handlers: {
            ...conversationHandlers,
            ...todoPanel.handlers,
            ...projectHandlers,
            ...skillPanel.handlers,
            ...dashboardMessageHandlers,
            ...isolatedSessionHandlers,
        },
        createAiSession: async e => {
            const worktreeKey = Object.prototype.hasOwnProperty.call(e, 'worktreeKey')
                ? parseAiSessionCreationWorktreeKey(e.worktreeKey)
                : undefined;
            if (worktreeKey === null) {
                return;
            }
            await aiSessionCreationController.createSession(e.projectId as string, worktreeKey);
        },
        createAiSessionQuick: async e => {
            const providerId = e.provider as AiSessionProviderId;
            const worktreeKey = Object.prototype.hasOwnProperty.call(e, 'worktreeKey')
                ? parseAiSessionCreationWorktreeKey(e.worktreeKey)
                : undefined;
            if (worktreeKey === null) {
                return;
            }
            if (providerId && isAiSessionProviderId(providerId)) {
                await aiSessionCreationController.createSessionQuick(
                    e.projectId as string,
                    providerId,
                    undefined,
                    worktreeKey
                );
            }
        },
        resumeAiSession: async (e, providerId, rootId) => {
            await aiSessionResumeController.resumeProjectSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string,
                rootId || undefined
            );
        },
        archiveAiSession: async (e, providerId) => {
            await aiSessionArchiveController.archiveSession(
                e.projectId as string,
                providerId as AiSessionProviderId | null,
                e.sessionId as string
            );
        },
    });
    const providerOptions: AgentPivotViewProviderOptions = {
        getWebviewOptions: () => getDashboardWebviewOptions(context.extensionPath, vscode.Uri.file),
        renderContent: (webview, documentGeneration) => {
            const transaction = aiSessionProjectionCoordinator.captureNext(
                getCurrentOpenWorkspace()
            );
            const configuration = getAgentPivotConfiguration();
            const cards = getOpenWorkspaceCards(transaction);
            return getStewardContent(
                context,
                webview,
                projectService.getGroups(),
                stewardInfos,
                true,
                cards,
                openWorkspaceDashboardController.getState().otherWindows.status,
                documentGeneration,
                buildAiSessionPresentationState(
                    false,
                    transaction,
                    getRenderedCurrentWorkspaceNavigationIdentity(cards),
                    getEffectiveRunningCardAnimation(configuration),
                    getEffectiveRunningIconAnimation(configuration),
                ),
            );
        },
        renderError: getErrorContent,
        onMessage: message => messageRequiresStorageMigration(message)
            ? runAfterStorageMigration(() => dashboardMessageRouter(message))
            : dashboardMessageRouter(message),
        onVisibleChanged: async visible => {
            projectsPanelController?.invalidatePendingUpdates();
            openWorkspaceDashboardController?.invalidatePendingUpdates();
            setAiSessionWatchersActive(visible);
            worktreeSnapshotCoordinator.setVisible(visible);
            activeAiSessionTerminalHighlighter.setVisible(visible);
            aiSessionAttentionEvent.setDeferredRestoreRefreshReady(visible);
            publishDeferredTmuxRestoreIfReady();
            if (visible) {
                void tmuxFocusedRuntimeMonitor.request();
            }
            await dashboardRuntimeController.handleAiSessionViewVisibilityChanged(visible);
        },
        onVisiblePrepared: () =>
            aiSessionDashboardController.refreshNow('dashboard-visible', {
                fallbackToFullRefresh: false,
            }),
        onDisposed: () => {
            aiSessionAttentionEvent.setDeferredRestoreRefreshReady(false);
        },
        logError,
    };
    let openWorkspaceBridgeClient: OpenWorkspaceBridgeClient;
    let latestOpenWorkspaceAggregate: OpenWorkspaceAggregate | null = null;
    openWorkspaceController = new OpenWorkspaceController({
        getWorkspace: resolveCurrentOpenWorkspace,
        getRunningAiSessionCount: workspace => {
            const executionSnapshot = aiSessionExecutionController.getSnapshot();
            return aiSessionRuntimeCoordinator.getActive().filter(runtime => {
                const sessionId = runtime.identity.sessionId;
                return hasWorkspaceRuntimeContinuity(workspace, runtime)
                    && Boolean(sessionId)
                    && executionSnapshot[getAiSessionKey(
                        runtime.identity.provider,
                        sessionId as string,
                    )]?.state === 'running';
            }).length;
        },
        publishWorkspace: (workspace, followsFocusEvent) =>
            openWorkspaceBridgeClient.publish(workspace, followsFocusEvent),
    });
    const dashboardRuntimeController = new DashboardRuntimeController({
        isVisible: () => provider.visible,
        refreshProvider: () => {
            projectsPanelController?.invalidatePendingUpdates();
            openWorkspaceDashboardController?.invalidatePendingUpdates();
            provider.refresh();
        },
        logDashboardDiagnostic,
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        viewType: AGENT_PIVOT_DASHBOARD_VIEW_ID,
        publishOpenWorkspace: () => openWorkspaceController.publish(),
        getCurrentSavedProject: getSavedProjectForCurrentWorkspace,
        syncProjectColorToCurrentWindow: project => projectWindowColorService.syncProjectColorToCurrentWindow(project),
        postMessage: message => provider.postMessage(message),
        logError,
        refreshAiSessionRuntimes: (_reason, force) => aiSessionRuntimeCoordinator.refreshForHost(force),
        logAiSessionRuntimeFailure,
    });
    openWorkspaceDashboardController = new OpenWorkspaceDashboardController<vscode.Terminal>({
        getCurrentWorkspace: getCurrentOpenWorkspace,
        isWorkspaceSavedAsProject: workspace => Boolean(getSavedProjectForWorkspace(workspace)),
        getWorkspaceProjectColor: workspace => getSavedProjectForWorkspace(workspace)?.color || '',
        getWorkspaceProjectName: workspace => getSavedProjectForWorkspace(workspace)?.name || '',
        getCurrentWorkspaceAiSessions: (workspace, projection) =>
            workspaceSessionHydrationController.hydrate(workspace, projection),
        getCurrentWorkspaceSessionProjectId: identity =>
            currentWorkspaceSessionAuthority.getProjectId(identity),
        getAiSessionProjectionRevision: () => aiSessionProjectionCoordinator.capture().revision,
        beginAiSessionProjection: () => {
            const transaction = aiSessionProjectionCoordinator.captureNext(
                getCurrentOpenWorkspace()
            );
            return transaction;
        },
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillPanel.getRecords(),
        getCollapsed: () => Boolean(groupCollapseController.getOpenWorkspacesCollapsed()),
        getRunningCardAnimation: () => getEffectiveRunningCardAnimation(getAgentPivotConfiguration()),
        getRunningIconAnimation: () => getEffectiveRunningIconAnimation(getAgentPivotConfiguration()),
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
        getBridgeInstanceId: () => openWorkspaceBridgeClient.instanceId,
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        isVisible: () => provider.visible,
        logDiagnostic: logOpenWorkspaceDiagnostic,
        logError,
    });
    workspaceNavigationController = new WorkspaceNavigationController({
        getRecord: cardId => openWorkspaceDashboardController.getNavigationWorkspace(cardId),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        refresh: refreshStewardViews,
    });
    ownResource(() => worktreeSnapshotCoordinator.onDidChange(state => {
        if ((state.kind === 'ready' && !state.refreshing) || state.kind === 'error') {
            void aiSessionDashboardController.refreshNow('worktree-snapshot', {
                fallbackToFullRefresh: false,
            });
        }
    }));
    if (provider.visible) {
        worktreeSnapshotCoordinator.setVisible(true);
    } else {
        void worktreeSnapshotCoordinator.start();
    }
    // Restored provisioning rows were held back during construction; publish
    // them only now that every controller they refresh is initialized.
    isolatedSessionController?.publishRestoredRows();
    const buildCurrentAttentionQueue = (): AttentionQueue => {
        const target = getCurrentWorkspaceActionTargetWithoutCardId();
        let workspace: AttentionQueueWorkspace | null = null;
        if (target) {
            const sessions: AttentionQueueWorkspaceSession[] = [];
            for (const provider of getRegisteredAiSessionProviders()) {
                for (const session of
                    target.sessions.sessionsByProvider[provider.id] || []) {
                    sessions.push({
                        provider: provider.id,
                        id: session.id,
                        name: session.name,
                        primaryRootId: session.primaryRootId,
                    });
                }
            }
            workspace = {
                roots: target.workspace.roots.map(root => ({
                    id: root.id,
                    uri: root.uri,
                })),
                sessions,
            };
        }
        return buildAttentionQueue({
            aggregate: aiSessionAttentionController.getEffectiveAggregate(),
            workspace,
        });
    };
    attentionStatusBarController = ownResource(() =>
        createAttentionStatusBarController({
            isEnabled: () => getAgentPivotConfiguration()
                .get<boolean>('aiSessionAttention.enabled', true) !== false,
            command: 'agentPivot.nextAttentionSession',
            nowMs: () => Date.now(),
        })
    );
    const findAttentionNavigationCardId = (projectId: string): string | null => {
        for (const card of openWorkspaceDashboardController.getCards()) {
            if (card.kind !== 'navigation') {
                continue;
            }
            const record = openWorkspaceDashboardController
                .getNavigationWorkspace(card.id);
            if (record && record.roots.some(root =>
                getAttentionProjectKey(getAttentionProjectPath(root.uri)) === projectId)) {
                return card.id;
            }
        }
        return null;
    };
    const aiSessionMru = createAiSessionMruTracker({ now: () => Date.now() });
    const sessionNavigationCoordinator = createSessionNavigationCoordinator();
    const sessionNavigationFocusExecutor = createSessionNavigationFocusExecutor({
        getProjectId: () => getCurrentWorkspaceActionTargetWithoutCardId()?.cardId || null,
        focusActive: (projectId, provider, sessionId) =>
            aiSessionTerminalCommandController.focusActive(
                projectId,
                provider,
                sessionId,
            ),
        openConversation: request => openAiSessionConversationWithFeedback(request),
        onFocused: target =>
            aiSessionMru.record(target.provider, target.sessionId),
    });
    const jumpToNextAttentionSession = createAttentionQueueJumpHandler({
        navigationCoordinator: sessionNavigationCoordinator,
        buildQueue: buildCurrentAttentionQueue,
        navigateSession: (item, executionOptions) =>
            sessionNavigationFocusExecutor.execute(item, executionOptions),
        acknowledge: eventIds =>
            acknowledgeAiSessionAttentionEventIds(eventIds),
        shouldAcknowledge: () => getAgentPivotConfiguration()
            .get<boolean>('aiSessionAttention.clearOnNextSession', false) === true,
        requestRemoteFocus: item => {
            const cardId = findAttentionNavigationCardId(item.projectId);
            const record = cardId
                ? openWorkspaceDashboardController.getNavigationWorkspace(cardId)
                : null;
            return record
                ? openWorkspaceBridgeClient.requestAttentionFocus(
                    record.navigationIdentity,
                    {
                        projectId: item.projectId,
                        provider: item.provider,
                        sessionId: item.sessionId,
                    },
                )
                : Promise.resolve(false);
        },
        getCurrentIdentity: () => {
            const identity = getFocusedAiSessionIdentity();
            return identity?.sessionId
                ? { provider: identity.provider, sessionId: identity.sessionId }
                : null;
        },
        findNavigationCardId: findAttentionNavigationCardId,
        openNavigationCard: cardId =>
            workspaceNavigationController.open(cardId),
        showInformationMessage: message =>
            vscode.window.showInformationMessage(message),
        showWarningMessage: message =>
            vscode.window.showWarningMessage(message),
    });
    // MRU focus resolution must be completion- and visibility-independent:
    // the attention highlighter clears its identity when a turn completes or
    // the dashboard hides, which would starve the tracker. Resolve the active
    // terminal straight from the tmux focus binding and the runtime registry.
    const getFocusedAiSessionIdentity = (): AiSessionRuntimeIdentity | null => {
        const activeTerminal = vscode.window.activeTerminal;
        if (!activeTerminal) {
            return null;
        }
        const tmuxRuntime = tmuxRuntimeBackend.getFocusedRuntime(activeTerminal);
        if (tmuxRuntime?.identity.sessionId) {
            return tmuxRuntime.identity;
        }
        const direct = aiSessionRuntimeCoordinator.getActive().find(candidate =>
            candidate.backend === 'vscode'
                && candidate.terminal === activeTerminal
                && Boolean(candidate.identity.sessionId));
        return direct?.identity || null;
    };
    const requestRemoteAiSessionFocus = (navigationIdentity: string): Promise<boolean> => {
        const sourceNavigationIdentity = getCurrentOpenWorkspace()?.navigationIdentity;
        return sourceNavigationIdentity
            ? openWorkspaceBridgeClient.requestRunningFocus(
                navigationIdentity,
                sourceNavigationIdentity,
            )
            : Promise.resolve(false);
    };
    const runningSessionJumpHandler = createRunningSessionJumpHandler({
        navigationCoordinator: sessionNavigationCoordinator,
        buildQueue: () => buildRunningSessionQueue({
            localSessions: (getCurrentWorkspaceActionTargetWithoutCardId()
                ?.sessions.activeSessions || [])
                .filter(session => session.executionState === 'running'
                    && Boolean(session.sessionId))
                .map(session => ({
                    provider: session.provider,
                    sessionId: session.sessionId as string,
                    name: session.name,
                })),
            remoteWindows: openWorkspaceDashboardController.getCards()
                .filter(card => card.kind === 'navigation'
                    && card.runningSessionCount > 0)
                .map(card => ({
                    cardId: card.id,
                    navigationIdentity: card.navigationIdentity,
                    displayName: card.name,
                    runningSessionCount: card.runningSessionCount,
                })),
            selfNavigationIdentity: getCurrentOpenWorkspace()?.navigationIdentity,
        }),
        navigateSession: (item, executionOptions) =>
            sessionNavigationFocusExecutor.execute(item, {
            onFocused: () => {
                executionOptions.onFocused?.();
                // Re-showing an already-active terminal fires no focus event,
                // so successful Running jumps record into the MRU directly.
                aiSessionMru.record(item.provider, item.sessionId);
            },
            }),
        requestRemoteFocus: item =>
            requestRemoteAiSessionFocus(item.navigationIdentity),
        openNavigationCard: cardId =>
            workspaceNavigationController.open(cardId),
        showInformationMessage: message =>
            vscode.window.showInformationMessage(message),
        showWarningMessage: message =>
            vscode.window.showWarningMessage(message),
        getCurrentKey: () => {
            const identity = getFocusedAiSessionIdentity();
            return identity?.sessionId
                ? `session:${identity.provider}:${identity.sessionId}`
                : null;
        },
    });
    // Tmux window switches inside one attach terminal never fire VS Code
    // terminal focus events, so event-driven recording starves the tracker.
    // Sample the resolved focus instead: the tmux focused-runtime monitor
    // already polls every second, keeping this resolution fresh.
    ownResource(() => {
        let lastSampledKey: string | null = null;
        const handle = setInterval(() => {
            const identity = getFocusedAiSessionIdentity();
            const key = identity?.sessionId
                ? getAiSessionKey(identity.provider, identity.sessionId)
                : null;
            if (key !== lastSampledKey) {
                lastSampledKey = key;
                if (identity?.sessionId) {
                    aiSessionMru.record(identity.provider, identity.sessionId);
                }
            }
        }, 1000);
        return { dispose: () => clearInterval(handle) };
    });
    const aiSessionQuickSwitchHandlers = createAiSessionQuickSwitchHandlers({
        navigationCoordinator: sessionNavigationCoordinator,
        getLocalSessions: () => getCurrentWorkspaceActionTargetWithoutCardId()
            ?.sessions.activeSessions || [],
        getRemoteWindows: () => openWorkspaceDashboardController.getCards()
            .filter(card => card.kind === 'navigation'
                && card.runningSessionCount > 0)
            .map(card => ({
                cardId: card.id,
                navigationIdentity: card.navigationIdentity,
                displayName: card.name,
                runningSessionCount: card.runningSessionCount,
            })),
        getFocusedSessionKey: () => {
            const identity = getFocusedAiSessionIdentity();
            return identity?.sessionId
                ? getAiSessionKey(identity.provider, identity.sessionId)
                : null;
        },
        mru: aiSessionMru,
        showPick: async (items, placeHolder) => vscode.window.showQuickPick([...items], {
            placeHolder,
            matchOnDescription: true,
        }),
        navigateSession: (target, executionOptions) =>
            sessionNavigationFocusExecutor.execute(target, executionOptions),
        requestRemoteFocus: target =>
            requestRemoteAiSessionFocus(target.navigationIdentity),
        openNavigationCard: cardId =>
            workspaceNavigationController.open(cardId),
        showInformationMessage: message =>
            vscode.window.showInformationMessage(message),
        showWarningMessage: message =>
            vscode.window.showWarningMessage(message),
    });
    const switchWorktreeOrSession = createWorktreeOrSessionSwitchHandler({
        getWorkspaceTarget: getCurrentWorkspaceActionTargetWithoutCardId,
        showPick: async (items, placeHolder) => vscode.window.showQuickPick([...items], {
            placeHolder,
            matchOnDescription: true,
        }),
        focusSession: (projectId, provider, sessionId) =>
            aiSessionTerminalCommandController.focusActive(projectId, provider, sessionId),
        resumeSession: (projectId, provider, sessionId) =>
            aiSessionResumeController.resumeProjectSession(projectId, provider, sessionId),
        revealWorktree: async (navigationIdentity, key) => {
            await showAgentPivot();
            await provider.postMessage({
                type: 'reveal-workspace-worktree-requested',
                version: 1,
                navigationIdentity,
                repositoryKey: key.repositoryKey,
                canonicalWorktreePath: key.canonicalWorktreePath,
            });
        },
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
    });
    // The first paint happens after bootstrap settles (see the post-ready
    // startup timer below); earlier reads of the card projection are unsafe.
    const workspaceNavigationQuickPickController = new WorkspaceNavigationQuickPickController({
        getCards: () => openWorkspaceDashboardController.getCards(),
        getRecord: cardId => openWorkspaceDashboardController.getNavigationWorkspace(cardId),
        showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
        getProjectGroupName: workspace => {
            const project = getSavedProjectForWorkspace(workspace);
            if (!project) { return null; }
            const group = projectService.getGroups()
                .find(candidate => candidate.projects.some(entry => entry.id === project.id));
            return group ? group.groupName : null;
        },
        open: cardId => workspaceNavigationController.open(cardId),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
    });
    openWorkspaceBridgeClient = earlyOpenWorkspaceBridge.adopt({
        onAggregate: aggregate => {
            latestOpenWorkspaceAggregate = aggregate;
            const statusChanged = openWorkspaceDashboardController.setBridgeStatus('ready');
            if (openWorkspaceDashboardController.setAggregate(aggregate) || statusChanged) {
                postOpenWorkspacesUpdated();
            }
            void conversationCapability.viewer.publishSessionStatus();
        },
        onError: error => logOpenWorkspaceBridgeError(error),
        onStatusChange: status => {
            if (openWorkspaceDashboardController.setBridgeStatus(status)) {
                postOpenWorkspacesUpdated();
            }
        },
        onPinSnapshot: snapshot => {
            if (openWorkspaceDashboardController.setPinSnapshot(snapshot)) {
                postOpenWorkspacesUpdated();
            }
        },
        onRunningFocusRequest: request =>
            runningSessionJumpHandler.jumpToNextLocalRunningSession(request),
        onAttentionFocusRequest: request =>
            jumpToNextAttentionSession.jumpToAttentionSession({
                projectId: request.projectId,
                provider: request.provider,
                sessionId: request.sessionId,
            }),
    });
    // The client outlives this generation, so a disposed bootstrap only stops
    // delivery to these handlers; it must not shut the bridge down.
    resources.own({ dispose: () => earlyOpenWorkspaceBridge.release() });
    // The publication built before bootstrap carried no AI session count.
    openWorkspaceController.publish();
    openWorkspacePinController = new OpenWorkspacePinController({
        getNavigationIdentity: cardId =>
            openWorkspaceDashboardController.getPinNavigationIdentity(cardId),
        setPinned: (requestId, navigationIdentity, pinned) =>
            openWorkspaceBridgeClient.setPinned(requestId, navigationIdentity, pinned),
        publishAuthoritativeUpdate: async () => {
            openWorkspaceDashboardController.invalidatePendingUpdates();
            await openWorkspaceDashboardController.postUpdated();
        },
        postMessage: message => provider.postMessage(message),
        showError: message => vscode.window.showErrorMessage(message),
        logError,
    });
    const activeAiSessionTerminalHighlighter = ownResource(() =>
        new ActiveAiSessionTerminalHighlighter<
        vscode.Terminal,
        AiSessionTerminalEntry<vscode.Terminal>
    >({
        isVisible: () => provider.visible,
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        resolveTerminal: terminal => aiSessionTerminalService.resolveTerminalSession(
            terminal,
            providerId => getAiSessionTerminalCandidates(providerId, aiSessionReadCoordinator)
        ),
        isComplete: resolution => aiSessionTerminalService.isComplete(resolution.entry),
        publish: () => postActiveAiSessionTerminalChanged(),
        onComplete: resolution => {
            if (!resolution.entry.runtimeIdentity) {
                return;
            }
            queueAiSessionRuntimeSettlements([{
                identity: cloneAiSessionRuntimeIdentity(resolution.entry.runtimeIdentity),
                backend: 'vscode',
                state: 'completed',
                markerPath: resolution.entry.markerPath,
                runStartedAtMs: resolution.entry.runStartedAtMs,
                attached: true,
                terminal: resolution.terminal,
            }]);
        },
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    }));
    const tmuxFocusedRuntimeMonitor = ownResource(() =>
        new TmuxFocusedRuntimeMonitor<vscode.Terminal>({
        isVisible: () => provider.visible,
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        syncFocusedRuntime: terminal => tmuxRuntimeBackend.syncFocusedRuntime(terminal),
        refresh: refreshAiSessionViewsIncrementally,
        onError: error => logAiSessionRuntimeFailure('sync-focused-runtime', error),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    }));
    tmuxFocusedRuntimeMonitor.start();
    publishRestoredTmuxAttachTerminal = refreshAiSessionViewsIncrementally;
    aiSessionRuntimeSettlement.startSettlementScan();

    ownResource(() => aiSessionAttentionEvent.registerTerminalEventHandlers());

    const stewardInfos: StewardInfos = {
        relevantExtensionsInstalls: {
            remoteSSH: false,
            remoteContainers: false,
        },
        get config() { return getAgentPivotConfiguration() },
        get otherStorageHasData() { return projectService.otherStorageHasData() },
        get favoritesGroupCollapsed() { return groupCollapseController.getFavoritesCollapsed() },
        get openWorkspacesGroupCollapsed() { return groupCollapseController.getOpenWorkspacesCollapsed() },
        get todoSearchItems() { return todoService.getSearchItems() },
        get skills() { return skillPanel.getRecords() },
    };
    projectsPanelController = new ProjectsPanelController({
        getGroups: () => projectService.getGroups(),
        getSearchCatalog: () => buildWorkspaceDashboardSearchCatalog(
            projectService.getGroups(),
            getOpenWorkspaceCards(),
            todoService.getSearchItems(),
            skillPanel.getRecords(),
        ),
        renderHtml: groups => getProjectsPanelContent(groups, stewardInfos),
        postMessage: message => provider.postMessage(message),
        refresh: reason => dashboardRuntimeController.refresh(reason),
        isVisible: () => provider.visible,
        logError,
    });
    const dashboardStartupController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: RelevantExtensions,
        isExtensionInstalled: extensionId => vscode.extensions.getExtension(extensionId) !== undefined,
        assertActive: () => resources.assertActive(),
        migrateDataIfNeeded: async () => {
            const projectMigration = settleMigration(() => projectService.migrateDataIfNeeded());
            const todoMigration = settleMigration(() => todoService.migrateDataIfNeeded());
            if (storageMigrationSettled) {
                todoPanel.setStorageMigrationReady(todoMigration.then(() => undefined));
            }
            const [projects, todos] = await Promise.all([projectMigration, todoMigration]);
            settleStorageMigration(true);
            return { projects, todos };
        },
        refreshDashboard: () => provider.refresh(),
        publishOpenWorkspace: () => openWorkspaceController.publish(),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logError,
        showAgentPivot,
        applyProjectColorToCurrentWindow: projectSurface.applyProjectColorToCurrentWindow,
        getReopenReason: () => context.globalState.get(REOPEN_KEY),
        updateReopenReason: reason => context.globalState.update(REOPEN_KEY, reason),
        reopenNoneValue: ReopenStewardReason.None,
        getWorkspaceName: () => vscode.workspace.name,
        getVisibleEditorLanguageIds: () => vscode.window.visibleTextEditors.map(editor => editor.document.languageId),
        afterProjectMigrationSucceeded: async () => {
            try {
                await savedWorkspaceProjectAdapter.completePendingWorkspaceSave();
            } catch (error) {
                logError('Could not complete the pending workspace save.', error);
            }
        },
    });
    const dashboardLifecycleController = new DashboardLifecycleController({
        prepareConfigurationChange: async event => {
            if (event.affectsConfiguration(
                `${AGENT_PIVOT_CONFIG_SECTION}.skills.globalStorePath`,
            )) {
                await skillPanel.handleGlobalStoreConfigurationChange();
            }
            if (event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTerminalMode`)
                || event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTmuxLayout`)
                || event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTmuxPath`)) {
                await handleAiSessionRuntimeConfigurationChanged();
            }
            if (event.affectsConfiguration(
                `${AGENT_PIVOT_CONFIG_SECTION}.aiConversation.showThinking`
            )) {
                await conversationCapability.viewer.refreshPresentation();
            }
        },
        checkDataMigration: async openStewardAfterMigrate => {
            await dashboardStartupController.checkDataMigration(openStewardAfterMigrate);
        },
        reconcileProjectCatalog: () => projectService.reconcileProjectCatalog(),
        consumeTodoDataWriteEcho: () => todoService.consumeCurrentSettingsDataLocalWriteEcho(),
        consumeProjectCatalogWriteEcho: change =>
            projectService.consumeProjectCatalogWriteEcho(change),
        consumePromptDataWriteEcho: () =>
            promptService.consumeCurrentSettingsDataLocalWriteEcho(),
        applyProjectColorToCurrentWindow: projectSurface.applyProjectColorToCurrentWindow,
        refresh: refreshStewardViews,
        refreshProjects: () => projectSurface.postProjectSurfacesUpdated('replace'),
        refreshPrompts: () => {
            void provider.postMessage(promptDashboardController.getRefreshContent());
        },
        publishOpenWorkspace: followsFocusEvent => openWorkspaceController.publish(followsFocusEvent),
        evaluateAiSessionAttention: () => runSafeAiSessionRuntimeLifecycleTask(
            'evaluate-attention-window-state', evaluateAiSessionAttention
        ),
        assertActive: () => resources.assertActive(),
        logError,
    });
    const activeTerminalFileReferenceController = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => vscode.window.activeTextEditor,
        getActiveTerminal: () => vscode.window.activeTerminal,
        asRelativePath: uri => vscode.workspace.asRelativePath(uri as vscode.Uri, false),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
    });
    const promptTerminalCommandController = new PromptTerminalCommandController({
        service: promptService,
        getActiveTerminal: () => vscode.window.activeTerminal,
        isTerminalAvailable: terminal =>
            vscode.window.terminals.indexOf(terminal as vscode.Terminal) >= 0,
        showQuickPick: async (items, options) => vscode.window.showQuickPick<{
            label: string;
            description: string;
            promptId: string;
        }>([...items], options),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showInformationMessage: async (message, action) => vscode.window.showInformationMessage(message, action),
        openAiPrompts: async () => {
            await showAgentPivot();
            await provider.postMessage({
                type: 'select-dashboard-tab',
                version: 1,
                tab: 'ai',
                aiSubtab: 'prompts',
            });
        },
    });

    const commandHandlers = {
        open: () => showAgentPivot(),
        addProject: () => runAfterStorageMigration(() => projectMutationController.addProject()),
        saveProject: () => runAfterStorageMigration(() => savedWorkspaceProjectAdapter.saveCurrentWorkspace()),
        removeProject: () => runAfterStorageMigration(() => projectRemovalController.removeProjectPerCommand()),
        editProjects: () => runAfterStorageMigration(() => projectManualEditController.editProjectsManually()),
        addGroup: () => runAfterStorageMigration(() => groupCommandController.addGroup()),
        removeGroup: () => runAfterStorageMigration(() => groupCommandController.removeGroupPerCommand()),
        addProjectsFromFolder: () => runAfterStorageMigration(
            () => addProjectsFromFolderController.addProjectsFromFolder()
        ),
        addFileToActiveTerminal: () => activeTerminalFileReferenceController.addFileToActiveTerminal(),
        insertPromptToActiveTerminal: () => promptTerminalCommandController.insertPromptToActiveTerminal(),
        migrateSkillsToCentral: () => skillPanel.migrateToCentral(),
        changeGlobalSkillsLocation: () =>
            skillPanel.changeGlobalStoreLocation(),
        openCurrentAiSessionConversation: () => openCurrentAiSessionConversation(),
        seekLatestConversationInteraction: () => seekLatestConversationInteractionWithFeedback(),
        previousActiveSession: () => sessionNavigationCoordinator.enqueue(
            () => followAdjacentActiveConversationWithFeedback('previous')
        ),
        nextActiveSession: () => sessionNavigationCoordinator.enqueue(
            () => followAdjacentActiveConversationWithFeedback('next')
        ),
        nextAttentionSession: async () => {
            await jumpToNextAttentionSession();
            revealFocusedAiSessionInDashboard();
        },
        nextRunningSession: async () => {
            await runningSessionJumpHandler.jumpToNextRunningSession();
            revealFocusedAiSessionInDashboard();
        },
        switchToAiSession: async () => {
            await aiSessionQuickSwitchHandlers.switchToAiSession();
            revealFocusedAiSessionInDashboard();
        },
        switchWorktreeOrSession: () => switchWorktreeOrSession(),
        toggleLastAiSession: async () => {
            await aiSessionQuickSwitchHandlers.toggleLastAiSession();
            revealFocusedAiSessionInDashboard();
        },
        switchToOpenWindow: () => workspaceNavigationQuickPickController.pickAndOpen(),
    };

    ownResource(() => vscode.workspace.onDidChangeConfiguration(
        event => dashboardLifecycleController.handleConfigurationChange(event)
    ));

    ownResource(() => vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.notify`)) {
            void notifyConfiguration.refresh();
        }
    }));

    ownResource(() => vscode.workspace.onDidChangeWorkspaceFolders(() => {
        worktreeSnapshotCoordinator.invalidate('workspace-roots');
        dashboardLifecycleController.handleWorkspaceFoldersChanged();
    }));

    ownResource(() => vscode.window.onDidChangeWindowState(windowState => {
        dashboardLifecycleController.handleWindowStateChanged(windowState);
    }));

    bootstrapPhaseTimings['startup-sequence'] = 0;
    const orderedBootstrapPhaseTimings: Record<string, number> = {};
    for (const phase of DASHBOARD_BOOTSTRAP_PHASE_ORDER) {
        if (Object.prototype.hasOwnProperty.call(bootstrapPhaseTimings, phase)) {
            orderedBootstrapPhaseTimings[phase] = bootstrapPhaseTimings[phase];
        }
    }
    logDashboardDiagnostic({
        event: 'agent-pivot-bootstrap-phases',
        generation: bootstrapGeneration,
        phases: orderedBootstrapPhaseTimings,
    });
    if (!dashboardCommandRegistration.stage(bootstrapGeneration, commandHandlers)) {
        throw new Error('Agent Pivot dashboard commands rejected the bootstrap generation.');
    }
    resources.own({
        dispose: () => dashboardCommandRegistration.discard(bootstrapGeneration),
    });
    ownTimer(
        () => setTimeout(() => {
            void timeBootstrapPhase('startup-sequence', () =>
                dashboardStartupController.startUp()).then(
                () => {
                    try {
                        resources.assertActive();
                    } catch (_error) {
                        return;
                    }
                    attentionStatusBarController.refresh(
                        buildCurrentAttentionQueue()
                    );
                    logDashboardDiagnostic({
                        event: 'agent-pivot-post-ready-startup-settled',
                        generation: bootstrapGeneration,
                        durationMs: bootstrapPhaseTimings['startup-sequence'],
                    });
                },
                error => {
                    try {
                        resources.assertActive();
                    } catch (_error) {
                        return;
                    }
                    logError('Failed to complete Agent Pivot post-ready startup.', error);
                },
            );
        }, 0),
        handle => clearTimeout(handle),
    );
    return providerOptions;

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ Functions ~~~~~~~~~~~~~~~~~~~~~~~~~
    function logAiSessionRuntimeFailure(
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux' = 'tmux'
    ): void {
        const detail = error instanceof TmuxRuntimeUnavailableError
            ? { category: error.reason }
            : error instanceof TmuxClientError
                ? { category: error.category, tmuxOperation: error.operation }
                : { category: 'unexpected' };
        logAiSessionDiagnostic({
            event: 'tmux-runtime-failure',
            operation,
            backend,
            ...detail,
        });
    }

    async function chooseAiSessionTmuxFallback(
        fallback: AiSessionTmuxFallbackContext
    ): Promise<'direct' | 'direct-anyway' | 'settings' | 'cancel'> {
        logAiSessionRuntimeFailure(`${fallback.operation}-fallback`, fallback.error);
        const openSettingsAction = 'Open Settings';
        if (fallback.knownHint) {
            const directAction = 'Resume in VS Code Anyway';
            const choice = await vscode.window.showWarningMessage(
                'Agent Pivot cannot verify the previous tmux runtime. Resuming in VS Code may start a duplicate AI process.',
                { modal: true },
                directAction,
                openSettingsAction
            );
            if (choice === openSettingsAction) {
                await showAgentPivotSettings();
                return 'settings';
            }
            return choice === directAction ? 'direct-anyway' : 'cancel';
        }

        const directAction = 'Use VS Code Terminal This Time';
        const choice = await vscode.window.showWarningMessage(
            'Agent Pivot cannot use tmux in this extension host.',
            directAction,
            openSettingsAction
        );
        if (choice === openSettingsAction) {
            await showAgentPivotSettings();
            return 'settings';
        }
        return choice === directAction ? 'direct' : 'cancel';
    }

    async function handleAiSessionRuntimeConfigurationChanged(): Promise<void> {
        const nextConfiguration = readAiSessionRuntimeConfiguration(getAgentPivotConfiguration());
        const pathChanged = nextConfiguration.tmuxPath !== aiSessionRuntimeConfiguration.tmuxPath;
        aiSessionRuntimeConfiguration = nextConfiguration;
        // Reapplying the executable also clears the client's cached availability probe.
        tmuxClient.setExecutablePath(nextConfiguration.tmuxPath);
        tmuxRuntimeDiscovery.invalidate();
        logAiSessionDiagnostic({
            event: 'runtime-configuration-changed',
            mode: nextConfiguration.mode,
            layout: nextConfiguration.tmuxLayout,
            pathChanged,
        });
        try {
            await aiSessionRuntimeCoordinator.refreshForHost(true);
        } catch (error) {
            logAiSessionRuntimeFailure('configuration-refresh', error);
        }
    }

    async function openCurrentAiSessionConversation(): Promise<void> {
        const target = getCurrentWorkspaceActionTargetWithoutCardId();
        if (!target) {
            void vscode.window.showInformationMessage(
                'Agent Pivot: no current workspace with AI sessions.'
            );
            return;
        }
        const candidates = target.sessions.activeSessions
            .filter(session => session.sessionId);
        if (!candidates.length) {
            void vscode.window.showInformationMessage(
                'Agent Pivot: no active AI session in the current workspace.'
            );
            return;
        }
        let selected = candidates.find(session => session.focused);
        if (!selected && candidates.length === 1) {
            selected = candidates[0];
        }
        if (!selected) {
            const picked = await vscode.window.showQuickPick(
                candidates.map(session => ({
                    label: session.name || session.sessionId as string,
                    description: session.provider,
                    session,
                })),
                { placeHolder: 'Select an AI session to open its conversation' }
            );
            selected = picked?.session;
        }
        if (!selected?.sessionId) {
            return;
        }
        const terminalAuthoritative = selected.focused === true;
        await openAiSessionConversationWithFeedback({
            projectId: target.cardId,
            provider: selected.provider,
            sessionId: selected.sessionId,
        }, terminalAuthoritative);
    }

    async function seekLatestConversationInteractionWithFeedback(): Promise<void> {
        const viewer = conversationCapability.viewer;
        if (!viewer.isOpen()) {
            void vscode.window.showInformationMessage(
                'Agent Pivot: open an AI Conversation editor to seek to the latest interaction.'
            );
            return;
        }
        viewer.focus();
        await viewer.navigateLatest();
    }

    async function openAiSessionConversationWithFeedback(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }, terminalAuthoritative = false): Promise<boolean> {
        const result = terminalAuthoritative
            ? await conversationCapability.openLatestActiveConversation(target)
            : await conversationCapability.openLatestConversation(target);
        if (result === 'empty') {
            void vscode.window.showInformationMessage(
                'Agent Pivot: this AI session has no conversation yet.'
            );
        } else if (result === 'unknownSession') {
            void vscode.window.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
        } else if (result === 'unavailable') {
            void vscode.window.showWarningMessage(
                'Agent Pivot: unable to read the AI session conversation.'
            );
        }
        return result === 'opened';
    }

    // After a command-driven session switch, make the sidebar follow the
    // session: the webview reveals it inside its worktree group or the Chats
    // active list, scrolling it into view without stealing keyboard focus.
    function revealAiSessionInDashboard(
        providerId: AiSessionProviderId,
        sessionId: string
    ): void {
        const currentCard = getOpenWorkspaceCards().find(candidate => candidate.kind === 'current');
        if (!currentCard || !sessionId) {
            return;
        }
        void provider.postMessage({
            type: 'reveal-ai-session-requested',
            version: 1,
            projectId: currentCard.id,
            provider: providerId,
            sessionId: sessionId,
        });
    }

    function revealFocusedAiSessionInDashboard(): void {
        const identity = getFocusedAiSessionIdentity();
        if (identity?.sessionId) {
            revealAiSessionInDashboard(identity.provider, identity.sessionId);
        }
    }

    async function followAdjacentActiveConversationWithFeedback(
        direction: 'previous' | 'next'
    ): Promise<void> {
        const result = await conversationCapability
            .followAdjacentActiveConversation(direction);
        if (result === 'opened') {
            const identity = getFocusedAiSessionIdentity();
            if (identity?.sessionId) {
                aiSessionMru.record(identity.provider, identity.sessionId);
                revealAiSessionInDashboard(identity.provider, identity.sessionId);
            }
        } else if (result === 'inactive' || result === 'closed') {
            void vscode.window.showInformationMessage(
                'Agent Pivot: open an AI Conversation editor to switch active sessions.'
            );
        } else if (result === 'noAdjacentSession') {
            void vscode.window.showInformationMessage(
                'Agent Pivot: no other active AI session is available.'
            );
        } else if (result === 'empty') {
            void vscode.window.showInformationMessage(
                'Agent Pivot: the adjacent AI session has no conversation yet.'
            );
        } else if (result === 'unknownSession') {
            void vscode.window.showWarningMessage(
                'Agent Pivot: the adjacent AI session is no longer active.'
            );
        } else if (result === 'unavailable') {
            void vscode.window.showWarningMessage(
                'Agent Pivot: unable to switch AI Conversation sessions.'
            );
        }
    }

    function getAiSessionTmuxAttachTerminalName(
        runtime: AiSessionRuntimeSnapshot
    ): string | undefined {
        const workspace = getCurrentOpenWorkspace();
        const currentCard = getOpenWorkspaceCards().find(candidate => candidate.kind === 'current');
        if (runtime.tmux?.layout === 'project') {
            return boundedAiSessionTmuxTitle(
                `Agent Pivot: ${workspace?.displayName || 'AI Workspace'} [tmux]`
            );
        }
        const sessionId = runtime.identity.sessionId;
        const session = currentCard?.aiSessions && sessionId
            ? (currentCard.aiSessions.sessionsByProvider[runtime.identity.provider] || [])
                .find(candidate => candidate.id === sessionId)
            : undefined;
        return session
            ? boundedAiSessionTmuxTitle(
                `Agent Pivot: ${getProviderAiSessionTerminalName(
                    runtime.identity.provider, session, aiSessionProviders
                )} [tmux]`
            )
            : undefined;
    }

    function boundedAiSessionTmuxTitle(value: string): string {
        return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    }

    async function showAgentPivot() {
        await dashboardRuntimeController.showAgentPivot();
    }

    function getRegisteredAiSessionProvider(providerId: AiSessionProviderId): AiSessionProvider {
        let provider = aiSessionProviderRegistry.get(providerId);
        if (!provider) {
            return null;
        }

        return provider;
    }

    function getRegisteredAiSessionProviders(): AiSessionProvider[] {
        return aiSessionProviders;
    }

    function refreshStewardViews(reason = 'refresh') {
        openWorkspaceController.refresh();
        dashboardRuntimeController.refresh(reason);
    }

    function postOpenWorkspacesUpdated() {
        openWorkspaceDashboardController.postUpdated();
    }

    function scheduleAiSessionRefresh(reason = 'refresh') {
        aiSessionDashboardController.scheduleRefresh(reason);
    }

    function setAiSessionWatchersActive(active: boolean) {
        aiSessionDashboardController.setWatchersActive(active);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        aiSessionDashboardController.scheduleNewSessionRefresh(providerId);
    }

    function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
        dashboardRuntimeController.postBatchArchiveCompletion(message);
    }

    function postActiveAiSessionTerminalChanged() {
        void conversationCapability.reconcile();
        postActiveAiSessionTerminalPresentation();
    }

    function postActiveAiSessionTerminalPresentation(
        transaction: AiSessionPresentationTransaction<vscode.Terminal>
            = aiSessionProjectionCoordinator.captureNext(getCurrentOpenWorkspace())
    ): void {
        const configuration = getAgentPivotConfiguration();
        const message = buildAiSessionPresentationState(
            true,
            transaction,
            openWorkspaceDashboardController.getCurrentRenderedWorkspaceNavigationIdentity(),
            getEffectiveRunningCardAnimation(configuration),
            getEffectiveRunningIconAnimation(configuration),
        );
        try {
            void provider.postMessage(message).then(undefined, error => {
                logError('Failed to post the Active Session presentation.', error);
            });
        } catch (error) {
            logError('Failed to post the Active Session presentation.', error);
        }
    }

    function invalidateAiSessionCache(providerId: AiSessionProviderId) {
        getRegisteredAiSessionProvider(providerId)?.service.invalidateCache();
    }

    async function showAgentPivotSettings() {
        await dashboardRuntimeController.openSettings();
    }

    function isFolderGitRepo(fPath: string) {
        return gitRepositoryDetector.isGitRepositoryPath(fPath);
    }

    function getOpenWorkspaceCards(
        projection?: AiSessionPresentationTransaction<vscode.Terminal>
    ) {
        return openWorkspaceDashboardController.getCards(projection);
    }

    function getSavedProjectForCurrentWorkspace(): Project | null {
        return getSavedProjectForWorkspace(getCurrentOpenWorkspace());
    }

    function getSavedProjectForWorkspace(
        workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'> | null
    ): Project | null {
        if (!workspace || workspace.kind === 'untitledMultiRoot') {
            return null;
        }
        try {
            return findSavedProjectForOpenProject(
                projectService.getProjectsFlat(),
                vscode.Uri.parse(workspace.navigationUri),
                vscode.env.remoteName,
            );
        } catch (_error) {
            return null;
        }
    }

    function getCurrentWorkspaceActionTargetWithoutCardId(): WorkspaceAiSessionActionTarget | null {
        const workspace = getCurrentOpenWorkspace();
        const card = getOpenWorkspaceCards().find(candidate => candidate.kind === 'current');
        return workspace && card?.aiSessions
            ? { cardId: card.id, workspace, sessions: card.aiSessions }
            : null;
    }

    function getCurrentWorkspaceActionTarget(cardId: string): WorkspaceAiSessionActionTarget | null {
        const workspace = getCurrentOpenWorkspace();
        if (!workspace) {
            return null;
        }
        const card = getOpenWorkspaceCards()
            .find(candidate => candidate.kind === 'current' && candidate.id === cardId);
        return card?.aiSessions
            ? { cardId: card.id, workspace, sessions: card.aiSessions }
            : null;
    }

    function getAiSessionsUpdatedMessage(): AiSessionsUpdatedMessage {
        return aiSessionDashboardController.getUpdatedMessage();
    }

    function getAiSessionPinKey(providerId: AiSessionProviderId, sessionId: string): string {
        return getAiSessionKey(providerId, sessionId);
    }

}

}



// this method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
    const client = activeAiSessionAttentionBridgeClient;
    activeAiSessionAttentionBridgeClient = null;
    await client?.shutdown();
    const openWorkspaceClient = activeOpenWorkspaceBridgeClient;
    activeOpenWorkspaceBridgeClient = null;
    await openWorkspaceClient?.shutdown();
}
