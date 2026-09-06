'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ManagedSshActiveConfigEditor,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshActiveConfigEditor');
const {
    ManagedSshOwnedFileStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshOwnedFiles');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-active-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ssh = path.join(root, '.ssh');
    fs.mkdirSync(ssh, { mode: 0o700 });
    const config = path.join(ssh, 'config');
    const original = 'Host legacy\r\n  HostName old.example.com\r\n';
    fs.writeFileSync(config, original, { mode: 0o600 });
    const owned = new ManagedSshOwnedFileStore(config);
    return {
        config,
        original,
        owned,
        editor: new ManagedSshActiveConfigEditor(config, owned),
    };
}

test('MANAGED-REMOTE-SSH-ACTIVE-CONFIG-001 automatically replaces exact bytes and retains a backup', t => {
    const { config, original, owned, editor } = fixture(t);
    const candidate = `# managed\r\n${original}`;
    const result = editor.replace(original, candidate);
    assert.equal(result.status, 'updated');
    assert.equal(fs.readFileSync(config, 'utf8'), candidate);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.equal(editor.hasInterruptedExchange(), false);
    assert.equal(fs.existsSync(path.join(owned.getPaths().root, 'active-config.candidate')), false);
});

test('MANAGED-REMOTE-SSH-ACTIVE-CONFIG-001 restores an interrupted exchange without losing bytes', t => {
    const { config, original, owned, editor } = fixture(t);
    const root = owned.getPaths().root;
    fs.mkdirSync(root, { mode: 0o700 });
    const exchange = path.join(root, 'active-config.exchange');
    const candidate = path.join(root, 'active-config.candidate');
    fs.renameSync(config, exchange);
    fs.writeFileSync(candidate, '# candidate\n', { mode: 0o600 });

    const result = editor.recoverInterruptedExchange();
    assert.equal(result.status, 'manualRequired');
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    assert.equal(editor.hasInterruptedExchange(), false);
});

test('MANAGED-REMOTE-SSH-ACTIVE-CONFIG-001 never overwrites a concurrent external save', t => {
    const { config, original, owned } = fixture(t);
    const editor = new ManagedSshActiveConfigEditor(config, owned, {
        afterDisplace() {
            fs.writeFileSync(config, '# external save\n', { mode: 0o600 });
        },
    });
    const result = editor.replace(original, `# managed\n${original}`);
    assert.equal(result.status, 'manualRequired');
    assert.match(result.reason, /Another editor saved/);
    assert.equal(fs.readFileSync(config, 'utf8'), '# external save\n');
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
});

test('MANAGED-REMOTE-SSH-ACTIVE-CONFIG-001 restores the original when candidate publication fails', t => {
    const { config, original, owned } = fixture(t);
    const editor = new ManagedSshActiveConfigEditor(config, owned, {
        afterDisplace() {
            fs.unlinkSync(owned.getPaths().activeConfigCandidate);
        },
    });
    const result = editor.replace(original, `# managed\n${original}`);
    assert.equal(result.status, 'manualRequired');
    assert.match(result.reason, /could not publish/);
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    assert.equal(editor.hasInterruptedExchange(), false);
});

test('MANAGED-REMOTE-SSH-ACTIVE-CONFIG-001 finishes an installed exchange and archives the displaced bytes', t => {
    const { config, original, owned, editor } = fixture(t);
    const root = owned.getPaths().root;
    fs.mkdirSync(root, { mode: 0o700 });
    const exchange = path.join(root, 'active-config.exchange');
    const candidate = path.join(root, 'active-config.candidate');
    fs.renameSync(config, exchange);
    fs.writeFileSync(candidate, '# candidate\n', { mode: 0o600 });
    fs.linkSync(candidate, config);

    const result = editor.recoverInterruptedExchange();
    assert.equal(result.status, 'manualRequired');
    assert.equal(fs.readFileSync(config, 'utf8'), '# candidate\n');
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
    assert.equal(editor.hasInterruptedExchange(), false);
});
