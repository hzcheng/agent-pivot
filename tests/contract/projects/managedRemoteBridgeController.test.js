'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCausalVersion, createVersionedCandidates, joinVersionVectors, vectorIncludingVersion } = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createEmptyManagedCatalogEnvelope, createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const { managedSshAliasSuffix } = require('../../../out/projects/managedRemote/sshConfigProjection');
const {
    formatManagedSshCommand,
    ManagedRemoteBridgeController,
    parseSftpLongListing,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemoteBridgeController');

function activeEnvelope(lifecycle = 'active') {
    const catalog = ManagedRemoteCatalogService.create('bridge', prefix => `${prefix}:one`);
    catalog.addMachine({ name: 'Build', host: 'build.example.com', user: 'dev', port: 22 });
    catalog.addProject({
        id: 'project:one',
        environmentId: 'host:machine:one',
        name: 'API',
        remotePath: '/work/api',
    });
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    envelope.authority = createVersionedCandidates({ lifecycle, active: slot }, version);
    envelope.causalContext = joinVersionVectors(envelope.causalContext, vectorIncludingVersion(version));
    return { envelope, slot };
}

function request(operation, revisionId) {
    return {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation,
        ...(revisionId ? { expectedRevisionId: revisionId } : {}),
    };
}

test('MANAGED-REMOTE-BRIDGE-001 rereads authority and rejects stale identity before local effects', async () => {
    const { envelope, slot } = activeEnvelope();
    let reads = 0;
    let effects = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { reads += 1; return envelope; },
    }, {
        async create() {
            return {
                async reconcile() { effects += 1; return {}; },
            };
        },
    }, 'session-12345678');
    const stale = await controller.execute(request('reconcile', `revision:${'0'.repeat(64)}`));
    assert.equal(stale.status, 'catalogOutOfDate');
    assert.equal(effects, 0);
    const current = await controller.execute(request('reconcile', slot.revisionId));
    assert.equal(current.status, 'ok');
    assert.equal(effects, 1);
    assert.equal(reads, 2);
});

test('MANAGED-REMOTE-BRIDGE-001 rejects endpoint-bearing requests before creating a coordinator', async () => {
    let creates = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('must not read'); },
    }, {
        async create() { creates += 1; return {}; },
    }, 'session-12345678');
    const result = await controller.execute({
        ...request('reconcile', `revision:${'a'.repeat(64)}`),
        host: 'attacker.example.com',
    });
    assert.equal(result.status, 'failed');
    assert.equal(creates, 0);

    const expired = await controller.execute({
        ...request('reconcile', `revision:${'a'.repeat(64)}`),
        sessionToken: 'expired-12345678',
    });
    assert.equal(expired.status, 'failed');
    assert.match(expired.message, /session expired/);
    assert.equal(creates, 0);
});

test('MANAGED-REMOTE-BRIDGE-001 can recover local disable without catalog authority', async () => {
    let reads = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { reads += 1; return null; },
    }, {
        async create() {
            return {
                async recover(slot) {
                    assert.equal(slot, undefined);
                    return { status: 'disabled', record: { status: 'disabled' } };
                },
            };
        },
    }, 'session-12345678');
    const result = await controller.execute(request('recover'));
    assert.equal(result.status, 'ok');
    assert.equal(result.value.status, 'disabled');
    assert.equal(reads, 0);
});

test('MANAGED-REMOTE-SSH-COMMAND-001 opens and copies the endpoint without projection', async () => {
    const { envelope, slot } = activeEnvelope();
    const terminals = [];
    const copied = [];
    let reconciles = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return {
                async reconcile() { reconciles += 1; return {}; },
                getExecutable() { return '/usr/local/bin/ssh'; },
            };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal(options) { terminals.push(options); },
        async writeClipboard(value) { copied.push(value); },
    });
    const target = 'machine:one';
    const terminal = await controller.execute({
        ...request('openLocalSshTerminal', slot.revisionId),
        targetId: target,
    });
    const copy = await controller.execute({
        ...request('copyLocalSshCommand', slot.revisionId),
        targetId: target,
    });

    assert.equal(terminal.status, 'ok');
    assert.equal(copy.status, 'ok');
    assert.equal(reconciles, 0);
    assert.equal(terminals[0].name, 'SSH: Build');
    assert.equal(terminals[0].shellPath, '/usr/local/bin/ssh');
    assert.deepEqual(terminals[0].shellArgs, [
        '-p', '22', '-l', 'dev', 'build.example.com',
    ]);
    assert.equal(copied[0], formatManagedSshCommand(
        '/usr/local/bin/ssh', terminals[0].shellArgs, 'linux',
    ));
    assert.match(copied[0], /build\.example\.com/u);
});

