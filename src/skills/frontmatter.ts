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
    // Tolerate a UTF-8 BOM before the opening fence.
    const text = (content || '').replace(/^\uFEFF/, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) {
        return null;
    }
    const lines = match[1].split(/\r?\n/);
    const result: SkillFrontmatter = {};
    for (let index = 0; index < lines.length; index++) {
        const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]);
        if (!field || (field[1] !== 'name' && field[1] !== 'description')) {
            continue;
        }
        const key = field[1];
        const raw = field[2].trim();
        if (!/^[>|][+-]?$/.test(raw)) {
            result[key] = raw.replace(/^["']|["']$/g, '');
            continue;
        }
        // YAML block scalar (`>`, `>-`, `|`, `|-`, …): consume the following
        // blank or more-indented lines, then fold/literal-join per the indicator.
        const block: string[] = [];
        while (index + 1 < lines.length
            && (lines[index + 1].trim() === '' || /^\s+\S/.test(lines[index + 1]))) {
            index++;
            block.push(lines[index]);
        }
        while (block.length && block[block.length - 1].trim() === '') {
            block.pop();
        }
        const nonBlank = block.filter(line => line.trim() !== '');
        if (!nonBlank.length) {
            result[key] = '';
            continue;
        }
        const minIndent = Math.min(...nonBlank.map(line => line.length - line.trimStart().length));
        const stripped = block.map(line => (line.trim() === '' ? '' : line.slice(minIndent).trimEnd()));
        if (raw.startsWith('|')) {
            result[key] = stripped.join('\n').trim();
            continue;
        }
        // Folded: lines within a paragraph join with a space, blank-line
        // separated paragraphs keep a single newline.
        const paragraphs: string[] = [];
        let current: string[] = [];
        for (const line of stripped) {
            if (line === '') {
                if (current.length) {
                    paragraphs.push(current.join(' '));
                    current = [];
                }
            } else {
                current.push(line.trim());
            }
        }
        if (current.length) {
            paragraphs.push(current.join(' '));
        }
        result[key] = paragraphs.join('\n').trim();
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
