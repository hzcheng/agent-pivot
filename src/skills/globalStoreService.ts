'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';

import { getProjectSkillsRoots, getUserSkillsRoots } from './roots';

export const DEFAULT_GLOBAL_SKILLS_LOCATION = '~/.skills';

export interface GlobalSkillsLocationResult {
    ok: boolean;
    /** Absolute path represented by the setting, before following a final symlink. */
    configuredPath?: string;
    /** Physical root used by discovery and every managed mutation. */
    rootPath?: string;
    error?: string;
}

export interface ResolveGlobalSkillsLocationOptions {
    homeDir: string;
    workspaceRoots?: readonly string[];
}

export interface RelocateGlobalSkillsStoreResult {
    ok: boolean;
    moved?: boolean;
    aliasCreated?: boolean;
    warning?: string;
    recoveryPath?: string;
    error?: string;
}

export interface RelocateGlobalSkillsStoreOptions {
    renameSync?: typeof fs.renameSync;
    copyFileSync?: typeof fs.copyFileSync;
    mkdirSync?: typeof fs.mkdirSync;
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function resolveFuturePath(candidate: string): string | null {
    const absolute = path.resolve(candidate);
    let existing = absolute;
    while (true) {
        try {
            fs.lstatSync(existing);
        } catch (error) {
            if (!isMissing(error)) {
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
            return null;
        }
    }
}

function overlaps(left: string, right: string): boolean {
    const contains = (parent: string, candidate: string): boolean => {
        const relative = path.relative(parent, candidate);
        return relative === '' || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    return contains(left, right) || contains(right, left);
}

function expandConfiguredPath(value: unknown, homeDir: string): GlobalSkillsLocationResult {
    if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, error: 'Global Skills Location must be a non-empty path.' };
    }
    const raw = value.trim();
    let expanded: string;
    if (raw === '~') {
        expanded = homeDir;
    } else if (raw.startsWith(`~${path.sep}`) || raw.startsWith('~/')) {
        expanded = path.join(homeDir, raw.slice(2));
    } else if (raw.startsWith('~')) {
        return { ok: false, error: 'Only the current user’s ~ path is supported.' };
    } else if (path.isAbsolute(raw)) {
        expanded = raw;
    } else {
        return { ok: false, error: 'Global Skills Location must use ~ or an absolute path.' };
    }
    const configuredPath = path.resolve(expanded);
    const rootPath = resolveFuturePath(configuredPath);
    if (!rootPath) {
        return { ok: false, error: `Cannot resolve Global Skills Location: ${configuredPath}` };
    }
    return { ok: true, configuredPath, rootPath };
}

/**
 * Resolve and validate a configured Global store without creating anything.
 * Project stores remain positional at <workspace>/.skills and are explicitly
 * excluded from the allowed Global location.
 */
export function resolveGlobalSkillsLocation(
    value: unknown,
    options: ResolveGlobalSkillsLocationOptions,
): GlobalSkillsLocationResult {
    const expanded = expandConfiguredPath(value, options.homeDir);
    if (!expanded.ok || !expanded.configuredPath || !expanded.rootPath) {
        return expanded;
    }
    const configuredPath = expanded.configuredPath;
    const rootPath = expanded.rootPath;
    const filesystemRoot = path.parse(configuredPath).root;
    if (configuredPath === filesystemRoot || rootPath === path.parse(rootPath).root) {
        return { ok: false, error: 'The filesystem root cannot be used as Global Skills Location.' };
    }
    const homeRoot = resolveFuturePath(options.homeDir) || path.resolve(options.homeDir);
    if (configuredPath === path.resolve(options.homeDir) || rootPath === homeRoot) {
        return { ok: false, error: 'The home directory itself cannot be used as Global Skills Location.' };
    }

    const forbidden = getUserSkillsRoots(options.homeDir).map(item => item.dirPath);
    for (const workspaceRoot of options.workspaceRoots || []) {
        forbidden.push(
            path.resolve(workspaceRoot),
            path.join(workspaceRoot, '.skills'),
            ...getProjectSkillsRoots(workspaceRoot).map(item => item.dirPath),
        );
    }
    for (const candidate of forbidden) {
        const lexical = path.resolve(candidate);
        const physical = resolveFuturePath(candidate) || lexical;
        if (overlaps(configuredPath, lexical) || overlaps(rootPath, physical)) {
            return {
                ok: false,
                error: `Global Skills Location overlaps a managed Agent or project path: ${candidate}`,
            };
        }
    }
    try {
        const stat = fs.statSync(rootPath);
        if (!stat.isDirectory()) {
            return { ok: false, error: `Global Skills Location is not a directory: ${configuredPath}` };
        }
    } catch (error) {
        if (!isMissing(error)) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    return { ok: true, configuredPath, rootPath };
}

function pathExists(candidate: string): boolean {
    try {
        fs.lstatSync(candidate);
        return true;
    } catch (error) {
        return !isMissing(error);
    }
}

export function copyDirectoryContents(
    sourceDir: string,
    targetDir: string,
    copyFileSync: typeof fs.copyFileSync,
): void {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const source = path.join(sourceDir, entry.name);
        const target = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(target, { recursive: false });
            copyDirectoryContents(source, target, copyFileSync);
        } else if (entry.isFile()) {
            copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        } else if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(source), target);
        } else {
            throw new Error(`Unsupported entry in the Global Skills store: ${source}`);
        }
    }
}

