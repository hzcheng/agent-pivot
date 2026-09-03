'use strict';

import type { Group } from '../models';
import { deterministicProjectCatalogV2Id } from './catalogV2/identity';
import { materializeProjectCatalogV2 } from './catalogV2/merge';
import {
    migrateProjectCatalogV1ToV2,
    ProjectCatalogV2MigrationReport,
} from './catalogV2/migration';
import type {
    ProjectCatalogV2Environment,
    ProjectCatalogV2Project,
} from './catalogV2/types';
import type { ProjectConnectionProfile } from './projectClientProtocol';

export type ProjectProfileAvailability = 'ready' | 'unavailable';

export interface MachineProjectRowViewModel {
    id: string;
    legacyProjectId: string;
    environmentId: string;
    machineId: string;
    machineName: string;
    environmentName: string;
    name: string;
    description: string | null;
    path: string;
    tags: string[];
    favorite: boolean;
    color: string | null;
    searchText: string;
    needsSetup: boolean;
    navigationState: 'open' | 'needsConnection' | 'unavailable' | 'previewOnly' | 'needsRepair' | 'needsAssignment';
}

export interface MachineEnvironmentViewModel {
    id: string;
    machineId: string;
    kind: ProjectCatalogV2Environment['kind'];
    displayName: string;
    needsSetup: boolean;
    projects: MachineProjectRowViewModel[];
}

export interface MachineRowViewModel {
    id: string;
    displayName: string;
    connectionState: 'configured' | 'notConfigured' | 'setupUnavailable';
    connectionLabel: string;
    hostAction: 'open' | 'setup';
    environments: MachineEnvironmentViewModel[];
}

export interface MachineProjectsReadyViewModel {
    kind: 'ready';
    profileAvailability: ProjectProfileAvailability;
    projectCount: number;
    tags: string[];
    favorites: MachineProjectRowViewModel[];
    machines: MachineRowViewModel[];
    report: ProjectCatalogV2MigrationReport;
    migrationPreview: MachineProjectsMigrationPreview;
}

export interface MachineProjectsMigrationPreview {
    legacyGroupCount: number;
    legacyProjectCount: number;
    machineCount: number;
    environmentCount: number;
    devContainerCount: number;
    groupTagCount: number;
    readyProjectCount: number;
    reviewProjectCount: number;
    cannotOpenProjectCount: number;
    blockingCount: number;
    overLimitTagCount: number;
    overLimitProjectCount: number;
}

export interface MachineProjectsErrorViewModel {
    kind: 'error';
    message: string;
    migrationPreview: MachineProjectsMigrationPreview;
}

export type MachineProjectsViewModel =
    | MachineProjectsReadyViewModel
    | MachineProjectsErrorViewModel;

export function buildMachineProjectsBlockingViewModel(
    groups: Group[],
): MachineProjectsErrorViewModel {
    const safeGroups = Array.isArray(groups) ? groups : [];
    const legacyProjectCount = safeGroups.reduce((count, group) =>
        count + (group && Array.isArray(group.projects) ? group.projects.length : 0), 0);
    return {
        kind: 'error',
        message: 'The current V1 catalog cannot be projected safely.',
        migrationPreview: {
            legacyGroupCount: safeGroups.length,
            legacyProjectCount,
            machineCount: 0,
            environmentCount: 0,
            devContainerCount: 0,
            groupTagCount: 0,
            readyProjectCount: 0,
            reviewProjectCount: 0,
            cannotOpenProjectCount: 0,
            blockingCount: 1,
            overLimitTagCount: 0,
            overLimitProjectCount: 0,
        },
    };
}

export interface BuildMachineProjectsViewModelOptions {
    profileAvailability: ProjectProfileAvailability;
    profiles: readonly ProjectConnectionProfile[];
}

