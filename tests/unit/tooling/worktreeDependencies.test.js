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
    installationEnvironment,
    npmExecutable,
    packageMapsMatch,
    parseArguments,
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

test('WORKTREE-DEPENDENCY-GUARD-001 removes a stale lock before acquiring and releases its own lock', t => {
    const { gitDirectory } = makeRepository(t);
    const lockPath = path.join(gitDirectory, LOCK_FILE_NAME);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 0 }));

    const release = acquireLock(lockPath);
    assert.equal(fs.existsSync(lockPath), true);

    release();
    assert.equal(fs.existsSync(lockPath), false);
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
