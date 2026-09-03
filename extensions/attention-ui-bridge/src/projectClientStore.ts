'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    FilesystemMutationLockLease,
    withFilesystemMutationLock,
} from '../../../src/aiSessions/tmuxCreationLock';
import {
    createProjectClientSnapshot,
    PROJECT_CLIENT_PROTOCOL_VERSION,
    ProjectClientSnapshot,
    ProjectConnectionProfile,
    ProjectConnectionProfileUpdateOutcome,
    ProjectConnectionProfileUpdateRequest,
    validateProjectConnectionProfile,
    validateProjectConnectionProfileUpdateRequest,
} from '../../../src/projects/projectClientProtocol';

const PROJECT_CLIENT_ID_KEY = 'projectClient.identity.v1';
const PROJECT_CONNECTION_PROFILES_KEY = 'projectClient.connectionProfiles.v1';
const PROJECT_CLIENT_DIRECTORY = 'project-client/v1';
const PROJECT_CLIENT_FILENAME = 'state.json';
const PROJECT_CLIENT_LOCK_DIRECTORY = 'project-client-locks';
const PROJECT_CLIENT_LOCK_KEY = 'state-v1';
const MAX_PROJECT_CLIENT_FILE_BYTES = 4 * 1024 * 1024;

interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

interface StoredProjectConnectionProfilesV1 {
    schemaVersion: 1;
    profiles: ProjectConnectionProfile[];
}

interface StoredProjectClientStateV1 extends StoredProjectConnectionProfilesV1 {
    clientId: string;
}

export interface ProjectClientStoreDependencies {
    createClientId?: () => string;
    now?: () => number;
    rootDirectory?: string;
}

