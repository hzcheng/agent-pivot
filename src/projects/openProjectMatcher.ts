'use strict';

import { isUriString } from '../uriStrings';
import * as vscode from 'vscode';

import { getRemoteType, getRemoteTypeFromRemoteName, Project, ProjectRemoteType } from '../models';
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
    isLegacyNameOnlyAliasForMachine,
    isManagedSshAliasForMachine,
    managedSshAlias,
} from './managedRemote/sshConfigProjection';
import {
    encodeRemoteAuthority,
    normalizePosixPath,
    normalizeRemoteAuthority,
} from './projectPathUtils';

export interface ManagedOpenProjectMatch {
    project: ManagedRemoteProject;
    environment: ManagedEnvironment;
    machine: ManagedSshMachine;
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

function openedOuterAlias(uri: vscode.Uri): string {
    const authority = normalizeRemoteAuthority(uri.authority);
    if (authority.startsWith('ssh-remote+')) {
        return authority.slice('ssh-remote+'.length);
    }
    return parseManagedDevContainerProjectUri(uri.toString())?.outerSshAuthority || '';
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
        if (!matches.length) {
            // An alias projected before the identity suffix existed carries no
            // Machine identity, so it can only be attributed when exactly one
            // Machine claims it. Two Machines sharing a name or connection host
            // (a dev box registered alongside its Dev Container) stay ambiguous
            // rather than resolving to an arbitrary one.
            const alias = openedOuterAlias(uri);
            const claimants = snapshot.catalog.machines.filter(machine =>
                isLegacyNameOnlyAliasForMachine(
                    alias, machine.name, machine.connection.host,
                ));
            if (claimants.length === 1) {
                const ownerId = claimants[0].id;
                matches = snapshot.catalog.environments.filter(environment =>
                    environmentMatchesRemoteAuthority(
                        snapshot, environment, uri,
                        (_alias, machine) => machine.id === ownerId,
                    ));
            }
        }
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
                `vscode-remote://${encodeRemoteAuthority(`ssh-remote+${alias}`)}${project.remotePath}`,
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

export function findSavedProjectForOpenProject(savedProjects: Project[], uri: vscode.Uri, currentRemoteName: string): Project {
    let exactMatch = savedProjects.find(project => projectMatchesOpenProject(project, uri));
    if (exactMatch) {
        return exactMatch;
    }

    let remotePathMatches = savedProjects.filter(project => projectPathMatchesRemoteOpenProject(project, uri, currentRemoteName));
    return remotePathMatches.length === 1 ? remotePathMatches[0] : null;
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

export function projectPathMatchesRemoteOpenProject(project: Project, uri: vscode.Uri, currentRemoteName: string): boolean {
    if (!currentRemoteName || !projectRemoteTypeMatchesCurrentRemote(project, currentRemoteName)) {
        return false;
    }

    if (uri.scheme === "vscode-remote" || uri.authority) {
        return false;
    }

    let projectPath = getProjectPathPart(project.path);
    let openPath = uri.path || uri.fsPath;
    if (!projectPath || !openPath) {
        return false;
    }

    return normalizePosixPath(projectPath) === normalizePosixPath(openPath);
}

export function projectRemoteTypeMatchesCurrentRemote(project: Project, currentRemoteName: string): boolean {
    let currentRemoteType = getRemoteTypeFromRemoteName(currentRemoteName);
    if (currentRemoteType === ProjectRemoteType.None) {
        return false;
    }

    return getRemoteType(project) === currentRemoteType;
}

export function getProjectPathPart(projectPath: string): string {
    if (!projectPath) {
        return projectPath;
    }

    if (!isUriString(projectPath)) {
        return projectPath;
    }

    try {
        let uri = vscode.Uri.parse(projectPath);
        return uri.path || uri.fsPath || projectPath;
    } catch (e) {
        return projectPath;
    }
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
