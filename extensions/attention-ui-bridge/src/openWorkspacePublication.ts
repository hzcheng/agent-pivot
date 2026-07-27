import {
    OpenWorkspacePublication,
    validateOpenWorkspacePublication,
} from '../../../src/openWorkspaces/protocol';
import {
    createWorkspaceScopeIdentity,
    createWorkspaceUriIdentity,
    WorkspaceUriIdentitySource,
} from '../../../src/workspaces/identity';
import { URL } from 'url';

export interface AuthoritativeOpenWorkspaceUri extends WorkspaceUriIdentitySource {
    value: string;
}

function requireMatchingResourcePath(
    publishedUri: string,
    authoritativeUri: AuthoritativeOpenWorkspaceUri,
    label: 'root' | 'workspace',
): void {
    let publishedPath: string;
    let authoritativePath: string;
    try {
        publishedPath = new URL(publishedUri).pathname;
        authoritativePath = new URL(authoritativeUri.value).pathname;
    } catch (error) {
        throw new Error(`${label} resource URI must be valid`);
    }
    if (publishedPath !== authoritativePath) {
        throw new Error(`${label} resource path must match before authority rewrite`);
    }
}

export function replaceOpenWorkspacePublicationUris(
    raw: unknown,
    workspaceUri: AuthoritativeOpenWorkspaceUri | null,
    rootUris: readonly AuthoritativeOpenWorkspaceUri[],
): OpenWorkspacePublication {
    const publication = validateOpenWorkspacePublication(raw);
    if (!publication.workspace) {
        return publication;
    }
    const workspace = publication.workspace;
    if (workspace.roots.length !== rootUris.length) {
        throw new Error('authoritative root count must match the published workspace roots');
    }
    workspace.roots.forEach((root, index) => {
        requireMatchingResourcePath(root.uri, rootUris[index], 'root');
    });
    if (workspace.kind === 'savedMultiRoot' && !workspaceUri) {
        throw new Error('authoritative saved workspace URI is required');
    }
    if (workspace.kind !== 'singleFolder' && workspaceUri) {
        requireMatchingResourcePath(workspace.navigationUri, workspaceUri, 'workspace');
    }
    const roots = workspace.roots.map((root, index) => ({
        ...root,
        id: createWorkspaceUriIdentity(rootUris[index]),
        uri: rootUris[index].value,
    }));
    const navigationTarget = workspace.kind === 'singleFolder'
        ? rootUris[0]
        : workspaceUri;
    const navigationUri = navigationTarget?.value || workspace.navigationUri;
    return validateOpenWorkspacePublication({
        ...publication,
        workspace: {
            ...workspace,
            navigationIdentity: navigationTarget
                ? createWorkspaceUriIdentity(navigationTarget)
                : workspace.navigationIdentity,
            scopeIdentity: createWorkspaceScopeIdentity(rootUris),
            navigationUri,
            roots,
        },
    });
}
