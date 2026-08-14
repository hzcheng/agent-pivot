'use strict';

import { randomBytes } from 'crypto';
import type { WorktreeKey } from './types';

const STORAGE_KEY = 'agentPivot.worktreeGroups.v1';
const MAX_GROUPS_PER_WORKSPACE = 256;
const MAX_WORKSPACE_BUCKETS = 512;
const MAX_MEMBERS_PER_GROUP = 64;
const MAX_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_SLUG_LENGTH = 200;
const MAX_PATH_LENGTH = 32 * 1024;
const MAX_BRANCH_LENGTH = 1024;
const MAX_ERROR_LENGTH = 1024;

interface MementoLike {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

/**
 * Member lifecycle (docs/worktree-tasks-prd.md §4.2):
 * planned → provisioning → ready; failed → provisioning (retry) / removed
 * (dismiss); ready → deleting → removed. `worktreeKey` exists only once the
 * physical worktree has been created successfully.
 */
export type WorktreeGroupMemberState =
  | 'planned'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'deleting';

export interface WorktreeGroupMember {
    memberId: string;
    repositoryKey: string;
    /** Present only for members whose physical worktree exists (ready). */
    worktreeKey?: WorktreeKey;
    branchName: string;
    /** Planned path before creation; the actual worktree path once ready. */
    path: string;
    state: WorktreeGroupMemberState;
    /** The repository is currently outside the open workspace (§7). */
    detached?: boolean;
    /** Machine-readable error code for failed members (humanized in the UI). */
    lastError?: string;
}

export interface WorktreeGroup {
    groupId: string;
    displayName: string;
    suggestedSlug: string;
    /** Must reference a ready member while any ready member exists. */
    primaryMemberId: string | null;
    members: WorktreeGroupMember[];
    createdAt: number;
}

export type WorktreeGroupManifestErrorCode =
  | 'invalid-record'
  | 'group-not-found'
  | 'member-not-found'
  | 'worktree-key-claimed'
  | 'repository-conflict'
  | 'primary-not-ready'
  | 'store-full';

export class WorktreeGroupManifestError extends Error {
    constructor(readonly code: WorktreeGroupManifestErrorCode) {
        super(code);
        this.name = 'WorktreeGroupManifestError';
        Object.setPrototypeOf(this, WorktreeGroupManifestError.prototype);
    }
}

export interface NewWorktreeGroupMember {
    repositoryKey: string;
    worktreeKey?: WorktreeKey;
    branchName: string;
    path: string;
    state: WorktreeGroupMemberState;
    lastError?: string;
}

export interface NewWorktreeGroup {
    displayName: string;
    suggestedSlug: string;
    /** Index into `members` that should become the primary (must be ready). */
    primaryMemberIndex?: number;
    members: NewWorktreeGroupMember[];
}

type WorkspaceBucket = WorktreeGroup[];
type ManifestShape = Record<string, WorkspaceBucket>;

/**
 * Authoritative record of which physical worktrees form one work group
 * (docs/worktree-tasks-prd.md §5.2). Stored machine-locally in globalState,
 * bucketed by the stable workspace `navigationIdentity` so that adding or
 * removing repositories never re-buckets existing groups (§9). Heuristics
 * such as matching slugs are never written here automatically across
 * repositories; every record originates from an explicit user action or from
 * an extension-run provisioning flow.
 */
export class WorktreeGroupManifestStore {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly memento: MementoLike) {
    }

    listGroups(workspaceIdentity: string): WorktreeGroup[] {
        return this.readBucket(workspaceIdentity).map(cloneGroup);
    }

    findGroupByWorktreeKey(
        workspaceIdentity: string,
        key: WorktreeKey
    ): WorktreeGroup | null {
        const found = this.readBucket(workspaceIdentity).find(group =>
            group.members.some(member => member.worktreeKey
                && worktreeKeyEquals(member.worktreeKey, key)));
        return found ? cloneGroup(found) : null;
    }

