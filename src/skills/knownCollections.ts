'use strict';

import { getSkillGroupName, getSkillStableKey, SkillGroupMap } from './skillGroupStore';
import type { SkillRecord } from './types';

export interface KnownSkillCollection {
    name: string;
    members: ReadonlyArray<string>;
}

/**
 * Curated list of widely installed skill collections. Membership is by skill
 * directory name (there is no on-disk collection marker to detect otherwise).
 */
export const KNOWN_SKILL_COLLECTIONS: ReadonlyArray<KnownSkillCollection> = [
    {
        name: 'superpowers',
        members: [
            'brainstorming',
            'dispatching-parallel-agents',
            'executing-plans',
            'finishing-a-development-branch',
            'receiving-code-review',
            'requesting-code-review',
            'subagent-driven-development',
            'systematic-debugging',
            'test-driven-development',
            'using-git-worktrees',
            'using-superpowers',
            'verification-before-completion',
            'writing-plans',
            'writing-skills',
        ],
    },
];

export interface SkillCollectionSuggestion {
    name: string;
    presentCount: number;
    ungroupedCount: number;
    memberKeys: string[];
}

const MIN_PRESENT_FOR_SUGGESTION = 2;

export function getCollectionSuggestions(
    records: SkillRecord[],
    groups: SkillGroupMap,
    dismissed: ReadonlyArray<string>,
): SkillCollectionSuggestion[] {
    const suggestions: SkillCollectionSuggestion[] = [];
    for (const collection of KNOWN_SKILL_COLLECTIONS) {
        if (dismissed.includes(collection.name)) {
            continue;
        }
        const members = records.filter(record => collection.members.includes(record.name));
        if (members.length < MIN_PRESENT_FOR_SUGGESTION) {
            continue;
        }
        const ungrouped = members.filter(record => !getSkillGroupName(record, groups));
        if (!ungrouped.length) {
            continue;
        }
        suggestions.push({
            name: collection.name,
            presentCount: members.length,
            ungroupedCount: ungrouped.length,
            memberKeys: ungrouped.map(record => getSkillStableKey(record)),
        });
    }
    return suggestions;
}
