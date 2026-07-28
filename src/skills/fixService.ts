'use strict';

import * as fs from 'fs';
import * as path from 'path';

import type { SkillDiagnostic, SkillRecord } from './types';

export interface SkillFixResult {
    ok: boolean;
    error?: string;
}

export const FIXABLE_DIAGNOSTIC_CODES: ReadonlyArray<SkillDiagnostic['code']> = [
    'lowercase-filename',
    'name-mismatch',
    'missing-frontmatter',
    'missing-name',
];

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

function writeFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, 'utf8');
}

function fixLowercaseFilename(record: SkillRecord): void {
    const target = path.join(record.dirPath, 'SKILL.md');
    if (fs.existsSync(target)) {
        throw new Error(`SKILL.md already exists in ${record.dirPath}`);
    }
    fs.renameSync(record.skillFilePath, target);
}

function fixNameMismatch(record: SkillRecord): void {
    const content = readFile(record.skillFilePath);
    const match = FRONTMATTER_BLOCK.exec(content);
    if (!match) {
        throw new Error('SKILL.md has no frontmatter block to fix.');
    }
    const fixed = match[1]
        .split(/\r?\n/)
        .map(line => (/^name\s*:/.test(line) ? `name: ${record.name}` : line))
        .join('\n');
    writeFile(record.skillFilePath, content.replace(match[1], fixed));
}

function fixMissingFrontmatter(record: SkillRecord): void {
    const content = readFile(record.skillFilePath);
    const skeleton = `---\nname: ${record.name}\ndescription: \n---\n\n`;
    writeFile(record.skillFilePath, skeleton + content);
}

function fixMissingName(record: SkillRecord): void {
    const content = readFile(record.skillFilePath);
    const match = FRONTMATTER_BLOCK.exec(content);
    if (!match) {
        throw new Error('SKILL.md has no frontmatter block to fix.');
    }
    writeFile(
        record.skillFilePath,
        content.replace(FRONTMATTER_BLOCK, `---\nname: ${record.name}\n${match[1]}\n---\n`)
    );
}

/**
 * Applies the automatic repair for a fixable diagnostic. Every write goes
 * through a narrow try/catch and returns a result instead of throwing.
 */
export function fixSkillDiagnostic(record: SkillRecord, code: SkillDiagnostic['code']): SkillFixResult {
    try {
        switch (code) {
            case 'lowercase-filename':
                fixLowercaseFilename(record);
                return { ok: true };
            case 'name-mismatch':
                fixNameMismatch(record);
                return { ok: true };
            case 'missing-frontmatter':
                fixMissingFrontmatter(record);
                return { ok: true };
            case 'missing-name':
                fixMissingName(record);
                return { ok: true };
            default:
                return { ok: false, error: `No automatic fix available for ${code}.` };
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