    createGroup(workspaceIdentity: string, input: NewWorktreeGroup): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            if (bucket.length >= MAX_GROUPS_PER_WORKSPACE) {
                throw new WorktreeGroupManifestError('store-full');
            }
            const group: WorktreeGroup = {
                groupId: newId(),
                displayName: requireDisplayName(input.displayName),
                suggestedSlug: requireSlug(input.suggestedSlug),
                primaryMemberId: null,
                members: input.members.map(member => ({
                    memberId: newId(),
                    ...sanitizeMember(member),
                })),
                createdAt: Date.now(),
            };
            assertGroupInvariants(group);
            assertWorktreeKeysUnclaimed(bucket, group.members, null);
            const requested = typeof input.primaryMemberIndex === 'number'
                ? group.members[input.primaryMemberIndex]
                : undefined;
            if (requested && requested.state !== 'ready') {
                throw new WorktreeGroupManifestError('primary-not-ready');
            }
            group.primaryMemberId = requested?.memberId
                || group.members.find(member => member.state === 'ready')?.memberId
                || null;
            bucket.push(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    renameGroup(
        workspaceIdentity: string,
        groupId: string,
        displayName: string
    ): Promise<WorktreeGroup> {
        return this.mutateGroup(workspaceIdentity, groupId, group => {
            group.displayName = requireDisplayName(displayName);
        });
    }

    setPrimaryMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<WorktreeGroup> {
        return this.mutateGroup(workspaceIdentity, groupId, group => {
            const member = group.members.find(candidate => candidate.memberId === memberId);
            if (!member) {
                throw new WorktreeGroupManifestError('member-not-found');
            }
            if (member.state !== 'ready') {
                throw new WorktreeGroupManifestError('primary-not-ready');
            }
            group.primaryMemberId = member.memberId;
        });
    }

    addMember(
        workspaceIdentity: string,
        groupId: string,
        input: NewWorktreeGroupMember
    ): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const group = this.requireGroup(manifest, workspaceIdentity, groupId);
            if (group.members.length >= MAX_MEMBERS_PER_GROUP) {
                throw new WorktreeGroupManifestError('store-full');
            }
            const member: WorktreeGroupMember = {
                memberId: newId(),
                ...sanitizeMember(input),
            };
            assertWorktreeKeysUnclaimed(
                this.getBucket(manifest, workspaceIdentity), [member], group.groupId);
            group.members.push(member);
            assertGroupInvariants(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    updateMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string,
        patch: Partial<Pick<WorktreeGroupMember,
            'state' | 'worktreeKey' | 'branchName' | 'path' | 'lastError' | 'detached'>>
    ): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const group = this.requireGroup(manifest, workspaceIdentity, groupId);
            const member = group.members.find(candidate => candidate.memberId === memberId);
            if (!member) {
                throw new WorktreeGroupManifestError('member-not-found');
            }
            if (patch.state !== undefined) {
                member.state = patch.state;
            }
            if (patch.worktreeKey !== undefined) {
                assertWorktreeKeysUnclaimed(
                    this.getBucket(manifest, workspaceIdentity),
                    [{ ...member, worktreeKey: patch.worktreeKey }],
                    group.groupId);
                member.worktreeKey = Object.freeze({ ...patch.worktreeKey });
            }
            if (patch.branchName !== undefined) {
                member.branchName = requireBranchName(patch.branchName);
            }
            if (patch.path !== undefined) {
                member.path = requirePath(patch.path);
            }
            if (patch.lastError !== undefined) {
                member.lastError = patch.lastError
                    ? requireShortText(patch.lastError, MAX_ERROR_LENGTH, 'invalid-record')
                    : undefined;
            }
            if (patch.detached !== undefined) {
                member.detached = patch.detached || undefined;
            }
            if (group.primaryMemberId === member.memberId && member.state !== 'ready') {
                group.primaryMemberId = null;
            }
            assertGroupInvariants(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    /** Dismiss a failed intent or record a removed worktree. Never touches disk. */
    removeMember(
        workspaceIdentity: string,
        groupId: string,
        memberId: string
    ): Promise<WorktreeGroup | null> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            const group = this.requireGroup(manifest, workspaceIdentity, groupId);
            const index = group.members.findIndex(candidate => candidate.memberId === memberId);
            if (index < 0) {
                throw new WorktreeGroupManifestError('member-not-found');
            }
            group.members.splice(index, 1);
            if (group.primaryMemberId === memberId) {
                group.primaryMemberId = null;
            }
            if (group.members.length === 0) {
                // Empty groups disappear with their last member (PRD §4.2).
                bucket.splice(bucket.findIndex(candidate => candidate.groupId === groupId), 1);
                await this.writeManifest(manifest);
                return null;
            }
            assertGroupInvariants(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    deleteGroup(workspaceIdentity: string, groupId: string): Promise<void> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            const index = bucket.findIndex(candidate => candidate.groupId === groupId);
            if (index < 0) {
                throw new WorktreeGroupManifestError('group-not-found');
            }
            bucket.splice(index, 1);
            await this.writeManifest(manifest);
        });
    }

