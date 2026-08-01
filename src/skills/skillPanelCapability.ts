'use strict';

import type * as vscode from 'vscode';
import type { DashboardMessageHandler } from '../dashboard/messageRouter';
import type { SkillPanelView } from '../webview/webviewSkillContent';
import { SkillDashboardController } from './dashboardController';
import type { SkillDashboardControllerOptions } from './dashboardController';
import { GlobalStoreLocationController } from './globalStoreLocationController';
import type { GlobalStoreLocationControllerOptions } from './globalStoreLocationController';
import { skillDirectoriesEqual } from './scopeService';
import type { SkillGroupStore } from './skillGroupStore';
import type { SkillRecord } from './types';

export interface SkillScopeActionSettlement {
    version: 1;
    requestId: string;
    dirPath: string;
    operation: 'apply-to-project' | 'move-to-global';
    ok: boolean;
    code?: string;
    resultDirPath?: string;
}

export interface SkillPanelCapabilityOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    getWorkspaceRoots: () => readonly string[];
    hasWorkspace: () => boolean;
    groupStore: SkillGroupStore;
    readGlobalStorePath: () => string;
    writeGlobalStorePath: (value: string) => PromiseLike<void>;
    postMessage: (message: unknown) => Thenable<boolean>;
    refreshDashboard: () => void;
    isVisible: () => boolean;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPickMany: <T extends vscode.QuickPickItem>(
        items: readonly T[],
        options: vscode.QuickPickOptions
    ) => Thenable<readonly T[] | undefined>;
    showWarningMessage: (
        message: string,
        options?: vscode.MessageOptions,
        ...items: string[]
    ) => Thenable<string | undefined>;
    showInformationMessage: (message: string) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    openTextFile: (fsPath: string) => Thenable<unknown>;
    logError: (message: string, error: unknown) => void;
}

export interface SkillPanelCapability {
    /** Dashboard message handlers, spread into the dashboard message router. */
    handlers: Record<string, DashboardMessageHandler>;
    /** Read facade for cross-domain consumers (search catalogs, the AI panel). */
    getRecords: () => SkillRecord[];
    getPanelView: () => SkillPanelView;
    /** Starts the initial skill scan; the dashboard times it as a bootstrap phase. */
    start: () => void;
    /** Palette command and message handler: migrate non-central skills centrally. */
    migrateToCentral: (scope?: 'user' | 'project') => Promise<void>;
    /** Palette command and message handler: relocate the Global skills store. */
    changeGlobalStoreLocation: () => Promise<boolean>;
    /** Configuration-change hook for `agentPivot.skills.globalStorePath`. */
    handleGlobalStoreConfigurationChange: () => Promise<boolean>;
    dispose(): void;
}

/**
 * Owns the Skills slice of the dashboard: the Global store location
 * controller, the skill dashboard controller, the scope-action settlement
 * pipeline with its request dedupe, the migrate-to-central flow, and every
 * `*-skill*` message handler.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts (see the todo panel
 * capability for the same slice pattern). Behaviour is unchanged: the handler
 * bodies, validation order, settlement fallbacks, and migration prompts are
 * the same; only their ownership moved.
 */
interface SkillPanelCapabilityInternalFactories {
    createLocationController(
        options: GlobalStoreLocationControllerOptions
    ): GlobalStoreLocationController;
    createDashboardController(
        options: SkillDashboardControllerOptions
    ): SkillDashboardController;
}

const DEFAULT_FACTORIES: SkillPanelCapabilityInternalFactories = {
    createLocationController: options => new GlobalStoreLocationController(options),
    createDashboardController: options => new SkillDashboardController(options),
};

