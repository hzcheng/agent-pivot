'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { centralizeSkill } from './centralService';
import { getCentralSkillsRoot } from './roots';
import type { SkillRecord, SkillScope, SkillSourceDir } from './types';

const MIGRATION_PRIORITY: SkillSourceDir[] = ['kimi', 'claude', 'codex'];

export interface SkillMigrationReport {
    ok: boolean;
    /** Skills moved into the central store. */
    migrated: string[];
    /** Migrated skills whose copies disagreed (winner picked by brand priority). */
    drifted: string[];
    /** Losing copy directories deleted after the winner was secured. */
    deleted: string[];
    skipped: Array<{ name: string; reason: string }>;
    errors: Array<{ name: string; error: string }>;
}

function priorityOf(record: SkillRecord): number {
    const index = MIGRATION_PRIORITY.indexOf(record.source);
    return index === -1 ? MIGRATION_PRIORITY.length : index;
}

/**
 * One-shot migration of every skill living in the three brand agent
 * roots at one scope into that scope's central store (the configured Global
 * store for user, `<project>/.skills` for project). The highest priority copy
 * (kimi > claude > codex) wins; all other real-directory copies are
 * deleted once the winner is secured. No agent links are created —
 * users enable agents per card afterwards.
 */
export function migrateSkillsToCentral(
    records: SkillRecord[],
    homeDir: string,
    scope: SkillScope,
    workspaceRoot?: string,
    globalSkillsRoot?: string,
): SkillMigrationReport {
    const report: SkillMigrationReport = {
        ok: true, migrated: [], drifted: [], deleted: [], skipped: [], errors: [],
    };
    if (scope === 'project' && !workspaceRoot) {
        report.ok = false;
        report.errors.push({ name: '.', error: 'No workspace is open for project-scope migration.' });
        return report;
    }
    const groups = new Map<string, SkillRecord[]>();
    for (const record of records) {
        if (record.scope !== scope) {
            continue;
        }
        const list = groups.get(record.name) || [];
        list.push(record);
        groups.set(record.name, list);
    }
    const centralRoot = getCentralSkillsRoot(homeDir, scope, workspaceRoot, globalSkillsRoot);
    for (const [name, copies] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const realDirs = copies.filter(copy => !copy.central);
        if (!realDirs.length) {
            continue;
        }
        if (copies.some(copy => copy.central) || fs.existsSync(path.join(centralRoot, name))) {
            report.skipped.push({ name, reason: 'already in the central store' });
            continue;
        }
        const migratable = realDirs.filter(copy => MIGRATION_PRIORITY.includes(copy.source));
        if (!migratable.length) {
            report.skipped.push({ name, reason: 'lives outside the kimi/claude/codex roots' });
            continue;
        }
        const drifted = new Set(migratable.map(copy => copy.contentHash)).size > 1;
        const winner = [...migratable].sort((a, b) => priorityOf(a) - priorityOf(b))[0];
        const losers = migratable.filter(copy => copy.dirPath !== winner.dirPath);
        const loserDirs = losers.map(copy => copy.dirPath);
        const result = centralizeSkill(winner, losers, homeDir, workspaceRoot, {
            linkBack: false,
            globalSkillsRoot,
        });
        if (!result.ok) {
            report.ok = false;
            report.errors.push({ name, error: result.error || 'unknown error' });
            continue;
        }
        report.migrated.push(name);
        if (drifted) {
            report.drifted.push(name);
        }
        report.deleted.push(...loserDirs.filter(dirPath => !fs.existsSync(dirPath)));
    }
    return report;
}

/** Back-compat wrapper: migrate the user scope into its Global store. */
export function migrateUserSkillsToCentral(
    records: SkillRecord[],
    homeDir: string,
    globalSkillsRoot?: string,
): SkillMigrationReport {
    return migrateSkillsToCentral(records, homeDir, 'user', undefined, globalSkillsRoot);
}
