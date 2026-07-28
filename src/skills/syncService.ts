'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { DISABLED_DIR_NAME, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
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
        const taken = new Set(
            records
                .filter(candidate => candidate.scope === record.scope && candidate.name === record.name)
                .map(candidate => {
                    const parent = path.dirname(candidate.dirPath);
                    return path.basename(parent) === DISABLED_DIR_NAME ? path.dirname(parent) : parent;
                })
        );
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
 * Drift resolution: park the losing copy under `.disabled/<name>.replaced-<ts>`
 * (reversible, never destroyed) and copy the winning copy into its place.
 */
export function syncSkillDir(sourceDir: string, targetDir: string): SkillFsResult {
    try {
        const name = path.basename(targetDir);
        const parkedDir = path.join(path.dirname(targetDir), DISABLED_DIR_NAME);
        let parkedPath = path.join(parkedDir, `${name}.replaced-${Date.now()}`);
        if (fs.existsSync(parkedPath)) {
            parkedPath = path.join(parkedDir, `${name}.replaced-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
        }
        fs.mkdirSync(parkedDir, { recursive: true });
        fs.renameSync(targetDir, parkedPath);
        try {
            copyDirRecursive(sourceDir, targetDir);
        } catch (error) {
            // Roll the parked copy back so the target never ends up missing.
            fs.renameSync(parkedPath, targetDir);
            throw error;
        }
        return { ok: true, dirPath: targetDir };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
