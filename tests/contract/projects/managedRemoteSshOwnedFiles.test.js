'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ManagedSshOwnedFileStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshOwnedFiles');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-managed-ssh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ssh = path.join(root, '.ssh');
    fs.mkdirSync(ssh, { mode: 0o700 });
    const config = path.join(ssh, 'config');
    fs.writeFileSync(config, 'Host legacy\n  HostName old.example.com\n', { mode: 0o600 });
    return { root, config, store: new ManagedSshOwnedFileStore(config) };
}

function revision(character) {
    return `revision:${character.repeat(64)}`;
}

test('MANAGED-REMOTE-SSH-FILES-001 installs versioned owned files without touching user config', t => {
    const { config, store } = fixture(t);
    const before = fs.readFileSync(config);
    const firstStage = store.stageProjection({
        revisionId: revision('1'),
        connectionDigest: 'a'.repeat(64),
        content: 'Host agent-pivot-one\n  HostName one.example.com\n',
    });
    const first = store.activateProjection(firstStage);
    const secondStage = store.stageProjection({
        revisionId: revision('2'),
        connectionDigest: 'b'.repeat(64),
        content: 'Host agent-pivot-two\n  HostName two.example.com\n',
    });
    const second = store.activateProjection(secondStage, first.currentChecksum);

    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(second.changed, true);
    assert.match(fs.readFileSync(store.getPaths().previous, 'utf8'), /one\.example\.com/);
    assert.equal(store.readManifest().currentChecksum, second.currentChecksum);
});

test('MANAGED-REMOTE-SSH-FILES-001 fails closed on external current edits and foreign files', t => {
    const { store } = fixture(t);
    const originalContent = 'Host agent-pivot-one\n  HostName one.example.com\n';
    const staged = store.stageProjection({
        revisionId: revision('1'),
        connectionDigest: 'a'.repeat(64),
        content: originalContent,
    });
    const installed = store.activateProjection(staged);
    fs.writeFileSync(store.getPaths().current, 'external edit\n');
    const next = store.stageProjection({
        revisionId: revision('2'),
        connectionDigest: 'b'.repeat(64),
        content: 'Host agent-pivot-two\n',
    });
    assert.throws(
        () => store.activateProjection(next, installed.currentChecksum),
        /outside Agent Pivot/,
    );

    fs.writeFileSync(store.getPaths().current, originalContent, { mode: 0o600 });
    fs.writeFileSync(path.join(store.getPaths().revisions, 'foreign.txt'), 'keep');
    assert.throws(
        () => store.removeOwnedFiles(installed.currentChecksum),
        /not owned/,
    );
    assert.equal(fs.readFileSync(path.join(store.getPaths().revisions, 'foreign.txt'), 'utf8'), 'keep');
});

test('MANAGED-REMOTE-SSH-FILES-001 refuses unsafe replacement targets and corrupt state', t => {
    const { root, store } = fixture(t);
    const staged = store.stageProjection({
        revisionId: revision('1'),
        connectionDigest: 'a'.repeat(64),
        content: 'Host agent-pivot-one\n  HostName one.example.com\n',
    });
    const external = path.join(root, 'external');
    fs.writeFileSync(external, 'keep', { mode: 0o600 });
    fs.mkdirSync(store.getPaths().root, { recursive: true, mode: 0o700 });
    fs.symlinkSync(external, store.getPaths().state);
    assert.throws(() => store.activateProjection(staged), /private regular file/);
    assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
    fs.unlinkSync(store.getPaths().state);

    const installed = store.activateProjection(staged);
    fs.writeFileSync(store.getPaths().state, '{broken', { mode: 0o600 });
    assert.throws(() => store.readManifest(), /corrupt/);
    assert.throws(
        () => store.removeOwnedFiles(installed.currentChecksum),
        /corrupt/,
    );
});

test('MANAGED-REMOTE-SSH-FILES-001 removes only enumerated owned files after Include removal', t => {
    const { config, store } = fixture(t);
    const staged = store.stageProjection({
        revisionId: revision('1'),
        connectionDigest: 'a'.repeat(64),
        content: 'Host agent-pivot-one\n  HostName one.example.com\n',
    });
    const installed = store.activateProjection(staged);
    store.removeOwnedFiles(installed.currentChecksum);

    assert.equal(fs.existsSync(store.getPaths().current), false);
    assert.match(fs.readFileSync(config, 'utf8'), /Host legacy/);
});

test('MANAGED-REMOTE-SSH-FILES-001 serializes writers with the per-config lock', t => {
    const { store } = fixture(t);
    assert.throws(() => store.withLock(() => store.withLock(() => undefined)), /busy/);
});

test('MANAGED-REMOTE-SSH-FILES-001 recovers a fresh lock whose local process is gone', t => {
    const { store } = fixture(t);
    fs.mkdirSync(store.getPaths().root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(store.getPaths().lock, JSON.stringify({
        schemaVersion: 1,
        pid: 2147483647,
        host: os.hostname(),
        createdAtMs: Date.now(),
        token: 'abandoned',
    }), { mode: 0o600 });
    assert.equal(store.withLock(() => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(store.getPaths().lock), false);
});

test('MANAGED-REMOTE-SSH-FILES-001 never removes a live lock that replaced the stale owner', t => {
    const { store } = fixture(t);
    const lockPath = store.getPaths().lock;
    fs.mkdirSync(store.getPaths().root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, JSON.stringify({
        schemaVersion: 1,
        pid: 2147483647,
        host: os.hostname(),
        createdAtMs: Date.now(),
        token: 'stale-owner',
    }), { mode: 0o600 });
    const live = JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        host: os.hostname(),
        createdAtMs: Date.now(),
        token: 'live-owner',
    });
    const originalRename = fs.renameSync;
    const originalLink = fs.linkSync;
    let injected = false;
    const installLiveContender = () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, live, { mode: 0o600 });
        injected = true;
    };
    fs.renameSync = (source, target) => {
        if (!injected && source === lockPath) { installLiveContender(); }
        return originalRename(source, target);
    };
    fs.linkSync = (source, target) => {
        const result = originalLink(source, target);
        if (!injected && source === lockPath) { installLiveContender(); }
        return result;
    };
    try {
        let entered = false;
        assert.throws(
            () => store.withLock(() => { entered = true; }),
            /busy|changed|lock/i,
        );
        assert.equal(entered, false);
        assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'live-owner');
    } finally {
        fs.renameSync = originalRename;
        fs.linkSync = originalLink;
    }
});
