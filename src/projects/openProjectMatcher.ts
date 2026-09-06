'use strict';

import { isUriString } from '../uriStrings';
import * as vscode from 'vscode';

import { Project } from '../models';
import type { ManagedRemoteManagementSnapshot } from './managedRemote/managementController';
import type {
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
} from './managedRemote/types';
import {
    parseManagedDevContainerProjectUri,
    rebuildManagedDevContainerProjectUri,
} from './managedRemote/devContainerCodec';
import {
    isManagedSshAliasForMachine,
    managedSshAlias,
} from './managedRemote/sshConfigProjection';
import {
    encodeRemoteAuthority,
    encodeRemotePath,
    normalizePosixPath,
    normalizeRemoteAuthority,
} from './projectPathUtils';

export interface ManagedOpenProjectMatch {
    project: ManagedRemoteProject;
    environment: ManagedEnvironment;
    machine: ManagedSshMachine;
}

export interface ManagedDevContainerSaveTarget {
    machine: ManagedSshMachine;
    anchor: NonNullable<ManagedEnvironment['devContainerAnchor']>;
    remotePath: string;
}

export interface ManagedCurrentRemoteContext {
    remoteName?: string;
    devContainerHostWorkspaceFolder?: string;
}

function environmentMachine(
    snapshot: ManagedRemoteManagementSnapshot,
    environment: ManagedEnvironment,
): ManagedSshMachine | undefined {
    return snapshot.catalog.machines.find(machine => machine.id === environment.machineId);
}

function environmentMatchesRemoteAuthority(
    snapshot: ManagedRemoteManagementSnapshot,
    environment: ManagedEnvironment,
    uri: vscode.Uri,
    aliasMatches: (alias: string, machine: ManagedSshMachine) => boolean,
): boolean {
    const authority = normalizeRemoteAuthority(uri.authority);
    const machine = environmentMachine(snapshot, environment);
    if (!machine) { return false; }
    if (environment.kind === 'host') {
        const openedAlias = authority.startsWith('ssh-remote+')
            ? authority.slice('ssh-remote+'.length) : '';
        return aliasMatches(openedAlias, machine);
    }
    const anchor = environment.devContainerAnchor;
    if (!anchor) { return false; }
    if (authority === normalizeRemoteAuthority(anchor.originalAuthority)) {
        return true;
    }
    const parsed = parseManagedDevContainerProjectUri(uri.toString());
    return Boolean(parsed
        && parsed.anchor.sourceKind === anchor.sourceKind
        && parsed.anchor.sourceLocator === anchor.sourceLocator
        && aliasMatches(parsed.outerSshAuthority, machine));
}

/**
 * Whether a Dev Container anchor was launched from this host workspace folder.
 *
 * `LOCAL_WORKSPACE_FOLDER` is the folder on the outer host that the container
 * was launched from. A `workspace` anchor records that folder directly, while a
 * `config` anchor records the `.devcontainer.json` inside it, so the config case
 * is matched against the file's containing directory.
 */
function anchorMatchesHostWorkspace(
    anchor: ManagedEnvironment['devContainerAnchor'],
    normalizedHostWorkspace: string,
): boolean {
    if (!anchor) { return false; }
    const locator = normalizePosixPath(anchor.sourceLocator);
    if (anchor.sourceKind === 'workspace') {
        return locator === normalizedHostWorkspace;
    }
    if (anchor.sourceKind !== 'config') { return false; }
    const separator = locator.lastIndexOf('/');
    const directory = separator > 0 ? locator.slice(0, separator) : '/';
    if (directory === normalizedHostWorkspace) { return true; }
    // A .devcontainer.json may sit one level down in a .devcontainer directory.
    const parentSeparator = directory.lastIndexOf('/');
    return parentSeparator > 0
        && directory.slice(parentSeparator + 1) === '.devcontainer'
        && directory.slice(0, parentSeparator) === normalizedHostWorkspace;
}

