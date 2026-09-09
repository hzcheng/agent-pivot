'use strict';

import { createHash, randomBytes } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { constants, Stats } from 'fs';
import { access, FileHandle, lstat, mkdir, open, opendir, realpath, rename, rm, stat } from 'fs/promises';
import * as path from 'path';
import { readManagedActiveRevisionSlot } from '../../../src/projects/managedRemote/envelope';
import {
    FileTransferDirectoryEntry,
    FileTransferLocalRootRequest,
    FileTransferRemoteDirectoryRequest,
    FileTransferPreflightRequest,
    FileTransferPreflightResult,
    FileTransferCopyRequest,
    FileTransferCopyResult,
    FileTransferCopyStatus,
    FileTransferCopyHop,
    FileTransferCopyFailureDiagnostic,
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
    device: number;
    inode: number;
    label: string;
    directories: Map<string, string>;
    entries: Map<string, FileTransferEntry>;
}

interface FileTransferEntry {
    path: string;
    kind: FileTransferDirectoryEntry['kind'];
    size?: number;
    directoryId: string;
}

interface ResolvedFileTransferEntry extends FileTransferEntry {
    id: string;
    /** Present only for a source selected beneath an approved local root. */
    localRootPath?: string;
    localRootIdentity?: { device: number; inode: number };
}

interface FileTransferRemoteDirectory extends FileTransferEntry {
    machineId: string;
    revisionId: string;
    path: string;
}

interface ActiveFileTransferCopy {
    cancelled: boolean;
    process?: ChildProcess;
    processes?: ChildProcess[];
    phase?: FileTransferCopyStatus['phase'];
    currentItemName?: string;
    completedItems?: number;
    skippedItems?: number;
    totalItems?: number;
    hop?: FileTransferCopyHop;
    transferredBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    activity?: FileTransferCopyStatus['activity'];
    lastActivityAt?: number;
    monitorTimer?: NodeJS.Timeout;
    monitorGeneration?: number;
}

function noteFileTransferActivity(
    active: ActiveFileTransferCopy,
    activity: NonNullable<FileTransferCopyStatus['activity']>,
): void {
    active.activity = activity;
    active.lastActivityAt = Date.now();
}

interface FileTransferTreeSummary {
    knownBytes: number;
    unknownSizeItems: number;
    /**
     * The bounded, source-relative regular-file manifest used to verify a
     * recursive copy. This stays entirely inside the UI Bridge; it is never
     * returned through the Webview protocol.
     */
    files: FileTransferTreeFile[];
    /**
     * Symbolic links are copied as links, never followed. Keeping a
     * manifest lets verification detect a transport that silently flattened
     * or omitted one.
     */
    links: string[];
}

interface FileTransferTreeFile {
    relativePath: string;
    size?: number;
}

const FILE_TRANSFER_TREE_MAX_ENTRIES = 10_000;
// The browser asks the Bridge to preflight immediately before it starts a
// copy. Reuse that safety scan only for that immediate action: a second
// recursive remote SFTP walk can take far longer than the copy itself for a
// dependency directory. The source fingerprint must still match at copy time.
const FILE_TRANSFER_TREE_REVIEW_TTL_MS = 15_000;
const FILE_TRANSFER_TREE_REVIEW_MAX_ENTRIES = 32;
// The Webview request deadline is 15 seconds. Keep the owning process below
// that deadline so a timed-out browse never leaves an orphaned SFTP child.
const FILE_TRANSFER_SFTP_CONTROL_TIMEOUT_MS = 12_000;
const FILE_TRANSFER_HANDLE_MAX_ENTRIES = 4_096;
const FILE_TRANSFER_ROOT_MAX_ENTRIES = 16;

interface ReviewedFileTransferTrees {
    expiresAt: number;
    trees: Map<string, FileTransferTreeSummary>;
    fingerprints: Map<string, string>;
}

function boundedFileTransferFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\0\r\n]+/gu, ' ')
        // The relay folder belongs to this computer. Its absolute path is not
        // actionable for a user and must not escape through a copy failure.
        .replace(/(?:[A-Za-z]:)?[\\/][^\s:]*agent-pivot-file-transfer-[^\s:]+/gu, '[local relay staging]')
        .trim().slice(0, 320) || 'File copy failed.';
}

function fileTransferFailureDiagnostic(
    error: unknown,
    active: ActiveFileTransferCopy,
): FileTransferCopyFailureDiagnostic {
    const message = boundedFileTransferFailureMessage(error).toLowerCase();
    const code = /no space left|disk full|not enough space|quota exceeded/u.test(message) ? 'space'
        : /permission denied|access denied|not permitted/u.test(message) ? 'permission'
            : /verification|did not pass size|size verification/u.test(message) ? 'verification'
                : /cancelled/u.test(message) ? 'cancelled'
                    : /connection|timed out|network|host key|could not resolve|connection reset|broken pipe/u.test(message)
                        ? 'network' : 'unknown';
    return {
        phase: active.phase || 'preparing',
        hop: active.hop || 'source-to-target',
        code,
    };
}

function stopFileTransferProgressMonitor(active: ActiveFileTransferCopy): void {
    if (active.monitorTimer) {
        clearInterval(active.monitorTimer);
        active.monitorTimer = undefined;
    }
    active.monitorGeneration = (active.monitorGeneration || 0) + 1;
}

function startFileTransferProgressMonitor(
    active: ActiveFileTransferCopy,
    totalBytes: number | undefined,
    readTransferredBytes: () => Promise<number>,
): void {
    stopFileTransferProgressMonitor(active);
    if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
        active.transferredBytes = undefined;
        active.totalBytes = undefined;
        active.bytesPerSecond = undefined;
        return;
    }
    const knownTotalBytes = totalBytes;
    active.transferredBytes = 0;
    active.totalBytes = totalBytes;
    active.bytesPerSecond = undefined;
    const generation = active.monitorGeneration!;
    let previousBytes = 0;
    let previousAt = Date.now();
    let sampling = false;
    const sample = (): void => {
        if (sampling) return;
        sampling = true;
        void readTransferredBytes().then(bytes => {
            if (active.monitorGeneration !== generation || !Number.isSafeInteger(bytes) || bytes < 0) return;
            const nextBytes = Math.min(bytes, knownTotalBytes);
            const now = Date.now();
            if (now > previousAt) {
                active.bytesPerSecond = Math.round(Math.max(0, nextBytes - previousBytes) * 1000 / (now - previousAt));
            }
            active.transferredBytes = nextBytes;
            previousBytes = nextBytes;
            previousAt = now;
        }, () => undefined).finally(() => { sampling = false; });
    };
    sample();
    // Remote size sampling opens an SFTP control connection. Keep it sparse:
    // telemetry must never become the busiest SSH client during a large copy.
    active.monitorTimer = setInterval(sample, 5_000);
}

function completeFileTransferProgressMonitor(active: ActiveFileTransferCopy): void {
    if (Number.isSafeInteger(active.totalBytes) && active.totalBytes! >= 0) {
        active.transferredBytes = active.totalBytes;
    }
    stopFileTransferProgressMonitor(active);
}

async function localFileTransferProgressBytes(targetPath: string): Promise<number> {
    try {
        return await localFileSize(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 0; }
        throw error;
    }
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
    modifiedAt?: number;
}

function machineIdToTransferRootId(machineId: string): string {
    return createHash('sha256').update(machineId, 'utf8').digest('hex').slice(0, 32);
}

function remoteChildPath(parent: string, name: string): string {
    // Some SFTP servers identify entries with their absolute path. Re-prefixing
    // such a name turns `/home/user/.config` into `.//home/user/.config`, which
    // makes a perfectly valid folder impossible to open from File Transfer.
    if (path.posix.isAbsolute(name)) { return name; }
    return parent === '.' ? `./${name}` : `${parent}/${name}`;
}

const scpSftpDefaultCache = new Map<string, Promise<boolean>>();

/** OpenSSH 9.0 made SFTP the SCP default; older clients invoke a remote shell. */
function scpUsesSftpByDefault(sshExecutable: string): Promise<boolean> {
    const cached = scpSftpDefaultCache.get(sshExecutable);
    if (cached) { return cached; }
    const result = new Promise<boolean>(resolve => {
        const process = spawn(sshExecutable, ['-V'], { stdio: ['ignore', 'ignore', 'pipe'] });
        const stderr: Buffer[] = [];
        process.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        process.on('error', () => resolve(false));
        process.on('close', () => {
            const version = /OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)/u
                .exec(Buffer.concat(stderr).toString('utf8'));
            resolve(Boolean(version && Number(version[1]) >= 9));
        });
    });
    scpSftpDefaultCache.set(sshExecutable, result);
    return result;
}

/** Legacy SCP executes the remote endpoint through a shell, so quote its path. */
function scpRemotePath(alias: string, remotePath: string, legacyScp: boolean): string {
    return legacyScp
        ? `${alias}:${remotePath.replace(/([^A-Za-z0-9_./:@-])/gu, '\\$1')}`
        : `${alias}:${remotePath}`;
}

function quoteSftpPath(value: string): string {
    return `"${value.replace(/([\\"])/gu, '\\$1')}"`;
}

