'use strict';

import * as path from 'path';
import type { WorktreeProvisioningCompletedStep } from './provisioningController';
import type { WorktreeProvisioningPlan } from './provisioningPlan';
import type { ProvisioningWorktreeRow, WorktreeKey } from './types';
import { normalizeWorktreeSetupCommand } from './worktreeSetupRunner';
import { isManagedWorktreePath } from './provisioningPlan';

const STORAGE_KEY = 'agentPivot.worktreeProvisioning.v1';
const TOMBSTONE_STORAGE_KEY = 'agentPivot.worktreeProvisioningTombstones.v1';
const MAX_RECORDS = 32;
// Tombstones live in their own bucket with their own (generous) bound so
// they can never crowd out live recovery records (or be evicted by
// them). The bound exists for memento health; legitimate churn prunes
// tombstones long before it is reached.
const MAX_TOMBSTONES = 1024;
const MAX_STRING = 32 * 1024;

interface MementoLike {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export type ProvisioningSessionProfile =
    | { kind: 'base' }
    | { kind: 'profile'; name: string };

export interface PersistedWorktreeProvisioningOperation {
    version: 1;
    operationId: string;
    projectId: string;
    /**
     * The workspace navigation identity captured when provisioning started.
     * Save Workspace As can reuse a legacy projectId for different roots, so
     * finalize and reconciliation must match this identity strictly instead
     * of trusting the projectId alone. Absent only in pre-binding records.
     */
    workspaceNavigationIdentity?: string;
    /**
     * Group-creation membership (M2): when set, this operation provisions
     * one member of an existing manifest group and must not surface as an
     * Unmanaged provisioning row — the group row renders its state.
     */
    groupId?: string;
    memberId?: string;
    /** The confirmed primary choice, applied once the member is ready. */
    preferredPrimary?: boolean;
    /**
     * Dismissed intents whose physical worktree exists but whose setup
     * never completed. Tombstones never restore as rows; they only keep
     * reconciliation from seeding a half-initialized worktree as ready.
     */
    tombstone?: boolean;
    providerId: 'codex' | 'kimi' | 'claude';
    profile?: ProvisioningSessionProfile;
    setupCommand: string[];
    plan: WorktreeProvisioningPlan;
    completedSteps: WorktreeProvisioningCompletedStep[];
    worktreeKey?: WorktreeKey;
    row: ProvisioningWorktreeRow;
}

/** Stores only validated machine-local provisioning recovery records. */
export class WorktreeProvisioningStore {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly memento: MementoLike,
        private readonly getWorktreeDirectory?: () => string
    ) {
    }

    read(): PersistedWorktreeProvisioningOperation[] {
        return [
            ...this.parseRecords(this.memento.get<unknown>(STORAGE_KEY, []), MAX_RECORDS),
            ...this.parseRecords(
                this.memento.get<unknown>(TOMBSTONE_STORAGE_KEY, []), MAX_TOMBSTONES),
        ];
    }

    private parseRecords(
        value: unknown,
        max: number
    ): PersistedWorktreeProvisioningOperation[] {
        if (!Array.isArray(value)) {
            return [];
        }
        const seen = new Set<string>();
        const records: PersistedWorktreeProvisioningOperation[] = [];
        for (const candidate of value.slice(0, max)) {
            const record = parseRecord(candidate, this.getWorktreeDirectory?.());
            if (record && !seen.has(record.operationId)) {
                seen.add(record.operationId);
                records.push(record);
            }
        }
        return records;
    }

    private sanitizeRecords(
        records: readonly PersistedWorktreeProvisioningOperation[],
        max: number
    ): PersistedWorktreeProvisioningOperation[] {
        // Keep the newest entries when the bound is exceeded.
        return records.slice(-max)
            .map(record => parseRecord(record, this.getWorktreeDirectory?.()))
            .filter((record): record is PersistedWorktreeProvisioningOperation => !!record);
    }

