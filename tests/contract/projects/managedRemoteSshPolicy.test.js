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

test('MANAGED-REMOTE-SSH-POLICY-001 scopes the managed Include above every Host block', () => {
    const generated = '/home/dev/.ssh/agent-pivot/current.conf';
    const block = renderManagedSshIncludeBlock(generated);
    // OpenSSH evaluates an Include in the scope of the preceding Host block, so
    // appending it would apply the managed hosts only while connecting to that
    // host and leave every managed alias unresolvable everywhere else.
    const source = 'Host code.example.com\n    StrictHostKeyChecking no\n';
    const inserted = insertManagedInclude(source, block, generated);

    assert.ok(inserted.startsWith(block));
    assert.ok(inserted.indexOf('Include') < inserted.indexOf('Host code.example.com'));
});

test('MANAGED-REMOTE-SSH-POLICY-001 scopes the managed Include above a leading Match block', () => {
    const generated = '/home/dev/.ssh/agent-pivot/current.conf';
    const block = renderManagedSshIncludeBlock(generated);
    const source = 'Match host build.example.com\n    User dev\n';
    const inserted = insertManagedInclude(source, block, generated);

    assert.ok(inserted.indexOf('Include') < inserted.indexOf('Match host'));
});

test('Home-relative literal Includes are fingerprinted without weakening dynamic path checks', () => {
    const root = '/home/dev/.ssh/config';
    const included = '/home/dev/.ssh/home-infra.generated.conf';
    const files = new MemoryFiles({ [root]: 'Include ~/.ssh/home-infra.generated.conf\n', [included]: 'Host infra-home-book\n HostName 100.101.7.100\n' });
    const options = { platform: 'linux', homeDirectory: '/home/dev' };
    const first = scanManagedSshConfigGraph(root, files, options);
    assert.deepEqual(first.issues, []);
    assert.equal(first.fingerprint.files.length, 2);
    files.files[included] += ' Port 2222\n';
    assert.notEqual(scanManagedSshConfigGraph(root, files, options).fingerprint.digest, first.fingerprint.digest);
    for (const pattern of ['~other/.ssh/config', '~/.ssh/*.conf', '~/.ssh/%h', '~/.ssh/$CONFIG', '~/.ssh/%h/../safe.conf', '~/.ssh/*/../safe.conf']) {
        files.files[root] = `Include ${pattern}\n`;
        assert.ok(scanManagedSshConfigGraph(root, files, options).issues.some(x => x.startsWith('dynamic-include:')), pattern);
    }
    files.files[root] = 'Include ~/.ssh/home-infra.generated.conf\n';
    files.files[included] = 'Include ~/.ssh/config\n';
    assert.ok(scanManagedSshConfigGraph(root, files, options).issues.some(x => x.startsWith('include-cycle:')));
});

test('MANAGED-REMOTE-SSH-CONSENT-001 recovers known-host filenames without guessing whitespace boundaries', t => {
    const { resolveManagedKnownHostsPaths } = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConfigPolicy');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-trust-paths-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    fs.writeFileSync(config, 'Host one\n UserKnownHostsFile "/tmp/trusted /hosts" relative_file\n', { mode: 0o600 });
    assert.deepEqual(resolveManagedKnownHostsPaths(config, '/tmp/trusted /hosts relative_file'), ['/tmp/trusted /hosts', 'relative_file']);
    fs.appendFileSync(config, 'Host two\n UserKnownHostsFile /tmp/trusted /hosts relative_file\n');
    assert.throws(() => resolveManagedKnownHostsPaths(config, '/tmp/trusted /hosts relative_file'), /unambiguously/);
});
