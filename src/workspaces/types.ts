export type OpenWorkspaceKind = 'singleFolder' | 'savedMultiRoot' | 'untitledMultiRoot';
export type OpenWorkspaceEnvironment = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';

export interface WorkspaceRoot {
    id: string;
    name: string;
    uri: string;
    hostPath: string;
    ordinal: number;
}

/** Maps an opened workspace root to its path relative to a repository root. */
export interface RepositoryRootBinding {
    workspaceRootId: string;
    repositoryRelativePath: string;
}

export interface OpenWorkspace {
    navigationIdentity: string;
    scopeIdentity: string;
    kind: OpenWorkspaceKind;
    displayName: string;
    navigationUri: string;
    environment: OpenWorkspaceEnvironment;
    roots: WorkspaceRoot[];
}
