'use strict';

import * as crypto from 'crypto';

import {
    createProjectClientSnapshot,
    ProjectClientSnapshot,
    ProjectConnectionProfile,
    ProjectConnectionProfileUpdateOutcome,
    ProjectConnectionProfileUpdateRequest,
    validateProjectConnectionProfile,
    validateProjectConnectionProfileUpdateRequest,
} from '../../../src/projects/projectClientProtocol';

const PROJECT_CLIENT_ID_KEY = 'projectClient.identity.v1';
const PROJECT_CONNECTION_PROFILES_KEY = 'projectClient.connectionProfiles.v1';

interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

interface StoredProjectConnectionProfilesV1 {
    schemaVersion: 1;
    profiles: ProjectConnectionProfile[];
}

export interface ProjectClientStoreDependencies {
    createClientId?: () => string;
    now?: () => number;
}

function readProfiles(value: unknown): ProjectConnectionProfile[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [];
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join('\n') !== ['profiles', 'schemaVersion'].join('\n')
        || record.schemaVersion !== 1
        || !Array.isArray(record.profiles)) {
        return [];
    }
    try {
        return record.profiles.map(validateProjectConnectionProfile);
    } catch (_error) {
        return [];
    }
}

export class ProjectClientStore {
    private mutationQueue: Promise<void> = Promise.resolve();
    private clientIdFlight: Promise<string> | null = null;

    public constructor(
        private readonly state: MementoLike,
        private readonly dependencies: ProjectClientStoreDependencies = {},
    ) {
    }

    public async getSnapshot(): Promise<ProjectClientSnapshot> {
        const clientId = await this.ensureClientId();
        return createProjectClientSnapshot(
            clientId,
            readProfiles(this.state.get<StoredProjectConnectionProfilesV1>(
                PROJECT_CONNECTION_PROFILES_KEY,
            )),
        );
    }

    public updateProfile(raw: unknown): Promise<ProjectConnectionProfileUpdateOutcome> {
        const request = validateProjectConnectionProfileUpdateRequest(raw);
        let outcome: ProjectConnectionProfileUpdateOutcome | undefined;
        const operation = async () => {
            const current = await this.getSnapshot();
            const byMachineId = new Map(
                current.profiles.map(profile => [profile.machineId, profile]),
            );
            if (request.profile === null) {
                byMachineId.delete(request.machineId);
            } else {
                byMachineId.set(request.machineId, {
                    machineId: request.machineId,
                    kind: request.profile.kind,
                    target: request.profile.target,
                    updatedAtMs: this.now(),
                });
            }
            const profiles = Array.from(byMachineId.values());
            createProjectClientSnapshot(current.clientId, profiles);
            const stored: StoredProjectConnectionProfilesV1 = {
                schemaVersion: 1,
                profiles,
            };
            await this.state.update(PROJECT_CONNECTION_PROFILES_KEY, stored);
            outcome = {
                protocolVersion: 1,
                requestId: request.requestId,
                machineId: request.machineId,
                saved: request.profile !== null,
                snapshot: createProjectClientSnapshot(current.clientId, profiles),
            };
        };
        const result = this.mutationQueue.then(operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result.then(() => outcome as ProjectConnectionProfileUpdateOutcome);
    }

    private async ensureClientId(): Promise<string> {
        const current = this.state.get<unknown>(PROJECT_CLIENT_ID_KEY);
        if (typeof current === 'string' && /^[a-f0-9]{32}$/.test(current)) {
            return current;
        }
        if (this.clientIdFlight) {
            return this.clientIdFlight;
        }
        const initialize = async () => {
            const clientId = (this.dependencies.createClientId
                || (() => crypto.randomBytes(16).toString('hex')))();
            if (!/^[a-f0-9]{32}$/.test(clientId)) {
                throw new Error('project client id generator returned an invalid id');
            }
            await this.state.update(PROJECT_CLIENT_ID_KEY, clientId);
            return clientId;
        };
        const flight = initialize();
        this.clientIdFlight = flight.then(clientId => {
            this.clientIdFlight = null;
            return clientId;
        }, error => {
            this.clientIdFlight = null;
            throw error;
        });
        return this.clientIdFlight;
    }

    private now(): number {
        const value = (this.dependencies.now || Date.now)();
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error('project client clock returned an invalid timestamp');
        }
        return value;
    }
}