function runFileTransferSftpBatch(
    sshExecutable: string,
    alias: string,
    command: string,
): Promise<{ stdout: string; stderr: string }> {
    const sftpExecutable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'sftp.exe' : 'sftp');
    return new Promise((resolve, reject) => {
        const child = spawn(sftpExecutable, [...fileTransferSshOptions(), '-b', '-', alias], {
            stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeout);
            if (error) { reject(error); }
            else { resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); }
        };
        const timeout = setTimeout(() => {
            stopFileTransferProcess(child);
            finish(new Error('Remote SFTP control request timed out. Refresh the Machine and try again.'));
        }, FILE_TRANSFER_SFTP_CONTROL_TIMEOUT_MS);
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', error => finish(new Error(`Could not start SFTP: ${error.message}`)));
        child.on('close', code => {
            if (code === 0) { finish(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            finish(new Error(message ? `Remote SFTP control request failed: ${message.slice(0, 320)}`
                : 'Remote SFTP control request failed.'));
        });
        child.stdin.end(command);
    });
}

function listRemoteDirectory(
    sshExecutable: string,
    alias: string,
    directoryPath: string,
): Promise<RemoteDirectoryRow[]> {
    return runFileTransferSftpBatch(sshExecutable, alias, `ls -la ${quoteSftpPath(directoryPath)}\n`)
        .then(({ stdout }) => parseSftpLongListing(stdout));
}

/** Resolve the authenticated SFTP session's actual login directory, never a guessed user path. */
function remoteLoginDirectory(
    sshExecutable: string,
    alias: string,
): Promise<string> {
    return runFileTransferSftpBatch(sshExecutable, alias, 'pwd\n').then(({ stdout }) => {
            const match = /^Remote working directory:\s*(\/[^\0\r\n]{0,1023})\s*$/mu
                .exec(stdout);
            if (!match || !path.posix.isAbsolute(match[1])) {
                throw new Error('Could not determine the remote login directory.');
            }
            return match[1];
    });
}

function remotePathKind(
    sshExecutable: string,
    alias: string,
    targetPath: string,
): Promise<FileTransferDirectoryEntry['kind'] | null> {
    return runFileTransferSftpBatch(sshExecutable, alias, `-lstat ${quoteSftpPath(targetPath)}\n`)
        .then(({ stdout, stderr }) => {
            const kind = parseSftpPathKind(`${stdout}${stderr}`);
            if (kind) {
                return kind;
            }
            // Some OpenSSH releases omit a stable type line for batch `stat`.
            // Fall back to the already-validated directory listing parser so
            // an existing empty directory cannot be mistaken for a missing
            // target. This remains a non-recursive, local-UI-host operation.
            const parent = path.posix.dirname(targetPath) || '.';
            const name = path.posix.basename(targetPath);
            return listRemoteDirectory(sshExecutable, alias, parent)
                .then(rows => rows.find(row => row.name === name)?.kind || null);
        });
}

function remotePathExists(
    sshExecutable: string,
    alias: string,
    targetPath: string,
): Promise<boolean> {
    return remotePathKind(sshExecutable, alias, targetPath).then(Boolean);
}

function addKnownFileTransferBytes(
    summary: FileTransferTreeSummary,
    size: number | undefined,
): void {
    if (Number.isSafeInteger(size) && size! >= 0
        && summary.knownBytes <= Number.MAX_SAFE_INTEGER - size!) {
        summary.knownBytes += size!;
    } else {
        summary.unknownSizeItems += 1;
    }
}

function unsupportedFileTransferTreeEntry(entryPath: string): Error {
    return new Error(`File Transfer cannot copy a folder containing an unsupported item: ${path.basename(entryPath)}.`);
}

async function inspectLocalFileTransferTree(rootPath: string): Promise<FileTransferTreeSummary> {
    const summary: FileTransferTreeSummary = { knownBytes: 0, unknownSizeItems: 0, files: [], links: [] };
    const pending = [{ path: rootPath, relativePath: '' }];
    let inspectedEntries = 0;
    while (pending.length) {
        const entry = pending.pop()!;
        const entryPath = entry.path;
        const details = await lstat(entryPath);
        inspectedEntries += 1;
        if (inspectedEntries > FILE_TRANSFER_TREE_MAX_ENTRIES) {
            throw new Error('File Transfer folder is too large to inspect safely. Choose a smaller folder.');
        }
        if (details.isSymbolicLink()) {
            summary.links.push(entry.relativePath);
            continue;
        }
        if (!details.isFile() && !details.isDirectory()) {
            throw unsupportedFileTransferTreeEntry(entryPath);
        }
        if (details.isFile()) {
            addKnownFileTransferBytes(summary, details.size);
            summary.files.push({ relativePath: entry.relativePath, size: details.size });
            continue;
        }
        const directory = await opendir(entryPath);
        for await (const child of directory) {
            pending.push({
                path: path.join(entryPath, child.name),
                relativePath: entry.relativePath ? `${entry.relativePath}/${child.name}` : child.name,
            });
        }
    }
    return summary;
}

async function inspectRemoteFileTransferTree(
    sshExecutable: string,
    alias: string,
    rootPath: string,
): Promise<FileTransferTreeSummary> {
    const summary: FileTransferTreeSummary = { knownBytes: 0, unknownSizeItems: 0, files: [], links: [] };
    const pending = [{ path: rootPath, relativePath: '' }];
    let inspectedEntries = 0;
    while (pending.length) {
        const directory = pending.pop()!;
        const directoryPath = directory.path;
        const rows = await listRemoteDirectory(sshExecutable, alias, directoryPath);
        if (rows.length >= 1_000) {
            throw new Error('File Transfer folder is too large to inspect safely. Choose a smaller folder.');
        }
        for (const row of rows) {
            inspectedEntries += 1;
            if (inspectedEntries > FILE_TRANSFER_TREE_MAX_ENTRIES) {
                throw new Error('File Transfer folder is too large to inspect safely. Choose a smaller folder.');
            }
            const entryPath = remoteChildPath(directoryPath, row.name);
            const relativePath = directory.relativePath
                ? `${directory.relativePath}/${row.name}` : row.name;
            if (row.kind === 'symlink') {
                summary.links.push(relativePath);
                continue;
            }
            if (row.kind === 'unsupported') {
                throw unsupportedFileTransferTreeEntry(entryPath);
            }
            if (row.kind === 'directory') {
                pending.push({
                    path: entryPath,
                    relativePath,
                });
            } else {
                addKnownFileTransferBytes(summary, row.size);
                summary.files.push({
                    relativePath,
                    ...(row.size === undefined ? {} : { size: row.size }),
                });
            }
        }
    }
    return summary;
}

async function localFileTransferEntryFingerprint(entry: ResolvedFileTransferEntry): Promise<string> {
    const details = await lstat(entry.path);
    const kind = details.isDirectory() ? 'directory' : details.isFile() ? 'file'
        : details.isSymbolicLink() ? 'symlink' : 'unsupported';
    if (!details.isDirectory()) { return `${kind}:${details.size}:${details.mtimeMs}`; }
    const children: string[] = [];
    const directory = await opendir(entry.path);
    for await (const child of directory) {
        children.push(`${child.name}:${child.isDirectory() ? 'directory' : child.isFile() ? 'file'
            : child.isSymbolicLink() ? 'symlink' : 'unsupported'}`);
    }
    return `directory:${details.mtimeMs}:${createHash('sha256').update(children.sort().join('\n'), 'utf8').digest('hex')}`;
}

async function remoteFileTransferEntryFingerprint(
    sshExecutable: string,
    alias: string,
    entry: ResolvedFileTransferEntry,
): Promise<string> {
    const rows = await listRemoteDirectory(sshExecutable, alias, entry.path);
    const children = rows.map(row => `${row.name}:${row.kind}:${row.size === undefined ? '' : row.size}:${row.modifiedAt === undefined ? '' : row.modifiedAt}`);
    return `directory:${createHash('sha256').update(children.sort().join('\n'), 'utf8').digest('hex')}`;
}

async function localPathKind(targetPath: string): Promise<FileTransferDirectoryEntry['kind'] | null> {
    try {
        const details = await lstat(targetPath);
        return details.isSymbolicLink() ? 'symlink'
            : details.isDirectory() ? 'directory'
                : details.isFile() ? 'file' : 'unsupported';
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
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
    return runFileTransferSftpBatch(sshExecutable, alias, `ls -l ${quoteSftpPath(targetPath)}\n`)
        .then(({ stdout }) => {
            // With an explicit absolute path OpenSSH SFTP may print that full
            // path as the last column. Do not route this verification through
            // the directory-listing name validator: a valid 255-byte basename
            // plus its parent exceeds that display-only bound.
            const match = /^-[rwxStTs-]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d\d:\d\d|\d{4})\s+.+$/mu.exec(stdout);
            const size = match ? Number(match[1]) : NaN;
            if (!Number.isSafeInteger(size) || size < 0) {
                throw new Error('Could not verify remote file size.');
            }
            return size;
        });
}

function fileTransferChildPath(parent: string, relativePath: string): string {
    return relativePath.split('/').reduce((current, segment) => remoteChildPath(current, segment), parent);
}

