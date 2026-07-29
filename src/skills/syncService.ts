'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { getSkillStableKey } from './skillGroupStore';
import type { SkillRecord, SkillScope, SkillSourceDir } from './types';

/**
 * Content fingerprint of a skill directory: a hash over every file's
 * relative path and content, so two copies of "the same" skill can be
 * compared for drift.
 */
export function hashSkillDirectory(dirPath: string): string {
    const hash = crypto.createHash('sha256');
    const walk = (current: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_error) {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    continue;
                }
                walk(entryPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            try {
                hash.update(path.relative(dirPath, entryPath));
                hash.update('\0');
                hash.update(fs.readFileSync(entryPath));
                hash.update('\0');
            } catch (_error) {
                // Unreadable files simply do not contribute to the fingerprint.
            }
        }
    };
    walk(dirPath);
    return hash.digest('hex');
}

export interface SkillDuplicateGroup {
    name: string;
    scope: SkillScope;
    drift: boolean;
    copies: Array<{ dirPath: string; contentHash: string }>;
}

/**
 * Groups same-scope same-name records. `drift` is true when their content
 * fingerprints differ. Groups with a single copy never appear.
 */
export function computeSkillDuplicates(records: SkillRecord[]): Map<string, SkillDuplicateGroup> {
    const byKey = new Map<string, SkillDuplicateGroup>();
    for (const record of records) {
        const key = `${record.scope}:${record.name}`;
        let group = byKey.get(key);
        if (!group) {
            group = { name: record.name, scope: record.scope, drift: false, copies: [] };
            byKey.set(key, group);
        }
        group.copies.push({ dirPath: record.dirPath, contentHash: record.contentHash || '' });
    }
    for (const [key, group] of byKey) {
        if (group.copies.length < 2) {
            byKey.delete(key);
            continue;
        }
        group.copies.sort((a, b) => a.dirPath.localeCompare(b.dirPath));
        group.drift = new Set(group.copies.map(copy => copy.contentHash)).size > 1;
    }
    return byKey;
}

export interface SkillCopyTarget {
    rootDir: string;
    source: SkillSourceDir;
    scope: SkillScope;
}

/**
 * For every record, the brand roots in the same scope where no skill with
 * the same name exists — the destinations a "Copy to …" action can offer.
 */
export function computeSkillCopyTargets(
    records: SkillRecord[],
    homeDir: string,
    workspaceRoot?: string,
): Map<string, SkillCopyTarget[]> {
    const brandRoots = getUserSkillsRoots(homeDir)
        .concat(workspaceRoot ? getProjectSkillsRoots(workspaceRoot) : [])
        .filter(root => root.source !== 'agents');
    const result = new Map<string, SkillCopyTarget[]>();
    for (const record of records) {
        if (record.central) {
            continue;
        }
        const taken = new Set<string>();
        for (const candidate of records) {
            if (candidate.scope !== record.scope || candidate.name !== record.name) {
                continue;
            }
            const parent = path.dirname(candidate.dirPath);
            taken.add(parent);
            if (candidate.central) {
                for (const scopedLinks of Object.values(candidate.central.links)) {
                    for (const link of Object.values(scopedLinks)) {
                        taken.add(path.dirname(link));
                    }
                }
            }
        }
        const targets = brandRoots
            .filter(root => root.scope === record.scope && !taken.has(root.dirPath))
            .map(root => ({ rootDir: root.dirPath, source: root.source, scope: root.scope }));
        if (targets.length) {
            result.set(getSkillStableKey(record), targets);
        }
    }
    return result;
}

export interface SkillFsResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
}

function copyDirRecursive(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const source = path.join(sourceDir, entry.name);
        const target = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') {
                continue;
            }
            copyDirRecursive(source, target);
        } else if (entry.isFile()) {
            fs.copyFileSync(source, target);
        }
    }
}

/**
 * Drift resolution: the losing target is moved aside into a temp directory,
 * the winning copy is copied into its place, and the aside is deleted. On
 * copy failure the aside is rolled back so the target never ends up missing.
 */
export function syncSkillDir(sourceDir: string, targetDir: string): SkillFsResult {
    let aside: string | null = null;
    try {
        const name = path.basename(targetDir);
        // The aside must live on the same filesystem as the target: renameSync
        // throws EXDEV across mounts (e.g. tmpfs /tmp vs $HOME on Linux).
        aside = fs.mkdtempSync(path.join(path.dirname(targetDir), '.agent-pivot-skill-sync-'));
        const asidePath = path.join(aside, name);
        fs.renameSync(targetDir, asidePath);
        try {
            copyDirRecursive(sourceDir, targetDir);
        } catch (error) {
            // Roll the aside back so the target never ends up missing.
            fs.renameSync(asidePath, targetDir);
            throw error;
        }
        fs.rmSync(aside, { recursive: true, force: true });
        return { ok: true, dirPath: targetDir };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        if (aside) {
            try { fs.rmSync(aside, { recursive: true, force: true }); } catch (_error) { /* best effort */ }
        }
    }
}

/** J6: copy a skill into another agent's skills root. Never overwrites. */
export function copySkillDir(sourceDir: string, targetRootDir: string): SkillFsResult {
    try {
        const destination = path.join(targetRootDir, path.basename(sourceDir));
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Destination already exists: ${destination}` };
        }
        fs.mkdirSync(targetRootDir, { recursive: true });
        copyDirRecursive(sourceDir, destination);
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
