'use strict';

import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';

const configurationKey = (key: string): string =>
    `${AGENT_PIVOT_CONFIG_SECTION}.${key}`;

const NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS = [
    'searchIsActiveByDefault',
    'customCss',
    'recentColors',
    'storeProjectsInSettings',
    'maxVisibleAiSessions',
    'aiSessionTerminalMode',
    'aiSessionTmuxLayout',
    'aiSessionTmuxPath',
    'aiSessionRunningCardAnimation',
    'aiSessionRunningIconAnimation',
    'maxVisibleTodosPerGroup',
    'maxVisibleProjectsPerGroup',
    'aiSessionAttention.enabled',
    'displayProjectPath',
    'prependVscodeUrlToWslRemotes',
    'projectTileWidth',
    'recentColorsToRemember',
    'openOnStartup',
    'showAddGroupButtonTile',
    'customProjectCardBackground',
    'customProjectNameColor',
    'customProjectPathColor',
    'applyProjectColorToWindow',
].map(configurationKey);

export interface ConfigurationChangeEventLike {
    affectsConfiguration(section: string): boolean;
}

export interface WindowStateLike {
    focused: boolean;
}

export interface DashboardLifecycleControllerOptions {
    checkDataMigration: (openStewardAfterMigrate: boolean) => Promise<void>;
    reconcileProjectCatalog?: () => Promise<void>;
    consumeTodoDataWriteEcho?: () => boolean;
    consumeProjectCatalogWriteEcho?: (
        change: { syncData: boolean; legacyGroups: boolean }
    ) => boolean;
    consumePromptDataWriteEcho?: () => boolean;
    applyProjectColorToCurrentWindow: () => void;
    refresh: (reason: string) => void;
    refreshProjects?: (reason: string) => void;
    refreshPrompts?: (reason: string) => void;
    publishOpenWorkspace: (followsFocusEvent?: boolean) => void;
    evaluateAiSessionAttention: () => unknown;
}

export class DashboardLifecycleController {
    constructor(private readonly options: DashboardLifecycleControllerOptions) {
    }

    async handleConfigurationChanged(event: ConfigurationChangeEventLike): Promise<void> {
        const todoDataChanged = event.affectsConfiguration(configurationKey('todoData'));
        const localTodoDataWriteEcho = todoDataChanged
            && this.options.consumeTodoDataWriteEcho?.() === true;
        const projectCatalogChange = {
            syncData: event.affectsConfiguration(configurationKey('projectSyncData')),
            legacyGroups: event.affectsConfiguration(configurationKey('projectData')),
        };
        const projectCatalogChanged = projectCatalogChange.syncData
            || projectCatalogChange.legacyGroups;
        const localProjectCatalogWriteEcho = projectCatalogChanged
            && this.options.consumeProjectCatalogWriteEcho?.(projectCatalogChange) === true;
        const promptDataChanged = event.affectsConfiguration(configurationKey('promptData'));
        const localPromptDataWriteEcho = promptDataChanged
            && this.options.consumePromptDataWriteEcho?.() === true;
        const nonTodoDashboardConfigurationChanged =
            NON_TODO_DASHBOARD_CONFIGURATION_SECTIONS.some(
                section => event.affectsConfiguration(section)
            );

        if (event.affectsConfiguration(configurationKey('storeProjectsInSettings'))) {
            await this.options.checkDataMigration(false);
        }

        if (projectCatalogChanged && !localProjectCatalogWriteEcho) {
            await this.options.reconcileProjectCatalog?.();
        }

        const trackedDataChanged = todoDataChanged || projectCatalogChanged || promptDataChanged;
        const fullDashboardRefreshRequired = nonTodoDashboardConfigurationChanged
            || (todoDataChanged && !localTodoDataWriteEcho);
        if (trackedDataChanged && !fullDashboardRefreshRequired) {
            if (projectCatalogChanged && !localProjectCatalogWriteEcho) {
                this.options.refreshProjects?.('configuration-changed');
                this.options.applyProjectColorToCurrentWindow();
                this.options.publishOpenWorkspace();
            }
            if (promptDataChanged && !localPromptDataWriteEcho) {
                this.options.refreshPrompts?.('configuration-changed');
            }
            return;
        }

        if (event.affectsConfiguration(AGENT_PIVOT_CONFIG_SECTION)) {
            this.options.applyProjectColorToCurrentWindow();
            this.options.refresh('configuration-changed');
            this.options.publishOpenWorkspace();
        }
    }

    handleWorkspaceFoldersChanged(): void {
        this.options.applyProjectColorToCurrentWindow();
        this.options.refresh('workspace-folders-changed');
        this.options.publishOpenWorkspace();
    }

    handleWindowStateChanged(windowState: WindowStateLike): void {
        if (windowState.focused) {
            this.options.publishOpenWorkspace(true);
        }
        this.options.evaluateAiSessionAttention();
    }
}
