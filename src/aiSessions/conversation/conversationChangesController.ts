'use strict';

import * as path from 'path';
import { createHash } from 'crypto';
import type * as vscode from 'vscode';
import {
    aggregateMemberChanges,
    ChangesCollector,
    MemberChangesSnapshot,
} from '../../worktrees/changesCollector';
import type {
    WorktreeGroup,
    WorktreeGroupMember,
} from '../../worktrees/groupManifestStore';
import type { RetiredWorktreeIdentity } from '../../worktrees/retiredWorktrees';
import type { MemberBaseline, WorktreeKey } from '../../worktrees/types';
import type {
    ConversationChangesFileItem,
    ConversationChangesMemberView,
    ConversationChangesState,
} from './types';
import type { ConversationViewerTarget } from './viewerTarget';

const MAX_MEMBER_LABEL_LENGTH = 64;

/** Persisted session identity for changes resolution (PRD §4.1). */
export interface ConversationChangesSessionIdentity {
    worktreeKey?: WorktreeKey;
    cwd?: string;
    navigationIdentity?: string;
}

/** A resolvable member of the session's change set. */
interface ChangesMemberSource {
    memberId: string;
    repoLabel: string;
    branchName: string;
    worktreePath: string;
    baseline?: MemberBaseline;
    detached?: boolean;
}

interface ResolvedChangeSet {
    kind: 'ready' | 'retired' | 'unavailable';
    members: ChangesMemberSource[];
}

export interface ConversationChangesControllerOptions {
    getPanel: () => vscode.WebviewPanel | undefined;
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    /** Suspended (hidden) panels pause collection like telemetry does. */
    isSuspended: () => boolean;
    /** PRD §4.1 step 1: the session's persisted identity. */
    resolveSessionIdentity: (
        target: ConversationViewerTarget
    ) => Promise<ConversationChangesSessionIdentity | undefined>;
    /** PRD §4.1 step 4: live fallback when no persisted identity exists. */
    resolveWorktreeKey: (
        candidatePath: string
    ) => Promise<WorktreeKey | undefined>;
    findGroupByWorktreeKey: (
        navigationIdentity: string,
        key: WorktreeKey
    ) => WorktreeGroup | undefined;
    listRetiredIdentities: (
        navigationIdentity: string
    ) => RetiredWorktreeIdentity[];
    collector: ChangesCollector;
    openWorkingChangeDiff: (
        worktreePath: string,
        item: ConversationChangesFileItem
    ) => Promise<void>;
    openTaskResultReview: (
        worktreePath: string,
        baselineSha: string,
        title: string
    ) => Promise<void>;
    showWorktreeInSourceControl: (worktreeRoot: string) => Promise<void>;
    /** Git API change events (P0 main refresh channel, PRD §5.4). */
    watchRepositoryChanges?: (
        paths: readonly string[],
        onChange: () => void
    ) => { dispose(): void };
    onError?: (message: string, error?: unknown) => void;
    now?: () => number;
}

interface ActiveChanges {
    target: ConversationViewerTarget;
    generation: number;
    changeSet: ResolvedChangeSet;
    snapshots: Map<string, MemberChangesSnapshot>;
    selectedMemberId?: string;
    watcher?: { dispose(): void };
}

/**
 * Drives the conversation Changes button + sidebar tab (changes-panel
 * PRD): resolves the session's change set once per target, collects
 * member snapshots on demand, and publishes one authoritative state
 * message. Unknown states are never rendered as zero (PRD §4.3).
 */
export class ConversationChangesController {
    private active?: ActiveChanges;
    private collecting?: Promise<void>;
    private pendingCollect = false;
    private state?: ConversationChangesState;
    private readonly collector: ChangesCollector;
    private readonly now: () => number;

    constructor(
        private readonly options: ConversationChangesControllerOptions
    ) {
        this.collector = options.collector;
        this.now = options.now || Date.now;
    }

    get snapshot(): ConversationChangesState | undefined {
        return this.state;
    }

    reset(): void {
        this.active?.watcher?.dispose();
        this.active = undefined;
        this.state = undefined;
        this.pendingCollect = false;
    }

    /** Target switch / initial load: resolve, collect, publish (PRD §5.4). */
    async activate(target: ConversationViewerTarget): Promise<void> {
        if (this.active
            && this.active.target.projectId === target.projectId
            && this.active.target.provider === target.provider
            && this.active.target.sessionId === target.sessionId) {
            return;
        }
        this.active?.watcher?.dispose();
        const changeSet = await this.resolveChangeSet(target);
        const active: ActiveChanges = {
            target,
            generation: this.options.getSubscriptionGeneration(),
            changeSet,
            snapshots: new Map(),
        };
        active.selectedMemberId = changeSet.members[0]?.memberId;
        this.active = active;
        this.state = undefined;
        if (changeSet.kind !== 'ready') {
            // Terminal kinds publish immediately; a ready change set first
            // collects real snapshots so transient unknown states never
            // render as misleading counts (PRD §4.3).
            this.publishState(active);
        }
        if (changeSet.kind === 'ready' && changeSet.members.length) {
            active.watcher = this.options.watchRepositoryChanges?.(
                changeSet.members.map(member => member.worktreePath),
                () => this.handleExternalChange(target));
        }
        await this.collectAndPublish(target);
    }

