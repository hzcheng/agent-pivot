'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { centralizeSkill, FolderLinkResult, moveSkillToFolder, setCentralLink, setFolderLinks } from './centralService';
import { migrateUserSkillsToCentral, SkillMigrationReport } from './migrateService';
import { scanSkills } from './discovery';
import { getCollectionSuggestions, KNOWN_SKILL_COLLECTIONS, SkillCollectionSuggestion } from './knownCollections';
import { DISABLED_DIR_NAME, getKimiBrandCandidates, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { computeSkillCopyTargets, copySkillDir, SkillCopyTarget, syncSkillDir } from './syncService';
import { disableSkill, enableSkill } from './toggleService';
import { fixSkillDiagnostic } from './fixService';
import { getSkillsPanelContent } from '../webview/webviewSkillContent';
import type { SkillGroupMap, SkillGroupStore } from './skillGroupStore';
import type { SkillAgentId, SkillDiagnostic, SkillRecord, SkillScope } from './types';

export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
    groupStore?: Pick<
        SkillGroupStore,
        'getGroups' | 'getGroupName' | 'setGroup' | 'getDismissedCollections' | 'dismissCollection'
    >;
    nowMs?: () => number;
}

const WATCH_DEBOUNCE_MS = 300;

export class SkillDashboardController {
    private records: SkillRecord[] = [];
    private watchers: fs.FSWatcher[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private disposed = false;

    constructor(private readonly options: SkillDashboardControllerOptions) {
    }

    getRecords(): SkillRecord[] {
        return this.records;
    }

    getGroups(): SkillGroupMap {
        return this.options.groupStore ? this.options.groupStore.getGroups() : {};
    }

    getCollectionSuggestions(): SkillCollectionSuggestion[] {
        const store = this.options.groupStore;
        if (!store) {
            return [];
        }
        return getCollectionSuggestions(this.records, store.getGroups(), store.getDismissedCollections());
    }

    getCopyTargets(): Map<string, SkillCopyTarget[]> {
        return computeSkillCopyTargets(
            this.records,
            this.options.getHomeDir(),
            this.options.getWorkspaceRoot(),
        );
    }

    handleSyncSkill(sourceDir: string, targetDir: string): { ok: boolean; error?: string } {
        const known = new Set(this.records.map(record => record.dirPath));
        if (!known.has(sourceDir) || !known.has(targetDir)) {
            return { ok: false, error: 'Sync is only allowed between discovered skill copies.' };
        }
        const result = syncSkillDir(sourceDir, targetDir);
        if (!result.ok) {
            this.options.logError('Failed to sync skills.', new Error(result.error || 'unknown error'));
        }
        this.refresh('sync-skill');
        return result;
    }

    handleCopySkill(sourceDir: string, targetRoot: string): { ok: boolean; error?: string } {
        const known = new Set(this.records.map(record => record.dirPath));
        if (!known.has(sourceDir) || !this.getKnownRootDirs().includes(targetRoot)) {
            return { ok: false, error: 'Copy is only allowed from a discovered skill into a known skills root.' };
        }
        const result = copySkillDir(sourceDir, targetRoot);
        if (!result.ok) {
            this.options.logError('Failed to copy the skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('copy-skill');
        return result;
    }

    handleCentralToggle(dirPath: string, scope: SkillScope, agent: SkillAgentId, enabled: boolean): { ok: boolean; error?: string } {
        const record = this.records.find(candidate => candidate.central && candidate.dirPath === dirPath);
        if (!record || !record.central) {
            return { ok: false, error: `Unknown centralized skill: ${dirPath}` };
        }
        const workspaceRoot = this.options.getWorkspaceRoot();
        if (scope === 'project' && !workspaceRoot) {
            return { ok: false, error: `Unknown ${scope} skills root for ${agent}.` };
        }
        const roots = scope === 'user'
            ? getUserSkillsRoots(this.options.getHomeDir())
            : getProjectSkillsRoots(workspaceRoot as string);
        // Brand agents only: the SkillAgentId type excludes agents/central at compile
        // time, but the webview message channel is untyped at runtime.
        const root = getKimiBrandCandidates(roots)
            .find(candidate => candidate.source === agent && candidate.scope === scope);
        if (!root) {
            return { ok: false, error: `Unknown ${scope} skills root for ${agent}.` };
        }
        // enabled === true means the link currently exists → remove it; false → create it.
        const result = setCentralLink(dirPath, root.dirPath, !enabled);
        if (!result.ok) {
            this.options.logError('Failed to toggle the skill link.', new Error(result.error || 'unknown error'));
        }
        this.refresh('central-toggle-skill');
        return result;
    }

    handleFolderToggle(storeRoot: string, folder: string, scope: SkillScope, enabled: boolean): FolderLinkResult {
        const result = setFolderLinks(storeRoot, folder, scope, this.options.getHomeDir(), this.options.getWorkspaceRoot(), !enabled);
        for (const error of result.errors) {
            this.options.logError(`Failed to toggle folder link for ${error.name}.`, new Error(error.error));
        }
        this.refresh('folder-toggle-skill-links');
        return result;
    }

    handleMoveToFolder(dirPath: string, folder: string): { ok: boolean; error?: string } {
        const record = this.records.find(candidate => candidate.central && candidate.dirPath === dirPath);
        if (!record) {
            return { ok: false, error: `Unknown centralized skill: ${dirPath}` };
        }
        const result = moveSkillToFolder(record, folder, this.options.getHomeDir(), this.options.getWorkspaceRoot());
        if (!result.ok) {
            this.options.logError('Failed to move the skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('move-skill-to-folder');
        return result;
    }

    handleCentralize(dirPath: string): { ok: boolean; error?: string } {
        const record = this.records.find(candidate => candidate.dirPath === dirPath && !candidate.central);
        if (!record) {
            return { ok: false, error: `Unknown skill to centralize: ${dirPath}` };
        }
        const duplicates = this.records.filter(candidate =>
            candidate.scope === record.scope && candidate.name === record.name && candidate.dirPath !== record.dirPath
        );
        const result = centralizeSkill(record, duplicates, this.options.getHomeDir(), this.options.getWorkspaceRoot());
        if (!result.ok) {
            this.options.logError('Failed to centralize the skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('centralize-skill');
        return result;
    }

    handleMigrateToCentral(): SkillMigrationReport {
        const report = migrateUserSkillsToCentral(this.records, this.options.getHomeDir());
        for (const error of report.errors) {
            this.options.logError(`Failed to migrate skill ${error.name}.`, new Error(error.error));
        }
        this.refresh('migrate-skills-to-central');
        return report;
    }

    async handleApplyCollectionSuggestion(name: string): Promise<{ ok: boolean; error?: string }> {
        const store = this.options.groupStore;
        const collection = KNOWN_SKILL_COLLECTIONS.find(candidate => candidate.name === name);
        if (!store || !collection) {
            return { ok: false, error: `Unknown skill collection: ${name}` };
        }
        try {
            for (const record of this.records) {
                if (collection.members.includes(record.name) && !store.getGroupName(record)) {
                    await store.setGroup(record, collection.name);
                }
            }
        } catch (error) {
            this.options.logError('Failed to apply the skill collection suggestion.', error);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.refresh('apply-skill-collection');
        return { ok: true };
    }

    async handleDismissCollectionSuggestion(name: string): Promise<{ ok: boolean }> {
        if (this.options.groupStore) {
            await this.options.groupStore.dismissCollection(name);
        }
        this.refresh('dismiss-skill-collection');
        return { ok: true };
    }

    start(): void {
        this.refresh('start');
    }

    refresh(_reason = 'refresh'): void {
        if (this.disposed) {
            return;
        }
        try {
            this.records = scanSkills({
                homeDir: this.options.getHomeDir(),
                workspaceRoot: this.options.getWorkspaceRoot(),
            });
        } catch (error) {
            this.options.logError('Skill scan failed.', error);
            this.records = [];
        }
        this.resetWatchers();
        if (this.options.isVisible()) {
            void this.options.postMessage({
                type: 'skills-updated',
                html: getSkillsPanelContent(this.records, {
                    groups: this.getGroups(),
                    suggestions: this.getCollectionSuggestions(),
                    copyTargets: computeSkillCopyTargets(
                        this.records,
                        this.options.getHomeDir(),
                        this.options.getWorkspaceRoot(),
                    ),
                }),
            });
        }
    }

    handleToggle(dirPath: string, enabled: boolean): { ok: boolean; error?: string } {
        const containmentError = this.checkToggleContainment(dirPath, enabled);
        if (containmentError) {
            return { ok: false, error: containmentError };
        }
        const result = enabled ? disableSkill(dirPath) : enableSkill(dirPath);
        if (!result.ok) {
            this.options.logError('Failed to toggle skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('toggle');
        return result;
    }

    async handleSetSkillGroup(dirPath: string, groupName: string): Promise<{ ok: boolean; error?: string }> {
        const record = this.records.find(candidate => candidate.dirPath === dirPath);
        if (!record || !this.options.groupStore) {
            return { ok: false, error: `Unknown skill: ${dirPath}` };
        }
        try {
            await this.options.groupStore.setGroup(record, groupName);
        } catch (error) {
            this.options.logError('Failed to update the skill group.', error);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.refresh('set-skill-group');
        return { ok: true };
    }

    handleFixSkillDiagnostic(dirPath: string, code: SkillDiagnostic['code']): { ok: boolean; error?: string } {
        const record = this.records.find(candidate => candidate.dirPath === dirPath);
        if (!record) {
            return { ok: false, error: `Unknown skill: ${dirPath}` };
        }
        const result = fixSkillDiagnostic(record, code);
        if (!result.ok) {
            this.options.logError('Failed to fix the skill diagnostic.', new Error(result.error || 'unknown error'));
        }
        this.refresh('fix-skill-diagnostic');
        return result;
    }

    handleToggleSkillGroup(name: string, scope: string, enabled: boolean): { ok: boolean; error?: string } {
        const store = this.options.groupStore;
        if (!store || !name) {
            return { ok: false, error: 'Missing skill group.' };
        }
        const members = this.records.filter(record =>
            record.scope === scope && store.getGroupName(record) === name
        );
        if (!members.length) {
            return { ok: false, error: `No skills in group "${name}".` };
        }
        // Members come from the last scan, so every moved path is contained by
        // construction: active members live directly under a known root, parked
        // members directly under its `.disabled` directory.
        const failures: string[] = [];
        for (const member of members) {
            if (enabled && member.enabled) {
                const result = disableSkill(member.dirPath);
                if (!result.ok) {
                    failures.push(`${member.name}: ${result.error}`);
                }
            } else if (!enabled && !member.enabled) {
                const result = enableSkill(member.dirPath);
                if (!result.ok) {
                    failures.push(`${member.name}: ${result.error}`);
                }
            }
        }
        if (failures.length) {
            this.options.logError('Failed to toggle some skills in the group.', new Error(failures.join('; ')));
        }
        this.refresh('toggle-skill-group');
        return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
    }

    private getKnownRootDirs(): string[] {
        const workspaceRoot = this.options.getWorkspaceRoot();
        return getUserSkillsRoots(this.options.getHomeDir())
            .concat(workspaceRoot ? getProjectSkillsRoots(workspaceRoot) : [])
            .map(root => root.dirPath);
    }

    private checkToggleContainment(dirPath: string, enabled: boolean): string | null {
        if (!dirPath) {
            return 'Missing skill path.';
        }
        const rootDirs = this.getKnownRootDirs();
        const parentDir = path.dirname(dirPath);
        if (enabled) {
            // Disable: the target must be a direct child of a known skills root
            // (and never the root's `.disabled` directory itself).
            if (path.basename(dirPath) === DISABLED_DIR_NAME || !rootDirs.includes(parentDir)) {
                return `Refusing to disable a skill outside the known skills roots: ${dirPath}`;
            }
            return null;
        }
        // Enable: the target must be a direct child of a known root's `.disabled` directory.
        if (path.basename(parentDir) !== DISABLED_DIR_NAME || !rootDirs.includes(path.dirname(parentDir))) {
            return `Refusing to enable a skill outside a known skills root ${DISABLED_DIR_NAME} directory: ${dirPath}`;
        }
        return null;
    }

    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.resetWatchers();
    }

    private resetWatchers(): void {
        for (const watcher of this.watchers) {
            try { watcher.close(); } catch (_error) { /* ignore */ }
        }
        this.watchers = [];
        if (this.disposed) {
            return;
        }
        const workspaceRoot = this.options.getWorkspaceRoot();
        const roots = getUserSkillsRoots(this.options.getHomeDir())
            .concat(workspaceRoot ? getProjectSkillsRoots(workspaceRoot) : []);
        const dirs = roots.map(root => root.dirPath)
            .concat(this.records.map(record => record.dirPath));
        for (const dirPath of dirs) {
            try {
                if (!fs.existsSync(dirPath)) {
                    continue;
                }
                const watcher = fs.watch(dirPath, () => this.scheduleRefresh());
                watcher.on('error', () => undefined);
                this.watchers.push(watcher);
            } catch (_error) {
                // Unwatchable directories must not break the dashboard.
            }
        }
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refresh('watch');
        }, WATCH_DEBOUNCE_MS);
    }
}