/**
 * Resolve the current remote Environment only from its authority. Paths are
 * intentionally ignored because the same path can exist on unrelated hosts.
 */
export function findManagedEnvironmentForWorkspace(
    snapshot: ManagedRemoteManagementSnapshot,
    uri: vscode.Uri,
    context: ManagedCurrentRemoteContext = {},
): ManagedEnvironment | null {
    if (snapshot.lifecycle !== 'active' || !uri) {
        return null;
    }
    let matches: ManagedEnvironment[] = [];
    if (uri.scheme === 'vscode-remote') {
        matches = snapshot.catalog.environments.filter(environment =>
            environmentMatchesRemoteAuthority(
                snapshot, environment, uri,
                (alias, machine) => isManagedSshAliasForMachine(alias, machine.id),
            ));
    } else if (uri.scheme === 'file' && context.remoteName === 'dev-container') {
        const hostWorkspace = context.devContainerHostWorkspaceFolder;
        if (hostWorkspace) {
            const normalizedHostWorkspace = normalizePosixPath(hostWorkspace);
            matches = snapshot.catalog.environments.filter(environment =>
                environment.kind === 'devContainer'
                && anchorMatchesHostWorkspace(
                    environment.devContainerAnchor, normalizedHostWorkspace,
                ));
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve the first save from a Dev Container opened through a Managed SSH
 * alias. At this point the Environment does not exist yet, so the outer alias
 * is the only authoritative link back to a Machine.
 */
export function findManagedDevContainerSaveTarget(
    snapshot: ManagedRemoteManagementSnapshot,
    uri: vscode.Uri,
): ManagedDevContainerSaveTarget | null {
    if (snapshot.lifecycle !== 'active' || !uri) { return null; }
    const parsed = parseManagedDevContainerProjectUri(uri.toString());
    if (!parsed) { return null; }
    const machines = snapshot.catalog.machines.filter(machine =>
        isManagedSshAliasForMachine(parsed.outerSshAuthority, machine.id));
    if (machines.length !== 1) { return null; }
    const remotePath = managedRemotePathForWorkspace(uri);
    return remotePath ? {
        machine: machines[0],
        anchor: parsed.anchor,
        remotePath,
    } : null;
}

function currentOuterSshAlias(uri: vscode.Uri): string | null {
    const authority = normalizeRemoteAuthority(uri.authority);
    if (authority.startsWith('ssh-remote+')) {
        return authority.slice('ssh-remote+'.length) || null;
    }
    return parseManagedDevContainerProjectUri(uri.toString())?.outerSshAuthority || null;
}

export function managedProjectUriFromCurrentMachine(
    snapshot: ManagedRemoteManagementSnapshot,
    projectId: string,
    workspaceUris: readonly vscode.Uri[],
    context: ManagedCurrentRemoteContext = {},
): vscode.Uri | null {
    const project = snapshot.catalog.projects.find(value => value.id === projectId);
    if (!project) { throw new Error('Managed Project no longer exists.'); }
    const targetEnvironment = snapshot.catalog.environments.find(environment =>
        environment.id === project.environmentId);
    if (!targetEnvironment) { throw new Error('Managed Project Environment no longer exists.'); }
    for (const currentUri of workspaceUris || []) {
        const currentEnvironment = findManagedEnvironmentForWorkspace(
            snapshot,
            currentUri,
            context,
        );
        if (!currentEnvironment
            || currentEnvironment.machineId !== targetEnvironment.machineId) {
            continue;
        }
        if (currentEnvironment.id === targetEnvironment.id) {
            return currentUri.with({
                path: project.remotePath,
                query: '',
                fragment: '',
            });
        }
        const alias = currentOuterSshAlias(currentUri);
        if (!alias) { continue; }
        if (targetEnvironment.kind === 'host') {
            return vscode.Uri.parse(
                `vscode-remote://${encodeRemoteAuthority(`ssh-remote+${alias}`)}${encodeRemotePath(project.remotePath)}`,
            );
        }
        const rebuilt = rebuildManagedDevContainerProjectUri(
            targetEnvironment.devContainerAnchor!,
            alias,
            project.remotePath,
        );
        if (rebuilt) { return vscode.Uri.parse(rebuilt); }
    }
    return null;
}

export function findManagedProjectForOpenProject(
    snapshot: ManagedRemoteManagementSnapshot,
    uri: vscode.Uri,
    context: ManagedCurrentRemoteContext = {},
): ManagedOpenProjectMatch | null {
    if (snapshot.lifecycle !== 'active' || !uri) {
        return null;
    }
    const remotePath = normalizePosixPath(uri.path || uri.fsPath);
    const currentEnvironment = findManagedEnvironmentForWorkspace(
        snapshot,
        uri,
        context,
    );
    if (!currentEnvironment) { return null; }
    for (const project of snapshot.catalog.projects) {
        if (normalizePosixPath(project.remotePath) !== remotePath) { continue; }
        const environment = snapshot.catalog.environments.find(candidate =>
            candidate.id === project.environmentId);
        const machine = environment && environmentMachine(snapshot, environment);
        if (!environment || !machine) { continue; }
        if (environment.id === currentEnvironment.id) {
            return { project, environment, machine };
        }
    }
    return null;
}

export function findSavedProjectForOpenProject(savedProjects: Project[], uri: vscode.Uri): Project {
    return savedProjects.find(project => projectMatchesOpenProject(project, uri)) || null;
}

export function projectMatchesOpenProject(project: Project, uri: vscode.Uri): boolean {
    if (!project || !project.path || !uri) {
        return false;
    }

    return projectPathMatchesWorkspaceUri(project.path, uri);
}

export function projectPathMatchesWorkspaceUri(projectPath: string, workspaceUri: vscode.Uri): boolean {
    if (!workspaceUri || !projectPath) {
        return false;
    }

    let currentWorkspacePath = uriToProjectPath(workspaceUri);
    if (normalizeComparableProjectPath(projectPath) === normalizeComparableProjectPath(currentWorkspacePath)) {
        return true;
    }

    if (!isUriString(projectPath) || workspaceUri.scheme !== "vscode-remote") {
        return false;
    }

    try {
        let projectUri = vscode.Uri.parse(projectPath);
        if (projectUri.scheme !== "vscode-remote") {
            return false;
        }

        if (normalizeRemoteAuthority(projectUri.authority) !== normalizeRemoteAuthority(workspaceUri.authority)) {
            return false;
        }

        let projectUriPath = projectUri.path || projectUri.fsPath;
        let workspacePath = workspaceUri.path || workspaceUri.fsPath;

        return normalizePosixPath(projectUriPath) === normalizePosixPath(workspacePath);
    } catch (e) {
        return false;
    }
}

export function normalizeComparableProjectPath(projectPath: string): string {
    if (!projectPath) {
        return "";
    }

    try {
        if (isUriString(projectPath)) {
            let uri = vscode.Uri.parse(projectPath);
            if (uri.scheme === "file") {
                projectPath = uri.fsPath;
            } else {
                projectPath = `${uri.scheme}://${normalizeRemoteAuthority(uri.authority)}${uri.path}`;
            }
        }
    } catch (e) {
        // Keep the original path and normalize it below.
    }

    return projectPath.replace(/\\/g, '/').replace(/\/+$/g, '');
}

export function uriToProjectPath(uri: vscode.Uri): string {
    return uri.scheme === "file" ? uri.fsPath.trim() : uri.toString().trim();
}

/**
 * The absolute path a saved Managed Project should record for this window.
 *
 * Kept beside the matcher that compares it so the value written on save and the
 * value compared on lookup are normalized by the same code. Returns null when
 * the window has no absolute path to record.
 */
export function managedRemotePathForWorkspace(uri: vscode.Uri): string | null {
    if (!uri) { return null; }
    const remotePath = normalizePosixPath(uri.path || uri.fsPath);
    return remotePath.startsWith('/') ? remotePath : null;
}
