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
            if (/not enabled on this computer/i.test(message)) {
                return response(request.requestId, 'clientNotEnabled', error);
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
