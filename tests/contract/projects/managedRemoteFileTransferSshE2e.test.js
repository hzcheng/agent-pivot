'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCausalVersion, createVersionedCandidates, joinVersionVectors, vectorIncludingVersion } = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createEmptyManagedCatalogEnvelope, createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const { managedSshAlias } = require('../../../out/projects/managedRemote/sshConfigProjection');
const {
    ManagedRemoteBridgeController,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemoteBridgeController');

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find(candidate => fs.existsSync(candidate));
const SSH_KEYGEN = ['/usr/bin/ssh-keygen', '/bin/ssh-keygen'].find(candidate => fs.existsSync(candidate));
const SKIP = {
    skip: process.platform !== 'linux' || !SSHD || !SSH_KEYGEN || !fs.existsSync('/usr/bin/scp')
        || !fs.existsSync('/usr/bin/sftp'),
};

function request(operation, revisionId, suffix) {
    return {
        protocolVersion: 1,
        requestId: `file-transfer-e2e-${suffix}-123456`,
        sessionToken: 'file-transfer-e2e-session',
        operation,
        ...(revisionId ? { expectedRevisionId: revisionId } : {}),
    };
}

function activeEnvelope(machines) {
    let sequence = 0;
    const catalog = ManagedRemoteCatalogService.create('file-transfer-e2e', prefix => `${prefix}:${++sequence}`);
    const added = machines.map(machine => catalog.addMachine(machine));
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const envelope = createEmptyManagedCatalogEnvelope('file-transfer-e2e-envelope');
    const version = createCausalVersion(envelope.causalContext, 'file-transfer-e2e-envelope');
    envelope.authority = createVersionedCandidates({ lifecycle: 'active', active: slot }, version);
    envelope.causalContext = joinVersionVectors(envelope.causalContext, vectorIncludingVersion(version));
    return { envelope, slot, machines: added };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(error => error ? reject(error) : resolve(address.port));
        });
    });
}

function waitForPort(port, process) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
            if (process.exitCode !== null) {
                reject(new Error(`Temporary sshd exited before accepting connections on ${port}.`));
                return;
            }
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => {
                socket.end();
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() >= deadline) {
                    reject(new Error(`Temporary sshd did not accept connections on ${port}.`));
                    return;
                }
                setTimeout(poll, 40);
            });
        };
        poll();
    });
}

