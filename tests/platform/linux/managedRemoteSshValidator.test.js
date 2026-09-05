'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    insertManagedInclude,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConfigPolicy');
const {
    ManagedSshProjectionValidator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshValidator');
const {
    managedSshAlias,
    renderManagedSshConfig,
    renderManagedSshIncludeBlock,
} = require('../../../out/projects/managedRemote/sshConfigProjection');

const SKIP = {
    skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/ssh'),
};

const MACHINE_ID = 'machine:1a678d4c46b03315af3e31ba30c326b9';

function projectionFor(name, host, port) {
    const alias = managedSshAlias(MACHINE_ID, name, host);
    return {
        alias,
        projection: {
            revisionId: `revision:${'a'.repeat(64)}`,
            connectionDigest: 'digest',
            entries: [{
                machineId: MACHINE_ID, alias, name, host, user: 'dev', port,
            }],
            unavailableMachineIds: [],
        },
    };
}

function writeProjection(root, projection) {
    const generated = path.join(root, 'current.conf');
    fs.writeFileSync(generated, renderManagedSshConfig(projection), { mode: 0o600 });
    return generated;
}

/**
 * Exercises the generated alias against the real OpenSSH binary rather than
 * against our own alias regex. OpenSSH resolves an alias with valid_domain(),
 * which rejects any non-ASCII byte, so a CJK Machine name must still produce
 * an alias the installed client can resolve.
 */
test('MANAGED-REMOTE-SSH-VALIDATION-001 resolves a generated alias for a CJK Machine name', SKIP, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-openssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { alias, projection } = projectionFor(
        '小红书开发机', 'reddev.example.com', 22022,
    );
    assert.match(alias, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    const generated = writeProjection(root, projection);

    await new ManagedSshProjectionValidator().validate({
        executable: '/usr/bin/ssh',
        aggregateConfigContent: `Include "${generated}"\n`,
        entries: projection.entries,
    });
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 resolves a generated alias for an ASCII Machine name', SKIP, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-openssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { projection } = projectionFor('RedDev Main', 'build.example.com', 22);
    const generated = writeProjection(root, projection);

    await new ManagedSshProjectionValidator().validate({
        executable: '/usr/bin/ssh',
        aggregateConfigContent: `Include "${generated}"\nHost *\n  Port 22\n`,
        entries: projection.entries,
    });
});

/**
 * OpenSSH evaluates an Include in the scope of the preceding Host block. If the
 * managed Include is appended to a config that ends in a Host block, the
 * managed hosts apply only while connecting to that host, and `ssh -G` silently
 * falls through to defaults for every managed alias.
 */
test('MANAGED-REMOTE-SSH-VALIDATION-001 resolves through a user config that ends in a Host block', SKIP, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-openssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { projection } = projectionFor(
        '小红书开发机', 'reddev.example.com', 22022,
    );
    const generated = writeProjection(root, projection);
    const userConfig = 'Host code.example.com\n'
        + '    StrictHostKeyChecking no\n'
        + '    UserKnownHostsFile /dev/null\n';

    await new ManagedSshProjectionValidator().validate({
        executable: '/usr/bin/ssh',
        aggregateConfigContent: insertManagedInclude(
            userConfig, renderManagedSshIncludeBlock(generated), generated,
        ),
        entries: projection.entries,
    });
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 detects an Include nested under a Host block', SKIP, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-openssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { projection } = projectionFor(
        '小红书开发机', 'reddev.example.com', 22022,
    );
    const generated = writeProjection(root, projection);

    // Appending rather than prepending nests the Include, which real OpenSSH
    // resolves to the default endpoint instead of the managed one.
    await assert.rejects(
        new ManagedSshProjectionValidator().validate({
            executable: '/usr/bin/ssh',
            aggregateConfigContent: 'Host code.example.com\n'
                + '    StrictHostKeyChecking no\n'
                + `Include "${generated}"\n`,
            entries: projection.entries,
        }),
        /unsafe target for .* \(hostname\)/u,
    );
});