export interface TargetMutationLock {
    lockPath: string;
    release: () => void;
}

export function acquireTargetMutationLock(
    targetPath: string,
): { ok: true; lock: TargetMutationLock } | { ok: false; error: string } {
    const absolute = path.resolve(targetPath);
    const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 24);
    const lockPath = path.join(path.dirname(absolute), `.agent-pivot-target-${digest}.lock`);
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(lockPath, 'wx', 0o600);
        const identity = fs.fstatSync(descriptor);
        let released = false;
        return {
            ok: true,
            lock: {
                lockPath,
                release: () => {
                    if (released) {
                        return;
                    }
                    released = true;
                    try {
                        fs.closeSync(descriptor as number);
                    } catch (_error) {
                        // Continue with identity-checked cleanup.
                    }
                    try {
                        const current = fs.lstatSync(lockPath);
                        if (current.isFile()
                            && current.dev === identity.dev
                            && current.ino === identity.ino) {
                            fs.unlinkSync(lockPath);
                        }
                    } catch (_error) {
                        // A missing or replaced lock must never be deleted by this owner.
                    }
                },
            },
        };
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_closeError) { /* best effort */ }
        }
        return {
            ok: false,
            error: `Another Agent Pivot window is already changing this Skills location: ${
                lockPath}. ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export function acquireSkillsMutationLocks(
    paths: readonly string[],
): { ok: true; lock: TargetMutationLock } | { ok: false; error: string } {
    const normalized = [...new Set(paths.map(candidate => path.resolve(candidate)))].sort();
    const acquired: TargetMutationLock[] = [];
    for (const candidate of normalized) {
        const result = acquireTargetMutationLock(candidate);
        if (result.ok === false) {
            for (const lock of acquired.reverse()) {
                lock.release();
            }
            return result;
        }
        acquired.push(result.lock);
    }
    let released = false;
    return {
        ok: true,
        lock: {
            lockPath: acquired.map(lock => lock.lockPath).join(', '),
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                for (const lock of acquired.reverse()) {
                    lock.release();
                }
            },
        },
    };
}

export function directoryTreesEqual(
    leftDir: string,
    rightDir: string,
    rightIdentity?: DirectoryIdentity,
): boolean {
    try {
        const compare = (left: string, right: string, root: boolean): boolean => {
            const leftEntries = fs.readdirSync(left, { withFileTypes: true })
                .sort((a, b) => a.name.localeCompare(b.name));
            const rightEntries = fs.readdirSync(right, { withFileTypes: true })
                .filter(entry => !root || entry.name !== rightIdentity?.markerName)
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
                if (leftEntry.isDirectory() && !compare(leftPath, rightPath, false)) {
                    return false;
                }
                if (leftEntry.isFile()
                    && !fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath))) {
                    return false;
                }
                if (leftEntry.isSymbolicLink()
                    && fs.readlinkSync(leftPath) !== fs.readlinkSync(rightPath)) {
                    return false;
                }
            }
            return true;
        };
        return compare(leftDir, rightDir, true);
    } catch (_error) {
        return false;
    }
}

export interface DirectoryIdentity {
    dev: number;
    ino: number;
    markerName: string;
    markerToken: string;
}

export function captureDirectoryIdentity(targetRoot: string): DirectoryIdentity {
    const stat = fs.lstatSync(targetRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`The claimed target is no longer a real directory: ${targetRoot}`);
    }
    const markerToken = randomBytes(24).toString('hex');
    const markerName = `.agent-pivot-owner-${markerToken}`;
    fs.writeFileSync(path.join(targetRoot, markerName), markerToken, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    return { dev: stat.dev, ino: stat.ino, markerName, markerToken };
}

function ownsDirectory(targetRoot: string, identity: DirectoryIdentity): boolean {
    try {
        const current = fs.lstatSync(targetRoot);
        return current.isDirectory()
            && !current.isSymbolicLink()
            && current.dev === identity.dev
            && current.ino === identity.ino
            && fs.readFileSync(path.join(targetRoot, identity.markerName), 'utf8')
                === identity.markerToken;
    } catch (_error) {
        return false;
    }
}

export function releaseDirectoryIdentity(
    targetRoot: string,
    identity: DirectoryIdentity,
): { ok: boolean; error?: string; recoveryPath?: string } {
    if (!ownsDirectory(targetRoot, identity)) {
        return {
            ok: false,
            error: `Target ownership changed; retained data at ${targetRoot}.`,
            recoveryPath: targetRoot,
        };
    }
    try {
        fs.unlinkSync(path.join(targetRoot, identity.markerName));
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: `Could not release the target ownership marker: ${
                error instanceof Error ? error.message : String(error)} `
                + `Recovery data is at ${targetRoot}.`,
            recoveryPath: targetRoot,
        };
    }
}

export function retainFailedTarget(
    targetRoot: string,
    identity: DirectoryIdentity | undefined,
): { ok: boolean; error?: string; recoveryPath?: string } {
    try {
        if (!pathExists(targetRoot)) {
            return { ok: true };
        }
        // Never delete a failed public target. There is no portable filesystem
        // primitive that atomically creates a directory and returns a durable
        // ownership handle; an external process can replace the path before
        // identity capture. Retaining the target is the only way to guarantee
        // that rollback cannot delete data written by another owner.
        const ownership = identity && ownsDirectory(targetRoot, identity)
            ? 'The incomplete target'
            : 'Target ownership changed; the target';
        return {
            ok: false,
            error: `${ownership} was retained at ${targetRoot}.`,
            recoveryPath: targetRoot,
        };
    } catch (error) {
        return {
            ok: false,
            error: `Could not inspect the failed target: ${
                error instanceof Error ? error.message : String(error)} `
                + `Recovery data is at ${targetRoot}.`,
            recoveryPath: targetRoot,
        };
    }
}

export function restoreDirectoryWithoutOverwrite(
    recoveryRoot: string,
    sourceRoot: string,
    copyFileSync: typeof fs.copyFileSync,
): { ok: boolean; error?: string } {
    try {
        // mkdir is the atomic no-overwrite claim. A concurrent writer wins
        // cleanly instead of being replaced by rename(2).
        fs.mkdirSync(sourceRoot, { recursive: false });
        copyDirectoryContents(recoveryRoot, sourceRoot, copyFileSync);
        if (!directoryTreesEqual(recoveryRoot, sourceRoot)) {
            throw new Error('Restored Global Skills content did not verify.');
        }
        fs.rmSync(recoveryRoot, { recursive: true, force: true });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Move the complete physical Global store and leave the old root as a stable
 * compatibility symlink. The alias keeps links in projects that are not
 * currently open valid after the setting changes.
 */
export function relocateGlobalSkillsStore(
    sourceRoot: string,
    targetRoot: string,
    options: RelocateGlobalSkillsStoreOptions = {},
): RelocateGlobalSkillsStoreResult {
    const source = path.resolve(sourceRoot);
    const target = path.resolve(targetRoot);
    const renameSync = options.renameSync || fs.renameSync;
    const copyFileSync = options.copyFileSync || fs.copyFileSync;
    const mkdirSync = options.mkdirSync || fs.mkdirSync;
    if (overlaps(source, target)) {
        return { ok: false, error: 'The old and new Global Skills locations overlap.' };
    }
    try {
        const sourceStat = fs.lstatSync(source);
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
            return { ok: false, error: `The current Global Skills store is not a real directory: ${source}` };
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const lockResult = acquireSkillsMutationLocks([source, target]);
    if (lockResult.ok === false) {
        return { ok: false, error: lockResult.error };
    }

    try {
        if (pathExists(target)) {
            try {
                const targetStat = fs.lstatSync(target);
                if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
                    return { ok: false, error: `The new Global Skills location is already occupied: ${target}` };
                }
                if (fs.readdirSync(target).length) {
                    return { ok: false, error: `The new Global Skills location is not empty: ${target}` };
                }
                fs.rmdirSync(target);
            } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        }

        let asideContainer: string;
        let targetCreated = false;
        let targetIdentity: DirectoryIdentity | undefined;
        try {
        // mkdir is the portable atomic no-overwrite claim. Always using the
        // verified copy protocol also avoids rename replacing a destination
        // created after the earlier inspection.
        mkdirSync(target, { recursive: false });
        targetCreated = true;
        targetIdentity = captureDirectoryIdentity(target);
        copyDirectoryContents(source, target, copyFileSync);
        if (!directoryTreesEqual(source, target, targetIdentity)) {
            throw new Error('Copied Global Skills content did not verify.');
        }
        asideContainer = fs.mkdtempSync(path.join(path.dirname(source), '.agent-pivot-global-store-'));
        } catch (error) {
            const cleanup = targetCreated
                ? retainFailedTarget(target, targetIdentity)
                : { ok: true };
            const message = error instanceof Error ? error.message : String(error);
            if (!cleanup.ok) {
                return {
                    ok: false,
                    error: `${message} ${cleanup.error}`,
                    recoveryPath: cleanup.recoveryPath,
                };
            }
            return { ok: false, error: message };
        }

        const aside = path.join(asideContainer, path.basename(source));
        let sourceAtAside = false;
        let sourceAliasCreated = false;
        try {
        renameSync(source, aside);
        sourceAtAside = true;
        if (!directoryTreesEqual(aside, target, targetIdentity)) {
            throw new Error('The Global Skills store changed during migration.');
        }
        fs.symlinkSync(target, source, 'dir');
        sourceAliasCreated = true;
        const released = releaseDirectoryIdentity(target, targetIdentity);
        if (!released.ok) {
            throw new Error(released.error);
        }
        } catch (error) {
            let rollbackError: unknown;
        if (sourceAliasCreated) {
            try {
                const stat = fs.lstatSync(source);
                if (stat.isSymbolicLink() && fs.readlinkSync(source) === target) {
                    fs.unlinkSync(source);
                }
            } catch (unlinkError) {
                if (!isMissing(unlinkError)) {
                    rollbackError = unlinkError;
                }
            }
        }
        if (sourceAtAside) {
            const rollback = restoreDirectoryWithoutOverwrite(aside, source, copyFileSync);
            if (rollback.ok) {
                sourceAtAside = false;
            } else {
                rollbackError = rollbackError || new Error(rollback.error);
            }
        }
            const targetCleanup = retainFailedTarget(target, targetIdentity);
            if (rollbackError) {
                const recoveryPath = aside;
                return {
                    ok: false,
                    error: `${error instanceof Error ? error.message : String(error)} `
                        + `Rollback failed: ${rollbackError instanceof Error
                            ? rollbackError.message : String(rollbackError)} `
                        + `Recovery data is at ${recoveryPath}.`
                        + (!targetCleanup.ok ? ` ${targetCleanup.error}` : ''),
                    recoveryPath,
                };
            }
            try { fs.rmSync(asideContainer, { recursive: true, force: true }); } catch (_error) { /* best effort */ }
            const message = error instanceof Error ? error.message : String(error);
            return targetCleanup.ok
                ? { ok: false, error: message }
                : {
                    ok: false,
                    error: `${message} ${targetCleanup.error}`,
                    recoveryPath: targetCleanup.recoveryPath,
                };
        }

        try {
            fs.rmSync(asideContainer, { recursive: true, force: true });
            return { ok: true, moved: true, aliasCreated: true };
        } catch (error) {
            return {
                ok: true,
                moved: true,
                aliasCreated: true,
                warning: `Migration succeeded, but the backup could not be removed: ${
                    error instanceof Error ? error.message : String(error)}`,
                recoveryPath: aside,
            };
        }
    } finally {
        lockResult.lock.release();
    }
}

export function hasGlobalSkillsStoreContent(rootDir: string): boolean {
    try {
        return fs.readdirSync(rootDir).length > 0;
    } catch (_error) {
        return false;
    }
}