function writeClientWrapper(root, binary, clientConfig) {
    const wrapper = path.join(root, 'bin', binary);
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "${binary}" = scp ] && [ -n "$AGENT_PIVOT_SCP_LOG" ]; then\n  printf '%s\\n' "$*" >> "$AGENT_PIVOT_SCP_LOG"\nfi\nif [ "${binary}" = scp ] && [ -n "$AGENT_PIVOT_SCP_SWAP_SOURCE" ]; then\n  rm -rf -- "$AGENT_PIVOT_SCP_SWAP_SOURCE"\n  ln -s -- "$AGENT_PIVOT_SCP_SWAP_TARGET" "$AGENT_PIVOT_SCP_SWAP_SOURCE"\nfi\nif [ "${binary}" = ssh ] && [ -n "$AGENT_PIVOT_SSH_PUBLISH_RACE_DESTINATION" ] && printf '%s' "$*" | grep -q 'mv -n'; then\n  mkdir -p -- "$AGENT_PIVOT_SSH_PUBLISH_RACE_DESTINATION"\nfi\nexec /usr/bin/${binary} -F "${clientConfig}" "$@"\n`, { mode: 0o700 });
    return wrapper;
}

async function startTemporarySshd(root, keyPath) {
    const port = await freePort();
    const hostKey = path.join(root, `host-${port}`);
    const authorizedKeys = path.join(root, `authorized-${port}`);
    const config = path.join(root, `sshd-${port}.conf`);
    childProcess.execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
    fs.copyFileSync(`${keyPath}.pub`, authorizedKeys);
    fs.writeFileSync(config, [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${hostKey}`,
        `PidFile ${path.join(root, `sshd-${port}.pid`)}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        'UsePAM no',
        'PasswordAuthentication no',
        'PubkeyAuthentication yes',
        'PermitRootLogin no',
        'StrictModes no',
        'UseDNS no',
        'Subsystem sftp internal-sftp',
    ].join('\n') + '\n', { mode: 0o600 });
    const process = childProcess.spawn(SSHD, ['-D', '-f', config, '-E', path.join(root, `sshd-${port}.log`)], {
        stdio: 'ignore',
    });
    try {
        await waitForPort(port, process);
    } catch (error) {
        if (process.exitCode === null) { process.kill(); }
        throw error;
    }
    return { port, process };
}

/**
 * Uses two temporary directories accessed through generated Managed Machine
 * aliases. The two servers are exposed on independent loopback ports, so this
 * proves that the UI Bridge relays through two independent SSH hops rather
 * than assuming remote peers can communicate directly.
 */
test('FILE-TRANSFER-SSH-E2E-001 relays local and managed files through real OpenSSH', SKIP, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-file-transfer-ssh-'));
    const scpLog = path.join(root, 'scp.log');
    const previousScpLog = process.env.AGENT_PIVOT_SCP_LOG;
    process.env.AGENT_PIVOT_SCP_LOG = scpLog;
    t.after(() => {
        if (previousScpLog === undefined) delete process.env.AGENT_PIVOT_SCP_LOG;
        else process.env.AGENT_PIVOT_SCP_LOG = previousScpLog;
    });
    const localRoot = path.join(root, 'local');
    const remoteOne = fs.mkdtempSync(path.join(os.homedir(), 'agent-pivot-file-transfer-ssh-one-'));
    const remoteTwo = fs.mkdtempSync(path.join(os.homedir(), 'agent-pivot-file-transfer-ssh-two-'));
    fs.mkdirSync(localRoot);
    fs.writeFileSync(path.join(localRoot, 'local.txt'), 'from local\n', 'utf8');
    const swappedLocalFile = 'swap-protected.txt';
    const swappedLocalPath = path.join(localRoot, swappedLocalFile);
    const outsideSwapTarget = path.join(root, 'outside-swap-target.txt');
    fs.writeFileSync(swappedLocalPath, 'approved before swap\n', 'utf8');
    fs.writeFileSync(outsideSwapTarget, 'private after swap\n', 'utf8');
    fs.chmodSync(path.join(localRoot, 'local.txt'), 0o751);
    fs.utimesSync(path.join(localRoot, 'local.txt'), new Date('2023-05-06T07:08:09.000Z'), new Date('2023-05-06T07:08:09.000Z'));
    const localSpecialFile = "-local #?% '雪.txt";
    fs.writeFileSync(path.join(localRoot, localSpecialFile), 'from local special file\n', 'utf8');
    const maximumLengthLocalFile = 'x'.repeat(255);
    fs.writeFileSync(path.join(localRoot, maximumLengthLocalFile), 'maximum-length filename\n', 'utf8');
    const localConflictFile = 'already-there.txt';
    fs.writeFileSync(path.join(localRoot, localConflictFile), 'from local conflict file\n', 'utf8');
    fs.mkdirSync(path.join(localRoot, 'local folder'));
    fs.writeFileSync(path.join(localRoot, 'local folder', 'nested.txt'), 'from local folder\n', 'utf8');
    fs.mkdirSync(path.join(localRoot, 'publish-race-folder'));
    fs.writeFileSync(path.join(localRoot, 'publish-race-folder', 'nested.txt'), 'must not land inside a concurrent folder\n', 'utf8');
    fs.mkdirSync(path.join(localRoot, 'parent-swap'));
    fs.writeFileSync(path.join(localRoot, 'parent-swap', 'approved.txt'), 'approved before parent swap\n', 'utf8');
    const outsideParentSwap = path.join(root, 'outside-parent-swap');
    fs.mkdirSync(outsideParentSwap);
    fs.writeFileSync(path.join(outsideParentSwap, 'approved.txt'), 'private after parent swap\n', 'utf8');
    fs.mkdirSync(path.join(localRoot, 'empty-directory-conflict'));
    fs.writeFileSync(path.join(localRoot, 'empty-directory-conflict', 'nested.txt'), 'must not replace an empty directory\n', 'utf8');
    fs.mkdirSync(path.join(remoteTwo, 'empty-directory-conflict'));
    fs.mkdirSync(path.join(localRoot, 'folder with relative link'));
    fs.symlinkSync('../local.txt', path.join(localRoot, 'folder with relative link', 'link'));
    const remoteSpecialFile = "-machine #?% '雪.txt";
    fs.writeFileSync(path.join(remoteOne, remoteSpecialFile), 'from first machine\n', 'utf8');
    const remoteFolder = 'streamed remote folder';
    fs.mkdirSync(path.join(remoteOne, remoteFolder));
    fs.mkdirSync(path.join(remoteOne, remoteFolder, 'nested'));
    fs.writeFileSync(path.join(remoteOne, remoteFolder, 'nested', 'relay.txt'), 'streamed folder\n', 'utf8');
    fs.mkdirSync(path.join(remoteOne, 'remote folder with relative link'));
    fs.symlinkSync(`../${remoteSpecialFile}`, path.join(remoteOne, 'remote folder with relative link', 'link'));
    const keyPath = path.join(root, 'client');
    childProcess.execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
    const servers = [];
    t.after(async () => {
        for (const server of servers) {
            if (server.process.exitCode === null) {
                server.process.kill();
                await new Promise(resolve => server.process.once('exit', resolve));
            }
        }
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(remoteOne, { recursive: true, force: true });
        await fsp.rm(remoteTwo, { recursive: true, force: true });
    });
    const firstServer = await startTemporarySshd(root, keyPath);
    servers.push(firstServer);
    const secondServer = await startTemporarySshd(root, keyPath);
    servers.push(secondServer);

    const user = os.userInfo().username;
    const { envelope, slot, machines } = activeEnvelope([
        { name: 'Relay Source', host: '127.0.0.1', user, port: firstServer.port },
        { name: 'Relay Destination', host: '127.0.0.1', user, port: secondServer.port },
    ]);
    const clientConfig = path.join(root, 'ssh-client.conf');
    fs.writeFileSync(clientConfig, machines.map(machine => [
        `Host ${managedSshAlias(machine.id, machine.name, machine.connection.host)}`,
        '    HostName 127.0.0.1',
        `    Port ${machine.connection.port}`,
        `    User ${user}`,
        `    IdentityFile ${keyPath}`,
        '    BatchMode yes',
        '    StrictHostKeyChecking no',
        '    UserKnownHostsFile /dev/null',
    ].join('\n')).join('\n\n') + '\n', { mode: 0o600 });
    const ssh = writeClientWrapper(root, 'ssh', clientConfig);
    writeClientWrapper(root, 'scp', clientConfig);
    writeClientWrapper(root, 'sftp', clientConfig);
    fs.writeFileSync(path.join(root, 'bin', 'mv'), `#!/bin/sh
