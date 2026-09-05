'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    analyzeManagedInclude,
    insertManagedInclude,
    NodeManagedSshConfigFileSystem,
    removeManagedInclude,
    scanManagedSshConfigGraph,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConfigPolicy');
const { renderManagedSshIncludeBlock } = require('../../../out/projects/managedRemote/sshConfigProjection');

class MemoryFiles {
    constructor(files) { this.files = files; }
    readSecureFile(filePath) {
        if (!(filePath in this.files)) { throw new Error('missing'); }
        const content = this.files[filePath];
        return {
            path: filePath,
            realPath: filePath,
            size: Buffer.byteLength(content),
            modifiedAtMs: 1,
            mode: 0o100600,
            device: 1,
            inode: Object.keys(this.files).indexOf(filePath) + 1,
            uid: 1000,
            gid: 1000,
            checksum: require('node:crypto').createHash('sha256').update(content).digest('hex'),
            content,
        };
    }
}

test('MANAGED-REMOTE-SSH-POLICY-001 inserts and removes only the exact owned Include block', () => {
    const generated = '/home/dev/.ssh/agent-pivot/current.conf';
    const block = renderManagedSshIncludeBlock(generated);
    const source = 'Host legacy\r\n    HostName old.example.com\r\n';
    const inserted = insertManagedInclude(source, block, generated);

    assert.equal(analyzeManagedInclude(inserted, generated), 'exact');
    assert.ok(inserted.startsWith(block.replace(/\n/g, '\r\n')));
    assert.equal(removeManagedInclude(inserted, generated), source);
    assert.equal(removeManagedInclude(source, generated), source);
    assert.throws(
        () => insertManagedInclude(`${block}\n${block}\n`, block, generated),
        /modified or duplicate/,
    );
});

test('MANAGED-REMOTE-SSH-POLICY-001 fingerprints a bounded static Include graph', () => {
    const files = new MemoryFiles({
        '/home/dev/.ssh/config': 'Include "/home/dev/.ssh/team config"\nHost *\n  ServerAliveInterval 30\n',
        '/home/dev/.ssh/team config': 'Host build\n  HostName build.example.com\n',
    });
    const first = scanManagedSshConfigGraph('/home/dev/.ssh/config', files, { platform: 'linux' });
    const second = scanManagedSshConfigGraph('/home/dev/.ssh/config', files, { platform: 'linux' });

    assert.deepEqual(first.issues, []);
    assert.equal(first.fingerprint.files.length, 2);
    assert.equal(first.fingerprint.digest, second.fingerprint.digest);
});

test('MANAGED-REMOTE-SSH-POLICY-001 rejects dynamic Includes, cycles, Match exec, and unreadable files', () => {
    const dynamic = scanManagedSshConfigGraph('/home/dev/.ssh/config', new MemoryFiles({
        '/home/dev/.ssh/config': 'Include=~/.ssh/conf.d/*\nMatch=exec "touch /tmp/no"\n',
    }), { platform: 'linux' });
    assert.ok(dynamic.issues.some(issue => issue.startsWith('dynamic-include:')));
    assert.ok(dynamic.issues.some(issue => issue.startsWith('match-exec:')));

    const cycle = scanManagedSshConfigGraph('/a', new MemoryFiles({
        '/a': 'Include /b\n',
        '/b': 'Include /a\n',
    }), { platform: 'linux' });
    assert.ok(cycle.issues.includes('include-cycle:/a'));

    const missing = scanManagedSshConfigGraph('/missing', new MemoryFiles({}), { platform: 'linux' });
    assert.deepEqual(missing.issues, ['unreadable:/missing']);
});

test('MANAGED-REMOTE-SSH-POLICY-001 rejects a group-writable config on POSIX', t => {
    if (process.platform === 'win32') { t.skip('POSIX permission contract'); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-ssh-policy-mode-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    fs.writeFileSync(config, 'Host safe\n', { mode: 0o620 });
    // The creation mode is filtered by the process umask (commonly 0o022,
    // which strips group write), so set the bit explicitly after creation.
    fs.chmodSync(config, 0o620);
    assert.throws(
        () => new NodeManagedSshConfigFileSystem().readSecureFile(config),
        /unsafe permissions/,
    );
});
