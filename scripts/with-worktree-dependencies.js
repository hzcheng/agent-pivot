'use strict';

// Keep npm ci from deleting a worktree's node_modules while another command in
// that same worktree is compiling or testing. The lock deliberately lives in
// Git's per-worktree administrative directory, not node_modules: npm ci
// removes node_modules as part of a normal install.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_ENVIRONMENT_VARIABLE = 'AGENT_PIVOT_WORKTREE_DEPENDENCY_LOCK';
const LOCK_FILE_NAME = 'worktree-dependencies.lock';
const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 100;
const DEPENDENCY_SENTINELS = [
    'node_modules/.package-lock.json',
    'node_modules/fitty/dist/fitty.min.js',
    'node_modules/typescript/bin/tsc',
];

function sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readJson(filePath, fileSystem = fs) {
    return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
}

function packageMapsMatch(repositoryRoot, fileSystem = fs) {
    try {
        const expected = readJson(path.join(repositoryRoot, 'package-lock.json'), fileSystem);
        const installed = readJson(path.join(repositoryRoot, 'node_modules/.package-lock.json'), fileSystem);

        // npm 7-11 may keep the root lockfile at v2 while writing the hidden
        // installed lockfile at v3, so package content is the compatibility
        // contract rather than the two lockfile format version numbers.
        const manifest = readJson(path.join(repositoryRoot, 'package.json'), fileSystem);
        const directDependencies = Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.optionalDependencies,
        });
        return Object.keys(installed.packages).length > 0
            && directDependencies.every(dependency => {
                const expectedPackage = expected.packages[`node_modules/${dependency}`];
                const installedPackage = installed.packages[`node_modules/${dependency}`];
                return expectedPackage && installedPackage
                    && ['version', 'resolved', 'integrity', 'link'].every(field =>
                        expectedPackage[field] === installedPackage[field]);
            });
    } catch {
        return false;
    }
}

function directDependenciesArePresent(repositoryRoot, fileSystem = fs) {
    try {
        const manifest = readJson(path.join(repositoryRoot, 'package.json'), fileSystem);
        const dependencies = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.optionalDependencies,
        };
        return Object.keys(dependencies).every(dependency =>
            fileSystem.existsSync(path.join(repositoryRoot, 'node_modules', dependency)));
    } catch {
        return false;
    }
}

function dependenciesAreCurrent(repositoryRoot, fileSystem = fs) {
    return DEPENDENCY_SENTINELS.every(relativePath =>
        fileSystem.existsSync(path.join(repositoryRoot, relativePath)))
        && directDependenciesArePresent(repositoryRoot, fileSystem)
        && packageMapsMatch(repositoryRoot, fileSystem);
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== 'ESRCH';
    }
}

function lockOwnerIsAlive(lockPath, fileSystem = fs) {
    try {
        return processIsAlive(readJson(lockPath, fileSystem).pid);
    } catch {
        return false;
    }
}

function resolveGitDirectory(repositoryRoot, spawnSync = childProcess.spawnSync) {
    const result = spawnSync('git', ['rev-parse', '--git-dir'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(`Unable to resolve the worktree Git directory: ${result.stderr || result.error || 'git failed'}`);
    }
    return path.resolve(repositoryRoot, result.stdout.trim());
}

function acquireLock(lockPath, options = {}) {
    const fileSystem = options.fileSystem || fs;
    const now = options.now || Date.now;
    const wait = options.sleep || sleep;
    const timeoutMs = options.timeoutMs || LOCK_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs || LOCK_POLL_INTERVAL_MS;
    const deadline = now() + timeoutMs;

    while (true) {
        try {
            const descriptor = fileSystem.openSync(lockPath, 'wx');
            fileSystem.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: now() }));
            return () => {
                fileSystem.closeSync(descriptor);
                try {
                    fileSystem.unlinkSync(lockPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        throw error;
                    }
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            if (!lockOwnerIsAlive(lockPath, fileSystem)) {
                try {
                    fileSystem.unlinkSync(lockPath);
                } catch (unlinkError) {
                    if (unlinkError.code !== 'ENOENT') {
                        throw unlinkError;
                    }
                }
                continue;
            }
            if (now() >= deadline) {
                throw new Error(`Timed out waiting for worktree dependency lock: ${lockPath}`);
            }
            wait(pollIntervalMs);
        }
    }
}

