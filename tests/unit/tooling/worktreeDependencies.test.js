'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    DEPENDENCY_SENTINELS,
    LOCK_ENVIRONMENT_VARIABLE,
    LOCK_FILE_NAME,
    acquireLock,
    dependenciesAreCurrent,
    directDependenciesArePresent,
    installationEnvironment,
    lockOwnerIsAlive,
    main,
    npmExecutable,
    packageMapsMatch,
    parseArguments,
    processIsAlive,
    resolveGitDirectory,
    runCommand,
    runWithWorktreeDependencies,
} = require('../../../scripts/with-worktree-dependencies');

function writeFile(root, relativePath, contents = '') {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
}

function writeCurrentDependencies(root) {
    const packages = {
        'node_modules/fitty': { version: '2.4.2' },
        'node_modules/typescript': { version: '5.9.2' },
    };
    writeFile(root, 'package.json', JSON.stringify({
        name: 'fixture',
        devDependencies: { fitty: '2.4.2', typescript: '5.9.2' },
    }));
    for (const sentinel of DEPENDENCY_SENTINELS) {
        writeFile(root, sentinel, 'fixture');
    }
    writeFile(root, 'package-lock.json', JSON.stringify({
        name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages },
    }));
    writeFile(root, 'node_modules/.package-lock.json', JSON.stringify({
        name: 'fixture', lockfileVersion: 3, packages,
    }));
}

function makeRepository(t) {
    const root = makeTempDirectory(t, 'worktree-dependencies-');
    const gitDirectory = path.join(root, '.git-worktree');
    fs.mkdirSync(gitDirectory);
    writeCurrentDependencies(root);
    return { root, gitDirectory };
}

test('WORKTREE-DEPENDENCY-GUARD-001 accepts direct installed lock entries when their resolved identities match package-lock', t => {
    const { root } = makeRepository(t);

    assert.equal(packageMapsMatch(root), true);
    assert.equal(dependenciesAreCurrent(root), true);

    writeFile(root, 'node_modules/.package-lock.json', JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/fitty': { version: 'older' } },
    }));
    assert.equal(packageMapsMatch(root), false);
    assert.equal(dependenciesAreCurrent(root), false);

    writeFile(root, 'node_modules/.package-lock.json', JSON.stringify({
        lockfileVersion: 3,
        packages: {},
    }));
    assert.equal(packageMapsMatch(root), false, 'an empty installed lock must not validate a populated install');
});

test('WORKTREE-DEPENDENCY-GUARD-001 treats missing direct dependency sentinels as an incomplete install', t => {
    const { root } = makeRepository(t);

    fs.unlinkSync(path.join(root, 'node_modules/fitty/dist/fitty.min.js'));

    assert.equal(dependenciesAreCurrent(root), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 rejects malformed lockfiles and missing direct packages', t => {
    const { root } = makeRepository(t);

    writeFile(root, 'node_modules/.package-lock.json', '{not json');
    assert.equal(packageMapsMatch(root), false);

    writeCurrentDependencies(root);
    fs.rmSync(path.join(root, 'node_modules/fitty'), { recursive: true });
    assert.equal(directDependenciesArePresent(root), false);
    assert.equal(dependenciesAreCurrent(root), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 removes a stale lock before acquiring and releases its own lock', t => {
    const { gitDirectory } = makeRepository(t);
    const lockPath = path.join(gitDirectory, LOCK_FILE_NAME);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 0 }));

    const release = acquireLock(lockPath);
    assert.equal(fs.existsSync(lockPath), true);

    release();
    assert.equal(fs.existsSync(lockPath), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 reports live-lock timeouts and filesystem lock errors', () => {
    let currentTime = 0;
    const existingLockFileSystem = {
        openSync() {
            const error = new Error('exists');
            error.code = 'EEXIST';
            throw error;
        },
        readFileSync() {
            return JSON.stringify({ pid: process.pid });
        },
    };
    assert.throws(
        () => acquireLock('/fixture.lock', {
            fileSystem: existingLockFileSystem,
            now: () => ++currentTime,
            timeoutMs: 1,
        }),
        /Timed out waiting for worktree dependency lock/
    );
    assert.throws(
        () => acquireLock('/fixture.lock', {
            fileSystem: {
                openSync() {
                    const error = new Error('denied');
                    error.code = 'EACCES';
                    throw error;
                },
            },
        }),
        /denied/
    );
});

