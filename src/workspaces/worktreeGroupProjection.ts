'use strict';

import type {
    ActiveAiSessionViewModel,
    AiSessionViewModel,
    ReadyWorktreeRow,
    WorktreeActivity,
    WorktreeAnchorViewModel,
    WorktreeGroupMemberStatus,
    WorktreeGroupMemberViewModel,
    WorktreeGroupRowViewModel,
    WorktreeRepositoryChip,
} from '../aiSessions/types';
import type { WorktreeGroup, WorktreeGroupMember } from '../worktrees/groupManifestStore';
import type {
    WorktreeGitSnapshot,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from '../worktrees/types';
import { worktreeKeysEqual } from '../worktrees/types';
import type { OpenWorkspace } from './types';
import {
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from './sessionAssignment';

/**
 * Manifest fallback for history identity (PRD §6.4): a session whose
 * worktree was deleted must keep its worktree identity in the history list —
 * display does not depend on the physical directory, and resume fails closed
 * on the retained key. Longest matching member path wins.
 */
export function findGroupMemberWorktreeKeyForPath(
    groups: readonly WorktreeGroup[],
    candidatePath: string
): WorktreeKey | null {
    const normalized = normalizeWorkspaceHostPath(candidatePath || '');
    if (!normalized) {
        return null;
    }
    let best: WorktreeKey | null = null;
    let bestLength = -1;
    for (const group of groups) {
        for (const member of group.members) {
            if (!member.worktreeKey) {
                continue;
            }
            const memberPath = normalizeWorkspaceHostPath(member.path);
            if (memberPath
                && memberPath.length > bestLength
                && isWorkspaceHostPathContained(memberPath, normalized)) {
                best = { ...member.worktreeKey };
                bestLength = memberPath.length;
            }
        }
    }
    return best;
}

/** Whether the authoritative manifest claims the given worktree key. */
export function manifestClaimsWorktreeKey(
    groups: readonly WorktreeGroup[],
    key: WorktreeKey
): boolean {
    return groups.some(group => group.members.some(member =>
        member.worktreeKey && worktreeKeysEqual(member.worktreeKey, key)));
}

export interface WorktreeGroupProjectionInput {
    workspace: OpenWorkspace;
    snapshot: WorktreeSnapshot | null | undefined;
    /** Authoritative manifest bucket for this workspace (PRD §5.2). */
    groups: readonly WorktreeGroup[];
    sessions: readonly AiSessionViewModel[];
    activeSessions: readonly ActiveAiSessionViewModel[];
}

export interface WorktreeGroupProjection {
    anchor: WorktreeAnchorViewModel;
    groups: WorktreeGroupRowViewModel[];
    /** Unclaimed linked worktrees (the Unmanaged section). */
    unmanaged: ReadyWorktreeRow[];
}

const ACTIVITY_ORDER: Record<WorktreeActivity, number> = {
    attention: 0,
    active: 1,
    idle: 2,
};

/**
 * Pure projection from the raw Git snapshot + the authoritative group
 * manifest to the Worktree tab's row model (docs/worktree-tasks-prd.md §10).
 * Manifest membership alone decides grouping; slugs only feed merge hints.
 */
export function buildWorktreeGroupProjection(
    input: WorktreeGroupProjectionInput
): WorktreeGroupProjection {
    const repositories = visibleRepositories(input.workspace, input.snapshot);
    const worktreeByKey = new Map<string, {
        repository: WorktreeRepositorySnapshot;
        worktree: WorktreeGitSnapshot;
    }>();
    for (const repository of repositories) {
        for (const worktree of repository.worktrees) {
            worktreeByKey.set(lookupKey(worktree.key), { repository, worktree });
        }
    }
    const repositoryLabels = buildRepositoryLabels(repositories);
    const chipUniverse = Array.from(new Set(repositoryLabels.values()));

    const anchorSessions: AiSessionViewModel[] = [];
    const anchorLive: ActiveAiSessionViewModel[] = [];
    const anchorEntries: { repositoryLabel: string; branch: string }[] = [];
    const anchorKeys: WorktreeKey[] = [];
    for (const repository of repositories) {
        for (const worktree of repository.worktrees) {
            if (!worktree.isMain || worktree.isBare) {
                continue;
            }
            anchorKeys.push({ ...worktree.key });
            anchorEntries.push({
                repositoryLabel: repositoryLabels.get(repository.repositoryKey) || 'repository',
                branch: shortBranchName(worktree),
            });
            anchorSessions.push(...sessionsOfWorktree(input.sessions, worktree.key));
            anchorLive.push(...liveSessionsOfWorktree(input.activeSessions, worktree.key));
        }
    }
    const anchor: WorktreeAnchorViewModel = {
        entries: anchorEntries,
        worktreeKeys: anchorKeys,
        sessions: anchorSessions,
        activity: aggregateActivity(anchorSessions, anchorLive),
    };

    const groupRows: WorktreeGroupRowViewModel[] = [];
    const claimedKeys = new Set<string>();
    for (const group of input.groups) {
        const members: WorktreeGroupMemberViewModel[] = [];
        const groupSessions: AiSessionViewModel[] = [];
        const groupLive: ActiveAiSessionViewModel[] = [];
        for (const member of group.members) {
            // Detached members (repository left the workspace) stay in the
            // manifest but off the row (PRD §7: 组行只显示可见 member).
            if (member.detached) {
                continue;
            }
            const visible = member.worktreeKey
                ? worktreeByKey.get(lookupKey(member.worktreeKey))
                : undefined;
            if (member.worktreeKey) {
                // Sessions keep their worktree identity even when the
                // physical worktree is gone (hydration manifest fallback),
                // so aggregate by the member key, not by snapshot visibility.
                claimedKeys.add(lookupKey(member.worktreeKey));
                groupSessions.push(...sessionsOfWorktree(input.sessions, member.worktreeKey));
                if (visible) {
                    groupLive.push(...liveSessionsOfWorktree(input.activeSessions, member.worktreeKey));
                }
            }
            members.push({
                memberId: member.memberId,
                repositoryKey: member.repositoryKey,
                repositoryLabel: repositoryLabels.get(member.repositoryKey)
                    || fallbackRepositoryLabel(member.repositoryKey),
                ...(member.worktreeKey ? { worktreeKey: { ...member.worktreeKey } } : {}),
                branchName: member.branchName,
                path: member.path,
                status: memberStatus(member, visible?.worktree),
                ...(member.lastError ? { errorCode: member.lastError } : {}),
                isPrimary: group.primaryMemberId === member.memberId,
            });
        }
        groupSessions.sort(compareSessions);
        // PRD §8: a failed or missing member needs attention just like an
        // unread session — otherwise a broken group looks healthy.
        const memberIssue = members.some(member =>
            member.status === 'failed' || member.status === 'missing');
        // Creation capability follows the *projected* primary status, never
        // the manifest state and never a silent fallback to another member:
        // a missing/detached/failed primary means the user must explicitly
        // choose a new one (PRD §4.2).
        const primaryReady = !!group.primaryMemberId
            && members.some(member =>
                member.memberId === group.primaryMemberId && member.status === 'ready');
        const hasReadyMember = members.some(member => member.status === 'ready');
        if (members.length === 0) {
            // Every member is detached (their repositories left the
            // workspace): the manifest record survives for automatic
            // re-attachment, but a memberless row is a blank ghost (PRD §7:
            // 组行只显示可见 member).
            continue;
        }
        groupRows.push({
            kind: 'group',
            groupId: group.groupId,
            displayName: group.displayName,
            activity: memberIssue
                ? 'attention'
                : aggregateActivity(groupSessions, groupLive),
            sessions: groupSessions,
            members,
            chips: buildChips(members.map(member => member.repositoryLabel), chipUniverse),
            hasDetachedMembers: group.members.some(member => !!member.detached),
            needsPrimarySelection: !primaryReady && hasReadyMember,
            canCreateSession: primaryReady,
            mergeCandidateGroupIds: [],
        });
    }

    // Merge hints are the only use of slugs in the projection: groups that
    // share a suggested slug are offered to merge, never merged silently.
    const groupsBySlug = new Map<string, string[]>();
    for (const group of input.groups) {
        const bucket = groupsBySlug.get(group.suggestedSlug) || [];
        bucket.push(group.groupId);
        groupsBySlug.set(group.suggestedSlug, bucket);
    }
    for (const row of groupRows) {
        const group = input.groups.find(candidate => candidate.groupId === row.groupId)!;
        row.mergeCandidateGroupIds = (groupsBySlug.get(group.suggestedSlug) || [])
            .filter(candidateId => candidateId !== row.groupId);
    }

    // Stable disambiguation for colliding display names (PRD §10): show the
    // primary branch short name, never a volatile status or timestamp.
    const nameCounts = new Map<string, number>();
    for (const row of groupRows) {
        const key = row.displayName.toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    for (const row of groupRows) {
        if ((nameCounts.get(row.displayName.toLowerCase()) || 0) > 1) {
            const primary = row.members.find(member => member.isPrimary) || row.members[0];
            row.discriminator = shortBranchLabel(primary?.branchName || row.groupId.slice(0, 8));
        }
    }

    groupRows.sort((left, right) =>
        ACTIVITY_ORDER[left.activity] - ACTIVITY_ORDER[right.activity]
        || createdAtOf(input.groups, right.groupId) - createdAtOf(input.groups, left.groupId)
        || left.displayName.localeCompare(right.displayName));

    const unmanaged: ReadyWorktreeRow[] = [];
    for (const repository of repositories) {
        for (const worktree of repository.worktrees) {
            if (worktree.isMain || worktree.isBare
                || claimedKeys.has(lookupKey(worktree.key))) {
                continue;
            }
            unmanaged.push(buildReadyRow(worktree, input.sessions, input.activeSessions));
        }
    }

    return { anchor, groups: groupRows, unmanaged };
}

function visibleRepositories(
    workspace: OpenWorkspace,
    snapshot: WorktreeSnapshot | null | undefined
): WorktreeRepositorySnapshot[] {
    if (!snapshot) {
        return [];
    }
    const workspaceRootIds = new Set(workspace.roots.map(root => root.id));
    return snapshot.repositories.filter(repository =>
        repository.rootBindings.some(binding => workspaceRootIds.has(binding.workspaceRootId)));
}

function memberStatus(
    member: WorktreeGroupMember,
    visible: WorktreeGitSnapshot | undefined
): WorktreeGroupMemberStatus {
    if (member.detached) {
        return 'detached';
    }
    if (member.state === 'failed') {
        return 'failed';
    }
    if (member.state !== 'ready') {
        return 'pending';
    }
    if (!visible || visible.health === 'missing' || visible.health === 'prunable') {
        return 'missing';
    }
    return 'ready';
}

function buildReadyRow(
    worktree: WorktreeGitSnapshot,
    sessions: readonly AiSessionViewModel[],
    activeSessions: readonly ActiveAiSessionViewModel[]
): ReadyWorktreeRow {
    const worktreeSessions = sessionsOfWorktree(sessions, worktree.key);
    const liveSessions = liveSessionsOfWorktree(activeSessions, worktree.key);
    const usable = worktree.health !== 'missing' && worktree.health !== 'prunable';
    return {
        kind: 'ready',
        git: { ...worktree, key: { ...worktree.key } },
        activity: aggregateActivity(worktreeSessions, liveSessions),
        sessions: worktreeSessions,
        authority: {
            canInput: liveSessions.length > 0,
            canFocus: liveSessions.length > 0,
            canStop: liveSessions.length > 0,
            canResume: usable,
            canArchive: worktreeSessions.length > 0,
            canRemove: usable,
            canTakeControl: false,
            liveOwnerAvailable: liveSessions.length > 0,
        },
    };
}

function sessionsOfWorktree(
    sessions: readonly AiSessionViewModel[],
    key: WorktreeKey
): AiSessionViewModel[] {
    return sessions.filter(session => !!session.worktreeKey
        && worktreeKeysEqual(session.worktreeKey, key));
}

function liveSessionsOfWorktree(
    activeSessions: readonly ActiveAiSessionViewModel[],
    key: WorktreeKey
): ActiveAiSessionViewModel[] {
    return activeSessions.filter(session => !!session.worktreeKey
        && worktreeKeysEqual(session.worktreeKey, key));
}

function aggregateActivity(
    sessions: readonly AiSessionViewModel[],
    liveSessions: readonly ActiveAiSessionViewModel[]
): WorktreeActivity {
    if (sessions.some(session => session.attention?.unread)
        || liveSessions.some(session => session.needsAttention)) {
        return 'attention';
    }
    return liveSessions.length > 0 ? 'active' : 'idle';
}

function compareSessions(
    left: AiSessionViewModel,
    right: AiSessionViewModel
): number {
    const leftAttention = left.attention?.unread ? 0 : 1;
    const rightAttention = right.attention?.unread ? 0 : 1;
    return leftAttention - rightAttention;
}

function createdAtOf(groups: readonly WorktreeGroup[], groupId: string): number {
    return groups.find(group => group.groupId === groupId)?.createdAt || 0;
}

function lookupKey(key: WorktreeKey): string {
    return `${key.repositoryKey}::${key.canonicalWorktreePath}`;
}

/**
 * Shortest prefix that is unique among all visible workspace repositories
 * (PRD §10), so `agent-pivot` / `agent-platform` never collapse onto the
 * same chip even when a group contains only one of them.
 */
export function buildChips(
    labels: readonly string[],
    universe: readonly string[]
): WorktreeRepositoryChip[] {
    const distinct = Array.from(new Set(universe));
    return labels.map(label => {
        let length = 1;
        while (length < label.length && distinct.some(other => other !== label
            && other.slice(0, length).toLowerCase() === label.slice(0, length).toLowerCase())) {
            length += 1;
        }
        return { label: label.slice(0, length), title: label };
    });
}

function buildRepositoryLabels(
    repositories: readonly WorktreeRepositorySnapshot[]
): Map<string, string> {
    const labels = new Map<string, string>();
    for (const repository of repositories) {
        labels.set(repository.repositoryKey,
            fallbackRepositoryLabel(repository.repositoryKey));
    }
    return labels;
}

export function fallbackRepositoryLabel(repositoryKey: string): string {
    const normalized = repositoryKey.replace(/[\\/]+$/, '');
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    let name = segments[segments.length - 1] || 'repository';
    if (name === '.git' && segments.length > 1) {
        name = segments[segments.length - 2];
    } else if (name.endsWith('.git')) {
        name = name.slice(0, -'.git'.length);
    }
    return name || 'repository';
}

function shortBranchName(worktree: WorktreeGitSnapshot): string {
    return shortBranchLabel(worktree.branchRef || '') || worktree.head.substring(0, 8) || 'detached';
}

export function shortBranchLabel(branchRef: string): string {
    return branchRef.replace(/^refs\/heads\//, '');
}
