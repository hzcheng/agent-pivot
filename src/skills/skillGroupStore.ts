'use strict';

import * as path from 'path';

import type { SkillRecord } from './types';

export interface SkillGroupStoreState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export const SKILL_GROUPS_STATE_KEY = 'agentPivot.skillGroups';
export const SKILL_COLLECTION_DISMISSALS_KEY = 'agentPivot.dismissedSkillCollectionSuggestions';

export type SkillGroupMap = Record<string, string>;

/** Stable identity for a skill: `<skills root>/<name>`. */
export function getSkillStableKey(record: SkillRecord): string {
    return path.join(path.dirname(record.dirPath), record.name);
}

export function getSkillGroupName(record: SkillRecord, groups: SkillGroupMap): string | undefined {
    const group = groups[getSkillStableKey(record)];
    return typeof group === 'string' && group.trim() ? group.trim() : undefined;
}

export class SkillGroupStore {
    private cache: SkillGroupMap | undefined;
    private dismissedCache: string[] | undefined;

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

    getDismissedCollections(): string[] {
        if (!this.dismissedCache) {
            const stored = this.state.get<string[]>(SKILL_COLLECTION_DISMISSALS_KEY);
            this.dismissedCache = Array.isArray(stored) ? [...stored] : [];
        }
        return this.dismissedCache;
    }

    async dismissCollection(name: string): Promise<void> {
        const next = [...new Set([...this.getDismissedCollections(), name])];
        this.dismissedCache = next;
        await this.state.update(SKILL_COLLECTION_DISMISSALS_KEY, next);
    }
}
