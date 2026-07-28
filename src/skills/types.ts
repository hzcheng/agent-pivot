'use strict';

export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillVisibility = 'active' | 'shadowed' | 'absent';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents' | 'central';

export interface SkillDiagnostic {
    code: 'missing-frontmatter' | 'missing-name' | 'missing-description'
        | 'name-mismatch' | 'name-too-long' | 'description-too-long'
        | 'body-too-long' | 'lowercase-filename' | 'unreadable';
    message: string;
}

export interface SkillRecord {
    name: string;
    description: string;
    dirPath: string;
    skillFilePath: string;
    scope: SkillScope;
    source: SkillSourceDir;
    enabled: boolean;
    contentHash?: string;
    central?: SkillCentralInfo;
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
}

export interface SkillCentralInfo {
    /** Real directory inside the central store (`~/.skills` or `<project>/.skills`). */
    dirPath: string;
    /** Which agent/generic skills roots link to the central directory, and where. */
    links: Partial<Record<SkillSourceDir, string>>;
}