function readProfiles(value: unknown): ProjectConnectionProfile[] {
    if (value === undefined) {
        return [];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('stored project connection profiles are invalid');
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join('\n') !== ['profiles', 'schemaVersion'].join('\n')
        || record.schemaVersion !== 1
        || !Array.isArray(record.profiles)) {
        throw new Error('stored project connection profiles are invalid');
    }
    try {
        return record.profiles.map(validateProjectConnectionProfile);
    } catch (_error) {
        throw new Error('stored project connection profiles are invalid');
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
        if (this.dependencies.rootDirectory) {
            return this.enqueueMutation(() => this.withFileLock(async lease => {
                const stored = await this.readOrInitializeFileState(lease);
                return createProjectClientSnapshot(stored.clientId, stored.profiles);
            }));
        }
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
        const operation = async (lease?: FilesystemMutationLockLease) => {
            const current = this.dependencies.rootDirectory
                ? createProjectClientSnapshotFromState(await this.readOrInitializeFileState(
                    lease as FilesystemMutationLockLease,
                ))
                : await this.getSnapshot();
            const byMachineId = new Map(
                current.profiles.map(profile => [profile.machineId, profile]),
            );
            if (request.profile === null) {
                byMachineId.delete(request.machineId);
            } else {
                if (request.profile.kind === 'local' && Array.from(byMachineId.values()).some(profile =>
                    profile.kind === 'local' && profile.machineId !== request.machineId)) {
                    throw new Error('project client already has a default local Machine');
                }
                byMachineId.set(request.machineId, {
                    machineId: request.machineId,
                    kind: request.profile.kind,
                    target: request.profile.target,
                    resolverAuthority: request.profile.resolverAuthority,
                    updatedAtMs: this.now(),
                });
            }
            const profiles = Array.from(byMachineId.values());
            createProjectClientSnapshot(current.clientId, profiles);
            if (this.dependencies.rootDirectory) {
                await this.writeFileState(
                    { schemaVersion: 1, clientId: current.clientId, profiles },
                    lease as FilesystemMutationLockLease,
                );
            } else {
                const stored: StoredProjectConnectionProfilesV1 = { schemaVersion: 1, profiles };
                await this.state.update(PROJECT_CONNECTION_PROFILES_KEY, stored);
            }
            outcome = {
                protocolVersion: PROJECT_CLIENT_PROTOCOL_VERSION,
                requestId: request.requestId,
                machineId: request.machineId,
                saved: request.profile !== null,
                snapshot: createProjectClientSnapshot(current.clientId, profiles),
            };
        };
        const guardedOperation = this.dependencies.rootDirectory
            ? () => this.withFileLock(lease => operation(lease))
            : () => operation();
        const result = this.mutationQueue.then(guardedOperation);
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

    private withFileLock<T>(
        operation: (lease: FilesystemMutationLockLease) => Promise<T>,
    ): Promise<T> {
        return withFilesystemMutationLock(
            this.dependencies.rootDirectory as string,
            PROJECT_CLIENT_LOCK_DIRECTORY,
            PROJECT_CLIENT_LOCK_KEY,
            operation,
        );
    }

    private async readOrInitializeFileState(
        lease: FilesystemMutationLockLease,
    ): Promise<StoredProjectClientStateV1> {
        const stored = await this.readFileState();
        if (stored) return stored;
        const profiles = readProfiles(this.state.get<StoredProjectConnectionProfilesV1>(
            PROJECT_CONNECTION_PROFILES_KEY,
        ));
        const clientId = await this.ensureClientId();
        const initialized = { schemaVersion: 1 as const, clientId, profiles };
        createProjectClientSnapshotFromState(initialized);
        await this.writeFileState(initialized, lease);
        await this.state.update(PROJECT_CONNECTION_PROFILES_KEY, undefined);
        return initialized;
    }

    private async readFileState(): Promise<StoredProjectClientStateV1 | null> {
        const filePath = this.filePath();
        try {
            const stats = await fs.promises.lstat(filePath);
            if (!stats.isFile() || stats.isSymbolicLink()
                || stats.size < 2 || stats.size > MAX_PROJECT_CLIENT_FILE_BYTES) {
                throw new Error('stored project client state file is invalid');
            }
            const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Record<string, unknown>;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)
                || Object.keys(raw).sort().join('\n') !== ['clientId', 'profiles', 'schemaVersion'].join('\n')
                || raw.schemaVersion !== 1 || typeof raw.clientId !== 'string') {
                throw new Error('stored project client state file is invalid');
            }
            const snapshot = createProjectClientSnapshot(raw.clientId, readProfiles({
                schemaVersion: 1,
                profiles: raw.profiles,
            }));
            return { schemaVersion: 1, clientId: snapshot.clientId, profiles: snapshot.profiles };
        } catch (error) {
            if (isNodeError(error, 'ENOENT')) return null;
            if (error instanceof SyntaxError) throw new Error('stored project client state file is invalid');
            throw error;
        }
    }

    private async writeFileState(
        state: StoredProjectClientStateV1,
        lease: FilesystemMutationLockLease,
    ): Promise<void> {
        const snapshot = createProjectClientSnapshotFromState(state);
        const normalized: StoredProjectClientStateV1 = {
            schemaVersion: 1,
            clientId: snapshot.clientId,
            profiles: snapshot.profiles,
        };
        const contents = `${JSON.stringify(normalized)}\n`;
        if (Buffer.byteLength(contents, 'utf8') > MAX_PROJECT_CLIENT_FILE_BYTES) {
            throw new Error('stored project client state file is too large');
        }
        const directory = path.dirname(this.filePath());
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(
            directory,
            `.${PROJECT_CLIENT_FILENAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, contents, {
                encoding: 'utf8', mode: 0o600, flag: 'wx',
            });
            await lease.assertOwned();
            await fs.promises.rename(temporaryPath, this.filePath());
        } finally {
            await fs.promises.unlink(temporaryPath).catch(error => {
                if (!isNodeError(error, 'ENOENT')) throw error;
            });
        }
    }

    private filePath(): string {
        return path.join(
            this.dependencies.rootDirectory as string,
            PROJECT_CLIENT_DIRECTORY,
            PROJECT_CLIENT_FILENAME,
        );
    }

    private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private now(): number {
        const value = (this.dependencies.now || Date.now)();
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error('project client clock returned an invalid timestamp');
        }
        return value;
    }
}

function createProjectClientSnapshotFromState(state: StoredProjectClientStateV1): ProjectClientSnapshot {
    return createProjectClientSnapshot(state.clientId, state.profiles);
}

function isNodeError(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === code;
}
