'use strict';

export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillVisibility = 'active' | 'shadowed' | 'absent';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents';

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
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
}
