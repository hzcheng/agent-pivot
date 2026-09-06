'use strict';

import * as vscode from 'vscode';

import { CurrentProjectDetailsResolver } from '../../projects/currentProjectDetails';
import { MachineRenameController } from '../../projects/machineRenameController';
import { FavoriteProjectController } from '../../projects/favoriteProjectController';
import { GroupCommandController } from '../../projects/groupCommandController';
import { queryGroupName } from '../../projects/groupPrompts';
import { ProjectMutationController } from '../../projects/projectMutationController';
import { ProjectOpenController } from '../../projects/projectOpenController';
import { ProjectOrderController } from '../../projects/projectOrderController';
import { ProjectPromptController } from '../../projects/projectPromptController';
import { ProjectRemovalController } from '../../projects/projectRemovalController';
import RemoteProjectResolver from '../../projects/remoteProjectResolver';
import { createProjectSurfaceRefresh } from '../../projects/projectMessageHandlers';
import { getWorkspacePath as resolveWorkspacePath } from '../../projects/workspaceHelpers';
import { GroupCollapseController } from '../groupCollapseController';
import { USER_CANCELED, REOPEN_KEY } from '../../constants';
import type { Project, StewardInfos } from '../../models';
import type ColorService from '../../services/colorService';
import type ProjectService from '../../services/projectService';
import type FileService from '../../services/fileService';
import type GitRepositoryDetector from '../../projects/gitRepositoryDetector';
import type { OpenWorkspaceController } from '../../openWorkspaces/workspaceController';
import type { OpenWorkspaceDashboardController } from '../../openWorkspaces/dashboardController';
import type { ProjectsPanelController } from '../projectsPanelController';
import type { DashboardRuntimeController } from '../runtimeController';

/**
 * Composition section (MOD-DASHBOARD-SHELL): the project catalog controllers
 * and resolvers. Extracted from the composition root; construction order and
 * closure timing are unchanged (late-bound collaborators arrive as getters).
 */
export interface ProjectControllersDeps {
    context: vscode.ExtensionContext;
    logError: (message: string, error: unknown) => void;
    colorService: ColorService;
    projectService: ProjectService;
    fileService: FileService;
    gitRepositoryDetector: GitRepositoryDetector;
    getStewardInfos: () => StewardInfos;
    getProjectsPanelController: () => ProjectsPanelController | undefined;
    getOpenWorkspaceDashboardController: () => OpenWorkspaceDashboardController;
    publishOpenWorkspace: () => void;
    applyProjectColorToCurrentWindow: (project: Project | null) => void;
    revealDashboard: () => void;
}

export function createProjectControllers(deps: ProjectControllersDeps) {
    const {
        context, logError, colorService, projectService, fileService, gitRepositoryDetector,
    } = deps;
    const isFolderGitRepo = (projectPath: string) =>
        gitRepositoryDetector.isGitRepositoryPath(projectPath);

    const projectSurface = createProjectSurfaceRefresh({
        getProjectsPanelController: deps.getProjectsPanelController,
        getOpenWorkspaceDashboardController: deps.getOpenWorkspaceDashboardController,
        publishOpenWorkspace: deps.publishOpenWorkspace,
        syncProjectColorToCurrentWindow: project =>
            deps.applyProjectColorToCurrentWindow(project),
    });
    const groupCollapseController = new GroupCollapseController({
        state: context.globalState,
        projectService,
    });
    const machineRenameController = new MachineRenameController({
        getGroups: () => projectService.getGroups(),
        saveGroups: groups => projectService.saveGroups(groups),
        showInputBox: options => vscode.window.showInputBox(options),
        showWarningMessage: message => vscode.window.showWarningMessage(message),
        refreshAfterMutation: projectSurface.refreshAfterMutation,
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
    const projectOpenController = new ProjectOpenController({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getPrependVscodeUrlToWslRemotes: () => deps.getStewardInfos().config.prependVscodeUrlToWslRemotes,
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
        getRemoteSshExtensionInstalled: () => deps.getStewardInfos().relevantExtensionsInstalls.remoteSSH,
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
        postCommandRemoval: () => { deps.revealDashboard(); },
    });
    const remoteProjectResolver = new RemoteProjectResolver(logError);
    const currentProjectDetailsResolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => vscode.workspace.workspaceFile,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getRemoteName: () => vscode.env.remoteName,
        getProjectDetailsForSave: (workspaceUri, remoteName) => remoteProjectResolver.getProjectDetailsForSave(workspaceUri, remoteName),
    });

    return {
        projectSurface,
        groupCollapseController,
        machineRenameController,
        groupCommandController,
        projectOpenController,
        projectPromptController,
        projectMutationController,
        favoriteProjectController,
        projectOrderController,
        projectRemovalController,
        remoteProjectResolver,
        currentProjectDetailsResolver,
    };
}
