'use strict';

// Owner for LOCAL-INSTALL-WORKTREE-DEPENDENCIES-001.
//
// scripts/build-test-package-install.sh is the documented local install path,
// and AGENTS.md requires every line of work to run inside a worktree. The
// script therefore must install dependencies through the worktree dependency
// guard rather than a bare `npm ci`: the guard skips the install when the
// worktree is already current, serializes against concurrent commands in the
// same worktree, and neutralizes the inherited user-level allow-scripts config
// that makes a bare project-scoped `npm ci` fail.
//
// The script is exercised, not pattern-matched: `npm` and `node` are replaced
// with recording shims on PATH so the real invocation sequence is observed.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

const repositoryRoot = path.resolve(__dirname, '../../..');
const installScript = path.join(repositoryRoot, 'scripts', 'build-test-package-install.sh');

/** Run the install script with recording shims for npm and node. */
function runScript(t, { environment = {} } = {}) {
    const directory = makeTempDirectory(t, 'install-local-');
    const binDirectory = path.join(directory, 'bin');
    const logPath = path.join(directory, 'invocations.log');
    fs.mkdirSync(binDirectory, { recursive: true });
    for (const executable of ['npm', 'node']) {
        const shim = path.join(binDirectory, executable);
        fs.writeFileSync(shim,
            `#!/usr/bin/env bash\nprintf '%s\\n' "${executable} $*" >> ${JSON.stringify(logPath)}\nexit 0\n`);
        fs.chmodSync(shim, 0o755);
    }
    const result = childProcess.spawnSync('bash', [installScript], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...environment,
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
        },
    });
    const invocations = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
        : [];
    return { result, invocations };
}

test('LOCAL-INSTALL-WORKTREE-DEPENDENCIES-001 installs dependencies through the worktree guard', t => {
    const { result, invocations } = runScript(t);

    assert.equal(result.status, 0,
        `the install script must succeed with stubbed tools: ${result.stderr}`);
    assert.ok(
        invocations.some(line => /^npm run worktree:bootstrap$/.test(line)),
        'the dependency step must delegate to the worktree guard, which handles the '
            + `allow-scripts config and the worktree lock. Saw: ${JSON.stringify(invocations)}`
    );
    assert.ok(
        !invocations.some(line => /^npm ci\b/.test(line)),
        'a bare `npm ci` bypasses the guard: it fails under an inherited allow-scripts '
            + 'config and can delete node_modules while another worktree command runs. '
            + `Saw: ${JSON.stringify(invocations)}`
    );
});

test('LOCAL-INSTALL-WORKTREE-DEPENDENCIES-001 still honours SKIP_NPM_CI for an already-prepared tree', t => {
    const { result, invocations } = runScript(t, { environment: { SKIP_NPM_CI: '1' } });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        !invocations.some(line => /^npm (ci\b|run worktree:bootstrap$)/.test(line)),
        `SKIP_NPM_CI=1 must skip the dependency step entirely. Saw: ${JSON.stringify(invocations)}`
    );
});

test('LOCAL-INSTALL-WORKTREE-DEPENDENCIES-001 keeps the build, package, and install steps in order', t => {
    const { invocations } = runScript(t, { environment: { SKIP_NPM_CI: '1' } });

    assert.deepEqual(
        invocations.filter(line => line !== 'npm run worktree:bootstrap'),
        [
            'npm run test-compile',
            'npm run lint',
            'npm run package:release',
            'node scripts/install-local-extensions.js',
        ],
        'the install script must build, lint, package, and then route the artifacts'
    );
});

test('LOCAL-INSTALL-WORKTREE-DEPENDENCIES-001 fails loudly when a step fails', t => {
    const directory = makeTempDirectory(t, 'install-local-');
    const binDirectory = path.join(directory, 'bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    // npm fails; node would succeed. The script must not reach node.
    fs.writeFileSync(path.join(binDirectory, 'npm'),
        '#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n');
    fs.chmodSync(path.join(binDirectory, 'npm'), 0o755);
    fs.writeFileSync(path.join(binDirectory, 'node'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(binDirectory, 'node'), 0o755);

    const result = childProcess.spawnSync('bash', [installScript], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env.PATH}` },
    });

    assert.notEqual(result.status, 0,
        'a failing dependency step must abort the install rather than report success');
});
