'use strict';

import * as path from 'path';

import type { SkillScope, SkillSourceDir } from './types';

export interface SkillsRoot {
    source: SkillSourceDir;
    scope: SkillScope;
    dirPath: string;
}

export const DISABLED_DIR_NAME = '.disabled';

export function getUserSkillsRoots(homeDir: string): SkillsRoot[] {
    return [
        { source: 'kimi', scope: 'user', dirPath: path.join(homeDir, '.kimi', 'skills') },
        { source: 'claude', scope: 'user', dirPath: path.join(homeDir, '.claude', 'skills') },
        { source: 'codex', scope: 'user', dirPath: path.join(homeDir, '.codex', 'skills') },
        { source: 'agents', scope: 'user', dirPath: path.join(homeDir, '.config', 'agents', 'skills') },
        { source: 'agents', scope: 'user', dirPath: path.join(homeDir, '.agents', 'skills') },
    ];
}

export function getProjectSkillsRoots(workspaceRoot: string): SkillsRoot[] {
    return [
        { source: 'kimi', scope: 'project', dirPath: path.join(workspaceRoot, '.kimi', 'skills') },
        { source: 'claude', scope: 'project', dirPath: path.join(workspaceRoot, '.claude', 'skills') },
        { source: 'codex', scope: 'project', dirPath: path.join(workspaceRoot, '.codex', 'skills') },
        { source: 'agents', scope: 'project', dirPath: path.join(workspaceRoot, '.agents', 'skills') },
    ];
}

export function getKimiBrandCandidates(roots: SkillsRoot[]): SkillsRoot[] {
    const order: SkillSourceDir[] = ['kimi', 'claude', 'codex'];
    return order
        .map(source => roots.find(root => root.source === source))
        .filter((root): root is SkillsRoot => Boolean(root));
}
