'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { applySkillEffectiveness } from './effectiveness';
import { getSkillDiagnostics, parseSkillFrontmatter } from './frontmatter';
import {
    DISABLED_DIR_NAME,
    getCentralSkillsRoot,
    getProjectSkillsRoots,
    getUserSkillsRoots,
    isUnderCentralRoot,
    SkillsRoot,
} from './roots';
import { hashSkillDirectory } from './syncService';
import type { SkillDiagnostic, SkillRecord, SkillSourceDir } from './types';

export interface ScanSkillsInput {
    homeDir: string;
    workspaceRoot?: string;
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

function createRecord(root: SkillsRoot, dirName: string, dirPath: string, enabled: boolean): SkillRecord | null {
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
        enabled,
        contentHash: hashSkillDirectory(dirPath),
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
    linkPath: string;
    targetPath: string;
}

function scanDir(
    root: SkillsRoot,
    parentDir: string,
    enabled: boolean,
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
            if (isUnderCentralRoot(dirPath, input.homeDir, input.workspaceRoot)) {
                links.push({ source: root.source, linkPath: path.join(parentDir, entry.name), targetPath: dirPath });
                continue;
            }
        } else if (!entry.isDirectory()) {
            continue;
        }
        const record = createRecord(root, entry.name, dirPath, enabled);
        if (record) {
            records.push(record);
        }
    }
    return records;
}

function scanRoot(root: SkillsRoot, links: SkillLink[], input: ScanSkillsInput): SkillRecord[] {
    // Active skills come from the root listing (dot-directories stay skipped there);
    // parked skills are first-level children of the root's `.disabled` directory.
    return scanDir(root, root.dirPath, true, links, input)
        .concat(scanDir(root, path.join(root.dirPath, DISABLED_DIR_NAME), false, links, input));
}

function centralRoots(input: ScanSkillsInput): SkillsRoot[] {
    const roots: SkillsRoot[] = [
        { source: 'central', scope: 'user', dirPath: getCentralSkillsRoot(input.homeDir, 'user') },
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
        if (record.source === 'central' || isUnderCentralRoot(record.dirPath, input.homeDir, input.workspaceRoot)) {
            let existing = byDir.get(record.dirPath);
            if (!existing) {
                existing = {
                    ...record,
                    source: 'central',
                    scope: isUnderCentralRoot(record.dirPath, input.homeDir, input.workspaceRoot)?.scope || record.scope,
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
            record.central.links[link.source] = link.linkPath;
        }
    }
    return merged;
}

export function scanSkills(input: ScanSkillsInput): SkillRecord[] {
    const roots = getUserSkillsRoots(input.homeDir)
        .concat(input.workspaceRoot ? getProjectSkillsRoots(input.workspaceRoot) : [])
        .concat(centralRoots(input));
    const links: SkillLink[] = [];
    const records = roots.reduce<SkillRecord[]>((all, root) => all.concat(scanRoot(root, links, input)), []);
    return applySkillEffectiveness(
        mergeCentralRecords(records, links, input),
        input
    );
}
