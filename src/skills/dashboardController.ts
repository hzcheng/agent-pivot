'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { scanSkills } from './discovery';
import { DISABLED_DIR_NAME, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { disableSkill, enableSkill } from './toggleService';
import { getSkillsPanelContent } from '../webview/webviewSkillContent';
import type { SkillRecord } from './types';

export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
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
                html: getSkillsPanelContent(this.records),
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
