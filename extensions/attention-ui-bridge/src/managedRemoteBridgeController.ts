'use strict';

import { createHash, randomBytes } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { lstat, opendir, realpath, stat } from 'fs/promises';
import * as path from 'path';
import { readManagedActiveRevisionSlot } from '../../../src/projects/managedRemote/envelope';
import {
    FileTransferDirectoryEntry,
    FileTransferLocalRootRequest,
    FileTransferRemoteDirectoryRequest,
    FileTransferCopyRequest,
    FileTransferCopyResult,
    FileTransferEndpointReference,
    FileTransferLocalRootResponse,
    ManagedRemoteBridgeRequest,
    ManagedRemoteBridgeResponse,
    MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
    parseManagedRemoteBridgeRequest,
} from '../../../src/projects/managedRemote/bridgeProtocol';
import { ManagedRevisionSlot } from '../../../src/projects/managedRemote/types';
import { materializeManagedRemoteCatalog } from '../../../src/projects/managedRemote/merge';
import {
    managedSshArguments,
    resolveManagedEnvironmentTarget,
    resolveManagedMachineTarget,
    resolveManagedProjectTarget,
} from '../../../src/projects/managedRemote/targetResolver';
import { ManagedSshConsentCoordinator } from './managedSshConsentCoordinator';

export interface ManagedRemoteBridgeCatalogReader {
    readManagedCatalogEnvelope(): unknown;
}

export interface ManagedRemoteBridgeCoordinatorFactory {
    create(): Promise<ManagedSshConsentCoordinator>;
}

export interface ManagedRemoteBridgeProjection {
    schedule(slot: ManagedRevisionSlot): void;
    ensureReady(slot: ManagedRevisionSlot): Promise<void>;
}

export interface ManagedRemoteBridgeLocalActions {
    platform: NodeJS.Platform;
    openTerminal(options: {
        name: string;
        shellPath: string;
        shellArgs: string[];
    }): Promise<void> | void;
    writeClipboard(value: string): Promise<void> | Thenable<void>;
    openRemoteWindow(remoteAuthority: string): Promise<void> | Thenable<void>;
    openRemoteFolder(uri: string): Promise<void> | Thenable<void>;
    inspectLegacySshTarget(
        executable: string,
        activeConfigPath: string,
        target: string,
    ): Promise<unknown>;
    selectLocalDirectory(): Promise<string | undefined>;
}

interface FileTransferLocalRoot {
    path: string;
    label: string;
    directories: Map<string, string>;
    entries: Map<string, FileTransferEntry>;
}

interface FileTransferEntry {
    path: string;
    kind: FileTransferDirectoryEntry['kind'];
    size?: number;
}

interface FileTransferRemoteDirectory extends FileTransferEntry {
    machineId: string;
    path: string;
}

interface ActiveFileTransferCopy {
    cancelled: boolean;
    process?: ChildProcess;
}

export function formatManagedSshCommand(
    executable: string,
    args: string[],
    platform: NodeJS.Platform,
): string {
    if (platform === 'win32') {
        const quote = (value: string) => `"${value
            .replace(/(\\*)"/gu, '$1$1\\"')
            .replace(/(\\+)$/gu, '$1$1')}"`;
        return [executable, ...args].map(quote).join(' ');
    }
    const quote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;
    return [executable, ...args].map(quote).join(' ');
}

function response(
    requestId: string,
    status: ManagedRemoteBridgeResponse['status'],
    value: unknown,
): ManagedRemoteBridgeResponse {
    return status === 'ok'
        ? { protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION, requestId, status, value }
        : {
            protocolVersion: MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
            requestId,
            status,
            message: value instanceof Error ? value.message : String(value),
        };
}

function activeSlot(value: unknown): ManagedRevisionSlot | null {
    return readManagedActiveRevisionSlot(value);
}

function sanitizeLocalResult(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(sanitizeLocalResult); }
    if (!value || typeof value !== 'object') { return value; }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if ([
            'candidateConfigContent',
            'currentConfigContent',
            'dependencyFingerprint',
            'projection',
        ].includes(key)) {
            continue;
        }
        result[key] = sanitizeLocalResult(child);
    }
    return result;
}