test('WORKTREE-DEPENDENCY-GUARD-001 recognizes invalid lock owner metadata and validates process ids', () => {
    assert.equal(processIsAlive(0), false);
    assert.equal(processIsAlive(process.pid), true);
    assert.equal(lockOwnerIsAlive('/missing-lock', { readFileSync() { throw new Error('missing'); } }), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 resolves worktree Git directories and surfaces Git failures', () => {
    assert.equal(resolveGitDirectory('/repository', () => ({ status: 0, stdout: '.git/worktrees/example\n' })),
        path.resolve('/repository', '.git/worktrees/example'));
    assert.throws(
        () => resolveGitDirectory('/repository', () => ({ status: 1, stderr: 'not a repository' })),
        /not a repository/
    );
});

test('WORKTREE-DEPENDENCY-GUARD-001 runs npm ci before a command when the install is incomplete', t => {
    const { root, gitDirectory } = makeRepository(t);
    fs.unlinkSync(path.join(root, 'node_modules/typescript/bin/tsc'));
    const calls = [];
    const logger = { log() {} };

    const status = runWithWorktreeDependencies(['node', '--version'], {
        repositoryRoot: root,
        gitDirectory,
        logger,
        spawnSync(command, args, options) {
            calls.push({ command, args, options });
            if (command === 'npm') {
                writeCurrentDependencies(root);
            }
            return { status: 0 };
        },
    });

    assert.equal(status, 0);
    assert.deepEqual(calls.map(call => [call.command, call.args]), [
        ['npm', ['ci', '--ignore-scripts', '--allow-scripts=']],
        ['node', ['--version']],
    ]);
    assert.equal(calls[1].options.env[LOCK_ENVIRONMENT_VARIABLE], path.join(gitDirectory, LOCK_FILE_NAME));
    assert.equal(fs.existsSync(path.join(gitDirectory, LOCK_FILE_NAME)), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 reuses an inherited lock for nested guarded commands', t => {
    const { root, gitDirectory } = makeRepository(t);
    const lockPath = path.join(gitDirectory, LOCK_FILE_NAME);
    const calls = [];

    const status = runWithWorktreeDependencies(['node', '--version'], {
        repositoryRoot: root,
        gitDirectory,
        environment: { [LOCK_ENVIRONMENT_VARIABLE]: lockPath },
        logger: { log() {} },
        spawnSync(command, args, options) {
            calls.push({ command, args, options });
            return { status: 0 };
        },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(lockPath), false, 'a nested command must not create or release the parent lock');
});

test('WORKTREE-DEPENDENCY-GUARD-001 returns failed installs and rejects incomplete successful installs', t => {
    const failedInstall = makeRepository(t);
    fs.unlinkSync(path.join(failedInstall.root, 'node_modules/typescript/bin/tsc'));
    assert.equal(runWithWorktreeDependencies(['node', '--version'], {
        repositoryRoot: failedInstall.root,
        gitDirectory: failedInstall.gitDirectory,
        logger: { log() {} },
        spawnSync() { return { status: 9 }; },
    }), 9);

    const incompleteInstall = makeRepository(t);
    fs.unlinkSync(path.join(incompleteInstall.root, 'node_modules/typescript/bin/tsc'));
    assert.throws(() => runWithWorktreeDependencies(['node', '--version'], {
        repositoryRoot: incompleteInstall.root,
        gitDirectory: incompleteInstall.gitDirectory,
        logger: { log() {} },
        spawnSync() { return { status: 0 }; },
    }), /npm ci completed but the worktree dependencies are still incomplete/);
});

test('WORKTREE-DEPENDENCY-GUARD-001 handles bootstrap and command usage errors without leaking its lock', t => {
    const { root, gitDirectory } = makeRepository(t);
    const options = { repositoryRoot: root, gitDirectory, logger: { log() {} } };

    assert.equal(runWithWorktreeDependencies(['--install-only'], options), 0);
    assert.throws(() => runWithWorktreeDependencies(['--install-only', 'node'], options), /does not accept a command/);
    assert.throws(() => runWithWorktreeDependencies([], options), /Usage: npm run worktree:run/);
    assert.equal(fs.existsSync(path.join(gitDirectory, LOCK_FILE_NAME)), false);
});

test('WORKTREE-DEPENDENCY-GUARD-001 distinguishes bootstrap from guarded command arguments', () => {
    assert.deepEqual(parseArguments(['--install-only']), { installOnly: true, command: [] });
    assert.deepEqual(parseArguments(['--', 'node', '--version']), {
        installOnly: false, command: ['node', '--version'],
    });
});

test('WORKTREE-DEPENDENCY-GUARD-001 clears a forwarded npm script allowlist before bootstrapping', () => {
    const environment = installationEnvironment({
        npm_config_allow_scripts: '@xhs/ee-cli',
        NPM_CONFIG_ALLOW_SCRIPTS: 'other-package',
        KEEP: 'value',
    }, '/tmp/lock');

    assert.equal(environment.npm_config_allow_scripts, undefined);
    assert.equal(environment.NPM_CONFIG_ALLOW_SCRIPTS, undefined);
    assert.equal(environment[LOCK_ENVIRONMENT_VARIABLE], '/tmp/lock');
    assert.equal(environment.KEEP, 'value');
});

test('WORKTREE-DEPENDENCY-GUARD-001 resolves npm.cmd for Windows child commands', t => {
    const { root, gitDirectory } = makeRepository(t);
    const calls = [];

    const status = runWithWorktreeDependencies(['npm', '--version'], {
        repositoryRoot: root,
        gitDirectory,
        platform: 'win32',
        logger: { log() {} },
        spawnSync(command, args, options) {
            calls.push({ command, args, options });
            return { status: 0 };
        },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'npm.cmd');
    assert.deepEqual(calls[0].args, ['--version']);
    assert.equal(calls[0].options.shell, true);
    assert.equal(npmExecutable('win32'), 'npm.cmd');
    assert.equal(npmExecutable('linux'), 'npm');
});

test('WORKTREE-DEPENDENCY-GUARD-001 propagates child launch failures and normalizes signal exits', () => {
    const launchError = new Error('spawn failed');
    assert.throws(
        () => runCommand('node', [], '/repository', {}, () => ({ error: launchError })),
        /spawn failed/
    );
    assert.equal(runCommand('node', [], '/repository', {}, () => ({ status: null })), 1);
});

test('WORKTREE-DEPENDENCY-GUARD-001 reports guard failures through the supplied logger', t => {
    const { root, gitDirectory } = makeRepository(t);
    const messages = [];

    assert.equal(main([], {
        repositoryRoot: root,
        gitDirectory,
        logger: { error(message) { messages.push(message); } },
    }), 1);
    assert.match(messages[0], /Usage: npm run worktree:run/);
});
