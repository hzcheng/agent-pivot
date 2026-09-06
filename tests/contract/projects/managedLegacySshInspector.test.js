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
                return { exitCode: 0, stdout: effective(), stderr: 'private diagnostic' };
            },
        },
    });

    const result = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', 'build');

    assert.deepEqual(calls, [{
        executable: '/usr/bin/ssh',
        args: ['-F', '/home/me/.ssh/config', '-G', 'build'],
        timeoutMs: 10_000,
    }]);
    assert.deepEqual(result, {
        status: 'needsInput',
        reason: 'Plain connection details were resolved automatically; authentication settings are not copied.',
        endpoint: { host: 'build.example.com', user: 'dev', port: 2207 },
    });
    assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});

test('MANAGED-REMOTE-MIGRATION-SSH-INSPECTION-001 rejects advanced routing and hostile aliases', async () => {
    let runs = 0;
    const inspector = new ManagedLegacySshInspector({
        runner: {
            async run() {
                runs += 1;
                return { exitCode: 0, stdout: effective('proxyjump bastion'), stderr: '' };
            },
        },
    });

    const advanced = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', 'build');
    const hostile = await inspector.inspect('/usr/bin/ssh', '/home/me/.ssh/config', '-F');

    assert.equal(advanced.status, 'unsupported');
    assert.match(advanced.reason, /proxy, command, or forwarding/u);
    assert.equal(hostile.status, 'unsupported');
    assert.equal(runs, 1);
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
