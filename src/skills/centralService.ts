'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { getCentralSkillsRoot, getProjectSkillsRoots, getUserSkillsRoots, SkillsRoot } from './roots';
import type { SkillAgentId, SkillRecord, SkillScope, SkillSourceDir } from './types';

export interface CentralResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
}

export interface FolderLinkResult {
    ok: boolean;
    changed: number;
    errors: Array<{ name: string; error: string }>;
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
export function setCentralLink(
    centralDir: string, rootDir: string, enable: boolean,
): CentralResult & { changed?: boolean } {
    const linkPath = path.join(rootDir, path.basename(centralDir));
    try {
        if (enable) {
            if (isSymlinkTo(linkPath, centralDir)) {
                return { ok: true, dirPath: linkPath, changed: false };
            }
            if (fs.existsSync(linkPath)) {
                return { ok: false, error: `Something else already exists at ${linkPath}` };
            }
            fs.mkdirSync(rootDir, { recursive: true });
            fs.symlinkSync(centralDir, linkPath, 'dir');
            return { ok: true, dirPath: linkPath, changed: true };
        }
        let stat: fs.Stats | null = null;
        try {
            // lstat (not existsSync) so dangling symlinks are still detected.
            stat = fs.lstatSync(linkPath);
        } catch (_error) {
            stat = null;
        }
        if (!stat) {
            return { ok: true, changed: false };
        }
        if (!stat.isSymbolicLink()) {
            return { ok: false, error: `Refusing to remove a real directory: ${linkPath}` };
        }
        fs.unlinkSync(linkPath);
        return { ok: true, changed: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

function deleteRealDir(dirPath: string): CentralResult {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Move a real-directory skill into the central store and link it back from
 * its original root. Duplicate real-dir copies (same scope + name) are
 * deleted once the winner is secured (move + link-back succeeded).
 */
export function centralizeSkill(
    record: SkillRecord,
    duplicates: SkillRecord[],
    homeDir: string,
    workspaceRoot?: string,
    options: CentralizeOptions = {},
): CentralResult {
    try {
        if (record.central) {
            return { ok: false, error: 'Skill is already centralized.' };
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
        if (options.linkBack !== false && ownRoot) {
            const link = setCentralLink(destination, ownRoot.dirPath, true);
            if (!link.ok) {
                return link;
            }
        }
        // Delete duplicate real-dir copies now that the winner is secured.
        for (const duplicate of duplicates) {
            if (duplicate.dirPath === record.dirPath || duplicate.central) {
                continue;
            }
            const deleted = deleteRealDir(duplicate.dirPath);
            if (!deleted.ok) {
                return deleted;
            }
        }
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export interface CentralizeOptions {
    /** Link the centralized skill back from its original root (default true). */
    linkBack?: boolean;
}

function walkSkillDirs(dirPath: string, found: string[]): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_error) {
        return found;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        let realPath = fullPath;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try {
                realPath = fs.realpathSync(fullPath);
                isDirectory = fs.statSync(realPath).isDirectory();
            } catch (_error) {
                continue;
            }
        }
        if (!isDirectory) {
            continue;
        }
        if (fs.existsSync(path.join(realPath, 'SKILL.md')) || fs.existsSync(path.join(realPath, 'skill.md'))) {
            if (!found.includes(realPath)) {
                found.push(realPath);
            }
        } else {
            walkSkillDirs(realPath, found);
        }
    }
    return found;
}

/**
 * Batch enable/disable every skill under a central-store folder (recursively)
 * for all brand agents at one scope. Collects per-skill errors instead of
 * stopping; `changed` counts only actual create/remove transitions.
 */
export function setFolderLinks(
    storeRoot: string, folder: string, scope: SkillScope,
    homeDir: string, workspaceRoot: string | undefined, enable: boolean,
    agents: SkillAgentId[] = ['kimi', 'claude', 'codex'],
): FolderLinkResult {
    if (scope === 'project' && !workspaceRoot) {
        return { ok: false, changed: 0, errors: [{ name: folder || '.', error: 'No workspace is open for project-scope links.' }] };
    }
    const result: FolderLinkResult = { ok: true, changed: 0, errors: [] };
    const roots = scope === 'user' ? getUserSkillsRoots(homeDir) : getProjectSkillsRoots(workspaceRoot as string);
    const agentRoots = roots.filter(root => agents.includes(root.source as SkillAgentId)
        && (root.source === 'kimi' || root.source === 'claude' || root.source === 'codex'));
    for (const skillDir of walkSkillDirs(path.join(storeRoot, folder), [])) {
        for (const root of agentRoots) {
            const link = setCentralLink(skillDir, root.dirPath, enable);
            if (link.ok) {
                if (link.changed) {
                    result.changed += 1;
                }
            } else {
                result.ok = false;
                result.errors.push({ name: path.basename(skillDir), error: link.error || 'unknown error' });
            }
        }
    }
    return result;
}

function sanitizeFolder(targetFolder: string): string | null {
    const trimmed = targetFolder.trim().replace(/\/+$/u, '');
    if (!trimmed) {
        return '';
    }
    if (path.isAbsolute(trimmed)) {
        return null;
    }
    const segments = trimmed.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
        return null;
    }
    return segments.join('/');
}

/**
 * Move a centralized skill to a different folder inside its central store and
 * re-point every existing link (both scopes) at the new location.
 */
export function moveSkillToFolder(
    record: SkillRecord, targetFolder: string, homeDir: string, workspaceRoot?: string,
): CentralResult {
    try {
        if (!record.central) {
            return { ok: false, error: 'Only centralized skills can be moved between folders.' };
        }
        const folder = sanitizeFolder(targetFolder);
        if (folder === null) {
            return { ok: false, error: `Invalid folder: ${targetFolder}` };
        }
        const storeRoot = getCentralSkillsRoot(homeDir, record.scope, workspaceRoot);
        const destination = folder ? path.join(storeRoot, folder, record.name) : path.join(storeRoot, record.name);
        if (destination === record.dirPath) {
            return { ok: true, dirPath: destination };
        }
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Already exists: ${destination}` };
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(record.dirPath, destination);
        // Re-point every existing link (both scopes) at the new location.
        for (const scopeLinks of Object.values(record.central.links)) {
            for (const linkPath of Object.values(scopeLinks || {})) {
                try {
                    if (fs.lstatSync(linkPath).isSymbolicLink()) {
                        fs.unlinkSync(linkPath);
                        fs.symlinkSync(destination, linkPath, 'dir');
                    }
                } catch (_error) {
                    // best effort; a rescan surfaces any stale link
                }
            }
        }
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export type { SkillScope, SkillSourceDir };

/**
 * Create a folder inside a central store (nested paths allowed). Folders are
 * plain directories; creating them on demand is how the panel's "+" works.
 */
export function createSkillFolder(storeRoot: string, targetFolder: string): CentralResult {
    try {
        const folder = sanitizeFolder(targetFolder);
        if (folder === null || folder === '') {
            return { ok: false, error: `Invalid folder: ${targetFolder}` };
        }
        const destination = path.join(storeRoot, folder);
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Folder already exists: ${destination}` };
        }
        fs.mkdirSync(destination, { recursive: true });
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Delete a folder inside a central store. Only empty folders (no skills
 * anywhere in the subtree) can be deleted — skills must be moved out first,
 * which keeps the operation non-destructive.
 */
export function removeSkillFolder(storeRoot: string, targetFolder: string): CentralResult {
    try {
        const folder = sanitizeFolder(targetFolder);
        if (folder === null || folder === '') {
            return { ok: false, error: `Invalid folder: ${targetFolder}` };
        }
        const destination = path.join(storeRoot, folder);
        if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) {
            return { ok: false, error: `Unknown folder: ${destination}` };
        }
        if (walkSkillDirs(destination, []).length) {
            return { ok: false, error: 'Folder is not empty — move its skills out first.' };
        }
        fs.rmSync(destination, { recursive: true, force: true });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
