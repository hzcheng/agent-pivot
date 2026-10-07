'use strict';

import { jumpHostIds, managedJumpRoute, managedJumpAlias } from './jumpRoutes';
import { annotateProjectPathHints } from '../machineProjectsViewModel';
import { ManagedRemoteManagementSnapshot } from './managementController';
import {
    ManagedCatalogConflict,
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
} from './types';

export interface ManagedRemoteProjectRowViewModel extends ManagedRemoteProject {
    pathHint?: string;
    conflict?: boolean;
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
    routeNames?: string[];
    jumpOptions?: Array<{ alias: string; name: string }>;
    environments: ManagedRemoteEnvironmentViewModel[];
    projectCount: number;
    openable: boolean;
    unavailableReason?: string;
    conflict: boolean;
}

export interface ManagedRemoteProjectsViewModel {
    orphanConflicts?: Array<{ entityType: 'project' | 'environment'; id: string; name: string }>;
    revisionId: string | null;
    lifecycle: ManagedRemoteManagementSnapshot['lifecycle'];
    projectCount: number;
    tags: string[];
    favorites: ManagedRemoteProjectRowViewModel[];
    machines: ManagedRemoteMachineViewModel[];
    jumpHosts?: ManagedRemoteMachineViewModel[];
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

function unavailableReason(
    active: boolean,
    conflicted: boolean,
    entity = 'Machine',
): string | undefined {
    if (conflicted) { return `${entity} sync conflict — Review`; }
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
): ManagedRemoteProjectsViewModel {
    const active = snapshot.lifecycle === 'active';
    const tags = new Map<string, string>();
    const projectRows = new Map<string, ManagedRemoteProjectRowViewModel>();
    const machines = inLayoutOrder(
        snapshot.catalog.machines,
        snapshot.catalog.layout.machineIds,
    ).map(machine => {
        const machineEndpoint = endpoint(machine);
        let routeNames: string[] = [];
        let routeError: string | undefined;
        try { routeNames = managedJumpRoute(snapshot.catalog, machine).map(hop => hop.name); }
        catch (error) { routeError = error instanceof Error ? error.message : 'Jump route unavailable.'; }
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
                const reason = routeError || unavailableReason(
                    active,
                    machineConflict || Boolean(routeError) || environmentConflict || projectConflict,
                    machineConflict ? 'Machine' : environmentConflict ? 'Environment' : 'Project',
                );
                for (const tag of project.tags || []) {
                    const key = tag.toLocaleLowerCase();
                    if (!tags.has(key)) { tags.set(key, tag); }
                }
                const row: ManagedRemoteProjectRowViewModel = {
                    ...project,
                    conflict: projectConflict,
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
            const reason = routeError || unavailableReason(
                active,
                machineConflict || environmentConflict,
                machineConflict ? 'Machine' : 'Environment',
            );
            return {
                ...environment,
                projects,
                openable: environment.kind === 'devContainer' && !reason,
                ...(reason ? { unavailableReason: reason } : {}),
                conflict: environmentConflict,
            };
        });
        const reason = routeError || unavailableReason(active, machineConflict);
        return {
            ...machine,
            endpoint: machineEndpoint,
            routeNames,
            jumpOptions: snapshot.catalog.machines.filter(value => value.id !== machine.id && !value.connection.sshConfigAlias).map(value => ({ alias: managedJumpAlias(value.id), name: value.name })),
            environments,
            projectCount: environments.reduce((sum, value) => sum + value.projects.length, 0),
            openable: !reason,
            ...(reason ? { unavailableReason: reason } : {}),
            conflict: machineConflict,
        };
    });
    annotateProjectPathHints(Array.from(projectRows.values()), row => row.remotePath);
    const favorites = (snapshot.catalog.layout.favoriteProjectIds || [])
        .map(id => projectRows.get(id))
        .filter((value): value is ManagedRemoteProjectRowViewModel => Boolean(value));
    const renderedEnvironmentIds = new Set<string>();
    for (const machine of machines) {
        for (const environment of machine.environments) { renderedEnvironmentIds.add(environment.id); }
    }
    const orphanConflicts: NonNullable<ManagedRemoteProjectsViewModel['orphanConflicts']> = [];
    const seenConflicts = new Set<string>();
    for (const conflict of snapshot.catalog.conflicts) {
        const kind = conflict.entityType;
        if (kind !== 'project' && kind !== 'environment') { continue; }
        const key = `${kind}:${conflict.entityId}`;
        if (seenConflicts.has(key) || (kind === 'project' ? projectRows.has(conflict.entityId) : renderedEnvironmentIds.has(conflict.entityId))) { continue; }
        const candidates: Array<ManagedEnvironment | ManagedRemoteProject | null> | undefined = kind === 'project'
            ? snapshot.projectConflictCandidates?.[conflict.entityId]
            : snapshot.environmentConflictCandidates?.[conflict.entityId];
        const deletionConflict = candidates && candidates.length >= 2 && candidates.includes(null);
        const missingParent = conflict.kind === 'missing-parent' && candidates && candidates.some(value => value !== null);
        if (!deletionConflict && !missingParent) { continue; }
        seenConflicts.add(key);
        orphanConflicts.push({ entityType: kind, id: conflict.entityId,
            name: candidates?.find(value => value !== null)?.name || `Removed ${kind}` });
    }
    const referenced = jumpHostIds(snapshot.catalog.machines);
    return {
        orphanConflicts,
        revisionId: snapshot.revisionId,
        lifecycle: snapshot.lifecycle,
        projectCount: snapshot.catalog.projects.length,
        tags: Array.from(tags.values()).sort((left, right) => left.localeCompare(right)),
        favorites,
        machines: machines.filter(machine => !referenced.has(machine.id) || machine.projectCount > 0),
        jumpHosts: machines.filter(machine => referenced.has(machine.id) && machine.projectCount === 0),
    };
}