    /** Piggyback refresh (telemetry cycle fallback, PRD §5.4). */
    async onTelemetryRefreshed(target: ConversationViewerTarget): Promise<void> {
        if (!this.matchesActive(target)) {
            return;
        }
        await this.collectAndPublish(target);
    }

    /** Git API change events (P0 main refresh channel, PRD §5.4). */
    handleExternalChange(target: ConversationViewerTarget): void {
        if (!this.matchesActive(target)) {
            return;
        }
        void this.collectAndPublish(target);
    }

    async handleRefresh(): Promise<void> {
        const target = this.active?.target;
        if (target) {
            await this.collectAndPublish(target);
        }
    }

    handleSelect(memberId: string): void {
        const active = this.active;
        if (!active
            || !active.changeSet.members.some(member =>
                member.memberId === memberId)) {
            return;
        }
        active.selectedMemberId = memberId;
        this.publishState(active);
    }

    async handleOpenFile(input: {
        memberId: string;
        item: ConversationChangesFileItem;
    }): Promise<void> {
        const member = this.active?.changeSet.members.find(candidate =>
            candidate.memberId === input.memberId);
        if (!member) {
            return;
        }
        // The webview-supplied path must stay inside the member worktree.
        const resolved = path.resolve(member.worktreePath, input.item.path);
        if (!isContainedIn(member.worktreePath, resolved)) {
            return;
        }
        await this.options.openWorkingChangeDiff(member.worktreePath, input.item);
    }

    async handleReview(memberId: string): Promise<void> {
        const active = this.active;
        const member = active?.changeSet.members.find(candidate =>
            candidate.memberId === memberId);
        if (!active || !member) {
            return;
        }
        const snapshot = active.snapshots.get(memberId);
        const baselineSha = snapshot?.availability === 'available'
            && member.baseline
            ? member.baseline.commitSha
            : undefined;
        if (!baselineSha) {
            return;
        }
        await this.options.openTaskResultReview(
            member.worktreePath,
            baselineSha,
            `Task result · ${member.repoLabel} (${member.branchName})`);
    }

    async handleOpenScm(memberId: string): Promise<void> {
        const member = this.active?.changeSet.members.find(candidate =>
            candidate.memberId === memberId);
        if (member) {
            await this.options.showWorktreeInSourceControl(member.worktreePath);
        }
    }

    private matchesActive(target: ConversationViewerTarget): boolean {
        return !!this.active
            && this.active.target.projectId === target.projectId
            && this.active.target.provider === target.provider
            && this.active.target.sessionId === target.sessionId;
    }

    /**
     * Authoritative resolution order (PRD §4.1): persisted identity →
     * manifest → retired identity → live fallback → hidden. A tool
     * call's cwd never overrides the session's persisted identity.
     */
    private async resolveChangeSet(
        target: ConversationViewerTarget
    ): Promise<ResolvedChangeSet> {
        const identity = await this.options.resolveSessionIdentity(target);
        const navigationIdentity = identity?.navigationIdentity;
        let key = identity?.worktreeKey;
        if (!key && identity?.cwd) {
            key = await this.options.resolveWorktreeKey(identity.cwd);
        }
        if (!key || !navigationIdentity) {
            return { kind: 'unavailable', members: [] };
        }
        const group = this.options.findGroupByWorktreeKey(
            navigationIdentity, key);
        if (group) {
            const members = group.members
                .filter(member => member.state === 'ready' && member.worktreeKey)
                .map(member => memberSource(member));
            return members.length
                ? { kind: 'ready', members }
                : { kind: 'unavailable', members: [] };
        }
        // Retired check must precede the live fallback (PRD §4.1): a
        // deleted worktree's session is retired, not unmanaged.
        const retired = this.options.listRetiredIdentities(navigationIdentity)
            .some(record =>
                record.repositoryKey === key!.repositoryKey
                && record.canonicalWorktreePath === key!.canonicalWorktreePath);
        if (retired) {
            return { kind: 'retired', members: [] };
        }
        // Degraded single-member view for unmanaged / legacy sessions.
        return {
            kind: 'ready',
            members: [{
                // Protocol member ids are charset-restricted; hash the
                // repository key (paths contain separators).
                memberId: `unmanaged-${createHash('sha256')
                    .update(key.repositoryKey).digest('hex').slice(0, 16)}`,
                repoLabel: repoLabelFromKey(key.repositoryKey),
                branchName: '',
                worktreePath: key.canonicalWorktreePath,
            }],
        };
    }

