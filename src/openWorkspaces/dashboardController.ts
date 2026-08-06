'use strict';

import * as crypto from 'crypto';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { WorkspaceAiSessionViewModel } from '../aiSessions/types';
import { PREDEFINED_COLORS } from '../constants';
import type { Group, WorkspaceCardViewModel } from '../models';
import { buildOpenWorkspacesUpdatedMessage } from '../dashboard/webviewUpdateMessages';
import type { TodoSearchCatalogItem } from '../todos/types';
import { getWorkspaceAttentionSummary } from '../workspaces/attentionProjection';
import type { OpenWorkspace } from '../workspaces/types';
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

export interface OpenWorkspaceDashboardState {
    otherWindows: { status: OpenWorkspaceBridgeStatus };
}

export interface OpenWorkspaceDashboardControllerOptions {
    getCurrentWorkspace: () => OpenWorkspace | null;
    isWorkspaceSavedAsProject: (workspace: OpenWorkspace) => boolean;
    getWorkspaceProjectColor: (workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'>) => string;
    getWorkspaceProjectName?: (workspace: Pick<OpenWorkspace, 'kind' | 'navigationUri'>) => string;
    getCurrentWorkspaceAiSessions: (workspace: OpenWorkspace) => WorkspaceAiSessionViewModel | null;
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

export class OpenWorkspaceDashboardController {
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

    constructor(private readonly options: OpenWorkspaceDashboardControllerOptions) {
        this.fallbackOpenedAtMs = this.nowMs();
    }

    setAggregate(aggregate: OpenWorkspaceAggregate | null): boolean {
        if (aggregate?.semanticRevision === this.aggregate?.semanticRevision) { return false; }
        this.aggregate = aggregate;
        this.navigationWorkspacesById.clear();
        this.pinNavigationIdentityById.clear();
        return true;
    }

    setPinSnapshot(snapshot: OpenWorkspacePinSnapshot): boolean {
        const normalized = validateOpenWorkspacePinSnapshot(snapshot);
        if (normalized.revision === this.pinSnapshot.revision) { return false; }
        this.pinSnapshot = normalized;
        return true;
    }

    setBridgeStatus(status: OpenWorkspaceBridgeStatus): boolean {
        if (status === this.bridgeStatus) { return false; }
        this.bridgeStatus = status;
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

    getCards(): WorkspaceCardViewModel[] {
        const startedAt = this.nowMs();
        const currentWorkspace = this.options.getCurrentWorkspace();
        const attentionAggregate = this.options.getAttentionAggregate();
        const pinTimes = getOpenWorkspacePinTimes(this.pinSnapshot);
        const ownRegistration = this.aggregate?.registrations.find(
            registration => registration.instanceId === this.options.getBridgeInstanceId()
        );
        const currentNavigationIdentity = ownRegistration?.workspace?.navigationIdentity
            || currentWorkspace?.navigationIdentity
            || null;
        const currentCard = currentWorkspace
            ? this.createCurrentCard(
                currentWorkspace,
                attentionAggregate,
                currentNavigationIdentity || currentWorkspace.navigationIdentity,
                pinTimes.has(currentNavigationIdentity || currentWorkspace.navigationIdentity),
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
        const message = buildOpenWorkspacesUpdatedMessage({
            groups: this.options.getGroups(),
            cards: this.getCards(),
            collapsed: this.options.getCollapsed(),
            semanticRevision,
            otherWindowsStatus: this.bridgeStatus,
            todoSearchItems: this.options.getTodoSearchItems(),
            skills: this.options.getSkillRecords ? this.options.getSkillRecords() : [],
            runningCardAnimation: this.options.getRunningCardAnimation(),
            runningIconAnimation: this.options.getRunningIconAnimation(),
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
    }

    private createCurrentCard(
        workspace: OpenWorkspace,
        attentionAggregate: AttentionAggregate | null,
        navigationIdentity: string,
        pinned: boolean,
    ): WorkspaceCardViewModel {
        const digest = crypto.createHash('sha256').update(workspace.scopeIdentity).digest('hex').slice(0, 24);
        const aiSessions = this.options.getCurrentWorkspaceAiSessions(workspace) || undefined;
        return {
            id: `__currentWorkspace-${digest}`,
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
            attentionCount: getWorkspaceAttentionSummary(workspace, attentionAggregate).attentionCount,
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

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
