'use strict';

import * as crypto from 'crypto';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { WorkspaceCardViewModel } from '../models';
import { getWorkspaceAttentionSummary } from '../workspaces/attentionProjection';
import type { OpenWorkspace, OpenWorkspaceEnvironment } from '../workspaces/types';
import {
    OpenWorkspaceAggregateV5,
    OpenWorkspaceRecord,
    validateOpenWorkspaceRecord,
} from './protocol';

interface NavigationCandidate {
    instanceId: string;
    openedAtMs: number;
    lastFocusedAtMs: number;
    pinnedAtMs: number | null;
    workspace: OpenWorkspaceRecord;
}

export interface OpenWorkspaceNavigationCardProjection {
    card: WorkspaceCardViewModel;
    workspace: OpenWorkspaceRecord;
    openedAtMs: number;
    pinnedAtMs: number | null;
}

export interface OpenWorkspaceCardOrder {
    navigationIdentity: string;
    openedAtMs: number;
    pinnedAtMs: number | null;
}

export function getLogicalWorkspaceOpenedAtMs(
    aggregate: OpenWorkspaceAggregateV5 | null,
    navigationIdentity: string,
): number | null {
    let openedAtMs: number | null = null;
    for (const registration of aggregate?.registrations || []) {
        if (registration.workspace?.navigationIdentity !== navigationIdentity) {
            continue;
        }
        openedAtMs = openedAtMs === null
            ? registration.openedAtMs
            : Math.min(openedAtMs, registration.openedAtMs);
    }
    return openedAtMs;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function createWorkspaceDescriptorKey(workspace: OpenWorkspaceRecord): string {
    return JSON.stringify([
        workspace.navigationIdentity,
        workspace.scopeIdentity,
        workspace.kind,
        workspace.displayName,
        workspace.navigationUri,
        workspace.environment,
        workspace.roots
            .map(root => [root.id, root.name, root.uri, root.ordinal])
            .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
    ]);
}

function candidateWins(candidate: NavigationCandidate, previous: NavigationCandidate): boolean {
    if (candidate.lastFocusedAtMs !== previous.lastFocusedAtMs) {
        return candidate.lastFocusedAtMs > previous.lastFocusedAtMs;
    }
    const instanceComparison = compareText(candidate.instanceId, previous.instanceId);
    if (instanceComparison !== 0) {
        return instanceComparison < 0;
    }
    return compareText(
        createWorkspaceDescriptorKey(candidate.workspace),
        createWorkspaceDescriptorKey(previous.workspace)
    ) < 0;
}

export function compareOpenWorkspaceCardOrder(
    left: OpenWorkspaceCardOrder,
    right: OpenWorkspaceCardOrder,
): number {
    if (left.pinnedAtMs !== null || right.pinnedAtMs !== null) {
        if (left.pinnedAtMs === null) {
            return 1;
        }
        if (right.pinnedAtMs === null) {
            return -1;
        }
        if (left.pinnedAtMs !== right.pinnedAtMs) {
            return left.pinnedAtMs < right.pinnedAtMs ? -1 : 1;
        }
        return compareText(left.navigationIdentity, right.navigationIdentity);
    }
    if (left.openedAtMs !== right.openedAtMs) {
        return left.openedAtMs < right.openedAtMs ? -1 : 1;
    }
    return compareText(left.navigationIdentity, right.navigationIdentity);
}

function compareCandidates(left: NavigationCandidate, right: NavigationCandidate): number {
    return compareOpenWorkspaceCardOrder({
        navigationIdentity: left.workspace.navigationIdentity,
        openedAtMs: left.openedAtMs,
        pinnedAtMs: left.pinnedAtMs,
    }, {
        navigationIdentity: right.workspace.navigationIdentity,
        openedAtMs: right.openedAtMs,
        pinnedAtMs: right.pinnedAtMs,
    });
}

function getEnvironmentLabel(environment: OpenWorkspaceEnvironment): string {
    switch (environment) {
        case 'ssh':
            return 'SSH';
        case 'wsl':
            return 'WSL';
        case 'devContainer':
            return 'Dev Container';
        case 'remote':
            return 'Remote';
        case 'local':
        default:
            return 'Local';
    }
}

export function sumOpenWorkspaceRunningAiSessionCounts(
    aggregate: OpenWorkspaceAggregateV5 | null,
): number {
    return getOpenWorkspaceRunningAiSessionKeys(aggregate).length;
}

/** The opaque logical-session tokens currently executing across every open window. */
export function getOpenWorkspaceRunningAiSessionKeys(
    aggregate: OpenWorkspaceAggregateV5 | null,
    excludedInstanceId = '',
): string[] {
    const keys = new Set<string>();
    for (const registration of aggregate?.registrations || []) {
        if (registration.instanceId === excludedInstanceId) {
            continue;
        }
        for (const key of registration.workspace?.runningAiSessionKeys || []) {
            keys.add(key);
        }
    }
    return Array.from(keys).sort();
}

function mergeWorkspaceRunningSessions(
    preferred: OpenWorkspaceRecord,
    other: OpenWorkspaceRecord,
): OpenWorkspaceRecord {
    const runningAiSessionKeys = Array.from(new Set([
        ...preferred.runningAiSessionKeys,
        ...other.runningAiSessionKeys,
    ])).sort();
    return {
        ...preferred,
        runningAiSessionCount: runningAiSessionKeys.length,
        runningAiSessionKeys,
    };
}

export function createOpenWorkspacePublication(
    workspace: OpenWorkspace | null,
    runningAiSessionCount = 0,
    runningAiSessionKeys: readonly string[] = [],
): OpenWorkspaceRecord | null {
    if (!workspace) {
        return null;
    }
    return validateOpenWorkspaceRecord({
        navigationIdentity: workspace.navigationIdentity,
        scopeIdentity: workspace.scopeIdentity,
        kind: workspace.kind,
        displayName: workspace.displayName,
        navigationUri: workspace.navigationUri,
        environment: workspace.environment,
        runningAiSessionCount,
        runningAiSessionKeys: Array.from(new Set(runningAiSessionKeys)).sort(),
        roots: (workspace.roots || []).map(root => ({
            id: root.id,
            name: root.name,
            uri: root.uri,
            ordinal: root.ordinal,
        })),
    });
}

function createNavigationCard(
    candidate: NavigationCandidate,
    attentionAggregate: AttentionAggregate | null
): WorkspaceCardViewModel {
    const workspace = candidate.workspace;
    const digest = crypto.createHash('sha256').update(workspace.navigationIdentity).digest('hex').slice(0, 24);
    return {
        id: `__openWorkspaceNavigation-${digest}`,
        kind: 'navigation',
        workspaceKind: workspace.kind,
        showSaveAction: false,
        pinned: candidate.pinnedAtMs !== null,
        runningSessionCount: workspace.runningAiSessionCount,
        navigationIdentity: workspace.navigationIdentity,
        scopeIdentity: workspace.scopeIdentity,
        name: workspace.displayName,
        environment: workspace.environment,
        environmentLabel: getEnvironmentLabel(workspace.environment),
        roots: workspace.roots
            .slice()
            .sort((left, right) => left.ordinal - right.ordinal || compareText(left.id, right.id))
            .map(root => ({ id: root.id, name: root.name, ordinal: root.ordinal })),
        attentionCount: getWorkspaceAttentionSummary(workspace, attentionAggregate).attentionCount,
    };
}

export function projectOpenWorkspaceCards(
    currentWorkspace: Pick<OpenWorkspace, 'navigationIdentity'> | null,
    aggregate: OpenWorkspaceAggregateV5 | null,
    ownInstanceId: string,
    attentionAggregate: AttentionAggregate | null = null,
    pinTimes: ReadonlyMap<string, number> = new Map(),
): WorkspaceCardViewModel[] {
    return projectOpenWorkspaceNavigationCards(
        currentWorkspace,
        aggregate,
        ownInstanceId,
        attentionAggregate,
        pinTimes,
    ).map(projection => projection.card);
}

export function projectOpenWorkspaceNavigationCards(
    currentWorkspace: Pick<OpenWorkspace, 'navigationIdentity'> | null,
    aggregate: OpenWorkspaceAggregateV5 | null,
    ownInstanceId: string,
    attentionAggregate: AttentionAggregate | null = null,
    pinTimes: ReadonlyMap<string, number> = new Map(),
): OpenWorkspaceNavigationCardProjection[] {
    if (!aggregate) {
        return [];
    }
    const reservedIdentity = currentWorkspace?.navigationIdentity || '';
    const navigationByIdentity = new Map<string, NavigationCandidate>();
    for (const registration of aggregate.registrations || []) {
        if (registration.instanceId === ownInstanceId || !registration.workspace) {
            continue;
        }
        const workspace = registration.workspace;
        if (workspace.navigationIdentity === reservedIdentity) {
            continue;
        }
        const candidate: NavigationCandidate = {
            instanceId: registration.instanceId,
            openedAtMs: registration.openedAtMs,
            lastFocusedAtMs: registration.lastFocusedAtMs,
            pinnedAtMs: pinTimes.get(workspace.navigationIdentity) ?? null,
            workspace,
        };
        const previous = navigationByIdentity.get(workspace.navigationIdentity);
        if (!previous) {
            navigationByIdentity.set(workspace.navigationIdentity, candidate);
            continue;
        }
        const openedAtMs = Math.min(previous.openedAtMs, candidate.openedAtMs);
        if (candidateWins(candidate, previous)) {
            navigationByIdentity.set(workspace.navigationIdentity, {
                ...candidate,
                openedAtMs,
                workspace: mergeWorkspaceRunningSessions(candidate.workspace, previous.workspace),
            });
        } else {
            navigationByIdentity.set(workspace.navigationIdentity, {
                ...previous,
                openedAtMs,
                workspace: mergeWorkspaceRunningSessions(previous.workspace, candidate.workspace),
            });
        }
    }
    return Array.from(navigationByIdentity.values())
        .sort(compareCandidates)
        .map(candidate => ({
            card: createNavigationCard(candidate, attentionAggregate),
            workspace: candidate.workspace,
            openedAtMs: candidate.openedAtMs,
            pinnedAtMs: candidate.pinnedAtMs,
        }));
}
