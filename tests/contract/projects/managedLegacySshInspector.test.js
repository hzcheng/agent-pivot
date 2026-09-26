'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedLegacySshInspector,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedLegacySshInspector');

function effective(overrides = '') {
    const lines = [
        'hostname build.example.com',
        'user dev',
        'port 2207',
        'proxyjump none',
        'proxycommand none',
        'remotecommand none',
        'permitlocalcommand no',
    ];
    if (overrides) {
        const key = overrides.slice(0, overrides.indexOf(' '));
        const index = lines.findIndex(line => line.startsWith(`${key} `));
        if (index >= 0) { lines[index] = overrides; }
        else { lines.push(overrides); }
    }
    return lines.join('\n');
}

test('MANAGED-REMOTE-MIGRATION-SSH-INSPECTION-001 uses OpenSSH argv without a shell and returns only plain endpoint fields', async () => {
    const calls = [];
    const inspector = new ManagedLegacySshInspector({
        runner: {
            async run(executable, args, timeoutMs) {
                calls.push({ executable, args, timeoutMs });
                return { exitCode: 0, stdout: effective(), stderr: 'debug1: /home/me/.ssh/config line 1: Applying options for build\nprivate diagnostic' };
            },
        },
    });

    const result = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', 'build');

    assert.deepEqual(calls, [{
        executable: '/usr/bin/ssh',
        args: ['-F', '/home/me/.ssh/config', '-vv', '-G', 'build'],
        timeoutMs: 10_000,
    }]);
    assert.deepEqual(result, {
        status: 'needsInput',
        reason: 'Uses this computer’s SSH configuration, including jump hosts and authentication. Configure the same alias on other computers.',
        configurationMatched: true,
        sshConfigAlias: 'build',
        route: { kind: 'direct' },
        portable: { jumpHosts: [] },
        endpoint: { host: 'build.example.com', user: 'dev', port: 2207 },
    });
    assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});

test('MANAGED-REMOTE-MIGRATION-SSH-INSPECTION-001 preserves jump routing by reference and rejects hostile aliases', async () => {
    let runs = 0;
    const inspector = new ManagedLegacySshInspector({
        runner: {
            async run() {
                runs += 1;
                return { exitCode: 0, stdout: effective('proxyjump bastion'), stderr: 'debug1: /home/me/.ssh/config line 1: Applying options for build' };
            },
        },
    });

    const advanced = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', 'build');
    const hostile = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', '-F');

    assert.equal(advanced.status, 'needsInput');
    assert.equal(advanced.sshConfigAlias, 'build');
    assert.deepEqual(advanced.route, { kind: 'jump', jumpHosts: 'bastion' });
    assert.equal(hostile.status, 'unsupported');
    assert.equal(runs, 2);
    assert.match(advanced.portableReason, /cycle/);
});

test('MANAGED-REMOTE-MIGRATION-SSH-INSPECTION-001 returns a noninteractive failure when OpenSSH cannot resolve an alias', async () => {
    let runs = 0;
    const inspector = new ManagedLegacySshInspector({
        runner: { async run() { runs += 1; throw new Error('cannot resolve'); } },
    });

    const result = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', 'build');
    assert.equal(result.status, 'needsInput');
    assert.match(result.reason, /could not inspect/u);
    assert.equal(runs, 1);
});

test('Import rejects successful default resolution without an active Host rule', async () => {
    const inspector = new ManagedLegacySshInspector({ runner: { async run() {
        return { exitCode: 0, stdout: effective('hostname infra-home-linux'), stderr: 'debug1: /tmp/config line 10: Applying options for *' };
    } } });
    const result = await inspector.inspect('ssh', '/tmp/config', 'infra-home-linux');
    assert.equal(result.configurationMatched, false);
    assert.match(result.reason, /no active Host or target-specific Match configuration.*Include/);
});

test('OpenSSH inspection rejects an inactive Include and accepts its corrected scope', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    if (spawnSync('ssh', ['-V']).status !== 0) { t.skip('OpenSSH unavailable'); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-import-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    const included = path.join(root, 'home.conf');
    fs.writeFileSync(included, 'Host infra-home-linux\n HostName 192.0.2.10\n User dev\n ProxyJump gateway\n');
    fs.writeFileSync(config, `Host unrelated\n HostName 192.0.2.20\n Include "${included}"\nHost *\n`);
    const inspector = new ManagedLegacySshInspector({});
    const broken = await inspector.inspect('ssh', config, 'infra-home-linux');
    assert.equal(broken.configurationMatched, false);
    fs.writeFileSync(config, `Host unrelated\n HostName 192.0.2.20\nHost *\n Include "${included}"\nHost *\n`);
    const fixed = await inspector.inspect('ssh', config, 'infra-home-linux');
    assert.deepEqual(fixed.endpoint, { host: '192.0.2.10', user: 'dev', port: 22 });
    assert.equal(fixed.sshConfigAlias, 'infra-home-linux');
    assert.deepEqual(fixed.route, { kind: 'jump', jumpHosts: 'gateway' });
});


test('OpenSSH recognizes target-specific Match rules without breaking default-only existing references', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    if (require('node:child_process').spawnSync('ssh', ['-V']).status !== 0) { t.skip('OpenSSH unavailable'); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-import-match-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    const inspector = new ManagedLegacySshInspector({});
    fs.writeFileSync(config, 'Match originalhost infra-home-linux\n HostName 192.0.2.10\n User dev\n ProxyJump gateway\n');
    const matched = await inspector.inspect('ssh', config, 'infra-home-linux');
    assert.equal(matched.configurationMatched, true);
    assert.equal(matched.endpoint.host, '192.0.2.10');
    for (const rule of ['OriginalHost infra-home-linux', 'host * originalhost infra-home-linux']) {
        fs.writeFileSync(config, `Match ${rule}\n HostName 192.0.2.10\n User dev\n`);
        assert.equal((await inspector.inspect('ssh', config, 'infra-home-linux')).configurationMatched, true, rule);
    }
    const unmatched = await inspector.inspect('ssh', config, 'other');
    assert.equal(unmatched.configurationMatched, false);
    fs.writeFileSync(config, 'Host *\n User dev\n');
    const existing = await inspector.inspect('ssh', config, 'build.example.com');
    assert.equal(existing.configurationMatched, false);
    assert.deepEqual(existing.endpoint, { host: 'build.example.com', user: 'dev', port: 22 });
    assert.notEqual(existing.status, 'unsupported');
});

test('Portable import resolves nested routes and explicit jump credentials without exporting key paths', async t => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-inspect-route-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    fs.writeFileSync(config, `Host target
  HostName target.example.com
  User dev
  ProxyJump override@inner:2222
Host inner
  HostName inner.example.com
  User ignored
  Port 22
  ProxyJump outer
  IdentityFile /local/private/key
Host outer
  HostName outer.example.com
  User jump
  Port 2229
`);
    const inspector = new ManagedLegacySshInspector({});
    const result = await inspector.inspect('ssh', config, 'target');
    assert.equal(result.configurationMatched, true);
    assert.deepEqual(result.portable.jumpHosts, [
        { name: 'outer', host: 'outer.example.com', user: 'jump', port: 2229 },
        { name: 'inner', host: 'inner.example.com', user: 'override', port: 2222 },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /\/local\/private/);
    fs.appendFileSync(config, '\nHost command-target\n  HostName command.example.com\n  User dev\n  ProxyCommand custom-proxy %h\n');
    const command = await inspector.inspect('ssh', config, 'command-target');
    assert.equal(command.portable, undefined);
    assert.match(command.portableReason, /custom ProxyCommand/);
});
