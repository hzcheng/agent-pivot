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
import type {
    ProvisioningWorktreeRow,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from './types';

export type IsolatedSessionStartOutcome =
  | WorktreeProvisioningOutcome
  | { kind: 'cancelled'; operationId: string }
  | { kind: 'rejected'; operationId: string; errorCode: string };

interface RepositoryPick extends vscode.QuickPickItem {
    repository: WorktreeRepositorySnapshot;
}

interface IsolatedSessionOperationContext {
    projectId: string;
    repository: WorktreeRepositorySnapshot;
    taskName: string;
    providerId: AiSessionProviderId;
    profile?: SessionProfileDecision;
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
    createSessionInWorktree: (
        projectId: string,
        providerId: AiSessionProviderId,
        title: string,
        worktreeKey: WorktreeKey,
        profile?: SessionProfileDecision
    ) => Promise<boolean>;
    publishRows: (revision: number, rows: readonly ProvisioningWorktreeRow[]) => void;
    runSetup?: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean
    ) => Promise<void>;
    onSettled?: (outcome: WorktreeProvisioningOutcome) => void;
    provisioner?: GitWorktreeProvisioner;
}

/** Coordinates the Host-owned "New Isolated Session" transaction. */
export class IsolatedSessionController {
    private readonly provisioner: GitWorktreeProvisioner;
    private readonly provisioning: WorktreeProvisioningController;
    private readonly preparing = new Set<string>();
    private readonly contextsByOperation = new Map<string, IsolatedSessionOperationContext>();

    constructor(private readonly options: IsolatedSessionControllerOptions) {
        this.provisioner = options.provisioner || new GitWorktreeProvisioner();
        this.provisioning = new WorktreeProvisioningController({
            createWorktree: (plan, isCancelled) =>
                this.provisioner.createWorktree(plan, isCancelled),
            runSetup: options.runSetup || (async () => undefined),
            startAgent: async (plan, worktreeKey, isCancelled, operationId) => {
                if (isCancelled()) {
                    throw provisioningError('cancelled');
                }
                await options.refreshWorktreeSnapshot();
                if (isCancelled()) {
                    throw provisioningError('cancelled');
                }
                const context = this.contextsByOperation.get(operationId);
                if (!context) {
                    throw provisioningError('workspace-unavailable');
                }
                const started = await options.createSessionInWorktree(
                    context.projectId,
                    context.providerId,
                    plan.taskName,
                    worktreeKey,
                    context.profile
                );
                if (!started) {
                    throw provisioningError('agent-start-failed');
                }
            },
            publish: options.publishRows,
            onSettled: outcome => {
                if (outcome.kind === 'succeeded') {
                    this.contextsByOperation.delete(outcome.operationId);
                }
                options.onSettled?.(outcome);
            },
        });
    }

    async start(operationId: string, projectId: string): Promise<IsolatedSessionStartOutcome> {
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
            const repository = await this.selectRepository(target.workspace, snapshot);
            if (!repository) {
                return { kind: 'cancelled', operationId };
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
            const plan = await this.createPlan(repository, taskName);
            const providerId = preferredProvider(target, this.options.isProviderId);
            const profile = preferredProfile(target, providerId);
            this.contextsByOperation.set(operationId, {
                projectId,
                repository,
                taskName: plan.taskName,
                providerId,
                ...(profile ? { profile: { ...profile } } : {}),
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
        let replacementPlan: WorktreeProvisioningPlan | undefined;
        if (!row.completedSteps.includes('worktree')) {
            try {
                replacementPlan = await this.createPlan(
                    context.repository, context.taskName, operationId);
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
        if (!context || (projectId && context.projectId !== projectId)) {
            return false;
        }
        return this.provisioning.cancel(operationId);
    }

    getRows(): ProvisioningWorktreeRow[] {
        return this.provisioning.getRows();
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

    private createPlan(
        repository: WorktreeRepositorySnapshot,
        taskName: string,
        ignoredOperationId?: string
    ): Promise<WorktreeProvisioningPlan> {
        return createWorktreeProvisioningPlan({
            repository,
            taskName,
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
