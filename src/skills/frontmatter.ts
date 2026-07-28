'use strict';

import type { SkillDiagnostic } from './types';

export interface SkillFrontmatter {
    name?: string;
    description?: string;
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content || '');
    if (!match) {
        return null;
    }
    const result: SkillFrontmatter = {};
    for (const line of match[1].split(/\r?\n/)) {
        const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!field) {
            continue;
        }
        const value = field[2].trim().replace(/^["']|["']$/g, '');
        if (field[1] === 'name') {
            result.name = value;
        } else if (field[1] === 'description') {
            result.description = value;
        }
    }
    return result;
}

export function getSkillDiagnostics(input: {
    dirName: string;
    fileName: string;
    frontmatter: SkillFrontmatter | null;
    bodyLineCount: number;
}): SkillDiagnostic[] {
    const diagnostics: SkillDiagnostic[] = [];
    if (input.fileName !== 'SKILL.md') {
        diagnostics.push({
            code: 'lowercase-filename',
            message: `Skill file must be named SKILL.md (found ${input.fileName}); discovery is case-sensitive.`,
        });
    }
    if (!input.frontmatter) {
        diagnostics.push({ code: 'missing-frontmatter', message: 'SKILL.md has no YAML frontmatter block.' });
        return diagnostics;
    }
    const { name, description } = input.frontmatter;
    if (!name) {
        diagnostics.push({ code: 'missing-name', message: 'Frontmatter is missing the name field.' });
    } else {
        if (name !== input.dirName) {
            diagnostics.push({ code: 'name-mismatch', message: `Frontmatter name "${name}" does not match directory "${input.dirName}".` });
        }
        if (name.length > MAX_NAME_LENGTH) {
            diagnostics.push({ code: 'name-too-long', message: `Frontmatter name exceeds ${MAX_NAME_LENGTH} characters.` });
        }
    }
    if (!description) {
        diagnostics.push({ code: 'missing-description', message: 'Frontmatter is missing the description field.' });
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({ code: 'description-too-long', message: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.` });
    }
    if (input.bodyLineCount > MAX_BODY_LINES) {
        diagnostics.push({ code: 'body-too-long', message: `SKILL.md body exceeds ${MAX_BODY_LINES} lines; move detail into references/.` });
    }
    return diagnostics;
}
