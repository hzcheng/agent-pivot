import * as vscode from 'vscode';
import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';

export default abstract class BaseService {
    context: vscode.ExtensionContext;
    protected readonly workspaceRoot: vscode.Uri | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    get configurationSection(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(AGENT_PIVOT_CONFIG_SECTION);
    }

    getConfig<T>(key: string, defaultValue?: T): T {
        return vscode.workspace.getConfiguration(
            AGENT_PIVOT_CONFIG_SECTION,
            this.workspaceRoot
        ).get<T>(key, defaultValue);
    }

    useSettingsStorage(): boolean {
        return this.getConfig<boolean>('storeProjectsInSettings');
    }

}
