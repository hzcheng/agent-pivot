'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { getKimiBrandCandidates, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import type { SkillAgentId, SkillRecord, SkillScope, SkillSourceDir, SkillVisibility } from './types';

interface EffectivenessInput {
    homeDir: string;
    workspaceRoot?: string;
    dirExists?: (dirPath: string) => boolean;
}

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

// Centralized skills are effective where they are linked, evaluated against one
// scope's link map and that scope's Kimi brand winner.
function applyCentralScope(record: SkillRecord, links: Partial<Record<SkillSourceDir, string>>, brandWinnerDir: string | null,
    visibility: Record<SkillAgentId, SkillVisibility>, shadowedBy: Partial<Record<SkillAgentId, string>>): void {
    for (const agent of AGENTS) {
        visibility[agent] = 'absent';
        delete shadowedBy[agent];
    }
    if (links.agents) {
        visibility.kimi = 'active';
    } else if (brandWinnerDir && Object.values(links).some(link => link.startsWith(brandWinnerDir + path.sep))) {
        visibility.kimi = 'active';
    } else if (brandWinnerDir && (links.kimi || links.claude || links.codex)) {
        visibility.kimi = 'shadowed';
        shadowedBy.kimi = brandWinnerDir;
    }
    for (const agent of AGENTS) {
        if (agent !== 'kimi' && links[agent]) {
            visibility[agent] = 'active';
        }
    }
}

function applyScope(
    records: SkillRecord[],
    scope: SkillScope,
    brandWinnerDir: string | null
): void {
    for (const record of records.filter(candidate => candidate.scope === scope)) {
        // Parked (disabled) skills are excluded from effectiveness entirely:
        // their visibility stays all-'absent' and shadowedBy stays empty.
        if (!record.enabled) {
            continue;
        }
        // Recompute per scope: a missing brand winner means brand records are absent,
        // even when re-applying to records that already went through effectiveness.
        record.visibility.kimi = 'absent';
        delete record.shadowedBy.kimi;
        if (record.central) {
            // Centralized skills are effective where they are linked: evaluate the
            // link map of the scope being applied (links.user for the user pass,
            // links.project for the project pass).
            applyCentralScope(record, record.central.links[scope] || {}, brandWinnerDir, record.visibility, record.shadowedBy);
            continue;
        }
        if (record.source === 'agents') {
            record.visibility.kimi = 'active';
        } else if (brandWinnerDir && record.dirPath.startsWith(brandWinnerDir + path.sep)) {
            record.visibility.kimi = 'active';
        } else if (brandWinnerDir) {
            record.visibility.kimi = 'shadowed';
            record.shadowedBy.kimi = brandWinnerDir;
        }
        for (const agent of AGENTS) {
            if (agent === 'kimi') {
                continue;
            }
            if (record.source === agent) {
                record.visibility[agent] = 'active';
            }
        }
    }
}

export function applySkillEffectiveness(records: SkillRecord[], input: EffectivenessInput): SkillRecord[] {
    const dirExists = input.dirExists || ((dirPath: string) => fs.existsSync(dirPath));
    const cloned = records.map(record => ({
        ...record,
        visibility: { ...record.visibility },
        shadowedBy: { ...record.shadowedBy },
    }));

    const userWinner = getKimiBrandCandidates(getUserSkillsRoots(input.homeDir))
        .find(root => dirExists(root.dirPath));
    applyScope(cloned, 'user', userWinner ? userWinner.dirPath : null);

    if (input.workspaceRoot) {
        const projectWinner = getKimiBrandCandidates(getProjectSkillsRoots(input.workspaceRoot))
            .find(root => dirExists(root.dirPath));
        applyScope(cloned, 'project', projectWinner ? projectWinner.dirPath : null);
    }

    // Third pass: central records linked from project roots also carry a project-scope
    // evaluation. Same rules against the project brand winner, except an agent already
    // active via the user links stays active (user links inherit into the project).
    // Project-store records are skipped: their `visibility` already is the project evaluation.
    const projectWinnerDir = input.workspaceRoot
        ? (getKimiBrandCandidates(getProjectSkillsRoots(input.workspaceRoot)).find(root => dirExists(root.dirPath))?.dirPath || null)
        : null;
    for (const record of cloned.filter(candidate => candidate.enabled && candidate.central && candidate.scope !== 'project' && candidate.central.links.project)) {
        const projectVisibility = { kimi: 'absent', claude: 'absent', codex: 'absent' } as Record<SkillAgentId, SkillVisibility>;
        const projectShadowedBy: Partial<Record<SkillAgentId, string>> = {};
        applyCentralScope(record, record.central?.links.project || {}, projectWinnerDir, projectVisibility, projectShadowedBy);
        // inheritance: user-active stays active at project scope
        for (const agent of AGENTS) {
            if (record.visibility[agent] === 'active') {
                projectVisibility[agent] = 'active';
                delete projectShadowedBy[agent];
            }
        }
        record.projectVisibility = projectVisibility;
        record.projectShadowedBy = projectShadowedBy;
    }
    return cloned;
}