    /**
     * Drops tombstones whose physical worktree no longer appears in the
     * snapshot: nothing is left to protect from ready seeding. Never
     * prunes against a truncated snapshot — a worktree missing only
     * because discovery hit its cap would lose its protection.
     */
    async pruneTombstones(
        existingWorktreePaths: ReadonlySet<string>,
        snapshotTruncated = false
    ): Promise<void> {
        if (snapshotTruncated) {
            return;
        }
        const tombstones = this.parseRecords(
            this.memento.get<unknown>(TOMBSTONE_STORAGE_KEY, []), MAX_TOMBSTONES);
        const kept = tombstones.filter(record =>
            existingWorktreePaths.has(
                `${record.plan.repositoryKey} ${record.plan.worktreePath}`));
        if (kept.length === tombstones.length) {
            return;
        }
        const operation = async (): Promise<void> => {
            await this.memento.update(TOMBSTONE_STORAGE_KEY, kept);
        };
        const result = this.writeQueue.then(operation, operation);
        this.writeQueue = result.catch(() => undefined);
        await result;
    }

    replace(records: readonly PersistedWorktreeProvisioningOperation[]): Promise<void> {
        const snapshot = this.sanitizeRecords(
            records.filter(record => !record.tombstone), MAX_RECORDS);
        const tombstoneSnapshot = this.sanitizeRecords(
            records.filter(record => record.tombstone), MAX_TOMBSTONES);
        const operation = async (): Promise<void> => {
            await this.memento.update(STORAGE_KEY, snapshot);
            await this.memento.update(TOMBSTONE_STORAGE_KEY, tombstoneSnapshot);
        };
        const result = this.writeQueue.then(operation, operation);
        this.writeQueue = result.catch(() => undefined);
        return result;
    }
}

function parseRecord(value: unknown, worktreeDirectory?: string): PersistedWorktreeProvisioningOperation | null {
    if (!isRecord(value) || value.version !== 1
        || !safeId(value.operationId) || !safeString(value.projectId)
        || !['codex', 'kimi', 'claude'].includes(String(value.providerId))) {
        return null;
    }
    const plan = parsePlan(value.plan);
    const row = parseRow(value.row);
    const completedSteps = parseCompletedSteps(value.completedSteps);
    const worktreeKey = value.worktreeKey === undefined
        ? undefined : parseWorktreeKey(value.worktreeKey);
    const profile = value.profile === undefined ? undefined : parseProfile(value.profile);
    const workspaceNavigationIdentity = value.workspaceNavigationIdentity === undefined
        ? undefined
        : (typeof value.workspaceNavigationIdentity === 'string'
            && safeString(value.workspaceNavigationIdentity)
            ? value.workspaceNavigationIdentity : null);
    const groupId = value.groupId === undefined
        ? undefined
        : (safeId(value.groupId) ? value.groupId : null);
    const memberId = value.memberId === undefined
        ? undefined
        : (safeId(value.memberId) ? value.memberId : null);
    const preferredPrimary = value.preferredPrimary === undefined
        ? undefined
        : (value.preferredPrimary === true ? true : null);
    const tombstone = value.tombstone === undefined
        ? undefined
        : (value.tombstone === true ? true : null);
    const setupCommand = normalizeWorktreeSetupCommand(value.setupCommand);
    if (!plan || !row || !completedSteps || (value.worktreeKey !== undefined && !worktreeKey)
        || (value.profile !== undefined && !profile)
        || workspaceNavigationIdentity === null
        || groupId === null || memberId === null
        || preferredPrimary === null
        || tombstone === null
        || (groupId === undefined) !== (memberId === undefined)
        || (preferredPrimary === true && groupId === undefined)
        || row.operationId !== value.operationId || row.repositoryKey !== plan.repositoryKey
        || row.taskName !== plan.taskName || row.proposedPath !== plan.worktreePath
        || row.completedSteps.join('\0') !== completedSteps.join('\0')
        || !isManagedWorktreePath(plan.repositoryKey, plan.worktreePath, worktreeDirectory)
        || !Array.isArray(value.setupCommand)
        || setupCommand.length !== value.setupCommand.length
        || (completedSteps.includes('worktree') !== !!worktreeKey)
        || (worktreeKey && (worktreeKey.repositoryKey !== plan.repositoryKey
            || worktreeKey.canonicalWorktreePath !== plan.worktreePath))
        || (value.providerId !== 'codex' && !!profile)) {
        return null;
    }
    return {
        version: 1,
        operationId: value.operationId,
        projectId: value.projectId,
        ...(workspaceNavigationIdentity ? { workspaceNavigationIdentity } : {}),
        ...(groupId && memberId ? { groupId, memberId } : {}),
        ...(preferredPrimary ? { preferredPrimary: true } : {}),
        ...(tombstone ? { tombstone: true } : {}),
        providerId: value.providerId as 'codex' | 'kimi' | 'claude',
        ...(profile ? { profile } : {}),
        setupCommand,
        plan,
        completedSteps,
        ...(worktreeKey ? { worktreeKey } : {}),
        row,
    };
}