test('MANAGED-REMOTE-NAVIGATION-001 resolves Machine and Project identities inside the UI host', async () => {
    const { envelope, slot } = activeEnvelope();
    const windows = [];
    const folders = [];
    const ensured = [];
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return { async reconcile() { throw new Error('action must not reconcile'); } };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal() {},
        async writeClipboard() {},
        async openRemoteWindow(authority) { windows.push(authority); },
        async openRemoteFolder(uri) { folders.push(uri); },
    }, {
        schedule() {},
        async ensureReady(value) { ensured.push(value.revisionId); },
    });
    const machine = await controller.execute({
        ...request('openManagedMachine', slot.revisionId),
        targetId: 'machine:one',
    });
    const project = await controller.execute({
        ...request('openManagedProject', slot.revisionId),
        targetId: 'project:one',
    });

    assert.equal(machine.status, 'ok');
    assert.equal(project.status, 'ok');
    assert.deepEqual(ensured, [slot.revisionId, slot.revisionId]);
    const alias = `build-${managedSshAliasSuffix('machine:one')}`;
    assert.equal(windows[0], `ssh-remote+${alias}`);
    assert.equal(
        folders[0],
        `vscode-remote://${encodeURIComponent(`ssh-remote+${alias}`)}/work/api`,
    );
    assert.doesNotMatch(`${windows[0]} ${folders[0]}`, /build\.example\.com|dev@/u);
});

test('FILE-TRANSFER-LOCAL-BROWSE-001 mints opaque local-root handles and never accepts paths', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-file-transfer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'folder'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello', 'utf8');
    let coordinatorCreates = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('local browsing must not read catalog'); },
    }, {
        async create() { coordinatorCreates += 1; return {}; },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal() {},
        async writeClipboard() {},
        async selectLocalDirectory() { return root; },
    });
    const selected = await controller.execute(request('selectFileTransferLocalRoot'));
    assert.equal(selected.status, 'ok');
    assert.equal(coordinatorCreates, 0);
    assert.equal(selected.value.label, path.basename(root));
    assert.equal(selected.value.displayPath, '.');
    assert.deepEqual(selected.value.entries.map(entry => [entry.name, entry.kind]), [
        ['folder', 'directory'], ['notes.txt', 'file'],
    ]);
    assert.doesNotMatch(JSON.stringify(selected.value), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const listed = await controller.execute({
        ...request('listFileTransferLocalDirectory'),
        fileTransfer: {
            kind: 'localRoot',
            rootId: selected.value.rootId,
            directoryId: selected.value.directoryId,
        },
    });
    assert.equal(listed.status, 'ok');
    assert.equal(listed.value.displayPath, '.');
    const rejected = await controller.execute({
        ...request('listFileTransferLocalDirectory'),
        fileTransfer: {
            kind: 'localRoot', rootId: selected.value.rootId, directoryId: '../outside',
        },
    });
    assert.equal(rejected.status, 'failed');

    const byPath = await controller.execute({
        ...request('listFileTransferLocalDirectory'),
        fileTransfer: { kind: 'localRoot', rootId: selected.value.rootId, path: 'folder' },
    });
    assert.equal(byPath.status, 'ok');
    assert.equal(byPath.value.displayPath, 'folder');
});

test('FILE-TRANSFER-LOCAL-BROWSE-002 binds selected file handles to the reviewed source directory', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-file-transfer-bound-entry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'child'));
    fs.writeFileSync(path.join(root, 'child', 'notes.txt'), 'hello', 'utf8');
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('local source validation must not read catalog'); },
    }, {
        async create() { return {}; },
    }, 'session-12345678', {
        platform: 'linux', openTerminal() {}, async writeClipboard() {},
        async selectLocalDirectory() { return root; },
    });
    const selected = await controller.execute(request('selectFileTransferLocalRoot'));
    const child = selected.value.entries.find(entry => entry.name === 'child');
    const nested = await controller.execute({
        ...request('listFileTransferLocalDirectory'),
        fileTransfer: { kind: 'localRoot', rootId: selected.value.rootId, directoryId: child.id },
    });
    const nestedFile = nested.value.entries.find(entry => entry.name === 'notes.txt');
    await assert.rejects(
        () => controller.resolveFileTransferSource(undefined, {
            kind: 'local', rootId: selected.value.rootId, directoryId: selected.value.directoryId,
        }, [nestedFile.id]),
        /current local directory/i,
    );
});

test('FILE-TRANSFER-COPY-001 rejects local-to-local copy even with approved handles', async t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-file-transfer-source-'));
    const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-file-transfer-destination-'));
    t.after(() => {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(destinationRoot, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(sourceRoot, 'report.txt'), 'safe', 'utf8');
    const selections = [sourceRoot, destinationRoot];
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('local copy must be rejected first'); },
    }, {
        async create() { return {}; },
    }, 'session-12345678', {
        platform: 'linux', openTerminal() {}, async writeClipboard() {},
        async selectLocalDirectory() { return selections.shift(); },
    });
    const source = await controller.execute(request('selectFileTransferLocalRoot'));
    const destination = await controller.execute(request('selectFileTransferLocalRoot'));
    const copy = await controller.execute({
        ...request('copyFileTransferEntries', `revision:${'a'.repeat(64)}`),
        fileTransfer: {
            kind: 'copy', taskId: 'task-123456789012', conflictPolicy: 'fail',
            source: {
                kind: 'local', rootId: source.value.rootId, directoryId: source.value.directoryId,
            },
            destination: {
                kind: 'local', rootId: destination.value.rootId, directoryId: destination.value.directoryId,
            },
            entryIds: [source.value.entries[0].id],
        },
    });
    assert.equal(copy.status, 'failed');
    assert.match(copy.message, /does not copy between two local folders/i);
});

