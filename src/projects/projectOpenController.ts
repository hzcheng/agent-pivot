'use strict';

import * as path from 'path';
import type * as vscode from 'vscode';

import { WSL_DEFAULT_REGEX } from '../constants';
import { getRemoteType, Project, ProjectOpenType, ProjectPathType, ProjectRemoteType, ReopenStewardReason, sanitizeProjectName } from '../models';
import { projectPathMatchesWorkspaceUri } from './openProjectMatcher';
import { isUriString } from './openProjectService';
import {
    SAVED_PROJECT_NAVIGATE_COMMAND,
    SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
    validateSavedProjectNavigationOutcome,
} from './projectNavigationProtocol';
import { getWorkspaceUris } from './workspaceHelpers';

export interface ProjectOpenControllerOptions {
    getWorkspaceFile: () => vscode.Uri | null | undefined;
    getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | readonly { uri: vscode.Uri }[] | null | undefined;
    getPrependVscodeUrlToWslRemotes: () => boolean;
    getProjectPathType: (projectPath: string) => Promise<ProjectPathType>;
    getFoldersFromWorkspaceFile: (workspaceFilePath: string) => Promise<string[]>;
    showWarningMessage: (message: string) => unknown;
    showInformationMessage: (message: string) => unknown;
    showErrorMessage: (message: string) => unknown;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
    updateWorkspaceFolders: (start: number, deleteCount: number | null, ...workspaceFoldersToAdd: { uri: vscode.Uri; name?: string }[]) => boolean;
    updateReopenReason: (reason: ReopenStewardReason) => unknown;
    fileUri: (projectPath: string) => vscode.Uri;
    parseUri: (projectPath: string) => vscode.Uri;
}

export class ProjectOpenController {
    constructor(private readonly options: ProjectOpenControllerOptions) {
    }

    async openProject(project: Project, projectOpenType: ProjectOpenType): Promise<void> {
        let remoteType = getRemoteType(project);
        let projectPath = (project.path || '').trim();

        if (!path.isAbsolute(projectPath)
            && !path.win32.isAbsolute(projectPath)
            && !projectPath.includes("://")) {
            let rootPath = this.options.getWorkspaceFile()?.path || this.options.getWorkspaceFolders()?.[0]?.uri.path;
            if (rootPath) {
                projectPath = path.join(rootPath, projectPath);
            } else {
                this.options.showWarningMessage("Tried to open a project with a relative path, but no workspace is open.");
                return;
            }
        }

        if (remoteType !== ProjectRemoteType.None && !isUriString(projectPath) && !projectPath.match(WSL_DEFAULT_REGEX)) {
            remoteType = ProjectRemoteType.None;
        }

        if (projectOpenType === ProjectOpenType.Default) {
            if (this.projectPathMatchesCurrentWorkspace(projectPath)) {
                return;
            }

            projectOpenType = ProjectOpenType.NewWindow;
        }

        if (projectOpenType === ProjectOpenType.CurrentWindow) {
            if (this.projectPathMatchesCurrentWorkspace(projectPath)) {
                return;
            }
        }

        var openInNewWindow = projectOpenType === ProjectOpenType.NewWindow;

        if (projectOpenType === ProjectOpenType.AddToWorkspace && remoteType === ProjectRemoteType.None) {
            const uri = isUriString(projectPath)
                ? this.options.parseUri(projectPath)
                : this.options.fileUri(projectPath);
            await this.addToWorkspace(project, uri);
            return;
        }

        if (remoteType === ProjectRemoteType.WSL
            && this.options.getPrependVscodeUrlToWslRemotes()
            && projectPath.match(WSL_DEFAULT_REGEX)) {
            projectPath = `vscode-remote://wsl+${projectPath.replace(WSL_DEFAULT_REGEX, '')}`;
        }

        validateSavedProjectNavigationOutcome(await this.options.executeCommand(
            SAVED_PROJECT_NAVIGATE_COMMAND,
            {
                protocolVersion: SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
                projectPath,
                remoteType,
                openInNewWindow,
            },
        ));
    }

    private projectPathMatchesCurrentWorkspace(projectPath: string): boolean {
        return getWorkspaceUris(this.options.getWorkspaceFile(), this.options.getWorkspaceFolders())
            .some(workspaceUri => projectPathMatchesWorkspaceUri(projectPath, workspaceUri));
    }

    private async addToWorkspace(project: Project, uri: vscode.Uri): Promise<void> {
        let wsToAdd: { uri: vscode.Uri, name?: string }[];
        let projectPathType = await this.options.getProjectPathType(uri.fsPath);

        switch (projectPathType) {
            case ProjectPathType.Folder:
                let name = sanitizeProjectName(project.name);
                wsToAdd = [{ uri, name }];
                break;
            case ProjectPathType.WorkspaceFile:
                try {
                    let folderPaths = await this.options.getFoldersFromWorkspaceFile(uri.fsPath);
                    wsToAdd = folderPaths.map(folderPath => ({ uri: this.options.fileUri(folderPath) }));
                } catch (e) {
                    console.error(e);
                    this.options.showErrorMessage("Could not read the project's workspace file.");
                    return;
                }
                break;
            default:
                this.options.showInformationMessage("A file project cannot be added to the workspace.");
                return;
        }

        let workspaceFolders = new Set((this.options.getWorkspaceFolders() || []).map(workspaceFolder => path.normalize(workspaceFolder.uri.fsPath)));
        wsToAdd = wsToAdd.filter(workspaceFolder => {
            return !workspaceFolders.has(path.normalize(workspaceFolder.uri.fsPath));
        });

        if (!wsToAdd.length) {
            return;
        }

        let isNewWorkSpace = !this.options.getWorkspaceFile();
        let couldOpen = this.options.updateWorkspaceFolders(
            workspaceFolders.size,
            null,
            ...wsToAdd,
        );

        if (!couldOpen) {
            this.options.showErrorMessage('Could not add project to workspace.');
        } else if (isNewWorkSpace) {
            this.options.updateReopenReason(ReopenStewardReason.EditorReopenedAsWorkspace);
        }
    }
}
