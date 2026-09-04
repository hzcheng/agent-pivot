"use strict";

import * as vscode from 'vscode';

import { Project, Group } from "../models";
import {
    ADD_NEW_PROJECT_TO_FRONT,
    LOCAL_PROJECTS_KEY,
    PROJECTS_KEY,
    PROJECT_SYNC_DATA_KEY,
    PROJECT_SYNC_LOCAL_STATE_KEY,
    StorageOption,
} from "../constants";
import type { ProjectCatalogMutationOptions } from '../projects/projectCatalogSync';
import {
    getMachineDisplayNameForPath,
    getMachineViewId,
    isLocalMachineProjectPath,
} from '../projects/machineProjectsViewModel';
import BaseService from './baseService';
import ColorService from './colorService';
import {
    ProjectCatalogConfigurationChange,
    ProjectCatalogLocalStateV1,
    ProjectCatalogSyncService,
} from './projectCatalogSyncService';

export interface ProjectServiceSyncOptions {
    createActorId?: () => string;
    onDiagnostic?: (event: Record<string, unknown>) => void;
    onConflict?: (projectIds: string[]) => void;
}

export default class ProjectService extends BaseService {

    colorService: ColorService;
    private readonly catalogSyncService: ProjectCatalogSyncService;

    constructor(
        context: vscode.ExtensionContext,
        colorService: ColorService,
        syncOptions: ProjectServiceSyncOptions = {}
    ) {
        super(context);
        this.colorService = colorService;
        this.catalogSyncService = new ProjectCatalogSyncService({
            getSyncData: () => this.getConfig<unknown>(PROJECT_SYNC_DATA_KEY),
            updateSyncData: value => this.configurationSection.update(
                PROJECT_SYNC_DATA_KEY,
                value,
                vscode.ConfigurationTarget.Global
            ),
            getLegacyGroups: () => this.getProjectsFromSettings(true),
            updateLegacyGroups: groups => this.saveGroupsInSettings(groups),
            getLocalState: () => this.context.globalState.get(
                PROJECT_SYNC_LOCAL_STATE_KEY
            ) as ProjectCatalogLocalStateV1,
            updateLocalState: value => this.context.globalState.update(
                PROJECT_SYNC_LOCAL_STATE_KEY,
                value
            ),
            createActorId: syncOptions.createActorId
                || (() => Group.getRandomId('project-sync-actor')),
            onDiagnostic: syncOptions.onDiagnostic,
            onConflict: syncOptions.onConflict,
        });
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ GET ~~~~~~~~~~~~~~~~~~~~~~~~~
    getGroups(noSanitize = false): Group[] {
        const remoteGroups = this.useSettingsStorage()
            ? this.catalogSyncService.getGroups()
            : this.getProjectsFromGlobalState();
        var groups = mergeProjectStores(remoteGroups, this.getLocalProjects());

        if (!noSanitize) {
            groups = this.sanitizeGroups(groups);
        }

        return groups;
    }

    getGroup(groupId: string): Group {
        var groups = this.getGroups();
        return groups.find(g => g.id === groupId) || null;
    }

    getProjectsFlat(): Project[] {
        var groups = this.getGroups();
        var projects = [];
        for (let group of groups) {
            projects.push.apply(projects, group.projects);
        }

        return projects;
    }

    getProject(projectId: string): Project {
        var [project] = this.getProjectAndGroup(projectId);
        return project;
    }

    getProjectAndGroup(projectId: string, groupId?: string): [Project, Group] {
        if (projectId == null) {
            return null;
        }

        var groups = this.getGroups();
        for (let group of groups) {
            if (groupId && group.id !== groupId) {
                continue;
            }
            let project = group.projects.find(p => p.id === projectId);
            if (project != null) {
                return [project, group];
            }
        }
        return [null, null];
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ ADD ~~~~~~~~~~~~~~~~~~~~~~~~~
    async addGroup(groupName: string, projects: Project[] = null): Promise<Group> {
        var groups = this.getGroups();
        if (groups == null) {
            groups = [];
        }

        let newGroup = new Group(groupName, projects);
        groups.push(newGroup);
        await this.saveGroups(groups);
        return newGroup;
    }

    async addProject(project: Project, groupId: string): Promise<Group[]> {
        // Get groups, default them to [] if there are no groups
        var groups = this.getGroups(true);
        if (groups == null) {
            groups = [];
        }

        // Get the group if there is any
        var group = groups.find(g => g.id === groupId);

        if (group == null) {
            if (groups.length) {
                // No group found, but there are groups? Default to first group
                group = groups[0];
            } else {
                // No groups, create initial group
                group = new Group(null);
                groups.push(group);
            }
        }

        const machineDisplayName = getMachineDisplayNameForPath(groups, project.path);
        if (machineDisplayName && !project.machineDisplayName) {
            project.machineDisplayName = machineDisplayName;
        }

        if (ADD_NEW_PROJECT_TO_FRONT) {
            group.projects.unshift(project);
        } else {
            group.projects.push(project);
        }

        // Add to recent colors
        try {
            await this.colorService.addRecentColor(project.color);
        } catch (e) {
            console.error(e);
        }

        await this.saveGroups(groups);
        return groups;
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ UPDATE ~~~~~~~~~~~~~~~~~~~~~~~~~
    async updateProject(
        projectId: string,
        updatedProject: Project,
        groupId?: string,
        rememberColor: boolean = true
    ) {
        if (!projectId || updatedProject == null) {
            return;
        }

        var groups = this.getGroups();
        for (let group of groups) {
            if (groupId && group.id !== groupId) {
                continue;
            }
            let project = group.projects.find(p => p.id === projectId);
            if (project != null) {
                const updatedPath = updatedProject.path || project.path;
                const nextProject = { ...updatedProject, path: updatedPath } as Project;
                if (getMachineViewId(project.path) !== getMachineViewId(updatedPath)
                    && !Object.prototype.hasOwnProperty.call(
                        nextProject,
                        'machineDisplayName'
                    )) {
                    delete project.machineDisplayName;
                }
                Object.assign(project, nextProject, { id: projectId });
                break;
            }
        }

        if (rememberColor) {
            // Colour edits retain their existing recent-colour bookkeeping; inline
            // metadata edits opt out so they cannot trigger a configuration refresh.
            try {
                await this.colorService.addRecentColor(updatedProject.color);
            } catch (e) {
                console.error(e);
            }
        }
        await this.saveGroups(groups);
    }

    /**
     * Opening a project must not write a whole synchronized Project record.
     * The old timestamp was never consumed and could win a concurrent
     * name/tag edit during catalog conflict resolution.
     */
    async touchProjectLastOpened(_projectId: string, _openedAt: number = Date.now()): Promise<void> {
        return;
    }

    async updateGroup(groupId: string, updatedGroup: Group) {
        if (!groupId || updatedGroup == null) {
            return;
        }

        var groups = this.getGroups();
        var group = groups.find(g => g.id === groupId);
        if (group != null) {
            Object.assign(group, updatedGroup, { id: groupId });
        }

        await this.saveGroups(groups);
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ REMOVE ~~~~~~~~~~~~~~~~~~~~~~~~~
    async removeProject(projectId: string): Promise<Group[]> {
        let groups = this.getGroups();
        let removed = false;
        for (let i = 0; i < groups.length; i++) {
            let group = groups[i];
            let index = group.projects.findIndex(p => p.id === projectId);

            if (index !== -1) {
                group.projects.splice(index, 1);
                removed = true;
                break;
            }
        }
        await this.saveGroupsWithMutation(groups, {
            deletedProjectIds: removed ? [projectId] : [],
        });
        return groups;
    }

    async removeGroup(groupId: string, testIfEmpty: boolean = false): Promise<Group[]> {
        let groups = this.getGroups();
        const removedGroup = groups.find(group =>
            group.id === groupId && (!testIfEmpty || !group.projects.length));

        groups = groups.filter(g => g.id !== groupId || (testIfEmpty && g.projects.length));
        await this.saveGroupsWithMutation(groups, {
            deletedGroupIds: removedGroup ? [groupId] : [],
            deletedProjectIds: removedGroup
                ? removedGroup.projects.map(project => project.id)
                : [],
        });

        return groups;
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ SAVE ~~~~~~~~~~~~~~~~~~~~~~~~~
    saveGroups(groups: Group[]): Thenable<void> {
        return this.saveGroupsWithMutation(groups);
    }

    saveGroupsFromManualEdit(groups: Group[], baselineGroups: Group[]): Thenable<void> {
        const nextGroupIds = new Set((groups || []).map(group => group.id));
        const nextProjectIds = new Set((groups || []).reduce(
            (projectIds, group) => projectIds.concat(
                (group.projects || []).map(project => project.id)
            ),
            [] as string[]
        ));
        const deletedGroupIds = (baselineGroups || [])
            .map(group => group.id)
            .filter(groupId => !nextGroupIds.has(groupId));
        const deletedProjectIds = (baselineGroups || []).reduce(
            (projectIds, group) => projectIds.concat(
                (group.projects || [])
                    .map(project => project.id)
                    .filter(projectId => !nextProjectIds.has(projectId))
            ),
            [] as string[]
        );
        return this.saveGroupsWithMutation(groups, {
            deletedGroupIds,
            deletedProjectIds,
        });
    }

    async reconcileProjectCatalog(): Promise<void> {
        if (!this.useSettingsStorage()) {
            return;
        }
        await this.catalogSyncService.reconcile();
        await this.migrateLocalProjectsOutOfSelectedStorage();
    }

    consumeProjectCatalogWriteEcho(change: ProjectCatalogConfigurationChange): boolean {
        return this.useSettingsStorage()
            && this.catalogSyncService.consumeConfigurationWriteEcho(change);
    }

    private async saveGroupsWithMutation(
        groups: Group[],
        options: ProjectCatalogMutationOptions = {}
    ): Promise<void> {
        groups = this.sanitizeGroups(groups);
        const { remoteGroups, localGroups } = partitionProjectStores(groups);
        const currentLocalGroups = this.getLocalProjects();
        const remoteProjectIds = getProjectIds(remoteGroups);
        const retainedLocalGroups = filterProjectGroups(
            currentLocalGroups,
            project => remoteProjectIds.has(project.id),
        );

        // Stage destination copies before changing either source. A Local → Remote
        // move retains its Local copy until the Remote write succeeds; a Remote →
        // Local move writes the Local copy before deleting the synchronized one.
        await this.saveLocalProjects(mergeProjectStores(localGroups, retainedLocalGroups));

        if (this.useSettingsStorage()) {
            const currentRemoteGroups = this.catalogSyncService.getGroups();
            const desiredLocalIds = getProjectIds(localGroups);
            const localIdsInRemoteStore = getProjectIds(filterProjectGroups(
                currentRemoteGroups,
                project => isLocalMachineProjectPath(project.path)
                    || desiredLocalIds.has(project.id),
            ));
            await this.catalogSyncService.saveGroups(remoteGroups, {
                deletedGroupIds: options.deletedGroupIds,
                deletedProjectIds: Array.from(new Set([
                    ...(options.deletedProjectIds || []),
                    ...localIdsInRemoteStore,
                ])),
            });
        } else {
            await this.saveGroupsInGlobalState(remoteGroups);
        }

        await this.saveLocalProjects(localGroups);
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ STORAGE ~~~~~~~~~~~~~~~~~~~~~~~~~
    private getCurrentStorageOption(): StorageOption {
        return this.useSettingsStorage() ? StorageOption.Settings : StorageOption.GlobalState;
    }

    private getProjectsFromStorage(storage: StorageOption = null, unsafe: boolean = false): Group[] {
        storage = storage || this.getCurrentStorageOption();

        switch (storage) {
            case StorageOption.Settings:
                return this.getProjectsFromSettings(unsafe);
            case StorageOption.GlobalState:
                return this.getProjectsFromGlobalState(unsafe);
            default:
                return [];
        }
    }

    private getProjectsFromGlobalState(unsafe: boolean = false): Group[] {
        var groups = this.context.globalState.get(PROJECTS_KEY) as Group[];

        if (groups == null && !unsafe) {
            groups = [];
        }

        return groups;
    }

    private getLocalProjects(): Group[] {
        return this.context.globalState.get(LOCAL_PROJECTS_KEY, []) as Group[];
    }

    private getProjectsFromSettings(unsafe: boolean = false): Group[] {
        var groups = this.getConfig<Group[]>('projectData');

        if (groups == null && !unsafe) {
            groups = [];
        }

        return groups;
    }

    private saveGroupsInGlobalState(groups: Group[]): Thenable<void> {
        return this.context.globalState.update(PROJECTS_KEY, groups);
    }

    private saveLocalProjects(groups: Group[]): Thenable<void> {
        return this.context.globalState.update(LOCAL_PROJECTS_KEY, groups);
    }

    private saveGroupsInSettings(groups: Group[]): Thenable<void> {
        return this.configurationSection.update("projectData", groups, vscode.ConfigurationTarget.Global);
    }

    private getStorageOptionsWithData(): StorageOption[] {
        var storageOptions: StorageOption[] = [];

        if (this.getProjectsFromSettings()?.length) {
            storageOptions.push(StorageOption.Settings);
        }

        if (this.getProjectsFromGlobalState()?.length) {
            storageOptions.push(StorageOption.GlobalState);
        }

        return storageOptions;
    }

    otherStorageHasData(currentStorage: StorageOption = null): boolean {
        currentStorage = currentStorage || this.getCurrentStorageOption();
        return this.getStorageOptionsWithData().some(s => s !== currentStorage);
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ MODEL MIGRATION ~~~~~~~~~~~~~~~~~~~~~~~~~
    async copyProjectsFromFilledStorageOptionToEmptyStorageOption(): Promise<void> {
        if (this.getProjectsFromStorage().length) {
            return;
        }

        var storageOptionToCopyFrom = this.getStorageOptionsWithData().find(s => s !== this.getCurrentStorageOption());

        const projects = mergeProjectStores(
            this.getProjectsFromStorage(storageOptionToCopyFrom, true),
            this.getLocalProjects(),
        );
        await this.saveGroups(projects);
    }

    async migrateDataIfNeeded() {
        var toMigrate = false;
        var projectsInSettings = this.getProjectsFromSettings(true);
        var projectsInGlobalState = this.getProjectsFromGlobalState(true);

        if (this.useSettingsStorage()) {
            // Migrate from Global State to Settings
            toMigrate = projectsInSettings == null && projectsInGlobalState != null;

            if (toMigrate) {
                await this.saveGroups(projectsInGlobalState);
            }

            //await this.saveGroupsInGlobalState(null);
        } else {
            // Migrate from Settings To Global State
            toMigrate = projectsInGlobalState == null && projectsInSettings != null;

            if (toMigrate) {
                await this.saveGroups(projectsInSettings);
            }

            //await this.saveGroupsInSettings(null);
        }


        if (this.useSettingsStorage()) {
            await this.catalogSyncService.reconcile();
        }

        const movedLocalProjects = await this.migrateLocalProjectsOutOfSelectedStorage();
        return movedLocalProjects || toMigrate;
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ HELPERS ~~~~~~~~~~~~~~~~~~~~~~~~~

    private sanitizeGroups(groups: Group[]): Group[] {
        groups = Array.isArray(groups) ? groups.filter(g => !!g) : [];

        // Fill id, should only happen if user removes id manually. But better be safe than sorry.
        for (let g of groups) {
            if (!g.id) {
                g.id = Group.getRandomId();
            }
        }
        for (const group of groups) {
            for (const project of group.projects || []) {
                delete (project as Project & { localMachineScope?: string }).localMachineScope;
            }
        }

        return groups;
    }

    private async migrateLocalProjectsOutOfSelectedStorage(): Promise<boolean> {
        const remoteGroups = this.useSettingsStorage()
            ? this.catalogSyncService.getGroups()
            : this.getProjectsFromGlobalState();
        const localProjectsInRemoteStore = filterProjectGroups(
            remoteGroups,
            project => isLocalMachineProjectPath(project.path),
        );
        if (!getProjectIds(localProjectsInRemoteStore).size) {
            return false;
        }
        await this.saveGroups(mergeProjectStores(remoteGroups, this.getLocalProjects()));
        return true;
    }
}

function cloneGroups(groups: Group[]): Group[] {
    return JSON.parse(JSON.stringify(Array.isArray(groups) ? groups : []));
}

function filterProjectGroups(
    groups: Group[],
    predicate: (project: Project) => boolean,
): Group[] {
    return cloneGroups(groups).map(group => ({
        ...group,
        projects: (group.projects || []).filter(predicate),
    } as Group)).filter(group => group.projects.length > 0);
}

function partitionProjectStores(groups: Group[]): {
    remoteGroups: Group[];
    localGroups: Group[];
} {
    const sanitized = cloneGroups(groups);
    return {
        // Group metadata remains shared so tags/names stay consistent. Only Local
        // Project records and their paths are excluded from synchronization.
        remoteGroups: sanitized.map(group => ({
            ...group,
            projects: (group.projects || []).filter(project =>
                !isLocalMachineProjectPath(project.path)),
        } as Group)),
        localGroups: filterProjectGroups(
            sanitized,
            project => isLocalMachineProjectPath(project.path),
        ),
    };
}

function mergeProjectStores(remoteGroups: Group[], localGroups: Group[]): Group[] {
    const merged = cloneGroups(remoteGroups);
    const groupsById = new Map(merged.map(group => [group.id, group]));
    const projectIds = getProjectIds(merged);
    for (const localGroup of cloneGroups(localGroups)) {
        let target = groupsById.get(localGroup.id);
        if (!target) {
            target = { ...localGroup, projects: [] } as Group;
            groupsById.set(localGroup.id, target);
            merged.push(target);
        }
        for (const project of localGroup.projects || []) {
            if (!projectIds.has(project.id)) {
                target.projects.push(project);
                projectIds.add(project.id);
            }
        }
    }
    return merged;
}

function getProjectIds(groups: Group[]): Set<string> {
    return new Set((groups || []).reduce(
        (ids, group) => ids.concat((group.projects || []).map(project => project.id)),
        [] as string[],
    ));
}