export async function verifyCopiedFileTransferTree(
    tree: FileTransferTreeSummary,
    destination: { kind: 'local'; path: string } | { kind: 'managedMachine'; alias: string; path: string },
    destinationPath: string,
    sshExecutable: string,
): Promise<void> {
    for (const file of tree.files) {
        const targetPath = destination.kind === 'local'
            ? path.join(destinationPath, ...file.relativePath.split('/'))
            : fileTransferChildPath(destinationPath, file.relativePath);
        const copiedSize = destination.kind === 'local'
            ? await localFileSize(targetPath)
            : await remoteFileSize(sshExecutable, destination.alias, targetPath);
        if (Number.isSafeInteger(file.size) && copiedSize !== file.size) {
            throw new Error(`File copy did not pass size verification: ${path.basename(file.relativePath)}.`);
        }
    }
    for (const relativePath of tree.links || []) {
        const targetPath = destination.kind === 'local'
            ? path.join(destinationPath, ...relativePath.split('/'))
            : fileTransferChildPath(destinationPath, relativePath);
        const kind = destination.kind === 'local'
            ? await localPathKind(targetPath)
            : await remotePathIsSymbolicLink(sshExecutable, destination.alias, targetPath)
                ? 'symlink' : null;
        if (kind !== 'symlink') {
            throw new Error(`File copy did not preserve symbolic link: ${path.basename(relativePath)}.`);
        }
    }
}

function parseSftpModifiedAt(monthLabel: string, dayLabel: string, timeOrYear: string): number | undefined {
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(monthLabel);
    const day = Number(dayLabel);
    if (month < 0 || !Number.isSafeInteger(day) || day < 1 || day > 31) { return undefined; }
    const now = new Date();
    let year = now.getFullYear();
    let hours = 0;
    let minutes = 0;
    if (/^\d{4}$/u.test(timeOrYear)) {
        year = Number(timeOrYear);
    } else {
        const time = /^(\d{2}):(\d{2})$/u.exec(timeOrYear);
        if (!time) { return undefined; }
        hours = Number(time[1]);
        minutes = Number(time[2]);
        if (hours > 23 || minutes > 59) { return undefined; }
    }
    let date = new Date(year, month, day, hours, minutes);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
        return undefined;
    }
    // SFTP prints a time rather than a year for recent entries. A future value
    // therefore belongs to the preceding year, matching the OpenSSH client convention.
    if (!/^\d{4}$/u.test(timeOrYear) && date.getTime() > now.getTime() + 36 * 60 * 60 * 1000) {
        date = new Date(year - 1, month, day, hours, minutes);
    }
    const timestamp = date.getTime();
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

export function parseSftpLongListing(output: string): RemoteDirectoryRow[] {
    const rows: RemoteDirectoryRow[] = [];
    for (const line of output.split(/\r?\n/u)) {
        if (!line || /^sftp>\s*/u.test(line) || /^Connected to /u.test(line)) { continue; }
        const match = /^([bcdlps-])[rwxStTs-]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d\d:\d\d|\d{4})\s+(.+)$/u.exec(line);
        if (!match) { continue; }
        // OpenSSH prints a symbolic link as `name -> target` in an `ls -l`
        // listing. The target is display-only; only the link name is a path.
        // A second delimiter makes the filename/target boundary ambiguous, so
        // expose it as unsupported rather than reading a different path.
        const displayedName = match[6];
        const symlinkParts = match[1] === 'l' ? displayedName.split(' -> ') : undefined;
        if (symlinkParts && symlinkParts.length > 2) {
            rows.push({ name: displayedName, kind: 'unsupported' });
            continue;
        }
        const name = symlinkParts && symlinkParts.length === 2 ? symlinkParts[0] : displayedName;
        if (name === '.' || name === '..' || name.length > 255 || /[\0\r\n]/u.test(name)) { continue; }
        const modifiedAt = parseSftpModifiedAt(match[3], match[4], match[5]);
        rows.push({
            name,
            kind: match[1] === 'd' ? 'directory' : match[1] === 'l' ? 'symlink'
                : match[1] === '-' ? 'file' : 'unsupported',
            ...(match[1] === '-' ? { size: Number(match[2]) } : {}),
            ...(modifiedAt === undefined ? {} : { modifiedAt }),
        });
    }
    rows.sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') { return -1; }
        if (left.kind !== 'directory' && right.kind === 'directory') { return 1; }
        return left.name.localeCompare(right.name);
    });
    return rows;
}

