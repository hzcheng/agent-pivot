'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { applySkillEffectiveness } from './effectiveness';
import { getSkillDiagnostics, parseSkillFrontmatter } from './frontmatter';
import { DISABLED_DIR_NAME, getProjectSkillsRoots, getUserSkillsRoots, SkillsRoot } from './roots';
import type { SkillDiagnostic, SkillRecord } from './types';

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

function scanDir(root: SkillsRoot, parentDir: string, enabled: boolean): SkillRecord[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch (_error) {
        return [];
    }
    const records: SkillRecord[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }
        const record = createRecord(root, entry.name, path.join(parentDir, entry.name), enabled);
        if (record) {
            records.push(record);
        }
    }
    return records;
}

function scanRoot(root: SkillsRoot): SkillRecord[] {
    // Active skills come from the root listing (dot-directories stay skipped there);
    // parked skills are first-level children of the root's `.disabled` directory.
    return scanDir(root, root.dirPath, true)
        .concat(scanDir(root, path.join(root.dirPath, DISABLED_DIR_NAME), false));
}

export function scanSkills(input: ScanSkillsInput): SkillRecord[] {
    const roots = getUserSkillsRoots(input.homeDir)
        .concat(input.workspaceRoot ? getProjectSkillsRoots(input.workspaceRoot) : []);
    return applySkillEffectiveness(
        roots.reduce<SkillRecord[]>((records, root) => records.concat(scanRoot(root)), []),
        input
    );
}
