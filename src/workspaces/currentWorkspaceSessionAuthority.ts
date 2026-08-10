'use strict';

import { createHash } from 'crypto';

export const CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY =
    'agentPivot.currentWorkspaceSessionAuthority.v1';

const MAX_NAVIGATION_IDENTITY_LENGTH = 4096;
const MAX_SCOPE_IDENTITY_LENGTH = 512;
// One authority per maximum durable known-runtime record keeps restore
// complete while bounding Memento input and output.
const MAX_WORKSPACE_AUTHORITIES = 512;
const CURRENT_WORKSPACE_PROJECT_ID = /^__currentWorkspace-[a-f0-9]{24}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export interface CurrentWorkspaceSessionIdentity {
    workspaceNavigationIdentity: string;
    workspaceScopeIdentity: string;
}

interface PersistedWorkspaceSessionAuthority {
    workspaceNavigationIdentity: string;
    projectId: string;
}

interface PersistedCurrentWorkspaceSessionAuthorities {
    version: 1;
    workspaces: PersistedWorkspaceSessionAuthority[];
}

export class CurrentWorkspaceSessionAuthority {
    private authorities: Map<string, string> | undefined;
    private persistQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly state?: MementoLike,
        private readonly onPersistenceError?: (error: unknown) => void
    ) { }

    getProjectId(identity: CurrentWorkspaceSessionIdentity): string {
        const normalized = normalizeIdentity(identity);
        const authorities = this.getAuthorities();
        const existing = authorities.get(
            normalized.workspaceNavigationIdentity
        );
        if (existing) {
            return existing;
        }

        // Preserve the pre-authority project ID on first adoption so existing
        // Conversation metadata remains addressable.
        const projectId = createLegacyCurrentWorkspaceProjectId(
            normalized.workspaceScopeIdentity
        );
        while (authorities.size >= MAX_WORKSPACE_AUTHORITIES) {
            const oldest = authorities.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            authorities.delete(oldest);
        }
        authorities.set(normalized.workspaceNavigationIdentity, projectId);
        this.persist(authorities);
        return projectId;
    }

    private getAuthorities(): Map<string, string> {
        if (this.authorities) {
            return this.authorities;
        }
        try {
            this.authorities = parsePersistedAuthorities(
                this.state?.get<unknown>(
                    CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY
                )
            );
        } catch (error) {
            this.authorities = new Map();
            this.onPersistenceError?.(error);
        }
        return this.authorities;
    }

    private persist(authorities: ReadonlyMap<string, string>): void {
        if (!this.state) {
            return;
        }
        const value: PersistedCurrentWorkspaceSessionAuthorities = {
            version: 1,
            workspaces: Array.from(authorities, (
                [workspaceNavigationIdentity, projectId]
            ) => ({ workspaceNavigationIdentity, projectId })),
        };
        this.persistQueue = this.persistQueue.then(() =>
            Promise.resolve(this.state?.update(
                CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY,
                value
            ))
        ).catch(error => {
            this.onPersistenceError?.(error);
        });
    }
}

export function createLegacyCurrentWorkspaceProjectId(
    workspaceScopeIdentity: string
): string {
    const normalized = normalizeIdentityPart(
        workspaceScopeIdentity,
        MAX_SCOPE_IDENTITY_LENGTH,
        'workspace scope identity'
    );
    const digest = createHash('sha256')
        .update(normalized)
        .digest('hex')
        .slice(0, 24);
    return `__currentWorkspace-${digest}`;
}

function normalizeIdentity(
    identity: CurrentWorkspaceSessionIdentity
): CurrentWorkspaceSessionIdentity {
    return {
        workspaceNavigationIdentity: normalizeIdentityPart(
            identity?.workspaceNavigationIdentity,
            MAX_NAVIGATION_IDENTITY_LENGTH,
            'workspace navigation identity'
        ),
        workspaceScopeIdentity: normalizeIdentityPart(
            identity?.workspaceScopeIdentity,
            MAX_SCOPE_IDENTITY_LENGTH,
            'workspace scope identity'
        ),
    };
}

function normalizeIdentityPart(
    value: unknown,
    maxLength: number,
    label: string
): string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > maxLength
        || CONTROL_CHARACTERS.test(value)) {
        throw new Error(`Invalid ${label}.`);
    }
    return value;
}

function parsePersistedAuthorities(
    value: unknown
): Map<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return new Map();
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',')
            !== 'version,workspaces'
        || record.version !== 1
        || !Array.isArray(record.workspaces)
        || record.workspaces.length > MAX_WORKSPACE_AUTHORITIES) {
        return new Map();
    }
    const authorities = new Map<string, string>();
    for (const value of record.workspaces) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return new Map();
        }
        const authority = value as Record<string, unknown>;
        if (Object.keys(authority).sort().join(',')
                !== 'projectId,workspaceNavigationIdentity'
            || typeof authority.workspaceNavigationIdentity !== 'string'
            || authority.workspaceNavigationIdentity.length === 0
            || authority.workspaceNavigationIdentity.length
                > MAX_NAVIGATION_IDENTITY_LENGTH
            || CONTROL_CHARACTERS.test(
                authority.workspaceNavigationIdentity
            )
            || authorities.has(authority.workspaceNavigationIdentity)
            || typeof authority.projectId !== 'string'
            || !CURRENT_WORKSPACE_PROJECT_ID.test(authority.projectId)) {
            return new Map();
        }
        authorities.set(
            authority.workspaceNavigationIdentity,
            authority.projectId
        );
    }
    return authorities;
}