/** Parse the bounded type-only portion of OpenSSH SFTP's `stat` output. */
export function parseSftpPathKind(output: string): FileTransferDirectoryEntry['kind'] | null {
    const filetype = /^Filetype:\s*(regular file|directory|symbolic link|block special|character special|fifo|socket)\s*$/imu.exec(output);
    const access = /^Access:\s*\(\d+\/([bcdlps-])/imu.exec(output);
    const marker = filetype?.[1] === 'regular file' ? '-'
        : filetype?.[1] === 'directory' ? 'd'
            : filetype?.[1] === 'symbolic link' ? 'l'
                : filetype ? 'x' : access?.[1];
    return marker === '-' ? 'file' : marker === 'd' ? 'directory'
        : marker === 'l' ? 'symlink' : marker ? 'unsupported' : null;
}

interface StableLocalFileTransferSource {
    /** Child-visible descriptor path. The descriptor itself is inherited as fd 3. */
    path: string;
    fd: number;
    close(): Promise<void>;
}

function fileTransferDescriptorPath(fd: number): string {
    return process.platform === 'darwin' ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`;
}

function fileTransferChildDescriptorPath(): string {
    return fileTransferDescriptorPath(3);
}

/**
 * Open the selected local item once, without following a symlink, and give
 * the transport child that already-open descriptor. Re-checking a pathname is
 * not sufficient: it can be swapped between validation and scp/tar opening
 * it. POSIX fd inheritance keeps the exact inode selected by the user.
 */
async function openStableLocalFileTransferSource(
    rootPath: string,
    rootIdentity: { device: number; inode: number },
    sourcePath: string,
    expectedKind: FileTransferDirectoryEntry['kind'],
): Promise<StableLocalFileTransferSource> {
    if (process.platform === 'win32') {
        // Node has no descriptor-relative, no-reparse-point child pathname on
        // Windows. Fail closed instead of allowing a junction/symlink swap to
        // turn a listed local item into an arbitrary source outside its root.
        throw new Error('Secure local-source transfer is not available on this Windows UI Bridge. Choose a Managed Machine as Source.');
    }
    const relativePath = path.relative(rootPath, sourcePath);
    const components = relativePath.split(path.sep).filter(Boolean);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath) || components.some(component => component === '.' || component === '..')) {
        throw new Error('The selected local source is outside the approved folder. Refresh Source and choose it again.');
    }
    const directoryFlag = expectedKind === 'directory' ? constants.O_DIRECTORY : 0;
    let handle: FileHandle | undefined;
    try {
        // Do not ask the kernel to resolve `root/sub/file` in one step:
        // O_NOFOLLOW covers only `file`. Walk from an opened root descriptor
        // and keep every parent descriptor stable, so replacing `sub` with a
        // link after browsing cannot redirect a later component outside root.
        handle = await open(rootPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        const openedRoot = await handle.stat();
        if (openedRoot.dev !== rootIdentity.device || openedRoot.ino !== rootIdentity.inode) {
            throw new Error('The approved local folder changed before transfer. Browse Source again.');
        }
        for (let index = 0; index < components.length; index += 1) {
            const previous: FileHandle = handle;
            const finalComponent = index === components.length - 1;
            handle = await open(
                `${fileTransferDescriptorPath(previous.fd)}/${components[index]}`,
                constants.O_RDONLY | constants.O_NOFOLLOW | (finalComponent ? directoryFlag : constants.O_DIRECTORY),
            );
            await previous.close();
        }
    } catch {
        await handle?.close();
        throw new Error('The selected local source changed before transfer. Refresh Source and choose it again.');
    }
    try {
        const details = await handle!.stat();
        const actualKind = details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'unsupported';
        if (actualKind !== expectedKind) {
            throw new Error('The selected local source changed before transfer. Refresh Source and choose it again.');
        }
        return { path: fileTransferChildDescriptorPath(), fd: handle!.fd, close: () => handle!.close() };
    } catch (error) {
        await handle!.close();
        throw error;
    }
}

function copyFileTransferEntry(
    sshExecutable: string,
    recursive: boolean,
    source: string,
    destination: string,
    active: ActiveFileTransferCopy,
    totalBytes?: number,
    readTransferredBytes?: () => Promise<number>,
    relayThroughLocal = false,
    sourceFd?: number,
): Promise<void> {
    const executable = path.join(path.dirname(sshExecutable), process.platform === 'win32' ? 'scp.exe' : 'scp');
    const args = [
        ...(recursive ? ['-r'] : []),
        // OpenSSH's -3 mode relays both remote streams through this UI Bridge
        // process. It neither asks the Managed Machines to reach each other
        // nor stages a complete file on this computer's disk.
        ...(relayThroughLocal ? ['-3'] : []),
        // Copies must never wait for an invisible password, host-key, or
        // keyboard-interactive prompt. Bound a dead connection as well; a
        // healthy large transfer remains active because SSH traffic resets
        // the server-alive counter.
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=20',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        // Preserve mode and modification time where both endpoints permit it.
        // SCP reports an ordinary transfer error if either side refuses them.
        '-p',
        '--',
        source,
        destination,
    ];
    if (readTransferredBytes) {
        startFileTransferProgressMonitor(active, totalBytes, readTransferredBytes);
    }
    return new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, {
            // When the source is local, its descriptor is inherited as fd 3.
            // The pathname passed to scp then refers to that descriptor in the
            // child, rather than re-opening a mutable user-controlled path.
            stdio: sourceFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', sourceFd],
            // SCP owns an SSH child on POSIX. A separate process group lets a
            // cancellation terminate both without relying on shell commands.
            detached: process.platform !== 'win32',
        });
        active.process = child;
        noteFileTransferActivity(active, 'scp-started');
        const stderr: Buffer[] = [];
        const stderrOutput = child.stderr;
        if (!stderrOutput) {
            stopFileTransferProcess(child);
            reject(new Error('Could not start SCP stderr stream.'));
            return;
        }
        stderrOutput.on('data', chunk => {
            stderr.push(Buffer.from(chunk));
            noteFileTransferActivity(active, 'scp-running');
        });
        child.on('error', error => reject(new Error(`Could not start SCP: ${error.message}`)));
        child.on('close', code => {
            active.process = undefined;
            noteFileTransferActivity(active, 'scp-exited');
            if (active.cancelled) {
                reject(new Error('File copy was cancelled.'));
                return;
            }
            if (code === 0) { completeFileTransferProgressMonitor(active); resolve(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            reject(new Error(message ? `File copy failed: ${message.slice(0, 320)}` : 'File copy failed.'));
        });
    }).finally(() => stopFileTransferProgressMonitor(active));
}

function quoteRemoteShellArgument(value: string): string {
    if (/\0/u.test(value)) { throw new Error('File Transfer path contains an unsupported character.'); }
    return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function fileTransferSshOptions(): string[] {
    return [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=20',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
    ];
}

function remotePathIsSymbolicLink(
    sshExecutable: string,
    alias: string,
    targetPath: string,
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const child = spawn(sshExecutable, [...fileTransferSshOptions(), alias,
            `[ -L ${quoteRemoteShellArgument(targetPath)} ]`], { stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('error', error => reject(new Error(`Could not inspect remote symbolic link: ${error.message}`)));
        child.on('close', code => resolve(code === 0));
    });
}

function remoteArchiveCommand(directoryPath: string, extracting: boolean): string {
    return `tar -C ${quoteRemoteShellArgument(directoryPath)} -${extracting ? 'x' : 'c'}f -${extracting ? '' : ' .'}`;
}

function startFileTransferArchiveProcess(
    sshExecutable: string,
    endpoint: { kind: 'local'; path: string; sourceFd?: number } | { kind: 'managedMachine'; alias: string; path: string },
    extracting: boolean,
): ChildProcess {
    if (endpoint.kind === 'local') {
        const executable = process.platform === 'win32' ? 'tar.exe' : 'tar';
        const sourcePath = endpoint.sourceFd === undefined ? endpoint.path : fileTransferChildDescriptorPath();
        return spawn(executable, ['-C', sourcePath, `-${extracting ? 'x' : 'c'}f`, '-', ...(extracting ? [] : ['.'])], {
            stdio: endpoint.sourceFd === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', endpoint.sourceFd],
            detached: process.platform !== 'win32',
        });
    }
    return spawn(sshExecutable, [...fileTransferSshOptions(), endpoint.alias,
        remoteArchiveCommand(endpoint.path, extracting)], {
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
}

function copyFileTransferFolderArchive(
    sshExecutable: string,
    source: { kind: 'local'; path: string; sourceFd?: number } | { kind: 'managedMachine'; alias: string; path: string },
    destination: { kind: 'local'; path: string } | { kind: 'managedMachine'; alias: string; path: string },
    active: ActiveFileTransferCopy,
): Promise<void> {
    const producer = startFileTransferArchiveProcess(sshExecutable, source, false);
    const consumer = startFileTransferArchiveProcess(sshExecutable, destination, true);
    const producerOutput = producer.stdout;
    const consumerInput = consumer.stdin;
    const producerError = producer.stderr;
    const consumerError = consumer.stderr;
    if (!producerOutput || !consumerInput || !producerError || !consumerError) {
        stopFileTransferProcess(producer);
        stopFileTransferProcess(consumer);
        return Promise.reject(new Error('Could not start archive stream.'));
    }
    active.process = producer;
    active.processes = [producer, consumer];
    noteFileTransferActivity(active, 'scp-started');
    const stderr: Buffer[] = [];
    producerError.on('data', chunk => { stderr.push(Buffer.from(chunk)); noteFileTransferActivity(active, 'scp-running'); });
    consumerError.on('data', chunk => { stderr.push(Buffer.from(chunk)); noteFileTransferActivity(active, 'scp-running'); });
    return new Promise<void>((resolve, reject) => {
        let producerExit: number | null | undefined;
        let consumerExit: number | null | undefined;
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) { return; }
            settled = true;
            active.process = undefined;
            active.processes = undefined;
            noteFileTransferActivity(active, 'scp-exited');
            if (error) { reject(error); } else { resolve(); }
        };
        const fail = (error: Error) => {
            if (settled) { return; }
            if (!active.cancelled) {
                stopFileTransferProcess(producer);
                stopFileTransferProcess(consumer);
            }
            finish(error);
        };
        const completeIfDone = () => {
            if (producerExit === undefined || consumerExit === undefined) { return; }
            if (active.cancelled) { finish(new Error('File copy was cancelled.')); return; }
            if (producerExit === 0 && consumerExit === 0) { finish(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            finish(new Error(message ? `File copy failed: ${message.slice(0, 320)}` : 'File copy failed.'));
        };
        producer.on('error', error => fail(new Error(`Could not start archive stream: ${error.message}`)));
        consumer.on('error', error => fail(new Error(`Could not start archive stream: ${error.message}`)));
        producerOutput.on('error', error => fail(new Error(`File copy stream failed: ${error.message}`)));
        consumerInput.on('error', error => fail(new Error(`File copy stream failed: ${error.message}`)));
        producer.on('close', code => { producerExit = code; completeIfDone(); });
        consumer.on('close', code => { consumerExit = code; completeIfDone(); });
        producerOutput.pipe(consumerInput);
    });
}

function createRemoteFileTransferDirectory(
    sshExecutable: string,
    alias: string,
    directoryPath: string,
    active: ActiveFileTransferCopy,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(sshExecutable, [...fileTransferSshOptions(), alias,
            `mkdir -- ${quoteRemoteShellArgument(directoryPath)}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        active.process = child;
        active.processes = [child];
        const stderr: Buffer[] = [];
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        const clearActiveProcess = () => {
            if (active.process === child) {
                active.process = undefined;
                active.processes = undefined;
            }
        };
        child.on('error', error => {
            clearActiveProcess();
            reject(new Error(`Could not create copy destination: ${error.message}`));
        });
        child.on('close', code => {
            clearActiveProcess();
            if (code === 0) { resolve(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            reject(new Error(message ? `Could not create copy destination: ${message.slice(0, 320)}`
                : 'Could not create copy destination.'));
        });
    });
}

async function createFileTransferDirectory(
    sshExecutable: string,
    destination: { kind: 'local'; path: string } | { kind: 'managedMachine'; alias: string; path: string },
    active: ActiveFileTransferCopy,
): Promise<void> {
    if (destination.kind === 'local') {
        await mkdir(destination.path);
        return;
    }
    await createRemoteFileTransferDirectory(sshExecutable, destination.alias, destination.path, active);
}

type FileTransferPathEndpoint = { kind: 'local'; path: string } | { kind: 'managedMachine'; alias: string; path: string };

function fileTransferTemporaryPath(finalPath: string, remote: boolean): string {
    // Keep this independently bounded: appending a suffix to a valid 255-byte
    // filename makes the staging path invalid on common filesystems.
    const pathApi = remote ? path.posix : path;
    return pathApi.join(pathApi.dirname(finalPath), `.agent-pivot-transfer-${randomBytes(12).toString('hex')}`);
}

function runRemoteFileTransferCommand(
    sshExecutable: string,
    alias: string,
    command: string,
    active?: ActiveFileTransferCopy,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(sshExecutable, [...fileTransferSshOptions(), alias, command], {
            stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
        });
        if (active) {
            active.process = child;
            active.processes = [child];
        }
        const stderr: Buffer[] = [];
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        const clearActiveProcess = () => {
            if (active?.process === child) {
                active.process = undefined;
                active.processes = undefined;
            }
        };
        child.on('error', error => {
            clearActiveProcess();
            reject(new Error(`Could not finalize copy destination: ${error.message}`));
        });
        child.on('close', code => {
            clearActiveProcess();
            if (active?.cancelled) { reject(new Error('File copy was cancelled.')); return; }
            if (code === 0) { resolve(); return; }
            const message = Buffer.concat(stderr).toString('utf8').trim();
            reject(new Error(message ? `Could not finalize copy destination: ${message.slice(0, 320)}`
                : 'Could not finalize copy destination.'));
        });
    });
}

