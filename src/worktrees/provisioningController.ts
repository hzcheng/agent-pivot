'use strict';

import type { ProvisioningWorktreeRow, WorktreeKey } from './types';
import type { WorktreeProvisioningPlan } from './provisioningPlan';
import { cloneMemberBaseline } from './baseline';

export type WorktreeProvisioningCompletedStep = 'worktree' | 'setup';

export type WorktreeProvisioningOutcome =
  | {
      kind: 'succeeded'; operationId: string; worktreeKey: WorktreeKey;
      plan: WorktreeProvisioningPlan;
  }
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
    validateWorktree?: (
        plan: WorktreeProvisioningPlan,
        worktreeKey: WorktreeKey,
        operationId: string
    ) => Promise<void>;
    publish: (revision: number, rows: readonly ProvisioningWorktreeRow[]) => void;
    checkpoint?: () => Promise<void>;
    onSettled?: (outcome: WorktreeProvisioningOutcome) => void | Promise<void>;
    /**
     * Awaited after the physical worktree is complete but before the
     * operation is dropped and success publishes. When it throws, the
     * operation degrades to a retryable partial instead of a false success
     * (e.g. the authoritative manifest write failed).
     */
    finalizeSuccess?: (
        outcome: WorktreeProvisioningOutcome & { kind: 'succeeded' }
    ) => Promise<void>;
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
    private readonly discardClaims = new Set<string>();
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
            || !operation.row.retryable || this.discardClaims.has(operationId)
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

    /**
     * Atomically claims the right to discard a settled-failed operation.
     * The claimant may then persist tombstones and mutate contexts before
     * calling discard(); a running or retried operation can never be
     * claimed, so a failed claim changes nothing.
     */
    claimDiscard(operationId: string): boolean {
        const operation = this.operations.get(operationId);
        if (!operation || operation.running || operation.row.stage !== 'failed'
            || this.discardClaims.has(operationId)) {
            return false;
        }
        this.discardClaims.add(operationId);
        return true;
    }

    /** Releases a discard claim without discarding (rollback path). */
    releaseDiscard(operationId: string): void {
        this.discardClaims.delete(operationId);
    }

    /** Drops a settled-failed row; requires a prior claimDiscard. */
    discard(operationId: string): boolean {
        const operation = this.operations.get(operationId);
        if (!operation || operation.running || operation.row.stage !== 'failed'
            || !this.discardClaims.has(operationId)) {
            return false;
        }
        this.discardClaims.delete(operationId);
        this.operations.delete(operationId);
        this.publish();
        return true;
    }

    cancel(operationId: string): boolean {
        const operation = this.operations.get(operationId);
        if (!operation || !operation.row.cancellable || operation.row.stage === 'failed'
            || this.discardClaims.has(operationId)) {
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
        // Restore never publishes: it runs inside the constructor while the
        // dashboard composition is not yet initialized. The owner calls
        // publishNow once composition has settled.
    }

    publishNow(): void {
        this.publish();
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
                    ? await this.partial(operation, 'cancelled', attempt)
                    : await this.fail(operation, 'cancelled', attempt);
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
                    return await this.partial(operation, 'cancelled', attempt);
                }
            }
            await this.options.validateWorktree?.(
                operation.plan,
                operation.worktreeKey!,
                operation.operationId
            );
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
                    return await this.partial(operation, 'cancelled', attempt);
                }
            }
            const outcome: WorktreeProvisioningOutcome = {
                kind: 'succeeded',
                operationId: operation.operationId,
                worktreeKey: { ...operation.worktreeKey! },
                plan: { ...operation.plan },
            };
            operation.settledAttempt = attempt;
            try {
                // The group manifest record must land before the success
                // settlement reaches the webview (PRD §9 "新建即写入"); a
                // failed write keeps the operation as a retryable partial.
                await this.options.finalizeSuccess?.(outcome);
            } catch (error) {
                return await this.partial(
                    operation, getErrorCode(error), attempt, getRetryable(error));
            }
            this.operations.delete(operation.operationId);
            try {
                // The completed operation's recovery record must be durably
                // gone before success publishes; a fire-and-forget cleanup
                // could resurrect it as an interrupted operation after a
                // crash.
                await this.options.checkpoint?.();
            } catch (error) {
                // The cleanup must not lose the operation either: put it
                // back and degrade to a retryable partial.
                this.operations.set(operation.operationId, operation);
                return await this.partial(
                    operation, getErrorCode(error), attempt, getRetryable(error));
            }
            this.publish();
            await this.options.onSettled?.(outcome);
            return outcome;
        } catch (error) {
            const errorCode = getErrorCode(error);
            const retryable = getRetryable(error);
            return operation.completedSteps.includes('worktree')
                ? await this.partial(operation, errorCode, attempt, retryable)
                : await this.fail(operation, errorCode, attempt, retryable);
        } finally {
            operation.running = false;
        }
    }

    private async partial(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number,
        retryable = true
    ): Promise<WorktreeProvisioningOutcome> {
        const outcome: WorktreeProvisioningOutcome = {
            kind: 'partial',
            operationId: operation.operationId,
            worktreeKey: { ...operation.worktreeKey! },
            errorCode,
            completedSteps: operation.completedSteps.slice(),
        };
        this.setFailed(operation, errorCode, attempt, retryable);
        await this.options.onSettled?.(outcome);
        return outcome;
    }

    private async fail(
        operation: ProvisioningOperation,
        errorCode: string,
        attempt: number,
        retryable = true
    ): Promise<WorktreeProvisioningOutcome> {
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
        await this.options.onSettled?.(outcome);
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
    return {
        ...plan,
        ...(plan.baseline
            ? { baseline: cloneMemberBaseline(plan.baseline) }
            : {}),
    };
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
