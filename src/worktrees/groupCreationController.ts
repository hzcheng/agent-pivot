'use strict';

import type { OpenWorkspace } from '../workspaces/types';
import { isWorkspaceHostPathContained } from '../workspaces/sessionAssignment';
import {
    createWorktreeProvisioningPlan,
    slugifyTaskName,
    WorktreeProvisioningPlanError,
} from './provisioningPlan';
import type { WorktreeProvisioningPlan } from './provisioningPlan';
import { isManagedWorktreePath } from './provisioningPlan';
import type {
    WorktreeGroup,
    WorktreeGroupManifestStore,
} from './groupManifestStore';
import type { WorktreeProvisioningOutcome } from './provisioningController';
import type {
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from './types';

const MAX_GROUP_MEMBERS = 16;
const MAX_PREVIEW_MEMO_ENTRIES = 200;

export interface GroupCreationRepositoryOption {
    repositoryKey: string;
    label: string;
    /** The base ref the form preselects (full ref, remembered preference). */
    defaultBaseRef: string;
    /** Local branch short names; the remembered base is not repeated here. */
    localBranches: string[];
    defaultChecked: boolean;
    setupCommand: string[];
}

export interface GroupCreationPreviewSelection {
    repositoryKey: string;
    /** Full ref override chosen in the base dropdown. */
    baseRef?: string;
}

export interface GroupCreationPreviewMember {
    repositoryKey: string;
    label: string;
    baseRef: string;
    branchName: string;
    worktreePath: string;
    setupCommand: string[];
    preflight: 'ok' | { code: string };
}

export interface GroupCreationPreview {
    displayName: string;
    slug: string;
    /**
     * Host-issued nonce identifying this preview snapshot. Confirm must
     * reference it: if the setup configuration changed since, the host
     * rejects the confirm as preview-stale instead of silently executing
     * a command the user never saw (PRD §6.1 预览值与执行值逐项一致).
     */
    previewId: string;
    formError?: 'invalid-task';
    members: GroupCreationPreviewMember[];
}

export interface GroupCreationConfirmedMember {
    repositoryKey: string;
    baseRef: string;
    branchName: string;
    worktreePath: string;
    /**
     * Whether setup runs for this member. The host resolves the command
     * from the repository's resource-scoped configuration at execution
     * time; the webview never supplies argv.
     */
    setupEnabled: boolean;
}

export type GroupCreationConfirmResult =
  | { kind: 'created'; groupId: string }
  | { kind: 'failed'; errorCode: string };

export interface WorktreeGroupCreationControllerOptions {
    getWorkspaceTarget: (
        projectId: string
    ) => { workspace: OpenWorkspace } | null;
    getWorktreeSnapshot: () => WorktreeSnapshot | null;
    listLocalBranches: (commandCwd: string) => Promise<string[]>;
    isBranchAvailable: (commandCwd: string, branchName: string) => Promise<boolean>;
    isPathAvailable: (worktreePath: string) => Promise<boolean>;
    preflightPlan: (
        plan: WorktreeProvisioningPlan
    ) => Promise<'ok' | string>;
    /** Resource-scoped setup resolution (PRD §6.1). */
    getSetupCommand: (repositoryKey: string) => readonly string[];
    getWorktreeDirectory: () => string;
    getActiveEditorPath: () => string | undefined;
    manifestStore: WorktreeGroupManifestStore;
    startMemberOperation: (input: {
        operationId: string;
        projectId: string;
        /** The identity confirm captured; startGroupMember must verify it. */
        navigationIdentity: string;
        plan: WorktreeProvisioningPlan;
        setupCommand: readonly string[];
        groupId: string;
        memberId: string;
        preferredPrimary?: boolean;
    }) => Promise<WorktreeProvisioningOutcome>;
    retryMemberOperation: (
        operationId: string,
        projectId?: string
    ) => Promise<WorktreeProvisioningOutcome>;
    dismissMemberOperation: (
        operationId: string,
        projectId?: string
    ) => Promise<boolean>;
    hasMemberOperation: (operationId: string) => boolean;
    memberDismissNeedsTombstone?: (operationId: string) => boolean;
    isTombstoneStoreFull?: () => boolean;
    /**
     * Conservatively tombstones a failed member whose recovery record is
     * missing, before its manifest record goes away.
     */
    writeSyntheticTombstone?: (input: {
        repositoryKey: string;
        worktreePath: string;
        branchName: string;
        taskName: string;
        projectId: string;
        navigationIdentity: string;
    }) => Promise<boolean>;
    onDidChange?: () => void;
}

/**
 * Drives the M2 inline group creation form: bootstrap options, real-time
 * preview computation, and the confirmed parallel provisioning. The host
 * executes exactly the confirmed member set — nothing is re-derived at
 * execution time (PRD §6.1 行为 5).
 */
export class WorktreeGroupCreationController {
    /**
     * Per-member preview memo (PRD §6.1 增量重算): a base-ref or checkbox
     * change recomputes only the affected repository; typing changes the
     * slug and therefore every row. Availability staleness fails closed at
     * execution time.
     */
    private readonly previewMemo = new Map<string, Promise<GroupCreationPreviewMember>>();

    private previewCounter = 0;
    /** Latest authoritative preview snapshot per project (nonce → setups). */
    private readonly previewSnapshots = new Map<string, {
        previewId: string;
        /** Normalized display name and derived slug this preview computed. */
        displayName: string;
        slug: string;
        /**
         * Derive binding (PRD §6.2): the source group and the revision the
         * bases were taken from. A source that drifted since rejects the
         * confirm with group-changed.
         */
        derive?: { sourceGroupId: string; sourceRevision: number };
        /**
         * Add-repo binding (PRD §6.3): the target group, its revision, and
         * its locked slug at preview time. Drift fails the confirm closed.
         */
        addRepo?: { targetGroupId: string; targetRevision: number; slug: string };
        /** repositoryKey → the exact previewed plan and setup argv. */
        members: Map<string, {
            baseRef: string;
            branchName: string;
            worktreePath: string;
            setupCommand: string[];
        }>;
    }>();

    constructor(
        private readonly options: WorktreeGroupCreationControllerOptions
    ) {
    }

    async listRepositoryOptions(
        projectId: string
    ): Promise<GroupCreationRepositoryOption[]> {
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!target || !snapshot) {
            return [];
        }
        const repositories = visibleRepositories(target.workspace, snapshot);
        const activeEditorPath = this.options.getActiveEditorPath();
        const activeRepositoryKey = activeEditorPath
            ? repositories.find(repository => {
                return repository.worktrees
                    .filter(worktree => !worktree.isBare)
                    .some(worktree =>
                        isWorkspaceHostPathContained(
                            worktree.key.canonicalWorktreePath, activeEditorPath));
            })?.repositoryKey
            : undefined;
        return Promise.all(repositories.map(async (repository, index) => {
            const commandCwd = repositoryCommandCwd(repository);
            let localBranches: string[] = [];
            try {
                localBranches = await this.options.listLocalBranches(commandCwd);
            } catch (_error) {
                // A repository that cannot list branches still appears; its
                // preflight reports the concrete blocker.
            }
            return {
                repositoryKey: repository.repositoryKey,
                label: repositoryLabel(repository),
                defaultBaseRef: repository.baseRef || '',
                localBranches,
                defaultChecked: activeRepositoryKey
                    ? repository.repositoryKey === activeRepositoryKey
                    : index === 0,
                setupCommand: this.options
                    .getSetupCommand(repository.repositoryKey).slice(),
            };
        }));
    }

    /**
     * Derive form context (PRD §6.2): prefill the creation form from a
     * source group — name `源名-2`, the source member repositories
     * prechecked, and each base ref overridden to the source member's
     * branch. Candidate eligibility (decision F): the manifest branchName
     * is never trusted without a refs check — ready members verify their
     * branch, failed/planned/provisioning members re-verify from refs, and
     * detached members (repository outside the workspace) are skipped with
     * a note. The source group itself is never modified.
     */
    async deriveFormContext(
        projectId: string,
        sourceGroupId: string
    ): Promise<{
        sourceGroupId: string;
        sourceName: string;
        suggestedName: string;
        checkedRepositories: string[];
        baseOverrides: Record<string, string>;
        skipped: { repositoryLabel: string; reason: string }[];
    } | null> {
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!target || !snapshot) {
            return null;
        }
        const groups = this.options.manifestStore
            .listGroups(target.workspace.navigationIdentity);
        const source = groups.find(candidate => candidate.groupId === sourceGroupId);
        if (!source) {
            return null;
        }
        const repositories = visibleRepositories(target.workspace, snapshot);
        const checkedRepositories: string[] = [];
        const baseOverrides: Record<string, string> = {};
        const skipped: { repositoryLabel: string; reason: string }[] = [];
        for (const member of source.members) {
            const repository = repositories.find(candidate =>
                candidate.repositoryKey === member.repositoryKey);
            const label = repository
                ? repositoryLabel(repository)
                : fallbackLabel(member.repositoryKey);
            if (member.detached || !repository) {
                skipped.push({
                    repositoryLabel: label,
                    reason: 'repository not in workspace',
                });
                continue;
            }
            // Re-verify the source branch from refs (decision F): manifest
            // state — including failed/planned/provisioning/missing — is
            // never proof the branch still exists.
            const shortBranch = member.branchName;
            const fullRef = `refs/heads/${shortBranch}`;
            let localBranches: string[] = [];
            const commandCwd = repositoryCommandCwd(repository);
            try {
                localBranches = commandCwd
                    ? await this.options.listLocalBranches(commandCwd)
                    : [];
            } catch (_error) {
                localBranches = [];
            }
            const branchExists = localBranches.includes(shortBranch)
                || repository.worktrees.some(worktree => worktree.branchRef === fullRef);
            if (!branchExists) {
                skipped.push({
                    repositoryLabel: label,
                    reason: 'source branch no longer exists',
                });
                continue;
            }
            checkedRepositories.push(repository.repositoryKey);
            baseOverrides[repository.repositoryKey] = fullRef;
        }
        // Default name `源名-2`, disambiguated against existing groups.
        const takenNames = new Set(groups.map(group => group.displayName));
        let suggestedName = `${source.displayName}-2`;
        for (let suffix = 3; takenNames.has(suggestedName); suffix += 1) {
            suggestedName = `${source.displayName}-${suffix}`;
        }
        return {
            sourceGroupId: source.groupId,
            sourceName: source.displayName,
            suggestedName,
            checkedRepositories,
            baseOverrides,
            skipped,
        };
    }

    /**
     * Add-repo form options (PRD §6.3): only repositories not already in
     * the group are listed; the default check marks the active editor's
     * repository when it is eligible, and nothing otherwise — never the
     * first repository, so a quick Enter never silently adds a repo the
     * user did not look at.
     */
    async listAddRepoOptions(
        projectId: string,
        targetGroupId: string
    ): Promise<{
        group: { groupId: string; displayName: string; revision: number };
        options: GroupCreationRepositoryOption[];
    } | null> {
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!target || !snapshot) {
            return null;
        }
        const group = this.options.manifestStore
            .listGroups(target.workspace.navigationIdentity)
            .find(candidate => candidate.groupId === targetGroupId);
        if (!group) {
            return null;
        }
        const memberRepositories = new Set(group.members.map(member => member.repositoryKey));
        const all = await this.listRepositoryOptions(projectId);
        const eligible = all.filter(option => !memberRepositories.has(option.repositoryKey));
        const activeEditorPath = this.options.getActiveEditorPath();
        const activeRepositoryKey = activeEditorPath
            ? visibleRepositories(target.workspace, snapshot).find(repository =>
                repository.worktrees
                    .filter(worktree => !worktree.isBare)
                    .some(worktree =>
                        isWorkspaceHostPathContained(
                            worktree.key.canonicalWorktreePath, activeEditorPath)))
                ?.repositoryKey
            : undefined;
        const activeEligible = activeRepositoryKey
            && !memberRepositories.has(activeRepositoryKey)
            ? activeRepositoryKey
            : undefined;
        return {
            group: {
                groupId: group.groupId,
                displayName: group.displayName,
                revision: group.revision,
            },
            options: eligible.map(option => ({
                ...option,
                defaultChecked: option.repositoryKey === activeEligible,
            })),
        };
    }

    async preview(
        projectId: string,
        displayName: string,
        selections: readonly GroupCreationPreviewSelection[],
        sourceGroupId?: string,
        targetGroupId?: string
    ): Promise<GroupCreationPreview> {
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        let slug = slugifyTaskName(displayName);
        this.previewCounter += 1;
        const previewId = `preview-${this.previewCounter.toString(36)}`;
        const previewSerial = this.previewCounter;
        const preview: GroupCreationPreview = {
            displayName: displayName.trim(),
            slug,
            previewId,
            members: [],
        };
        if (!target || !snapshot) {
            return preview;
        }
        const addRepoTargetEarly = targetGroupId
            ? this.options.manifestStore
                .listGroups(target.workspace.navigationIdentity)
                .find(candidate => candidate.groupId === targetGroupId)
            : undefined;
        if (addRepoTargetEarly) {
            // Add repo (PRD §6.3): the group's identity is authoritative —
            // the slug stays locked to the group's suggestedSlug and member
            // branches derive from it, never from a forged form name.
            preview.displayName = addRepoTargetEarly.displayName;
            preview.slug = addRepoTargetEarly.suggestedSlug;
            slug = addRepoTargetEarly.suggestedSlug;
        }
        if (!slug) {
            return { ...preview, formError: 'invalid-task' };
        }
        const repositories = visibleRepositories(target.workspace, snapshot);
        preview.members = await Promise.all(selections.map(async selection => {
            const repository = repositories.find(candidate =>
                candidate.repositoryKey === selection.repositoryKey);
            const label = repository ? repositoryLabel(repository) : selection.repositoryKey;
            if (!repository) {
                return {
                    repositoryKey: selection.repositoryKey,
                    label,
                    baseRef: selection.baseRef || '',
                    branchName: '',
                    worktreePath: '',
                    setupCommand: [],
                    preflight: { code: 'repository-unavailable' },
                };
            }
            const member = await this.previewMember(
                repository, selection, preview.displayName, preview.slug, label,
                snapshot.revision ?? 0);
            // Setup resolution is a cheap config read and stays fresh; only
            // the git-backed plan/preflight work is memoized.
            member.setupCommand = this.options
                .getSetupCommand(repository.repositoryKey).slice();
            return member;
        }));
        // Compare-and-set by serial: a slow preview must never overwrite a
        // newer snapshot the webview is already displaying.
        if (previewSerial !== this.previewCounter) {
            return preview;
        }
        // The authoritative snapshot a confirm must reference: the full
        // previewed identity, plan, and setup argv (PRD §6.1: Host 仅执行
        // 最终预览集合，逐项一致).
        const deriveSource = sourceGroupId && target
            ? this.options.manifestStore
                .listGroups(target.workspace.navigationIdentity)
                .find(candidate => candidate.groupId === sourceGroupId)
            : undefined;
        const addRepoTarget = targetGroupId && target
            ? this.options.manifestStore
                .listGroups(target.workspace.navigationIdentity)
                .find(candidate => candidate.groupId === targetGroupId)
            : undefined;
        this.previewSnapshots.set(projectId, {
            previewId,
            displayName: preview.displayName,
            slug: preview.slug,
            ...(targetGroupId
                ? {
                    addRepo: {
                        targetGroupId,
                        targetRevision: addRepoTarget ? addRepoTarget.revision : -1,
                        slug: addRepoTarget ? addRepoTarget.suggestedSlug : '',
                    },
                }
                : {}),
            ...(sourceGroupId
                ? {
                    derive: {
                        sourceGroupId,
                        // A vanished source can never match: the confirm
                        // fails closed with group-changed.
                        sourceRevision: deriveSource ? deriveSource.revision : -1,
                    },
                }
                : {}),
            members: new Map(preview.members.map(member => [
                member.repositoryKey,
                {
                    baseRef: member.baseRef,
                    branchName: member.branchName,
                    worktreePath: member.worktreePath,
                    setupCommand: member.setupCommand.slice(),
                },
            ])),
        });
        return preview;
    }

    private previewMember(
        repository: WorktreeRepositorySnapshot,
        selection: GroupCreationPreviewSelection,
        displayName: string,
        slug: string,
        label: string,
        snapshotRevision: number | string
    ): Promise<GroupCreationPreviewMember> {
        // Unambiguous serialization (plain concatenation collides), and the
        // entry expires with the snapshot revision or a directory change.
        const memoKey = JSON.stringify([
            repository.repositoryKey,
            selection.baseRef || '',
            slug,
            snapshotRevision,
            this.options.getWorktreeDirectory(),
        ]);
        const cached = this.previewMemo.get(memoKey);
        if (cached) {
            return cached.then(member => ({ ...member, label }));
        }
        const computed = this.computePreviewMember(
            repository, selection, displayName, label);
        if (this.previewMemo.size >= MAX_PREVIEW_MEMO_ENTRIES) {
            // Insertion-ordered eviction: the oldest slug's rows go first.
            const oldest = this.previewMemo.keys().next();
            if (!oldest.done) {
                this.previewMemo.delete(oldest.value);
            }
        }
        this.previewMemo.set(memoKey, computed);
        // Callers attach per-preview fields (setup); never share the object.
        return computed.then(member => ({ ...member }));
    }

    private async computePreviewMember(
        repository: WorktreeRepositorySnapshot,
        selection: GroupCreationPreviewSelection,
        displayName: string,
        label: string
    ): Promise<GroupCreationPreviewMember> {
        try {
            const plan = await createWorktreeProvisioningPlan({
                repository,
                taskName: displayName,
                baseRefOverride: selection.baseRef,
                worktreeDirectory: this.options.getWorktreeDirectory(),
                // Real probes: branch/path collisions surface as visible
                // auto-suffixes in the preview (PRD §5.2), and the
                // confirmed values are later executed verbatim.
                isBranchAvailable: branch =>
                    this.options.isBranchAvailable(
                        repositoryCommandCwd(repository), branch),
                isPathAvailable: candidatePath =>
                    this.options.isPathAvailable(candidatePath),
            });
            const preflight = await this.options.preflightPlan(plan);
            return {
                repositoryKey: repository.repositoryKey,
                label,
                baseRef: plan.baseRef,
                branchName: plan.branchName,
                worktreePath: plan.worktreePath,
                setupCommand: [],
                preflight: preflight === 'ok' ? 'ok' as const : { code: preflight },
            };
        } catch (error) {
            const code = error instanceof WorktreeProvisioningPlanError
                ? error.code : 'unexpected-error';
            return {
                repositoryKey: repository.repositoryKey,
                label,
                baseRef: selection.baseRef || repository.baseRef || '',
                branchName: '',
                worktreePath: '',
                setupCommand: [],
                preflight: { code },
            };
        }
    }

    /**
     * Writes the confirmed group (members planned) and provisions every
     * member in parallel with exactly the confirmed plan values.
     */
    async confirm(request: {
        projectId: string;
        previewId: string;
        displayName: string;
        members: readonly GroupCreationConfirmedMember[];
        primaryRepositoryKey?: string;
        targetGroupId?: string;
    }): Promise<GroupCreationConfirmResult> {
        const target = this.options.getWorkspaceTarget(request.projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!target || !snapshot) {
            return { kind: 'failed', errorCode: 'workspace-unavailable' };
        }
        // The confirmed setup toggle may only execute the command the
        // preview displayed: any configuration change since the referenced
        // preview snapshot rejects the confirm (PRD §6.1 一致性承诺).
        const previewSnapshot = this.previewSnapshots.get(request.projectId);
        if (!previewSnapshot || previewSnapshot.previewId !== request.previewId) {
            return { kind: 'failed', errorCode: 'preview-stale' };
        }
        // The confirmed target must be the group the preview bound: a
        // forged or dropped targetGroupId under a valid previewId is stale.
        if ((request.targetGroupId ?? null)
            !== (previewSnapshot.addRepo?.targetGroupId ?? null)) {
            return { kind: 'failed', errorCode: 'preview-stale' };
        }
        if (previewSnapshot.derive && target) {
            // Derive binding (decision G): the source group must be exactly
            // the revision the bases were previewed from — a rename, member
            // change, or merge meanwhile makes this confirm group-changed.
            const source = this.options.manifestStore
                .listGroups(target.workspace.navigationIdentity)
                .find(candidate =>
                    candidate.groupId === previewSnapshot.derive!.sourceGroupId);
            if (!source || source.revision !== previewSnapshot.derive.sourceRevision) {
                return { kind: 'failed', errorCode: 'group-changed' };
            }
        }
        if (previewSnapshot.addRepo && target) {
            // Add-repo binding (PRD §6.3): the target group must be exactly
            // the previewed revision with the locked slug.
            const targetGroup = this.options.manifestStore
                .listGroups(target.workspace.navigationIdentity)
                .find(candidate =>
                    candidate.groupId === previewSnapshot.addRepo!.targetGroupId);
            if (!targetGroup
                || targetGroup.revision !== previewSnapshot.addRepo.targetRevision
                || targetGroup.suggestedSlug !== previewSnapshot.addRepo.slug) {
                return { kind: 'failed', errorCode: 'group-changed' };
            }
        }
        const displayName = request.displayName.trim();
        const slug = slugifyTaskName(displayName);
        if (!displayName || !slug) {
            return { kind: 'failed', errorCode: 'invalid-task' };
        }
        // The group identity is part of the bound preview: a forged label
        // would desync the manifest name and merge hints from the branches.
        if (previewSnapshot.displayName !== displayName
            || previewSnapshot.slug !== slug) {
            return { kind: 'failed', errorCode: 'preview-stale' };
        }
        const members = request.members.slice(0, MAX_GROUP_MEMBERS);
        if (members.length === 0 || members.length !== request.members.length) {
            return { kind: 'failed', errorCode: 'invalid-members' };
        }
        const repositories = visibleRepositories(target.workspace, snapshot);
        const seenRepositories = new Set<string>();
        for (const member of members) {
            const repository = repositories.find(candidate =>
                candidate.repositoryKey === member.repositoryKey);
            if (!repository || seenRepositories.has(member.repositoryKey)) {
                return { kind: 'failed', errorCode: 'invalid-members' };
            }
            seenRepositories.add(member.repositoryKey);
            const previewed = previewSnapshot.members.get(member.repositoryKey);
            if (!previewed) {
                return { kind: 'failed', errorCode: 'preview-stale' };
            }
            // Every confirmed field must equal the previewed value exactly:
            // a forged branch or path under a valid previewId is stale, not
            // executable.
            if (previewed.baseRef !== member.baseRef
                || previewed.branchName !== member.branchName
                || previewed.worktreePath !== member.worktreePath) {
                return { kind: 'failed', errorCode: 'preview-stale' };
            }
            const currentSetup = JSON.stringify(
                this.options.getSetupCommand(member.repositoryKey).slice());
            if (JSON.stringify(previewed.setupCommand) !== currentSetup) {
                return { kind: 'failed', errorCode: 'preview-stale' };
            }
            const commandCwd = repositoryCommandCwd(repository);
            if (!commandCwd || !member.branchName || member.branchName.startsWith('-')
                || /[\0\r\n]/u.test(member.branchName)
                || !member.baseRef || member.baseRef.startsWith('-')
                || /[\0\r\n]/u.test(member.baseRef)
                || !isManagedWorktreePath(
                    member.repositoryKey, member.worktreePath,
                    this.options.getWorktreeDirectory())) {
                return { kind: 'failed', errorCode: 'invalid-members' };
            }
        }
        const navigationIdentity = target.workspace.navigationIdentity;
        // Preview tokens are single-use: consume atomically (synchronously,
        // before the first manifest await) so a replayed or concurrent
        // confirm can never provision the same plan twice.
        this.previewSnapshots.delete(request.projectId);
        let group: WorktreeGroup;
        let newMembers: WorktreeGroup['members'];
        try {
            if (previewSnapshot.addRepo) {
                // Add repo (PRD §6.3): members join the existing group in
                // one aggregate write (decision F: validate-all-then-write).
                group = await this.options.manifestStore.addPlannedMembers(
                    navigationIdentity,
                    previewSnapshot.addRepo.targetGroupId,
                    members.map(member => ({
                        repositoryKey: member.repositoryKey,
                        branchName: member.branchName,
                        path: member.worktreePath,
                        state: 'provisioning' as const,
                    })));
                newMembers = group.members.slice(-members.length);
            } else {
                group = await this.options.manifestStore.createGroup(navigationIdentity, {
                    displayName,
                    suggestedSlug: slug,
                    // Members start in provisioning (not planned): any member
                    // reconciliation sees as provisioning without a live
                    // operation crashed mid-creation and self-heals to
                    // failed/interrupted (PRD §9 in-flight 对账).
                    members: members.map(member => ({
                        repositoryKey: member.repositoryKey,
                        branchName: member.branchName,
                        path: member.worktreePath,
                        state: 'provisioning' as const,
                    })),
                });
                newMembers = group.members;
            }
        } catch (error) {
            return {
                kind: 'failed',
                errorCode: (error as { code?: string })?.code || 'manifest-unavailable',
            };
        }
        this.options.onDidChange?.();
        const confirmedPrimary = members.find(member =>
            member.repositoryKey === request.primaryRepositoryKey);
        // Add repo never switches the primary — unless the group has no
        // primary at all, in which case the first new member takes it once
        // it becomes ready (PRD §6.3).
        const addRepoNeedsPrimary = !!previewSnapshot.addRepo && !group.primaryMemberId;
        await Promise.all(newMembers.map(async (member, index) => {
            const confirmed = members.find(candidate =>
                candidate.repositoryKey === member.repositoryKey)!;
            const previewed = previewSnapshot.members.get(confirmed.repositoryKey)!;
            await this.runMember(request.projectId, navigationIdentity, group.groupId, {
                memberId: member.memberId,
                plan: {
                    repositoryKey: confirmed.repositoryKey,
                    commandCwd: repositoryCommandCwd(repositories.find(candidate =>
                        candidate.repositoryKey === confirmed.repositoryKey)!),
                    baseRef: confirmed.baseRef,
                    taskName: displayName,
                    slug,
                    branchName: confirmed.branchName,
                    worktreePath: confirmed.worktreePath,
                },
                // Execute the frozen preview argv — exactly what the user
                // reviewed — never a config value re-read later.
                setupCommand: confirmed.setupEnabled
                    ? previewed.setupCommand.slice()
                    : [],
                preferredPrimary: previewSnapshot.addRepo
                    ? addRepoNeedsPrimary && index === 0
                    : confirmed === confirmedPrimary,
            });
        }));
        return { kind: 'created', groupId: group.groupId };
    }

    /** Retry a failed member with its confirmed plan — never re-suffixed. */
    async retryMember(
        projectId: string,
        groupId: string,
        memberId: string
    ): Promise<WorktreeProvisioningOutcome> {
        const target = this.options.getWorkspaceTarget(projectId);
        if (!target) {
            return { kind: 'failed', operationId: memberOperationId(memberId), errorCode: 'workspace-unavailable' };
        }
        const navigationIdentity = target.workspace.navigationIdentity;
        const group = this.options.manifestStore
            .listGroups(navigationIdentity)
            .find(candidate => candidate.groupId === groupId);
        const member = group?.members.find(candidate => candidate.memberId === memberId);
        if (!group || !member || member.state !== 'failed') {
            return { kind: 'failed', operationId: memberOperationId(memberId), errorCode: 'retry-unavailable' };
        }
        try {
            await this.options.manifestStore.updateMember(
                navigationIdentity, groupId, memberId, {
                    state: 'provisioning',
                    // The store treats undefined as "leave unchanged".
                    lastError: '',
                });
        } catch (_error) {
            return {
                kind: 'failed',
                operationId: memberOperationId(memberId),
                errorCode: 'manifest-unavailable',
            };
        }
        this.options.onDidChange?.();
        const outcome = await this.options.retryMemberOperation(
            memberOperationId(memberId), projectId);
        try {
            await this.settleMemberOutcome(navigationIdentity, groupId, memberId, outcome);
        } catch (_error) {
            // A manifest write that races a concurrent group mutation must
            // still produce a terminal settlement for the webview.
            return {
                kind: 'failed',
                operationId: memberOperationId(memberId),
                errorCode: 'manifest-unavailable',
            };
        }
        return outcome;
    }

    /** Dismiss a failed intent: drops the member record, never touches disk. */
    async dismissMember(
        projectId: string,
        groupId: string,
        memberId: string
    ): Promise<'dismissed' | 'unavailable' | 'store-full'> {
        const target = this.options.getWorkspaceTarget(projectId);
        if (!target) {
            return 'unavailable';
        }
        const navigationIdentity = target.workspace.navigationIdentity;
        const group = this.options.manifestStore
            .listGroups(navigationIdentity)
            .find(candidate => candidate.groupId === groupId);
        const member = group?.members.find(candidate => candidate.memberId === memberId);
        if (!group || !member || member.state !== 'failed') {
            return 'unavailable';
        }
        const operationId = memberOperationId(memberId);
        // A live operation that refuses discard (still running, or its
        // tombstone could not be persisted) blocks the dismiss.
        if (this.options.hasMemberOperation(operationId)) {
            // A full tombstone bucket refuses the dismiss instead of
            // silently evicting another worktree's protection record.
            if (this.options.memberDismissNeedsTombstone?.(operationId)
                && this.options.isTombstoneStoreFull?.()) {
                return 'store-full';
            }
            if (!(await this.options.dismissMemberOperation(operationId, projectId))) {
                return 'unavailable';
            }
        } else if (this.options.writeSyntheticTombstone) {
            // The recovery record is gone (evicted or corrupt): without a
            // tombstone, removing the manifest member would let
            // reconciliation seed the possibly half-initialized worktree
            // as ready.
            if (this.options.isTombstoneStoreFull?.()) {
                return 'store-full';
            }
            const tombstoned = await this.options.writeSyntheticTombstone({
                repositoryKey: member.repositoryKey,
                worktreePath: member.path,
                branchName: member.branchName,
                taskName: group.displayName,
                projectId,
                navigationIdentity,
            });
            if (!tombstoned) {
                return 'unavailable';
            }
        }
        try {
            await this.options.manifestStore.removeMember(
                navigationIdentity, groupId, memberId);
        } catch (_error) {
            return 'unavailable';
        }
        this.options.onDidChange?.();
        return 'dismissed';
    }

    private async runMember(
        projectId: string,
        navigationIdentity: string,
        groupId: string,
        input: {
            memberId: string;
            plan: WorktreeProvisioningPlan;
            setupCommand: readonly string[];
            preferredPrimary: boolean;
        }
    ): Promise<void> {
        let outcome: WorktreeProvisioningOutcome;
        try {
            outcome = await this.options.startMemberOperation({
                operationId: memberOperationId(input.memberId),
                projectId,
                navigationIdentity,
                plan: input.plan,
                setupCommand: input.setupCommand,
                groupId,
                memberId: input.memberId,
                preferredPrimary: input.preferredPrimary,
            });
        } catch (error) {
            // A throwing executor must not reject the confirm's Promise.all:
            // the member degrades to failed and the settlement still lands.
            outcome = {
                kind: 'failed',
                operationId: memberOperationId(input.memberId),
                errorCode: (error as { code?: string })?.code || 'unexpected-error',
            };
        }
        try {
            await this.settleMemberOutcome(
                navigationIdentity, groupId, input.memberId, outcome);
        } catch (_error) {
            // The member record may be gone (dismissed after a spurious
            // downgrade raced the operation); the physical worktree is
            // re-seeded by reconciliation and never lost.
        }
    }

    private async settleMemberOutcome(
        navigationIdentity: string,
        groupId: string,
        memberId: string,
        outcome: WorktreeProvisioningOutcome
    ): Promise<void> {
        // Success is recorded by the finalize hook before settlement
        // reaches us (PRD §9 新建即写入); only failures need a state write.
        if (outcome.kind === 'succeeded') {
            this.options.onDidChange?.();
            return;
        }
        await this.options.manifestStore.updateMember(
            navigationIdentity, groupId, memberId, {
                state: 'failed',
                lastError: outcome.errorCode,
            });
        this.options.onDidChange?.();
    }
}