function publishLocalFileTransferTemporaryPath(
    temporaryPath: string,
    destinationPath: string,
    active: ActiveFileTransferCopy,
): Promise<void> {
    return new Promise((resolve, reject) => {
        // GNU mv's -T -n is an atomic no-clobber publication on the local
        // filesystem: it neither overwrites a concurrent destination nor
        // treats a concurrently-created directory as a parent. Do not fall
        // back to check-then-rename on platforms without this guarantee.
        const child = spawn('mv', ['-Tn', '--', temporaryPath, destinationPath], {
            stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
        });
        active.process = child;
        active.processes = [child];
        const stderr: Buffer[] = [];
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        const clearActiveProcess = () => {
            if (active.process === child) {
                active.process = undefined;
                active.processes = undefined;
            }
        };
        child.on('error', error => {
            clearActiveProcess();
            reject(new Error(`Could not finalize copy destination: ${error.message}`));
        });
        child.on('close', async code => {
            clearActiveProcess();
            if (active.cancelled) { reject(new Error('File copy was cancelled.')); return; }
            if (code !== 0) {
                const message = Buffer.concat(stderr).toString('utf8').trim();
                reject(new Error(message ? `Could not finalize copy destination: ${message.slice(0, 320)}`
                    : 'Could not finalize copy destination.'));
                return;
            }
            if (await localPathKind(temporaryPath)) {
                reject(new Error('Copy target appeared while the folder was transferring. Refresh Target and try again.'));
                return;
            }
            resolve();
        });
    });
}

async function publishFileTransferTemporaryPath(
    sshExecutable: string,
    temporary: FileTransferPathEndpoint,
    destination: FileTransferPathEndpoint,
    active: ActiveFileTransferCopy,
    replaceExisting: boolean,
): Promise<void> {
    if (temporary.kind === 'local' && destination.kind === 'local') {
        // POSIX rename replaces atomically. Platforms that prohibit replacing
        // an open file fail before touching the original, which is safer than
        // deleting it before the verified replacement is ready.
        if (replaceExisting) {
            await rename(temporary.path, destination.path);
        } else {
            await publishLocalFileTransferTemporaryPath(temporary.path, destination.path, active);
        }
        return;
    }
    if (temporary.kind !== 'managedMachine' || destination.kind !== 'managedMachine'
        || temporary.alias !== destination.alias) {
        throw new Error('Could not finalize copy destination.');
    }
    const temporaryPath = quoteRemoteShellArgument(temporary.path);
    const destinationPath = quoteRemoteShellArgument(destination.path);
    // -n is available on the OpenSSH-supported POSIX hosts and prevents a
    // concurrent file from being overwritten. Without GNU `-T`, a concurrent
    // directory may receive the staging item as a child; detect and remove
    // only that opaque child, then fail instead of reporting false success.
    const nestedTemporaryPath = quoteRemoteShellArgument(
        remoteChildPath(destination.path, path.posix.basename(temporary.path)),
    );
    const command = replaceExisting
        ? `mv -Tf -- ${temporaryPath} ${destinationPath}`
        : `mv -n ${temporaryPath} ${destinationPath} && ! test -e ${temporaryPath} && ! test -L ${temporaryPath}`
            + ` && ! test -e ${nestedTemporaryPath} && ! test -L ${nestedTemporaryPath}`
            + ` || { rm -rf -- ${nestedTemporaryPath}; exit 3; }`;
    await runRemoteFileTransferCommand(sshExecutable, temporary.alias, command, active);
}

async function discardFileTransferTemporaryPath(
    sshExecutable: string,
    temporary: FileTransferPathEndpoint,
): Promise<void> {
    try {
        if (temporary.kind === 'local') {
            await rm(temporary.path, { recursive: true, force: true });
            return;
        }
        await runRemoteFileTransferCommand(sshExecutable, temporary.alias,
            `rm -rf -- ${quoteRemoteShellArgument(temporary.path)}`);
    } catch {
        // Preserve the original transfer error. The temporary name is opaque
        // and unique, so a later cleanup cannot address user content.
    }
}

/**
 * A machine-to-machine copy must always pass through the UI Bridge computer.
 * OpenSSH's `scp -3` provides a bounded stream between two independently
 * authenticated remote connections; it does not require source-to-target
 * reachability and does not create a full local staging file.
 */
async function relayFileTransferEntry(
    sshExecutable: string,
    recursive: boolean,
    source: string,
    destination: string,
    active: ActiveFileTransferCopy,
    totalBytes: number | undefined,
    readDestinationBytes: () => Promise<number>,
): Promise<void> {
    active.phase = 'uploading';
    active.hop = 'source-to-target';
    await copyFileTransferEntry(
        sshExecutable, recursive, source, destination, active, totalBytes, readDestinationBytes, true,
    );
}

function stopFileTransferProcess(child: ChildProcess): void {
    if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid! > 0) {
        try {
            process.kill(-child.pid!, 'SIGTERM');
            return;
        } catch (_error) {
            // The process may already have exited between cancellation and the signal.
        }
    }
    child.kill();
}

export class ManagedRemoteBridgeController {
    private readonly fileTransferRoots = new Map<string, FileTransferLocalRoot>();
    private readonly fileTransferRemoteDirectories = new Map<string, FileTransferRemoteDirectory>();
    private readonly fileTransferRemoteEntries = new Map<string, FileTransferRemoteDirectory>();
    private readonly activeFileTransferCopies = new Map<string, ActiveFileTransferCopy>();
    private readonly reviewedFileTransferTrees = new Map<string, ReviewedFileTransferTrees>();
    constructor(
        private readonly catalog: ManagedRemoteBridgeCatalogReader,
        private readonly coordinators: ManagedRemoteBridgeCoordinatorFactory,
        private readonly sessionToken: string,
        private readonly localActions?: ManagedRemoteBridgeLocalActions,
        private readonly projection?: ManagedRemoteBridgeProjection,
        private readonly reportDiagnostic?: (message: string) => void,
    ) {
    }

