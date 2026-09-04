'use strict';

import {
    readManagedActiveRevisionSlot,
    readManagedCurrentRevisionSlot,
} from '../../../src/projects/managedRemote/envelope';
import {
    ManagedRemoteBridgeRequest,
    ManagedRemoteBridgeResponse,
    MANAGED_REMOTE_BRIDGE_PROTOCOL_VERSION,
    parseManagedRemoteBridgeRequest,
} from '../../../src/projects/managedRemote/bridgeProtocol';
import { ManagedRevisionSlot } from '../../../src/projects/managedRemote/types';
import { materializeManagedRemoteCatalog } from '../../../src/projects/managedRemote/merge';
import { managedSshAlias } from '../../../src/projects/managedRemote/sshConfigProjection';
import { rebuildManagedDevContainerProjectUri } from '../../../src/projects/managedRemote/devContainerCodec';
import { ManagedSshConsentCoordinator } from './managedSshConsentCoordinator';

export interface ManagedRemoteBridgeCatalogReader {
    readManagedCatalogEnvelope(): unknown;
}

export interface ManagedRemoteBridgeCoordinatorFactory {
    create(): Promise<ManagedSshConsentCoordinator>;
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
}

export function formatManagedSshCommand(
    executable: string,
    alias: string,
    platform: NodeJS.Platform,
): string {
    if (platform === 'win32') {
        const quote = (value: string) => `"${value
            .replace(/(\\*)"/gu, '$1$1\\"')
            .replace(/(\\+)$/gu, '$1$1')}"`;
        return `${quote(executable)} ${quote(alias)}`;
    }
    const quote = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;
    return `${quote(executable)} ${quote(alias)}`;
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

function sshRemoteAuthority(alias: string): string {
    return `ssh-remote+${alias}`;
}

function remoteUri(authority: string, remotePath: string): string {
    return `vscode-remote://${encodeURIComponent(authority)}${remotePath}`;
}

function authorityFromRemoteUri(uri: string): string {
    const prefix = 'vscode-remote://';
    const remainder = uri.slice(prefix.length);
    return decodeURIComponent(remainder.slice(0, remainder.indexOf('/')));
}

export class ManagedRemoteBridgeController {
    constructor(
        private readonly catalog: ManagedRemoteBridgeCatalogReader,
        private readonly coordinators: ManagedRemoteBridgeCoordinatorFactory,
        private readonly sessionToken: string,
        private readonly localActions?: ManagedRemoteBridgeLocalActions,
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
            const coordinator = await this.coordinators.create();
            if (request.operation === 'inspectLegacySshTarget') {
                if (!this.localActions || !request.legacySshTarget) {
                    throw new Error('Legacy SSH inspection is unavailable.');
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
            if (request.operation === 'preflightDisable') {
                return response(
                    request.requestId,
                    'ok',
                    sanitizeLocalResult(coordinator.preflightDisable()),
                );
            }
            if (request.operation === 'beginDisable') {
                return response(
                    request.requestId,
                    'ok',
                    sanitizeLocalResult(await coordinator.beginDisable()),
                );
            }
            if (request.operation === 'confirmDisable') {
                return response(request.requestId, 'ok', await coordinator.confirmDisable());
            }
            if (request.operation === 'cancelTransition') {
                return response(
                    request.requestId,
                    'ok',
                    await coordinator.cancelPendingTransition(),
                );
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
            const slot = this.readExpectedSlot(
                request,
                request.operation === 'preflightEnable'
                    || request.operation === 'beginEnable'
                    || request.operation === 'confirmEnable',
            );
            if (request.operation === 'openManagedMachine'
                || request.operation === 'openManagedProject'
                || request.operation === 'openManagedEnvironment') {
                if (!this.localActions || !request.targetId) {
                    throw new Error('Managed Remote navigation is unavailable.');
                }
                const view = materializeManagedRemoteCatalog(slot.document);
                let machine = request.operation === 'openManagedMachine'
                    ? view.machines.find(value => value.id === request.targetId)
                    : undefined;
                let environment = request.operation === 'openManagedEnvironment'
                    ? view.environments.find(value => value.id === request.targetId)
                    : undefined;
                const project = request.operation === 'openManagedProject'
                    ? view.projects.find(value => value.id === request.targetId)
                    : undefined;
                if (project) {
                    environment = view.environments.find(value =>
                        value.id === project.environmentId);
                }
                if (environment) {
                    machine = view.machines.find(value => value.id === environment?.machineId);
                }
                if (!machine
                    || (request.operation === 'openManagedProject' && (!project || !environment))
                    || (request.operation === 'openManagedEnvironment' && !environment)) {
                    throw new Error('Managed Remote navigation target no longer exists.');
                }
                const blockedIds = new Set<string>();
                for (const conflict of view.conflicts) {
                    blockedIds.add(conflict.entityId);
                    for (const relatedId of conflict.relatedEntityIds || []) {
                        blockedIds.add(relatedId);
                    }
                }
                if (blockedIds.has(machine.id)
                    || (environment && blockedIds.has(environment.id))
                    || (project && blockedIds.has(project.id))) {
                    throw new Error('Managed Remote navigation target has an unresolved conflict.');
                }
                await coordinator.reconcile(slot);
                const alias = managedSshAlias(machine.id);
                if (request.operation === 'openManagedMachine') {
                    await this.localActions.openRemoteWindow(sshRemoteAuthority(alias));
                } else if (environment?.kind === 'devContainer') {
                    const uri = rebuildManagedDevContainerProjectUri(
                        environment.devContainerAnchor!,
                        alias,
                        project?.remotePath || '/',
                    );
                    if (!uri) {
                        throw new Error('Managed Dev Container authority could not be rebuilt.');
                    }
                    if (project) {
                        await this.localActions.openRemoteFolder(uri);
                    } else {
                        await this.localActions.openRemoteWindow(authorityFromRemoteUri(uri));
                    }
                } else if (project) {
                    await this.localActions.openRemoteFolder(remoteUri(
                        sshRemoteAuthority(alias),
                        project.remotePath,
                    ));
                } else {
                    throw new Error('Only Dev Container Environments open independently.');
                }
                return response(request.requestId, 'ok', {
                    targetId: request.targetId,
                    machineId: machine.id,
                    alias,
                });
            }
            if (request.operation === 'openLocalSshTerminal'
                || request.operation === 'copyLocalSshCommand') {
                if (!this.localActions || !request.targetId) {
                    throw new Error('Managed Remote local SSH actions are unavailable.');
                }
                const view = materializeManagedRemoteCatalog(slot.document);
                const machine = view.machines.find(value => value.id === request.targetId);
                if (!machine || view.conflicts.some(conflict =>
                    conflict.entityType === 'machine' && conflict.entityId === request.targetId)) {
                    throw new Error('Managed Machine is missing or has a connection conflict.');
                }
                await coordinator.reconcile(slot);
                const alias = managedSshAlias(machine.id);
                if (request.operation === 'openLocalSshTerminal') {
                    await this.localActions.openTerminal({
                        name: `SSH: ${machine.name}`,
                        shellPath: coordinator.getExecutable(),
                        shellArgs: [alias],
                    });
                } else {
                    await this.localActions.writeClipboard(formatManagedSshCommand(
                        coordinator.getExecutable(),
                        alias,
                        this.localActions.platform,
                    ));
                }
                return response(request.requestId, 'ok', {
                    machineId: machine.id,
                    machineName: machine.name,
                    alias,
                });
            }
            if (request.operation === 'preflightEnable') {
                return response(
                    request.requestId,
                    'ok',
                    sanitizeLocalResult(await coordinator.preflightEnable(slot)),
                );
            }
            if (request.operation === 'beginEnable') {
                return response(
                    request.requestId,
                    'ok',
                    sanitizeLocalResult(await coordinator.beginEnable(slot)),
                );
            }
            if (request.operation === 'confirmEnable') {
                return response(request.requestId, 'ok', await coordinator.confirmEnable(slot));
            }
            if (request.operation === 'reconcile') {
                return response(request.requestId, 'ok', await coordinator.reconcile(slot));
            }
            throw new Error('Unsupported Managed Remote bridge operation.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/catalog revision|active Managed Remote catalog/i.test(message)) {
                return response(request.requestId, 'catalogOutOfDate', error);
            }
            if (/not enabled on this computer/i.test(message)) {
                return response(request.requestId, 'clientNotEnabled', error);
            }
            if (/recovery/i.test(message)) {
                return response(request.requestId, 'recoveryRequired', error);
            }
            return response(request.requestId, 'failed', error);
        }
    }

    private readExpectedSlot(
        request: ManagedRemoteBridgeRequest,
        allowPreview = false,
    ): ManagedRevisionSlot {
        const raw = this.catalog.readManagedCatalogEnvelope();
        const slot = allowPreview
            ? readManagedCurrentRevisionSlot(raw) : activeSlot(raw);
        if (!slot) {
            throw new Error('There is no unambiguous active Managed Remote catalog.');
        }
        if (slot.revisionId !== request.expectedRevisionId) {
            throw new Error('Managed Remote catalog revision is out of date.');
        }
        return slot;
    }
}