export function createSkillPanelCapability(
    options: SkillPanelCapabilityOptions,
    internalFactories: Partial<SkillPanelCapabilityInternalFactories> = {}
): SkillPanelCapability {
    const factories = { ...DEFAULT_FACTORIES, ...internalFactories };
    const showInputBox = options.showInputBox;
    const showQuickPickMany = options.showQuickPickMany;
    const showWarningMessage = options.showWarningMessage;
    const showInformationMessage = options.showInformationMessage;
    const showErrorMessage = options.showErrorMessage;
    const logError = options.logError;

    const globalStoreLocationController = factories.createLocationController({
        homeDir: options.getHomeDir(),
        getWorkspaceRoots: options.getWorkspaceRoots,
        readSetting: options.readGlobalStorePath,
        writeSetting: options.writeGlobalStorePath,
        showInputBox: options.showInputBox,
        showWarningMessage: (message, messageOptions, ...items) => messageOptions
            ? options.showWarningMessage(message, messageOptions, ...items)
            : options.showWarningMessage(message),
        showErrorMessage: options.showErrorMessage,
        refresh: () => skillDashboardController.refresh(
            'global-skills-location-changed',
        ),
        logError,
    });
    const skillDashboardController = factories.createDashboardController({
        getHomeDir: options.getHomeDir,
        getWorkspaceRoot: options.getWorkspaceRoot,
        getGlobalSkillsRoot: () => globalStoreLocationController.getActiveRoot(),
        postMessage: message => options.postMessage(message),
        isVisible: options.isVisible,
        logError,
        groupStore: options.groupStore,
    });
    const completedSkillScopeActionRequests = new Set<string>();
    const publishSkillScopeActionSettlement = async (settlement: SkillScopeActionSettlement): Promise<void> => {
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
            options.refreshDashboard();
        } catch (error) {
            logError('Failed to refresh the dashboard after a Skill scope action.', error);
        }
        try {
            await options.postMessage({
                type: 'skill-scope-action-result',
                ...settlement,
                ok: false,
                code: 'refresh-failed',
            });
        } catch (error) {
            logError('Failed to settle the Skill scope action.', error);
        }
    };
    const runSkillMigrationToCentral = async (scope?: 'user' | 'project'): Promise<void> => {
        const hasWorkspace = options.hasWorkspace();
        const migratable = skillDashboardController.getRecords()
            .filter(record => !record.central
                && (!scope || record.scope === scope)
                && (record.source === 'kimi' || record.source === 'claude' || record.source === 'codex'));
        if (!migratable.length) {
            void showInformationMessage(scope
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
        const choice = await showWarningMessage(
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
            void showWarningMessage(`${summary} ${report.errors.length} failed: ${report.errors[0].error}`);
        } else {
            void showInformationMessage(summary);
        }
    };

    const handlers: Record<string, DashboardMessageHandler> = {
        'delete-skill': async e => {
            const dirPath = String(e.dirPath || '');
            const record = skillDashboardController.getRecords().find(candidate => candidate.dirPath === dirPath);
            const label = record ? record.name : dirPath;
            const choice = await showWarningMessage(
                `Delete skill "${label}" permanently? This cannot be undone.`,
                { modal: true },
                'Delete',
            );
            if (choice !== 'Delete') {
                return;
            }
            const result = skillDashboardController.handleDeleteSkill(dirPath);
            if (!result.ok) {
                void showWarningMessage(`Could not delete the skill: ${result.error}`);
            }
        },
        'apply-skill-collection': e => {
            const result = skillDashboardController.handleApplyCollectionSuggestion(String(e.name || ''));
            if (!result.ok) {
                void showWarningMessage(`Could not create the skill folder: ${result.error}`);
            }
        },
        'dismiss-skill-collection': async e => {
            await skillDashboardController.handleDismissCollectionSuggestion(String(e.name || ''));
        },
        'sync-skill': e => {
            const result = skillDashboardController.handleSyncSkill(String(e.sourceDir || ''), String(e.targetDir || ''));
            if (!result.ok) {
                void showWarningMessage(`Could not sync the skill: ${result.error}`);
            }
        },
        'copy-skill': e => {
            const result = skillDashboardController.handleCopySkill(String(e.sourceDir || ''), String(e.targetRoot || ''));
            if (!result.ok) {
                void showWarningMessage(`Could not copy the skill: ${result.error}`);
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
            const settlement: SkillScopeActionSettlement = {
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
                    const selected = await showQuickPickMany(items, {
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
                        void showInformationMessage('Choose at least one project agent.');
                        await publishSkillScopeActionSettlement(settlement);
                        return;
                    }
                    const result = skillDashboardController.handleSetGlobalSkillProjectAgents(
                        e.dirPath, selected.map(item => item.agent));
                    settlement.ok = result.ok;
                    settlement.code = result.ok ? 'applied' : (result.code || 'failed');
                    settlement.resultDirPath = result.dirPath;
                    if (!result.ok) {
                        void showWarningMessage(`Could not apply the skill to this project: ${result.error}`);
                    }
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }

                const existingGlobal = skillDashboardController.getRecords().find(candidate =>
                    candidate.central && candidate.scope === 'user' && candidate.name === record.name);
                if (existingGlobal && !skillDirectoriesEqual(record.dirPath, existingGlobal.dirPath)) {
                    settlement.code = 'conflict';
                    void showWarningMessage(
                        `A different global skill named "${record.name}" already exists. Rename or reconcile it first.`);
                    await publishSkillScopeActionSettlement(settlement);
                    return;
                }
                const choice = await showWarningMessage(
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
                    void showWarningMessage(`Could not move the skill to Global: ${result.error}`);
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
                void showWarningMessage(`Could not toggle the skill link: ${result.error}`);
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
                void showWarningMessage(
                    `Some folder links failed: ${result.errors.map(item => item.name).join(', ')}`);
            }
        },
        'move-skill-to-folder': e => {
            const result = skillDashboardController.handleMoveToFolder(String(e.dirPath || ''), String(e.folder || ''));
            if (!result.ok) {
                void showWarningMessage(`Could not move the skill: ${result.error}`);
            }
        },
        'create-skill-folder': async e => {
            const parentFolder = String(e.parentFolder || '').replace(/^\/+|\/+$/g, '');
            const folder = await showInputBox({
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
                void showWarningMessage(`Could not create the folder: ${result.error}`);
            }
        },
        'remove-skill-folder': async e => {
            const folderName = String(e.folder || '');
            const choice = await showWarningMessage(
                `Delete the folder "${folderName}"? Only empty folders can be deleted.`,
                { modal: true },
                'Delete',
            );
            if (choice !== 'Delete') {
                return;
            }
            const result = skillDashboardController.handleRemoveFolder(String(e.storeRoot || ''), folderName);
            if (!result.ok) {
                void showWarningMessage(`Could not delete the folder: ${result.error}`);
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
                    const choice = await showWarningMessage(
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
                void showWarningMessage(`Could not centralize the skill: ${result.error}`);
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
                void showWarningMessage(`Could not fix the skill: ${result.error}`);
            }
        },
        'open-skill-file': async e => {
            const skillFilePath = String(e.skillFilePath || '');
            if (!skillDashboardController.getRecords().some(record => record.skillFilePath === skillFilePath)) {
                return;
            }
            await options.openTextFile(skillFilePath);
        },
    };

    return {
        handlers,
        getRecords: () => skillDashboardController.getRecords(),
        getPanelView: () => skillDashboardController.getPanelView(),
        start: () => skillDashboardController.start(),
        migrateToCentral: runSkillMigrationToCentral,
        changeGlobalStoreLocation: () => globalStoreLocationController.changeInteractively(),
        handleGlobalStoreConfigurationChange: () => globalStoreLocationController.handleConfigurationChange(),
        dispose: () => skillDashboardController.dispose(),
    };
}
