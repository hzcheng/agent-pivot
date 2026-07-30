'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { centralizeSkill, createSkillFolder, FolderLinkResult, moveSkillToFolder, removeSkillFolder, setCentralLink, setFolderLinks } from './centralService';
import { migrateSkillsToCentral, SkillMigrationReport } from './migrateService';
import { scanSkillsDetailed } from './discovery';
import { getCollectionSuggestions, KNOWN_SKILL_COLLECTIONS, SkillCollectionSuggestion } from './knownCollections';
import { acquireSkillsMutationLocks } from './globalStoreService';
import { getCentralSkillsRoot, getKimiBrandCandidates, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { computeSkillCopyTargets, copySkillDir, SkillCopyTarget, syncSkillDir } from './syncService';
import { fixSkillDiagnostic } from './fixService';
import { moveProjectSkillToGlobal, setGlobalSkillProjectAgents, SkillScopeActionResult } from './scopeService';
import { getSkillsPanelContent } from '../webview/webviewSkillContent';
import type { SkillPanelView } from '../webview/webviewSkillContent';
import type { SkillGroupStore } from './skillGroupStore';
import type { SkillAgentId, SkillDiagnostic, SkillRecord, SkillScope } from './types';

export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    getGlobalSkillsRoot?: () => string;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
    /** Only collection-suggestion dismissals still use the store; virtual groups are gone. */
    groupStore?: Pick<SkillGroupStore, 'getDismissedCollections' | 'dismissCollection'>;
    nowMs?: () => number;
}

const WATCH_DEBOUNCE_MS = 300;

const LINK_AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];
const LINK_SCOPES: SkillScope[] = ['user', 'project'];

/**
 * dirPaths of central records that share a name and both link the same agent at the
 * same scope. On disk only one link can win the <root>/<name> slot, so both cards get
 * a conflict chip (effectiveness marks the loser shadowed).
 */
export function computeSkillLinkConflicts(records: SkillRecord[]): Set<string> {
    const conflicts = new Set<string>();
    const central = records.filter(record => record.central);
    for (let i = 0; i < central.length; i += 1) {
        for (let j = i + 1; j < central.length; j += 1) {
            const a = central[i];
            const b = central[j];
            if (a.name !== b.name) {
                continue;
            }
            const collides = LINK_SCOPES.some(scope => {
                const aLinks = (a.central && a.central.links[scope]) || {};
                const bLinks = (b.central && b.central.links[scope]) || {};
                return LINK_AGENTS.some(agent => Boolean(aLinks[agent] && bLinks[agent]));
            });
            if (collides) {
                conflicts.add(a.dirPath);
                conflicts.add(b.dirPath);
            }
        }
    }
    return conflicts;
}

