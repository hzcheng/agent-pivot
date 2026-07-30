'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { setCentralLink } from './centralService';
import { acquireSkillsMutationLocks } from './globalStoreService';
import { getCentralSkillsRoot, getProjectSkillsRoots } from './roots';
import type { SkillAgentId, SkillRecord } from './types';

export interface SkillScopeActionResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
    code?: 'invalid' | 'conflict' | 'io' | 'rollback';
}

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

function projectRootByAgent(workspaceRoot: string): Map<SkillAgentId, string> {
    const roots = new Map<SkillAgentId, string>();
    for (const root of getProjectSkillsRoots(workspaceRoot)) {
        if (root.source === 'kimi' || root.source === 'claude' || root.source === 'codex') {
            roots.set(root.source, root.dirPath);
        }
    }
    return roots;
}

function fail(error: string, code: SkillScopeActionResult['code'] = 'io'): SkillScopeActionResult {
    return { ok: false, error, code };
}

function resolveFuturePath(candidate: string): string | null {
    const absolute = path.resolve(candidate);
    let existing = absolute;
    while (true) {
        try {
            fs.lstatSync(existing);
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error)
                || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
                return null;
            }
            const parent = path.dirname(existing);
            if (parent === existing) {
                return null;
            }
            existing = parent;
            continue;
        }
        try {
            const realExisting = fs.realpathSync(existing);
            return path.resolve(realExisting, path.relative(existing, absolute));
        } catch (_error) {
            // lstat succeeded but realpath failed: usually a dangling symlink.
            return null;
        }
    }
}

function pathSlotOccupied(candidate: string): boolean {
    try {
        fs.lstatSync(candidate);
        return true;
    } catch (error) {
        return !(error instanceof Error) || !('code' in error)
            || (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

function isManagedDescendant(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..'
        || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return false;
    }
    const realCandidate = resolveFuturePath(candidate);
    const realRoot = resolveFuturePath(root);
    if (!realCandidate || !realRoot) {
        return false;
    }
    const realRelative = path.relative(realRoot, realCandidate);
    return Boolean(realRelative) && realRelative !== '..'
        && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
}

function copyDirContents(sourceDir: string, targetDir: string): void {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const source = path.join(sourceDir, entry.name);
        const target = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(target, { recursive: false });
            copyDirContents(source, target);
        } else if (entry.isFile()) {
            fs.copyFileSync(source, target);
        } else if (entry.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(source);
            let type: fs.symlink.Type = 'file';
            try {
                type = fs.statSync(source).isDirectory() ? 'dir' : 'file';
            } catch (_error) {
                // Preserve a dangling link verbatim; its target type is unknowable.
            }
            fs.symlinkSync(linkTarget, target, type);
        } else {
            throw new Error(`Unsupported skill entry: ${source}`);
        }
    }
}

type LinkSlotState = 'owned' | 'absent' | 'foreign';

