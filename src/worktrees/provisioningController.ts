'use strict';

import type { ProvisioningWorktreeRow, WorktreeKey } from './types';
import type { WorktreeProvisioningPlan } from './provisioningPlan';

export type WorktreeProvisioningCompletedStep = 'worktree' | 'setup' | 'agent';

export type WorktreeProvisioningOutcome =
  | { kind: 'succeeded'; operationId: string; worktreeKey: WorktreeKey }
  | {
      kind: 'partial'; operationId: string; worktreeKey: WorktreeKey;
      errorCode: string; completedSteps: WorktreeProvisioningCompletedStep[];
  }
  | { kind: 'failed'; operationId: string; errorCode: string };

export interface WorktreeProvisioningControllerOptions {
    createWorktree: (
        plan: WorktreeProvisioningPlan,
        isCancelled: () => boolean,
        operationId: string
    ) => Promise<WorktreeKey>;
    runSetup: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean,
        operationId: string
    ) => Promise<void>;
    startAgent: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean,
        operationId: string
    ) => Promise<void>;
    validateWorktree?: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        operationId: string
    ) => Promise<void>;
    publish: (revision: number, rows: readonly ProvisioningWorktreeRow[]) => void;
    checkpoint?: () => Promise<void>;
    onSettled?: (outcome: WorktreeProvisioningOutcome) => void;
}

interface ProvisioningOperation {
    operationId: string;
    plan: WorktreeProvisioningPlan;
    completedSteps: WorktreeProvisioningCompletedStep[];
    worktreeKey?: WorktreeKey;
    row: ProvisioningWorktreeRow;
    cancelled: boolean;
    running: boolean;
    settledAttempt: number;
}

export interface WorktreeProvisioningRecoveryOperation {
    operationId: string;
    plan: WorktreeProvisioningPlan;
    completedSteps: WorktreeProvisioningCompletedStep[];
    worktreeKey?: WorktreeKey;
    row: ProvisioningWorktreeRow;
}

export class WorktreeProvisioningController {
    private readonly operations = new Map<string, ProvisioningOperation>();
    private revision = 0;

    constructor(private readonly options: WorktreeProvisioningControllerOptions) {
    }

    start(operationId: string, plan: WorktreeProvisioningPlan): Promise<WorktreeProvisioningOutcome> {
        if (!isSafeOperationId(operationId) || this.operations.has(operationId)) {
            return Promise.resolve({ kind: 'failed', operationId, errorCode: 'duplicate-operation' });
        }
        const operation: ProvisioningOperation = {
            operationId,
            plan: clonePlan(plan),
            completedSteps: [],
            row: createRow(operationId, plan),
            cancelled: false,
            running: false,
            settledAttempt: 0,
        };
        this.operations.set(operationId, operation);
        this.publish();
        return Promise.resolve().then(() => this.run(operation));
    }

    retry(
        operationId: string,
        replacementPlan?: WorktreeProvisioningPlan
    ): Promise<WorktreeProvisioningOutcome> {
        const operation = this.operations.get(operationId);
        if (!operation || operation.running || operation.row.stage !== 'failed'
            || !operation.row.retryable
            || (replacementPlan && operation.completedSteps.includes('worktree'))) {
            return Promise.resolve({ kind: 'failed', operationId, errorCode: 'retry-unavailable' });
        }
        if (replacementPlan) {
            operation.plan = clonePlan(replacementPlan);
        }
        operation.cancelled = false;
        operation.row = createRow(operation.operationId, operation.plan, operation.completedSteps);
        this.publish();
        return Promise.resolve().then(() => this.run(operation));
    }

    cancel(operationId: string): boolean {
        const operation = this.operations.get(operationId);
        if (!operation || !operation.row.cancellable || operation.row.stage === 'failed') {
            return false;
        }
        operation.cancelled = true;
        operation.row = { ...operation.row, cancellable: false };
        this.publish();
        return true;
    }

    getRows(): ProvisioningWorktreeRow[] {
        return Array.from(this.operations.values()).map(operation => cloneRow(operation.row));
    }

    getRevision(): number {
        return this.revision;
    }

    restore(records: readonly WorktreeProvisioningRecoveryOperation[]): void {
        for (const record of records) {
            if (!isSafeOperationId(record.operationId) || this.operations.has(record.operationId)) {
                continue;
            }
            const completedSteps = record.completedSteps.slice();
            const operation: ProvisioningOperation = {
                operationId: record.operationId,
                plan: clonePlan(record.plan),
                completedSteps,
                ...(record.worktreeKey ? { worktreeKey: { ...record.worktreeKey } } : {}),
                row: {
                    ...cloneRow(record.row),
                    stage: 'failed',
                    completedSteps: completedSteps.slice(),
                    retryable: true,
                    cancellable: false,
                    errorCode: 'interrupted',
                },
                cancelled: false,
                running: false,
                settledAttempt: 0,
            };
            if (completedSteps.includes('worktree') && !operation.worktreeKey) {
                continue;
            }
            this.operations.set(operation.operationId, operation);
        }
        if (this.operations.size) {
            this.publish();
        }
    }

    getRecoveryOperations(): WorktreeProvisioningRecoveryOperation[] {
        return Array.from(this.operations.values()).map(operation => ({
            operationId: operation.operationId,
            plan: clonePlan(operation.plan),
            completedSteps: operation.completedSteps.slice(),
            ...(operation.worktreeKey ? { worktreeKey: { ...operation.worktreeKey } } : {}),
            row: cloneRow(operation.row),
        }));
    }

