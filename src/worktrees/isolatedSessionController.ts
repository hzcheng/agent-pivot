'use strict';

import type * as vscode from 'vscode';
import type { AiSessionProviderId } from '../models';
import type { OpenWorkspace } from '../workspaces/types';
import { assignPathToWorkspaceWorktree } from '../workspaces/worktreeSessionAssignment';
import { GitWorktreeProvisioner } from './gitWorktreeProvisioner';
import {
    createWorktreeProvisioningPlan,
    WorktreeProvisioningPlanError,
} from './provisioningPlan';
import type { WorktreeProvisioningPlan } from './provisioningPlan';
import {
    WorktreeProvisioningController,
    WorktreeProvisioningOutcome,
} from './provisioningController';
import type { WorktreeProvisioningRecoveryOperation } from './provisioningController';
import type {
    ProvisioningWorktreeRow,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from './types';
import type { PersistedWorktreeProvisioningOperation } from './provisioningStore';

export type IsolatedSessionStartOutcome =
  | WorktreeProvisioningOutcome
  | { kind: 'cancelled'; operationId: string }
  | { kind: 'rejected'; operationId: string; errorCode: string };

interface RepositoryPick extends vscode.QuickPickItem {
    repository?: WorktreeRepositorySnapshot;
}

interface IsolatedSessionOperationContext {
    projectId: string;
    /**
     * Navigation identity captured when the operation started. Save
     * Workspace As can reuse a legacy projectId for a different workspace,
     * so the manifest write must match this identity strictly.
     */
    navigationIdentity?: string;
    /**
     * Group-creation membership (M2): this operation provisions one member
     * of an existing manifest group. Its row never surfaces in the
     * Unmanaged section — the group row renders the member state.
     */
    groupId?: string;
    memberId?: string;
    /** The confirmed primary choice: applies once this member is ready. */
    preferredPrimary?: boolean;
    repository: WorktreeRepositorySnapshot;
    taskName: string;
    providerId: AiSessionProviderId;
    profile?: SessionProfileDecision;
    setupCommand: string[];
}

type SessionProfileDecision =
    | { kind: 'base' }
    | { kind: 'profile'; name: string };

interface IsolatedSessionWorkspaceTarget {
    workspace: OpenWorkspace;
    sessions: {
        activeProvider: AiSessionProviderId;
        quickCreateProvider?: AiSessionProviderId;
        quickCreateProfile?: string;
    };
}

export interface IsolatedSessionControllerOptions {
    getWorkspaceTarget: (projectId: string) => IsolatedSessionWorkspaceTarget | null;
    getWorktreeSnapshot: () => WorktreeSnapshot | null;
    getActiveEditorPath: () => string | undefined;
    isProviderId: (value: string) => value is AiSessionProviderId;
    isWorkspaceTrusted: () => boolean;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick: (
        items: RepositoryPick[],
        options: vscode.QuickPickOptions
    ) => Thenable<RepositoryPick | undefined>;
    refreshWorktreeSnapshot: () => Promise<void>;
    getSetupCommand?: () => readonly string[];
    getWorktreeDirectory?: () => string;
    publishRows: (revision: number, rows: readonly ProvisioningWorktreeRow[]) => void;
    runSetup?: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean,
        command: readonly string[]
    ) => Promise<void>;
    recoveredOperations?: readonly PersistedWorktreeProvisioningOperation[];
    persistOperations?: (
        operations: readonly PersistedWorktreeProvisioningOperation[]
    ) => Promise<void>;
    onPersistenceError?: (error: unknown) => void;
    onSettled?: (outcome: WorktreeProvisioningOutcome) => void;
    /**
     * Awaited on the success path before the settlement publishes: records
     * the provisioned worktree in the authoritative group manifest.
     */
    recordProvisionedWorktree?: (info: {
        projectId: string;
        navigationIdentity?: string;
        groupId?: string;
        memberId?: string;
        preferredPrimary?: boolean;
        plan: WorktreeProvisioningPlan;
        worktreeKey: WorktreeKey;
    }) => Promise<void>;
    provisioner?: GitWorktreeProvisioner;
}

