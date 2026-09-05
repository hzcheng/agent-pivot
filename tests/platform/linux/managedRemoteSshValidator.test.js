'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ManagedSshProjectionValidator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshValidator');

test('MANAGED-REMOTE-SSH-VALIDATION-001 validates the installed Linux OpenSSH -F/-G behavior', {
    skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/ssh'),
}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-openssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const generated = path.join(root, 'current.conf');
    fs.writeFileSync(generated, [
        'Host 小红书开发机',
        '    HostName build.example.com',
        '    User dev',
        '    Port 22022',
        '    ProxyJump none',
        '    ProxyCommand none',
        '    PermitLocalCommand no',
        '',
    ].join('\n'), { mode: 0o600 });

    await new ManagedSshProjectionValidator().validate({
        executable: '/usr/bin/ssh',
        aggregateConfigContent: `Include "${generated}"\nHost *\n  Port 22\n`,
        entries: [{
            machineId: 'machine:fixture',
            alias: '小红书开发机',
            name: '小红书开发机',
            host: 'build.example.com',
            user: 'dev',
            port: 22022,
        }],
    });
    assert.ok(true);
});