function parsePlan(value: unknown): WorktreeProvisioningPlan | null {
    if (!isRecord(value)) {
        return null;
    }
    const fields = ['repositoryKey', 'commandCwd', 'baseRef', 'taskName', 'slug', 'branchName', 'worktreePath'];
    if (!fields.every(field => safeString(value[field]))
        || !absolutePath(value.repositoryKey) || !absolutePath(value.commandCwd)
        || !absolutePath(value.worktreePath) || String(value.baseRef).startsWith('-')
        || String(value.branchName).startsWith('-')) {
        return null;
    }
    return {
        repositoryKey: value.repositoryKey,
        commandCwd: value.commandCwd,
        baseRef: value.baseRef,
        taskName: value.taskName,
        slug: value.slug,
        branchName: value.branchName,
        worktreePath: value.worktreePath,
    };
}

function parseRow(value: unknown): ProvisioningWorktreeRow | null {
    if (!isRecord(value) || value.kind !== 'provisioning' || !safeId(value.operationId)
        || !safeString(value.repositoryKey) || !safeString(value.taskName)
        || !absolutePath(value.proposedPath)
        || !['queued', 'creating', 'setting-up', 'starting-agent', 'failed'].includes(String(value.stage))
        || typeof value.retryable !== 'boolean' || typeof value.cancellable !== 'boolean') {
        return null;
    }
    const completedSteps = Array.isArray(value.completedSteps)
        ? value.completedSteps.filter(item => typeof item === 'string').slice(0, 3) : null;
    if (!completedSteps || (value.errorCode !== undefined && !safeErrorCode(value.errorCode))) {
        return null;
    }
    return {
        kind: 'provisioning', operationId: value.operationId,
        repositoryKey: value.repositoryKey, taskName: value.taskName,
        proposedPath: value.proposedPath, stage: value.stage as ProvisioningWorktreeRow['stage'],
        completedSteps,
        retryable: value.retryable, cancellable: value.cancellable,
        ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    };
}

function parseCompletedSteps(value: unknown): WorktreeProvisioningCompletedStep[] | null {
    if (!Array.isArray(value) || value.some(item => !['worktree', 'setup', 'agent'].includes(String(item)))) {
        return null;
    }
    const steps = value as WorktreeProvisioningCompletedStep[];
    const ordered = ['worktree', 'setup', 'agent'].slice(0, steps.length);
    return steps.every((step, index) => step === ordered[index]) ? steps.slice() : null;
}

function parseWorktreeKey(value: unknown): WorktreeKey | null {
    return isRecord(value) && absolutePath(value.repositoryKey) && absolutePath(value.canonicalWorktreePath)
        ? { repositoryKey: value.repositoryKey, canonicalWorktreePath: value.canonicalWorktreePath }
        : null;
}

function parseProfile(value: unknown): ProvisioningSessionProfile | null {
    if (!isRecord(value)) {
        return null;
    }
    if (value.kind === 'base' && Object.keys(value).length === 1) {
        return { kind: 'base' };
    }
    return value.kind === 'profile' && safeString(value.name)
        ? { kind: 'profile', name: value.name } : null;
}

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING
        && !/[\0\r\n]/u.test(value);
}

function safeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
}

function safeErrorCode(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9-]{1,64}$/u.test(value);
}

function absolutePath(value: unknown): value is string {
    return safeString(value) && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}