export function buildMachineProjectsViewModel(
    groups: Group[],
    options: BuildMachineProjectsViewModelOptions,
): MachineProjectsReadyViewModel {
    const migration = migrateProjectCatalogV1ToV2(groups || []);
    const catalog = materializeProjectCatalogV2(migration.document);
    const profiles = new Map((options.profiles || []).map(profile => [profile.machineId, profile]));
    const legacyProjectIds = new Map<string, string>();
    for (const group of groups || []) {
        for (const project of group.projects || []) {
            legacyProjectIds.set(
                deterministicProjectCatalogV2Id(`project:${project.id}`),
                project.id,
            );
        }
    }
    const environments = new Map(catalog.environments.map(environment => [environment.id, environment]));
    const machines = new Map(catalog.machines.map(machine => [machine.id, machine]));
    const needsSetupEnvironmentIds = new Set(migration.report.needsSetupEnvironmentIds);
    const needsAssignmentProjectIds = new Set(migration.report.needsAssignmentProjectIds);
    const projectRows = new Map<string, MachineProjectRowViewModel>();
    for (const project of catalog.projects) {
        const environment = environments.get(project.environmentId);
        const machine = environment && machines.get(environment.machineId);
        const legacyProjectId = legacyProjectIds.get(project.id);
        if (!environment || !machine || !legacyProjectId) { continue; }
        projectRows.set(project.id, toProjectRow(
            project,
            legacyProjectId,
            environment,
            machine.displayName,
            needsSetupEnvironmentIds.has(environment.id),
            needsAssignmentProjectIds.has(project.id),
            options.profileAvailability,
            profiles.has(machine.id),
        ));
    }
    const rowsByEnvironment = new Map<string, MachineProjectRowViewModel[]>();
    for (const project of catalog.projects) {
        const row = projectRows.get(project.id);
        if (!row) { continue; }
        const rows = rowsByEnvironment.get(project.environmentId) || [];
        rows.push(row);
        rowsByEnvironment.set(project.environmentId, rows);
    }
    const machineRows: MachineRowViewModel[] = catalog.machines.map(machine => {
        const profile = profiles.get(machine.id) || null;
        const connectionState = options.profileAvailability !== 'ready'
            ? 'setupUnavailable' as const
            : profile ? 'configured' as const : 'notConfigured' as const;
        return {
            id: machine.id,
            displayName: machine.displayName,
            connectionState,
            connectionLabel: profile ? formatConnectionLabel(profile) : '',
            hostAction: profile && options.profileAvailability === 'ready' ? 'open' : 'setup',
            environments: catalog.environments
                .filter(environment => environment.machineId === machine.id)
                .map(environment => ({
                    id: environment.id,
                    machineId: machine.id,
                    kind: environment.kind,
                    displayName: environment.displayName,
                    needsSetup: needsSetupEnvironmentIds.has(environment.id),
                    projects: rowsByEnvironment.get(environment.id) || [],
                })),
        };
    });
    const favorites = catalog.projects
        .filter(project => project.favorite && projectRows.has(project.id))
        .sort(compareFavoriteProjects)
        .map(project => projectRows.get(project.id)!);
    const tagsByKey = new Map<string, string>();
    for (const project of catalog.projects) {
        for (const tag of project.tags) {
            const key = tag.toLocaleLowerCase();
            if (!tagsByKey.has(key)) { tagsByKey.set(key, tag); }
        }
    }
    const cannotOpenProjectIds = new Set(needsAssignmentProjectIds);
    for (const project of catalog.projects) {
        if (needsSetupEnvironmentIds.has(project.environmentId)) {
            cannotOpenProjectIds.add(project.id);
        }
    }
    const overLimitTags = new Set<string>();
    const overLimitProjectIds = new Set<string>();
    for (const project of catalog.projects) {
        if (project.tags.length > 8) { overLimitProjectIds.add(project.id); }
        for (const tag of project.tags) {
            if (tag.length > 32) {
                overLimitTags.add(tag.toLocaleLowerCase());
                overLimitProjectIds.add(project.id);
            }
        }
    }
    const reviewProjectIds = new Set(
        Array.from(overLimitProjectIds).filter(id => !cannotOpenProjectIds.has(id)),
    );
    return {
        kind: 'ready',
        profileAvailability: options.profileAvailability,
        projectCount: projectRows.size,
        tags: Array.from(tagsByKey.values()).sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: 'base' })),
        favorites,
        machines: machineRows,
        report: migration.report,
        migrationPreview: {
            legacyGroupCount: (groups || []).length,
            legacyProjectCount: migration.report.projectCount,
            machineCount: migration.report.machineCount,
            environmentCount: migration.report.environmentCount,
            devContainerCount: catalog.environments
                .filter(environment => environment.kind === 'devContainer').length,
            groupTagCount: migration.report.uniqueGroupTagCount,
            readyProjectCount: Math.max(
                0,
                migration.report.projectCount
                    - cannotOpenProjectIds.size
                    - reviewProjectIds.size,
            ),
            reviewProjectCount: reviewProjectIds.size,
            cannotOpenProjectCount: cannotOpenProjectIds.size,
            blockingCount: 0,
            overLimitTagCount: overLimitTags.size,
            overLimitProjectCount: overLimitProjectIds.size,
        },
    };
}

