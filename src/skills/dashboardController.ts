'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { scanSkills } from './discovery';
import { DISABLED_DIR_NAME, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { disableSkill, enableSkill } from './toggleService';
import { getSkillsPanelContent } from '../webview/webviewSkillContent';
import type { SkillGroupMap, SkillGroupStore } from './skillGroupStore';
import type { SkillRecord } from './types';

export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
    groupStore?: Pick<SkillGroupStore, 'getGroups' | 'getGroupName' | 'setGroup'>;
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
                html: getSkillsPanelContent(this.records, this.getGroups()),
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
