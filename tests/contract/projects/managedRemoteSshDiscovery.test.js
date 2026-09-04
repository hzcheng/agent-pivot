'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    discoverManagedSshLocalInputs,
    managedSshConfiguredPaths,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshDiscovery');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-ssh-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    const ssh = path.join(bin, 'ssh');
    const sshDirectory = path.join(root, '.ssh');
    fs.mkdirSync(bin);
    fs.mkdirSync(sshDirectory);
    fs.writeFileSync(ssh, '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(path.join(sshDirectory, 'config'), '', { mode: 0o600 });
    return { root, bin, ssh };
}

test('MANAGED-REMOTE-SSH-DISCOVERY-001 resolves the exact executable and canonical config path', t => {
    const { root, bin, ssh } = fixture(t);
    const result = discoverManagedSshLocalInputs({
        platform: 'linux',
        homeDirectory: root,
        environmentPath: bin,
        remoteSshPath: 'ssh',
        remoteSshConfigFile: '~/.ssh/config',
    });
    assert.equal(result.executable, fs.realpathSync.native(ssh));
    assert.equal(result.activeConfigPath, fs.realpathSync.native(path.join(root, '.ssh/config')));
});

test('MANAGED-REMOTE-SSH-DISCOVERY-001 rejects relative config paths and missing executables', t => {
    const { root, bin } = fixture(t);
    assert.throws(() => discoverManagedSshLocalInputs({
        platform: 'linux', homeDirectory: root, environmentPath: bin,
        remoteSshConfigFile: 'relative/config',
    }), /absolute path/);
    assert.throws(() => discoverManagedSshLocalInputs({
        platform: 'linux', homeDirectory: root, environmentPath: '',
        remoteSshPath: '/missing/ssh',
    }), /not found/);
});

test('MANAGED-REMOTE-SSH-DISCOVERY-001 derives Windows OpenSSH and config defaults without local substitution', () => {
    assert.deepEqual(managedSshConfiguredPaths({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Dev',
        environmentPath: 'C:\\Windows\\System32',
        windowsDirectory: 'D:\\Windows',
    }), {
        executableCandidate: 'D:\\Windows\\System32\\OpenSSH\\ssh.exe',
        configPath: 'C:\\Users\\Dev\\.ssh\\config',
    });
});
