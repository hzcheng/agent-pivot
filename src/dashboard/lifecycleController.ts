'use strict';

import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';

const configurationKey = (key: string): string =>
    `${AGENT_PIVOT_CONFIG_SECTION}.${key}`;

const DASHBOARD_CONFIGURATION_SECTIONS = [
    'searchIsActiveByDefault',
    'customCss',
    'recentColors',
    'storeProjectsInSettings',
    'aiSessionTerminalMode',
    'aiSessionTmuxLayout',
    'aiSessionTmuxPath',
    'aiSessionRunningCardAnimation',
    'aiSessionRunningIconAnimation',
    'aiSessionRunningCardCustomImage',
    'aiSessionRunningIconCustomImage',
    'skills.globalStorePath',
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
    prepareConfigurationChange?: (
        event: ConfigurationChangeEventLike
    ) => Promise<void>;
    checkDataMigration: (openStewardAfterMigrate: boolean) => Promise<void>;
    reconcileProjectCatalog?: () => Promise<void>;
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
    assertActive?: () => void;
    logError?: (message: string, error: unknown) => unknown;
}

export class DashboardLifecycleController {
    constructor(private readonly options: DashboardLifecycleControllerOptions) {
    }

    handleConfigurationChange(event: ConfigurationChangeEventLike): void {
        void this.handleConfigurationChanged(event).catch(error => {
            try {
                this.options.assertActive?.();
            } catch (_disposedError) {
                return;
            }
            try {
                this.options.logError?.(
                    'Failed to handle an Agent Pivot configuration change.',
                    error
                );
            } catch (_logError) {
                // Configuration listeners must never create unhandled rejections.
            }
        });
    }

    async handleConfigurationChanged(event: ConfigurationChangeEventLike): Promise<void> {
        this.assertActive();
        if (this.options.prepareConfigurationChange) {
            await this.options.prepareConfigurationChange(event);
            this.assertActive();
        }
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
        const dashboardConfigurationChanged =
            DASHBOARD_CONFIGURATION_SECTIONS.some(
                section => event.affectsConfiguration(section)
            );

        if (event.affectsConfiguration(configurationKey('storeProjectsInSettings'))) {
            await this.options.checkDataMigration(false);
            this.assertActive();
        }

        if (projectCatalogChanged && !localProjectCatalogWriteEcho) {
            if (this.options.reconcileProjectCatalog) {
                await this.options.reconcileProjectCatalog();
                this.assertActive();
            }
        }

        const trackedDataChanged = projectCatalogChanged || promptDataChanged;
        const fullDashboardRefreshRequired = dashboardConfigurationChanged;
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

    private assertActive(): void {
        this.options.assertActive?.();
    }
}
