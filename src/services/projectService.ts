"use strict";

import * as vscode from 'vscode';

import { Project, Group } from "../models";
import {
    ADD_NEW_PROJECT_TO_FRONT,
    LOCAL_PROJECTS_KEY,
} from "../constants";
import {
    getMachineDisplayNameForPath,
    getMachineViewId,
    isLocalMachineProjectPath,
} from '../projects/machineProjectsViewModel';
import BaseService from './baseService';
import ColorService from './colorService';

export default class ProjectService extends BaseService {

    colorService: ColorService;
    constructor(
        context: vscode.ExtensionContext,
        colorService: ColorService,
    ) {
        super(context);
        this.colorService = colorService;
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ GET ~~~~~~~~~~~~~~~~~~~~~~~~~
    getGroups(noSanitize = false): Group[] {
        var groups = cloneGroups(this.getLocalProjects());

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

    getLocalGroupsForDisplay(): Group[] {
        return cloneGroups(this.getLocalProjects());
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
        if (!project || !isLocalMachineProjectPath(project.path)) {
            throw new Error('Remote Projects must be added to a Managed Machine.');
        }
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
        for (let i = 0; i < groups.length; i++) {
            let group = groups[i];
            let index = group.projects.findIndex(p => p.id === projectId);

            if (index !== -1) {
                group.projects.splice(index, 1);
                break;
            }
        }
        await this.saveGroupsWithMutation(groups);
        return groups;
    }

    async removeGroup(groupId: string, testIfEmpty: boolean = false): Promise<Group[]> {
        let groups = this.getGroups();
        groups = groups.filter(g => g.id !== groupId || (testIfEmpty && g.projects.length));
        await this.saveGroupsWithMutation(groups);

        return groups;
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ SAVE ~~~~~~~~~~~~~~~~~~~~~~~~~
    saveGroups(groups: Group[]): Thenable<void> {
        return this.saveGroupsWithMutation(groups);
    }

    private async saveGroupsWithMutation(
        groups: Group[],
    ): Promise<void> {
        groups = this.sanitizeGroups(cloneGroups(groups));
        if (groups.some(group => (group.projects || []).some(project =>
            !isLocalMachineProjectPath(project.path)))) {
            throw new Error('Remote Projects must be added to a Managed Machine.');
        }
        await this.saveLocalProjects(groups);
    }

    // ~~~~~~~~~~~~~~~~~~~~~~~~~ STORAGE ~~~~~~~~~~~~~~~~~~~~~~~~~
    private getLocalProjects(): Group[] {
        return this.context.globalState.get(LOCAL_PROJECTS_KEY, []) as Group[];
    }

    private saveLocalProjects(groups: Group[]): Thenable<void> {
        return this.context.globalState.update(LOCAL_PROJECTS_KEY, groups);
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

}

function cloneGroups(groups: Group[]): Group[] {
    return JSON.parse(JSON.stringify(Array.isArray(groups) ? groups : []));
}

function getProjectIds(groups: Group[]): Set<string> {
    return new Set((groups || []).reduce(
        (ids, group) => ids.concat((group.projects || []).map(project => project.id)),
        [] as string[],
    ));
}