    /**
     * Group → group merge (PRD §6.5): every member of the source group moves
     * to the target group with its state; the source record is deleted.
     * Blocked when both groups hold a member of the same repository
     * (invariant 2). The target keeps its identity, name, and primary.
     */
    mergeGroups(
        workspaceIdentity: string,
        targetGroupId: string,
        sourceGroupId: string
    ): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            const target = this.requireGroup(manifest, workspaceIdentity, targetGroupId);
            const source = this.requireGroup(manifest, workspaceIdentity, sourceGroupId);
            if (target.groupId === source.groupId) {
                throw new WorktreeGroupManifestError('invalid-record');
            }
            const targetRepositories = new Set(target.members.map(member => member.repositoryKey));
            if (source.members.some(member => targetRepositories.has(member.repositoryKey))) {
                throw new WorktreeGroupManifestError('repository-conflict');
            }
            if (target.members.length + source.members.length > MAX_MEMBERS_PER_GROUP) {
                throw new WorktreeGroupManifestError('store-full');
            }
            target.members.push(...source.members);
            assertGroupInvariants(target);
            bucket.splice(bucket.findIndex(candidate => candidate.groupId === source.groupId), 1);
            await this.writeManifest(manifest);
            return cloneGroup(target);
        });
    }

    /** Marks every member of a repository (detached ⇄ visible) on workspace changes. */
    setRepositoryDetached(
        workspaceIdentity: string,
        repositoryKey: string,
        detached: boolean
    ): Promise<void> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            let changed = false;
            for (const group of bucket) {
                for (const member of group.members) {
                    if (member.repositoryKey === repositoryKey && !!member.detached !== detached) {
                        member.detached = detached || undefined;
                        changed = true;
                    }
                }
            }
            if (changed) {
                await this.writeManifest(manifest);
            }
        });
    }

    private mutateGroup(
        workspaceIdentity: string,
        groupId: string,
        mutate: (group: WorktreeGroup) => void
    ): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const group = this.requireGroup(manifest, workspaceIdentity, groupId);
            mutate(group);
            assertGroupInvariants(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    private requireGroup(
        manifest: ManifestShape,
        workspaceIdentity: string,
        groupId: string
    ): WorktreeGroup {
        const group = this.getBucket(manifest, workspaceIdentity)
            .find(candidate => candidate.groupId === groupId);
        if (!group) {
            throw new WorktreeGroupManifestError('group-not-found');
        }
        return group;
    }

    private getBucket(manifest: ManifestShape, workspaceIdentity: string): WorkspaceBucket {
        const key = requireWorkspaceIdentity(workspaceIdentity);
        if (!manifest[key]) {
            if (Object.keys(manifest).length >= MAX_WORKSPACE_BUCKETS) {
                throw new WorktreeGroupManifestError('store-full');
            }
            manifest[key] = [];
        }
        return manifest[key];
    }

    private readBucket(workspaceIdentity: string): WorktreeGroup[] {
        const key = requireWorkspaceIdentity(workspaceIdentity);
        return this.readManifest()[key] || [];
    }

    private readManifest(): ManifestShape {
        const stored = this.memento.get<unknown>(STORAGE_KEY, {});
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }
        const manifest: ManifestShape = {};
        for (const [bucketKey, bucket] of Object.entries(stored as Record<string, unknown>)
            .slice(0, MAX_WORKSPACE_BUCKETS)) {
            if (!isSafeText(bucketKey, MAX_ID_LENGTH) || !Array.isArray(bucket)) {
                continue;
            }
            const groups = bucket.slice(0, MAX_GROUPS_PER_WORKSPACE)
                .map(parseGroup)
                .filter((group): group is WorktreeGroup => !!group);
            if (groups.length > 0) {
                manifest[bucketKey] = groups;
            }
        }
        return manifest;
    }

    private writeManifest(manifest: ManifestShape): Promise<void> {
        const persisted: ManifestShape = {};
        for (const [bucketKey, bucket] of Object.entries(manifest)) {
            if (bucket.length > 0) {
                persisted[bucketKey] = bucket;
            }
        }
        return Promise.resolve(this.memento.update(STORAGE_KEY, persisted));
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeQueue.then(operation, operation);
        this.writeQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}