export function resolveMachineProjectTarget(
    groups: Group[],
    target: {
        legacyProjectId: string;
        machineId: string;
        environmentId: string;
    },
): { projectPath: string } | null {
    const migration = migrateProjectCatalogV1ToV2(groups || []);
    const catalog = materializeProjectCatalogV2(migration.document);
    const projectId = deterministicProjectCatalogV2Id(`project:${target.legacyProjectId}`);
    const project = catalog.projects.find(candidate => candidate.id === projectId);
    const environment = project && catalog.environments.find(candidate =>
        candidate.id === project.environmentId);
    if (!project || !environment
        || environment.id !== target.environmentId
        || environment.machineId !== target.machineId
        || environment.kind !== 'host'
        || migration.report.needsAssignmentProjectIds.includes(project.id)
        || migration.report.needsSetupEnvironmentIds.includes(environment.id)) {
        return null;
    }
    return { projectPath: project.path };
}

function toProjectRow(
    project: ProjectCatalogV2Project,
    legacyProjectId: string,
    environment: ProjectCatalogV2Environment,
    machineName: string,
    needsSetup: boolean,
    needsAssignment: boolean,
    profileAvailability: ProjectProfileAvailability,
    hasProfile: boolean,
): MachineProjectRowViewModel {
    const navigationState = needsAssignment ? 'needsAssignment' as const
        : environment.kind !== 'host' ? 'previewOnly' as const
            : needsSetup ? 'needsRepair' as const
            : profileAvailability !== 'ready' ? 'unavailable' as const
                : hasProfile ? 'open' as const : 'needsConnection' as const;
    return {
        id: project.id,
        legacyProjectId,
        environmentId: environment.id,
        machineId: environment.machineId,
        machineName,
        environmentName: environment.displayName,
        name: project.name,
        description: project.description,
        path: project.path,
        tags: [...project.tags],
        favorite: project.favorite,
        color: project.color,
        searchText: [
            project.name,
            project.description || '',
            project.path,
            project.tags.join(' '),
            machineName,
            environment.displayName,
        ].join(' ').toLocaleLowerCase(),
        needsSetup,
        navigationState,
    };
}

function formatConnectionLabel(profile: ProjectConnectionProfile): string {
    if (profile.kind === 'local') { return 'Local · this VS Code'; }
    const label = profile.kind === 'ssh' ? 'SSH'
        : profile.kind === 'wsl' ? 'WSL'
            : 'Remote';
    return `${label} · ${profile.target || profile.resolverAuthority || 'configured'}`;
}

function compareFavoriteProjects(
    left: ProjectCatalogV2Project,
    right: ProjectCatalogV2Project,
): number {
    const leftPosition = left.favoritePosition || `~:${left.position}`;
    const rightPosition = right.favoritePosition || `~:${right.position}`;
    return leftPosition.localeCompare(rightPosition) || left.id.localeCompare(right.id);
}