function authorityFromRemoteUri(uri: string): string {
    const prefix = 'vscode-remote://';
    const remainder = uri.slice(prefix.length);
    return decodeURIComponent(remainder.slice(0, remainder.indexOf('/')));
}

interface RemoteDirectoryRow {
    name: string;
    kind: FileTransferDirectoryEntry['kind'];
    size?: number;
}

function machineIdToTransferRootId(machineId: string): string {
    return createHash('sha256').update(machineId, 'utf8').digest('hex').slice(0, 32);
}

function remoteChildPath(parent: string, name: string): string {
    return parent === '.' ? `./${name}` : `${parent}/${name}`;
}

function quoteSftpPath(value: string): string {
    return `"${value.replace(/([\\"])/gu, '\\$1')}"`;
}

function listRemoteDirectory(
    sshExecutable: string,
    alias: string,
    directoryPath: string,
): Promise<RemoteDirectoryRow[]> {
    const sftpExecutable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'sftp.exe' : 'sftp');
    return new Promise((resolve, reject) => {
        const process = spawn(sftpExecutable, ['-b', '-', alias], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        process.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        process.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        process.on('error', error => reject(new Error(`Could not start SFTP: ${error.message}`)));
        process.on('close', code => {
            if (code !== 0) {
                const message = Buffer.concat(stderr).toString('utf8').trim();
                reject(new Error(message ? `Could not read remote directory: ${message.slice(0, 320)}`
                    : 'Could not read remote directory.'));
                return;
            }
            try {
                resolve(parseSftpLongListing(Buffer.concat(stdout).toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
        process.stdin.end(`ls -l ${quoteSftpPath(directoryPath)}\n`);
    });
}

function remotePathExists(
    sshExecutable: string,
    alias: string,
    targetPath: string,
): Promise<boolean> {
    const sftpExecutable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'sftp.exe' : 'sftp');
    return new Promise((resolve, reject) => {
        const process = spawn(sftpExecutable, ['-b', '-', alias], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        process.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        process.on('error', error => reject(new Error(`Could not start SFTP: ${error.message}`)));
        process.on('close', code => {
            if (code !== 0) {
                reject(new Error('Could not inspect the remote copy destination.'));
                return;
            }
            const output = Buffer.concat(stdout).toString('utf8');
            resolve(/^[-bcdlps][rwxStTs-]{9}\s/mu.test(output));
        });
        // The leading dash keeps a missing path from failing the whole batch.
        process.stdin.end(`-ls -ld ${quoteSftpPath(targetPath)}\n`);
    });
}

async function localPathExists(targetPath: string): Promise<boolean> {
    try {
        await lstat(targetPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
        throw error;
    }
}

async function localFileSize(targetPath: string): Promise<number> {
    const details = await stat(targetPath);
    if (!details.isFile()) {
        throw new Error('The copied local target is not a regular file.');
    }
    return details.size;
}

function remoteFileSize(
    sshExecutable: string,
    alias: string,
    targetPath: string,
): Promise<number> {
    const sftpExecutable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'sftp.exe' : 'sftp');
    return new Promise((resolve, reject) => {
        const process = spawn(sftpExecutable, ['-b', '-', alias], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        process.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        process.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        process.on('error', error => reject(new Error(`Could not start SFTP: ${error.message}`)));
        process.on('close', code => {
            if (code !== 0) {
                const message = Buffer.concat(stderr).toString('utf8').trim();
                reject(new Error(message ? `Could not verify remote file size: ${message.slice(0, 320)}`
                    : 'Could not verify remote file size.'));
                return;
            }
            const entry = parseSftpLongListing(Buffer.concat(stdout).toString('utf8'))[0];
            if (!entry || entry.kind !== 'file' || !Number.isSafeInteger(entry.size)) {
                reject(new Error('Could not verify remote file size.'));
                return;
            }
            resolve(entry.size);
        });
        process.stdin.end(`ls -l ${quoteSftpPath(targetPath)}\n`);
    });
}

export function parseSftpLongListing(output: string): RemoteDirectoryRow[] {
    const rows: RemoteDirectoryRow[] = [];
    for (const line of output.split(/\r?\n/u)) {
        if (!line || /^sftp>\s*/u.test(line) || /^Connected to /u.test(line)) { continue; }
        const match = /^([bcdlps-])[rwxStTs-]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d\d:\d\d|\d{4})\s+(.+)$/u.exec(line);
        if (!match) { continue; }
        const name = match[3];
        if (name === '.' || name === '..' || name.length > 255 || /[\0\r\n]/u.test(name)) { continue; }
        rows.push({
            name,
            kind: match[1] === 'd' ? 'directory' : match[1] === 'l' ? 'symlink'
                : match[1] === '-' ? 'file' : 'unsupported',
            ...(match[1] === '-' ? { size: Number(match[2]) } : {}),
        });
    }
    rows.sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') { return -1; }
        if (left.kind !== 'directory' && right.kind === 'directory') { return 1; }
        return left.name.localeCompare(right.name);
    });
    return rows.slice(0, 1_000);
}

function copyFileTransferEntry(
    sshExecutable: string,
    relay: boolean,
    recursive: boolean,
    source: string,
    destination: string,
    active: ActiveFileTransferCopy,
): Promise<void> {
    const executable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'scp.exe' : 'scp');
    const args = [
        ...(relay ? ['-3'] : []),
        ...(recursive ? ['-r'] : []),
        '--',
        source,
        destination,
    ];
    return new Promise((resolve, reject) => {
        const process = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        active.process = process;
        const stderr: Buffer[] = [];
        process.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        process.on('error', error => reject(new Error(`Could not start SCP: ${error.message}`)));
        process.on('close', code => {
            active.process = undefined;
            if (active.cancelled) {
                reject(new Error('File copy was cancelled.'));
                return;
            }
            if (code === 0) { resolve(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            reject(new Error(message ? `File copy failed: ${message.slice(0, 320)}` : 'File copy failed.'));
        });
    });
}

export class ManagedRemoteBridgeController {
    private readonly fileTransferRoots = new Map<string, FileTransferLocalRoot>();
    private readonly fileTransferRemoteDirectories = new Map<string, FileTransferRemoteDirectory>();
    private readonly fileTransferRemoteEntries = new Map<string, FileTransferRemoteDirectory>();
    private readonly activeFileTransferCopies = new Map<string, ActiveFileTransferCopy>();
    constructor(
        private readonly catalog: ManagedRemoteBridgeCatalogReader,
        private readonly coordinators: ManagedRemoteBridgeCoordinatorFactory,
        private readonly sessionToken: string,
        private readonly localActions?: ManagedRemoteBridgeLocalActions,
        private readonly projection?: ManagedRemoteBridgeProjection,
    ) {
    }

    async execute(raw: unknown): Promise<ManagedRemoteBridgeResponse> {
        const request = parseManagedRemoteBridgeRequest(raw);
        if (!request) {
            return response('invalid-request', 'failed', 'Invalid Managed Remote bridge request.');
        }
        if (request.sessionToken !== this.sessionToken) {
            return response(request.requestId, 'failed', 'Managed Remote bridge session expired.');
        }
        try {
            if (request.operation === 'selectFileTransferLocalRoot') {
                return response(request.requestId, 'ok', await this.selectFileTransferLocalRoot());
            }
            if (request.operation === 'listFileTransferLocalDirectory') {
                const localRoot = request.fileTransfer as FileTransferLocalRootRequest;
                return response(request.requestId, 'ok', await this.listFileTransferLocalDirectory(
                    localRoot.rootId,
                    localRoot.directoryId,
                ));
            }
            if (request.operation === 'cancelFileTransferCopy') {
                const cancellation = request.fileTransfer as { taskId: string };
                return response(request.requestId, 'ok', this.cancelFileTransferCopy(cancellation.taskId));
            }
            const coordinator = await this.coordinators.create();
            if (request.operation === 'listFileTransferRemoteDirectory') {
                const remoteDirectory = request.fileTransfer as FileTransferRemoteDirectoryRequest;
                const slot = this.readExpectedSlot(request);
                return response(request.requestId, 'ok', await this.listFileTransferRemoteDirectory(
                    slot,
                    coordinator,
                    request.targetId!,
                    remoteDirectory.directoryId,
                ));
            }
            if (request.operation === 'copyFileTransferEntries') {
                const copy = request.fileTransfer as FileTransferCopyRequest;
                if (copy.source.kind === 'local' && copy.destination.kind === 'local') {
                    throw new Error('File Transfer does not copy between two local folders.');
                }
                const slot = this.readExpectedSlot(request);
                return response(request.requestId, 'ok', await this.copyFileTransferEntries(
                    slot,
                    coordinator,
                    copy,
                ));
            }
            if (request.operation === 'inspectLegacySshTarget') {
                if (!this.localActions || !request.legacySshTarget) {
                    throw new Error('Local SSH inspection is unavailable.');
                }
                return response(
                    request.requestId,
                    'ok',
                    await this.localActions.inspectLegacySshTarget(
                        coordinator.getExecutable(),
                        coordinator.getActiveConfigPath(),
                        request.legacySshTarget,
                    ),
                );
            }
            if (request.operation === 'getStatus') {
                const state = coordinator.getState();
                return state.status === 'recoveryRequired'
                    ? response(request.requestId, 'recoveryRequired', state.recoveryReason || 'Recovery required.')
                    : response(request.requestId, 'ok', state);
            }
            if (request.operation === 'recover') {
                const slot = request.expectedRevisionId
                    ? this.readExpectedSlot(request) : undefined;
                return response(
                    request.requestId,
                    'ok',
                    sanitizeLocalResult(await coordinator.recover(slot)),
                );
            }
            const slot = this.readExpectedSlot(request);
            if (request.operation === 'openManagedMachine'
                || request.operation === 'openManagedProject'
                || request.operation === 'openManagedEnvironment') {
                if (!this.localActions || !request.targetId) {
                    throw new Error('Managed Remote navigation is unavailable.');
                }
                const view = materializeManagedRemoteCatalog(slot.document);
                if (request.operation === 'openManagedMachine') {
                    const target = resolveManagedMachineTarget(view, request.targetId);
                    await this.ensureProjectionReady(slot);
                    await this.localActions.openRemoteWindow(target.remoteAuthority);
                    return response(request.requestId, 'ok', {
                        targetId: request.targetId,
                        machineId: target.machine.id,
                        alias: target.alias,
                    });
                } else if (request.operation === 'openManagedEnvironment') {
                    const target = resolveManagedEnvironmentTarget(view, request.targetId);
                    await this.ensureProjectionReady(slot);
                    await this.localActions.openRemoteWindow(
                        authorityFromRemoteUri(target.remoteUri),
                    );
                    return response(request.requestId, 'ok', {
                        targetId: request.targetId,
                        machineId: target.machine.id,
                        alias: target.alias,
                    });
                } else {
                    const target = resolveManagedProjectTarget(view, request.targetId);
                    await this.ensureProjectionReady(slot);
                    await this.localActions.openRemoteFolder(target.remoteUri);
                    return response(request.requestId, 'ok', {
                        targetId: request.targetId,
                        machineId: target.machine.id,
                        alias: target.alias,
                    });
                }
            }
            if (request.operation === 'openLocalSshTerminal'
                || request.operation === 'copyLocalSshCommand') {
                if (!this.localActions || !request.targetId) {
                    throw new Error('Managed Remote local SSH actions are unavailable.');
                }
                const view = materializeManagedRemoteCatalog(slot.document);
                const target = resolveManagedMachineTarget(view, request.targetId);
                const args = managedSshArguments(target.machine);
                if (request.operation === 'openLocalSshTerminal') {
                    await this.localActions.openTerminal({
                        name: `SSH: ${target.machine.name}`,
                        shellPath: coordinator.getExecutable(),
                        shellArgs: args,
                    });
                } else {
                    await this.localActions.writeClipboard(formatManagedSshCommand(
                        coordinator.getExecutable(), args, this.localActions.platform,
                    ));
                }
                return response(request.requestId, 'ok', {
                    machineId: target.machine.id,
                    machineName: target.machine.name,
                    alias: target.alias,
                });
            }
            if (request.operation === 'reconcile') {
                if (this.projection) {
                    this.projection.schedule(slot);
                    return response(request.requestId, 'ok', { scheduled: true });
                }
                return response(request.requestId, 'ok', await coordinator.reconcile(slot));
            }
            throw new Error('Unsupported Managed Remote bridge operation.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/catalog revision|active Managed Remote catalog/i.test(message)) {
                return response(request.requestId, 'catalogOutOfDate', error);
            }
            if (/recovery/i.test(message)) {
                return response(request.requestId, 'recoveryRequired', error);
            }
            return response(request.requestId, 'failed', error);
        }
    }

    private ensureProjectionReady(
        slot: ManagedRevisionSlot,
    ): Promise<void> {
        if (!this.projection) {
            throw new Error('Managed SSH projection worker is unavailable.');
        }
        return this.projection.ensureReady(slot);
    }

    private async selectFileTransferLocalRoot(): Promise<FileTransferLocalRootResponse | null> {
        if (!this.localActions) {
            throw new Error('Local folder selection is unavailable.');
        }
        const selected = await this.localActions.selectLocalDirectory();
        if (!selected) { return null; }
        const rootPath = await realpath(selected);
        if (!(await stat(rootPath)).isDirectory()) {
            throw new Error('The selected local path is not a directory.');
        }
        const rootId = this.fileTransferHandle();
        const directoryId = this.fileTransferHandle();
        const label = path.basename(rootPath) || rootPath;
        this.fileTransferRoots.set(rootId, {
            path: rootPath,
            label,
            directories: new Map([[directoryId, rootPath]]),
            entries: new Map(),
        });
        return this.listFileTransferLocalDirectory(rootId, directoryId);
    }

    private async listFileTransferLocalDirectory(
        rootId: string,
        directoryId: string | undefined,
    ): Promise<FileTransferLocalRootResponse> {
        const root = this.fileTransferRoots.get(rootId);
        if (!root) {
            throw new Error('The selected local folder is no longer available. Choose it again.');
        }
        const resolvedDirectoryId = directoryId || Array.from(root.directories.keys())[0];
        const directoryPath = resolvedDirectoryId ? root.directories.get(resolvedDirectoryId) : undefined;
        if (!directoryPath) {
            throw new Error('The selected local directory is no longer available. Refresh the folder.');
        }
        const currentPath = await realpath(directoryPath);
        if (!this.isWithinLocalRoot(root.path, currentPath)
            || !(await stat(currentPath)).isDirectory()) {
            throw new Error('The selected local directory is outside the approved folder.');
        }
        root.directories.set(resolvedDirectoryId, currentPath);
        const entries: FileTransferDirectoryEntry[] = [];
        const directory = await opendir(currentPath);
        for await (const child of directory) {
                if (entries.length >= 1_000) { break; }
                if (child.name.length > 255) { continue; }
                const childPath = path.join(currentPath, child.name);
                const childStat = await lstat(childPath);
                const kind = childStat.isSymbolicLink()
                    ? 'symlink'
                    : childStat.isDirectory()
                        ? 'directory'
                        : childStat.isFile()
                            ? 'file'
                            : 'unsupported';
                const id = this.fileTransferHandle();
                root.entries.set(id, {
                    path: childPath, kind,
                    ...(kind === 'file' ? { size: childStat.size } : {}),
                });
                if (kind === 'directory') {
                    const realChildPath = await realpath(childPath);
                    if (this.isWithinLocalRoot(root.path, realChildPath)) {
                        root.directories.set(id, realChildPath);
                    }
                }
                entries.push({
                    id,
                    name: child.name,
                    kind,
                    ...(kind === 'file' ? { size: childStat.size } : {}),
                    ...(Number.isSafeInteger(Math.floor(childStat.mtimeMs))
                        ? { modifiedAt: Math.max(0, Math.floor(childStat.mtimeMs)) } : {}),
                });
        }
        entries.sort((left, right) => {
            if (left.kind === 'directory' && right.kind !== 'directory') { return -1; }
            if (left.kind !== 'directory' && right.kind === 'directory') { return 1; }
            return left.name.localeCompare(right.name);
        });
        const relativePath = path.relative(root.path, currentPath).split(path.sep).join('/') || '.';
        return {
            rootId, directoryId: resolvedDirectoryId, label: root.label,
            displayPath: relativePath, entries,
        };
    }

    private isWithinLocalRoot(rootPath: string, candidatePath: string): boolean {
        const relative = path.relative(rootPath, candidatePath);
        return relative === '' || (!relative.startsWith(`..${path.sep}`)
            && relative !== '..' && !path.isAbsolute(relative));
    }

    private fileTransferHandle(): string {
        return randomBytes(16).toString('hex');
    }

    private async listFileTransferRemoteDirectory(
        slot: ManagedRevisionSlot,
        coordinator: ManagedSshConsentCoordinator,
        machineId: string,
        directoryId: string | undefined,
    ): Promise<FileTransferLocalRootResponse> {
        const view = materializeManagedRemoteCatalog(slot.document);
        const target = resolveManagedMachineTarget(view, machineId);
        await this.ensureProjectionReady(slot);
        let resolvedDirectoryId = directoryId;
        let directory: FileTransferRemoteDirectory | undefined;
        if (resolvedDirectoryId) {
            directory = this.fileTransferRemoteDirectories.get(resolvedDirectoryId);
            if (!directory || directory.machineId !== machineId) {
                throw new Error('The selected remote directory is no longer available. Refresh the Machine.');
            }
        } else {
            resolvedDirectoryId = this.fileTransferHandle();
            directory = { machineId, path: '.', kind: 'directory' };
            this.fileTransferRemoteDirectories.set(resolvedDirectoryId, directory);
        }
        const rows = await listRemoteDirectory(coordinator.getExecutable(), target.alias, directory.path);
        const entries: FileTransferDirectoryEntry[] = rows.map(row => {
            const id = this.fileTransferHandle();
            const entryPath = remoteChildPath(directory!.path, row.name);
            this.fileTransferRemoteEntries.set(id, {
                machineId, path: entryPath, kind: row.kind,
                ...(row.size === undefined ? {} : { size: row.size }),
            });
            if (row.kind === 'directory') {
                this.fileTransferRemoteDirectories.set(id, {
                    machineId,
                    path: entryPath,
                    kind: 'directory',
                });
            }
            return { id, name: row.name, kind: row.kind, ...(row.size === undefined ? {} : { size: row.size }) };
        });
        return {
            rootId: machineIdToTransferRootId(machineId),
            directoryId: resolvedDirectoryId,
            label: target.machine.name,
            displayPath: directory.path,
            entries,
        };
    }

    private async copyFileTransferEntries(
        slot: ManagedRevisionSlot,
        coordinator: ManagedSshConsentCoordinator,
        request: FileTransferCopyRequest,
    ): Promise<FileTransferCopyResult> {
        if (this.activeFileTransferCopies.has(request.taskId)) {
            throw new Error('This File Transfer task is already running.');
        }
        if (this.activeFileTransferCopies.size > 0) {
            throw new Error('Another File Transfer copy is already running. Cancel it or wait for it to finish.');
        }
        if (request.source.kind === 'local' && request.destination.kind === 'local') {
            throw new Error('File Transfer does not copy between two local folders.');
        }
        const active: ActiveFileTransferCopy = { cancelled: false };
        this.activeFileTransferCopies.set(request.taskId, active);
        let completedItems = 0;
        let skippedItems = 0;
        try {
            const source = await this.resolveFileTransferSource(slot, request.source, request.entryIds);
            const destination = await this.resolveFileTransferDestination(slot, request.destination);
            for (const entry of source.entries) {
                if (active.cancelled) { throw new Error('File copy was cancelled.'); }
                const destinationPath = destination.kind === 'local'
                    ? path.join(destination.path, path.basename(entry.path))
                    : remoteChildPath(destination.path, path.basename(entry.path));
                const collision = destination.kind === 'local'
                    ? await localPathExists(destinationPath)
                    : await remotePathExists(
                        coordinator.getExecutable(), destination.alias, destinationPath,
                    );
                if (collision) {
                    if (request.conflictPolicy === 'skip') {
                        skippedItems += 1;
                        continue;
                    }
                    if (request.conflictPolicy !== 'replace') {
                        throw new Error(`Copy target already exists: ${path.basename(entry.path)}. Choose another folder or select a conflict policy.`);
                    }
                }
                await copyFileTransferEntry(
                    coordinator.getExecutable(),
                    source.kind === 'managedMachine' && destination.kind === 'managedMachine',
                    entry.kind === 'directory',
                    source.kind === 'managedMachine' ? `${source.alias}:${entry.path}` : entry.path,
                    destination.kind === 'managedMachine'
                        ? `${destination.alias}:${destination.path}` : destination.path,
                    active,
                );
                if (entry.kind === 'file' && Number.isSafeInteger(entry.size)) {
                    const copiedSize = destination.kind === 'local'
                        ? await localFileSize(destinationPath)
                        : await remoteFileSize(
                            coordinator.getExecutable(), destination.alias, destinationPath,
                        );
                    if (copiedSize !== entry.size) {
                        throw new Error(`File copy did not pass size verification: ${path.basename(entry.path)}.`);
                    }
                }
                completedItems += 1;
            }
        } catch (error) {
            if (active.cancelled) {
                return {
                    status: 'cancelled', completedItems, skippedItems, totalItems: request.entryIds.length,
                };
            }
            throw error;
        } finally {
            this.activeFileTransferCopies.delete(request.taskId);
        }
        return { status: 'copied', completedItems, skippedItems, totalItems: request.entryIds.length };
    }

    private cancelFileTransferCopy(taskId: string): { cancelled: boolean } {
        const active = this.activeFileTransferCopies.get(taskId);
        if (!active) { return { cancelled: false }; }
        active.cancelled = true;
        active.process?.kill();
        return { cancelled: true };
    }

    private async resolveFileTransferSource(
        slot: ManagedRevisionSlot,
        endpoint: FileTransferEndpointReference,
        entryIds: string[],
    ): Promise<{ kind: 'local'; entries: FileTransferEntry[] } | {
        kind: 'managedMachine'; alias: string; entries: FileTransferEntry[];
    }> {
        if (endpoint.kind === 'local') {
            const root = this.fileTransferRoots.get(endpoint.rootId);
            if (!root || !root.directories.has(endpoint.directoryId)) {
                throw new Error('The selected local source is no longer available. Browse it again.');
            }
            const entries = entryIds.map(id => root.entries.get(id));
            if (entries.some(entry => !entry || entry.kind === 'symlink' || entry.kind === 'unsupported')) {
                throw new Error('Select only regular files or folders from the current local directory.');
            }
            return { kind: 'local', entries: entries as FileTransferEntry[] };
        }
        const target = resolveManagedMachineTarget(
            materializeManagedRemoteCatalog(slot.document), endpoint.machineId,
        );
        await this.ensureProjectionReady(slot);
        const entries = entryIds.map(id => this.fileTransferRemoteEntries.get(id));
        if (entries.some(entry => !entry || entry.machineId !== endpoint.machineId
            || entry.kind === 'symlink' || entry.kind === 'unsupported')) {
            throw new Error('Select only regular files or folders from the current Managed Machine directory.');
        }
        return { kind: 'managedMachine', alias: target.alias, entries: entries as FileTransferEntry[] };
    }

    private async resolveFileTransferDestination(
        slot: ManagedRevisionSlot,
        endpoint: FileTransferEndpointReference,
    ): Promise<{ kind: 'local'; path: string } | { kind: 'managedMachine'; alias: string; path: string }> {
        if (endpoint.kind === 'local') {
            const root = this.fileTransferRoots.get(endpoint.rootId);
            const directoryPath = root?.directories.get(endpoint.directoryId);
            if (!root || !directoryPath) {
                throw new Error('The selected local destination is no longer available. Browse it again.');
            }
            const resolvedPath = await realpath(directoryPath);
            if (!this.isWithinLocalRoot(root.path, resolvedPath) || !(await stat(resolvedPath)).isDirectory()) {
                throw new Error('The selected local destination is outside the approved folder.');
            }
            return { kind: 'local', path: resolvedPath };
        }
        const directory = this.fileTransferRemoteDirectories.get(endpoint.directoryId);
        if (!directory || directory.machineId !== endpoint.machineId) {
            throw new Error('The selected Managed Machine destination is no longer available. Browse it again.');
        }
        const target = resolveManagedMachineTarget(
            materializeManagedRemoteCatalog(slot.document), endpoint.machineId,
        );
        await this.ensureProjectionReady(slot);
        return { kind: 'managedMachine', alias: target.alias, path: directory.path };
    }

    private readExpectedSlot(request: ManagedRemoteBridgeRequest): ManagedRevisionSlot {
        const raw = this.catalog.readManagedCatalogEnvelope();
        const slot = activeSlot(raw);
        if (!slot) {
            throw new Error('There is no unambiguous active Managed Remote catalog.');
        }
        if (slot.revisionId !== request.expectedRevisionId) {
            throw new Error('Managed Remote catalog revision is out of date.');
        }
        return slot;
    }
}