/** Invariant 2: one repository contributes at most one member to a group. */
function assertGroupInvariants(group: WorktreeGroup): void {
    const repositories = new Set<string>();
    for (const member of group.members) {
        if (repositories.has(member.repositoryKey)) {
            throw new WorktreeGroupManifestError('repository-conflict');
        }
        repositories.add(member.repositoryKey);
        if (member.state === 'ready' && !member.worktreeKey) {
            throw new WorktreeGroupManifestError('invalid-record');
        }
    }
    if (group.primaryMemberId) {
        const primary = group.members
            .find(member => member.memberId === group.primaryMemberId);
        if (!primary || primary.state !== 'ready') {
            throw new WorktreeGroupManifestError('primary-not-ready');
        }
    }
}

/** Invariant 1: within a workspace bucket a WorktreeKey belongs to ≤ 1 group. */
function assertWorktreeKeysUnclaimed(
    bucket: WorkspaceBucket,
    members: readonly WorktreeGroupMember[],
    owningGroupId: string | null
): void {
    for (const member of members) {
        if (!member.worktreeKey) {
            continue;
        }
        for (const group of bucket) {
            if (owningGroupId && group.groupId === owningGroupId) {
                continue;
            }
            if (group.members.some(candidate => candidate.worktreeKey
                && worktreeKeyEquals(candidate.worktreeKey, member.worktreeKey!))) {
                throw new WorktreeGroupManifestError('worktree-key-claimed');
            }
        }
    }
}

function worktreeKeyEquals(left: WorktreeKey, right: WorktreeKey): boolean {
    return left.repositoryKey === right.repositoryKey
        && left.canonicalWorktreePath === right.canonicalWorktreePath;
}

function parseGroup(value: unknown): WorktreeGroup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (!isSafeText(candidate.groupId, MAX_ID_LENGTH)
        || !isSafeText(candidate.displayName, MAX_DISPLAY_NAME_LENGTH)
        || !isSafeText(candidate.suggestedSlug, MAX_SLUG_LENGTH)
        || !Array.isArray(candidate.members)
        || typeof candidate.createdAt !== 'number'
        || !Number.isFinite(candidate.createdAt)) {
        return null;
    }
    const members = (candidate.members as unknown[])
        .slice(0, MAX_MEMBERS_PER_GROUP)
        .map(parseMember)
        .filter((member): member is WorktreeGroupMember => !!member);
    if (members.length === 0) {
        return null;
    }
    const group: WorktreeGroup = {
        groupId: candidate.groupId as string,
        displayName: candidate.displayName as string,
        suggestedSlug: candidate.suggestedSlug as string,
        primaryMemberId: isSafeText(candidate.primaryMemberId, MAX_ID_LENGTH)
            ? candidate.primaryMemberId as string
            : null,
        members,
        createdAt: candidate.createdAt as number,
    };
    try {
        assertGroupInvariants(group);
    } catch {
        return null;
    }
    return group;
}

const MEMBER_STATES: readonly WorktreeGroupMemberState[] = [
    'planned', 'provisioning', 'ready', 'failed', 'deleting',
];

