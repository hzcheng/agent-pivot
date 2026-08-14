'use strict';

import type { OpenWorkspace } from '../workspaces/types';
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
const MAX_LOCAL_BRANCH_OPTIONS = 200;

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
    formError?: 'invalid-task';
    members: GroupCreationPreviewMember[];
}

export interface GroupCreationConfirmedMember {
    repositoryKey: string;
    baseRef: string;
    branchName: string;
    worktreePath: string;
    /** Empty array means "no setup for this member" (disabled or unset). */
    setupCommand: string[];
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
    dismissMemberOperation: (operationId: string, projectId?: string) => boolean;
    onDidChange?: () => void;
}

/**
 * Drives the M2 inline group creation form: bootstrap options, real-time
 * preview computation, and the confirmed parallel provisioning. The host
 * executes exactly the confirmed member set — nothing is re-derived at
 * execution time (PRD §6.1 行为 5).
 */
export class WorktreeGroupCreationController {
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
            ? repositories.find(repository =>
                activeEditorPath.startsWith(
                    repositoryCommandCwd(repository) + '/'
                ) || activeEditorPath === repositoryCommandCwd(repository))
                ?.repositoryKey
            : undefined;
        return Promise.all(repositories.map(async (repository, index) => {
            const commandCwd = repositoryCommandCwd(repository);
            let localBranches: string[] = [];
            try {
                localBranches = (await this.options.listLocalBranches(commandCwd))
                    .slice(0, MAX_LOCAL_BRANCH_OPTIONS);
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

    async preview(
        projectId: string,
        displayName: string,
        selections: readonly GroupCreationPreviewSelection[]
    ): Promise<GroupCreationPreview> {
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        const slug = slugifyTaskName(displayName);
        const preview: GroupCreationPreview = {
            displayName: displayName.trim(),
            slug,
            members: [],
        };
        if (!slug) {
            return { ...preview, formError: 'invalid-task' };
        }
        if (!target || !snapshot) {
            return preview;
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
                    setupCommand: this.options
                        .getSetupCommand(repository.repositoryKey).slice(),
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
        }));
        return preview;
    }

    /**
     * Writes the confirmed group (members planned) and provisions every
     * member in parallel with exactly the confirmed plan values.
     */
    async confirm(request: {
        projectId: string;
        displayName: string;
        members: readonly GroupCreationConfirmedMember[];
        primaryRepositoryKey?: string;
    }): Promise<GroupCreationConfirmResult> {
        const target = this.options.getWorkspaceTarget(request.projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!target || !snapshot) {
            return { kind: 'failed', errorCode: 'workspace-unavailable' };
        }
        const displayName = request.displayName.trim();
        const slug = slugifyTaskName(displayName);
        if (!displayName || !slug) {
            return { kind: 'failed', errorCode: 'invalid-task' };
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
        let group: WorktreeGroup;
        try {
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
        } catch (error) {
            return {
                kind: 'failed',
                errorCode: (error as { code?: string })?.code || 'manifest-unavailable',
            };
        }
        this.options.onDidChange?.();
        const confirmedPrimary = members.find(member =>
            member.repositoryKey === request.primaryRepositoryKey);
        await Promise.all(group.members.map(async member => {
            const confirmed = members.find(candidate =>
                candidate.repositoryKey === member.repositoryKey)!;
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
                setupCommand: confirmed.setupCommand,
                preferredPrimary: confirmed === confirmedPrimary,
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
        await this.options.manifestStore.updateMember(
            navigationIdentity, groupId, memberId, {
                state: 'provisioning',
                // The store treats undefined as "leave unchanged".
                lastError: '',
            });
        this.options.onDidChange?.();
        const outcome = await this.options.retryMemberOperation(
            memberOperationId(memberId), projectId);
        await this.settleMemberOutcome(navigationIdentity, groupId, memberId, outcome);
        return outcome;
    }

    /** Dismiss a failed intent: drops the member record, never touches disk. */
    async dismissMember(
        projectId: string,
        groupId: string,
        memberId: string
    ): Promise<boolean> {
        const target = this.options.getWorkspaceTarget(projectId);
        if (!target) {
            return false;
        }
        const navigationIdentity = target.workspace.navigationIdentity;
        const group = this.options.manifestStore
            .listGroups(navigationIdentity)
            .find(candidate => candidate.groupId === groupId);
        const member = group?.members.find(candidate => candidate.memberId === memberId);
        if (!group || !member || member.state !== 'failed') {
            return false;
        }
        this.options.dismissMemberOperation(memberOperationId(memberId), projectId);
        await this.options.manifestStore.removeMember(
            navigationIdentity, groupId, memberId);
        this.options.onDidChange?.();
        return true;
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
        const outcome = await this.options.startMemberOperation({
            operationId: memberOperationId(input.memberId),
            projectId,
            plan: input.plan,
            setupCommand: input.setupCommand,
            groupId,
            memberId: input.memberId,
            preferredPrimary: input.preferredPrimary,
        });
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