/** Coordinates the Host-owned "New Isolated Session" transaction. */
export class IsolatedSessionController {
    private readonly provisioner: GitWorktreeProvisioner;
    private readonly provisioning: WorktreeProvisioningController;
    private readonly preparing = new Set<string>();
    private readonly contextsByOperation = new Map<string, IsolatedSessionOperationContext>();
    /**
     * Dismissed intents whose physical worktree exists but whose setup
     * never ran. They restore no row; they only keep reconciliation from
     * seeding the half-initialized worktree as a ready group.
     */
    private readonly recoveryTombstones = new Map<string, PersistedWorktreeProvisioningOperation>();

    constructor(private readonly options: IsolatedSessionControllerOptions) {
        for (const record of options.recoveredOperations || []) {
            if (record.tombstone) {
                this.recoveryTombstones.set(record.operationId, record);
                continue;
            }
            const repository = options.getWorktreeSnapshot()?.repositories.find(candidate =>
                candidate.repositoryKey === record.plan.repositoryKey);
            this.contextsByOperation.set(record.operationId, {
                projectId: record.projectId,
                ...(record.workspaceNavigationIdentity
                    ? { navigationIdentity: record.workspaceNavigationIdentity }
                    : {}),
                ...(record.groupId && record.memberId
                    ? { groupId: record.groupId, memberId: record.memberId }
                    : {}),
                ...(record.preferredPrimary ? { preferredPrimary: true } : {}),
                repository,
                taskName: record.plan.taskName,
                providerId: record.providerId,
                ...(record.profile ? { profile: { ...record.profile } } : {}),
                setupCommand: record.setupCommand.slice(),
            });
        }
        this.provisioner = options.provisioner || new GitWorktreeProvisioner();
        this.provisioning = new WorktreeProvisioningController({
            createWorktree: (plan, isCancelled) =>
                this.provisioner.createWorktree(plan, isCancelled),
            validateWorktree: (plan, worktreeKey) =>
                this.provisioner.validateCreatedWorktree(plan, worktreeKey),
            runSetup: (plan, worktreeKey, isCancelled, operationId) => {
                if (!options.isWorkspaceTrusted()) {
                    throw provisioningError('workspace-untrusted');
                }
                const command = this.contextsByOperation.get(operationId)?.setupCommand || [];
                return options.runSetup
                    ? options.runSetup(plan, worktreeKey, isCancelled, command)
                    : Promise.resolve();
            },
            publish: (revision, rows) => {
                options.publishRows(revision, rows);
                void this.persistOperations().catch(error =>
                    this.options.onPersistenceError?.(error));
            },
            checkpoint: async () => {
                try {
                    await this.persistOperations();
                } catch (error) {
                    this.options.onPersistenceError?.(error);
                    throw provisioningError('recovery-persist-failed');
                }
            },
            onSettled: outcome => {
                return this.handleSettled(outcome);
            },
            finalizeSuccess: outcome => {
                const context = this.contextsByOperation.get(outcome.operationId);
                if (!context || !options.recordProvisionedWorktree) {
                    return Promise.resolve();
                }
                // Throws propagate: the operation becomes a retryable
                // partial instead of a false success.
                return options.recordProvisionedWorktree({
                    projectId: context.projectId,
                    ...(context.navigationIdentity
                        ? { navigationIdentity: context.navigationIdentity }
                        : {}),
                    ...(context.groupId && context.memberId
                        ? { groupId: context.groupId, memberId: context.memberId }
                        : {}),
                    ...(context.preferredPrimary ? { preferredPrimary: true } : {}),
                    plan: outcome.plan,
                    worktreeKey: outcome.worktreeKey,
                });
            },
        });
        this.provisioning.restore((options.recoveredOperations || [])
            .filter(record => !record.tombstone)
            .map(record => ({
            operationId: record.operationId,
            plan: record.plan,
            completedSteps: record.completedSteps,
            ...(record.worktreeKey ? { worktreeKey: record.worktreeKey } : {}),
            row: record.row,
        })));
    }

    private async handleSettled(outcome: WorktreeProvisioningOutcome): Promise<void> {
        const options = this.options;
        if (outcome.kind === 'succeeded') {
            this.contextsByOperation.delete(outcome.operationId);
            // The session is started separately from the row menu, so
            // provisioning finishes by making the new worktree visible.
            void options.refreshWorktreeSnapshot();
        } else if (outcome.kind === 'failed' && outcome.errorCode === 'cancelled') {
            this.contextsByOperation.delete(outcome.operationId);
        }
        options.onSettled?.(outcome);
    }

