'use strict';

import * as path from 'path';

import { DISABLED_DIR_NAME } from './roots';
import type { SkillRecord } from './types';

export interface SkillGroupStoreState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export const SKILL_GROUPS_STATE_KEY = 'agentPivot.skillGroups';

export type SkillGroupMap = Record<string, string>;

/**
 * Stable identity for a skill that survives enable/disable moves:
 * `<skills root>/<name>` even when the skill is parked under `.disabled/`.
 */
export function getSkillStableKey(record: SkillRecord): string {
    const parent = path.dirname(record.dirPath);
    const rootDir = path.basename(parent) === DISABLED_DIR_NAME ? path.dirname(parent) : parent;
    return path.join(rootDir, record.name);
}

export function getSkillGroupName(record: SkillRecord, groups: SkillGroupMap): string | undefined {
    const group = groups[getSkillStableKey(record)];
    return typeof group === 'string' && group.trim() ? group.trim() : undefined;
}

export class SkillGroupStore {
    private cache: SkillGroupMap | undefined;

    constructor(private readonly state: SkillGroupStoreState) {
    }

    getGroups(): SkillGroupMap {
        if (!this.cache) {
            const stored = this.state.get<SkillGroupMap>(SKILL_GROUPS_STATE_KEY);
            this.cache = stored && typeof stored === 'object' ? { ...stored } : {};
        }
        return this.cache;
    }

    getGroupName(record: SkillRecord): string | undefined {
        return getSkillGroupName(record, this.getGroups());
    }

    async setGroup(record: SkillRecord, groupName: string): Promise<void> {
        const next = { ...this.getGroups() };
        const key = getSkillStableKey(record);
        const trimmed = groupName.trim();
        if (trimmed) {
            next[key] = trimmed;
        } else {
            delete next[key];
        }
        this.cache = next;
        await this.state.update(SKILL_GROUPS_STATE_KEY, next);
    }
}
