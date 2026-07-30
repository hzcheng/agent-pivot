'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { applySkillEffectiveness } from './effectiveness';
import { getSkillDiagnostics, parseSkillFrontmatter } from './frontmatter';
import {
    getCentralSkillsRoot,
    getProjectSkillsRoots,
    getUserSkillsRoots,
    isUnderCentralRoot,
    SkillsRoot,
} from './roots';
import { hashSkillDirectory } from './syncService';
import type { SkillDiagnostic, SkillRecord, SkillScope, SkillSourceDir } from './types';

export interface ScanSkillsInput {
    homeDir: string;
    workspaceRoot?: string;
    globalSkillsRoot?: string;
}

function readSkillFile(dirPath: string): { fileName: string; content: string } | null {
    for (const fileName of ['SKILL.md', 'skill.md']) {
        const filePath = path.join(dirPath, fileName);
        try {
            return { fileName, content: fs.readFileSync(filePath, 'utf8') };
        } catch (_error) {
            // try next candidate
        }
    }
    return null;
}

function createRecord(root: SkillsRoot, dirName: string, dirPath: string): SkillRecord | null {
    const skillFile = readSkillFile(dirPath);
    if (!skillFile) {
        return null;
    }
    const frontmatter = parseSkillFrontmatter(skillFile.content);
    const bodyLineCount = skillFile.content.split(/\r?\n/).length;
    return {
        name: dirName,
        description: frontmatter?.description || '',
        dirPath,
        skillFilePath: path.join(dirPath, skillFile.fileName),
        scope: root.scope,
        source: root.source,
        contentHash: hashSkillDirectory(dirPath),
        folder: '',
        visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        shadowedBy: {},
        diagnostics: getSkillDiagnostics({
            dirName,
            fileName: skillFile.fileName,
            frontmatter,
            bodyLineCount,
        }),
    };
}

interface SkillLink {
    source: SkillSourceDir;
    scope: SkillScope;
    linkPath: string;
    targetPath: string;
}

function scanDir(
    root: SkillsRoot,
    parentDir: string,
    links: SkillLink[],
    input: ScanSkillsInput,
): SkillRecord[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch (_error) {
        return [];
    }
    const records: SkillRecord[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        let dirPath = path.join(parentDir, entry.name);
        if (entry.isSymbolicLink()) {
            try {
                const resolved = fs.realpathSync(dirPath);
                if (!fs.statSync(resolved).isDirectory()) {
                    continue;
                }
                dirPath = resolved;
            } catch (_error) {
                continue;
            }
            // A symlink into the central store is an agent link, not a copy:
            // the record comes from the central-root scan, the link is noted.
            if (isUnderCentralRoot(dirPath, input.homeDir, input.workspaceRoot, input.globalSkillsRoot)) {
                links.push({
                    source: root.source,
                    scope: root.scope,
                    linkPath: path.join(parentDir, entry.name),
                    targetPath: dirPath,
                });
                continue;
            }
        } else if (!entry.isDirectory()) {
            continue;
        }
        const record = createRecord(root, entry.name, dirPath);
        if (record) {
            records.push(record);
        }
    }
    return records;
}

function scanRoot(root: SkillsRoot, links: SkillLink[], input: ScanSkillsInput): SkillRecord[] {
    // Dot-directories (including any legacy `.disabled`) stay skipped.
    return scanDir(root, root.dirPath, links, input);
}

function scanCentralStore(root: SkillsRoot, records: SkillRecord[], folders: string[]): void {
    const walk = (dirPath: string, folder: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (_error) {
            return;
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
            if (readSkillFile(realPath)) {
                const record = createRecord(root, entry.name, realPath);
                if (record) {
                    record.folder = folder;
                    records.push(record);
                }
            } else {
                const childFolder = folder ? `${folder}/${entry.name}` : entry.name;
                // Folder nodes exist even when empty (e.g. created via the panel "+").
                folders.push(childFolder);
                walk(realPath, childFolder);
            }
        }
    };
    walk(root.dirPath, '');
}

export interface ScanSkillsResult {
    records: SkillRecord[];
    /** Folder paths (relative to the store root) present in each central store, including empty ones. */
    storeFolders: Partial<Record<SkillScope, string[]>>;
}

export function scanSkillsDetailed(input: ScanSkillsInput): ScanSkillsResult {
    const roots = getUserSkillsRoots(input.homeDir)
        .concat(input.workspaceRoot ? getProjectSkillsRoots(input.workspaceRoot) : [])
        .concat(centralRoots(input));
    const links: SkillLink[] = [];
    const records: SkillRecord[] = [];
    const storeFolders: Partial<Record<SkillScope, string[]>> = { user: [], project: [] };
    for (const root of roots) {
        if (root.source === 'central') {
            scanCentralStore(root, records, storeFolders[root.scope] as string[]);
        } else {
            records.push(...scanRoot(root, links, input));
        }
    }
    return {
        records: applySkillEffectiveness(mergeCentralRecords(records, links, input), input),
        storeFolders,
    };
}

function centralRoots(input: ScanSkillsInput): SkillsRoot[] {
    const roots: SkillsRoot[] = [
        {
            source: 'central',
            scope: 'user',
            dirPath: getCentralSkillsRoot(input.homeDir, 'user', undefined, input.globalSkillsRoot),
        },
    ];
    if (input.workspaceRoot) {
        roots.push({ source: 'central', scope: 'project', dirPath: getCentralSkillsRoot(input.homeDir, 'project', input.workspaceRoot) });
    }
    return roots;
}

function mergeCentralRecords(records: SkillRecord[], links: SkillLink[], input: ScanSkillsInput): SkillRecord[] {
    const byDir = new Map<string, SkillRecord>();
    const merged: SkillRecord[] = [];
    for (const record of records) {
        const centralScope = isUnderCentralRoot(
            record.dirPath,
            input.homeDir,
            input.workspaceRoot,
            input.globalSkillsRoot,
        )?.scope;
        if (record.source === 'central' || centralScope) {
            let existing = byDir.get(record.dirPath);
            if (!existing) {
                existing = {
                    ...record,
                    source: 'central',
                    scope: centralScope || record.scope,
                    central: { dirPath: record.dirPath, links: {} },
                };
                byDir.set(record.dirPath, existing);
                merged.push(existing);
            }
        } else {
            merged.push(record);
        }
    }
    for (const link of links) {
        const record = byDir.get(link.targetPath);
        if (record && record.central && link.source !== 'central') {
            let scopedLinks = record.central.links[link.scope];
            if (!scopedLinks) {
                scopedLinks = {};
                record.central.links[link.scope] = scopedLinks;
            }
            scopedLinks[link.source] = link.linkPath;
        }
    }
    return merged;
}

export function scanSkills(input: ScanSkillsInput): SkillRecord[] {
    return scanSkillsDetailed(input).records;
}
