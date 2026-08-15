'use strict';

import { randomBytes } from 'crypto';
import type { WorktreeKey } from './types';
import { slugifyTaskName } from './provisioningPlan';
import type {
    GenerationClaim,
    RetiredAffectedSession,
    RetiredWorktreeIdentity,
} from './retiredWorktrees';

const STORAGE_KEY = 'agentPivot.worktreeGroups.v1';
const MAX_GROUPS_PER_WORKSPACE = 256;
const MAX_WORKSPACE_BUCKETS = 512;
const MAX_MEMBERS_PER_GROUP = 64;
const MAX_RETIRED_PER_WORKSPACE = 256;
const MAX_AFFECTED_SESSIONS_PER_RECORD = 256;
const MAX_GENERATION_CLAIMS_PER_WORKSPACE = 1024;
const MAX_AGGREGATE_SERIALIZED_BYTES = 1024 * 1024;
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
    /**
     * Persistent monotonic revision (PRD §4): 1 at creation, incremented by
     * every successful mutation. Preview/confirm tokens bind to it; a content
     * fingerprint must never substitute (ABA: name A → B → A must still
     * invalidate earlier tokens).
     */
    revision: number;
}

export type WorktreeGroupManifestErrorCode =
  | 'invalid-record'
  | 'group-not-found'
  | 'member-not-found'
  | 'worktree-key-claimed'
  | 'repository-conflict'
  | 'primary-not-ready'
  | 'group-changed'
  | 'store-corrupt'
  | 'store-full';

export class WorktreeGroupManifestError extends Error {
    constructor(readonly code: WorktreeGroupManifestErrorCode) {
        super(code);
        this.name = 'WorktreeGroupManifestError';
        Object.setPrototypeOf(this, WorktreeGroupManifestError.prototype);
    }
}

export type GenerationClaimResolution =
    | { kind: 'keep' }
    | { kind: 'promote'; provider: string; sessionId: string };

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

/**
 * Aggregate v2 (PRD §9): each workspace bucket is one versioned blob
 * holding groups plus the deletion-related sections, so multi-section
 * transactions (deletion checkpoint = retired write + member removal +
 * journal advance) commit in a single memento update. v1 buckets (bare
 * group arrays) migrate structurally on read; no data is ever inferred
 * into the new sections.
 */
interface WorkspaceAggregate {
    version: 2;
    groups: WorktreeGroup[];
    retiredIdentities: RetiredWorktreeIdentity[];
    /** Reserved for the deletion journal (batch 3); parsed tolerantly. */
    deletionJournal: unknown[];
    generationClaims: GenerationClaim[];
    /**
     * Persisted quarantine marker: set when the blob fails cross-record
     * validation (e.g. a duplicate retirement id). It survives reloads and
     * unrelated group mutations, claims read as empty, and retired/claim
     * mutations fail closed — because choosing any record by order would
     * let corruption decide resumability. Retired records themselves stay
     * readable: they are historical facts used for unresumable marking,
     * which is the fail-closed direction.
     */
    corrupt?: boolean;
    /**
     * Persistent high-water mark for generation cutoffs: bumped atomically
     * by every deletion begin, never regresses — not even when retired
     * records are cleaned up — so a system clock rollback cannot make a new
     * cutoff sort before an older one.
     */
    lastGenerationCutoffAt: number;
}