    async start(
        operationId: string,
        projectId: string,
        sourceWorktree?: WorktreeKey
    ): Promise<IsolatedSessionStartOutcome> {
        if (!isSafeOperationId(operationId) || this.preparing.has(operationId)
            || this.contextsByOperation.has(operationId)) {
            return { kind: 'rejected', operationId, errorCode: 'duplicate-operation' };
        }
        const target = this.options.getWorkspaceTarget(projectId);
        const snapshot = this.options.getWorktreeSnapshot();
        if (!this.options.isWorkspaceTrusted()) {
            return { kind: 'rejected', operationId, errorCode: 'workspace-untrusted' };
        }
        if (!target || !snapshot) {
            return { kind: 'rejected', operationId, errorCode: 'snapshot-unavailable' };
        }
        this.preparing.add(operationId);
        try {
            let baseRefOverride: string | undefined;
            let repository: WorktreeRepositorySnapshot | undefined;
            if (sourceWorktree) {
                const resolved = this.resolveSourceWorktree(
                    target.workspace, snapshot, sourceWorktree);
                if (!resolved) {
                    return { kind: 'rejected', operationId, errorCode: 'base-ref-unavailable' };
                }
                repository = resolved.repository;
                baseRefOverride = resolved.baseRef;
            } else {
                repository = await this.selectRepository(target.workspace, snapshot);
                if (!repository) {
                    return { kind: 'cancelled', operationId };
                }
            }
            const inputOptions: vscode.InputBoxOptions = {
                title: 'New Isolated Session',
                prompt: 'Task name (used for the session title, branch, and worktree folder)',
                placeHolder: 'Fix login race',
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? null : 'Enter a task name.',
            } as vscode.InputBoxOptions & { title: string };
            const taskName = await this.options.showInputBox(inputOptions);
            if (taskName === undefined) {
                return { kind: 'cancelled', operationId };
            }
            const plan = await this.createPlan(repository, taskName, undefined, baseRefOverride);
            const providerId = preferredProvider(target, this.options.isProviderId);
            const profile = preferredProfile(target, providerId);
            this.contextsByOperation.set(operationId, {
                projectId,
                navigationIdentity: target.workspace.navigationIdentity,
                repository,
                taskName: plan.taskName,
                providerId,
                ...(profile ? { profile: { ...profile } } : {}),
                setupCommand: (this.options.getSetupCommand?.() || []).slice(),
            });
            return await this.provisioning.start(operationId, plan);
        } catch (error) {
            const errorCode = error instanceof WorktreeProvisioningPlanError
                ? error.code
                : getErrorCode(error);
            return { kind: 'rejected', operationId, errorCode };
        } finally {
            this.preparing.delete(operationId);
            if (!this.provisioning.getRows().some(row => row.operationId === operationId)) {
                this.contextsByOperation.delete(operationId);
            }
        }
    }

    async retry(operationId: string, projectId?: string): Promise<WorktreeProvisioningOutcome> {
        const row = this.getRows().find(candidate => candidate.operationId === operationId);
        const context = this.contextsByOperation.get(operationId);
        if (!row || !context || (projectId && context.projectId !== projectId)) {
            return { kind: 'failed', operationId, errorCode: 'retry-unavailable' };
        }
        if (!this.options.isWorkspaceTrusted()) {
            return { kind: 'failed', operationId, errorCode: 'workspace-untrusted' };
        }
        const target = this.options.getWorkspaceTarget(context.projectId);
        if (!this.contextMatchesWorkspace(context, target)) {
            return { kind: 'failed', operationId, errorCode: 'workspace-unavailable' };
        }
        const snapshot = this.options.getWorktreeSnapshot();
        const rootIds = new Set(target?.workspace.roots.map(root => root.id) || []);
        const repository = snapshot?.repositories.find(candidate =>
            candidate.repositoryKey === row.repositoryKey
            && candidate.rootBindings.some(binding => rootIds.has(binding.workspaceRootId)));
        if (!target || !snapshot || !repository) {
            return { kind: 'failed', operationId, errorCode: 'workspace-unavailable' };
        }
        context.repository = repository;
        let replacementPlan: WorktreeProvisioningPlan | undefined;
        // Group member operations execute exactly the confirmed plan
        // (PRD §6.1/§8): a pre-create collision must surface as a failed
        // member, never as a silently re-suffixed branch or path.
        if (!row.completedSteps.includes('worktree') && !context.groupId) {
            try {
                replacementPlan = await this.createPlan(
                    repository, context.taskName, operationId);
            } catch (error) {
                return {
                    kind: 'failed', operationId,
                    errorCode: error instanceof WorktreeProvisioningPlanError
                        ? error.code : getErrorCode(error),
                };
            }
        }
        return await this.provisioning.retry(operationId, replacementPlan);
    }

