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
        isCancelled: () => boolean
    ) => Promise<WorktreeKey>;
    runSetup: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean
    ) => Promise<void>;
    startAgent: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        isCancelled: () => boolean
    ) => Promise<void>;
    publish: (revision: number, rows: readonly ProvisioningWorktreeRow[]) => void;
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

    retry(operationId: string): Promise<WorktreeProvisioningOutcome> {
        const operation = this.operations.get(operationId);
        if (!operation || operation.running || operation.row.stage !== 'failed'
            || !operation.row.retryable) {
            return Promise.resolve({ kind: 'failed', operationId, errorCode: 'retry-unavailable' });
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
        return true;
    }

    getRows(): ProvisioningWorktreeRow[] {
        return Array.from(this.operations.values()).map(operation => cloneRow(operation.row));
    }

    getRevision(): number {
        return this.revision;
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
                    () => operation.cancelled
                );
                operation.completedSteps.push('worktree');
                if (operation.cancelled) {
                    return this.partial(operation, 'cancelled', attempt);
                }
            }
            if (!operation.completedSteps.includes('setup')) {
                this.setStage(operation, 'setting-up', true);
                await this.options.runSetup(
                    operation.plan,
                    operation.worktreeKey!,
                    () => operation.cancelled
                );
                operation.completedSteps.push('setup');
                if (operation.cancelled) {
                    return this.partial(operation, 'cancelled', attempt);
                }
            }
            if (!operation.completedSteps.includes('agent')) {
                this.setStage(operation, 'starting-agent', false);
                await this.options.startAgent(
                    operation.plan,
                    operation.worktreeKey!,
                    () => operation.cancelled
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
            return operation.completedSteps.includes('worktree')
                ? this.partial(operation, errorCode, attempt)
                : this.fail(operation, errorCode, attempt);
        } finally {
            operation.running = false;
        }
    }

    private partial(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number
    ): WorktreeProvisioningOutcome {
        const outcome: WorktreeProvisioningOutcome = {
            kind: 'partial',
            operationId: operation.operationId,
            worktreeKey: { ...operation.worktreeKey! },
            errorCode,
            completedSteps: operation.completedSteps.slice(),
        };
        this.setFailed(operation, errorCode, attempt, true);
        this.options.onSettled?.(outcome);
        return outcome;
    }

    private fail(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number
    ): WorktreeProvisioningOutcome {
        const outcome: WorktreeProvisioningOutcome = {
            kind: 'failed', operationId: operation.operationId, errorCode,
        };
        if (errorCode === 'cancelled') {
            operation.settledAttempt = attempt;
            this.operations.delete(operation.operationId);
            this.publish();
        } else {
            this.setFailed(operation, errorCode, attempt, true);
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
