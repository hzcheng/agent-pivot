'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { DISABLED_DIR_NAME, getCentralSkillsRoot, getProjectSkillsRoots, getUserSkillsRoots, SkillsRoot } from './roots';
import type { SkillRecord, SkillScope, SkillSourceDir } from './types';

export interface CentralResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
}

function knownBrandRoots(homeDir: string, workspaceRoot?: string): SkillsRoot[] {
    return getUserSkillsRoots(homeDir)
        .concat(workspaceRoot ? getProjectSkillsRoots(workspaceRoot) : [])
        .filter(root => root.source !== 'agents');
}

function isSymlinkTo(linkPath: string, target: string): boolean {
    try {
        return fs.lstatSync(linkPath).isSymbolicLink() && fs.realpathSync(linkPath) === target;
    } catch (_error) {
        return false;
    }
}

/**
 * Enable/disable one agent's access to a centralized skill by creating or
 * removing a symlink `<root>/<name>` → central directory. Never touches
 * real directories and never throws.
 */
export function setCentralLink(centralDir: string, rootDir: string, enable: boolean): CentralResult {
    const linkPath = path.join(rootDir, path.basename(centralDir));
    try {
        if (enable) {
            if (isSymlinkTo(linkPath, centralDir)) {
                return { ok: true, dirPath: linkPath };
            }
            if (fs.existsSync(linkPath)) {
                return { ok: false, error: `Something else already exists at ${linkPath}` };
            }
            fs.mkdirSync(rootDir, { recursive: true });
            fs.symlinkSync(centralDir, linkPath, 'dir');
            return { ok: true, dirPath: linkPath };
        }
        let stat: fs.Stats | null = null;
        try {
            // lstat (not existsSync) so dangling symlinks are still detected.
            stat = fs.lstatSync(linkPath);
        } catch (_error) {
            stat = null;
        }
        if (!stat) {
            return { ok: true };
        }
        if (!stat.isSymbolicLink()) {
            return { ok: false, error: `Refusing to remove a real directory: ${linkPath}` };
        }
        fs.unlinkSync(linkPath);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

function parkRealDir(dirPath: string): CentralResult {
    try {
        const parkedDir = path.join(path.dirname(dirPath), DISABLED_DIR_NAME);
        let parkedPath = path.join(parkedDir, path.basename(dirPath));
        if (fs.existsSync(parkedPath)) {
            parkedPath = path.join(parkedDir, `${path.basename(dirPath)}.replaced-${Date.now()}`);
        }
        fs.mkdirSync(parkedDir, { recursive: true });
        fs.renameSync(dirPath, parkedPath);
        return { ok: true, dirPath: parkedPath };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Move a real-directory skill into the central store and link it back from
 * its original root. Duplicate real-dir copies (same scope + name) are
 * parked under `.disabled/` — reversible, never destroyed.
 */
export function centralizeSkill(
    record: SkillRecord,
    duplicates: SkillRecord[],
    homeDir: string,
    workspaceRoot?: string,
): CentralResult {
    try {
        if (record.central) {
            return { ok: false, error: 'Skill is already centralized.' };
        }
        if (!record.enabled) {
            return { ok: false, error: 'Enable the skill before centralizing it.' };
        }
        const centralRoot = getCentralSkillsRoot(homeDir, record.scope, workspaceRoot);
        const destination = path.join(centralRoot, record.name);
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Central store already has ${record.name}: ${destination}` };
        }
        fs.mkdirSync(centralRoot, { recursive: true });
        fs.renameSync(record.dirPath, destination);
        // Link back from the record's original root so current effectiveness holds.
        const ownRoot = knownBrandRoots(homeDir, workspaceRoot)
            .find(root => root.source === record.source && root.scope === record.scope);
        if (ownRoot) {
            const link = setCentralLink(destination, ownRoot.dirPath, true);
            if (!link.ok) {
                return link;
            }
        }
        // Park duplicate real-dir copies.
        for (const duplicate of duplicates) {
            if (duplicate.dirPath === record.dirPath || duplicate.central || !duplicate.enabled) {
                continue;
            }
            const parked = parkRealDir(duplicate.dirPath);
            if (!parked.ok) {
                return parked;
            }
        }
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export type { SkillScope, SkillSourceDir };