export function memberOperationId(memberId: string): string {
    return `group-member-${memberId}`;
}

function visibleRepositories(
    workspace: OpenWorkspace,
    snapshot: WorktreeSnapshot
): WorktreeRepositorySnapshot[] {
    const rootIds = new Set(workspace.roots.map(root => root.id));
    return snapshot.repositories.filter(repository =>
        repository.rootBindings.some(binding => rootIds.has(binding.workspaceRootId)));
}

function repositoryCommandCwd(repository: WorktreeRepositorySnapshot): string {
    return repository.worktrees.find(worktree => worktree.isMain && !worktree.isBare)
        ?.key.canonicalWorktreePath
        || repository.worktrees.find(worktree => !worktree.isBare)?.key.canonicalWorktreePath
        || '';
}

function repositoryLabel(repository: WorktreeRepositorySnapshot): string {
    const cwd = repositoryCommandCwd(repository).replace(/[\\/]+$/u, '');
    return cwd.split(/[\\/]/u).pop() || repository.repositoryKey;
}

function fallbackLabel(repositoryKey: string): string {
    const segments = repositoryKey.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean);
    let name = segments[segments.length - 1] || 'repository';
    if (name === '.git' && segments.length > 1) {
        name = segments[segments.length - 2];
    } else if (name.endsWith('.git')) {
        name = name.slice(0, -'.git'.length);
    }
    return name || 'repository';
}