    private async run(operation: ProvisioningOperation): Promise<WorktreeProvisioningOutcome> {
        if (operation.running) {
            return { kind: 'failed', operationId: operation.operationId, errorCode: 'operation-running' };
        }
        operation.running = true;
        const attempt = operation.settledAttempt + 1;
        try {
            if (operation.cancelled) {
                return operation.completedSteps.includes('worktree')
                    ? this.partial(operation, 'cancelled', attempt)
                    : this.fail(operation, 'cancelled', attempt);
            }
            if (!operation.completedSteps.includes('worktree')) {
                this.setStage(operation, 'creating', true);
                operation.worktreeKey = await this.options.createWorktree(
                    operation.plan,
                    () => operation.cancelled,
                    operation.operationId
                );
                operation.completedSteps.push('worktree');
                this.synchronizeCompletedSteps(operation);
                await this.options.checkpoint?.();
                if (operation.cancelled) {
                    return this.partial(operation, 'cancelled', attempt);
                }
            }
            if (!operation.completedSteps.includes('agent')) {
                await this.options.validateWorktree?.(
                    operation.plan,
                    operation.worktreeKey!,
                    operation.operationId
                );
            }
            if (!operation.completedSteps.includes('setup')) {
                this.setStage(operation, 'setting-up', true);
                await this.options.runSetup(
                    operation.plan,
                    operation.worktreeKey!,
                    () => operation.cancelled,
                    operation.operationId
                );
                operation.completedSteps.push('setup');
                this.synchronizeCompletedSteps(operation);
                await this.options.checkpoint?.();
                if (operation.cancelled) {
                    return this.partial(operation, 'cancelled', attempt);
                }
            }
            if (!operation.completedSteps.includes('agent')) {
                this.setStage(operation, 'starting-agent', false);
                await this.options.startAgent(
                    operation.plan,
                    operation.worktreeKey!,
                    () => operation.cancelled,
                    operation.operationId
                );
                operation.completedSteps.push('agent');
            }
            const outcome: WorktreeProvisioningOutcome = {
                kind: 'succeeded',
                operationId: operation.operationId,
                worktreeKey: { ...operation.worktreeKey! },
            };
            operation.settledAttempt = attempt;
            this.operations.delete(operation.operationId);
            this.publish();
            this.options.onSettled?.(outcome);
            return outcome;
        } catch (error) {
            const errorCode = getErrorCode(error);
            const retryable = getRetryable(error);
            return operation.completedSteps.includes('worktree')
                ? this.partial(operation, errorCode, attempt, retryable)
                : this.fail(operation, errorCode, attempt, retryable);
        } finally {
            operation.running = false;
        }
    }

    private partial(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number,
        retryable = true
    ): WorktreeProvisioningOutcome {
        const outcome: WorktreeProvisioningOutcome = {
            kind: 'partial',
            operationId: operation.operationId,
            worktreeKey: { ...operation.worktreeKey! },
            errorCode,
            completedSteps: operation.completedSteps.slice(),
        };
        this.setFailed(operation, errorCode, attempt, retryable);
        this.options.onSettled?.(outcome);
        return outcome;
    }

    private fail(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number,
        retryable = true
    ): WorktreeProvisioningOutcome {
        const outcome: WorktreeProvisioningOutcome = {
            kind: 'failed', operationId: operation.operationId, errorCode,
        };
        if (errorCode === 'cancelled') {
            operation.settledAttempt = attempt;
            this.operations.delete(operation.operationId);
            this.publish();
        } else {
            this.setFailed(operation, errorCode, attempt, retryable);
        }
        this.options.onSettled?.(outcome);
        return outcome;
    }

    private setFailed(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number,
        retryable: boolean
    ): void {
        operation.settledAttempt = attempt;
        operation.row = {
            ...operation.row,
            stage: 'failed',
            completedSteps: operation.completedSteps.slice(),
            retryable,
            cancellable: false,
            errorCode,
        };
        this.publish();
    }

    private setStage(
        operation: ProvisioningOperation,
        stage: ProvisioningWorktreeRow['stage'],
        cancellable: boolean
    ): void {
        operation.row = {
            ...operation.row,
            stage,
            completedSteps: operation.completedSteps.slice(),
            retryable: false,
            cancellable,
        };
        this.publish();
    }

    private synchronizeCompletedSteps(operation: ProvisioningOperation): void {
        operation.row = {
            ...operation.row,
            completedSteps: operation.completedSteps.slice(),
        };
    }

    private publish(): void {
        this.revision = this.revision >= Number.MAX_SAFE_INTEGER ? 1 : this.revision + 1;
        this.options.publish(this.revision, this.getRows());
    }
}

function createRow(
    operationId: string,
    plan: WorktreeProvisioningPlan,
    completedSteps: readonly WorktreeProvisioningCompletedStep[] = []
): ProvisioningWorktreeRow {
    return {
        kind: 'provisioning',
        operationId,
        repositoryKey: plan.repositoryKey,
        taskName: plan.taskName,
        proposedPath: plan.worktreePath,
        stage: 'queued',
        completedSteps: completedSteps.slice(),
        retryable: false,
        cancellable: true,
    };
}

function cloneRow(row: ProvisioningWorktreeRow): ProvisioningWorktreeRow {
    return { ...row, completedSteps: row.completedSteps.slice() };
}

function clonePlan(plan: WorktreeProvisioningPlan): WorktreeProvisioningPlan {
    return { ...plan };
}

function isSafeOperationId(value: string): boolean {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function getErrorCode(error: unknown): string {
    if (error && typeof error === 'object'
        && typeof (error as { code?: unknown }).code === 'string'
        && /^[a-z0-9-]{1,64}$/u.test((error as { code: string }).code)) {
        return (error as { code: string }).code;
    }
    return 'unexpected-error';
}

function getRetryable(error: unknown): boolean {
    return !(error && typeof error === 'object'
        && (error as { retryable?: unknown }).retryable === false);
}