function inspectCentralLink(centralDir: string, rootDir: string): LinkSlotState {
    const linkPath = path.join(rootDir, path.basename(centralDir));
    try {
        const stat = fs.lstatSync(linkPath);
        if (!stat.isSymbolicLink()) {
            return 'foreign';
        }
        return fs.realpathSync(linkPath) === fs.realpathSync(centralDir) ? 'owned' : 'foreign';
    } catch (error) {
        return error instanceof Error && 'code' in error
            && (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'absent'
            : 'foreign';
    }
}

function isReadableSkillDirectory(dirPath: string): boolean {
    try {
        if (!fs.statSync(dirPath).isDirectory()) {
            return false;
        }
    } catch (_error) {
        return false;
    }
    for (const fileName of ['SKILL.md', 'skill.md']) {
        try {
            if (fs.statSync(path.join(dirPath, fileName)).isFile()) {
                return true;
            }
        } catch (_error) {
            // Try the alternate supported filename.
        }
    }
    return false;
}

/** Fresh, exact comparison used immediately before destructive consolidation. */
export function skillDirectoriesEqual(leftDir: string, rightDir: string): boolean {
    try {
        const compare = (left: string, right: string): boolean => {
            const leftEntries = fs.readdirSync(left, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
            const rightEntries = fs.readdirSync(right, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
            if (leftEntries.length !== rightEntries.length) {
                return false;
            }
            for (let index = 0; index < leftEntries.length; index += 1) {
                const leftEntry = leftEntries[index];
                const rightEntry = rightEntries[index];
                if (leftEntry.name !== rightEntry.name
                    || leftEntry.isDirectory() !== rightEntry.isDirectory()
                    || leftEntry.isFile() !== rightEntry.isFile()
                    || leftEntry.isSymbolicLink() !== rightEntry.isSymbolicLink()) {
                    return false;
                }
                const leftPath = path.join(left, leftEntry.name);
                const rightPath = path.join(right, rightEntry.name);
                if (leftEntry.isDirectory()) {
                    if (!compare(leftPath, rightPath)) {
                        return false;
                    }
                } else if (leftEntry.isFile()) {
                    if (!fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath))) {
                        return false;
                    }
                } else if (leftEntry.isSymbolicLink()) {
                    if (fs.readlinkSync(leftPath) !== fs.readlinkSync(rightPath)) {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            return true;
        };
        return compare(leftDir, rightDir);
    } catch (_error) {
        return false;
    }
}

function hasOnlyInternalSymlinks(rootDir: string): boolean {
    try {
        const walk = (current: string): boolean => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (!walk(entryPath)) {
                        return false;
                    }
                } else if (entry.isSymbolicLink()) {
                    const target = fs.readlinkSync(entryPath);
                    if (path.isAbsolute(target)) {
                        return false;
                    }
                    const resolved = path.resolve(path.dirname(entryPath), target);
                    const relative = path.relative(rootDir, resolved);
                    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                        return false;
                    }
                }
            }
            return true;
        };
        return walk(rootDir);
    } catch (_error) {
        return false;
    }
}

/**
 * Make one global central skill available to exactly the selected agents in
 * the current project. The global directory remains the only real copy.
 */
export function setGlobalSkillProjectAgents(
    record: SkillRecord,
    agents: SkillAgentId[],
    homeDir: string,
    workspaceRoot: string,
    globalSkillsRoot?: string,
): SkillScopeActionResult {
    if (!record.central || record.scope !== 'user') {
        return fail('Only a centralized global skill can be applied to a project.', 'invalid');
    }
    const globalStore = getCentralSkillsRoot(homeDir, 'user', undefined, globalSkillsRoot);
    if (!isManagedDescendant(
        record.dirPath,
        globalStore,
    )) {
        return fail('The global skill resolves outside the managed Global store.', 'invalid');
    }
    if (!isReadableSkillDirectory(record.dirPath)) {
        return fail('The global skill source is missing or unreadable.', 'invalid');
    }
    const lockResult = acquireSkillsMutationLocks([globalStore]);
    if (lockResult.ok === false) {
        return fail(lockResult.error);
    }
    try {
    const desired = new Set(agents);
    if (agents.some(agent => !AGENTS.includes(agent)) || desired.size !== agents.length) {
        return fail('Unknown or duplicate project agent.', 'invalid');
    }
    const roots = projectRootByAgent(workspaceRoot);
    const previous = new Map<SkillAgentId, LinkSlotState>();
    for (const agent of AGENTS) {
        const root = roots.get(agent);
        if (!root) {
            return fail(`Unknown project skills root for ${agent}.`, 'invalid');
        }
        const state = inspectCentralLink(record.dirPath, root);
        previous.set(agent, state);
        if (desired.has(agent) && state === 'foreign') {
            return fail(`A different project skill already occupies the ${agent} slot.`, 'conflict');
        }
    }
    const changed: SkillAgentId[] = [];
    try {
        for (const agent of AGENTS) {
            const root = roots.get(agent);
            if (!root) {
                throw new Error(`Unknown project skills root for ${agent}.`);
            }
            const state = previous.get(agent) as LinkSlotState;
            if ((desired.has(agent) && state === 'owned')
                || (!desired.has(agent) && state !== 'owned')) {
                continue;
            }
            const result = setCentralLink(record.dirPath, root, desired.has(agent));
            if (!result.ok) {
                throw new Error(result.error || `Could not update ${agent}.`);
            }
            if (result.changed) {
                changed.push(agent);
            }
        }
        return { ok: true, dirPath: record.dirPath };
    } catch (error) {
        const rollbackErrors: string[] = [];
        for (const agent of changed.reverse()) {
            const root = roots.get(agent);
            if (root) {
                const result = setCentralLink(record.dirPath, root, previous.get(agent) === 'owned');
                if (!result.ok) {
                    rollbackErrors.push(result.error || `Could not restore the ${agent} project link.`);
                }
            }
        }
        const message = error instanceof Error ? error.message : String(error);
        if (rollbackErrors.length) {
            return fail(`${message} Rollback was incomplete. ${rollbackErrors.join(' ')}`, 'rollback');
        }
        return fail(message, message.includes('already exists') || message.includes('points elsewhere') ? 'conflict' : 'io');
    }
    } finally {
        lockResult.lock.release();
    }
}

