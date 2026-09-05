'use strict';

import { ManagedRemoteManagementSnapshot } from './managementController';
import {
    ManagedCatalogConflict,
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
} from './types';

export type ManagedRemoteClientUiState =
    | 'preview'
    | 'enableRequired'
    | 'applying'
    | 'ready'
    | 'attention'
    | 'remoteSshMissing';

export interface ManagedRemoteProjectRowViewModel extends ManagedRemoteProject {
    machineId: string;
    machineName: string;
    machineEndpoint: string;
    environmentName: string;
    searchText: string;
    openable: boolean;
    unavailableReason?: string;
}

export interface ManagedRemoteEnvironmentViewModel extends ManagedEnvironment {
    projects: ManagedRemoteProjectRowViewModel[];
    openable: boolean;
    unavailableReason?: string;
    conflict: boolean;
}

export interface ManagedRemoteMachineViewModel extends ManagedSshMachine {
    endpoint: string;
    environments: ManagedRemoteEnvironmentViewModel[];
    projectCount: number;
    openable: boolean;
    unavailableReason?: string;
    conflict: boolean;
}

export interface ManagedRemoteProjectsViewModel {
    revisionId: string | null;
    lifecycle: ManagedRemoteManagementSnapshot['lifecycle'];
    clientState: ManagedRemoteClientUiState;
    clientMessage: string;
    projectCount: number;
    tags: string[];
    favorites: ManagedRemoteProjectRowViewModel[];
    machines: ManagedRemoteMachineViewModel[];
}

function inLayoutOrder<T extends { id: string }>(
    values: T[],
    ids: string[] | undefined,
): T[] {
    const byId = new Map(values.map(value => [value.id, value]));
    const ordered: T[] = [];
    for (const id of ids || []) {
        const value = byId.get(id);
        if (value) { ordered.push(value); byId.delete(id); }
    }
    return ordered.concat(Array.from(byId.values()).sort((left, right) =>
        left.id.localeCompare(right.id)));
}

function endpoint(machine: ManagedSshMachine): string {
    const host = machine.connection.host.includes(':')
        ? `[${machine.connection.host}]` : machine.connection.host;
    return `${machine.connection.user}@${host}:${machine.connection.port}`;
}

function clientMessage(state: ManagedRemoteClientUiState): string {
    if (state === 'preview') {
        return 'The Managed Machine catalog is unavailable.';
    }
    if (state === 'enableRequired') {
        return 'Enable managed connections on this computer before opening remote Projects.';
    }
    if (state === 'applying') { return 'Applying the managed SSH configuration…'; }
    if (state === 'attention') { return 'The SSH configuration needs attention.'; }
    if (state === 'remoteSshMissing') { return 'Remote - SSH is required.'; }
    return 'Managed connections are ready on this computer.';
}

function unavailableReason(
    active: boolean,
    conflicted: boolean,
): string | undefined {
    if (conflicted) { return 'Connection conflict — Review'; }
    if (!active) { return 'The Managed Machine catalog is unavailable.'; }
    return undefined;
}

function hasConflict(
    conflicts: ManagedCatalogConflict[],
    entityType: ManagedCatalogConflict['entityType'],
    entityId: string,
): boolean {
    return conflicts.some(conflict =>
        conflict.entityType === entityType && conflict.entityId === entityId);
}

export function buildManagedRemoteProjectsViewModel(
    snapshot: ManagedRemoteManagementSnapshot,
    requestedClientState?: ManagedRemoteClientUiState,
): ManagedRemoteProjectsViewModel {
    const clientState = requestedClientState
        || (snapshot.lifecycle === 'active' ? 'enableRequired' : 'preview');
    const active = snapshot.lifecycle === 'active';
    const tags = new Map<string, string>();
    const projectRows = new Map<string, ManagedRemoteProjectRowViewModel>();
    const machines = inLayoutOrder(
        snapshot.catalog.machines,
        snapshot.catalog.layout.machineIds,
    ).map(machine => {
        const machineEndpoint = endpoint(machine);
        const machineConflict = hasConflict(
            snapshot.catalog.conflicts, 'machine', machine.id,
        );
        const environments = inLayoutOrder(
            snapshot.catalog.environments.filter(value => value.machineId === machine.id),
            snapshot.catalog.layout.environmentIdsByMachine[machine.id],
        ).map(environment => {
            const environmentConflict = hasConflict(
                snapshot.catalog.conflicts, 'environment', environment.id,
            );
            const projects = inLayoutOrder(
                snapshot.catalog.projects.filter(value =>
                    value.environmentId === environment.id),
                snapshot.catalog.layout.projectIdsByEnvironment[environment.id],
            ).map(project => {
                const projectConflict = hasConflict(
                    snapshot.catalog.conflicts, 'project', project.id,
                );
                const reason = unavailableReason(
                    active,
                    machineConflict || environmentConflict || projectConflict,
                );
                for (const tag of project.tags || []) {
                    const key = tag.toLocaleLowerCase();
                    if (!tags.has(key)) { tags.set(key, tag); }
                }
                const row: ManagedRemoteProjectRowViewModel = {
                    ...project,
                    machineId: machine.id,
                    machineName: machine.name,
                    machineEndpoint,
                    environmentName: environment.name,
                    searchText: [
                        project.name,
                        project.description || '',
                        project.remotePath,
                        ...(project.tags || []),
                        machine.name,
                        machineEndpoint,
                        environment.name,
                    ].join(' ').toLocaleLowerCase(),
                    openable: !reason,
                    ...(reason ? { unavailableReason: reason } : {}),
                };
                projectRows.set(project.id, row);
                return row;
            });
            const reason = unavailableReason(
                active,
                machineConflict || environmentConflict,
            );
            return {
                ...environment,
                projects,
                openable: environment.kind === 'devContainer' && !reason,
                ...(reason ? { unavailableReason: reason } : {}),
                conflict: environmentConflict,
            };
        });
        const reason = unavailableReason(active, machineConflict);
        return {
            ...machine,
            endpoint: machineEndpoint,
            environments,
            projectCount: environments.reduce((sum, value) => sum + value.projects.length, 0),
            openable: !reason,
            ...(reason ? { unavailableReason: reason } : {}),
            conflict: machineConflict,
        };
    });
    const favorites = (snapshot.catalog.layout.favoriteProjectIds || [])
        .map(id => projectRows.get(id))
        .filter((value): value is ManagedRemoteProjectRowViewModel => Boolean(value));
    return {
        revisionId: snapshot.revisionId,
        lifecycle: snapshot.lifecycle,
        clientState,
        clientMessage: clientMessage(clientState),
        projectCount: snapshot.catalog.projects.length,
        tags: Array.from(tags.values()).sort((left, right) => left.localeCompare(right)),
        favorites,
        machines,
    };
}
