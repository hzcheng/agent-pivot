'use strict';
import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { Project, ProjectRemoteType, StewardInfos, ReopenStewardReason, AiSessionProviderId, isAiSessionProviderId } from './models';
import { getProjectsPanelContent, getStewardContent } from './webview/webviewContent';
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
import AiSessionAliasController from './aiSessions/aliasController';
import AiSessionPinStore from './aiSessions/pinStore';
import AiSessionPinController from './aiSessions/pinController';
import {
    ConversationCommentFileStore,
} from './aiSessions/conversation/commentStore';
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
import { getLogicalAttentionSessionKey } from './aiSessions/attentionProject';
import type { ActiveAiSessionTerminalIdentity } from './aiSessions/activeTerminalHighlight';
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
import { WorkspaceSessionHydrationController } from './workspaces/sessionHydrationController';
import type { OpenWorkspace } from './workspaces/types';
import { buildWorkspaceDashboardSearchCatalog } from './webview/dashboardViewModel';

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
    const conversationCommentStore = new ConversationCommentFileStore(
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
                        projectId: getCurrentWorkspaceConversationProjectId(
                            binding.workspaceScopeIdentity
                        ),
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
            const projectId = getCurrentWorkspaceConversationProjectId(
                previous.workspaceScopeIdentity
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceScopeIdentity !== next.workspaceScopeIdentity) {
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
            const projectId = getCurrentWorkspaceConversationProjectId(
                previous.workspaceScopeIdentity
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceScopeIdentity !== next.workspaceScopeIdentity) {
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
    const aiSessionAttentionEvent = ownResource(() => createAiSessionAttentionEventCapability({
        tmuxRuntimeDiscovery,
        tmuxRuntimeBackend,
        tmuxRuntimeStore,
        aiSessionTerminalService,
        getRuntimeConfiguration: () => aiSessionRuntimeConfiguration,
        getCurrentOpenWorkspace: () => getCurrentOpenWorkspace(),
        getActiveTerminal: () => vscode.window.activeTerminal || null,
        postMessage: message => { void provider.postMessage(message); },
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
    const postAiSessionAttentionState = aiSessionAttentionEvent.postAttentionState;
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
    const {
        aiSessionCommandController,
        aiSessionCreationController,
        aiSessionArchiveController,
        aiSessionTerminalCommandController,
        aiSessionResumeController,
    } = createSessionControllerComposition({
        getCurrentWorkspaceActionTarget,
        getCurrentOpenWorkspace,
        getRegisteredAiSessionProvider,
        getRegisteredAiSessionProviders,
        getAiSessionRuntimeById,
        getAiSessionRuntimeCollision,
        getLaunchOptions: () => readAiSessionLaunchOptions(vscode.workspace),
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
    let aiSessionUpdateSequence = 0;
    let currentAiSessionRefreshReason = 'refresh';
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
    const aiSessionDashboardController = ownResource(() => new AiSessionDashboardController({
        providerIds: aiSessionProviders.map(provider => provider.id),
        isVisible: () => provider.visible,
        invalidateCache: providerId => invalidateAiSessionCache(providerId),
        watchSessionChanges: (providerId, onDidChange) => getRegisteredAiSessionProvider(providerId).service.watchSessionChanges(onDidChange),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillPanel.getRecords(),
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
            aiSessionAttentionController.invalidateWorkspaceTarget();
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
            return activeSession
                ? withConversationDisplayMetadata(
                    activeSession,
                    activeSessions
                )
                : null;
        },
        resolveActiveTargets: projectId =>
            getCurrentWorkspaceActionTarget(projectId)
                ?.sessions.activeSessions || [],
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
        bookmarkStore: conversationViewerBookmarkStore,
        resolveReboundTarget: target =>
            conversationSessionRebindCoordinator.resolve(target),
        getShowThinking: () => getAgentPivotConfiguration()
            .get<unknown>('aiConversation.showThinking', false) === true,
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
        postAiSessionAttentionState,
        showAgentPivotSettings,
        showBridgeExtension: () => vscode.commands.executeCommand(
            'workbench.extensions.action.showExtensionsWithIds',
            ['hzcheng.agent-pivot-attention-ui-bridge'],
        ),
    });

    const dashboardMessageRouter = createDashboardMessageRouter({
        getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id),
        saveCurrentWorkspace: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace(),
        handlers: {
            ...conversationHandlers,
            ...todoPanel.handlers,
            ...projectHandlers,
            ...skillPanel.handlers,
            ...dashboardMessageHandlers,
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
        onMessage: message => messageRequiresStorageMigration(message)
            ? runAfterStorageMigration(() => dashboardMessageRouter(message))
            : dashboardMessageRouter(message),
        onVisibleChanged: async visible => {
            projectsPanelController?.invalidatePendingUpdates();
            openWorkspaceDashboardController?.invalidatePendingUpdates();
            setAiSessionWatchersActive(visible);
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
        getWorkspaceProjectName: workspace => getSavedProjectForWorkspace(workspace)?.name || '',
        getCurrentWorkspaceAiSessions: workspace => workspaceSessionHydrationController.hydrate(workspace),
        getGroups: () => projectService.getGroups(),
        getTodoSearchItems: () => todoService.getSearchItems(),
        getSkillRecords: () => skillPanel.getRecords(),
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
    resources.own({
        dispose: () => {
            if (activeOpenWorkspaceBridgeClient === openWorkspaceBridgeClient) {
                activeOpenWorkspaceBridgeClient = null;
            }
        },
    });
    activeOpenWorkspaceBridgeClient = openWorkspaceBridgeClient;
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
        await openAiSessionConversationWithFeedback({
            projectId: target.cardId,
            provider: selected.provider,
            sessionId: selected.sessionId,
        });
    }

    async function openAiSessionConversationWithFeedback(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<void> {
        const result = await conversationCapability.openLatestConversation(target);
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

    function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
        void conversationCapability.reconcile();
        dashboardRuntimeController.postActiveAiSessionTerminalChanged(identity);
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
    const openWorkspaceClient = activeOpenWorkspaceBridgeClient;
    activeOpenWorkspaceBridgeClient = null;
    await openWorkspaceClient?.shutdown();
}

function getCurrentWorkspaceConversationProjectId(
    workspaceScopeIdentity: unknown
): string | null {
    if (typeof workspaceScopeIdentity !== 'string'
        || workspaceScopeIdentity.length === 0
        || workspaceScopeIdentity.length > 512
        || /[\u0000-\u001f\u007f]/.test(workspaceScopeIdentity)) {
        return null;
    }
    const digest = createHash('sha256')
        .update(workspaceScopeIdentity)
        .digest('hex')
        .slice(0, 24);
    return `__currentWorkspace-${digest}`;
}
