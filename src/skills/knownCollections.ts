'use strict';

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
    /** Enabled members not yet filed under the collection's store folder. */
    unfiledCount: number;
}

const MIN_PRESENT_FOR_SUGGESTION = 2;

/**
 * Suggest creating a store folder for a known collection. A member counts as
 * unfiled when it is not centralized yet or lives outside `<store>/<name>`.
 */
export function getCollectionSuggestions(
    records: SkillRecord[],
    dismissed: ReadonlyArray<string>,
): SkillCollectionSuggestion[] {
    const suggestions: SkillCollectionSuggestion[] = [];
    for (const collection of KNOWN_SKILL_COLLECTIONS) {
        if (dismissed.includes(collection.name)) {
            continue;
        }
        const members = records.filter(record => record.enabled && collection.members.includes(record.name));
        if (members.length < MIN_PRESENT_FOR_SUGGESTION) {
            continue;
        }
        const unfiled = members.filter(record => !record.central || record.folder !== collection.name);
        if (!unfiled.length) {
            continue;
        }
        suggestions.push({
            name: collection.name,
            presentCount: members.length,
            unfiledCount: unfiled.length,
        });
    }
    return suggestions;
}
