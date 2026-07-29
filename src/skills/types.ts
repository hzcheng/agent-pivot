'use strict';

export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillVisibility = 'active' | 'shadowed' | 'absent';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents' | 'central';

/** links[scope][source] = link path; source is one of kimi|claude|codex|agents ('central' never appears). */
export type SkillLinkMap = Partial<Record<SkillScope, Partial<Record<SkillSourceDir, string>>>>;

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
    contentHash?: string;
    /** Folder path inside the central store ('' = store root, 'a/b' = nested). Always '' for non-central records. */
    folder: string;
    central?: SkillCentralInfo;
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    /** Central records with project-scope links: effectiveness evaluated at project scope (inherits user links). */
    projectVisibility?: Record<SkillAgentId, SkillVisibility>;
    projectShadowedBy?: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
}

export interface SkillCentralInfo {
    /** Real directory inside the central store (`~/.skills` or `<project>/.skills`). */
    dirPath: string;
    /** Which agent/generic skills roots link to the central directory, by scope. */
    links: SkillLinkMap;
}
