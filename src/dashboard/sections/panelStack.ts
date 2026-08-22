'use strict';

import * as os from 'os';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

import { PromptService } from '../../prompts/service';
import { PromptDashboardController } from '../../prompts/dashboardController';
import { getPromptSurfaceContent, getAiPanelContent } from '../../prompts/webviewContent';
import { createSkillPanelCapability } from '../../skills/skillPanelCapability';
import { SkillGroupStore } from '../../skills/skillGroupStore';
import { getSkillsPanelContent } from '../../skills/webviewSkillContent';
import { buildWorkspaceDashboardSearchCatalog } from '../../webview/dashboardViewModel';
import { getAgentPivotConfiguration } from '../../configuration';
import type { WorkspaceCardViewModel } from '../../models';
import type { AgentPivotViewProvider } from '../viewProvider';
import type ProjectService from '../../services/projectService';
import type { DashboardBootstrapResources } from '../bootstrapResources';

/**
 * Composition section (MOD-DASHBOARD-SHELL): the prompt and skill
 * panel stack. Extracted from the composition root; remaining construction
 * and ownResource registration order are unchanged.
 */
export interface PanelStackDeps {
    context: vscode.ExtensionContext;
    provider: AgentPivotViewProvider;
    resources: DashboardBootstrapResources;
    ownResource: <T extends { dispose(): unknown }>(factory: () => T) => T;
    timeBootstrapPhase: <T>(phase: string, run: () => T | Promise<T>) => Promise<T>;
    logError: (message: string, error: unknown) => void;
    logDashboardDiagnostic: (event: Record<string, unknown>) => void;
    projectService: ProjectService;
    promptStore: { readSetting: () => unknown; writeGlobalSetting: (value: unknown) => Promise<void> };
    getOpenWorkspaceCards: () => WorkspaceCardViewModel[];
}

export interface PanelStack {
    promptService: PromptService;
    promptDashboardController: PromptDashboardController;
    skillPanel: ReturnType<typeof createSkillPanelCapability>;
}

export function createPanelStack(deps: PanelStackDeps): PanelStack {
    const {
        context, provider, ownResource, timeBootstrapPhase,
        logError, logDashboardDiagnostic, projectService, promptStore, getOpenWorkspaceCards,
    } = deps;

    const promptService = new PromptService({
        readSetting: promptStore.readSetting,
        writeGlobalSetting: promptStore.writeGlobalSetting,
        createId: () => randomBytes(16).toString('hex'),
        logDiagnostic: event => logDashboardDiagnostic({ event: 'prompt-store', ...event }),
    });
    const getWorkspaceRootPaths = (): string[] =>
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
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
    return {
        promptService,
        promptDashboardController,
        skillPanel,
    };
}