    cancel(operationId: string, projectId?: string): boolean {
        const context = this.contextsByOperation.get(operationId);
        if (!context || (projectId && context.projectId !== projectId)
            || !this.contextMatchesWorkspace(
                context, this.options.getWorkspaceTarget(context.projectId))) {
            return false;
        }
        return this.provisioning.cancel(operationId);
    }

    dismiss(operationId: string, projectId?: string): boolean {
        const context = this.contextsByOperation.get(operationId);
        if (!context || (projectId && context.projectId !== projectId)
            || !this.contextMatchesWorkspace(
                context, this.options.getWorkspaceTarget(context.projectId))) {
            return false;
        }
        const recovery = this.provisioning.getRecoveryOperations()
            .find(operation => operation.operationId === operationId);
        if (!this.provisioning.discard(operationId)) {
            return false;
        }
        // Dismissing an intent whose worktree exists but whose setup never
        // ran must not let reconciliation re-seed the half-initialized
        // worktree as ready: keep a tombstone that blocks seeding without
        // ever restoring a row.
        if (recovery
            && recovery.completedSteps.includes('worktree')
            && !recovery.completedSteps.includes('setup')
            && context.setupCommand.length > 0) {
            const tombstone = this.buildRecoveryRecord(recovery, context);
            if (tombstone) {
                this.recoveryTombstones.set(operationId, {
                    ...tombstone,
                    tombstone: true,
                });
                // discard's publish already persisted without the tombstone.
                void this.persistOperations().catch(error =>
                    this.options.onPersistenceError?.(error));
            }
        }
        this.contextsByOperation.delete(operationId);
        return true;
    }

    /** Whether any live operation (row or context) exists for the id. */
    hasOperation(operationId: string): boolean {
        return this.contextsByOperation.has(operationId)
            || this.provisioning.getRows().some(row => row.operationId === operationId);
    }

    getRows(): ProvisioningWorktreeRow[] {
        return this.provisioning.getRows();
    }

    /**
     * Rows visible to one workspace bucket. Save Workspace As can reuse a
     * legacy projectId for different roots, so visibility follows the
     * navigation identity captured when the operation started — and records
     * predating identity binding fail closed rather than leaking into
     * whichever workspace happens to share their projectId.
     */
    getVisibleRows(navigationIdentity: string): ProvisioningWorktreeRow[] {
        return this.provisioning.getRows().filter(row => {
            const context = this.contextsByOperation.get(row.operationId);
            if (context?.groupId) {
                // Group member operations render inside their group row.
                return false;
            }
            return !!navigationIdentity && !!context?.navigationIdentity
                && context.navigationIdentity === navigationIdentity;
        });
    }

    /**
     * Member ids with a live (not settled-failed) group provisioning
     * operation. Reconciliation uses this to avoid downgrading members
     * whose provisioning is actively running (PRD §9 in-flight 对账).
     */
    getActiveGroupMemberIds(): string[] {
        const activeOperationIds = new Set(
            this.provisioning.getRows()
                .filter(row => row.stage !== 'failed')
                .map(row => row.operationId));
        const memberIds: string[] = [];
        for (const [operationId, context] of this.contextsByOperation) {
            if (context.groupId && context.memberId && activeOperationIds.has(operationId)) {
                memberIds.push(context.memberId);
            }
        }
        return memberIds;
    }

