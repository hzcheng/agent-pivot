'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { DISABLED_DIR_NAME } from './roots';

export interface SkillToggleResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
}

function move(dirPath: string, targetDir: string): SkillToggleResult {
    const name = path.basename(dirPath);
    const destination = path.join(targetDir, name);
    try {
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Destination already exists: ${destination}` };
        }
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(dirPath, destination);
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export function disableSkill(dirPath: string): SkillToggleResult {
    if (path.basename(path.dirname(dirPath)) === DISABLED_DIR_NAME) {
        return { ok: false, error: 'Skill is already disabled.' };
    }
    return move(dirPath, path.join(path.dirname(dirPath), DISABLED_DIR_NAME));
}

export function enableSkill(dirPath: string): SkillToggleResult {
    if (path.basename(path.dirname(dirPath)) !== DISABLED_DIR_NAME) {
        return { ok: false, error: 'Skill is not disabled.' };
    }
    return move(dirPath, path.dirname(path.dirname(dirPath)));
}
