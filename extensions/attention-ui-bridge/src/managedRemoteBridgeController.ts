'use strict';

import { randomBytes } from 'crypto';
import { lstat, opendir, realpath, stat } from 'fs/promises';
import * as path from 'path';
import { readManagedActiveRevisionSlot } from '../../../src/projects/managedRemote/envelope';
import {
    FileTransferDirectoryEntry,
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

export class ManagedRemoteBridgeController {
    private readonly fileTransferRoots = new Map<string, FileTransferLocalRoot>();
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
                return response(request.requestId, 'ok', await this.listFileTransferLocalDirectory(
                    request.fileTransfer!.rootId,
                    request.fileTransfer!.directoryId,
                ));
            }
            const coordinator = await this.coordinators.create();
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
        return { rootId, directoryId: resolvedDirectoryId, label: root.label, entries };
    }

    private isWithinLocalRoot(rootPath: string, candidatePath: string): boolean {
        const relative = path.relative(rootPath, candidatePath);
        return relative === '' || (!relative.startsWith(`..${path.sep}`)
            && relative !== '..' && !path.isAbsolute(relative));
    }

    private fileTransferHandle(): string {
        return randomBytes(16).toString('hex');
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