export class SkillDashboardController {
    private records: SkillRecord[] = [];
    private storeFolders: Partial<Record<SkillScope, string[]>> = {};
    private watchers: fs.FSWatcher[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private disposed = false;

    constructor(private readonly options: SkillDashboardControllerOptions) {
    }

    getRecords(): SkillRecord[] {
        return this.records;
    }

    getCollectionSuggestions(): SkillCollectionSuggestion[] {
        const store = this.options.groupStore;
        if (!store) {
            return [];
        }
        return getCollectionSuggestions(this.records, store.getDismissedCollections());
    }

    getCopyTargets(): Map<string, SkillCopyTarget[]> {
        return computeSkillCopyTargets(
            this.records,
            this.options.getHomeDir(),
            this.options.getWorkspaceRoot(),
        );
    }

    getStoreRoots(): { user: string; project?: string } {
        const workspaceRoot = this.options.getWorkspaceRoot();
        return {
            user: this.getGlobalSkillsRoot(),
            project: workspaceRoot ? getCentralSkillsRoot(this.options.getHomeDir(), 'project', workspaceRoot) : undefined,
        };
    }

    getPanelView(): SkillPanelView {
        return {
            hasWorkspace: Boolean(this.options.getWorkspaceRoot()),
            copyTargets: this.getCopyTargets(),
            conflicts: computeSkillLinkConflicts(this.records),
            suggestions: this.getCollectionSuggestions(),
            storeRoots: this.getStoreRoots(),
            storeFolders: this.storeFolders,
        };
    }

    handleCreateFolder(scope: SkillScope, folder: string): { ok: boolean; error?: string } {
        const workspaceRoot = this.options.getWorkspaceRoot();
        const storeRoot = scope === 'project'
            ? (workspaceRoot ? getCentralSkillsRoot(this.options.getHomeDir(), 'project', workspaceRoot) : null)
            : this.getGlobalSkillsRoot();
        if (!storeRoot) {
            return { ok: false, error: 'No workspace is open for project folders.' };
        }
        const result = createSkillFolder(storeRoot, folder);
        if (!result.ok) {
            this.options.logError('Failed to create the skill folder.', new Error(result.error || 'unknown error'));
        }
        this.refresh('create-skill-folder');
        return result;
    }

    handleRemoveFolder(storeRoot: string, folder: string): { ok: boolean; error?: string } {
        const known = Object.values(this.getStoreRoots()).filter(Boolean);
        if (!known.includes(storeRoot)) {
            return { ok: false, error: `Unknown skills store: ${storeRoot}` };
        }
        const result = removeSkillFolder(storeRoot, folder);
        if (!result.ok) {
            this.options.logError('Failed to delete the skill folder.', new Error(result.error || 'unknown error'));
        }
        this.refresh('remove-skill-folder');
        return result;
    }

    handleSyncSkill(sourceDir: string, targetDir: string): { ok: boolean; error?: string } {
        const sourceRecord = this.records.find(record => record.dirPath === sourceDir);
        const targetRecord = this.records.find(record => record.dirPath === targetDir);
        if (!sourceRecord || !targetRecord) {
            return { ok: false, error: 'Sync is only allowed between discovered skill copies.' };
        }
        const lockPaths = [sourceDir, targetDir];
        for (const record of [sourceRecord, targetRecord]) {
            const storeRoot = this.getCentralStoreRoot(record);
            if (storeRoot) {
                lockPaths.push(storeRoot);
            }
        }
        const lockResult = acquireSkillsMutationLocks(lockPaths);
        if (lockResult.ok === false) {
            return { ok: false, error: lockResult.error };
        }
        try {
            const result = syncSkillDir(sourceDir, targetDir);
            if (!result.ok) {
                this.options.logError('Failed to sync skills.', new Error(result.error || 'unknown error'));
            }
            this.refresh('sync-skill');
            return result;
        } finally {
            lockResult.lock.release();
        }
    }

    handleCopySkill(sourceDir: string, targetRoot: string): { ok: boolean; error?: string } {
        const sourceRecord = this.records.find(record => record.dirPath === sourceDir);
        if (!sourceRecord || !this.getKnownRootDirs().includes(targetRoot)) {
            return { ok: false, error: 'Copy is only allowed from a discovered skill into a known skills root.' };
        }
        const storeRoot = this.getCentralStoreRoot(sourceRecord);
        const lockPaths = storeRoot ? [storeRoot, sourceDir] : [sourceDir];
        if (Object.values(this.getStoreRoots()).filter(Boolean).includes(targetRoot)) {
            lockPaths.push(targetRoot);
        }
        const lockResult = acquireSkillsMutationLocks(lockPaths);
        if (lockResult.ok === false) {
            return { ok: false, error: lockResult.error };
        }
        try {
            const result = copySkillDir(sourceDir, targetRoot);
            if (!result.ok) {
                this.options.logError('Failed to copy the skill.', new Error(result.error || 'unknown error'));
            }
            this.refresh('copy-skill');
            return result;
        } finally {
            lockResult.lock.release();
        }
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
        const storeRoot = this.getCentralStoreRoot(record);
        const lockResult = acquireSkillsMutationLocks(storeRoot ? [storeRoot] : [dirPath]);
        if (lockResult.ok === false) {
            return { ok: false, error: lockResult.error };
        }
        try {
            // enabled === true means the link currently exists → remove it; false → create it.
            const result = setCentralLink(dirPath, root.dirPath, !enabled);
            if (!result.ok) {
                this.options.logError('Failed to toggle the skill link.', new Error(result.error || 'unknown error'));
            }
            this.refresh('central-toggle-skill');
            return result;
        } finally {
            lockResult.lock.release();
        }
    }

    handleSetGlobalSkillProjectAgents(dirPath: string, agents: SkillAgentId[]): SkillScopeActionResult {
        const record = this.records.find(candidate =>
            candidate.central && candidate.scope === 'user' && candidate.dirPath === dirPath);
        const workspaceRoot = this.options.getWorkspaceRoot();
        if (!record || !workspaceRoot) {
            return { ok: false, error: !workspaceRoot
                ? 'Open a project before applying a global skill.'
                : `Unknown global skill: ${dirPath}`, code: 'invalid' };
        }
        const result = setGlobalSkillProjectAgents(
            record,
            agents,
            this.options.getHomeDir(),
            workspaceRoot,
            this.getGlobalSkillsRoot(),
        );
        if (!result.ok) {
            this.options.logError('Failed to apply the global skill to the project.', new Error(result.error || 'unknown error'));
        }
        return result;
    }

    handleMoveProjectSkillToGlobal(dirPath: string): SkillScopeActionResult {
        const workspaceRoot = this.options.getWorkspaceRoot();
        const freshRecords = workspaceRoot
            ? scanSkillsDetailed({
                homeDir: this.options.getHomeDir(),
                workspaceRoot,
                globalSkillsRoot: this.getGlobalSkillsRoot(),
            }).records
            : [];
        const record = freshRecords.find(candidate =>
            candidate.central && candidate.scope === 'project' && candidate.dirPath === dirPath);
        if (!record || !workspaceRoot) {
            return { ok: false, error: !workspaceRoot
                ? 'Open the project that owns this skill before moving it.'
                : `Unknown project skill: ${dirPath}`, code: 'invalid' };
        }
        const globalMatches = freshRecords.filter(candidate =>
            candidate.central && candidate.scope === 'user' && candidate.name === record.name);
        if (globalMatches.length > 1) {
            return {
                ok: false,
                error: `Multiple global skills named "${record.name}" already exist.`,
                code: 'conflict',
            };
        }
        const existingGlobal = globalMatches[0];
        const result = moveProjectSkillToGlobal(
            record,
            existingGlobal,
            this.options.getHomeDir(),
            workspaceRoot,
            this.getGlobalSkillsRoot(),
        );
        if (!result.ok) {
            this.options.logError('Failed to move the project skill to Global.', new Error(result.error || 'unknown error'));
        }
        return result;
    }

    handleFolderToggle(storeRoot: string, folder: string, scope: SkillScope, agent: SkillAgentId, enabled: boolean): FolderLinkResult {
        const known = Object.values(this.getStoreRoots()).filter(Boolean);
        if (!known.includes(storeRoot)) {
            return { ok: false, changed: 0, errors: [{ name: folder || '.', error: `Unknown skills store: ${storeRoot}` }] };
        }
        const result = setFolderLinks(storeRoot, folder, scope, this.options.getHomeDir(), this.options.getWorkspaceRoot(), !enabled, [agent]);
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
        const result = moveSkillToFolder(
            record,
            folder,
            this.options.getHomeDir(),
            this.options.getWorkspaceRoot(),
            this.getGlobalSkillsRoot(),
        );
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
            && !candidate.central
            && (candidate.source === 'kimi' || candidate.source === 'claude' || candidate.source === 'codex')
        );
        const result = centralizeSkill(
            record,
            duplicates,
            this.options.getHomeDir(),
            this.options.getWorkspaceRoot(),
            { globalSkillsRoot: this.getGlobalSkillsRoot() },
        );
        if (!result.ok) {
            this.options.logError('Failed to centralize the skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('centralize-skill');
        return result;
    }

    handleMigrateToCentral(scope?: SkillScope): SkillMigrationReport {
        const report = scope === 'project'
            ? migrateSkillsToCentral(this.records, this.options.getHomeDir(), 'project', this.options.getWorkspaceRoot())
            : migrateSkillsToCentral(
                this.records,
                this.options.getHomeDir(),
                'user',
                undefined,
                this.getGlobalSkillsRoot(),
            );
        if (!scope && this.options.getWorkspaceRoot()) {
            const projectReport = migrateSkillsToCentral(this.records, this.options.getHomeDir(), 'project', this.options.getWorkspaceRoot());
            report.ok = report.ok && projectReport.ok;
            report.migrated.push(...projectReport.migrated);
            report.drifted.push(...projectReport.drifted);
            report.deleted.push(...projectReport.deleted);
            report.skipped.push(...projectReport.skipped);
            report.errors.push(...projectReport.errors);
        }
        for (const error of report.errors) {
            this.options.logError(`Failed to migrate skill ${error.name}.`, new Error(error.error));
        }
        this.refresh('migrate-skills-to-central');
        return report;
    }

    handleApplyCollectionSuggestion(name: string): { ok: boolean; error?: string } {
        const collection = KNOWN_SKILL_COLLECTIONS.find(candidate => candidate.name === name);
        if (!collection) {
            return { ok: false, error: `Unknown skill collection: ${name}` };
        }
        const homeDir = this.options.getHomeDir();
        const workspaceRoot = this.options.getWorkspaceRoot();
        const failures: string[] = [];
        const unfiled = () => this.records.filter(record =>
            collection.members.includes(record.name)
            && (!record.central || record.folder !== collection.name));
        for (const record of unfiled()) {
            if (!record.central) {
                const duplicates = this.records.filter(candidate =>
                    candidate.scope === record.scope && candidate.name === record.name
                    && candidate.dirPath !== record.dirPath);
                const centralized = centralizeSkill(record, duplicates, homeDir, workspaceRoot, {
                    globalSkillsRoot: this.getGlobalSkillsRoot(),
                });
                if (!centralized.ok) {
                    failures.push(`${record.name}: ${centralized.error}`);
                    continue;
                }
                this.refresh('apply-skill-collection');
            }
            const current = this.records.find(candidate =>
                candidate.central && candidate.scope === record.scope && candidate.name === record.name);
            if (!current) {
                failures.push(`${record.name}: lost after centralizing`);
                continue;
            }
            const moved = moveSkillToFolder(
                current,
                collection.name,
                homeDir,
                workspaceRoot,
                this.getGlobalSkillsRoot(),
            );
            if (!moved.ok) {
                failures.push(`${record.name}: ${moved.error}`);
            }
            this.refresh('apply-skill-collection');
        }
        for (const failure of failures) {
            this.options.logError('Failed to apply the skill collection suggestion.', new Error(failure));
        }
        this.refresh('apply-skill-collection');
        return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
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

    refresh(_reason = 'refresh', settlement?: unknown): Promise<boolean> {
        if (this.disposed) {
            return Promise.resolve(false);
        }
        try {
            const scan = scanSkillsDetailed({
                homeDir: this.options.getHomeDir(),
                workspaceRoot: this.options.getWorkspaceRoot(),
                globalSkillsRoot: this.getGlobalSkillsRoot(),
            });
            this.records = scan.records;
            this.storeFolders = scan.storeFolders;
        } catch (error) {
            this.options.logError('Skill scan failed.', error);
            this.records = [];
        }
        this.resetWatchers();
        if (this.options.isVisible()) {
            return Promise.resolve(this.options.postMessage({
                type: 'skills-updated',
                html: getSkillsPanelContent(this.records, this.getPanelView()),
                ...(settlement ? { settlement } : {}),
            }));
        }
        return Promise.resolve(false);
    }

    handleDeleteSkill(dirPath: string): { ok: boolean; error?: string } {
        const containmentError = this.checkDeleteContainment(dirPath);
        if (containmentError) {
            return { ok: false, error: containmentError };
        }
        const record = this.records.find(candidate => candidate.dirPath === dirPath);
        const lockPaths = [dirPath];
        const storeRoot = record ? this.getCentralStoreRoot(record) : null;
        if (storeRoot) {
            lockPaths.push(storeRoot);
        }
        const lockResult = acquireSkillsMutationLocks(lockPaths);
        if (lockResult.ok === false) {
            return { ok: false, error: lockResult.error };
        }
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.logError('Failed to delete the skill.', new Error(message));
            this.refresh('delete-skill');
            return { ok: false, error: message };
        } finally {
            lockResult.lock.release();
        }
        this.refresh('delete-skill');
        return { ok: true };
    }

    handleFixSkillDiagnostic(dirPath: string, code: SkillDiagnostic['code']): { ok: boolean; error?: string } {
        const record = this.records.find(candidate => candidate.dirPath === dirPath);
        if (!record) {
            return { ok: false, error: `Unknown skill: ${dirPath}` };
        }
        const storeRoot = this.getCentralStoreRoot(record);
        const lockResult = acquireSkillsMutationLocks(
            storeRoot ? [storeRoot, dirPath] : [dirPath],
        );
        if (lockResult.ok === false) {
            return { ok: false, error: lockResult.error };
        }
        try {
            const result = fixSkillDiagnostic(record, code);
            if (!result.ok) {
                this.options.logError('Failed to fix the skill diagnostic.', new Error(result.error || 'unknown error'));
            }
            this.refresh('fix-skill-diagnostic');
            return result;
        } finally {
            lockResult.lock.release();
        }
    }

    private getKnownRootDirs(): string[] {
        const workspaceRoot = this.options.getWorkspaceRoot();
        return getUserSkillsRoots(this.options.getHomeDir())
            .concat(workspaceRoot ? getProjectSkillsRoots(workspaceRoot) : [])
            .map(root => root.dirPath);
    }

    private getGlobalSkillsRoot(): string {
        return this.options.getGlobalSkillsRoot?.()
            || getCentralSkillsRoot(this.options.getHomeDir(), 'user');
    }

    private getCentralStoreRoot(record: SkillRecord): string | null {
        if (!record.central) {
            return null;
        }
        if (record.scope === 'user') {
            return this.getGlobalSkillsRoot();
        }
        const workspaceRoot = this.options.getWorkspaceRoot();
        return workspaceRoot
            ? getCentralSkillsRoot(this.options.getHomeDir(), 'project', workspaceRoot)
            : null;
    }

    private checkDeleteContainment(dirPath: string): string | null {
        if (!dirPath) {
            return 'Missing skill path.';
        }
        const record = this.records.find(candidate => candidate.dirPath === dirPath);
        if (!record) {
            return `Unknown skill: ${dirPath}`;
        }
        if (record.central) {
            return `Refusing to delete a centralized skill: ${dirPath}`;
        }
        // The target must be a direct child of a known skills root. Symlinked
        // entries resolve outside the roots, so they fail this check naturally;
        // the lstat guard below is the belt-and-braces for realpath races.
        if (!this.getKnownRootDirs().includes(path.dirname(dirPath))) {
            return `Refusing to delete a skill outside the known skills roots: ${dirPath}`;
        }
        try {
            if (fs.lstatSync(dirPath).isSymbolicLink()) {
                return `Refusing to delete a symlinked skill: ${dirPath}`;
            }
        } catch (_error) {
            return `Skill path does not exist: ${dirPath}`;
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
            .concat(this.getGlobalSkillsRoot())
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
