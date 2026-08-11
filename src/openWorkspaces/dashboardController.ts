'use strict';

import * as crypto from 'crypto';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { WorkspaceAiSessionViewModel } from '../aiSessions/types';
import {
    buildAiSessionPresentationState,
    getRenderedCurrentWorkspaceNavigationIdentity,
} from '../aiSessions/presentationMessage';
import { PREDEFINED_COLORS } from '../constants';
import type { Group, WorkspaceCardViewModel } from '../models';
import { buildOpenWorkspacesUpdatedMessage } from '../dashboard/webviewUpdateMessages';
import type { TodoSearchCatalogItem } from '../todos/types';
import type { OpenWorkspace } from '../workspaces/types';
import type {
    AiSessionPresentationTransaction,
    AiSessionProjectionSnapshot,
} from '../workspaces/sessionHydrationController';
import {
    CurrentWorkspaceSessionAuthority,
} from '../workspaces/currentWorkspaceSessionAuthority';
import type { OpenWorkspaceBridgeStatus } from './bridgeClient';
import {
    compareOpenWorkspaceCardOrder,
    getLogicalWorkspaceOpenedAtMs,
    projectOpenWorkspaceNavigationCards,
} from './projection';
import type { OpenWorkspaceAggregate, OpenWorkspaceRecord } from './protocol';
import {
    createOpenWorkspacePinSnapshot,
    getOpenWorkspacePinTimes,
    OpenWorkspacePinSnapshot,
    validateOpenWorkspacePinSnapshot,
} from './pinProtocol';

const CARD_PROJECTION_BURST_TTL_MS = 100;

export interface OpenWorkspaceDashboardState {
    otherWindows: { status: OpenWorkspaceBridgeStatus };
}

