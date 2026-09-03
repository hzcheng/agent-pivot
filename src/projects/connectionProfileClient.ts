'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
    PROJECT_CLIENT_HANDSHAKE_COMMAND,
    PROJECT_CLIENT_PROTOCOL_VERSION,
    PROJECT_CLIENT_UPDATE_PROFILE_COMMAND,
    ProjectClientSnapshot,
    ProjectConnectionKind,
    ProjectConnectionProfile,
    validateProjectClientHandshakeResponse,
    validateProjectConnectionProfileUpdateOutcome,
    validateProjectMachineId,
} from './projectClientProtocol';

export interface ConnectionProfileClientDependencies {
    mainExtensionVersion?: string;
    executeCommand?: (command: string, argument: unknown) => PromiseLike<unknown>;
    createRequestId?: () => string;
}

export default class ConnectionProfileClient {
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly mainExtensionVersion: string;
    private readonly executeCommand: (command: string, argument: unknown) => PromiseLike<unknown>;
    private readonly createRequestId: () => string;

    public constructor(dependencies: ConnectionProfileClientDependencies = {}) {
        this.mainExtensionVersion = dependencies.mainExtensionVersion || 'unknown';
        this.executeCommand = dependencies.executeCommand
            || ((command, argument) => vscode.commands.executeCommand(command, argument));
        this.createRequestId = dependencies.createRequestId
            || (() => crypto.randomBytes(16).toString('hex'));
    }

    public refresh(): Promise<ProjectClientSnapshot> {
        return this.enqueue(() => this.readSnapshot());
    }

    /** Always reads the UI-host authority; connection decisions must not use stale cached state. */
    public getProfile(machineId: string): Promise<ProjectConnectionProfile | null> {
        validateProjectMachineId(machineId);
        return this.enqueue(async () => {
            const snapshot = await this.readSnapshot();
            return snapshot.profiles.find(profile => profile.machineId === machineId) || null;
        });
    }

    public updateProfile(
        machineId: string,
        profile: {
            kind: ProjectConnectionKind;
            target: string | null;
            resolverAuthority: string | null;
        } | null,
    ): Promise<ProjectClientSnapshot> {
        validateProjectMachineId(machineId);
        return this.enqueue(async () => {
            const requestId = this.createRequestId();
            const outcome = validateProjectConnectionProfileUpdateOutcome(
                await this.executeCommand(PROJECT_CLIENT_UPDATE_PROFILE_COMMAND, {
                    protocolVersion: PROJECT_CLIENT_PROTOCOL_VERSION,
                    requestId,
                    machineId,
                    profile,
                }),
            );
            if (outcome.requestId !== requestId || outcome.machineId !== machineId) {
                throw new Error('project client profile update outcome correlation mismatch');
            }
            return outcome.snapshot;
        });
    }

    private async readSnapshot(): Promise<ProjectClientSnapshot> {
        const response = validateProjectClientHandshakeResponse(
            await this.executeCommand(PROJECT_CLIENT_HANDSHAKE_COMMAND, {
                protocolVersion: PROJECT_CLIENT_PROTOCOL_VERSION,
                mainExtensionVersion: this.mainExtensionVersion,
            }),
        );
        return response.snapshot;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