/**
 * Move a project central skill into the global store while preserving only
 * its current project-agent links. An identical global skill is consolidated;
 * different content is never overwritten.
 */
export function moveProjectSkillToGlobal(
    record: SkillRecord,
    existingGlobal: SkillRecord | undefined,
    homeDir: string,
    workspaceRoot: string,
    globalSkillsRoot?: string,
): SkillScopeActionResult {
    if (!record.central || record.scope !== 'project') {
        return fail('Only a centralized project skill can be moved to Global.', 'invalid');
    }
    const projectStore = getCentralSkillsRoot(homeDir, 'project', workspaceRoot);
    const globalStore = getCentralSkillsRoot(homeDir, 'user', undefined, globalSkillsRoot);
    if (!isManagedDescendant(record.dirPath, projectStore)) {
        return fail('The project skill resolves outside this project’s managed store.', 'invalid');
    }
    if (!isReadableSkillDirectory(record.dirPath)) {
        return fail('The project skill source is missing or unreadable.', 'invalid');
    }
    if (path.basename(record.dirPath) !== record.name) {
        return fail('Fix the skill name mismatch before moving it to Global.', 'invalid');
    }
    if (!hasOnlyInternalSymlinks(record.dirPath)) {
        return fail('Move blocked because the skill contains an unreadable or external symlink.', 'invalid');
    }
    if (existingGlobal && (!existingGlobal.central || existingGlobal.scope !== 'user'
        || !skillDirectoriesEqual(record.dirPath, existingGlobal.dirPath))) {
        return fail(`A different global skill named "${record.name}" already exists.`, 'conflict');
    }
    if (existingGlobal && !isManagedDescendant(existingGlobal.dirPath, globalStore)) {
        return fail('The matching global skill resolves outside the managed Global store.', 'invalid');
    }
    if (existingGlobal && path.basename(existingGlobal.dirPath) !== record.name) {
        return fail('Fix the matching global skill name mismatch before consolidating.', 'invalid');
    }
    const roots = projectRootByAgent(workspaceRoot);
    const projectAgents = AGENTS.filter(agent => {
        const root = roots.get(agent);
        return Boolean(root && inspectCentralLink(record.dirPath, root) === 'owned');
    });
    const destination = existingGlobal
        ? existingGlobal.dirPath
        : path.join(globalStore, record.folder, record.name);
    if (!existingGlobal && pathSlotOccupied(destination)) {
        return fail(`Global destination already exists: ${destination}`, 'conflict');
    }
    if (!isManagedDescendant(destination, globalStore)) {
        return fail('The Global destination escapes the managed store.', 'invalid');
    }

    const lockResult = acquireSkillsMutationLocks([
        projectStore,
        globalStore,
        record.dirPath,
    ]);
    if (lockResult.ok === false) {
        return fail(lockResult.error);
    }
    try {
        const removed: SkillAgentId[] = [];
        const created: SkillAgentId[] = [];
        let asideContainer: string;
        try {
            asideContainer = fs.mkdtempSync(path.join(path.dirname(record.dirPath), '.agent-pivot-scope-'));
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
        const aside = path.join(asideContainer, path.basename(record.dirPath));
        let sourceAtAside = false;
        let destinationCreated = false;
        try {
        for (const agent of projectAgents) {
            const root = roots.get(agent);
            if (!root) {
                throw new Error(`Unknown project skills root for ${agent}.`);
            }
            const result = setCentralLink(record.dirPath, root, false);
            if (!result.ok) {
                throw new Error(result.error || `Could not detach ${agent}.`);
            }
            if (result.changed) {
                removed.push(agent);
            }
        }
        fs.renameSync(record.dirPath, aside);
        sourceAtAside = true;
        if (!existingGlobal) {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            if (pathSlotOccupied(destination)) {
                throw new Error(`Global destination already exists: ${destination}`);
            }
            if (!isManagedDescendant(destination, globalStore)) {
                throw new Error('The Global destination escapes the managed store.');
            }
            fs.mkdirSync(destination, { recursive: false });
            destinationCreated = true;
            if (!isManagedDescendant(destination, globalStore)) {
                throw new Error('The Global destination escaped the managed store during creation.');
            }
            copyDirContents(aside, destination);
        }
        for (const agent of projectAgents) {
            const result = setCentralLink(destination, roots.get(agent) as string, true);
            if (!result.ok) {
                throw new Error(result.error || `Could not attach ${agent}.`);
            }
            if (result.changed) {
                created.push(agent);
            }
        }
        if (!skillDirectoriesEqual(aside, destination)) {
            throw new Error('The Global copy changed or did not verify before commit.');
        }
        if (sourceAtAside) {
            try {
                fs.rmSync(aside, { recursive: true, force: true });
                sourceAtAside = false;
            } catch (cleanupError) {
                return {
                    ok: true,
                    dirPath: destination,
                    error: `Migration succeeded, but the hidden backup could not be fully removed: ${aside}. `
                        + (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
                };
            }
        }
        try {
            fs.rmSync(asideContainer, { recursive: true, force: true });
        } catch (_cleanupError) {
            // The source and links are already committed; an empty hidden temp
            // container is safer than rolling back a completed migration.
        }
        return { ok: true, dirPath: destination };
        } catch (error) {
            const rollbackErrors: string[] = [];
        for (const agent of created.reverse()) {
            const result = setCentralLink(destination, roots.get(agent) as string, false);
            if (!result.ok) {
                rollbackErrors.push(result.error || `Could not remove the new ${agent} link.`);
            }
        }
        let sourceRestored = !sourceAtAside && isReadableSkillDirectory(record.dirPath);
        if (destinationCreated) {
            try {
                fs.rmSync(destination, { recursive: true, force: true });
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            }
        }
        if (sourceAtAside) {
            if (pathSlotOccupied(record.dirPath)) {
                rollbackErrors.push(`The original project slot was occupied during rollback: ${record.dirPath}`);
            } else {
                try {
                    fs.mkdirSync(record.dirPath, { recursive: false });
                    copyDirContents(aside, record.dirPath);
                    if (!skillDirectoriesEqual(aside, record.dirPath)) {
                        throw new Error('The restored project copy did not verify.');
                    }
                    sourceAtAside = false;
                    sourceRestored = true;
                    try {
                        fs.rmSync(aside, { recursive: true, force: true });
                    } catch (_cleanupError) {
                        // The verified project source is authoritative again.
                    }
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
                }
            }
        }
        if (sourceRestored) {
            for (const agent of removed.reverse()) {
                const result = setCentralLink(record.dirPath, roots.get(agent) as string, true);
                if (!result.ok) {
                    rollbackErrors.push(result.error || `Could not restore the ${agent} link.`);
                }
            }
        } else if (removed.length) {
            rollbackErrors.push('Project links were not restored because the source path is unavailable.');
        }
        if (!sourceAtAside) {
            try {
                fs.rmSync(asideContainer, { recursive: true, force: true });
            } catch (cleanupError) {
                rollbackErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
            }
        }
        const message = error instanceof Error ? error.message : String(error);
        if (rollbackErrors.length) {
            const recoveryPath = sourceAtAside ? aside : (sourceRestored ? record.dirPath : destination);
            return fail(
                `${message} Rollback was incomplete; the recoverable skill source is at ${recoveryPath}. `
                + rollbackErrors.join(' '),
                'rollback');
        }
            return fail(message, message.includes('already exists') || message.includes('points elsewhere') ? 'conflict' : 'io');
        }
    } finally {
        lockResult.lock.release();
    }
}