if [ -n "$AGENT_PIVOT_LOCAL_PUBLISH_RACE_DESTINATION" ]; then
  mkdir -p -- "$AGENT_PIVOT_LOCAL_PUBLISH_RACE_DESTINATION"
fi
exec /bin/mv "$@"
`, { mode: 0o700 });
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return { getExecutable() { return ssh; } };
        },
    }, 'file-transfer-e2e-session', {
        platform: 'linux', openTerminal() {}, async writeClipboard() {},
        async defaultLocalDirectory() { return localRoot; },
    }, {
        schedule() {}, async ensureReady() {},
    });

    const local = await controller.execute(request('selectFileTransferLocalRoot', undefined, 'local'));
    assert.equal(local.status, 'ok');
    const parentSwapDirectory = local.value.entries.find(entry => entry.name === 'parent-swap');
    assert.ok(parentSwapDirectory);
    const parentSwapListing = await controller.execute({
        ...request('listFileTransferLocalDirectory', undefined, 'parent-swap-list'),
        fileTransfer: { kind: 'localRoot', rootId: local.value.rootId, directoryId: parentSwapDirectory.id },
    });
    assert.equal(parentSwapListing.status, 'ok', parentSwapListing.message);
    const parentSwapFile = parentSwapListing.value.entries.find(entry => entry.name === 'approved.txt');
    assert.ok(parentSwapFile);
    const sourceRoot = await controller.execute({
        ...request('listFileTransferRemoteDirectory', slot.revisionId, 'source-list'),
        targetId: machines[0].id,
        fileTransfer: { kind: 'managedMachine' },
    });
    const destinationRoot = await controller.execute({
        ...request('listFileTransferRemoteDirectory', slot.revisionId, 'destination-list'),
        targetId: machines[1].id,
        fileTransfer: { kind: 'managedMachine' },
    });
    const sourceByAbsolutePath = await controller.execute({
        ...request('listFileTransferRemoteDirectory', slot.revisionId, 'source-path'),
        targetId: machines[0].id,
        fileTransfer: { kind: 'managedMachine', path: remoteOne },
    });
    assert.equal(sourceRoot.status, 'ok', sourceRoot.message);
    assert.equal(destinationRoot.status, 'ok', destinationRoot.message);
    assert.equal(sourceByAbsolutePath.status, 'ok', sourceByAbsolutePath.message);
    assert.equal(sourceRoot.value.displayPath, os.homedir(),
        'FILE-TRANSFER-REMOTE-BROWSE-003 must open a Managed Machine at its authenticated login home');
    assert.equal(destinationRoot.value.displayPath, os.homedir(),
        'FILE-TRANSFER-REMOTE-BROWSE-003 must open the target at its authenticated login home');
    assert.equal(sourceByAbsolutePath.value.displayPath, remoteOne);
    assert.ok(sourceByAbsolutePath.value.entries.some(entry => entry.name === remoteSpecialFile));
    const sourceDirectory = sourceRoot.value.entries.find(entry => entry.name === path.basename(remoteOne));
    const destinationDirectory = destinationRoot.value.entries.find(entry => entry.name === path.basename(remoteTwo));
    assert.ok(sourceDirectory);
    assert.ok(destinationDirectory);
    const source = await controller.execute({
        ...request('listFileTransferRemoteDirectory', slot.revisionId, 'source-directory'),
        targetId: machines[0].id,
        fileTransfer: { kind: 'managedMachine', directoryId: sourceDirectory.id },
    });
    const destination = await controller.execute({
        ...request('listFileTransferRemoteDirectory', slot.revisionId, 'destination-directory'),
        targetId: machines[1].id,
        fileTransfer: { kind: 'managedMachine', directoryId: destinationDirectory.id },
    });
    assert.equal(source.status, 'ok', source.message);
    assert.equal(destination.status, 'ok', destination.message);
    const linkedRemoteFolder = source.value.entries.find(entry => entry.name === 'remote folder with relative link');
    const localFile = local.value.entries.find(entry => entry.name === 'local.txt');
    const swapProtectedLocal = local.value.entries.find(entry => entry.name === swappedLocalFile);
    const localSpecial = local.value.entries.find(entry => entry.name === localSpecialFile);
    const maximumLengthLocal = local.value.entries.find(entry => entry.name === maximumLengthLocalFile);
    const localConflict = local.value.entries.find(entry => entry.name === localConflictFile);
    const localFolder = local.value.entries.find(entry => entry.name === 'local folder');
    const publishRaceFolder = local.value.entries.find(entry => entry.name === 'publish-race-folder');
    const emptyDirectoryConflict = local.value.entries.find(entry => entry.name === 'empty-directory-conflict');
    const linkedLocalFolder = local.value.entries.find(entry => entry.name === 'folder with relative link');
    const remoteFile = source.value.entries.find(entry => entry.name === remoteSpecialFile);
    const remoteFolderEntry = source.value.entries.find(entry => entry.name === remoteFolder);
    assert.ok(localFile);
    assert.ok(swapProtectedLocal);
    assert.ok(localSpecial);
    assert.ok(maximumLengthLocal);
    assert.ok(localConflict);
    assert.ok(localFolder);
    assert.ok(publishRaceFolder);
    assert.ok(emptyDirectoryConflict);
    assert.ok(linkedLocalFolder);
    assert.ok(linkedRemoteFolder);
    assert.ok(remoteFile);
    assert.ok(remoteFolderEntry);
    assert.equal(Number.isSafeInteger(remoteFile.modifiedAt), true);

    const linkedLocalPreflight = await controller.execute({
        ...request('preflightFileTransfer', slot.revisionId, 'linked-local-preflight'),
        fileTransfer: {
            kind: 'preflight',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [linkedLocalFolder.id],
        },
    });
    assert.equal(linkedLocalPreflight.status, 'ok', linkedLocalPreflight.message);
    assert.equal(controller.reviewedFileTransferTrees.size, 1,
        'FILE-TRANSFER-COPY-008 must retain one bounded local safety manifest for the immediate copy');
    const copiedLinkedLocalFolder = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'linked-local-folder-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-linked-local-folder', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [linkedLocalFolder.id],
        },
    });
    assert.equal(copiedLinkedLocalFolder.status, 'ok', copiedLinkedLocalFolder.message);
    const copiedLocalLink = fs.lstatSync(path.join(remoteTwo, 'folder with relative link', 'link'));
    assert.equal(copiedLinkedLocalFolder.value.status, 'copied', JSON.stringify({
        result: copiedLinkedLocalFolder.value, isLink: copiedLocalLink.isSymbolicLink(),
        target: copiedLocalLink.isSymbolicLink() ? fs.readlinkSync(path.join(remoteTwo, 'folder with relative link', 'link')) : undefined,
    }));
    assert.equal(copiedLocalLink.isSymbolicLink(), true,
        'FILE-TRANSFER-COPY-009 must preserve a relative symlink inside a transferred local folder');
    assert.equal(fs.readlinkSync(path.join(remoteTwo, 'folder with relative link', 'link')), '../local.txt');
    assert.equal(controller.reviewedFileTransferTrees.size, 0,
        'FILE-TRANSFER-COPY-008 must consume the local safety manifest after the copy settles');

    const linkedRemotePreflight = await controller.execute({
        ...request('preflightFileTransfer', slot.revisionId, 'linked-remote-preflight'),
        fileTransfer: {
            kind: 'preflight',
            source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [linkedRemoteFolder.id],
        },
    });
    assert.equal(linkedRemotePreflight.status, 'ok', linkedRemotePreflight.message);
    const copiedLinkedRemoteFolder = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'linked-remote-folder-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-linked-remote-folder', conflictPolicy: 'fail',
            source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [linkedRemoteFolder.id],
        },
    });
    assert.equal(copiedLinkedRemoteFolder.status, 'ok', copiedLinkedRemoteFolder.message);
    assert.equal(copiedLinkedRemoteFolder.value.status, 'copied', JSON.stringify(copiedLinkedRemoteFolder.value));
    assert.equal(fs.lstatSync(path.join(remoteTwo, 'remote folder with relative link', 'link')).isSymbolicLink(), true,
        'FILE-TRANSFER-COPY-009 must preserve a relative symlink inside a relayed Managed Machine folder');
    assert.equal(fs.readlinkSync(path.join(remoteTwo, 'remote folder with relative link', 'link')), `../${remoteSpecialFile}`);

    const copiedLocal = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'local-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-local-copy', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [localFile.id], targetName: 'renamed-local.txt',
        },
    });
    assert.equal(copiedLocal.status, 'ok', copiedLocal.message);
    assert.deepEqual(copiedLocal.value, { status: 'copied', completedItems: 1, skippedItems: 0, totalItems: 1 });
    assert.equal(fs.readFileSync(path.join(remoteTwo, 'renamed-local.txt'), 'utf8'), 'from local\n');
    const copiedLocalStat = fs.statSync(path.join(remoteTwo, 'renamed-local.txt'));
    assert.equal(copiedLocalStat.mode & 0o777, 0o751);
    assert.ok(Math.abs(copiedLocalStat.mtimeMs - new Date('2023-05-06T07:08:09.000Z').getTime()) < 1_000);
    assert.match(fs.readFileSync(scpLog, 'utf8'), /\.agent-pivot-transfer-[a-f0-9]{24}/u,
        'FILE-TRANSFER-SSH-E2E-001 must stream into an opaque sibling before publishing a verified target');
    assert.match(fs.readFileSync(scpLog, 'utf8'), /\/proc\/self\/fd\/3/u,
        'FILE-TRANSFER-LOCAL-SAFETY-001 must pass a stable local descriptor to scp, not re-open the selected path');

    // The scp wrapper replaces the selected pathname immediately before it
    // execs the real client. The child inherited fd 3 still refers to the
    // approved inode, proving a post-validation symlink swap cannot escape
    // the local-root boundary.
    process.env.AGENT_PIVOT_SCP_SWAP_SOURCE = swappedLocalPath;
    process.env.AGENT_PIVOT_SCP_SWAP_TARGET = outsideSwapTarget;
    try {
        const copiedSwappedLocal = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'local-symlink-swap'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-local-symlink-swap', conflictPolicy: 'fail',
                source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [swapProtectedLocal.id], targetName: 'swap-protected-copy.txt',
            },
        });
        assert.equal(copiedSwappedLocal.status, 'ok', copiedSwappedLocal.message);
        assert.equal(copiedSwappedLocal.value.status, 'copied', JSON.stringify(copiedSwappedLocal.value));
    } finally {
        delete process.env.AGENT_PIVOT_SCP_SWAP_SOURCE;
        delete process.env.AGENT_PIVOT_SCP_SWAP_TARGET;
    }
    assert.equal(fs.readFileSync(path.join(remoteTwo, 'swap-protected-copy.txt'), 'utf8'), 'approved before swap\n',
        'FILE-TRANSFER-LOCAL-SAFETY-001 must copy the selected descriptor, not the replacement symlink target');

    process.env.AGENT_PIVOT_SCP_SWAP_SOURCE = path.join(localRoot, 'parent-swap');
    process.env.AGENT_PIVOT_SCP_SWAP_TARGET = outsideParentSwap;
    try {
        const copiedParentSwappedLocal = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'local-parent-symlink-swap'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-local-parent-symlink-swap', conflictPolicy: 'fail',
                source: { kind: 'local', rootId: local.value.rootId, directoryId: parentSwapListing.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [parentSwapFile.id], targetName: 'parent-swap-copy.txt',
            },
        });
        assert.equal(copiedParentSwappedLocal.status, 'ok', copiedParentSwappedLocal.message);
        assert.equal(copiedParentSwappedLocal.value.status, 'copied', JSON.stringify(copiedParentSwappedLocal.value));
    } finally {
        delete process.env.AGENT_PIVOT_SCP_SWAP_SOURCE;
        delete process.env.AGENT_PIVOT_SCP_SWAP_TARGET;
    }
    assert.equal(fs.readFileSync(path.join(remoteTwo, 'parent-swap-copy.txt'), 'utf8'), 'approved before parent swap\n',
        'FILE-TRANSFER-LOCAL-SAFETY-001 must keep every parent descriptor beneath the approved root stable');

    const copiedSpecialLocal = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'local-special-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-local-special', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [localSpecial.id],
        },
    });
    assert.equal(copiedSpecialLocal.status, 'ok', copiedSpecialLocal.message);
    assert.equal(fs.readFileSync(path.join(remoteTwo, localSpecialFile), 'utf8'), 'from local special file\n');

    const copiedMaximumLengthLocal = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'maximum-length-local-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-maximum-length-local', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [maximumLengthLocal.id],
        },
    });
    assert.equal(copiedMaximumLengthLocal.status, 'ok', copiedMaximumLengthLocal.message);
    assert.equal(copiedMaximumLengthLocal.value.status, 'copied', JSON.stringify(copiedMaximumLengthLocal.value));
    assert.equal(fs.readFileSync(path.join(remoteTwo, maximumLengthLocalFile), 'utf8'), 'maximum-length filename\n',
        'FILE-TRANSFER-COPY-011 must use a bounded sibling staging name for valid 255-byte targets');

    const copiedConflictLocal = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'local-conflict-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-local-conflict', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [localConflict.id],
        },
    });
    assert.equal(copiedConflictLocal.status, 'ok', copiedConflictLocal.message);
    assert.equal(fs.readFileSync(path.join(remoteTwo, localConflictFile), 'utf8'), 'from local conflict file\n');

    const partialFailure = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'partial-failure'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-partial-failure', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [localFile.id, localConflict.id],
        },
    });
    assert.equal(partialFailure.status, 'ok', partialFailure.message);
    assert.deepEqual(partialFailure.value, {
        status: 'failed', completedItems: 1, skippedItems: 0, totalItems: 2,
        message: `Copy target already exists: ${localConflictFile}. Choose another folder or select a conflict policy.`,
        diagnostic: { phase: 'preparing', hop: 'source-to-target', code: 'unknown' },
    });
    assert.equal(fs.readFileSync(path.join(remoteTwo, 'local.txt'), 'utf8'), 'from local\n');

    const emptyDirectoryCollision = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'empty-directory-collision'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-empty-directory-collision', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [emptyDirectoryConflict.id],
        },
    });
    assert.equal(emptyDirectoryCollision.status, 'ok', emptyDirectoryCollision.message);
    assert.deepEqual(emptyDirectoryCollision.value, {
        status: 'failed', completedItems: 0, skippedItems: 0, totalItems: 1,
        message: 'Copy target already exists: empty-directory-conflict. Choose another folder or select a conflict policy.',
        diagnostic: { phase: 'preparing', hop: 'source-to-target', code: 'unknown' },
    });

    const copiedFolder = await controller.execute({
        ...request('copyFileTransferEntries', slot.revisionId, 'local-folder-copy'),
        fileTransfer: {
            kind: 'copy', taskId: 'file-transfer-e2e-local-folder', conflictPolicy: 'fail',
            source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
            destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
            entryIds: [localFolder.id],
        },
    });
    assert.equal(copiedFolder.status, 'ok', copiedFolder.message);
    assert.deepEqual(copiedFolder.value, { status: 'copied', completedItems: 1, skippedItems: 0, totalItems: 1 });
    assert.equal(fs.readFileSync(path.join(remoteTwo, 'local folder', 'nested.txt'), 'utf8'), 'from local folder\n');

    // Simulate another actor creating the final folder after the collision
    // check but immediately before publication. `mv -Tn` must reject that
    // race rather than nesting the verified staging folder inside it and
    // reporting a false success.
    const publishRaceDestination = path.join(remoteTwo, 'publish-race-folder');
    process.env.AGENT_PIVOT_SSH_PUBLISH_RACE_DESTINATION = publishRaceDestination;
    try {
        const racedFolderCopy = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'folder-publish-race'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-folder-publish-race', conflictPolicy: 'fail',
                source: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [publishRaceFolder.id],
            },
        });
        assert.equal(racedFolderCopy.status, 'ok', racedFolderCopy.message);
        assert.equal(racedFolderCopy.value.status, 'failed', JSON.stringify(racedFolderCopy.value));
    } finally {
        delete process.env.AGENT_PIVOT_SSH_PUBLISH_RACE_DESTINATION;
    }
    assert.equal(fs.existsSync(path.join(publishRaceDestination, 'publish-race-folder')), false,
        'FILE-TRANSFER-COPY-010 must not nest a staged folder inside a concurrent destination');
    assert.equal(fs.existsSync(path.join(publishRaceDestination, 'nested.txt')), false,
        'FILE-TRANSFER-COPY-010 must not report an unrelated concurrent destination as copied');

    const localPublishRaceDestination = path.join(localRoot, 'local-publish-race.txt');
    const previousPath = process.env.PATH;
    process.env.AGENT_PIVOT_LOCAL_PUBLISH_RACE_DESTINATION = localPublishRaceDestination;
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${previousPath || ''}`;
    try {
        const racedLocalPublication = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'local-publish-race'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-local-publish-race', conflictPolicy: 'fail',
                source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
                destination: { kind: 'local', rootId: local.value.rootId, directoryId: local.value.directoryId },
                entryIds: [remoteFile.id], targetName: 'local-publish-race.txt',
            },
        });
        assert.equal(racedLocalPublication.status, 'ok', racedLocalPublication.message);
        assert.equal(racedLocalPublication.value.status, 'failed', JSON.stringify(racedLocalPublication.value));
    } finally {
        delete process.env.AGENT_PIVOT_LOCAL_PUBLISH_RACE_DESTINATION;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
    }
    assert.deepEqual(fs.readdirSync(localPublishRaceDestination), [],
        'FILE-TRANSFER-COPY-010 must not publish a staging item inside a concurrent local directory');

    const blockedRelayDirectory = path.join(root, 'blocked-relay-directory');
    fs.mkdirSync(blockedRelayDirectory, { mode: 0o500 });
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = blockedRelayDirectory;
    const scpCallCountBeforeRelay = fs.readFileSync(scpLog, 'utf8').trim().split('\n').filter(Boolean).length;
    let copiedRelay;
    let copiedRelayFolder;
    try {
        const reviewedRelayFolder = await controller.execute({
            ...request('preflightFileTransfer', slot.revisionId, 'reviewed-remote-relay-folder'),
            fileTransfer: {
                kind: 'preflight',
                source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [remoteFolderEntry.id],
            },
        });
        assert.equal(reviewedRelayFolder.status, 'ok', reviewedRelayFolder.message);
        assert.equal(reviewedRelayFolder.value.unknownSizeItems, 1,
            'FILE-TRANSFER-PREFLIGHT-005 must return one valid unknown-size folder review item');
        assert.equal(controller.reviewedFileTransferTrees.size, 0,
            'FILE-TRANSFER-PREFLIGHT-005 must not recursively walk a Managed Machine folder before copying it');
        copiedRelay = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'remote-relay'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-remote-relay', conflictPolicy: 'fail',
                source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [remoteFile.id],
            },
        });
        copiedRelayFolder = await controller.execute({
            ...request('copyFileTransferEntries', slot.revisionId, 'remote-relay-folder'),
            fileTransfer: {
                kind: 'copy', taskId: 'file-transfer-e2e-remote-relay-folder', conflictPolicy: 'fail',
                source: { kind: 'managedMachine', machineId: machines[0].id, directoryId: source.value.directoryId },
                destination: { kind: 'managedMachine', machineId: machines[1].id, directoryId: destination.value.directoryId },
                entryIds: [remoteFolderEntry.id],
            },
        });
        assert.equal(controller.reviewedFileTransferTrees.size, 0,
            'FILE-TRANSFER-COPY-008 must consume the reviewed tree rather than retaining stale remote paths');
    } finally {
        if (previousTmpDir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpDir;
    }
    assert.equal(copiedRelay.status, 'ok', copiedRelay.message);
    assert.deepEqual(copiedRelay.value, { status: 'copied', completedItems: 1, skippedItems: 0, totalItems: 1 });
    assert.equal(fs.readFileSync(path.join(remoteTwo, remoteSpecialFile), 'utf8'), 'from first machine\n');
    assert.equal(copiedRelayFolder.status, 'ok', copiedRelayFolder.message);
    assert.deepEqual(copiedRelayFolder.value, { status: 'copied', completedItems: 1, skippedItems: 0, totalItems: 1 });
    assert.equal(fs.readFileSync(path.join(remoteTwo, remoteFolder, 'nested', 'relay.txt'), 'utf8'), 'streamed folder\n');
    const scpCalls = fs.readFileSync(scpLog, 'utf8').trim().split('\n');
    const relayCalls = scpCalls.filter(Boolean).slice(scpCallCountBeforeRelay);
    const sourceAlias = managedSshAlias(machines[0].id, machines[0].name, machines[0].connection.host);
    const destinationAlias = managedSshAlias(machines[1].id, machines[1].name, machines[1].connection.host);
    assert.equal(relayCalls.length, 1,
        'FILE-TRANSFER-STREAMING-001 must relay the selected remote file without staging it locally');
    for (const relayCall of relayCalls) {
        assert.match(relayCall, /(?:^|\s)-3(?:\s|$)/u,
            'the relay must force OpenSSH to stream remote-to-remote data through the UI Bridge');
        assert.match(relayCall, /(?:^|\s)-o\s+BatchMode=yes(?:\s|$)/u,
            'FILE-TRANSFER-COPY-007 must fail rather than wait for an interactive SSH prompt');
        assert.match(relayCall, /(?:^|\s)-o\s+ConnectTimeout=20(?:\s|$)/u,
            'FILE-TRANSFER-COPY-007 must bound an unreachable SSH connection');
        assert.match(relayCall, /(?:^|\s)-o\s+ServerAliveInterval=15(?:\s|$)/u,
            'FILE-TRANSFER-COPY-007 must detect a dead stream before the 24-hour copy deadline');
        assert.match(relayCall, new RegExp(`${sourceAlias}:`));
        assert.match(relayCall, new RegExp(`${destinationAlias}:`));
    }
});