type ManifestShape = Record<string, WorkspaceAggregate>;

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
        return this.readAggregate(workspaceIdentity).groups.map(cloneGroup);
    }

    findGroupByWorktreeKey(
        workspaceIdentity: string,
        key: WorktreeKey
    ): WorktreeGroup | null {
        const found = this.readAggregate(workspaceIdentity).groups.find(group =>
            group.members.some(member => member.worktreeKey
                && worktreeKeyEquals(member.worktreeKey, key)));
        return found ? cloneGroup(found) : null;
    }

    createGroup(workspaceIdentity: string, input: NewWorktreeGroup): Promise<WorktreeGroup> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            if (bucket.groups.length >= MAX_GROUPS_PER_WORKSPACE) {
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
                revision: 1,
            };
            assertGroupInvariants(group);
            assertWorktreeKeysUnclaimed(bucket.groups, group.members, null);
            const requested = typeof input.primaryMemberIndex === 'number'
                ? group.members[input.primaryMemberIndex]
                : undefined;
            if (requested && requested.state !== 'ready') {
                throw new WorktreeGroupManifestError('primary-not-ready');
            }
            group.primaryMemberId = requested?.memberId
                || group.members.find(member => member.state === 'ready')?.memberId
                || null;
            bucket.groups.push(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    renameGroup(
        workspaceIdentity: string,
        groupId: string,
        displayName: string,
        expectedRevision?: number
    ): Promise<WorktreeGroup> {
        return this.mutateGroup(workspaceIdentity, groupId, group => {
            if (expectedRevision !== undefined
                && group.revision !== expectedRevision) {
                // The webview edited against an older authoritative state
                // (a concurrent rename/member change landed meanwhile):
                // fail closed instead of silently last-write-wins.
                throw new WorktreeGroupManifestError('group-changed');
            }
            // Renaming regenerates the suggested slug authoritatively (PRD
            // §5.2): the name, slug, and revision land in one write so
            // future Add repo/derive naming never follows a stale slug, and
            // no caller can change the name without the slug.
            const name = requireDisplayName(displayName);
            const slug = slugifyTaskName(name);
            if (!slug) {
                throw new WorktreeGroupManifestError('invalid-record');
            }
            group.displayName = name;
            group.suggestedSlug = slug;
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
                this.getBucket(manifest, workspaceIdentity).groups, [member], group.groupId);
            group.members.push(member);
            bumpRevision(group);
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
                    this.getBucket(manifest, workspaceIdentity).groups,
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
            bumpRevision(group);
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
                bucket.groups.splice(
                    bucket.groups.findIndex(candidate => candidate.groupId === groupId), 1);
                await this.writeManifest(manifest);
                return null;
            }
            bumpRevision(group);
            assertGroupInvariants(group);
            await this.writeManifest(manifest);
            return cloneGroup(group);
        });
    }

    deleteGroup(workspaceIdentity: string, groupId: string): Promise<void> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            const index = bucket.groups.findIndex(candidate => candidate.groupId === groupId);
            if (index < 0) {
                throw new WorktreeGroupManifestError('group-not-found');
            }
            bucket.groups.splice(index, 1);
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
            bumpRevision(target);
            assertGroupInvariants(target);
            bucket.groups.splice(
                bucket.groups.findIndex(candidate => candidate.groupId === source.groupId), 1);
            await this.writeManifest(manifest);
            return cloneGroup(target);
        });
    }

    // ---------- Retired identities & generation claims (PRD §6.4) ----------

    listRetiredIdentities(workspaceIdentity: string): RetiredWorktreeIdentity[] {
        const aggregate = this.readAggregate(workspaceIdentity);
        return aggregate.retiredIdentities
            .map(cloneRetiredIdentity);
    }

    listGenerationClaims(workspaceIdentity: string): GenerationClaim[] {
        const aggregate = this.readAggregate(workspaceIdentity);
        if (aggregate.corrupt) {
            return [];
        }
        return aggregate.generationClaims
            .map(cloneGenerationClaim);
    }

    /** Whether the bucket's retired/claim sections failed validation. */
    isRetiredStoreCorrupt(workspaceIdentity: string): boolean {
        return !!this.readAggregate(workspaceIdentity).corrupt;
    }

    /**
     * Explicit repair for a quarantined bucket: drops the retired/claim
     * sections and the corrupt marker. Deliberately separate from every
     * automatic path — only a user-facing reset may call this.
     */
    resetCorruptRetiredStore(workspaceIdentity: string): Promise<void> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.getBucket(manifest, workspaceIdentity);
            bucket.retiredIdentities = [];
            bucket.generationClaims = [];
            bucket.deletionJournal = [];
            bucket.corrupt = undefined;
            await this.writeManifest(manifest);
        });
    }

    private requireHealthyBucket(
        manifest: ManifestShape,
        workspaceIdentity: string
    ): WorkspaceAggregate {
        const bucket = this.getBucket(manifest, workspaceIdentity);
        if (bucket.corrupt) {
            throw new WorktreeGroupManifestError('store-corrupt');
        }
        return bucket;
    }

    /**
     * Records a retired worktree identity. Only the journaled deletion flow
     * may call this (never reconciliation guesses). Bumps the persistent
     * cutoff high-water mark in the same write.
     */
    recordRetiredIdentity(
        workspaceIdentity: string,
        input: Omit<RetiredWorktreeIdentity, 'affectedSessions' | 'truncated'> & {
            affectedSessions: readonly RetiredAffectedSession[];
        }
    ): Promise<RetiredWorktreeIdentity> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            if (bucket.retiredIdentities.length >= MAX_RETIRED_PER_WORKSPACE) {
                throw new WorktreeGroupManifestError('store-full');
            }
            if (bucket.retiredIdentities.some(record =>
                record.retirementId === input.retirementId)) {
                // Retirement ids are bucket-unique: reusing one would make
                // generation claims ambiguous about which retirement they
                // postdate.
                throw new WorktreeGroupManifestError('invalid-record');
            }
            const seen = new Set<string>();
            const affectedSessions: RetiredAffectedSession[] = [];
            let truncated = false;
            for (const entry of input.affectedSessions) {
                const provider = requireShortText(entry?.provider, MAX_ID_LENGTH, 'invalid-record');
                const sessionId = requireShortText(
                    entry?.sessionId, MAX_ID_LENGTH, 'invalid-record');
                const key = `${provider}::${sessionId}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                if (affectedSessions.length >= MAX_AFFECTED_SESSIONS_PER_RECORD) {
                    // The detail is lost; the generation rules fail closed
                    // for any session without precise identity (PRD §6.4).
                    truncated = true;
                    continue;
                }
                affectedSessions.push({ provider, sessionId });
            }
            const record: RetiredWorktreeIdentity = {
                retirementId: requireShortText(
                    input.retirementId, MAX_ID_LENGTH, 'invalid-record'),
                repositoryKey: requirePath(input.repositoryKey),
                canonicalWorktreePath: requirePath(input.canonicalWorktreePath),
                branchName: requireBranchName(input.branchName),
                deletedAt: requireTimestamp(input.deletedAt),
                generationCutoffAt: requireTimestamp(input.generationCutoffAt),
                ...(input.origin
                    ? {
                        origin: {
                            groupId: requireShortText(
                                input.origin.groupId, MAX_ID_LENGTH, 'invalid-record'),
                            memberId: requireShortText(
                                input.origin.memberId, MAX_ID_LENGTH, 'invalid-record'),
                            displayName: requireDisplayName(input.origin.displayName),
                        },
                    }
                    : {}),
                affectedSessions,
                ...(truncated ? { truncated: true } : {}),
            };
            bucket.retiredIdentities.push(record);
            bucket.lastGenerationCutoffAt = Math.max(
                bucket.lastGenerationCutoffAt, record.generationCutoffAt);
            await this.writeManifest(manifest);
            return cloneRetiredIdentity(record);
        });
    }

    /**
     * The next generation cutoff: monotonic per workspace bucket even under
     * system clock rollback, persisted as a high-water mark that retired
     * record cleanup never regresses.
     */
    nextGenerationCutoff(workspaceIdentity: string, nowMs: number): number {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new WorktreeGroupManifestError('invalid-record');
        }
        const bucket = this.readAggregate(workspaceIdentity);
        return Math.max(nowMs, bucket.lastGenerationCutoffAt + 1);
    }

    /**
     * Persists a pending generation claim before any terminal/provider side
     * effect of a session creation on a retired path (PRD §6.4). The claim
     * references the latest retirement of the key at creation time.
     */
    createGenerationClaim(
        workspaceIdentity: string,
        input: {
            pendingId: string;
            worktreeKey: WorktreeKey;
            createdAfterRetirementId: string;
            createdAtMs: number;
            creatingProvider?: string;
            launchMarkerPath?: string;
        }
    ): Promise<GenerationClaim> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            const basis = bucket.retiredIdentities.find(record =>
                record.retirementId === input.createdAfterRetirementId);
            if (!basis
                || basis.repositoryKey !== input.worktreeKey.repositoryKey
                || basis.canonicalWorktreePath !== input.worktreeKey.canonicalWorktreePath) {
                // The claim's basis must retire the very same worktree key;
                // otherwise a newer retirement of a foreign key could prove
                // this key's sessions "current" (fail-open).
                throw new WorktreeGroupManifestError('invalid-record');
            }
            if (bucket.generationClaims.some(candidate =>
                candidate.state === 'pending' && candidate.pendingId === input.pendingId)) {
                throw new WorktreeGroupManifestError('invalid-record');
            }
            if (bucket.generationClaims.length >= MAX_GENERATION_CLAIMS_PER_WORKSPACE) {
                throw new WorktreeGroupManifestError('store-full');
            }
            const claim: GenerationClaim = {
                claimId: newId(),
                worktreeKey: Object.freeze({
                    repositoryKey: requirePath(input.worktreeKey.repositoryKey),
                    canonicalWorktreePath: requirePath(input.worktreeKey.canonicalWorktreePath),
                }),
                createdAfterRetirementId: basis.retirementId,
                createdAtMs: requireTimestamp(input.createdAtMs),
                state: 'pending',
                pendingId: requireShortText(input.pendingId, MAX_ID_LENGTH, 'invalid-record'),
                ...(input.creatingProvider
                    ? {
                        creatingProvider: requireShortText(
                            input.creatingProvider, MAX_ID_LENGTH, 'invalid-record'),
                    }
                    : {}),
                ...(input.launchMarkerPath
                    ? { launchMarkerPath: requirePath(input.launchMarkerPath) }
                    : {}),
            };
            bucket.generationClaims.push(claim);
            await this.writeManifest(manifest);
            return cloneGenerationClaim(claim);
        });
    }

    /** Atomically promotes a pending claim once the session id is known. */
    promoteGenerationClaim(
        workspaceIdentity: string,
        pendingId: string,
        session: { provider: string; sessionId: string }
    ): Promise<GenerationClaim> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            const claim = bucket.generationClaims.find(candidate =>
                candidate.state === 'pending' && candidate.pendingId === pendingId);
            if (!claim) {
                throw new WorktreeGroupManifestError('invalid-record');
            }
            if (claim.creatingProvider && claim.creatingProvider !== session.provider) {
                // The provider is part of the session's composite identity:
                // a Codex pending claim must never become a Kimi session.
                throw new WorktreeGroupManifestError('invalid-record');
            }
            if (bucket.generationClaims.some(candidate =>
                candidate.state === 'promoted'
                && candidate.provider === session.provider
                && candidate.sessionId === session.sessionId)) {
                // A promoted session identity may back at most one claim.
                throw new WorktreeGroupManifestError('invalid-record');
            }
            const promoted: GenerationClaim = {
                claimId: claim.claimId,
                worktreeKey: claim.worktreeKey,
                createdAfterRetirementId: claim.createdAfterRetirementId,
                createdAtMs: claim.createdAtMs,
                state: 'promoted',
                provider: requireShortText(session.provider, MAX_ID_LENGTH, 'invalid-record'),
                sessionId: requireShortText(session.sessionId, MAX_ID_LENGTH, 'invalid-record'),
            };
            bucket.generationClaims.splice(
                bucket.generationClaims.findIndex(candidate =>
                    candidate.claimId === claim.claimId),
                1,
                promoted);
            await this.writeManifest(manifest);
            return cloneGenerationClaim(promoted);
        });
    }

    /** Compensating delete for failed starts and authoritative cleanup. */
    removeGenerationClaim(workspaceIdentity: string, claimId: string): Promise<boolean> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            const index = bucket.generationClaims.findIndex(candidate =>
                candidate.claimId === claimId);
            if (index < 0) {
                return false;
            }
            bucket.generationClaims.splice(index, 1);
            await this.writeManifest(manifest);
            return true;
        });
    }

    /**
     * Idempotent crash-recovery pass over pending claims (PRD §6.4): the
     * runtime promotion and the claim promotion are separate writes, so a
     * crash between them leaves a pending claim whose runtime is gone. The
     * resolver classifies each pending claim from durable evidence; every
     * resolution is validated and applied in one aggregate write. There is
     * no discard here by design: absence of evidence is not proof a launch
     * never happened, so claims leave only through promotion, the exact
     * in-process compensating delete, or explicit retired-record cleanup.
     */
    reconcileGenerationClaims(
        workspaceIdentity: string,
        resolve: (claim: GenerationClaim) => GenerationClaimResolution
    ): Promise<{ promoted: number; kept: number }> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            // Resolve everything first, then apply: two pending claims
            // resolving onto the same session identity must BOTH stay
            // pending — picking the first by array order would be a guess.
            const resolutions = new Map<string, GenerationClaimResolution>();
            for (const claim of bucket.generationClaims) {
                if (claim.state !== 'pending') {
                    continue;
                }
                let resolution: GenerationClaimResolution;
                try {
                    resolution = resolve(cloneGenerationClaim(claim));
                } catch {
                    resolution = { kind: 'keep' };
                }
                if (resolution?.kind === 'promote'
                    && (!isSafeText(resolution.provider, MAX_ID_LENGTH)
                        || !isSafeText(resolution.sessionId, MAX_ID_LENGTH))) {
                    resolution = { kind: 'keep' };
                }
                resolutions.set(claim.claimId, resolution || { kind: 'keep' });
            }
            const claimedIdentities = new Map<string, number>();
            for (const claim of bucket.generationClaims) {
                if (claim.state === 'promoted') {
                    claimedIdentities.set(`${claim.provider}::${claim.sessionId}`, 1);
                }
            }
            for (const claim of bucket.generationClaims) {
                const resolution = resolutions.get(claim.claimId);
                if (claim.state === 'pending' && resolution?.kind === 'promote') {
                    const identity = `${resolution.provider}::${resolution.sessionId}`;
                    claimedIdentities.set(identity, (claimedIdentities.get(identity) || 0) + 1);
                }
            }
            const outcome = { promoted: 0, kept: 0 };
            const nextClaims: GenerationClaim[] = [];
            let changed = false;
            for (const claim of bucket.generationClaims) {
                const resolution = resolutions.get(claim.claimId);
                if (claim.state !== 'pending' || !resolution) {
                    nextClaims.push(claim);
                    continue;
                }
                if (resolution.kind === 'promote') {
                    const identity = `${resolution.provider}::${resolution.sessionId}`;
                    if (claimedIdentities.get(identity) !== 1) {
                        // Ambiguous or already-taken target: keep every
                        // claimant pending, never guess.
                        nextClaims.push(claim);
                        outcome.kept += 1;
                        continue;
                    }
                    nextClaims.push({
                        claimId: claim.claimId,
                        worktreeKey: claim.worktreeKey,
                        createdAfterRetirementId: claim.createdAfterRetirementId,
                        createdAtMs: claim.createdAtMs,
                        state: 'promoted',
                        provider: resolution.provider,
                        sessionId: resolution.sessionId,
                    });
                    outcome.promoted += 1;
                    changed = true;
                    continue;
                }
                nextClaims.push(claim);
                outcome.kept += 1;
            }
            if (changed) {
                bucket.generationClaims = nextClaims;
                await this.writeManifest(manifest);
            }
            return outcome;
        });
    }

    /**
     * Removes a retired record and releases the generation claims that
     * reference it (PRD §6.4 capacity escape hatch). Callers must prove
     * first that no active/pending/history session references the record —
     * the store cannot judge that. The cutoff high-water mark never
     * regresses when records are removed.
     */
    removeRetiredIdentity(
        workspaceIdentity: string,
        retirementId: string
    ): Promise<boolean> {
        return this.enqueue(async () => {
            const manifest = this.readManifest();
            const bucket = this.requireHealthyBucket(manifest, workspaceIdentity);
            const index = bucket.retiredIdentities.findIndex(record =>
                record.retirementId === retirementId);
            if (index < 0) {
                return false;
            }
            bucket.retiredIdentities.splice(index, 1);
            bucket.generationClaims = bucket.generationClaims.filter(claim =>
                claim.createdAfterRetirementId !== retirementId);
            await this.writeManifest(manifest);
            return true;
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
            for (const group of bucket.groups) {
                let groupChanged = false;
                for (const member of group.members) {
                    if (member.repositoryKey === repositoryKey && !!member.detached !== detached) {
                        member.detached = detached || undefined;
                        changed = true;
                        groupChanged = true;
                    }
                }
                if (groupChanged) {
                    bumpRevision(group);
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
            bumpRevision(group);
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
            .groups
            .find(candidate => candidate.groupId === groupId);
        if (!group) {
            throw new WorktreeGroupManifestError('group-not-found');
        }
        return group;
    }

    private getBucket(manifest: ManifestShape, workspaceIdentity: string): WorkspaceAggregate {
        const key = requireWorkspaceIdentity(workspaceIdentity);
        if (!manifest[key]) {
            if (Object.keys(manifest).length >= MAX_WORKSPACE_BUCKETS) {
                throw new WorktreeGroupManifestError('store-full');
            }
            manifest[key] = emptyAggregate();
        }
        return manifest[key];
    }

    private readAggregate(workspaceIdentity: string): WorkspaceAggregate {
        const key = requireWorkspaceIdentity(workspaceIdentity);
        return this.readManifest()[key] || emptyAggregate();
    }

    private readManifest(): ManifestShape {
        const stored = this.memento.get<unknown>(STORAGE_KEY, {});
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }
        const manifest: ManifestShape = {};
        for (const [bucketKey, bucket] of Object.entries(stored as Record<string, unknown>)
            .slice(0, MAX_WORKSPACE_BUCKETS)) {
            if (!isSafeText(bucketKey, MAX_ID_LENGTH)) {
                continue;
            }
            // v1 buckets are bare group arrays; v2 buckets are aggregates.
            // The migration is structural only: the new sections start
            // empty and nothing is ever inferred into them (PRD §6.4:
            // retired facts come from journaled deletions alone).
            const aggregate = Array.isArray(bucket)
                ? { ...emptyAggregate(), groups: parseGroups(bucket) }
                : parseAggregate(bucket);
            if (aggregate) {
                if (!isAggregateEmpty(aggregate)) {
                    manifest[bucketKey] = aggregate;
                }
            } else {
                // An unreadable aggregate shape is structural damage: keep
                // the bucket alive as quarantined instead of dropping it
                // into a false "healthy and empty" state.
                manifest[bucketKey] = { ...emptyAggregate(), corrupt: true };
            }
        }
        return manifest;
    }

    private writeManifest(manifest: ManifestShape): Promise<void> {
        const persisted: ManifestShape = {};
        for (const [bucketKey, bucket] of Object.entries(manifest)) {
            if (!isAggregateEmpty(bucket)) {
                persisted[bucketKey] = bucket;
            }
        }
        // Measure real UTF-8 bytes, not UTF-16 code units: CJK content can
        // occupy ~3x its .length, and the deletion flow pre-reserves
        // capacity by actual frozen snapshot bytes (PRD §6.4).
        if (Buffer.byteLength(JSON.stringify(persisted), 'utf8')
            > MAX_AGGREGATE_SERIALIZED_BYTES) {
            throw new WorktreeGroupManifestError('store-full');
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
    if (!Number.isSafeInteger(group.revision) || group.revision < 1) {
        throw new WorktreeGroupManifestError('invalid-record');
    }
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
    bucket: readonly WorktreeGroup[],
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

function emptyAggregate(): WorkspaceAggregate {
    return {
        version: 2,
        groups: [],
        retiredIdentities: [],
        deletionJournal: [],
        generationClaims: [],
        lastGenerationCutoffAt: 0,
    };
}

function isAggregateEmpty(aggregate: WorkspaceAggregate): boolean {
    return aggregate.groups.length === 0
        && aggregate.retiredIdentities.length === 0
        && aggregate.deletionJournal.length === 0
        && aggregate.generationClaims.length === 0
        && !aggregate.corrupt
        && aggregate.lastGenerationCutoffAt === 0;
}

function parseGroups(bucket: unknown[]): WorktreeGroup[] {
    return bucket.slice(0, MAX_GROUPS_PER_WORKSPACE)
        .map(parseGroup)
        .filter((group): group is WorktreeGroup => !!group);
}

function parseAggregate(value: unknown): WorkspaceAggregate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 2) {
        return null;
    }
    // A section present but unreadable is structural damage, not an empty
    // section: quarantine rather than fail open on "no retired records".
    const sectionDamaged = (candidate.retiredIdentities !== undefined
            && !Array.isArray(candidate.retiredIdentities))
        || (candidate.generationClaims !== undefined
            && !Array.isArray(candidate.generationClaims))
        || (candidate.deletionJournal !== undefined
            && !Array.isArray(candidate.deletionJournal));
    const rawRetired = Array.isArray(candidate.retiredIdentities)
        ? candidate.retiredIdentities : [];
    const rawClaims = Array.isArray(candidate.generationClaims)
        ? candidate.generationClaims : [];
    const retiredIdentities = rawRetired
        .slice(0, MAX_RETIRED_PER_WORKSPACE)
        .map(parseRetiredIdentity)
        .filter((record): record is RetiredWorktreeIdentity => !!record);
    const generationClaims = rawClaims
        .slice(0, MAX_GENERATION_CLAIMS_PER_WORKSPACE)
        .map(parseGenerationClaim)
        .filter((claim): claim is GenerationClaim => !!claim);
    // A pending claim may be the only deletion blocker for a live session,
    // so no claim or retired record may ever be dropped silently: any parse
    // failure or overflow quarantines the bucket instead.
    const dropped = sectionDamaged
        || retiredIdentities.length !== rawRetired.length
        || generationClaims.length !== rawClaims.length;
    const aggregate: WorkspaceAggregate = {
        version: 2,
        groups: Array.isArray(candidate.groups) ? parseGroups(candidate.groups) : [],
        ...(candidate.corrupt === true || dropped ? { corrupt: true } : {}),
        retiredIdentities,
        // The deletion journal arrives with batch 3; tolerate and drop
        // anything unreadable rather than failing the whole bucket.
        deletionJournal: Array.isArray(candidate.deletionJournal)
            ? candidate.deletionJournal.slice(0, MAX_RETIRED_PER_WORKSPACE)
            : [],
        generationClaims,
        lastGenerationCutoffAt: typeof candidate.lastGenerationCutoffAt === 'number'
            && Number.isSafeInteger(candidate.lastGenerationCutoffAt)
            && candidate.lastGenerationCutoffAt >= 0
            ? candidate.lastGenerationCutoffAt
            : 0,
    };
    return sanitizeAggregateCrossInvariants(aggregate);
}

/**
 * Persisted blobs can predate the write-side invariants or be corrupt:
 * enforce the cross-record rules the lookup/reconcile logic relies on,
 * failing closed — a dropped claim only ever pushes sessions toward the
 * retired generation, and a dropped duplicate retirement cannot fabricate
 * a deletion fact.
 */
function sanitizeAggregateCrossInvariants(
    aggregate: WorkspaceAggregate
): WorkspaceAggregate {
    const seenRetirementIds = new Set<string>();
    const duplicateRetirement = aggregate.retiredIdentities.some(record => {
        if (seenRetirementIds.has(record.retirementId)) {
            return true;
        }
        seenRetirementIds.add(record.retirementId);
        return false;
    });
    if (duplicateRetirement) {
        // A retirement id must identify exactly one deletion fact. When it
        // does not, no record may win by array order: quarantine the
        // retired/claim sections (claims read empty, mutations fail
        // closed). The records themselves stay persisted and readable —
        // clearing them here would let the next unrelated group mutation
        // wash the corruption away as if nothing had happened.
        aggregate.corrupt = true;
        return aggregate;
    }
    // Any claim-level conflict quarantines the bucket: a pending claim may
    // be the only deletion blocker for a live session, and a promoted claim
    // is a generation proof — neither may be dropped nor chosen by order.
    const claimIds = new Map<string, number>();
    const pendingIds = new Map<string, number>();
    const promotedIdentities = new Map<string, number>();
    const retirementIds = new Set(
        aggregate.retiredIdentities.map(record => record.retirementId));
    let claimConflict = false;
    for (const claim of aggregate.generationClaims) {
        claimIds.set(claim.claimId, (claimIds.get(claim.claimId) || 0) + 1);
        if (claim.state === 'pending' && claim.pendingId) {
            pendingIds.set(claim.pendingId, (pendingIds.get(claim.pendingId) || 0) + 1);
        }
        if (claim.state === 'promoted') {
            const identity = `${claim.provider}::${claim.sessionId}`;
            promotedIdentities.set(identity, (promotedIdentities.get(identity) || 0) + 1);
        }
        const basis = claim.createdAfterRetirementId;
        const basisRecord = aggregate.retiredIdentities.find(record =>
            record.retirementId === basis);
        if (!retirementIds.has(basis)
            || basisRecord!.repositoryKey !== claim.worktreeKey.repositoryKey
            || basisRecord!.canonicalWorktreePath
                !== claim.worktreeKey.canonicalWorktreePath) {
            claimConflict = true;
        }
    }
    for (const count of claimIds.values()) {
        if (count !== 1) {
            claimConflict = true;
        }
    }
    for (const count of pendingIds.values()) {
        if (count !== 1) {
            claimConflict = true;
        }
    }
    for (const count of promotedIdentities.values()) {
        if (count !== 1) {
            claimConflict = true;
        }
    }
    if (claimConflict) {
        aggregate.corrupt = true;
        return aggregate;
    }
    // The cutoff high-water mark must cover every surviving retirement; a
    // lower stored value is repaired upward, never downward.
    for (const record of aggregate.retiredIdentities) {
        aggregate.lastGenerationCutoffAt = Math.max(
            aggregate.lastGenerationCutoffAt, record.generationCutoffAt);
    }
    return aggregate;
}

function parseRetiredIdentity(value: unknown): RetiredWorktreeIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (!isSafeText(candidate.retirementId, MAX_ID_LENGTH)
        || !isSafeText(candidate.repositoryKey, MAX_PATH_LENGTH)
        || !isSafeText(candidate.canonicalWorktreePath, MAX_PATH_LENGTH)
        || !isSafeText(candidate.branchName, MAX_BRANCH_LENGTH)
        || !Number.isSafeInteger(candidate.deletedAt)
        || !Number.isSafeInteger(candidate.generationCutoffAt)
        || (candidate.generationCutoffAt as number) < 0) {
        return null;
    }
    const affectedSessions: RetiredAffectedSession[] = [];
    const seenSessions = new Set<string>();
    if (Array.isArray(candidate.affectedSessions)) {
        for (const entry of candidate.affectedSessions
            .slice(0, MAX_AFFECTED_SESSIONS_PER_RECORD)) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const { provider, sessionId } = entry as Record<string, unknown>;
            if (!isSafeText(provider, MAX_ID_LENGTH)
                || !isSafeText(sessionId, MAX_ID_LENGTH)) {
                continue;
            }
            const key = `${provider}::${sessionId}`;
            if (seenSessions.has(key)) {
                continue;
            }
            seenSessions.add(key);
            affectedSessions.push({
                provider: provider as string,
                sessionId: sessionId as string,
            });
        }
    }
    let origin: RetiredWorktreeIdentity['origin'];
    if (candidate.origin && typeof candidate.origin === 'object'
        && !Array.isArray(candidate.origin)) {
        const raw = candidate.origin as Record<string, unknown>;
        if (isSafeText(raw.groupId, MAX_ID_LENGTH)
            && isSafeText(raw.memberId, MAX_ID_LENGTH)
            && isSafeText(raw.displayName, MAX_DISPLAY_NAME_LENGTH)) {
            origin = {
                groupId: raw.groupId as string,
                memberId: raw.memberId as string,
                displayName: raw.displayName as string,
            };
        }
    }
    return {
        retirementId: candidate.retirementId as string,
        repositoryKey: candidate.repositoryKey as string,
        canonicalWorktreePath: candidate.canonicalWorktreePath as string,
        branchName: candidate.branchName as string,
        deletedAt: candidate.deletedAt as number,
        generationCutoffAt: candidate.generationCutoffAt as number,
        ...(origin ? { origin } : {}),
        affectedSessions,
        ...(candidate.truncated === true ? { truncated: true } : {}),
    };
}

function parseGenerationClaim(value: unknown): GenerationClaim | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Record<string, unknown>;
    if (!isSafeText(candidate.claimId, MAX_ID_LENGTH)
        || !isSafeText(candidate.createdAfterRetirementId, MAX_ID_LENGTH)
        || !Number.isSafeInteger(candidate.createdAtMs)
        || (candidate.state !== 'pending' && candidate.state !== 'promoted')) {
        return null;
    }
    const key = candidate.worktreeKey as Record<string, unknown>;
    if (!key || typeof key !== 'object'
        || !isSafeText(key.repositoryKey, MAX_PATH_LENGTH)
        || !isSafeText(key.canonicalWorktreePath, MAX_PATH_LENGTH)) {
        return null;
    }
    if (candidate.state === 'pending'
        && !isSafeText(candidate.pendingId, MAX_ID_LENGTH)) {
        return null;
    }
    if (candidate.state === 'promoted'
        && (!isSafeText(candidate.provider, MAX_ID_LENGTH)
            || !isSafeText(candidate.sessionId, MAX_ID_LENGTH))) {
        return null;
    }
    return {
        claimId: candidate.claimId as string,
        worktreeKey: Object.freeze({
            repositoryKey: key.repositoryKey as string,
            canonicalWorktreePath: key.canonicalWorktreePath as string,
        }),
        createdAfterRetirementId: candidate.createdAfterRetirementId as string,
        createdAtMs: candidate.createdAtMs as number,
        state: candidate.state,
            ...(candidate.state === 'pending'
            ? {
                pendingId: candidate.pendingId as string,
                ...(isSafeText(candidate.creatingProvider, MAX_ID_LENGTH)
                    ? { creatingProvider: candidate.creatingProvider as string }
                    : {}),
                ...(isSafeText(candidate.launchMarkerPath, MAX_PATH_LENGTH)
                    ? { launchMarkerPath: candidate.launchMarkerPath as string }
                    : {}),
            }
            : {
                provider: candidate.provider as string,
                sessionId: candidate.sessionId as string,
            }),
    };
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
    try {
        const group: WorktreeGroup = {
            groupId: candidate.groupId as string,
            displayName: candidate.displayName as string,
            suggestedSlug: candidate.suggestedSlug as string,
            primaryMemberId: isSafeText(candidate.primaryMemberId, MAX_ID_LENGTH)
                ? candidate.primaryMemberId as string
                : null,
            members,
            createdAt: candidate.createdAt as number,
            // Legacy records predate the revision field: only a *missing*
            // field migrates to 1; a present-but-corrupt one must not
            // silently reset the monotonic counter (ABA protection for
            // preview tokens), so the record is dropped instead.
            revision: candidate.revision === undefined
                ? 1
                : parseRevision(candidate.revision),
        };
        assertGroupInvariants(group);
        return group;
    } catch {
        return null;
    }
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

function requireTimestamp(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new WorktreeGroupManifestError('invalid-record');
    }
    return value;
}

function cloneRetiredIdentity(record: RetiredWorktreeIdentity): RetiredWorktreeIdentity {
    return {
        ...record,
        ...(record.origin ? { origin: { ...record.origin } } : {}),
        affectedSessions: record.affectedSessions.map(entry => ({ ...entry })),
    };
}

function cloneGenerationClaim(claim: GenerationClaim): GenerationClaim {
    return {
        ...claim,
        worktreeKey: { ...claim.worktreeKey },
    };
}

function parseRevision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new WorktreeGroupManifestError('invalid-record');
    }
    return value;
}

function bumpRevision(group: WorktreeGroup): void {
    if (!Number.isSafeInteger(group.revision) || group.revision < 1
        || group.revision >= Number.MAX_SAFE_INTEGER) {
        // Refuse the mutation rather than writing an unsafe integer that a
        // later reload could no longer parse monotonically.
        throw new WorktreeGroupManifestError('invalid-record');
    }
    group.revision += 1;
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