    /**
     * Starts one group member's physical provisioning (M2). No prompts: the
     * plan is exactly what the user confirmed in the creation preview.
     */
    async startGroupMember(input: {
        operationId: string;
        projectId: string;
        /**
         * The navigation identity the group confirm captured. Verified
         * strictly: a mid-flight Save Workspace As must never write the
         * manifest and the physical provisioning into different buckets.
         */
        navigationIdentity: string;
        plan: WorktreeProvisioningPlan;
        setupCommand: readonly string[];
        groupId: string;
        memberId: string;
        preferredPrimary?: boolean;
    }): Promise<WorktreeProvisioningOutcome> {
        const operationId = input.operationId;
        if (!isSafeOperationId(operationId) || this.preparing.has(operationId)
            || this.contextsByOperation.has(operationId)) {
            return { kind: 'failed', operationId, errorCode: 'duplicate-operation' };
        }
        if (!this.options.isWorkspaceTrusted()) {
            return { kind: 'failed', operationId, errorCode: 'workspace-untrusted' };
        }
        const target = this.options.getWorkspaceTarget(input.projectId);
        const repository = this.options.getWorktreeSnapshot()?.repositories.find(candidate =>
            candidate.repositoryKey === input.plan.repositoryKey);
        if (!target || !repository) {
            return { kind: 'failed', operationId, errorCode: 'workspace-unavailable' };
        }
        if (target.workspace.navigationIdentity !== input.navigationIdentity) {
            return { kind: 'failed', operationId, errorCode: 'workspace-unavailable' };
        }
        this.contextsByOperation.set(operationId, {
            projectId: input.projectId,
            navigationIdentity: input.navigationIdentity,
            groupId: input.groupId,
            memberId: input.memberId,
            ...(input.preferredPrimary ? { preferredPrimary: true } : {}),
            repository,
            taskName: input.plan.taskName,
            providerId: preferredProvider(target, this.options.isProviderId),
            setupCommand: input.setupCommand.slice(),
        });
        const outcome = await this.provisioning.start(operationId, input.plan);
        if (!this.provisioning.getRows().some(row => row.operationId === operationId)) {
            this.contextsByOperation.delete(operationId);
        }
        return outcome;
    }

    private contextMatchesWorkspace(
        context: IsolatedSessionOperationContext,
        target: IsolatedSessionWorkspaceTarget | null
    ): boolean {
        return !!target && !!context.navigationIdentity
            && target.workspace.navigationIdentity === context.navigationIdentity;
    }

    /** Publishes rows restored at construction once composition has settled. */
    publishRestoredRows(): void {
        if (this.provisioning.getRows().length) {
            this.provisioning.publishNow();
        }
    }

    getRevision(): number {
        return this.provisioning.getRevision();
    }

    private async selectRepository(
        workspace: OpenWorkspace,
        snapshot: WorktreeSnapshot
    ): Promise<WorktreeRepositorySnapshot | undefined> {
        const rootIds = new Set(workspace.roots.map(root => root.id));
        const repositories = snapshot.repositories.filter(repository =>
            repository.rootBindings.some(binding => rootIds.has(binding.workspaceRootId))
            && !!repository.baseRef
            && repository.worktrees.some(worktree => !worktree.isBare));
        const activeEditorPath = this.options.getActiveEditorPath();
        if (activeEditorPath) {
            const active = assignPathToWorkspaceWorktree(activeEditorPath, workspace, snapshot);
            const selected = active && repositories.find(repository =>
                repository.repositoryKey === active.repository.repositoryKey);
            if (selected) {
                return selected;
            }
        }
        if (repositories.length === 1) {
            return repositories[0];
        }
        if (!repositories.length) {
            throw provisioningError('repository-unavailable');
        }
        const quickPickOptions: vscode.QuickPickOptions = {
            title: 'New Isolated Session Repository',
            placeHolder: 'Select the repository for the new worktree',
            ignoreFocusOut: true,
        } as vscode.QuickPickOptions & { title: string };
        const selected = await this.options.showQuickPick(
            repositories.map(repository => ({
                label: repositoryLabel(repository),
                description: repositoryCommandCwd(repository),
                repository,
            })),
            quickPickOptions
        );
        return selected?.repository;
    }