function npmExecutable(platform = process.platform) {
    return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args, repositoryRoot, environment, spawnSync = childProcess.spawnSync, platform) {
    const result = spawnSync(command === 'npm' ? npmExecutable(platform) : command, args, {
        cwd: repositoryRoot,
        env: environment,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    return result.status === null ? 1 : result.status;
}

function installationEnvironment(environment, lockPath) {
    const result = { ...environment, [LOCK_ENVIRONMENT_VARIABLE]: lockPath };
    // npm run forwards config as npm_config_* environment variables. npm 12
    // gives that inherited user allowlist precedence over the child command's
    // --allow-scripts= flag, so remove it before the isolated npm ci process.
    delete result.npm_config_allow_scripts;
    delete result.NPM_CONFIG_ALLOW_SCRIPTS;
    return result;
}

function parseArguments(argv) {
    if (argv[0] === '--install-only') {
        return { installOnly: true, command: argv.slice(1) };
    }
    return { installOnly: false, command: argv[0] === '--' ? argv.slice(1) : argv };
}

function runWithWorktreeDependencies(argv, options = {}) {
    const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
    const parsed = parseArguments(argv);
    const logger = options.logger || console;
    const spawnSync = options.spawnSync || childProcess.spawnSync;
    const environment = options.environment || process.env;
    const gitDirectory = options.gitDirectory
        || resolveGitDirectory(repositoryRoot, options.gitSpawnSync || childProcess.spawnSync);
    const lockPath = path.join(gitDirectory, LOCK_FILE_NAME);
    const alreadyLocked = environment[LOCK_ENVIRONMENT_VARIABLE] === lockPath;
    const release = alreadyLocked ? null : acquireLock(lockPath, options);

    try {
        if (!dependenciesAreCurrent(repositoryRoot, options.fileSystem || fs)) {
            logger.log('Installing worktree dependencies with npm ci --ignore-scripts...');
            const installStatus = runCommand(
                'npm',
                ['ci', '--ignore-scripts', '--allow-scripts='],
                repositoryRoot,
                installationEnvironment(environment, lockPath),
                spawnSync,
                options.platform
            );
            if (installStatus !== 0) {
                return installStatus;
            }
            if (!dependenciesAreCurrent(repositoryRoot, options.fileSystem || fs)) {
                throw new Error('npm ci completed but the worktree dependencies are still incomplete.');
            }
        }

        if (parsed.installOnly) {
            if (parsed.command.length > 0) {
                throw new Error('--install-only does not accept a command.');
            }
            return 0;
        }
        if (parsed.command.length === 0) {
            throw new Error('Usage: npm run worktree:run -- <command> [args...]');
        }
        return runCommand(
            parsed.command[0],
            parsed.command.slice(1),
            repositoryRoot,
            { ...environment, [LOCK_ENVIRONMENT_VARIABLE]: lockPath },
            spawnSync,
            options.platform
        );
    } finally {
        if (release) {
            release();
        }
    }
}

function main(argv = process.argv.slice(2)) {
    try {
        return runWithWorktreeDependencies(argv);
    } catch (error) {
        console.error(`Worktree dependency guard failed: ${error.message}`);
        return 1;
    }
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = {
    DEPENDENCY_SENTINELS,
    LOCK_ENVIRONMENT_VARIABLE,
    LOCK_FILE_NAME,
    acquireLock,
    dependenciesAreCurrent,
    directDependenciesArePresent,
    installationEnvironment,
    lockOwnerIsAlive,
    npmExecutable,
    packageMapsMatch,
    parseArguments,
    resolveGitDirectory,
    runWithWorktreeDependencies,
};