export interface OpenWorkspaceDashboardControllerOptions<TTerminal = unknown> {
    getCurrentWorkspace: () => OpenWorkspace | null;
    isWorkspaceSavedAsProject: (workspace: OpenWorkspace) => boolean;
    getWorkspaceProjectColor: (workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'>) => string;
    getWorkspaceProjectName?: (workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'>) => string;
    getCurrentWorkspaceAiSessions: (
        workspace: OpenWorkspace,
        projection?: AiSessionProjectionSnapshot<TTerminal>
    ) => WorkspaceAiSessionViewModel | null;
    getCurrentWorkspaceSessionProjectId?: (
        identity: {
            workspaceNavigationIdentity: string;
            workspaceScopeIdentity: string;
        }
    ) => string;
    getAiSessionProjectionRevision?: () => number;
    beginAiSessionProjection: () => AiSessionPresentationTransaction<TTerminal>;
    getGroups: () => Group[];
    getTodoSearchItems: () => TodoSearchCatalogItem[];
    getSkillRecords?: () => import('../skills/types').SkillRecord[];
    getCollapsed: () => boolean;
    getRunningCardAnimation: () => string | undefined;
    getRunningIconAnimation: () => string | undefined;
    getAttentionAggregate: () => AttentionAggregate | null;
    getBridgeInstanceId: () => string;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: (reason: string) => void;
    isVisible: () => boolean;
    logDiagnostic: (source: string, event: Record<string, unknown>) => void;
    logError: (message: string, error: unknown) => void;
    nowMs?: () => number;
}

export class OpenWorkspaceDashboardController<TTerminal = unknown> {
    private aggregate: OpenWorkspaceAggregate | null = null;
    private pinSnapshot: OpenWorkspacePinSnapshot = createOpenWorkspacePinSnapshot([]);
    private bridgeStatus: OpenWorkspaceBridgeStatus = 'connecting';
    private navigationWorkspacesById = new Map<string, OpenWorkspaceRecord>();
    private pinNavigationIdentityById = new Map<string, string>();
    private lastPostedSemanticRevision: string | null = null;
    private deliveryGeneration = 0;
    private updateFlight: Promise<void> | null = null;
    private updateRequested = false;
    private requestedFallbackToFullRefresh = true;
    private readonly fallbackOpenedAtMs: number;
    private cachedCards: WorkspaceCardViewModel[] | null = null;
    private cachedCardsKey: string | null = null;
    private cachedCardsExpiresAtMs = 0;
    private readonly fallbackCurrentWorkspaceSessionAuthority =
        new CurrentWorkspaceSessionAuthority();

    constructor(private readonly options: OpenWorkspaceDashboardControllerOptions<TTerminal>) {
        this.fallbackOpenedAtMs = this.nowMs();
    }

    setAggregate(aggregate: OpenWorkspaceAggregate | null): boolean {
        if (aggregate?.semanticRevision === this.aggregate?.semanticRevision) { return false; }
        this.aggregate = aggregate;
        this.invalidateCardProjection();
        this.navigationWorkspacesById.clear();
        this.pinNavigationIdentityById.clear();
        return true;
    }

    setPinSnapshot(snapshot: OpenWorkspacePinSnapshot): boolean {
        const normalized = validateOpenWorkspacePinSnapshot(snapshot);
        if (normalized.revision === this.pinSnapshot.revision) { return false; }
        this.pinSnapshot = normalized;
        this.invalidateCardProjection();
        return true;
    }

    setBridgeStatus(status: OpenWorkspaceBridgeStatus): boolean {
        if (status === this.bridgeStatus) { return false; }
        this.bridgeStatus = status;
        this.invalidateCardProjection();
        if (status !== 'ready') {
            this.aggregate = null;
            this.navigationWorkspacesById.clear();
            this.pinNavigationIdentityById.clear();
        }
        return true;
    }

    getState(): OpenWorkspaceDashboardState {
        return { otherWindows: { status: this.bridgeStatus } };
    }

    getNavigationWorkspace(cardId: string): OpenWorkspaceRecord | null {
        return this.navigationWorkspacesById.get(cardId) || null;
    }

    getPinNavigationIdentity(cardId: string): string | null {
        return this.pinNavigationIdentityById.get(cardId) || null;
    }

    getCurrentRenderedWorkspaceNavigationIdentity(): string | null {
        const currentWorkspace = this.options.getCurrentWorkspace();
        if (!currentWorkspace) { return null; }
        const ownRegistration = this.aggregate?.registrations.find(
            registration => registration.instanceId === this.options.getBridgeInstanceId()
        );
        return ownRegistration?.workspace?.navigationIdentity
            || currentWorkspace.navigationIdentity;
    }

    getCards(
        projection?: AiSessionProjectionSnapshot<TTerminal>
    ): WorkspaceCardViewModel[] {
        const startedAt = this.nowMs();
        const currentWorkspace = this.options.getCurrentWorkspace();
        const attentionAggregate = this.options.getAttentionAggregate();
        const cacheKey = this.getCardProjectionCacheKey(
            currentWorkspace,
            attentionAggregate,
            projection?.revision,
        );
        if (this.cachedCards
            && cacheKey === this.cachedCardsKey
            && startedAt < this.cachedCardsExpiresAtMs) {
            return this.cachedCards;
        }
        const pinTimes = getOpenWorkspacePinTimes(this.pinSnapshot);
        const currentNavigationIdentity =
            this.getCurrentRenderedWorkspaceNavigationIdentity();
        const currentCard = currentWorkspace
            ? this.createCurrentCard(
                currentWorkspace,
                currentNavigationIdentity || currentWorkspace.navigationIdentity,
                pinTimes.has(currentNavigationIdentity || currentWorkspace.navigationIdentity),
                projection,
            )
            : null;
        const navigationProjections = projectOpenWorkspaceNavigationCards(
            currentNavigationIdentity ? { navigationIdentity: currentNavigationIdentity } : null,
            this.aggregate,
            this.options.getBridgeInstanceId(),
            attentionAggregate,
            pinTimes,
        );
        this.navigationWorkspacesById = new Map(navigationProjections.map(projection => [
            projection.card.id,
            projection.workspace,
        ]));
        const navigationCards = navigationProjections.map(projection => ({
            card: {
                ...projection.card,
                name: this.getWorkspaceProjectName(projection.workspace) || projection.card.name,
                color: this.getWorkspaceCardColor(projection.workspace),
            },
            openedAtMs: projection.openedAtMs,
            pinnedAtMs: projection.pinnedAtMs,
        }));
        const orderedCards = [
            ...(currentCard ? [{
                card: currentCard,
                openedAtMs: getLogicalWorkspaceOpenedAtMs(
                    this.aggregate,
                    currentCard.navigationIdentity,
                ) ?? this.fallbackOpenedAtMs,
                pinnedAtMs: pinTimes.get(currentCard.navigationIdentity) ?? null,
            }] : []),
            ...navigationCards,
        ].sort((left, right) => compareOpenWorkspaceCardOrder({
            navigationIdentity: left.card.navigationIdentity,
            openedAtMs: left.openedAtMs,
            pinnedAtMs: left.pinnedAtMs,
        }, {
            navigationIdentity: right.card.navigationIdentity,
            openedAtMs: right.openedAtMs,
            pinnedAtMs: right.pinnedAtMs,
        }));
        const cards = orderedCards.map(entry => entry.card);
        this.pinNavigationIdentityById = new Map(cards.map(card => [
            card.id,
            card.navigationIdentity,
        ]));
        this.options.logDiagnostic('Renderer', {
            event: 'open-workspace-cards-build',
            durationMs: this.nowMs() - startedAt,
            currentWorkspaceCount: currentCard ? 1 : 0,
            navigationWorkspaceCount: navigationCards.length,
            semanticRevision: this.aggregate?.semanticRevision || null,
        });
        this.cachedCards = cards;
        this.cachedCardsKey = cacheKey;
        this.cachedCardsExpiresAtMs = startedAt + CARD_PROJECTION_BURST_TTL_MS;
        return cards;
    }

    postUpdated(options: { fallbackToFullRefresh?: boolean } = {}): Promise<void> {
        if (!this.options.isVisible()) { return Promise.resolve(); }
        this.updateRequested = true;
        this.requestedFallbackToFullRefresh = options.fallbackToFullRefresh !== false;
        if (this.updateFlight) { return this.updateFlight; }

        let resolveFlight: () => void;
        let rejectFlight: (error: unknown) => void;
        const flight = new Promise<void>((resolve, reject) => {
            resolveFlight = resolve;
            rejectFlight = reject;
        });
        this.updateFlight = flight;
        void this.drainUpdates(flight, resolveFlight, rejectFlight);
        return flight;
    }

    private async drainUpdates(
        flight: Promise<void>,
        resolveFlight: () => void,
        rejectFlight: (error: unknown) => void,
    ): Promise<void> {
        try {
            while (this.updateRequested) {
                this.updateRequested = false;
                const fallbackToFullRefresh = this.requestedFallbackToFullRefresh;
                await this.postLatestUpdate(fallbackToFullRefresh);
            }
            if (this.updateFlight === flight) { this.updateFlight = null; }
            resolveFlight();
        } catch (error) {
            if (this.updateFlight === flight) { this.updateFlight = null; }
            rejectFlight(error);
        }
    }

    private postLatestUpdate(fallbackToFullRefresh: boolean): Promise<void> {
        if (!this.options.isVisible()) { return Promise.resolve(); }
        const semanticRevision = this.getViewSemanticRevision();
        if (semanticRevision === this.lastPostedSemanticRevision) { return Promise.resolve(); }
        const projection = this.options.beginAiSessionProjection();
        const runningCardAnimation = this.options.getRunningCardAnimation();
        const runningIconAnimation = this.options.getRunningIconAnimation();
        const cards = this.getCards(projection);
        const message = buildOpenWorkspacesUpdatedMessage({
            groups: this.options.getGroups(),
            cards,
            collapsed: this.options.getCollapsed(),
            semanticRevision,
            projectionRevision: projection.revision,
            otherWindowsStatus: this.bridgeStatus,
            todoSearchItems: this.options.getTodoSearchItems(),
            skills: this.options.getSkillRecords ? this.options.getSkillRecords() : [],
            runningCardAnimation,
            runningIconAnimation,
            presentation: buildAiSessionPresentationState(
                false,
                projection,
                getRenderedCurrentWorkspaceNavigationIdentity(cards),
                runningCardAnimation,
                runningIconAnimation,
            ),
        });
        this.lastPostedSemanticRevision = message.semanticRevision;
        const deliveryGeneration = this.deliveryGeneration;
        return Promise.resolve(this.options.postMessage(message)).then(delivered => {
            if (!delivered) {
                const current = this.clearPostedSemanticRevision(
                    message.semanticRevision,
                    deliveryGeneration
                );
                if (current && !this.updateRequested && fallbackToFullRefresh
                    && this.options.isVisible()) {
                    this.options.refresh('open-workspace-update-not-delivered');
                }
            }
        }, error => {
            const current = this.clearPostedSemanticRevision(
                message.semanticRevision,
                deliveryGeneration
            );
            this.options.logError('Failed to post OPEN WORKSPACE update message.', error);
            if (current && !this.updateRequested && fallbackToFullRefresh
                && this.options.isVisible()) {
                this.options.refresh('open-workspace-update-post-error');
            }
        });
    }

    invalidatePendingUpdates(): void {
        this.deliveryGeneration += 1;
        this.lastPostedSemanticRevision = null;
        this.invalidateCardProjection();
    }

    private createCurrentCard(
        workspace: OpenWorkspace,
        navigationIdentity: string,
        pinned: boolean,
        projection?: AiSessionProjectionSnapshot<TTerminal>,
    ): WorkspaceCardViewModel {
        const projectId = (
            this.options.getCurrentWorkspaceSessionProjectId
            || (identity => this.fallbackCurrentWorkspaceSessionAuthority
                .getProjectId(identity))
        )({
            workspaceNavigationIdentity: navigationIdentity,
            workspaceScopeIdentity: workspace.scopeIdentity,
        });
        const aiSessions = this.options.getCurrentWorkspaceAiSessions(
            workspace,
            projection
        ) || undefined;
        return {
            id: projectId,
            kind: 'current',
            workspaceKind: workspace.kind,
            showSaveAction: workspace.kind === 'untitledMultiRoot'
                || !this.options.isWorkspaceSavedAsProject(workspace),
            pinned,
            runningSessionCount: (aiSessions?.activeSessions || [])
                .filter(session => session.executionState === 'running').length,
            navigationIdentity,
            scopeIdentity: workspace.scopeIdentity,
            name: this.getWorkspaceProjectName(workspace) || workspace.displayName,
            environment: workspace.environment,
            environmentLabel: this.getEnvironmentLabel(workspace.environment),
            color: this.getWorkspaceCardColor(workspace),
            roots: workspace.roots
                .slice()
                .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
                .map(root => ({ id: root.id, name: root.name, ordinal: root.ordinal })),
            aiSessions,
            attentionCount: aiSessions?.attentionCount || 0,
        };
    }

    private getEnvironmentLabel(environment: OpenWorkspace['environment']): string {
        switch (environment) {
            case 'ssh': return 'SSH';
            case 'wsl': return 'WSL';
            case 'devContainer': return 'Dev Container';
            case 'remote': return 'Remote';
            case 'local':
            default: return 'Local';
        }
    }

    private getWorkspaceProjectName(
        workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'>,
    ): string {
        if (!this.options.getWorkspaceProjectName) { return ''; }
        const name = this.options.getWorkspaceProjectName(workspace);
        return name && name.trim() ? name : '';
    }

    private getWorkspaceCardColor(
        workspace: Pick<OpenWorkspace, 'kind' | 'navigationIdentity' | 'navigationUri'>
    ): string {
        const projectColor = this.options.getWorkspaceProjectColor(workspace);
        if (projectColor?.trim()) {
            return projectColor;
        }
        const digest = crypto.createHash('sha256')
            .update(workspace.navigationIdentity)
            .digest();
        return PREDEFINED_COLORS[digest.readUInt32BE(0) % PREDEFINED_COLORS.length].value;
    }

    private clearPostedSemanticRevision(
        semanticRevision: string,
        deliveryGeneration: number
    ): boolean {
        if (this.lastPostedSemanticRevision === semanticRevision
            && this.deliveryGeneration === deliveryGeneration) {
            this.lastPostedSemanticRevision = null;
            return true;
        }
        return false;
    }

    private getViewSemanticRevision(): string {
        return crypto.createHash('sha256').update(JSON.stringify([
            this.bridgeStatus,
            this.aggregate?.semanticRevision || null,
            this.pinSnapshot.revision,
            this.options.getAttentionAggregate()?.aggregateRevision || null,
            this.options.getRunningCardAnimation(),
            this.options.getRunningIconAnimation(),
            this.options.getGroups(),
            this.options.getTodoSearchItems(),
        ])).digest('hex');
    }

    private invalidateCardProjection(): void {
        this.cachedCards = null;
        this.cachedCardsKey = null;
        this.cachedCardsExpiresAtMs = 0;
    }

    private getCardProjectionCacheKey(
        workspace: OpenWorkspace | null,
        attentionAggregate: AttentionAggregate | null,
        projectionRevision?: number,
    ): string {
        return JSON.stringify([
            this.bridgeStatus,
            this.aggregate?.semanticRevision || null,
            this.pinSnapshot.revision,
            attentionAggregate?.aggregateRevision || null,
            projectionRevision
                ?? this.options.getAiSessionProjectionRevision?.()
                ?? null,
            workspace ? {
                navigationIdentity: workspace.navigationIdentity,
                scopeIdentity: workspace.scopeIdentity,
                kind: workspace.kind,
                displayName: workspace.displayName,
                navigationUri: workspace.navigationUri,
                environment: workspace.environment,
                roots: workspace.roots.map(root => [
                    root.id,
                    root.name,
                    root.uri,
                    root.hostPath,
                    root.ordinal,
                ]),
                saved: this.options.isWorkspaceSavedAsProject(workspace),
            } : null,
        ]);
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
