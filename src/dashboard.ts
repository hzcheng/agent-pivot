'use strict';
import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { Project, GroupOrder, ProjectRemoteType, StewardInfos, ProjectOpenType, ReopenStewardReason, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
import { getSkillsPanelContent } from './webview/webviewSkillContent';
import {
    AGENT_PIVOT_CONFIG_SECTION,
    AGENT_PIVOT_DASHBOARD_VIEW_ID,
    USER_CANCELED,
    RelevantExtensions,
    REOPEN_KEY,
    WSL_DEFAULT_REGEX,
} from './constants';

import ColorService from './services/colorService';
import ProjectService from './services/projectService';
import { TodoCommandController } from './todos/commandController';
import { TodoService } from './todos/service';
import { PromptDashboardController } from './prompts/dashboardController';
import { initializePromptMementoStore, PromptService } from './prompts/service';
import { PromptTerminalCommandController } from './prompts/terminalCommandController';
import { getAiPanelContent, getPromptSurfaceContent } from './prompts/webviewContent';
import { SkillDashboardController } from './skills/dashboardController';
import { GlobalStoreLocationController } from './skills/globalStoreLocationController';
import { skillDirectoriesEqual } from './skills/scopeService';
import { SkillGroupStore } from './skills/skillGroupStore';
import {
    deleteTodoWithConfirmation,
    renameTodoGroupWithPrompt,
    runTodoMutation,
    runTodoPromptMutation,
    runTodoRequestMutation,
} from './todos/hostMutation';
import { UnsupportedTodoDataVersionError } from './todos/types';
import { buildTodoPanelSnapshot, buildTodoViewModel } from './todos/viewModel';
import { getTodoPanelContent, getUnsupportedTodoVersionPanelContent } from './todos/webviewContent';
import FileService from './services/fileService';
import CodexSessionService from './services/codexSessionService';
import { ProcCodexRootThreadObserver } from './aiSessions/codexRootThreadObserver';
import KimiSessionService from './services/kimiSessionService';
import ClaudeSessionService from './services/claudeSessionService';
import ProjectWindowColorService from './services/projectWindowColorService';
import AiSessionAliasStore from './aiSessions/aliasStore';
import AiSessionAliasController from './aiSessions/aliasController';
import AiSessionPinStore from './aiSessions/pinStore';
import AiSessionPinController from './aiSessions/pinController';
import {
    ConversationCommentFileStore,
} from './aiSessions/conversation/commentStore';
import {
    ConversationBookmarkFileStore,
} from './aiSessions/conversation/bookmarkStore';
import AiSessionWorkspaceStateStore from './aiSessions/workspaceStateStore';
import ActiveAiSessionTerminalHighlighter from './aiSessions/activeTerminalHighlight';
import AttentionBridgeClient from './aiSessions/attentionBridgeClient';
import { getAttentionRuntimeSessionKey, withAttentionProject } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
import { getAiSessionKey } from './aiSessions/sessionHelpers';
import {
    AI_SESSION_PROVIDER_DEFINITIONS,
    buildAiSessionProviderPicks,
    createAiSessionProviderRegistry,
    getAiSessionProviderLabel,
} from './aiSessions/providers';
import { ProviderDirectoryCapabilityProbe } from './aiSessions/providerDirectoryCapability';
import type {
    BoundedChildProcessOptions,
    BoundedChildProcessResult,
} from './aiSessions/providerDirectoryCapability';
import { getAiSessionComparableCwd as getProviderAiSessionComparableCwd, getAiSessionTerminalName as getProviderAiSessionTerminalName } from './aiSessions/sessionPaths';
import { getAiSessionIdsForCwd } from './aiSessions/pendingTerminals';
import { getAiSessionTerminalCandidates } from './aiSessions/terminalCandidates';
import { AiSessionReadCoordinator } from './aiSessions/readCoordinator';
import AiSessionTerminalService from './aiSessions/terminalService';
import AiSessionTerminalBindingStore from './aiSessions/terminalBindingStore';
import { readAiSessionLaunchOptions } from './aiSessions/launchOptions';
import { readAiSessionRuntimeConfiguration } from './aiSessions/runtimeConfiguration';
import { DirectTerminalRuntimeBackend } from './aiSessions/directTerminalRuntimeBackend';
import { AiSessionRuntimeCoordinator } from './aiSessions/runtimeCoordinator';
import type { AiSessionTmuxFallbackContext } from './aiSessions/runtimeCoordinator';
import type { AiSessionRuntimeSnapshot } from './aiSessions/runtimeTypes';
import { cloneAiSessionRuntimeIdentity, TmuxRuntimeUnavailableError } from './aiSessions/runtimeTypes';
import { TmuxClient, TmuxClientError } from './aiSessions/tmuxClient';
import { TmuxRuntimeBindingStore } from './aiSessions/tmuxRuntimeBindingStore';
import { TmuxAttachBindingStore } from './aiSessions/tmuxAttachBindingStore';
import {
    findTmuxCollisionRuntime,
    isCurrentRuntimeMarker,
    TmuxRuntimeDiscovery,
} from './aiSessions/tmuxRuntimeDiscovery';
import { TmuxRuntimeBackend } from './aiSessions/tmuxRuntimeBackend';
import { TmuxFocusedRuntimeMonitor } from './aiSessions/tmuxFocusedRuntimeMonitor';
import { withTmuxCreationLock } from './aiSessions/tmuxCreationLock';
import type { AiSessionBatchArchiveCompletedMessage, AiSessionProvider, AiSessionService, AiSessionTerminalEntry, AiSessionsUpdatedMessage, WorkspaceAiSessionActionTarget } from './aiSessions/types';
import {
    ConversationCapability,
    createConversationCapability,
} from './aiSessions/conversation/composition';
import {
    withConversationDisplayMetadata,
} from './aiSessions/conversation/conversationHostController';
import {
    submitConversationPrompt,
} from './aiSessions/conversation/submission';
import { AiSessionDashboardController } from './aiSessions/dashboardController';
import { AiSessionCommandController } from './aiSessions/commandController';
import { AiSessionCreationController } from './aiSessions/creationController';
import { AiSessionArchiveController } from './aiSessions/archiveController';
import { AiSessionResumeController } from './aiSessions/resumeController';
import { AiSessionTerminalCommandController } from './aiSessions/terminalCommandController';
import { AiSessionExecutionController } from './aiSessions/executionController';
import {
    AiSessionAttentionController,
    runAiSessionRuntimeLifecycleTask,
    settleAiSessionRuntimeLifecycles,
} from './aiSessions/attentionController';
import type {
    AiSessionAttentionEvaluation,
    AiSessionRuntimeLifecycleCandidate,
} from './aiSessions/attentionController';
import { createAiSessionStatusCapability } from './aiSessions/statusCapability';
import { NotifyDispatcher } from './aiSessions/notify/dispatcher';
import { createHttpsTransport } from './aiSessions/notify/httpClient';
import { NotifiedEventStore } from './aiSessions/notify/store';
import type { NotifyConfig } from './aiSessions/notify/types';
import { registerNotifyCommands, resolveNotifySecretStorage } from './aiSessions/notifyIntegration/commands';
import { assembleNotifyConfig, NOTIFY_SECRET_KEY_PREFIX } from './aiSessions/notifyIntegration/credentials';
import { buildNotifyPayload } from './aiSessions/notifyIntegration/notifier';
import { createNotifyOutputChannel } from './aiSessions/notifyIntegration/output';
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
import { ProjectsPanelController } from './dashboard/projectsPanelController';
import {
    DashboardRuntimeController,
    revealAgentPivotDashboard,
} from './dashboard/runtimeController';
import type { ProjectsPanelUpdateMode } from './dashboard/webviewUpdateMessages';
import { DashboardStartupController, settleMigration } from './dashboard/startupController';
import { getDashboardWebviewOptions } from './dashboard/webviewOptions';
import OpenWorkspaceBridgeClient from './openWorkspaces/bridgeClient';
import { OpenWorkspaceDashboardController } from './openWorkspaces/dashboardController';
import { WorkspaceNavigationController } from './openWorkspaces/navigationController';
import { OpenWorkspacePinController } from './openWorkspaces/pinController';
import { OpenWorkspaceController } from './openWorkspaces/workspaceController';
import { WorkspaceContextResolver } from './workspaces/contextResolver';
import { WorkspacePrimaryRootStore } from './workspaces/primaryRootStore';
import { PendingWorkspaceSaveStore } from './workspaces/pendingWorkspaceSaveStore';
import { SavedWorkspaceProjectAdapter } from './workspaces/savedWorkspaceProjectAdapter';
import { WorkspacePendingSessionPromotionController } from './workspaces/pendingSessionPromotionController';
import { WorkspaceSessionHydrationController } from './workspaces/sessionHydrationController';
import type { OpenWorkspace } from './workspaces/types';
import { buildWorkspaceDashboardSearchCatalog } from './webview/dashboardViewModel';

const NEW_AI_SESSION_REFRESH_DELAYS_MS = [250, 1000, 2500, 5000];
const AI_SESSION_REFRESH_DEBOUNCE_MS = 3000;
const AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS = 10000;
const AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;
const AI_SESSION_TMUX_RESTORE_BUDGET_MS = 800;
const DASHBOARD_BOOTSTRAP_PHASE_ORDER = [
    'skill-scan',
    'tmux-persisted-inactive-restore',
    'direct-terminal-restore',
    'tmux-attach-restore',
    'tmux-restore-wait',
    'startup-sequence',
];
// Mirrors vscode.TerminalExitReason.User. The extension's minimum VS Code typings
// predate TerminalExitStatus.reason, while supported hosts expose it at runtime.
const USER_TERMINAL_EXIT_REASON = 3;
let activeAiSessionAttentionBridgeClient: AttentionBridgeClient | null = null;

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

async function settlesWithinBudget<T>(
    task: Promise<T>,
    budgetMs: number
): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            task.then(() => true),
            new Promise<boolean>(resolve => {
                timeout = setTimeout(() => resolve(false), budgetMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
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
        ),
    );

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
    const globalStoreLocationController = new GlobalStoreLocationController({
        homeDir: os.homedir(),
        getWorkspaceRoots: getWorkspaceRootPaths,
        readSetting: () => getAgentPivotConfiguration().get<string>(
            'skills.globalStorePath',
            '~/.skills',
        ),
        writeSetting: value => getAgentPivotConfiguration().update(
            'skills.globalStorePath',
            value,
            vscode.ConfigurationTarget.Global,
        ),
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: (message, options, ...items) => options
            ? vscode.window.showWarningMessage(message, options, ...items)
            : vscode.window.showWarningMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        refresh: () => skillDashboardController.refresh(
            'global-skills-location-changed',
        ),
        logError,
    });
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
                skillDashboardController.getRecords(),
                skillDashboardController.getPanelView(),
            ),
        ),
    });
    const skillDashboardController = ownResource(() => new SkillDashboardController({
        getHomeDir: () => os.homedir(),
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        getGlobalSkillsRoot: () => globalStoreLocationController.getActiveRoot(),
        postMessage: message => provider.postMessage(message),
        isVisible: () => provider.visible,
        logError,
        groupStore: new SkillGroupStore(context.globalState),
    }));
    const completedSkillScopeActionRequests = new Set<string>();
    const publishSkillScopeActionSettlement = async (settlement: {
        version: 1;
        requestId: string;
        dirPath: string;
        operation: 'apply-to-project' | 'move-to-global';
        ok: boolean;
        code?: string;
        resultDirPath?: string;
    }): Promise<void> => {
        let delivered = false;
        try {
            delivered = await skillDashboardController.refresh('skill-scope-action', settlement);
        } catch (error) {
            logError('Failed to publish the authoritative Skill scope update.', error);
        }
        if (delivered) {
            return;
        }
        try {
            provider.refresh();
        } catch (error) {
            logError('Failed to refresh the dashboard after a Skill scope action.', error);
        }
        try {
            await provider.postMessage({
                type: 'skill-scope-action-result',
                ...settlement,
                ok: false,
                code: 'refresh-failed',
            });
        } catch (error) {
            logError('Failed to settle the Skill scope action.', error);
        }
    };
    timeBootstrapPhase('skill-scan', () => skillDashboardController.start());
    const runSkillMigrationToCentral = async (scope?: 'user' | 'project'): Promise<void> => {
        const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
        const migratable = skillDashboardController.getRecords()
            .filter(record => !record.central
                && (!scope || record.scope === scope)
                && (record.source === 'kimi' || record.source === 'claude' || record.source === 'codex'));
        if (!migratable.length) {
            void vscode.window.showInformationMessage(scope
                ? `Every ${scope === 'user' ? 'user' : 'project'} skill is already centralized.`
                : 'Every skill is already centralized.');
            return;
        }
        const userNames = new Set(migratable.filter(record => record.scope === 'user').map(record => record.name));
        const projectNames = new Set(migratable.filter(record => record.scope === 'project').map(record => record.name));
        const segments: string[] = [];
        if (userNames.size) {
            segments.push(
                `${userNames.size} user skill(s) into `
                + skillDashboardController.getStoreRoots().user,
            );
        }
        if (hasWorkspace && projectNames.size) {
            segments.push(`${projectNames.size} project skill(s) into this project's .skills`);
        }
        const choice = await vscode.window.showWarningMessage(
            `Migrate ${segments.join(' and ')}? `
            + 'The kimi > claude > codex copy wins, other copies are deleted, '
            + 'and no agent links are created — enable agents per card afterwards.',
            { modal: true },
            'Migrate',
        );
        if (choice !== 'Migrate') {
            return;
        }
        const report = skillDashboardController.handleMigrateToCentral(scope);
        const parts = [`Migrated ${report.migrated.length} skill(s) into the central stores`];
        if (report.drifted.length) {
            parts.push(`${report.drifted.length} had drift (brand-priority winner)`);
        }
        if (report.deleted.length) {
            parts.push(`${report.deleted.length} duplicate(s) deleted`);
        }
        if (report.skipped.length) {
            parts.push(`${report.skipped.length} skipped`);
        }
        const summary = `${parts.join('; ')}.`;
        if (report.errors.length) {
            void vscode.window.showWarningMessage(`${summary} ${report.errors.length} failed: ${report.errors[0].error}`);
        } else {
            void vscode.window.showInformationMessage(summary);
        }
    };
    const todoViewState = todoService.getViewState();
    let revealedTodoId: string | undefined;
    const todoCommandController = new TodoCommandController({
        service: todoService,
        getViewState: () => todoViewState,
        setShowCompleted: async showCompleted => {
            const persistedViewState = await todoService.setShowCompleted(showCompleted);
            todoViewState.showCompleted = persistedViewState.showCompleted;
            return persistedViewState;
        },
        getRevealedTodoId: () => revealedTodoId,
        clearRevealedTodoId: () => { revealedTodoId = undefined; },
    });
    const todoStorageMigration = { ready: Promise.resolve<unknown>(undefined) };
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
        refreshAfterMutation,
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
        refreshAfterMutation,
    });
    const favoriteProjectController = new FavoriteProjectController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        refreshAfterMutation,
    });
    const projectOrderController = new ProjectOrderController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        refreshAfterMutation,
    });
    const projectRemovalController = new ProjectRemovalController({
        getProject: projectId => projectService.getProject(projectId),
        getProjectsFlat: () => projectService.getProjectsFlat(),
        showProjectPicker: projectPicks => vscode.window.showQuickPick(projectPicks),
        confirmRemoveProject: projectName => vscode.window.showWarningMessage(`Remove ${projectName}?`, { modal: true }, 'Remove'),
        removeProject: projectId => projectService.removeProject(projectId),
        refreshAfterMutation,
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
            refreshAfterMutation();
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
        refreshAfterMutation,
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
    const tmuxAttachBindingStore = new TmuxAttachBindingStore(context.workspaceState, error => {
        logAiSessionRuntimeFailure('persist-attach-binding', error);
    });
    const tmuxClient = new TmuxClient(aiSessionRuntimeConfiguration.tmuxPath);
    const tmuxRuntimeDiscovery = new TmuxRuntimeDiscovery({
        client: tmuxClient,
        bindingStore: tmuxRuntimeStore,
        codexRootThreadObserver: new ProcCodexRootThreadObserver(),
        onSessionRebound: (previous, next) => aiSessionAliasController.copyForRebind(
            previous.provider,
            previous.sessionId || '',
            next.sessionId || ''
        ),
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
    ownResource(() => vscode.window.onDidOpenTerminal(terminal => {
        if (!tmuxRuntimeBackend.isAttachTerminalCandidate(terminal)) {
            return;
        }
        void tmuxRuntimeBackend.restoreAttachTerminals([terminal]).then(
            () => publishRestoredTmuxAttachTerminal(),
            error => logAiSessionRuntimeFailure('restore-opened-tmux-attach-terminal', error)
        );
    }));
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
    await timeBootstrapPhase('direct-terminal-restore', () =>
        aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals));
    resources.assertActive();
    const tmuxRestoreTask = persistedInactiveRestoreTask.then(async (): Promise<'restored' | 'failed' | 'disposed'> => {
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
    const tmuxRestoreCompleted = await timeBootstrapPhase('tmux-restore-wait', () =>
        settlesWithinBudget(tmuxRestoreTask, AI_SESSION_TMUX_RESTORE_BUDGET_MS));
    resources.assertActive();
    let deferredTmuxRestoreSettled = false;
    let deferredTmuxRestoreRefreshReady = false;
    let deferredTmuxRestoreRefreshPublished = false;
    if (!tmuxRestoreCompleted) {
        logDashboardDiagnostic({
            event: 'agent-pivot-bootstrap-tmux-restore-deferred',
            generation: bootstrapGeneration,
            budgetMs: AI_SESSION_TMUX_RESTORE_BUDGET_MS,
        });
        void tmuxRestoreTask.then(outcome => {
            try {
                resources.assertActive();
            } catch (_error) {
                return;
            }
            deferredTmuxRestoreSettled = true;
            logDashboardDiagnostic({
                event: 'agent-pivot-bootstrap-tmux-restore-settled',
                generation: bootstrapGeneration,
                outcome,
            });
            publishDeferredTmuxRestoreIfReady();
        });
    }
    const aiSessionPinStore = new AiSessionPinStore(context.globalStoragePath);
    const aiSessionPinController = new AiSessionPinController({
        store: aiSessionPinStore,
        getSessionKey: getAiSessionPinKey,
        logError,
        showUpdateError: () => vscode.window.showErrorMessage('Could not update the pinned chat.'),
    });
    const aiSessionWorkspaceStateStore = new AiSessionWorkspaceStateStore(context.globalState, isAiSessionProviderId);
    const workspaceContextResolver = new WorkspaceContextResolver();
    const workspacePrimaryRootStore = new WorkspacePrimaryRootStore(context.globalState);
    let openWorkspaceController: OpenWorkspaceController;
    let openWorkspaceDashboardController: OpenWorkspaceDashboardController;
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
            syncActiveRuntime: () => activeAiSessionTerminalHighlighter.sync(),
            evaluateExecution: () => evaluateAiSessionLifecycleTick(),
            scheduleRefresh: () => refreshAiSessionViewsIncrementally(),
            logDiagnostic: logAiSessionDiagnostic,
        });
    const workspaceSessionHydrationController = new WorkspaceSessionHydrationController<vscode.Terminal>({
        providers: aiSessionProviders,
        readCoordinator: aiSessionReadCoordinator,
        incrementalScanMaxFiles: AI_SESSION_INCREMENTAL_SCAN_MAX_FILES,
        getRefreshReason: () => currentAiSessionRefreshReason,
        getSessionComparableCwd: (providerId, session) =>
            getProviderAiSessionComparableCwd(providerId, session, aiSessionProviders),
        getPinnedSessions: () => aiSessionPinController.getAll(),
        getAliases: () => aiSessionAliasController.getAll(),
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
        getActiveRuntimes: () => aiSessionRuntimeCoordinator.getActive(),
        getPendingRuntimes: () => aiSessionRuntimeCoordinator.getPending(),
        getExecutionSnapshot: () => aiSessionExecutionController.getSnapshot(),
        getFocusedIdentity: () => getFocusedAiSessionRuntimeIdentity(),
        getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
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
    const pickAiSessionWorkspaceRoot = async (
        workspace: OpenWorkspace,
        action: 'create' | 'resume'
    ): Promise<string | undefined> => {
        const selected = await vscode.window.showQuickPick(
            workspace.roots.map(root => ({
                label: root.name,
                description: root.hostPath,
                rootId: root.id,
            })),
            {
                placeHolder: 'Select a workspace root',
                ignoreFocusOut: true,
                title: action === 'resume'
                    ? 'Resume AI Session in Workspace Root'
                    : 'New AI Session Working Directory',
            } as vscode.QuickPickOptions & { title: string }
        );
        return selected?.rootId;
    };
    const aiSessionCommandController = new AiSessionCommandController({
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getOpenWorkspace: getCurrentOpenWorkspace,
        getActiveEditorUri: () => vscode.window.activeTextEditor?.document.uri,
        isWorkspaceTrusted: () => (
            vscode.workspace as typeof vscode.workspace & { isTrusted?: boolean }
        ).isTrusted !== false,
        getProvider: getRegisteredAiSessionProvider,
        getProviderDirectoryCapability: providerDefinition =>
            providerDirectoryCapability.probe(providerDefinition),
        getPrimaryRootId: workspace => workspacePrimaryRootStore.getPrimaryRootId(
            workspace.scopeIdentity,
            workspace.roots
        ),
        setPrimaryRootId: (scopeIdentity, rootId) =>
            workspacePrimaryRootStore.setPrimaryRootId(scopeIdentity, rootId),
        pickWorkspaceRoot: pickAiSessionWorkspaceRoot,
        isDirectory: hostPath => {
            try {
                return statSync(hostPath).isDirectory();
            } catch (error) {
                return false;
            }
        },
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        isProviderId: isAiSessionProviderId,
        setExpanded: (workspaceScopeIdentity, expanded) => aiSessionWorkspaceStateStore.setExpanded(workspaceScopeIdentity, expanded),
        setProviderSelection: (workspaceScopeIdentity, selection) =>
            aiSessionWorkspaceStateStore.setProviderSelection(workspaceScopeIdentity, selection),
        postProviderSelectionResult: result => provider.postMessage(result),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logError,
        togglePin: (providerId, sessionId) => aiSessionPinController.toggle(providerId, sessionId),
        getAliases: () => aiSessionAliasController.getAll(),
        saveAliases: aliases => aiSessionAliasController.saveAll(aliases),
        getOriginalName: (providerId, sessionId) => aiSessionAliasController.getOriginalName(providerId, sessionId),
        getSessionKey: getAiSessionPinKey,
        showInputBox: options => vscode.window.showInputBox(options),
        writeClipboard: value => vscode.env.clipboard.writeText(value),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        refresh: refreshAiSessionViewsIncrementally,
    });
    const pickAiSessionProvider = async (): Promise<AiSessionProviderId | undefined> => {
        const quickPickOptions: vscode.QuickPickOptions = {
            placeHolder: 'Select an AI provider',
            ignoreFocusOut: true,
        };
        (quickPickOptions as vscode.QuickPickOptions & { title?: string }).title = 'Select an AI provider';
        const selected = await vscode.window.showQuickPick(
            buildAiSessionProviderPicks(getRegisteredAiSessionProviders()),
            quickPickOptions
        );
        return selected?.providerId;
    };
    const aiSessionCreationController = new AiSessionCreationController({
        isProviderId: isAiSessionProviderId,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        pickWorkspaceRoot: workspace => pickAiSessionWorkspaceRoot(workspace, 'create'),
        pickProvider: pickAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getLaunchOptions: () =>
            readAiSessionLaunchOptions(vscode.workspace),
        getProvider: getRegisteredAiSessionProvider,
        resolveWorkspaceDirectoryScope: (target, providerId, explicitRootId) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, undefined, explicitRootId
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        createPendingId: () => randomBytes(16).toString('hex'),
        showInputBox: options => vscode.window.showInputBox(options),
        showActiveTab: projectId => provider.postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'active',
        }),
        showWarningMessage: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        getExistingSessionIdsForCwd: (providerId, cwd) => getAiSessionIdsForCwd(providerId, aiSessionReadCoordinator.getProviderResult(providerId, {
            forceRefresh: true,
            candidatePaths: [cwd],
            reason: 'new-session',
        }), cwd, aiSessionProviders),
        getPendingMarkerPath: providerId => aiSessionTerminalService.getPendingMarkerPath(providerId),
        scheduleNewSessionRefresh: scheduleNewAiSessionRefresh,
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        nowMs: () => Date.now(),
    });
    const aiSessionArchiveController = new AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>({
        isProviderId: isAiSessionProviderId,
        getProvider: getRegisteredAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getRuntimeById: getAiSessionRuntimeById,
        refreshRuntimeGuard: () => aiSessionRuntimeCoordinator.refreshForHost(true),
        isRuntimeComplete: runtime => runtime.state === 'completed',
        focusRuntime: runtime => aiSessionRuntimeCoordinator.focus({ ...runtime.identity }),
        deleteRuntimeMarker: runtime => aiSessionTerminalService.deleteMarker(runtime.markerPath),
        untrackRuntime: (providerId, sessionId, workspaceScopeIdentity) =>
            aiSessionTerminalService.untrack(providerId, sessionId, workspaceScopeIdentity),
        deletePin: (providerId, sessionId) => aiSessionPinController.remove(providerId, sessionId),
        deleteAlias: (providerId, sessionId) => aiSessionAliasController.remove(providerId, sessionId),
        confirmSingleArchive: providerLabel => vscode.window.showWarningMessage(`Archive this ${providerLabel} session?`, { modal: true }, "Archive"),
        confirmBatchArchive: message => vscode.window.showWarningMessage(message, { modal: true }, 'Archive'),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        appendLine: message => outputChannel.appendLine(message),
        postCompletion: completion => postBatchArchiveCompletion(completion as AiSessionBatchArchiveCompletedMessage),
        refresh: refreshAiSessionViewsIncrementally,
        syncActiveRuntime: () => activeAiSessionTerminalHighlighter.sync(),
        logUnexpectedError: (operation, error, failedSessionId) => {
            if (operation === 'focus-runtime') {
                logAiSessionRuntimeFailure(operation, error, 'tmux');
                return;
            }
            logError(`Batch AI session archive failed during ${operation}${failedSessionId ? ` (${failedSessionId})` : ''}.`, error);
        },
    });
    const aiSessionTerminalCommandController = new AiSessionTerminalCommandController<vscode.Terminal>({
        isProviderId: isAiSessionProviderId,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        confirmRuntimeClose: (message, action) => vscode.window.showWarningMessage(
            message, { modal: true }, action
        ),
        chooseRuntimeConflict: async runtimes => {
            const picks = runtimes.map(runtime => {
                const backendLabel = runtime.backend === 'tmux'
                    ? `tmux · ${runtime.tmux?.layout || 'unknown'} layout`
                    : 'Direct · VS Code Terminal';
                const attachment = runtime.attached ? 'attached' : 'detached';
                const target = runtime.backend === 'tmux'
                    ? `${runtime.tmux?.sessionName || 'unknown session'}${runtime.tmux?.windowName
                        ? `:${runtime.tmux.windowName}` : ''}`
                    : runtime.terminal?.name || 'unnamed VS Code terminal';
                return {
                    label: `$(terminal) ${backendLabel}`,
                    description: attachment,
                    detail: `Target: ${target}`,
                    runtime,
                };
            });
            const selected = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select the exact AI session runtime to focus',
                ignoreFocusOut: true,
            });
            return selected?.runtime;
        },
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        getProviderLabel: getAiSessionProviderLabel,
        refresh: refreshAiSessionViewsIncrementally,
        onRuntimeCloseEnd: (runtime, succeeded) => {
            const sessionId = runtime.identity.sessionId;
            if (!sessionId || !succeeded) {
                return;
            }
            void runSafeAiSessionRuntimeLifecycleTask(
                'acknowledge-explicit-session-close',
                () => acknowledgeAiSessionAttention({
                    provider: runtime.identity.provider,
                    sessionId,
                    workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                })
            );
        },
        focusTerminalView: () =>
            vscode.commands.executeCommand('workbench.action.terminal.focus'),
    });
    const aiSessionResumeController = new AiSessionResumeController<vscode.Terminal>({
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getLaunchOptions: () =>
            readAiSessionLaunchOptions(vscode.workspace),
        getProvider: getRegisteredAiSessionProvider,
        resolveWorkspaceDirectoryScope: (target, session, providerId, explicitRootId) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, session, explicitRootId
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        getTerminalName: (providerId, session) => getProviderAiSessionTerminalName(providerId, session, aiSessionProviders),
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        getRuntimeConflict: getAiSessionRuntimeCollision,
        getMarkerPath: (providerId, sessionId) => aiSessionTerminalService.getMarkerPath(providerId, sessionId),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        showActiveTab: projectId => provider.postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'active',
        }),
        announceStatus: (projectId, message) => provider.postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
    });
    let aiSessionUpdateSequence = 0;
    let currentAiSessionRefreshReason = 'refresh';
    let aiSessionAttentionBridgeClient: AttentionBridgeClient;
    const notifyOutput = createNotifyOutputChannel();
    context.subscriptions.push({ dispose: () => notifyOutput.dispose() });
    const notifiedStore = new NotifiedEventStore(
        path.join(os.homedir(), '.agent-pivot', 'notified.json'));
    notifiedStore.load();
    let currentNotifyConfig: NotifyConfig | null = null;
    const notifyDispatcher = new NotifyDispatcher({
        transport: createHttpsTransport(),
        store: notifiedStore,
        nowMs: () => Date.now(),
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        globalProxy: getAgentPivotConfiguration().get<string>('notify.proxy', ''),
        env: process.env,
        onLog: line => notifyOutput.log(line),
    });
    const refreshNotifyConfig = async (): Promise<void> => {
        const configuration = getAgentPivotConfiguration();
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
            enabled: configuration.get<boolean>('notify.enabled', false),
            sinks: skeletons,
            reasons: configuration.get<string[]>('notify.reasons',
                ['completed', 'input-required', 'failed']),
            minRunDurationMs: configuration.get<number>('notify.minRunDurationMs', 60000),
            debounceMs: configuration.get<number>('notify.debounceMs', 5000),
            rateLimitPerMin: configuration.get<number>('notify.rateLimitPerMin', 6),
            escalateAfterMs: configuration.get<number>('notify.escalateAfterMs', 0),
            projectPathMode: configuration.get<string>('notify.projectPathMode', 'basename'),
            includeSessionLabel: configuration.get<boolean>('notify.includeSessionLabel', true),
        }, secrets);
        currentNotifyConfig = assembled;
        notifyDispatcher.setConfig(assembled);
    };
    await refreshNotifyConfig();
    context.subscriptions.push(...registerNotifyCommands(context, {
        output: notifyOutput,
        getConfig: () => currentNotifyConfig || assembleNotifyConfig({
            enabled: false, sinks: [], reasons: [], minRunDurationMs: 0,
            debounceMs: 0, rateLimitPerMin: 1, escalateAfterMs: 0,
            projectPathMode: 'basename', includeSessionLabel: true,
        }, {}),
        globalProxy: () => getAgentPivotConfiguration().get<string>('notify.proxy', ''),
    }));
    const locateAttentionSession = (key: string) => {
        const target = getCurrentWorkspaceActionTargetWithoutCardId();
        if (!target) {
            return null;
        }
        for (const provider of getRegisteredAiSessionProviders()) {
            for (const session of target.sessions.sessionsByProvider[provider.id] || []) {
                if (getAiSessionKey(provider.id, session.id) !== key) {
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
    const aiSessionAttentionController = new AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>({
        isEnabled: () => getAgentPivotConfiguration().get<boolean>('aiSessionAttention.enabled', true) !== false,
        getWorkspaceTarget: getCurrentWorkspaceActionTargetWithoutCardId,
        getProviders: getRegisteredAiSessionProviders,
        getRuntimeById: getAiSessionRuntimeById,
        publish: (items, forceHeartbeat) => aiSessionAttentionBridgeClient.publish(items, forceHeartbeat),
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        onAttentionEvents: events => {
            for (const event of events) {
                const located = locateAttentionSession(event.key);
                if (!located) {
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
    const getAiSessionAttentionEventIds = (identity: ActiveAiSessionTerminalIdentity): string[] => {
        const sessionKey = getAiSessionKey(identity.provider, identity.sessionId);
        return aiSessionAttentionController.getRecoverySessionEvents()
            .find(session => session.sessionKey === sessionKey)?.eventIds || [];
    };
    const acknowledgeAiSessionAttentionEventIds = async (eventIds: string[]): Promise<void> => {
        const uniqueEventIds = Array.from(new Set(eventIds.filter(eventId => Boolean(eventId))));
        if (!uniqueEventIds.length) {
            return;
        }
        aiSessionAttentionController.acknowledge(uniqueEventIds);
        refreshAiSessionViewsIncrementally();
        await aiSessionAttentionBridgeClient.acknowledge(uniqueEventIds);
    };
    const acknowledgeAiSessionAttention = async (
        identity: ActiveAiSessionTerminalIdentity
    ): Promise<void> => {
        await acknowledgeAiSessionAttentionEventIds(getAiSessionAttentionEventIds(identity));
    };
    type RuntimeLifecycleCandidate = AiSessionRuntimeLifecycleCandidate & {
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
    };
    const queuedAiSessionRuntimeSettlements = new Map<string, RuntimeLifecycleCandidate>();
    const settlingAiSessionRuntimeKeys = new Set<string>();
    let aiSessionRuntimeSettlementInFlight: Promise<void> | null = null;
    const runSafeAiSessionRuntimeLifecycleTask = (
        operation: string,
        task: () => unknown | Promise<unknown>
    ): Promise<void> => runAiSessionRuntimeLifecycleTask(
        operation,
        task,
        (failedOperation, category) => logAiSessionDiagnostic({
            event: 'runtime-lifecycle-task-failed',
            operation: failedOperation,
            category,
        })
    );
    const queueAiSessionRuntimeSettlements = (
        runtimes: readonly AiSessionRuntimeSnapshot<vscode.Terminal>[]
    ): void => {
        for (const runtime of runtimes) {
            if (!runtimeBelongsToCurrentWorkspace(runtime)) {
                continue;
            }
            const sessionId = runtime.identity.sessionId;
            if (!sessionId || (runtime.state !== 'completed' && runtime.state !== 'stopped')) {
                continue;
            }
            const key = getAttentionRuntimeSessionKey({
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                provider: runtime.identity.provider,
                sessionId,
                runStartedAtMs: runtime.runStartedAtMs,
                backend: runtime.backend,
            });
            if (settlingAiSessionRuntimeKeys.has(key)) {
                continue;
            }
            queuedAiSessionRuntimeSettlements.set(key, {
                key,
                sessionKey: key,
                state: runtime.state,
                runtime: {
                    ...runtime,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                },
            });
        }
        if (!aiSessionRuntimeSettlementInFlight && queuedAiSessionRuntimeSettlements.size) {
            aiSessionRuntimeSettlementInFlight = runSafeAiSessionRuntimeLifecycleTask(
                'settle-runtime-lifecycles',
                drainAiSessionRuntimeSettlements
            );
        }
    };
    const drainAiSessionRuntimeSettlements = async (): Promise<void> => {
        try {
            while (queuedAiSessionRuntimeSettlements.size) {
                const candidates = [...queuedAiSessionRuntimeSettlements.values()]
                    .sort((left, right) => left.key.localeCompare(right.key));
                queuedAiSessionRuntimeSettlements.clear();
                candidates.forEach(candidate => settlingAiSessionRuntimeKeys.add(candidate.key));
                try {
                    const settled = await settleAiSessionRuntimeLifecycles({
                        candidates: candidates,
                        evaluateAttention: () => evaluateAiSessionAttention(
                            candidates.map(candidate => ({
                                providerId: candidate.runtime.identity.provider,
                                sessionId: candidate.runtime.identity.sessionId as string,
                                attentionKey: candidate.key,
                                runtime: candidate.runtime,
                            }))
                        ),
                        release: async candidate => {
                            if (candidate.runtime.backend === 'tmux') {
                                const acknowledgement = await tmuxRuntimeDiscovery
                                    .acknowledgeInactive(candidate.runtime);
                                if (acknowledgement === 'stale') {
                                    throw new Error('The tmux lifecycle acknowledgement became stale.');
                                }
                                return;
                            }
                            aiSessionTerminalService.releaseCompletedSession(
                                candidate.runtime.identity.provider,
                                candidate.runtime.identity.sessionId as string,
                                candidate.runtime.identity.workspaceScopeIdentity
                            );
                        },
                        reportFailure: (operation, category, key) => logAiSessionDiagnostic({
                            event: 'runtime-lifecycle-settlement-failed',
                            operation,
                            category,
                            hasRuntimeKey: Boolean(key),
                        }),
                    });
                    if (settled.releasedKeys.length) {
                        refreshAiSessionViewsIncrementally();
                        activeAiSessionTerminalHighlighter.sync();
                    }
                } finally {
                    candidates.forEach(candidate => settlingAiSessionRuntimeKeys.delete(candidate.key));
                }
            }
        } catch (_error) {
            logAiSessionDiagnostic({
                event: 'runtime-lifecycle-settlement-failed',
                operation: 'drain',
                category: 'unexpected',
            });
        } finally {
            aiSessionRuntimeSettlementInFlight = null;
            if (queuedAiSessionRuntimeSettlements.size) {
                queueAiSessionRuntimeSettlements([]);
            }
        }
    };
    aiSessionAttentionBridgeClient = ownResource(() => new AttentionBridgeClient(
        aggregate => {
            if (aiSessionAttentionController.setRemoteAggregate(aggregate)) {
                scheduleAttentionViewsRefresh();
            }
        },
        error => logError('AI session attention bridge unavailable; using local-window monitoring.', error)
    ));
    resources.own({
        dispose: () => {
            if (activeAiSessionAttentionBridgeClient === aiSessionAttentionBridgeClient) {
                activeAiSessionAttentionBridgeClient = null;
            }
        },
    });
    activeAiSessionAttentionBridgeClient = aiSessionAttentionBridgeClient;
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
    const aiSessionDashboardController = ownResource(() => new AiSessionDashboardController({
        providerIds: aiSessionProviders.map(provider => provider.id),
        isVisible: () => provider.visible,
        invalidateCache: providerId => invalidateAiSessionCache(providerId),
        watchSessionChanges: (providerId, onDidChange) => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(onDidChange),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillDashboardController.getRecords(),
        getCards: getOpenWorkspaceCards,
        getRunningCardAnimation: () => getAgentPivotConfiguration()
            .get<string>('aiSessionRunningCardAnimation', 'current'),
        getRunningIconAnimation: () => getAgentPivotConfiguration()
            .get<string>('aiSessionRunningIconAnimation', 'current'),
        nextSequence: () => ++aiSessionUpdateSequence,
        postMessage: message => provider.postMessage(message),
        refresh: refreshStewardViews,
        logError,
        logDiagnostic: logAiSessionDiagnostic,
        beforeRefresh: reason => {
            currentAiSessionRefreshReason = reason;
            postAiSessionAttentionState();
        },
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
    conversationCapability = ownResource(() => createConversationCapability({
        services: aiSessionServices,
        resolveTarget: (projectId, providerId, sessionId) => {
            const target = getCurrentWorkspaceActionTarget(projectId);
            const activeSessions = target?.sessions.activeSessions || [];
            const activeSession = activeSessions.find(session =>
                session.provider === providerId
                && session.sessionId === sessionId
            );
            return activeSession
                ? withConversationDisplayMetadata(
                    activeSession,
                    activeSessions
                )
                : null;
        },
        getWorkspaceRootHostPaths: () =>
            getCurrentWorkspaceActionTargetWithoutCardId()
                ?.workspace.roots.map(root => root.hostPath) || [],
        publish: message => provider.postMessage(message),
        createPanel: vscode.window.createWebviewPanel,
        openExternal: vscode.env.openExternal,
        spawnCodex: childProcess.spawn,
        now: () => Date.now(),
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        onDiagnostic: event => logAiSessionDiagnostic({ ...event }),
        commentStore: new ConversationCommentFileStore(
            context.globalStoragePath
        ),
        bookmarkStore: new ConversationBookmarkFileStore(
            context.globalStoragePath
        ),
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
        focusSession: async viewerTarget => {
            await aiSessionTerminalCommandController.focusActive(
                viewerTarget.projectId,
                viewerTarget.provider,
                viewerTarget.sessionId
            );
        },
    }));
    const conversationHandlers = {
        'request-ai-session-conversation-outline': message =>
            conversationCapability.controller.handleOutline(message),
        'open-ai-session-conversation': message =>
            conversationCapability.controller.handleOpen(message),
        'cancel-ai-session-conversation': message =>
            conversationCapability.controller.cancel(message),
    };

    const dashboardMessageRouter = createDashboardMessageRouter({
        getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id),
        saveCurrentWorkspace: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
        handlers: {
            ...conversationHandlers,
            'request-projects-panel': async e => {
                if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                    return;
                }
                await provider.postMessage({
                    type: 'projects-panel-content',
                    version: 1,
                    requestId: e.requestId,
                    html: getProjectsPanelContent(projectService.getGroups(), stewardInfos),
                });
            },
            'request-todo-panel': async e => {
                if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                    return;
                }
                await postTodoPanelContent(e.requestId as number);
            },
            'request-ai-panel': async e => {
                if (Object.keys(e).length !== 4
                    || e.version !== 1
                    || typeof e.requestId !== 'string'
                    || e.requestId.length < 1
                    || e.requestId.length > 128
                    || e.target !== 'global-prompt-library') {
                    return;
                }
                await provider.postMessage(
                    promptDashboardController.getPanelContent(e.requestId)
                );
            },
            'delete-skill': async e => {
                const dirPath = String(e.dirPath || '');
                const record = skillDashboardController.getRecords().find(candidate => candidate.dirPath === dirPath);
                const label = record ? record.name : dirPath;
                const choice = await vscode.window.showWarningMessage(
                    `Delete skill "${label}" permanently? This cannot be undone.`,
                    { modal: true },
                    'Delete',
                );
                if (choice !== 'Delete') {
                    return;
                }
                const result = skillDashboardController.handleDeleteSkill(dirPath);
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not delete the skill: ${result.error}`);
                }
            },
            'apply-skill-collection': e => {
                const result = skillDashboardController.handleApplyCollectionSuggestion(String(e.name || ''));
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not create the skill folder: ${result.error}`);
                }
            },
            'dismiss-skill-collection': async e => {
                await skillDashboardController.handleDismissCollectionSuggestion(String(e.name || ''));
            },
            'sync-skill': e => {
                const result = skillDashboardController.handleSyncSkill(String(e.sourceDir || ''), String(e.targetDir || ''));
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not sync the skill: ${result.error}`);
                }
            },
            'copy-skill': e => {
                const result = skillDashboardController.handleCopySkill(String(e.sourceDir || ''), String(e.targetRoot || ''));
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not copy the skill: ${result.error}`);
                }
            },
            'skill-scope-action': async e => {
                const keys = Object.keys(e).sort().join(',');
                if (keys !== 'dirPath,operation,requestId,type,version'
                    || e.version !== 1
                    || typeof e.requestId !== 'string'
                    || e.requestId.length < 1
                    || e.requestId.length > 128
                    || typeof e.dirPath !== 'string'
                    || e.dirPath.length < 1
                    || e.dirPath.length > 4096
                    || (e.operation !== 'apply-to-project' && e.operation !== 'move-to-global')
                    || completedSkillScopeActionRequests.has(e.requestId)) {
                    return;
                }
                completedSkillScopeActionRequests.add(e.requestId);
                if (completedSkillScopeActionRequests.size > 256) {
                    completedSkillScopeActionRequests.delete(completedSkillScopeActionRequests.values().next().value as string);
                }
                const settlement = {
                    version: 1 as const,
                    requestId: e.requestId,
                    dirPath: e.dirPath,
                    operation: e.operation as 'apply-to-project' | 'move-to-global',
                    ok: false,
                    code: 'cancelled',
                    resultDirPath: undefined as string | undefined,
                };
                try {
                    const record = skillDashboardController.getRecords().find(candidate =>
                        candidate.central && candidate.dirPath === e.dirPath);
                if (!record || (e.operation === 'apply-to-project' && record.scope !== 'user')
                    || (e.operation === 'move-to-global' && record.scope !== 'project')) {
                    settlement.code = 'invalid';
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }
                if (e.operation === 'apply-to-project') {
                    const agents = ['kimi', 'claude', 'codex'] as const;
                    const current = new Set(agents.filter(agent => Boolean(record.central?.links.project?.[agent])));
                    const defaults = current.size
                        ? current
                        : new Set(agents.filter(agent => Boolean(record.central?.links.user?.[agent])));
                    const items: Array<vscode.QuickPickItem & { agent: typeof agents[number] }> = agents.map(agent => ({
                        label: agent === 'kimi' ? 'Kimi' : agent === 'claude' ? 'Claude' : 'Codex',
                        description: current.has(agent) ? 'Currently available in this project' : undefined,
                        picked: defaults.has(agent),
                        agent,
                    }));
                    const selected = await vscode.window.showQuickPick(items, {
                        canPickMany: true,
                        placeHolder: current.size
                            ? `Use "${record.name}": choose project agents; clear all to remove project access`
                            : `Use "${record.name}": choose the agents that should use this global skill`,
                    });
                    if (selected === undefined) {
                        await publishSkillScopeActionSettlement(settlement);
                        return;
                    }
                    if (!current.size && !selected.length) {
                        settlement.code = 'invalid';
                        void vscode.window.showInformationMessage('Choose at least one project agent.');
                        await publishSkillScopeActionSettlement(settlement);
                        return;
                    }
                    const result = skillDashboardController.handleSetGlobalSkillProjectAgents(
                        e.dirPath, selected.map(item => item.agent));
                    settlement.ok = result.ok;
                    settlement.code = result.ok ? 'applied' : (result.code || 'failed');
                    settlement.resultDirPath = result.dirPath;
                    if (!result.ok) {
                        void vscode.window.showWarningMessage(`Could not apply the skill to this project: ${result.error}`);
                    }
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }

                const existingGlobal = skillDashboardController.getRecords().find(candidate =>
                    candidate.central && candidate.scope === 'user' && candidate.name === record.name);
                if (existingGlobal && !skillDirectoriesEqual(record.dirPath, existingGlobal.dirPath)) {
                    settlement.code = 'conflict';
                    void vscode.window.showWarningMessage(
                        `A different global skill named "${record.name}" already exists. Rename or reconcile it first.`);
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }
                const choice = await vscode.window.showWarningMessage(
                    existingGlobal
                        ? `Consolidate project skill "${record.name}" into the identical Global skill? `
                            + 'The project source directory will be removed and its existing project links will be preserved.'
                        : `Move project skill "${record.name}" to Global management? `
                            + 'Its source directory will leave this project (and may appear deleted in Git), '
                            + 'while its existing project links keep working. It will not be enabled globally.',
                    { modal: true },
                    existingGlobal ? 'Consolidate into Global' : 'Move to Global',
                );
                if (choice !== (existingGlobal ? 'Consolidate into Global' : 'Move to Global')) {
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }
                const result = skillDashboardController.handleMoveProjectSkillToGlobal(e.dirPath);
                settlement.ok = result.ok;
                settlement.code = result.ok ? 'moved' : (result.code || 'failed');
                settlement.resultDirPath = result.dirPath;
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not move the skill to Global: ${result.error}`);
                }
                await publishSkillScopeActionSettlement(settlement);
                } catch (error) {
                    settlement.ok = false;
                    settlement.code = 'failed';
                    logError('Skill scope action failed unexpectedly.', error);
                    await publishSkillScopeActionSettlement(settlement);
                }
            },
            'central-toggle-skill': e => {
                const result = skillDashboardController.handleCentralToggle(
                    String(e.dirPath || ''),
                    (e.scope === 'project' ? 'project' : 'user') as never,
                    String(e.source || '') as never,
                    e.enabled === true,
                );
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not toggle the skill link: ${result.error}`);
                }
            },
            'folder-toggle-skill-links': e => {
                const result = skillDashboardController.handleFolderToggle(
                    String(e.storeRoot || ''), String(e.folder || ''),
                    (e.scope === 'project' ? 'project' : 'user') as never,
                    String(e.agent || '') as never,
                    e.enabled === true,
                );
                if (!result.ok) {
                    void vscode.window.showWarningMessage(
                        `Some folder links failed: ${result.errors.map(item => item.name).join(', ')}`);
                }
            },
            'move-skill-to-folder': e => {
                const result = skillDashboardController.handleMoveToFolder(String(e.dirPath || ''), String(e.folder || ''));
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not move the skill: ${result.error}`);
                }
            },
            'create-skill-folder': async e => {
                const parentFolder = String(e.parentFolder || '').replace(/^\/+|\/+$/g, '');
                const folder = await vscode.window.showInputBox({
                    prompt: parentFolder
                        ? `New subfolder inside ${parentFolder} (use / for deeper nesting)`
                        : 'New skill folder (use / for nesting, e.g. xiaohongshu/yunxiao)',
                    placeHolder: 'folder or folder/subfolder',
                });
                if (!folder || !folder.trim()) {
                    return;
                }
                const target = parentFolder ? `${parentFolder}/${folder.trim()}` : folder.trim();
                const result = skillDashboardController.handleCreateFolder(
                    e.scope === 'project' ? 'project' : 'user',
                    target,
                );
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not create the folder: ${result.error}`);
                }
            },
            'remove-skill-folder': async e => {
                const folderName = String(e.folder || '');
                const choice = await vscode.window.showWarningMessage(
                    `Delete the folder "${folderName}"? Only empty folders can be deleted.`,
                    { modal: true },
                    'Delete',
                );
                if (choice !== 'Delete') {
                    return;
                }
                const result = skillDashboardController.handleRemoveFolder(String(e.storeRoot || ''), folderName);
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not delete the folder: ${result.error}`);
                }
            },
            'centralize-skill': async e => {
                const dirPath = String(e.dirPath || '');
                const record = skillDashboardController.getRecords()
                    .find(candidate => candidate.dirPath === dirPath && !candidate.central);
                if (record) {
                    // Centralize permanently deletes the losing duplicate copies;
                    // confirm first, naming them and flagging content drift.
                    const duplicates = skillDashboardController.getRecords().filter(candidate =>
                        candidate.scope === record.scope && candidate.name === record.name
                        && candidate.dirPath !== record.dirPath && !candidate.central
                        && (candidate.source === 'kimi' || candidate.source === 'claude' || candidate.source === 'codex'));
                    if (duplicates.length) {
                        const drifted = new Set([record.contentHash || '', ...duplicates.map(copy => copy.contentHash || '')]).size > 1;
                        const choice = await vscode.window.showWarningMessage(
                            `Centralize "${record.name}" into the ${record.scope} store? `
                            + `The other ${duplicates.length} ${record.scope} ${duplicates.length === 1 ? 'copy' : 'copies'} will be deleted permanently:\n`
                            + duplicates.map(copy => copy.dirPath).join('\n')
                            + (drifted ? '\nWarning: the copies have different content; only the clicked copy is kept.' : ''),
                            { modal: true },
                            'Centralize',
                        );
                        if (choice !== 'Centralize') {
                            return;
                        }
                    }
                }
                const result = skillDashboardController.handleCentralize(dirPath);
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not centralize the skill: ${result.error}`);
                }
            },
            'migrate-skills-to-central': e => {
                void runSkillMigrationToCentral(e.scope === 'project' ? 'project' : e.scope === 'user' ? 'user' : undefined);
            },
            'change-global-skills-location': () => {
                void globalStoreLocationController.changeInteractively();
            },
            'fix-skill-diagnostic': e => {
                const result = skillDashboardController.handleFixSkillDiagnostic(
                    String(e.dirPath || ''),
                    String(e.code || '') as never,
                );
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Could not fix the skill: ${result.error}`);
                }
            },
            'open-skill-file': async e => {
                const skillFilePath = String(e.skillFilePath || '');
                if (!skillDashboardController.getRecords().some(record => record.skillFilePath === skillFilePath)) {
                    return;
                }
                await vscode.window.showTextDocument(vscode.Uri.file(skillFilePath));
            },
            'prompt-command': async e => {
                const result = await promptDashboardController.handle(e);
                if (result !== undefined) {
                    await provider.postMessage(result);
                }
            },
            'prompt-insert-terminal': async e => {
                const result = await promptTerminalCommandController.handleInsertRequest(e);
                if (result !== undefined) {
                    await provider.postMessage(result);
                }
            },
            'todo-command': async e => {
                await todoStorageMigration.ready;
                const result = await todoCommandController.handle(e);
                if (result) {
                    await provider.postMessage({
                        ...result,
                        searchCatalog: buildWorkspaceDashboardSearchCatalog(
                            projectService.getGroups(),
                            getOpenWorkspaceCards(),
                            todoService.getSearchItems(),
                            skillDashboardController.getRecords(),
                        ),
                    });
                }
            },
            'todo-add': async e => {
                const valid = typeof e.title === 'string' && Boolean(e.title.trim());
                await runTodoRequestMutation({
                    requestId: e.requestId,
                    valid,
                    mutate: () => todoService.addTodo({
                        title: e.title as string,
                        notes: typeof e.notes === 'string' ? e.notes : '',
                        priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
                        groupId: typeof e.groupId === 'string' ? e.groupId : undefined,
                    }),
                    onSuccess: () => postTodoPanelContent(),
                    postResult: message => provider.postMessage(message),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-add-group': async () => {
                await runTodoPromptMutation({
                    prompt: value => vscode.window.showInputBox({
                        prompt: 'Todo group title',
                        placeHolder: 'Group name',
                        value,
                        ignoreFocusOut: true,
                    }),
                    mutate: title => todoService.addGroup(title),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-toggle': async e => {
                if (typeof e.todoId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.completeTodo(e.todoId as string, e.completed === true));
            },
            'todo-delete': async e => {
                if (typeof e.todoId !== 'string') {
                    return;
                }
                await deleteTodoWithConfirmation({
                    todoId: e.todoId,
                    getData: () => todoService.getData(),
                    confirm: title => vscode.window.showWarningMessage(
                        `Delete TODO "${title}"?`,
                        { modal: true },
                        'Delete'
                    ),
                    deleteTodo: todoId => todoService.deleteTodo(todoId),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-delete-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                const todoGroup = todoService.getData().groups.find(group => group.id === e.groupId);
                if (!todoGroup) {
                    return;
                }
                const confirmed = await vscode.window.showWarningMessage(
                    `Delete TODO group "${todoGroup.title}" and all of its todos?`,
                    { modal: true },
                    'Delete'
                );
                if (confirmed !== 'Delete') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.deleteGroup(e.groupId as string));
            },
            'todo-rename-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await renameTodoGroupWithPrompt({
                    groupId: e.groupId,
                    getData: () => todoService.getData(),
                    prompt: value => vscode.window.showInputBox({
                        prompt: 'Todo group title',
                        value,
                        ignoreFocusOut: true,
                    }),
                    renameGroup: (groupId, title) => todoService.renameGroup(groupId, title),
                    refreshPanel: () => postTodoPanelContent(),
                    showErrorMessage: message => vscode.window.showErrorMessage(message),
                    logError,
                });
            },
            'todo-reorder-groups': async e => {
                if (!Array.isArray(e.groupIds)) {
                    return;
                }
                await runTodoPanelMutation(() => todoService.reorderGroups(e.groupIds as string[]));
            },
            'todo-reorder-items': async e => {
                if (typeof e.groupId !== 'string' || !Array.isArray(e.todoIds)) {
                    return;
                }
                await runTodoPanelMutation(() => todoService.reorderTodos(e.groupId as string, e.todoIds as string[]));
            },
            'todo-collapse-group': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.setGroupCollapsed(e.groupId as string, e.collapsed === true));
            },
            'todo-collapse-groups': async e => {
                await runTodoPanelMutation(() => todoService.setGroupsCollapsed(e.collapsed === true));
            },
            'todo-sort-priority': async e => {
                if (typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.sortGroupByPriority(e.groupId as string));
            },
            'todo-toggle-show-completed': async e => {
                await runTodoPanelMutation(async () => {
                    const persistedViewState = await todoService.setShowCompleted(e.showCompleted === true);
                    todoViewState.showCompleted = persistedViewState.showCompleted;
                    revealedTodoId = undefined;
                });
            },
            'todo-reveal': async e => {
                if (typeof e.todoId !== 'string' || typeof e.groupId !== 'string') {
                    return;
                }
                await runTodoPanelMutation(async () => {
                    const result = await todoService.revealTodo(e.todoId as string, e.groupId as string);
                    if (result.revealed) {
                        revealedTodoId = e.todoId as string;
                    }
                });
            },
            'todo-update': async e => {
                if (typeof e.todoId !== 'string' || typeof e.title !== 'string') {
                    return;
                }
                await runTodoPanelMutation(() => todoService.updateTodo(e.todoId as string, {
                    title: e.title as string,
                    notes: typeof e.notes === 'string' ? e.notes : '',
                    priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
                }));
            },
            'selected-project': async e => {
                let projectId = e.projectId as string;
                let projectOpenType = e.projectOpenType as ProjectOpenType;

                if (projectId.startsWith('__openWorkspaceNavigation-')) {
                    await workspaceNavigationController.open(projectId);
                    return;
                }

                const project = projectService.getProject(projectId);
                if (project == null) {
                    vscode.window.showWarningMessage("Selected Project not found.");
                    return;
                }

                const attentionProject = withAttentionProject(
                    project,
                    aiSessionAttentionController.getEffectiveAggregate()
                );
                await acknowledgeAiSessionAttentionEventIds(attentionProject.aiSessionAttentionEventIds);
                await projectOpenController.openProject(project, projectOpenType);
            },
            'set-open-workspace-pin': e => openWorkspacePinController.handle(e),
            'add-project': async e => {
                await projectMutationController.addProject(e.groupId as string);
            },
            'import-from-other-storage': async () => {
                await projectService.copyProjectsFromFilledStorageOptionToEmptyStorageOption();
                refreshAfterMutation();
            },
            'reordered-projects': async e => {
                await projectOrderController.reorderGroups(e.groupOrders as GroupOrder[]);
            },
            'reordered-favorites': async e => {
                await favoriteProjectController.reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds as string[] : []);
            },
            'remove-project': async e => {
                await projectRemovalController.removeProject(e.projectId as string);
            },
            'edit-project': async e => {
                await projectMutationController.editProject(e.projectId as string);
            },
            'color-project': async e => {
                await projectMutationController.editProjectColor(e.projectId as string);
            },
            'favorite-project': async e => {
                await favoriteProjectController.toggleProjectFavorite(e.projectId as string);
            },
            'toggle-codex-sessions': async e => {
                await aiSessionCommandController.toggleSessionsExpanded(e.projectId as string, Boolean(e.expanded));
            },
            'select-ai-session-providers': async e => {
                await aiSessionCommandController.selectProviders(
                    e.projectId as string,
                    e.selectedProviders,
                    e.requestId,
                    e.version
                );
            },
            'focus-ai-session-terminal': async e => {
                const target = {
                    projectId: e.projectId as string,
                    provider: e.provider as AiSessionProviderId,
                    sessionId: e.sessionId as string,
                };
                const focused =
                    await aiSessionTerminalCommandController.focusActive(
                        target.projectId,
                        target.provider,
                        target.sessionId
                    );
                if (focused) {
                    await conversationCapability.followActiveConversation(
                        target
                    );
                }
            },
            'focus-pending-ai-session': async e => {
                await aiSessionTerminalCommandController.focusPending(
                    e.projectId as string,
                    e.provider as string,
                    e.createdAt as string
                );
            },
            'close-ai-session-terminal': async e => {
                await aiSessionTerminalCommandController.closeTerminal({
                    projectId: e.projectId as string,
                    providerId: e.provider as string,
                    sessionId: e.sessionId as string,
                    pendingCreatedAt: e.pendingCreatedAt as string,
                    expectedBackend: 'vscode',
                });
            },
            'detach-ai-session-terminal': async e => {
                await aiSessionTerminalCommandController.closeTerminal({
                    projectId: e.projectId as string,
                    providerId: e.provider as string,
                    sessionId: e.sessionId as string,
                    pendingCreatedAt: e.pendingCreatedAt as string,
                    expectedBackend: 'tmux',
                });
            },
            'toggle-ai-session-pin': async e => {
                await aiSessionCommandController.togglePin(e.provider as string, e.sessionId as string);
            },
            'acknowledge-ai-session-attention': async e => {
                const attentionEventIds = Array.isArray(e.eventIds) ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
                await acknowledgeAiSessionAttentionEventIds(attentionEventIds);
            },
            'rename-ai-session': async e => {
                await aiSessionCommandController.renameSession(e.provider as string, e.sessionId as string);
            },
            'copy-ai-session-id': async e => {
                await aiSessionCommandController.copySessionId(e.sessionId as string);
            },
            'request-full-refresh': e => {
                logOpenWorkspaceDiagnostic('Renderer', {
                    event: 'full-refresh-requested',
                    reason: typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'unknown',
                });
                refreshStewardViews(typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'webview-requested');
            },
            'open-workspaces-rendered': e => {
                logOpenWorkspaceDiagnostic('Renderer', {
                    event: 'open-workspaces-rendered',
                    semanticRevision: typeof e.semanticRevision === 'string'
                        ? e.semanticRevision.slice(0, 128)
                        : 'invalid',
                    currentWorkspaceCount: (e.currentWorkspaceCount === 0 || e.currentWorkspaceCount === 1)
                        ? e.currentWorkspaceCount as number
                        : -1,
                    navigationWorkspaceCount: Number.isSafeInteger(e.navigationWorkspaceCount)
                        && e.navigationWorkspaceCount >= 0
                        ? e.navigationWorkspaceCount as number
                        : -1,
                    hasOtherWindowsGroup: e.hasOtherWindowsGroup === true,
                    otherWindowsStatus: e.otherWindowsStatus === 'ready'
                        || e.otherWindowsStatus === 'unavailable'
                        || e.otherWindowsStatus === 'update-required'
                        ? e.otherWindowsStatus as string
                        : 'invalid',
                });
            },
            'request-active-ai-session-terminal': () => {
                activeAiSessionTerminalHighlighter.request();
            },
            'request-ai-session-attention-state': () => {
                postAiSessionAttentionState();
            },
            'open-settings': async () => {
                await showAgentPivotSettings();
            },
            'open-bridge-extension': async () => {
                await vscode.commands.executeCommand(
                    'workbench.extensions.action.showExtensionsWithIds',
                    ['hzcheng.agent-pivot-attention-ui-bridge'],
                );
            },
            'archive-ai-sessions': async e => {
                await aiSessionArchiveController.archiveSessions(
                    e.projectId,
                    e.items,
                    e.requestId,
                    e.version
                );
            },
            'edit-group': async e => {
                await groupCommandController.editGroup(e.groupId as string);
            },
            'remove-group': async e => {
                await groupCommandController.removeGroup(e.groupId as string);
            },
            'add-group': async () => {
                await groupCommandController.addGroup();
            },
            'collapse-group': async e => {
                await groupCollapseController.collapseGroup(e.groupId as string, e.collapsed as boolean);
            },
            // Collapse-all is a per-webview convenience action.
            'toggle-all-groups': () => undefined,
        },
        createAiSession: async e => {
            await aiSessionCreationController.createSession(e.projectId as string);
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
        renderContent: webview => getStewardContent(
            context,
            webview,
            projectService.getGroups(),
            stewardInfos,
            true,
            getOpenWorkspaceCards(),
            openWorkspaceDashboardController.getState().otherWindows.status,
        ),
        renderError: getErrorContent,
        onMessage: dashboardMessageRouter,
        onVisibleChanged: async visible => {
            conversationCapability.controller.setVisible(visible);
            projectsPanelController?.invalidatePendingUpdates();
            openWorkspaceDashboardController?.invalidatePendingUpdates();
            setAiSessionWatchersActive(visible);
            activeAiSessionTerminalHighlighter.setVisible(visible);
            if (visible) {
                void tmuxFocusedRuntimeMonitor.request();
            }
            await dashboardRuntimeController.handleAiSessionViewVisibilityChanged(visible);
            deferredTmuxRestoreRefreshReady = true;
            publishDeferredTmuxRestoreIfReady();
        },
        onVisiblePrepared: () =>
            aiSessionDashboardController.refreshNow('dashboard-visible', {
                fallbackToFullRefresh: false,
            }),
        onDisposed: () => {
            deferredTmuxRestoreRefreshReady = false;
            conversationCapability.controller.resetView();
        },
        logError,
    };
    let openWorkspaceBridgeClient: OpenWorkspaceBridgeClient;
    openWorkspaceController = new OpenWorkspaceController({
        getWorkspace: resolveCurrentOpenWorkspace,
        getRunningAiSessionCount: workspace => {
            const executionSnapshot = aiSessionExecutionController.getSnapshot();
            return aiSessionRuntimeCoordinator.getActive().filter(runtime => {
                const sessionId = runtime.identity.sessionId;
                return runtime.identity.workspaceScopeIdentity === workspace.scopeIdentity
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
    openWorkspaceDashboardController = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: getCurrentOpenWorkspace,
        isWorkspaceSavedAsProject: workspace => Boolean(getSavedProjectForWorkspace(workspace)),
        getWorkspaceProjectColor: workspace => getSavedProjectForWorkspace(workspace)?.color || '',
        getCurrentWorkspaceAiSessions: workspace => workspaceSessionHydrationController.hydrate(workspace),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillDashboardController.getRecords(),
        getCollapsed: () => Boolean(groupCollapseController.getOpenWorkspacesCollapsed()),
        getRunningCardAnimation: () => getAgentPivotConfiguration()
            .get<string>('aiSessionRunningCardAnimation', 'current'),
        getRunningIconAnimation: () => getAgentPivotConfiguration()
            .get<string>('aiSessionRunningIconAnimation', 'current'),
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
    openWorkspaceBridgeClient = ownResource(() => new OpenWorkspaceBridgeClient(
        openWorkspaceController.getPublication(),
        aggregate => {
            const statusChanged = openWorkspaceDashboardController.setBridgeStatus('ready');
            if (openWorkspaceDashboardController.setAggregate(aggregate) || statusChanged) {
                postOpenWorkspacesUpdated();
            }
        },
        error => logOpenWorkspaceBridgeError(error),
        {
            reportDiagnostic: event => logOpenWorkspaceDiagnostic('Workspace', event),
            reportBridgeDiagnostic: event => logOpenWorkspaceDiagnostic('Bridge', event),
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
        }
    ));
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
        publish: identity => postActiveAiSessionTerminalChanged(identity),
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
    ownTimer(
        () => setInterval(() => {
            const completedSessions = aiSessionTerminalService.getCompletedSessions();
            const completedRuntimes = completedSessions.filter(resolution =>
                !!resolution.entry.runtimeIdentity).map(resolution => ({
                    identity: cloneAiSessionRuntimeIdentity(resolution.entry.runtimeIdentity),
                    backend: 'vscode',
                    state: 'completed',
                    markerPath: resolution.entry.markerPath,
                    runStartedAtMs: resolution.entry.runStartedAtMs,
                    attached: true,
                    terminal: resolution.terminal,
                } as AiSessionRuntimeSnapshot<vscode.Terminal>));
            const inactiveTmuxRuntimes = tmuxRuntimeDiscovery.getInactive()
                .map(runtime => runtime as AiSessionRuntimeSnapshot<vscode.Terminal>);
            queueAiSessionRuntimeSettlements([...completedRuntimes, ...inactiveTmuxRuntimes]);
        }, 1_000),
        handle => clearInterval(handle),
    );

    ownResource(() =>
        vscode.window.onDidChangeActiveTerminal(() => {
            activeAiSessionTerminalHighlighter.sync();
            void tmuxFocusedRuntimeMonitor.request();
            refreshAiSessionViewsIncrementally();
            void runSafeAiSessionRuntimeLifecycleTask(
                'evaluate-attention-active-terminal', evaluateAiSessionAttention
            );
        }));
    ownResource(() =>
        vscode.window.onDidCloseTerminal(terminal => {
            const closedRuntimes = aiSessionRuntimeCoordinator.getActive()
                .filter(runtime => runtime.backend === 'vscode' && runtime.terminal === terminal
                    && Boolean(runtime.identity.sessionId));
            const exitStatus = terminal.exitStatus as
                (vscode.TerminalExitStatus & { reason?: number }) | undefined;
            const userClosedTerminal = exitStatus?.reason === USER_TERMINAL_EXIT_REASON;
            const closedSessions: ActiveAiSessionTerminalIdentity[] = closedRuntimes.map(runtime => ({
                provider: runtime.identity.provider,
                sessionId: runtime.identity.sessionId as string,
                workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
            }));
            const hadRuntimeClient = [...aiSessionRuntimeCoordinator.getActive(), ...aiSessionRuntimeCoordinator.getPending()]
                .some(runtime => runtime.terminal === terminal);
            aiSessionRuntimeCoordinator.handleClosedTerminal(terminal);
            evaluateAiSessionLifecycleTick();
            activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal);
            if (closedSessions.length || hadRuntimeClient) {
                refreshAiSessionViewsIncrementally();
                if (userClosedTerminal) {
                    void runSafeAiSessionRuntimeLifecycleTask(
                        'acknowledge-user-terminal-close',
                        async () => {
                            for (const identity of closedSessions) {
                                await acknowledgeAiSessionAttention(identity);
                            }
                        }
                    );
                }
                void runSafeAiSessionRuntimeLifecycleTask(
                    'evaluate-attention-closed-terminal', evaluateAiSessionAttention
                );
            }
        }));

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
        get skills() { return skillDashboardController.getRecords() },
    };
    projectsPanelController = new ProjectsPanelController({
        getGroups: () => projectService.getGroups(),
        getSearchCatalog: () => buildWorkspaceDashboardSearchCatalog(
            projectService.getGroups(),
            getOpenWorkspaceCards(),
            todoService.getSearchItems(),
            skillDashboardController.getRecords(),
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
            todoStorageMigration.ready = todoMigration.then(() => undefined, () => undefined);
            const [projects, todos] = await Promise.all([projectMigration, todoMigration]);
            return { projects, todos };
        },
        refreshDashboard: () => provider.refresh(),
        publishOpenWorkspace: () => openWorkspaceController.publish(),
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showErrorMessage: message => vscode.window.showErrorMessage(message),
        logError,
        showAgentPivot,
        applyProjectColorToCurrentWindow,
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
                await globalStoreLocationController.handleConfigurationChange();
            }
            if (event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTerminalMode`)
                || event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTmuxLayout`)
                || event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.aiSessionTmuxPath`)) {
                await handleAiSessionRuntimeConfigurationChanged();
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
        applyProjectColorToCurrentWindow,
        refresh: refreshStewardViews,
        refreshProjects: () => postProjectSurfacesUpdated('replace'),
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
        addProject: () => projectMutationController.addProject(),
        saveProject: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
        removeProject: () => projectRemovalController.removeProjectPerCommand(),
        editProjects: () => projectManualEditController.editProjectsManually(),
        addGroup: () => groupCommandController.addGroup(),
        removeGroup: () => groupCommandController.removeGroupPerCommand(),
        addProjectsFromFolder: () => addProjectsFromFolderController.addProjectsFromFolder(),
        addFileToActiveTerminal: () => activeTerminalFileReferenceController.addFileToActiveTerminal(),
        insertPromptToActiveTerminal: () => promptTerminalCommandController.insertPromptToActiveTerminal(),
        migrateSkillsToCentral: () => runSkillMigrationToCentral(),
        changeGlobalSkillsLocation: () =>
            globalStoreLocationController.changeInteractively(),
        openCurrentAiSessionConversation: () => openCurrentAiSessionConversation(),
    };

    ownResource(() => vscode.workspace.onDidChangeConfiguration(
        event => dashboardLifecycleController.handleConfigurationChange(event)
    ));

    ownResource(() => vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${AGENT_PIVOT_CONFIG_SECTION}.notify`)) {
            void refreshNotifyConfig();
        }
    }));

    ownResource(() => vscode.workspace.onDidChangeWorkspaceFolders(() => {
        dashboardLifecycleController.handleWorkspaceFoldersChanged();
    }));

    ownResource(() => vscode.window.onDidChangeWindowState(windowState => {
        dashboardLifecycleController.handleWindowStateChanged(windowState);
    }));

    await timeBootstrapPhase('startup-sequence', () =>
        dashboardStartupController.startUp());
    resources.assertActive();
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

    async function evaluateAiSessionAttention(
        runtimeOverrides: ReadonlyArray<{
            providerId: AiSessionProviderId;
            sessionId: string;
            attentionKey: string;
            runtime: AiSessionRuntimeSnapshot<vscode.Terminal>;
        }> = []
    ): Promise<AiSessionAttentionEvaluation> {
        try {
            await tmuxRuntimeDiscovery.loadPersistedInactive();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-inactive-restore', error);
        }
        const hasRelevantTmux = await hasRelevantTmuxRuntime();
        if (hasRelevantTmux && await hasLiveTmuxOwnership()) {
            try {
                await aiSessionRuntimeCoordinator.refreshForHost(false);
            } catch (error) {
                logAiSessionRuntimeFailure('attention-refresh', error);
            }
        }
        return aiSessionAttentionController.evaluate(runtimeOverrides);
    }

    async function hasLiveTmuxOwnership(): Promise<boolean> {
        if (aiSessionRuntimeConfiguration.mode === 'tmux'
            || tmuxRuntimeDiscovery.getActive().length
            || tmuxRuntimeDiscovery.getPending().length
            || tmuxRuntimeBackend.getConflicts().length) {
            return true;
        }
        try {
            const [known, pending] = await Promise.all([
                tmuxRuntimeStore.listKnown(),
                tmuxRuntimeStore.listPending(),
            ]);
            return known.length > 0 || pending.length > 0;
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    async function hasRelevantTmuxRuntime(): Promise<boolean> {
        if (tmuxRuntimeDiscovery.getInactive().length) {
            return true;
        }
        try {
            const inactive = await tmuxRuntimeStore.listInactive();
            return inactive.length > 0 || await hasLiveTmuxOwnership();
        } catch (error) {
            logAiSessionRuntimeFailure('attention-relevance', error);
            return true;
        }
    }

    function getAiSessionRuntimeById(
        providerId: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        const workspaceScopeIdentity = getCurrentOpenWorkspace()?.scopeIdentity;
        if (!workspaceScopeIdentity) {
            return null;
        }
        const collision = getAiSessionRuntimeCollision(
            providerId, sessionId, workspaceScopeIdentity
        );
        if (collision) {
            return collision;
        }
        const live = aiSessionRuntimeCoordinator.getById(
            providerId, sessionId, workspaceScopeIdentity
        );
        if (live) {
            return live;
        }
        const liveConflicts = aiSessionRuntimeCoordinator.getActive().filter(runtime =>
            runtime.identity.provider === providerId && runtime.identity.sessionId === sessionId
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity);
        if (liveConflicts.length > 1) {
            return { ...liveConflicts[0], state: 'conflict' };
        }
        const inactiveTmux: AiSessionRuntimeSnapshot<vscode.Terminal>[] = tmuxRuntimeDiscovery.getInactive()
            .filter(runtime => runtime.identity.provider === providerId
                && runtime.identity.sessionId === sessionId
                && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity)
            .map(runtime => {
                const { terminal: _terminal, ...detached } = runtime;
                return {
                    ...detached,
                    identity: cloneAiSessionRuntimeIdentity(runtime.identity),
                    ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
                };
            });
        const completedDirect = aiSessionTerminalService.getTrackedTerminalEntries()
            .filter(entry => entry.provider === providerId && entry.sessionId === sessionId
                && aiSessionTerminalService.isComplete(entry) && !!entry.runtimeIdentity
                && entry.runtimeIdentity.workspaceScopeIdentity === workspaceScopeIdentity)
            .map(entry => ({
                identity: cloneAiSessionRuntimeIdentity(entry.runtimeIdentity),
                backend: 'vscode' as const,
                state: 'completed' as const,
                markerPath: entry.markerPath,
                runStartedAtMs: entry.runStartedAtMs,
                attached: true,
                terminal: entry.terminal,
            }));
        const inactive = [...inactiveTmux, ...completedDirect];
        return inactive.length === 1 ? inactive[0] : null;
    }

    function getAiSessionRuntimeCollision(
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ): AiSessionRuntimeSnapshot<vscode.Terminal> | null {
        return findTmuxCollisionRuntime(
            tmuxRuntimeDiscovery.getDiagnostics(), providerId, sessionId,
            workspaceScopeIdentity
        ) as AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    }

    function getFocusedAiSessionRuntimeIdentity() {
        const activeTerminal = vscode.window.activeTerminal || null;
        const tmuxRuntime = tmuxRuntimeBackend.getFocusedRuntime(activeTerminal);
        return tmuxRuntime && runtimeBelongsToCurrentWorkspace(tmuxRuntime)
            ? tmuxRuntime.identity
            : activeAiSessionTerminalHighlighter.getIdentity();
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
        const result = await conversationCapability.openLatestConversation({
            projectId: target.cardId,
            provider: selected.provider,
            sessionId: selected.sessionId,
        });
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
    }

    function runtimeBelongsToCurrentWorkspace(
        runtime: AiSessionRuntimeSnapshot<vscode.Terminal>
    ): boolean {
        const workspaceScopeIdentity = getCurrentOpenWorkspace()?.scopeIdentity;
        return !!workspaceScopeIdentity
            && runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity;
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

    function scheduleAttentionViewsRefresh() {
        scheduleAiSessionRefresh('attention');
        openWorkspaceDashboardController?.postUpdated();
    }

    function setAiSessionWatchersActive(active: boolean) {
        aiSessionDashboardController.setWatchersActive(active);
    }

    function scheduleNewAiSessionRefresh(providerId: AiSessionProviderId) {
        aiSessionDashboardController.scheduleNewSessionRefresh(providerId);
    }

    function refreshAiSessionViewsIncrementally() {
        void aiSessionDashboardController.refreshNow();
    }

    function publishDeferredTmuxRestoreIfReady(): void {
        if (!deferredTmuxRestoreSettled
            || !deferredTmuxRestoreRefreshReady
            || deferredTmuxRestoreRefreshPublished
            || !provider.visible) {
            return;
        }
        try {
            resources.assertActive();
        } catch (_error) {
            return;
        }
        deferredTmuxRestoreRefreshPublished = true;
        void aiSessionDashboardController.refreshNow('tmux-bootstrap-restore');
    }

    function postAiSessionAttentionState() {
        void provider.postMessage({
            type: 'ai-session-attention-state',
            sessionEvents: aiSessionAttentionController.getRecoverySessionEvents(),
            eventIds: aiSessionAttentionController.getAttentionEventIds(),
        });
    }

    function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
        dashboardRuntimeController.postBatchArchiveCompletion(message);
    }

    function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
        void conversationCapability.reconcile();
        dashboardRuntimeController.postActiveAiSessionTerminalChanged(identity);
    }

    async function postTodoPanelContent(requestId?: number) {
        let html: string;
        let snapshot: ReturnType<typeof buildTodoPanelSnapshot> | undefined;
        try {
            await todoStorageMigration.ready;
            const unsupportedVersionError = todoService.getUnsupportedVersionError();
            if (unsupportedVersionError) {
                throw unsupportedVersionError;
            }
            const todoData = todoService.getData();
            const config = getAgentPivotConfiguration();
            const todoRenderOptions = {
                maxVisibleTodosPerGroup: getMaxVisibleTodosPerGroup(config),
            };
            snapshot = buildTodoPanelSnapshot(todoData, todoViewState, revealedTodoId);
            html = getTodoPanelContent(
                buildTodoViewModel(todoData, todoViewState, revealedTodoId),
                todoRenderOptions,
            );
        } catch (error) {
            if (!(error instanceof UnsupportedTodoDataVersionError)) {
                throw error;
            }
            html = getUnsupportedTodoVersionPanelContent(error.version);
        }
        await provider.postMessage(requestId
            ? {
                type: 'todo-panel-content',
                version: 1,
                requestId,
                html,
                ...(snapshot ? { snapshot } : {}),
                searchCatalog: buildWorkspaceDashboardSearchCatalog(
                    projectService.getGroups(),
                    getOpenWorkspaceCards(),
                    todoService.getSearchItems(),
                    skillDashboardController.getRecords(),
                ),
            }
            : {
                type: 'todo-panel-updated',
                version: 1,
                html,
                ...(snapshot ? { snapshot } : {}),
                searchCatalog: buildWorkspaceDashboardSearchCatalog(
                    projectService.getGroups(),
                    getOpenWorkspaceCards(),
                    todoService.getSearchItems(),
                    skillDashboardController.getRecords(),
                ),
            });
    }

    function getMaxVisibleTodosPerGroup(config: vscode.WorkspaceConfiguration): number {
        const configuredItems = config.get('maxVisibleTodosPerGroup', 5);
        const visibleItems = Math.floor(Number(configuredItems));
        return Number.isFinite(visibleItems) && visibleItems > 0 ? visibleItems : 5;
    }

    async function runTodoPanelMutation(mutate: () => Promise<unknown>): Promise<boolean> {
        return runTodoMutation({
            mutate,
            onSuccess: () => postTodoPanelContent(),
            showErrorMessage: message => vscode.window.showErrorMessage(message),
            logError,
        });
    }

    function invalidateAiSessionCache(providerId: AiSessionProviderId) {
        getRegisteredAiSessionProvider(providerId)?.service.invalidateCache();
    }

    function postProjectSurfacesUpdated(mode: ProjectsPanelUpdateMode): void {
        projectsPanelController?.postUpdated(mode);
        openWorkspaceDashboardController.postUpdated();
    }

    function refreshAfterMutation(mode: ProjectsPanelUpdateMode = 'replace') {
        postProjectSurfacesUpdated(mode);
        applyProjectColorToCurrentWindow();
        openWorkspaceController.publish();
    }

    function applyProjectColorToCurrentWindow(project: Project = null) {
        dashboardRuntimeController.applyProjectColorToCurrentWindow(project);
    }

    async function showAgentPivotSettings() {
        await dashboardRuntimeController.openSettings();
    }

    function isFolderGitRepo(fPath: string) {
        return gitRepositoryDetector.isGitRepositoryPath(fPath);
    }

    function getOpenWorkspaceCards() {
        return openWorkspaceDashboardController.getCards();
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
}
