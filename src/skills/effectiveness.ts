'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { getKimiBrandCandidates, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import type { SkillAgentId, SkillRecord, SkillScope } from './types';

interface EffectivenessInput {
    homeDir: string;
    workspaceRoot?: string;
    dirExists?: (dirPath: string) => boolean;
}

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

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
    return cloned;
}
