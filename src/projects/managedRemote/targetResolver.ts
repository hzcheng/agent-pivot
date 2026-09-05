'use strict';

import {
    rebuildManagedDevContainerProjectUri,
} from './devContainerCodec';
import { managedSshAlias } from './sshConfigProjection';
import type {
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
    MaterializedManagedRemoteCatalog,
} from './types';

export interface ManagedMachineTarget {
    machine: ManagedSshMachine;
    alias: string;
    remoteAuthority: string;
}

export interface ManagedEnvironmentTarget extends ManagedMachineTarget {
    environment: ManagedEnvironment;
    remoteUri: string;
}

export interface ManagedProjectTarget extends ManagedEnvironmentTarget {
    project: ManagedRemoteProject;
}

export interface ManagedProjectIdentity extends ManagedMachineTarget {
    environment: ManagedEnvironment;
    project: ManagedRemoteProject;
}

function blockedEntityIds(catalog: MaterializedManagedRemoteCatalog): Set<string> {
    const blocked = new Set<string>();
    for (const conflict of catalog.conflicts) {
        blocked.add(conflict.entityId);
        for (const relatedId of conflict.relatedEntityIds || []) {
            blocked.add(relatedId);
        }
    }
    return blocked;
}

function assertReady(blocked: Set<string>, ids: string[]): void {
    if (ids.some(id => blocked.has(id))) {
        throw new Error('Managed Remote target has an unresolved conflict.');
    }
}

function remoteUri(remoteAuthority: string, remotePath: string): string {
    return `vscode-remote://${encodeURIComponent(remoteAuthority)}${remotePath}`;
}

export function resolveManagedMachineTarget(
    catalog: MaterializedManagedRemoteCatalog,
    machineId: string,
): ManagedMachineTarget {
    const machine = catalog.machines.find(value => value.id === machineId);
    if (!machine) { throw new Error('Managed Machine no longer exists.'); }
    assertReady(blockedEntityIds(catalog), [machine.id]);
    const alias = managedSshAlias(
        machine.id,
        machine.name,
        machine.connection.host,
    );
    return { machine, alias, remoteAuthority: `ssh-remote+${alias}` };
}

export function resolveManagedEnvironmentTarget(
    catalog: MaterializedManagedRemoteCatalog,
    environmentId: string,
): ManagedEnvironmentTarget {
    const environment = catalog.environments.find(value => value.id === environmentId);
    if (!environment) { throw new Error('Managed Environment no longer exists.'); }
    const machineTarget = resolveManagedMachineTarget(catalog, environment.machineId);
    assertReady(blockedEntityIds(catalog), [environment.id, machineTarget.machine.id]);
    if (environment.kind !== 'devContainer' || !environment.devContainerAnchor) {
        throw new Error('Only Dev Container Environments open independently.');
    }
    const rebuilt = rebuildManagedDevContainerProjectUri(
        environment.devContainerAnchor,
        machineTarget.alias,
        '/',
    );
    if (!rebuilt) {
        throw new Error('Managed Dev Container authority could not be rebuilt.');
    }
    return { ...machineTarget, environment, remoteUri: rebuilt };
}

export function resolveManagedProjectTarget(
    catalog: MaterializedManagedRemoteCatalog,
    projectId: string,
): ManagedProjectTarget {
    const identity = resolveManagedProjectIdentity(catalog, projectId);
    const { environment, project } = identity;
    let targetUri: string | null;
    if (environment.kind === 'host') {
        targetUri = remoteUri(identity.remoteAuthority, project.remotePath);
    } else if (environment.devContainerAnchor) {
        targetUri = rebuildManagedDevContainerProjectUri(
            environment.devContainerAnchor,
            identity.alias,
            project.remotePath,
        );
    } else {
        targetUri = null;
    }
    if (!targetUri) {
        throw new Error('Managed Project target could not be rebuilt.');
    }
    return { ...identity, remoteUri: targetUri };
}

export function resolveManagedProjectIdentity(
    catalog: MaterializedManagedRemoteCatalog,
    projectId: string,
): ManagedProjectIdentity {
    const project = catalog.projects.find(value => value.id === projectId);
    if (!project) { throw new Error('Managed Project no longer exists.'); }
    const environment = catalog.environments.find(value =>
        value.id === project.environmentId);
    if (!environment) { throw new Error('Managed Project Environment no longer exists.'); }
    const machineTarget = resolveManagedMachineTarget(catalog, environment.machineId);
    assertReady(blockedEntityIds(catalog), [
        machineTarget.machine.id,
        environment.id,
        project.id,
    ]);
    return { ...machineTarget, environment, project };
}

export function managedSshArguments(machine: ManagedSshMachine): string[] {
    return [
        '-p', String(machine.connection.port),
        '-l', machine.connection.user,
        machine.connection.host,
    ];
}

function quotePortableSshArgument(value: string): string {
    return `"${value.replace(/"/gu, '\\"')}"`;
}

export function formatManagedSshCommand(machine: ManagedSshMachine): string {
    const args = managedSshArguments(machine);
    return [
        'ssh',
        args[0],
        args[1],
        args[2],
        quotePortableSshArgument(args[3]),
        quotePortableSshArgument(args[4]),
    ].join(' ');
}