    private async collectAndPublish(
        target: ConversationViewerTarget
    ): Promise<void> {
        if (!this.matchesActive(target) || this.options.isSuspended()) {
            return;
        }
        if (this.collecting) {
            this.pendingCollect = true;
            return;
        }
        this.collecting = this.doCollect(target).finally(() => {
            this.collecting = undefined;
        });
        await this.collecting;
        if (this.pendingCollect && this.matchesActive(target)) {
            this.pendingCollect = false;
            await this.collectAndPublish(target);
        }
    }

    private async doCollect(target: ConversationViewerTarget): Promise<void> {
        const active = this.active;
        if (!active || active.changeSet.kind !== 'ready') {
            return;
        }
        const results = await Promise.all(active.changeSet.members.map(
            async member => {
                try {
                    const snapshot = await this.collector.collect(
                        member.worktreePath, member.baseline);
                    return { memberId: member.memberId, snapshot };
                } catch (error) {
                    this.options.onError?.(
                        'Changes collection failed for member.', error);
                    return null;
                }
            }));
        if (!this.matchesActive(target)) {
            // Session switched mid-collection: discard in-flight results.
            return;
        }
        for (const result of results) {
            if (result) {
                active.snapshots.set(result.memberId, result.snapshot);
            }
        }
        this.publishState(active);
    }

    private publishState(active: ActiveChanges): void {
        const panel = this.options.getPanel();
        if (!panel || !this.matchesActive(active.target)) {
            return;
        }
        const snapshots = active.changeSet.members.map(member =>
            active.snapshots.get(member.memberId));
        const collected = snapshots.filter(
            (snapshot): snapshot is MemberChangesSnapshot => !!snapshot);
        const aggregate = aggregateMemberChanges(collected);
        const selectedId = active.selectedMemberId
            ?? active.changeSet.members[0]?.memberId;
        const selectedSource = active.changeSet.members.find(member =>
            member.memberId === selectedId);
        const selectedSnapshot = selectedId
            ? active.snapshots.get(selectedId)
            : undefined;
        const state: ConversationChangesState = {
            kind: active.changeSet.kind,
            aggregate,
            members: active.changeSet.members.map(member =>
                memberView(member, active.snapshots.get(member.memberId))),
            ...(selectedId ? { selectedMemberId: selectedId } : {}),
            ...(selectedSource && selectedSnapshot
                ? { detail: detailView(selectedSource, selectedSnapshot) }
                : {}),
            collectedAt: this.now(),
        };
        this.state = state;
        void Promise.resolve(panel.webview.postMessage({
            type: 'conversation-viewer-changes',
            version: 1,
            subscriptionGeneration: active.generation,
            changes: state,
        }));
    }
}

function memberSource(member: WorktreeGroupMember): ChangesMemberSource {
    return {
        memberId: member.memberId,
        repoLabel: repoLabelFromKey(member.repositoryKey),
        branchName: member.branchName,
        worktreePath: member.worktreeKey!.canonicalWorktreePath,
        ...(member.baseline ? { baseline: member.baseline } : {}),
        ...(member.detached ? { detached: true } : {}),
    };
}

function memberView(
    member: ChangesMemberSource,
    snapshot: MemberChangesSnapshot | undefined
): ConversationChangesMemberView {
    return {
        memberId: member.memberId,
        repoLabel: member.repoLabel.slice(0, MAX_MEMBER_LABEL_LENGTH),
        branchName: member.branchName,
        worktreePath: member.worktreePath,
        availability: snapshot?.availability
            ?? (member.baseline ? 'unreadable' : 'baselineUnavailable'),
        workingItemCount: snapshot?.workingItemCount ?? 0,
        ...(snapshot?.aheadCount !== undefined
            ? { aheadCount: snapshot.aheadCount }
            : {}),
        truncated: snapshot?.truncated ?? false,
        ...(member.detached ? { detached: true } : {}),
    };
}

function detailView(
    member: ChangesMemberSource,
    snapshot: MemberChangesSnapshot
): ConversationChangesState['detail'] {
    return {
        memberId: member.memberId,
        availability: snapshot.availability,
        ...(member.baseline ? { baselineSha: member.baseline.commitSha } : {}),
        ...(snapshot.aheadCount !== undefined
            ? { aheadCount: snapshot.aheadCount }
            : {}),
        ...(snapshot.taskFileCount !== undefined
            ? { taskFileCount: snapshot.taskFileCount }
            : {}),
        items: snapshot.workingItems.map(item => ({ ...item })),
        truncated: snapshot.truncated,
    };
}

function repoLabelFromKey(repositoryKey: string): string {
    const segments = repositoryKey.replace(/[\\/]+$/u, '')
        .split(/[\\/]/u).filter(Boolean);
    let name = segments[segments.length - 1] || 'repository';
    if (name === '.git' && segments.length > 1) {
        name = segments[segments.length - 2];
    } else if (name.endsWith('.git')) {
        name = name.slice(0, -'.git'.length);
    }
    return name || 'repository';
}

function isContainedIn(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
