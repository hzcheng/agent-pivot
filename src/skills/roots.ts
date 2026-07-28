'use strict';

import * as path from 'path';

import type { SkillScope, SkillSourceDir } from './types';

export interface SkillsRoot {
    source: SkillSourceDir;
    scope: SkillScope;
    dirPath: string;
}

export const DISABLED_DIR_NAME = '.disabled';
export const CENTRAL_DIR_NAME = '.skills';

export function getCentralSkillsRoot(homeDir: string, scope: SkillScope, workspaceRoot?: string): string {
    return scope === 'user'
        ? path.join(homeDir, CENTRAL_DIR_NAME)
        : path.join(workspaceRoot as string, CENTRAL_DIR_NAME);
}

export function isUnderCentralRoot(dirPath: string, homeDir: string, workspaceRoot?: string): { scope: SkillScope } | null {
    const userCentral = getCentralSkillsRoot(homeDir, 'user');
    if (dirPath.startsWith(userCentral + path.sep)) {
        return { scope: 'user' };
    }
    if (workspaceRoot) {
        const projectCentral = getCentralSkillsRoot(homeDir, 'project', workspaceRoot);
        if (dirPath.startsWith(projectCentral + path.sep)) {
            return { scope: 'project' };
        }
    }
    return null;
}

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