    dispose(): void {
        for (const active of this.activeFileTransferCopies.values()) {
            active.cancelled = true;
            stopFileTransferProgressMonitor(active);
            for (const process of active.processes || (active.process ? [active.process] : [])) {
                stopFileTransferProcess(process);
            }
        }
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
                localRoot.path,
                ));
            }
            if (request.operation === 'cancelFileTransferCopy') {
                const cancellation = request.fileTransfer as { taskId: string };
                return response(request.requestId, 'ok', this.cancelFileTransferCopy(cancellation.taskId));
            }
            if (request.operation === 'getFileTransferCopyStatus') {
                const status = request.fileTransfer as { taskId: string };
                return response(request.requestId, 'ok', this.getFileTransferCopyStatus(status.taskId));
            }
            if (request.operation === 'copyFileTransferEntries'
                || request.operation === 'preflightFileTransfer') {
                const plan = request.fileTransfer as FileTransferCopyRequest | FileTransferPreflightRequest;
                if (plan.source.kind === 'local' && plan.destination.kind === 'local') {
                    throw new Error('File Transfer does not copy between two local folders.');
                }
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
                    remoteDirectory.path,
                ));
            }
            if (request.operation === 'copyFileTransferEntries') {
                const copy = request.fileTransfer as FileTransferCopyRequest;
                const slot = this.readExpectedSlot(request);
                return response(request.requestId, 'ok', await this.copyFileTransferEntries(
                    slot,
                    coordinator,
                    copy,
                ));
            }
            if (request.operation === 'preflightFileTransfer') {
                const preflight = request.fileTransfer as FileTransferPreflightRequest;
                const slot = this.readExpectedSlot(request);
                return response(request.requestId, 'ok', await this.preflightFileTransfer(
                    slot,
                    coordinator,
                    preflight,
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

    private evictFileTransferHandles(): void {
        const evict = <T>(entries: Map<string, T>, maximum: number): void => {
            while (entries.size > maximum) {
                const oldest = entries.keys().next().value as string | undefined;
                if (!oldest) { return; }
                entries.delete(oldest);
            }
        };
        evict(this.fileTransferRoots, FILE_TRANSFER_ROOT_MAX_ENTRIES);
        evict(this.fileTransferRemoteDirectories, FILE_TRANSFER_HANDLE_MAX_ENTRIES);
        evict(this.fileTransferRemoteEntries, FILE_TRANSFER_HANDLE_MAX_ENTRIES);
        for (const root of this.fileTransferRoots.values()) {
            evict(root.directories, FILE_TRANSFER_HANDLE_MAX_ENTRIES);
            evict(root.entries, FILE_TRANSFER_HANDLE_MAX_ENTRIES);
        }
    }

    private async selectFileTransferLocalRoot(): Promise<FileTransferLocalRootResponse | null> {
        if (!this.localActions) {
            throw new Error('Local folder selection is unavailable.');
        }
        const selected = await this.localActions.selectLocalDirectory();
        if (!selected) { return null; }
        const rootPath = await realpath(selected);
        const rootDetails = await stat(rootPath);
        if (!rootDetails.isDirectory()) {
            throw new Error('The selected local path is not a directory.');
        }
        const rootId = this.fileTransferHandle();
        const directoryId = this.fileTransferHandle();
        const label = path.basename(rootPath) || rootPath;
        this.fileTransferRoots.set(rootId, {
            path: rootPath,
            device: rootDetails.dev,
            inode: rootDetails.ino,
            label,
            directories: new Map([[directoryId, rootPath]]),
            entries: new Map(),
        });
        this.evictFileTransferHandles();
        return this.listFileTransferLocalDirectory(rootId, directoryId);
    }

    private async listFileTransferLocalDirectory(
        rootId: string,
        directoryId: string | undefined,
        navigationPath?: string,
    ): Promise<FileTransferLocalRootResponse> {
        const root = this.fileTransferRoots.get(rootId);
        if (!root) {
            throw new Error('The selected local folder is no longer available. Choose it again.');
        }
        const resolvedDirectoryId = navigationPath === undefined
            ? directoryId || Array.from(root.directories.keys())[0]
            : this.fileTransferHandle();
        const directoryPath = navigationPath === undefined
            ? resolvedDirectoryId ? root.directories.get(resolvedDirectoryId) : undefined
            : path.join(root.path, navigationPath);
        if (!directoryPath) {
            throw new Error('The selected local directory is no longer available. Refresh the folder.');
        }
        const currentPath = await realpath(directoryPath);
        if (!this.isWithinLocalRoot(root.path, currentPath)
            || !(await stat(currentPath)).isDirectory()) {
            throw new Error('The selected local directory is outside the approved folder.');
        }
        root.directories.set(resolvedDirectoryId, currentPath);
        for (const [entryId, entry] of root.entries) {
            if (entry.directoryId === resolvedDirectoryId) { root.entries.delete(entryId); }
        }
        const entries: FileTransferDirectoryEntry[] = [];
        const directory = await opendir(currentPath);
        for await (const child of directory) {
                if (entries.length >= 1_001) { break; }
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
                    directoryId: resolvedDirectoryId,
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
        this.evictFileTransferHandles();
        const hasMore = entries.length > 1_000;
        entries.sort((left, right) => {
            if (left.kind === 'directory' && right.kind !== 'directory') { return -1; }
            if (left.kind !== 'directory' && right.kind === 'directory') { return 1; }
            return left.name.localeCompare(right.name);
        });
        const relativePath = path.relative(root.path, currentPath).split(path.sep).join('/') || '.';
        return {
            rootId, directoryId: resolvedDirectoryId, label: root.label,
            displayPath: relativePath, entries: entries.slice(0, 1_000),
            ...(hasMore ? { hasMore: true } : {}),
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
        navigationPath?: string,
    ): Promise<FileTransferLocalRootResponse> {
        const view = materializeManagedRemoteCatalog(slot.document);
        const target = resolveManagedMachineTarget(view, machineId);
        await this.ensureProjectionReady(slot);
        let resolvedDirectoryId = directoryId;
        let directory: FileTransferRemoteDirectory | undefined;
        if (navigationPath !== undefined) {
            resolvedDirectoryId = this.fileTransferHandle();
            directory = {
                machineId, revisionId: slot.revisionId, path: navigationPath, kind: 'directory', directoryId: resolvedDirectoryId,
            };
            this.fileTransferRemoteDirectories.set(resolvedDirectoryId, directory);
        } else if (resolvedDirectoryId) {
            directory = this.fileTransferRemoteDirectories.get(resolvedDirectoryId);
            if (!directory || directory.machineId !== machineId || directory.revisionId !== slot.revisionId) {
                throw new Error('The selected remote directory is no longer available. Refresh the Machine.');
            }
        } else {
            resolvedDirectoryId = this.fileTransferHandle();
            directory = {
                machineId, revisionId: slot.revisionId,
                path: await remoteLoginDirectory(coordinator.getExecutable(), target.alias),
                kind: 'directory',
                directoryId: resolvedDirectoryId,
            };
            this.fileTransferRemoteDirectories.set(resolvedDirectoryId, directory);
        }
        const rows = await listRemoteDirectory(coordinator.getExecutable(), target.alias, directory.path);
        const hasMore = rows.length > 1_000;
        const entries: FileTransferDirectoryEntry[] = rows.slice(0, 1_000).map(row => {
            const id = this.fileTransferHandle();
            const entryPath = remoteChildPath(directory!.path, row.name);
            this.fileTransferRemoteEntries.set(id, {
                machineId, revisionId: slot.revisionId, path: entryPath, kind: row.kind,
                ...(row.size === undefined ? {} : { size: row.size }),
                directoryId: resolvedDirectoryId!,
            });
            if (row.kind === 'directory') {
                this.fileTransferRemoteDirectories.set(id, {
                    machineId, revisionId: slot.revisionId,
                    path: entryPath,
                    kind: 'directory',
                    directoryId: id,
                });
            }
            return {
                id, name: row.name, kind: row.kind,
                ...(row.size === undefined ? {} : { size: row.size }),
                ...(row.modifiedAt === undefined ? {} : { modifiedAt: row.modifiedAt }),
            };
        });
        this.evictFileTransferHandles();
        return {
            rootId: machineIdToTransferRootId(machineId),
            directoryId: resolvedDirectoryId,
            label: target.machine.name,
            displayPath: directory.path,
            entries,
            ...(hasMore ? { hasMore: true } : {}),
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
        const active: ActiveFileTransferCopy = {
            cancelled: false,
            phase: 'preparing',
            completedItems: 0,
            skippedItems: 0,
            totalItems: request.entryIds.length,
        };
        noteFileTransferActivity(active, 'preparing');
        this.activeFileTransferCopies.set(request.taskId, active);
        let completedItems = 0;
        let skippedItems = 0;
        try {
            const source = await this.resolveFileTransferSource(slot, request.source, request.entryIds);
            const destination = await this.resolveFileTransferDestination(slot, request.destination);
            const targetName = this.resolveFileTransferTargetName(source.entries, request.targetName);
            const reviewedTrees = await this.takeReviewedFileTransferTrees(
                request.source, request.entryIds, source, coordinator.getExecutable(),
            );
            for (const entry of source.entries) {
                if (active.cancelled) { throw new Error('File copy was cancelled.'); }
                active.currentItemName = path.basename(entry.path).slice(0, 255);
                active.phase = 'preparing';
                noteFileTransferActivity(active, 'preparing');
                let entryTree: FileTransferTreeSummary | undefined;
                if (entry.kind === 'directory') {
                    entryTree = reviewedTrees?.get(entry.id) || (source.kind === 'local'
                        ? await inspectLocalFileTransferTree(entry.path)
                        : undefined);
                }
                const destinationPath = destination.kind === 'local'
                    ? path.join(destination.path, targetName || path.basename(entry.path))
                    : remoteChildPath(destination.path, targetName || path.basename(entry.path));
                const collisionKind = destination.kind === 'local'
                    ? await localPathKind(destinationPath)
                    : await remotePathKind(
                        coordinator.getExecutable(), destination.alias, destinationPath,
                    );
                if (collisionKind) {
                    if (request.conflictPolicy === 'skip') {
                        skippedItems += 1;
                        active.skippedItems = skippedItems;
                        continue;
                    }
                    if (request.conflictPolicy !== 'replace') {
                        throw new Error(`Copy target already exists: ${path.basename(entry.path)}. Choose another folder or select a conflict policy.`);
                    }
                    if (entry.kind !== 'file' || collisionKind !== 'file') {
                        throw new Error(`File Transfer cannot safely replace an existing folder or non-file: ${path.basename(entry.path)}. Choose Skip existing or another folder.`);
                    }
                }
                // Never stream into the visible destination. A verified
                // sibling is published only after copy completion, so Replace
                // cannot corrupt the original on interruption and a failed
                // folder copy leaves no collision that blocks retry.
                const temporaryPath = fileTransferTemporaryPath(destinationPath, destination.kind === 'managedMachine');
                const temporaryDestination: FileTransferPathEndpoint = destination.kind === 'local'
                    ? { kind: 'local', path: temporaryPath }
                    : { kind: 'managedMachine', alias: destination.alias, path: temporaryPath };
                try {
                const stableLocalSource = source.kind === 'local'
                    ? await openStableLocalFileTransferSource(
                        entry.localRootPath!, entry.localRootIdentity!, entry.path, entry.kind,
                    ) : undefined;
                try {
                const legacyScp = !await scpUsesSftpByDefault(coordinator.getExecutable());
                const copySource = source.kind === 'managedMachine'
                    ? scpRemotePath(source.alias, entry.path, legacyScp) : stableLocalSource!.path;
                const copyDestination = destination.kind === 'managedMachine'
                    ? scpRemotePath(destination.alias, temporaryPath, legacyScp) : temporaryPath;
                const archiveSource = source.kind === 'local'
                    ? { kind: 'local' as const, path: entry.path, sourceFd: stableLocalSource!.fd }
                    : { kind: 'managedMachine' as const, alias: source.alias, path: entry.path };
                const archiveDestination = temporaryDestination;
                if (entry.kind === 'directory') {
                    // A single tar producer/consumer pair preserves symbolic
                    // links and avoids recursively launching SFTP once for
                    // every nested remote folder before the stream can start.
                    // Data still only flows through this UI Bridge process;
                    // no relay archive is written to disk.
                    active.phase = source.kind === 'managedMachine' ? 'downloading' : 'uploading';
                    active.hop = 'source-to-target';
                    await createFileTransferDirectory(coordinator.getExecutable(), archiveDestination, active);
                    if (active.cancelled) { throw new Error('File copy was cancelled.'); }
                    await copyFileTransferFolderArchive(
                        coordinator.getExecutable(), archiveSource, archiveDestination, active,
                    );
                } else if (source.kind === 'managedMachine' && destination.kind === 'managedMachine') {
                    const totalBytes = entry.kind === 'file' && Number.isSafeInteger(entry.size)
                        ? entry.size : undefined;
                    await relayFileTransferEntry(
                        coordinator.getExecutable(), false, copySource,
                        copyDestination, active, totalBytes,
                        () => remoteFileSize(coordinator.getExecutable(), destination.alias, temporaryPath),
                    );
                } else {
                    active.phase = source.kind === 'managedMachine' ? 'downloading' : 'uploading';
                    active.hop = 'source-to-target';
                    const totalBytes = entry.kind === 'file' && Number.isSafeInteger(entry.size)
                        ? entry.size : undefined;
                    await copyFileTransferEntry(
                        coordinator.getExecutable(), false, copySource,
                        copyDestination, active, totalBytes,
                        destination.kind === 'local'
                            ? () => localFileTransferProgressBytes(temporaryPath)
                            : () => remoteFileSize(coordinator.getExecutable(), destination.alias, temporaryPath),
                        false, stableLocalSource?.fd,
                    );
                }
                active.phase = 'verifying';
                noteFileTransferActivity(active, 'verifying');
                if (entry.kind === 'directory' && entryTree) {
                    await verifyCopiedFileTransferTree(
                        entryTree, temporaryDestination, temporaryPath, coordinator.getExecutable(),
                    );
                } else if (entry.kind === 'directory') {
                    const copiedKind = destination.kind === 'local'
                        ? await localPathKind(temporaryPath)
                        : await remotePathKind(
                            coordinator.getExecutable(), destination.alias, temporaryPath,
                        );
                    if (copiedKind !== 'directory') {
                        throw new Error(`File copy did not create the target folder: ${path.basename(entry.path)}.`);
                    }
                } else if (entry.kind === 'file') {
                    const copiedSize = destination.kind === 'local'
                        ? await localFileSize(temporaryPath)
                        : await remoteFileSize(
                            coordinator.getExecutable(), destination.alias, temporaryPath,
                        );
                    if (Number.isSafeInteger(entry.size) && copiedSize !== entry.size) {
                        throw new Error(`File copy did not pass size verification: ${path.basename(entry.path)}.`);
                    }
                }
                if (active.cancelled) { throw new Error('File copy was cancelled.'); }
                await publishFileTransferTemporaryPath(
                    coordinator.getExecutable(), temporaryDestination,
                    destination.kind === 'local'
                        ? { kind: 'local', path: destinationPath }
                        : { kind: 'managedMachine', alias: destination.alias, path: destinationPath },
                    active,
                    collisionKind === 'file' && request.conflictPolicy === 'replace',
                );
                // Publishing is a separate race boundary. Verify the visible
                // result too; a remote command must never turn a staged copy
                // into an apparently successful write at another path.
                const publishedDestination: FileTransferPathEndpoint = destination.kind === 'local'
                    ? { kind: 'local', path: destinationPath }
                    : { kind: 'managedMachine', alias: destination.alias, path: destinationPath };
                if (entry.kind === 'directory' && entryTree) {
                    await verifyCopiedFileTransferTree(
                        entryTree, publishedDestination, destinationPath, coordinator.getExecutable(),
                    );
                } else if (entry.kind === 'directory') {
                    const publishedKind = destination.kind === 'local'
                        ? await localPathKind(destinationPath)
                        : await remotePathKind(coordinator.getExecutable(), destination.alias, destinationPath);
                    if (publishedKind !== 'directory') {
                        throw new Error(`File copy was not published to the target folder: ${path.basename(entry.path)}.`);
                    }
                } else if (Number.isSafeInteger(entry.size)) {
                    const publishedSize = destination.kind === 'local'
                        ? await localFileSize(destinationPath)
                        : await remoteFileSize(coordinator.getExecutable(), destination.alias, destinationPath);
                    if (publishedSize !== entry.size) {
                        throw new Error(`File copy did not pass final size verification: ${path.basename(entry.path)}.`);
                    }
                }
                } finally {
                    await stableLocalSource?.close();
                }
                } catch (error) {
                    await discardFileTransferTemporaryPath(coordinator.getExecutable(), temporaryDestination);
                    throw error;
                }
                completedItems += 1;
                active.completedItems = completedItems;
            }
        } catch (error) {
            if (active.cancelled) {
                return {
                    status: 'cancelled', completedItems, skippedItems, totalItems: request.entryIds.length,
                };
            }
            const diagnostic = fileTransferFailureDiagnostic(error, active);
            const message = boundedFileTransferFailureMessage(error);
            this.reportDiagnostic?.(
                `File Transfer failed: phase=${diagnostic.phase} hop=${diagnostic.hop} code=${diagnostic.code}`
                    + ` item=${active.currentItemName || 'unknown'} message=${message}`,
            );
            return {
                status: 'failed', completedItems, skippedItems, totalItems: request.entryIds.length,
                message,
                diagnostic,
            };
        } finally {
            stopFileTransferProgressMonitor(active);
            this.activeFileTransferCopies.delete(request.taskId);
        }
        return { status: 'copied', completedItems, skippedItems, totalItems: request.entryIds.length };
    }

    private async preflightFileTransfer(
        slot: ManagedRevisionSlot,
        coordinator: ManagedSshConsentCoordinator,
        request: FileTransferPreflightRequest,
    ): Promise<FileTransferPreflightResult> {
        const reviewKey = this.fileTransferTreeReviewKey(request.source, request.entryIds);
        this.evictReviewedFileTransferTrees();
        // A new review supersedes an old one even when this attempt finds an
        // unsafe source and throws before producing a replacement manifest.
        this.reviewedFileTransferTrees.delete(reviewKey);
        const source = await this.resolveFileTransferSource(slot, request.source, request.entryIds);
        const destination = await this.resolveFileTransferDestination(slot, request.destination);
        const targetName = this.resolveFileTransferTargetName(source.entries, request.targetName);
        const existingFileNames: string[] = [];
        const existingDirectoryNames: string[] = [];
        const reviewedTrees = new Map<string, FileTransferTreeSummary>();
        const reviewedFingerprints = new Map<string, string>();
        let knownBytes = 0;
        let unknownSizeItems = 0;
        for (const entry of source.entries) {
            let entryTree: FileTransferTreeSummary | undefined;
            if (entry.kind === 'directory') {
                if (source.kind === 'local') {
                    entryTree = await inspectLocalFileTransferTree(entry.path);
                } else {
                    // Folder copy is a single streamed archive operation. Do
                    // not recursively open every remote child directory in
                    // the control plane before that operation begins.
                }
            } else if (source.kind === 'local') {
                try {
                    await access(entry.path, constants.R_OK);
                } catch (_error) {
                    throw new Error(`The selected source is no longer readable: ${path.basename(entry.path)}.`);
                }
            } else {
                // The entry was already supplied by a successful SFTP directory
                // listing. Do not reclassify it with `lstat`: several SFTP
                // servers omit type details for that command, making a listed
                // regular file look as if it vanished. `ls -l` is the same
                // path-specific format used for post-copy verification and
                // refreshes the size that the progress UI will report.
                try {
                    entry.size = await remoteFileSize(coordinator.getExecutable(), source.alias, entry.path);
                } catch (error) {
                    const reason = boundedFileTransferFailureMessage(error);
                    this.reportDiagnostic?.(
                        `File Transfer source probe failed: item=${path.basename(entry.path)} reason=${reason}`,
                    );
                    throw new Error(`File Transfer could not read the selected source: ${path.basename(entry.path)}. Refresh Source and choose it again.`);
                }
            }
            if (entryTree) {
                reviewedTrees.set(entry.id, entryTree);
                reviewedFingerprints.set(entry.id, await this.fileTransferEntryFingerprint(
                    source, entry, coordinator.getExecutable(),
                ));
                if (knownBytes <= Number.MAX_SAFE_INTEGER - entryTree.knownBytes) {
                    knownBytes += entryTree.knownBytes;
                } else {
                    unknownSizeItems += 1;
                }
                unknownSizeItems += entryTree.unknownSizeItems;
            } else if (entry.kind === 'directory') {
                unknownSizeItems += 1;
            } else {
                const summary: FileTransferTreeSummary = { knownBytes, unknownSizeItems, files: [], links: [] };
                addKnownFileTransferBytes(summary, entry.size);
                knownBytes = summary.knownBytes;
                unknownSizeItems = summary.unknownSizeItems;
            }
            const destinationPath = destination.kind === 'local'
                ? path.join(destination.path, targetName || path.basename(entry.path))
                : remoteChildPath(destination.path, targetName || path.basename(entry.path));
            const existingKind = destination.kind === 'local'
                ? await localPathKind(destinationPath)
                : await remotePathKind(coordinator.getExecutable(), destination.alias, destinationPath);
            if (existingKind === 'file') {
                existingFileNames.push(path.basename(entry.path));
            } else if (existingKind) {
                existingDirectoryNames.push(path.basename(entry.path));
            }
        }
        if (reviewedTrees.size > 0) {
            this.reviewedFileTransferTrees.set(
                reviewKey,
                {
                    expiresAt: Date.now() + FILE_TRANSFER_TREE_REVIEW_TTL_MS,
                    trees: reviewedTrees,
                    fingerprints: reviewedFingerprints,
                },
            );
            this.evictReviewedFileTransferTrees();
        }
        return {
            totalItems: source.entries.length,
            knownBytes,
            unknownSizeItems,
            existingFileNames,
            existingDirectoryNames,
        };
    }

    private fileTransferTreeReviewKey(endpoint: FileTransferEndpointReference, entryIds: string[]): string {
        const source = endpoint.kind === 'local'
            ? `local:${endpoint.rootId}:${endpoint.directoryId}`
            : `managed:${endpoint.machineId}:${endpoint.directoryId}`;
        return `${source}:${entryIds.join(':')}`;
    }

    private async takeReviewedFileTransferTrees(
        endpoint: FileTransferEndpointReference,
        entryIds: string[],
        source: { kind: 'local'; entries: ResolvedFileTransferEntry[] } | {
            kind: 'managedMachine'; alias: string; entries: ResolvedFileTransferEntry[];
        },
        sshExecutable: string,
    ): Promise<Map<string, FileTransferTreeSummary> | undefined> {
        this.evictReviewedFileTransferTrees();
        const key = this.fileTransferTreeReviewKey(endpoint, entryIds);
        const review = this.reviewedFileTransferTrees.get(key);
        this.reviewedFileTransferTrees.delete(key);
        if (!review || review.expiresAt < Date.now()) { return undefined; }
        for (const entry of source.entries) {
            if (!review.trees.has(entry.id)) { continue; }
            const fingerprint = await this.fileTransferEntryFingerprint(source, entry, sshExecutable);
            if (fingerprint !== review.fingerprints.get(entry.id)) { return undefined; }
        }
        return review.trees;
    }

    private async fileTransferEntryFingerprint(
        source: { kind: 'local'; entries: ResolvedFileTransferEntry[] } | {
            kind: 'managedMachine'; alias: string; entries: ResolvedFileTransferEntry[];
        },
        entry: ResolvedFileTransferEntry,
        sshExecutable: string,
    ): Promise<string> {
        return source.kind === 'local'
            ? localFileTransferEntryFingerprint(entry)
            : remoteFileTransferEntryFingerprint(sshExecutable, source.alias, entry);
    }

    private evictReviewedFileTransferTrees(): void {
        const now = Date.now();
        for (const [key, review] of this.reviewedFileTransferTrees) {
            if (review.expiresAt < now) { this.reviewedFileTransferTrees.delete(key); }
        }
        while (this.reviewedFileTransferTrees.size > FILE_TRANSFER_TREE_REVIEW_MAX_ENTRIES) {
            const oldest = this.reviewedFileTransferTrees.keys().next().value as string | undefined;
            if (!oldest) { break; }
            this.reviewedFileTransferTrees.delete(oldest);
        }
    }

    private cancelFileTransferCopy(taskId: string): { cancelled: boolean } {
        const active = this.activeFileTransferCopies.get(taskId);
        if (!active) { return { cancelled: false }; }
        active.cancelled = true;
        for (const process of active.processes || (active.process ? [active.process] : [])) {
            stopFileTransferProcess(process);
        }
        stopFileTransferProgressMonitor(active);
        return { cancelled: true };
    }

    private getFileTransferCopyStatus(taskId: string): FileTransferCopyStatus | { status: 'unknown' } {
        const active = this.activeFileTransferCopies.get(taskId);
        if (!active) { return { status: 'unknown' }; }
        return {
            status: 'running',
            phase: active.phase || 'preparing',
            completedItems: active.completedItems || 0,
            skippedItems: active.skippedItems || 0,
            totalItems: active.totalItems || 0,
            ...(active.currentItemName ? { currentItemName: active.currentItemName } : {}),
            ...(active.hop ? { hop: active.hop } : {}),
            ...(Number.isSafeInteger(active.transferredBytes) && active.transferredBytes! >= 0
                && Number.isSafeInteger(active.totalBytes) && active.totalBytes! >= 0
                ? { transferredBytes: active.transferredBytes, totalBytes: active.totalBytes } : {}),
            ...(Number.isSafeInteger(active.bytesPerSecond) && active.bytesPerSecond! >= 0
                ? { bytesPerSecond: active.bytesPerSecond } : {}),
            ...(active.activity ? { activity: active.activity } : {}),
            ...(Number.isSafeInteger(active.lastActivityAt) && active.lastActivityAt! >= 0
                ? { lastActivityAt: active.lastActivityAt } : {}),
        };
    }

    private resolveFileTransferTargetName(entries: FileTransferEntry[], targetName: string | undefined): string | undefined {
        if (targetName === undefined) { return undefined; }
        if (entries.length !== 1 || entries[0].kind !== 'file'
            || !/^(?!\.\.?$)[^\\/\0\r\n]{1,255}$/u.test(targetName)) {
            throw new Error('A destination name is available only for one regular file.');
        }
        return targetName;
    }

    private async resolveFileTransferSource(
        slot: ManagedRevisionSlot,
        endpoint: FileTransferEndpointReference,
        entryIds: string[],
    ): Promise<{ kind: 'local'; entries: ResolvedFileTransferEntry[] } | {
        kind: 'managedMachine'; alias: string; entries: ResolvedFileTransferEntry[];
    }> {
        if (endpoint.kind === 'local') {
            const root = this.fileTransferRoots.get(endpoint.rootId);
            if (!root || !root.directories.has(endpoint.directoryId)) {
                throw new Error('The selected local source is no longer available. Browse it again.');
            }
            const entries = entryIds.map(id => ({ id, entry: root.entries.get(id) }));
            if (entries.some(({ entry }) => !entry || entry.directoryId !== endpoint.directoryId
                || entry.kind === 'symlink' || entry.kind === 'unsupported')) {
                throw new Error('Select only regular files or folders from the current local directory.');
            }
            const resolvedEntries: ResolvedFileTransferEntry[] = [];
            for (const { id, entry } of entries) {
                const listed = entry!;
                let details: Stats;
                let currentPath: string;
                try {
                    // Re-check the exact directory item immediately before
                    // preflight/copy. A stale opaque ID must not become an
                    // authority to follow a symlink swapped in after listing.
                    details = await lstat(listed.path);
                    currentPath = await realpath(listed.path);
                } catch {
                    throw new Error('The selected local source is no longer available. Refresh Source and choose it again.');
                }
                const currentKind = details.isDirectory() ? 'directory'
                    : details.isFile() ? 'file' : details.isSymbolicLink() ? 'symlink' : 'unsupported';
                if (currentKind !== listed.kind || currentKind === 'symlink'
                    || !this.isWithinLocalRoot(root.path, currentPath)) {
                    throw new Error('The selected local source is no longer available. Refresh Source and choose it again.');
                }
                resolvedEntries.push({
                    id, ...listed, path: currentPath, localRootPath: root.path,
                    localRootIdentity: { device: root.device, inode: root.inode },
                });
            }
            return { kind: 'local', entries: resolvedEntries };
        }
        const target = resolveManagedMachineTarget(
            materializeManagedRemoteCatalog(slot.document), endpoint.machineId,
        );
        await this.ensureProjectionReady(slot);
        const entries = entryIds.map(id => ({ id, entry: this.fileTransferRemoteEntries.get(id) }));
        if (entries.some(({ entry }) => !entry || entry.machineId !== endpoint.machineId
            || entry.directoryId !== endpoint.directoryId
            || entry.revisionId !== slot.revisionId
            || entry.kind === 'symlink' || entry.kind === 'unsupported')) {
            throw new Error('The selected Managed Machine directory changed. Refresh Source and choose the items again.');
        }
        return { kind: 'managedMachine', alias: target.alias, entries: entries.map(({ id, entry }) => ({ id, ...entry! })) };
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
            try {
                await access(resolvedPath, constants.W_OK | constants.X_OK);
            } catch (_error) {
                throw new Error('The selected local destination is not writable. Choose another folder.');
            }
            return { kind: 'local', path: resolvedPath };
        }
        const directory = this.fileTransferRemoteDirectories.get(endpoint.directoryId);
        if (!directory || directory.machineId !== endpoint.machineId || directory.revisionId !== slot.revisionId) {
            throw new Error('The selected Managed Machine destination changed. Browse it again.');
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
