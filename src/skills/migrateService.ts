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
    /** Losing copy directories parked under `.disabled/`. */
    parked: string[];
    skipped: Array<{ name: string; reason: string }>;
    errors: Array<{ name: string; error: string }>;
}

function priorityOf(record: SkillRecord): number {
    const index = MIGRATION_PRIORITY.indexOf(record.source);
    return index === -1 ? MIGRATION_PRIORITY.length : index;
}

/**
 * One-shot migration of every enabled skill living in the three brand agent
 * roots at one scope into that scope's central store (`~/.skills` for user,
 * `<project>/.skills` for project). The highest priority copy
 * (kimi > claude > codex) wins; all other real-directory copies are parked
 * reversibly under their root's `.disabled/`. No agent links are created —
 * users enable agents per card afterwards.
 */
export function migrateSkillsToCentral(
    records: SkillRecord[],
    homeDir: string,
    scope: SkillScope,
    workspaceRoot?: string,
): SkillMigrationReport {
    const report: SkillMigrationReport = {
        ok: true, migrated: [], drifted: [], parked: [], skipped: [], errors: [],
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
    const centralRoot = getCentralSkillsRoot(homeDir, scope, workspaceRoot);
    for (const [name, copies] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const enabledRealDirs = copies.filter(copy => copy.enabled && !copy.central);
        if (!enabledRealDirs.length) {
            continue;
        }
        if (copies.some(copy => copy.central) || fs.existsSync(path.join(centralRoot, name))) {
            report.skipped.push({ name, reason: 'already in the central store' });
            continue;
        }
        const migratable = enabledRealDirs.filter(copy => MIGRATION_PRIORITY.includes(copy.source));
        if (!migratable.length) {
            report.skipped.push({ name, reason: 'lives outside the kimi/claude/codex roots' });
            continue;
        }
        const drifted = new Set(migratable.map(copy => copy.contentHash)).size > 1;
        const winner = [...migratable].sort((a, b) => priorityOf(a) - priorityOf(b))[0];
        const losers = migratable.filter(copy => copy.dirPath !== winner.dirPath);
        const loserDirs = losers.map(copy => copy.dirPath);
        const result = centralizeSkill(winner, losers, homeDir, workspaceRoot, { linkBack: false });
        if (!result.ok) {
            report.ok = false;
            report.errors.push({ name, error: result.error || 'unknown error' });
            continue;
        }
        report.migrated.push(name);
        if (drifted) {
            report.drifted.push(name);
        }
        report.parked.push(...loserDirs.filter(dirPath => !fs.existsSync(dirPath)));
    }
    return report;
}

/** Back-compat wrapper: migrate the user scope (`~/.skills`). */
export function migrateUserSkillsToCentral(records: SkillRecord[], homeDir: string): SkillMigrationReport {
    return migrateSkillsToCentral(records, homeDir, 'user');
}