    private resolveSourceWorktree(
        workspace: OpenWorkspace,
        snapshot: WorktreeSnapshot,
        sourceWorktree: WorktreeKey
    ): { repository: WorktreeRepositorySnapshot; baseRef: string } | null {
        const rootIds = new Set(workspace.roots.map(root => root.id));
        const repository = snapshot.repositories.find(candidate =>
            candidate.repositoryKey === sourceWorktree.repositoryKey
            && candidate.rootBindings.some(binding => rootIds.has(binding.workspaceRootId)));
        const worktree = repository?.worktrees.find(candidate =>
            candidate.key.canonicalWorktreePath === sourceWorktree.canonicalWorktreePath);
        if (!repository || !worktree || worktree.isBare || !worktree.branchRef) {
            return null;
        }
        return { repository, baseRef: worktree.branchRef };
    }

    private createPlan(
        repository: WorktreeRepositorySnapshot,
        taskName: string,
        ignoredOperationId?: string,
        baseRefOverride?: string
    ): Promise<WorktreeProvisioningPlan> {
        return createWorktreeProvisioningPlan({
            repository,
            taskName,
            baseRefOverride,
            worktreeDirectory: this.options.getWorktreeDirectory?.(),
            isBranchAvailable: branchName =>
                this.provisioner.isBranchAvailable(
                    repositoryCommandCwd(repository), branchName),
            isPathAvailable: worktreePath => this.provisioner.isPathAvailable(worktreePath),
            reservedPaths: new Set(this.getRows()
                .filter(row => row.operationId !== ignoredOperationId)
                .map(row => row.proposedPath)
                .filter((value): value is string => !!value)),
        });
    }

    private persistOperations(): Promise<void> {
        if (!this.options.persistOperations) {
            return Promise.resolve();
        }
        const records = this.provisioning.getRecoveryOperations()
            .map(operation => {
                const context = this.contextsByOperation.get(operation.operationId);
                if (!context) {
                    return null;
                }
                return this.buildRecoveryRecord(operation, context);
            })
            .filter((record): record is PersistedWorktreeProvisioningOperation => !!record);
        const liveOperationIds = new Set(records.map(record => record.operationId));
        const tombstones = Array.from(this.recoveryTombstones.values())
            .filter(record => !liveOperationIds.has(record.operationId));
        return this.options.persistOperations([...records, ...tombstones]);
    }

    private buildRecoveryRecord(
        operation: WorktreeProvisioningRecoveryOperation,
        context: IsolatedSessionOperationContext
    ): PersistedWorktreeProvisioningOperation {
        const record: PersistedWorktreeProvisioningOperation = {
            version: 1 as const,
            operationId: operation.operationId,
            projectId: context.projectId,
            providerId: context.providerId,
            ...(context.profile ? { profile: { ...context.profile } } : {}),
            setupCommand: context.setupCommand.slice(),
            plan: operation.plan,
            completedSteps: operation.completedSteps,
            ...(operation.worktreeKey ? { worktreeKey: operation.worktreeKey } : {}),
            row: operation.row,
        };
        if (context.navigationIdentity) {
            record.workspaceNavigationIdentity = context.navigationIdentity;
        }
        if (context.groupId && context.memberId) {
            record.groupId = context.groupId;
            record.memberId = context.memberId;
        }
        if (context.preferredPrimary) {
            record.preferredPrimary = true;
        }
        return record;
    }
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

function preferredProvider(
    target: IsolatedSessionWorkspaceTarget,
    isProviderId: (value: string) => value is AiSessionProviderId
): AiSessionProviderId {
    const preferred = target.sessions.quickCreateProvider || target.sessions.activeProvider;
    return isProviderId(preferred) ? preferred : 'codex';
}

function preferredProfile(
    target: IsolatedSessionWorkspaceTarget,
    providerId: AiSessionProviderId
): SessionProfileDecision | undefined {
    return providerId === 'codex' && target.sessions.quickCreateProfile
        ? { kind: 'profile', name: target.sessions.quickCreateProfile }
        : undefined;
}

function provisioningError(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

function getErrorCode(error: unknown): string {
    const code = error && typeof error === 'object'
        ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[a-z0-9-]{1,64}$/u.test(code)
        ? code : 'unexpected-error';
}

function isSafeOperationId(value: string): boolean {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}