test('FILE-TRANSFER-PREFLIGHT-001 rejects local-to-local review before catalog access', async () => {
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('local-to-local preflight must be rejected first'); },
    }, {
        async create() { throw new Error('local-to-local preflight must not create a coordinator'); },
    }, 'session-12345678');
    const result = await controller.execute({
        ...request('preflightFileTransfer', `revision:${'a'.repeat(64)}`),
        fileTransfer: {
            kind: 'preflight',
            source: { kind: 'local', rootId: 'a'.repeat(32), directoryId: 'b'.repeat(32) },
            destination: { kind: 'local', rootId: 'c'.repeat(32), directoryId: 'd'.repeat(32) },
            entryIds: ['e'.repeat(32)],
        },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /does not copy between two local folders/i);
});

test('FILE-TRANSFER-COPY-002 permits only one active relay copy in a UI Bridge session', async () => {
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('an active copy must be rejected before catalog access'); },
    }, {
        async create() { throw new Error('an active copy must be rejected before coordinator creation'); },
    }, 'session-12345678');
    controller.activeFileTransferCopies.set('running-task-123456', { cancelled: false });
    await assert.rejects(
        () => controller.copyFileTransferEntries(undefined, undefined, {
            kind: 'copy', taskId: 'new-task-123456789', conflictPolicy: 'fail', entryIds: ['a'.repeat(32)],
            source: { kind: 'local', rootId: 'b'.repeat(32), directoryId: 'c'.repeat(32) },
            destination: { kind: 'managedMachine', machineId: 'machine:one', directoryId: 'd'.repeat(32) },
        }),
        /another file transfer copy is already running/i,
    );
});

test('FILE-TRANSFER-COPY-002A exposes only a correlated redacted active-task snapshot', async () => {
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('progress must not read catalog authority'); },
    }, {
        async create() { throw new Error('progress must not create a coordinator'); },
    }, 'session-12345678');
    controller.activeFileTransferCopies.set('running-task-123456', {
        cancelled: false,
        phase: 'copying',
        currentItemName: 'report.txt',
        completedItems: 2,
        skippedItems: 1,
        totalItems: 5,
    });
    const running = await controller.execute({
        ...request('getFileTransferCopyStatus'),
        fileTransfer: { kind: 'status', taskId: 'running-task-123456' },
    });
    assert.deepEqual(running.value, {
        status: 'running', phase: 'copying', currentItemName: 'report.txt',
        completedItems: 2, skippedItems: 1, totalItems: 5,
    });
    const missing = await controller.execute({
        ...request('getFileTransferCopyStatus'),
        fileTransfer: { kind: 'status', taskId: 'missing-task-123456' },
    });
    assert.deepEqual(missing.value, { status: 'unknown' });
});

test('FILE-TRANSFER-COPY-003 retains SFTP file sizes for post-copy verification', () => {
    const entries = parseSftpLongListing(
        '-rw-r--r--    1 user     group          4096 Jan 01 2026 report.txt\n'
        + 'drwxr-xr-x    2 user     group          4096 Jan 01 2026 artifacts\n',
    );
    assert.deepEqual(entries, [
        { name: 'artifacts', kind: 'directory' },
        { name: 'report.txt', kind: 'file', size: 4096 },
    ]);
});

test('FILE-TRANSFER-COPY-003A retains hidden SFTP entries but omits dot navigation rows', () => {
    const entries = parseSftpLongListing(
        'drwxr-xr-x    2 user     group          4096 Jan 01 2026 .\n'
        + 'drwxr-xr-x    2 user     group          4096 Jan 01 2026 ..\n'
        + '-rw-r--r--    1 user     group            42 Jan 01 2026 .env\n',
    );
    assert.deepEqual(entries, [{ name: '.env', kind: 'file', size: 42 }]);
});

test('FILE-TRANSFER-COPY-004 stops active relay processes when the UI Bridge disposes', () => {
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return null; },
    }, {
        async create() { return {}; },
    }, 'session-12345678');
    let killed = 0;
    const active = { cancelled: false, process: { kill() { killed += 1; } } };
    controller.activeFileTransferCopies.set('running-task-123456', active);
    controller.dispose();
    assert.equal(active.cancelled, true);
    assert.equal(killed, 1);
});