function parseMember(value: unknown): WorktreeGroupMember | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (!isSafeText(candidate.memberId, MAX_ID_LENGTH)
        || !isSafeText(candidate.repositoryKey, MAX_PATH_LENGTH)
        || !isSafeText(candidate.branchName, MAX_BRANCH_LENGTH)
        || (candidate.branchName as string).startsWith('-')
        || !isSafeText(candidate.path, MAX_PATH_LENGTH)
        || !MEMBER_STATES.includes(candidate.state as WorktreeGroupMemberState)) {
        return null;
    }
    let worktreeKey: WorktreeKey | undefined;
    if (candidate.worktreeKey !== undefined) {
        const key = candidate.worktreeKey as Record<string, unknown>;
        if (!key || typeof key !== 'object'
            || !isSafeText(key.repositoryKey, MAX_PATH_LENGTH)
            || !isSafeText(key.canonicalWorktreePath, MAX_PATH_LENGTH)) {
            return null;
        }
        worktreeKey = Object.freeze({
            repositoryKey: key.repositoryKey as string,
            canonicalWorktreePath: key.canonicalWorktreePath as string,
        });
    }
    const state = candidate.state as WorktreeGroupMemberState;
    if (state === 'ready' && !worktreeKey) {
        return null;
    }
    return {
        memberId: candidate.memberId as string,
        repositoryKey: candidate.repositoryKey as string,
        ...(worktreeKey ? { worktreeKey } : {}),
        branchName: candidate.branchName as string,
        path: candidate.path as string,
        state,
        ...(candidate.detached === true ? { detached: true } : {}),
        ...(isSafeText(candidate.lastError, MAX_ERROR_LENGTH)
            ? { lastError: candidate.lastError as string }
            : {}),
    };
}

function sanitizeMember(input: NewWorktreeGroupMember): Omit<WorktreeGroupMember, 'memberId'> {
    if (!MEMBER_STATES.includes(input.state)) {
        throw new WorktreeGroupManifestError('invalid-record');
    }
    const member: Omit<WorktreeGroupMember, 'memberId'> = {
        repositoryKey: requirePath(input.repositoryKey),
        ...(input.worktreeKey
            ? {
                worktreeKey: Object.freeze({
                    repositoryKey: requirePath(input.worktreeKey.repositoryKey),
                    canonicalWorktreePath: requirePath(input.worktreeKey.canonicalWorktreePath),
                }),
            }
            : {}),
        branchName: requireBranchName(input.branchName),
        path: requirePath(input.path),
        state: input.state,
        ...(input.lastError
            ? { lastError: requireShortText(input.lastError, MAX_ERROR_LENGTH, 'invalid-record') }
            : {}),
    };
    return member;
}

function cloneGroup(group: WorktreeGroup): WorktreeGroup {
    return {
        ...group,
        members: group.members.map(member => ({
            ...member,
            ...(member.worktreeKey ? { worktreeKey: { ...member.worktreeKey } } : {}),
        })),
    };
}

function newId(): string {
    return randomBytes(16).toString('hex');
}

function isSafeText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0
        && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

function requireShortText(
    value: unknown,
    maxLength: number,
    code: WorktreeGroupManifestErrorCode
): string {
    if (!isSafeText(value, maxLength)) {
        throw new WorktreeGroupManifestError(code);
    }
    return value;
}

function requireDisplayName(value: unknown): string {
    return requireShortText(value, MAX_DISPLAY_NAME_LENGTH, 'invalid-record');
}

function requireSlug(value: unknown): string {
    return requireShortText(value, MAX_SLUG_LENGTH, 'invalid-record');
}

function requireBranchName(value: unknown): string {
    const branch = requireShortText(value, MAX_BRANCH_LENGTH, 'invalid-record');
    if (branch.startsWith('-')) {
        throw new WorktreeGroupManifestError('invalid-record');
    }
    return branch;
}

function requirePath(value: unknown): string {
    return requireShortText(value, MAX_PATH_LENGTH, 'invalid-record');
}

function requireWorkspaceIdentity(value: unknown): string {
    return requireShortText(value, MAX_ID_LENGTH, 'invalid-record');
}
