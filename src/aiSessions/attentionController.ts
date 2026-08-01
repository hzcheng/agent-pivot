'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { AttentionAggregate } from './attentionAggregate';
import {
    aggregateAttentionSnapshots,
    filterAcknowledgedAttentionAggregate,
    filterLocallyClearedAttentionAggregate,
} from './attentionAggregate';
import { MAX_ATTENTION_ITEMS } from './attentionPayload';
import type { AttentionPayloadItem } from './attentionPayload';
import AiSessionAttentionMonitor from './attentionMonitor';
import type { AiSessionAttentionEvent, AiSessionAttentionSnapshot } from './attentionMonitor';
import type { AiSessionLifecycleRequest, AiSessionLifecycleSignal } from './lifecycle';
import type {
    AiSessionLifecycleRequestsByProvider,
    AiSessionLifecycleSignals,
} from './lifecycleSignalReader';
import { getAttentionProjectKeys, getLogicalAttentionSessionKey } from './attentionProject';
import { getAiSessionKey } from './sessionHelpers';
import type { WorkspaceAiSessionActionTarget, WorkspaceAiSessionViewModel } from './types';

const DEFAULT_BRIDGE_OUTAGE_MS = 10_000;

export interface AiSessionAttentionRuntimeEntry {
    runStartedAtMs: number;
    state: 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';
}

export interface AiSessionAttentionProvider {
    id: AiSessionProviderId;
    service: {
        getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    };
}

export interface AiSessionAttentionControllerOptions<TRuntime extends AiSessionAttentionRuntimeEntry = AiSessionAttentionRuntimeEntry> {
    isEnabled: () => boolean;
    getWorkspaceTarget: () => WorkspaceAiSessionActionTarget | null;
    getProviders: () => AiSessionAttentionProvider[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    getRuntimeById: (providerId: AiSessionProviderId, sessionId: string) => TRuntime | null;
    publish: (items: AttentionPayloadItem[], forceHeartbeat?: boolean) => Promise<boolean>;
    scheduleRefresh: (reason: string) => void;
    nowMs: () => number;
    /** How long publishing must keep failing before the bridge counts as out. */
    bridgeOutageMs?: number;
    onAttentionEvents?: (events: AiSessionAttentionEvent[]) => void;
    onAttentionAcknowledged?: (eventIds: string[]) => void;
}

export interface AiSessionAttentionEvaluation {
    enabled: boolean;
    published: boolean;
    inScopeSessionKeys: string[];
    eventIdsBySession: Record<string, string[]>;
    overflowedSessionKeys: string[];
}

export interface AiSessionAttentionRuntimeOverride<TRuntime> {
    providerId: AiSessionProviderId;
    sessionId: string;
    attentionKey?: string;
    runtime: TRuntime;
}

export class AiSessionAttentionController<TRuntime extends AiSessionAttentionRuntimeEntry = AiSessionAttentionRuntimeEntry> {
    private readonly monitor: AiSessionAttentionMonitor;
    private remoteAggregate: AttentionAggregate | null = null;
    private localItems: AttentionPayloadItem[] = [];
    private attentionKeysBySession = new Map<string, string[]>();
    private locallyAcknowledgedEventIds = new Set<string>();
    private publishFailingSinceMs: number | null = null;

    constructor(private readonly options: AiSessionAttentionControllerOptions<TRuntime>) {
        this.monitor = new AiSessionAttentionMonitor({ now: options.nowMs });
    }

    async evaluate(
        runtimeOverrides: readonly AiSessionAttentionRuntimeOverride<TRuntime>[] = [],
        signals?: AiSessionLifecycleSignals
    ): Promise<AiSessionAttentionEvaluation> {
        if (!this.options.isEnabled()) {
            this.monitor.clear();
            this.remoteAggregate = null;
            this.localItems = [];
            this.attentionKeysBySession.clear();
            this.locallyAcknowledgedEventIds.clear();
            const published = await this.options.publish([], true);
            this.recordPublishResult(published);
            this.options.scheduleRefresh('attention');
            return {
                enabled: false,
                published,
                inScopeSessionKeys: [],
                eventIdsBySession: {},
                overflowedSessionKeys: [],
            };
        }

        const workspaceTarget = this.options.getWorkspaceTarget();
        const providers = this.options.getProviders();
        const ownedSessions = this.getOwnedSessions(workspaceTarget?.sessions || null, providers, runtimeOverrides);
        for (const [attentionKey, owned] of ownedSessions) {
            const keys = this.attentionKeysBySession.get(owned.baseSessionKey) || [];
            if (!keys.includes(attentionKey)) {
                keys.push(attentionKey);
                keys.sort();
            }
            this.attentionKeysBySession.set(owned.baseSessionKey, keys);
        }
        const signalsByProvider = signals || this.readSignals(providers, ownedSessions);
        const runningAttentionKeysBySession = new Map<string, string>();
        const inputs = Array.from(ownedSessions, ([key, owned]) => {
            const signal = signalsByProvider[owned.providerId][owned.session.id];
            if (signal?.phase === 'running') {
                runningAttentionKeysBySession.set(owned.baseSessionKey, key);
            }
            return {
                key,
                eventKey: owned.baseSessionKey,
                signal,
                observedAt: signal?.occurredAtMs,
            };
        });

        const events = this.monitor.evaluate(inputs);
        if (events.length) {
            try {
                this.options.onAttentionEvents?.(events);
            } catch (_error) {
                // 外发通知不得影响 attention 主流程。
            }
        }
        const acknowledgedReplayEventIds = events
            .map(event => event.eventId)
            .filter(eventId => this.locallyAcknowledgedEventIds.has(eventId));
        if (acknowledgedReplayEventIds.length) {
            this.monitor.acknowledge(acknowledgedReplayEventIds);
        }
        let discardedStaleAttention = false;
        for (const [sessionKey, runningAttentionKey] of runningAttentionKeysBySession) {
            const staleAttentionKeys = (this.attentionKeysBySession.get(sessionKey) || [])
                .filter(attentionKey => attentionKey !== runningAttentionKey);
            discardedStaleAttention ||= staleAttentionKeys.length > 0;
            this.monitor.discard(staleAttentionKeys);
        }
        this.pruneAttentionKeysBySession();
        if (events.length || discardedStaleAttention) {
            this.options.scheduleRefresh('attention');
        }

        const localResult = this.buildLocalItems(workspaceTarget, providers);
        this.localItems = localResult.items;
        const published = await this.options.publish(this.localItems);
        this.recordPublishResult(published);
        return {
            enabled: true,
            published,
            inScopeSessionKeys: [...ownedSessions.keys()].sort(),
            eventIdsBySession: groupEventIdsBySession(this.localItems),
            overflowedSessionKeys: localResult.overflowedSessionKeys,
        };
    }

    acknowledge(eventIds: string[]): void {
        const uniqueEventIds = Array.from(new Set(eventIds.filter(eventId => Boolean(eventId))));
        for (const eventId of uniqueEventIds) {
            this.locallyAcknowledgedEventIds.delete(eventId);
            this.locallyAcknowledgedEventIds.add(eventId);
            if (this.locallyAcknowledgedEventIds.size > MAX_ATTENTION_ITEMS) {
                const oldestEventId = this.locallyAcknowledgedEventIds.values().next().value;
                if (oldestEventId) {
                    this.locallyAcknowledgedEventIds.delete(oldestEventId);
                }
            }
        }
        this.monitor.acknowledge(uniqueEventIds);
        try {
            this.options.onAttentionAcknowledged?.(uniqueEventIds);
        } catch (_error) {
            // 同上。
        }
        const result = this.buildLocalItems(this.options.getWorkspaceTarget(), this.options.getProviders());
        this.localItems = result.items;
    }

    setRemoteAggregate(aggregate: AttentionAggregate): boolean {
        if (aggregate.aggregateRevision === this.remoteAggregate?.aggregateRevision) {
            return false;
        }

        this.remoteAggregate = aggregate;
        return true;
    }

    hasRemoteAggregate(): boolean {
        return Boolean(this.remoteAggregate);
    }

    getEffectiveAggregate(): AttentionAggregate {
        // A sustained publish outage means the bridge cannot be reached at all, so
        // its last aggregate is unverifiable and no peer can be acknowledging our
        // events either. Local state is then the only honest source.
        const remote = this.isBridgeOut() ? null : this.remoteAggregate;
        const aggregate = remote || (() => {
            const now = this.options.nowMs();
            return aggregateAttentionSnapshots([{
                version: 1,
                generatedAtMs: now,
                items: this.localItems,
                instanceId: '00000000000000000000000000000000',
                sequence: 0,
                heartbeat: 0,
            }], new Set<string>(), now);
        })();
        return filterLocallyClearedAttentionAggregate(
            filterAcknowledgedAttentionAggregate(aggregate, this.locallyAcknowledgedEventIds),
            sessionKey => this.isLocallyCleared(sessionKey)
        );
    }

    private recordPublishResult(published: boolean): void {
        if (published) {
            this.publishFailingSinceMs = null;
            return;
        }
        if (this.publishFailingSinceMs === null) {
            this.publishFailingSinceMs = this.options.nowMs();
        }
    }

    /**
     * Whether publishing has been failing long enough to call the bridge out.
     * A single failure is not enough: the client retries at 100ms, 500ms and 2s,
     * so a bridge restart would otherwise flicker peer windows off the view.
     */
    private isBridgeOut(): boolean {
        if (this.publishFailingSinceMs === null) {
            return false;
        }
        const outageMs = this.options.bridgeOutageMs ?? DEFAULT_BRIDGE_OUTAGE_MS;
        return this.options.nowMs() - this.publishFailingSinceMs >= outageMs;
    }

    /**
     * Whether this window owns the session and its monitor no longer reports
     * attention. Sessions this window does not track are never claimed, because
     * for those the aggregate is the only thing that knows anything.
     */
    private isLocallyCleared(sessionKey: string): boolean {
        const attentionKeys = this.attentionKeysBySession.get(
            getLogicalAttentionSessionKey(sessionKey)
        );
        if (!attentionKeys?.length) {
            return false;
        }
        const snapshot = this.monitor.getSnapshot();
        return !attentionKeys.some(key => snapshot[key]?.state === 'needsAttention');
    }

    getLocalSnapshot(): Record<string, AiSessionAttentionSnapshot> {
        return this.monitor.getSnapshot();
    }

    getRecoverySessionEvents(): Array<{ sessionKey: string; eventIds: string[] }> {
        const bySession = new Map<string, Set<string>>();
        const addEvent = (sessionKey: string, eventId: string) => {
            if (!sessionKey || !eventId) {
                return;
            }
            const eventIds = bySession.get(sessionKey) || new Set<string>();
            eventIds.add(eventId);
            bySession.set(sessionKey, eventIds);
        };

        Object.entries(this.monitor.getSnapshot()).forEach(([sessionKey, snapshot]) => {
            if (snapshot.state === 'needsAttention' && snapshot.event?.eventId) {
                addEvent(this.getLogicalSessionKey(sessionKey), snapshot.event.eventId);
            }
        });
        this.getEffectiveAggregate().sessions.forEach(session => {
            session.eventIds.forEach(eventId => addEvent(
                this.getLogicalSessionKey(session.sessionKey),
                eventId
            ));
        });
        return Array.from(bySession.entries())
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .slice(0, 1000)
            .map(([sessionKey, eventIds]) => ({ sessionKey, eventIds: Array.from(eventIds).slice(0, 1000) }));
    }

    getAttentionEventIds(): string[] {
        return Array.from(new Set([
            ...Object.values(this.monitor.getSnapshot())
                .map(snapshot => snapshot.state === 'needsAttention' ? snapshot.event?.eventId : undefined)
                .filter((id): id is string => Boolean(id)),
            ...this.getEffectiveAggregate().sessions
                .reduce((eventIds, item) => eventIds.concat(item.eventIds), [] as string[]),
        ]));
    }

    private getOwnedSessions(
        workspaceSessions: WorkspaceAiSessionViewModel | null,
        providers: AiSessionAttentionProvider[],
        runtimeOverrides: readonly AiSessionAttentionRuntimeOverride<TRuntime>[]
    ): Map<string, {
        providerId: AiSessionProviderId;
        session: CodexSession;
        runtime: TRuntime;
        baseSessionKey: string;
    }> {
        const ownedSessions = new Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            runtime: TRuntime;
            baseSessionKey: string;
        }>();
        const overrides = new Map<string, Array<{ attentionKey: string; runtime: TRuntime }>>();
        for (const override of runtimeOverrides) {
            const baseSessionKey = override
                && this.getSessionKey(override.providerId, override.sessionId);
            if (baseSessionKey && override.runtime) {
                const entries = overrides.get(baseSessionKey) || [];
                entries.push({
                    attentionKey: override.attentionKey || baseSessionKey,
                    runtime: override.runtime,
                });
                overrides.set(baseSessionKey, entries);
            }
        }
        for (const provider of providers) {
            for (const session of workspaceSessions?.sessionsByProvider[provider.id] || []) {
                    const baseSessionKey = this.getSessionKey(provider.id, session.id);
                    const overridden = overrides.get(baseSessionKey);
                    if (overridden?.length) {
                        for (const entry of overridden) {
                            if (entry.runtime.state !== 'stopped'
                                && !ownedSessions.has(entry.attentionKey)) {
                                ownedSessions.set(entry.attentionKey, {
                                    providerId: provider.id,
                                    session,
                                    runtime: entry.runtime,
                                    baseSessionKey,
                                });
                            }
                        }
                        continue;
                    }
                    const runtime = this.options.getRuntimeById(provider.id, session.id);
                    if (!runtime || runtime.state === 'stopped' || ownedSessions.has(baseSessionKey)) {
                        continue;
                    }
                    ownedSessions.set(baseSessionKey, {
                        providerId: provider.id, session, runtime, baseSessionKey,
                    });
            }
        }
        return ownedSessions;
    }

    /** The sessions this controller needs signals for, for the shared reader to merge. */
    getLifecycleRequests(
        runtimeOverrides: readonly AiSessionAttentionRuntimeOverride<TRuntime>[] = []
    ): AiSessionLifecycleRequestsByProvider {
        if (!this.options.isEnabled()) {
            return {};
        }
        const requests: Partial<Record<AiSessionProviderId, AiSessionLifecycleRequest[]>> = {};
        const ownedSessions = this.getOwnedSessions(
            this.options.getWorkspaceTarget()?.sessions || null,
            this.options.getProviders(),
            runtimeOverrides
        );
        for (const owned of ownedSessions.values()) {
            const owning = requests[owned.providerId] || [];
            owning.push({
                sessionId: owned.session.id,
                runStartedAtMs: owned.runtime.runStartedAtMs,
            });
            requests[owned.providerId] = owning;
        }
        return requests;
    }

    private readSignals(
        providers: AiSessionAttentionProvider[],
        ownedSessions: Map<string, {
            providerId: AiSessionProviderId;
            session: CodexSession;
            runtime: TRuntime;
            baseSessionKey: string;
        }>
    ): Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>> {
        const requestsByProvider = providers.reduce((result, provider) => {
            result[provider.id] = [];
            return result;
        }, {} as Record<AiSessionProviderId, AiSessionLifecycleRequest[]>);
        for (const owned of ownedSessions.values()) {
            requestsByProvider[owned.providerId].push({
                sessionId: owned.session.id,
                runStartedAtMs: owned.runtime.runStartedAtMs,
            });
        }

        return providers.reduce((result, provider) => {
            const requests = requestsByProvider[provider.id];
            result[provider.id] = requests.length
                ? provider.service.getLifecycleSignals(requests)
                : {};
            return result;
        }, {} as Record<AiSessionProviderId, Record<string, AiSessionLifecycleSignal>>);
    }

    private buildLocalItems(
        workspaceTarget: WorkspaceAiSessionActionTarget | null,
        providers: AiSessionAttentionProvider[]
    ): { items: AttentionPayloadItem[]; overflowedSessionKeys: string[] } {
        const snapshot = this.monitor.getSnapshot();
        const items: AttentionPayloadItem[] = [];
        for (const provider of providers) {
            for (const session of workspaceTarget?.sessions.sessionsByProvider[provider.id] || []) {
                    const root = workspaceTarget.workspace.roots.find(candidate =>
                        candidate.id === session.primaryRootId
                    );
                    const attentionRootKey = root ? getAttentionProjectKeys([root.uri])[0] || '' : '';
                    if (!attentionRootKey) {
                        continue;
                    }
                    const baseSessionKey = this.getSessionKey(provider.id, session.id);
                    const attentionKeys = this.attentionKeysBySession.get(baseSessionKey)
                        || [baseSessionKey];
                    for (const attentionKey of attentionKeys) {
                        const attention = snapshot[attentionKey];
                        if (!attention?.event) {
                            continue;
                        }
                        items.push({
                            projectId: attentionRootKey,
                            sessionKey: attentionKey,
                            state: attention.state === 'needsAttention' ? 'needsAttention' : 'acknowledged',
                            eventId: attention.event.eventId,
                            reason: attention.event.reason,
                            observedAtMs: attention.stateChangedAt,
                        });
                    }
            }
        }
        const sorted = items
            .sort((left, right) => right.observedAtMs - left.observedAtMs
                || (left.eventId || '').localeCompare(right.eventId || ''));
        const retained = sorted.slice(0, MAX_ATTENTION_ITEMS);
        const overflowedSessionKeys = sorted.slice(MAX_ATTENTION_ITEMS)
            .map(item => item.sessionKey);
        this.monitor.discard(overflowedSessionKeys);
        this.pruneAttentionKeysBySession();
        return { items: retained, overflowedSessionKeys };
    }

    private pruneAttentionKeysBySession(): void {
        const snapshotKeys = new Set(Object.keys(this.monitor.getSnapshot()));
        for (const [sessionKey, attentionKeys] of this.attentionKeysBySession) {
            const retained = attentionKeys.filter(key => snapshotKeys.has(key));
            if (retained.length) {
                this.attentionKeysBySession.set(sessionKey, retained);
            } else {
                this.attentionKeysBySession.delete(sessionKey);
            }
        }
    }

    private getLogicalSessionKey(attentionKey: string): string {
        for (const [sessionKey, attentionKeys] of this.attentionKeysBySession) {
            if (attentionKeys.includes(attentionKey)) {
                return sessionKey;
            }
        }
        return getLogicalAttentionSessionKey(attentionKey);
    }

    private getSessionKey(providerId: AiSessionProviderId, sessionId: string): string {
        return this.options.getSessionKey
            ? this.options.getSessionKey(providerId, sessionId)
            : getAiSessionKey(providerId, sessionId);
    }
}

function groupEventIdsBySession(items: readonly AttentionPayloadItem[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const item of items) {
        const eventIds = result[item.sessionKey] || [];
        if (!eventIds.includes(item.eventId)) {
            eventIds.push(item.eventId);
            eventIds.sort();
        }
        result[item.sessionKey] = eventIds;
    }
    return result;
}

export interface AiSessionRuntimeLifecycleCandidate {
    key: string;
    sessionKey?: string;
    state: 'completed' | 'stopped';
}

export type AiSessionRuntimeLifecycleFailureOperation = 'evaluate' | 'release';

export interface SettleAiSessionRuntimeLifecyclesOptions<TCandidate extends AiSessionRuntimeLifecycleCandidate> {
    candidates: readonly TCandidate[];
    evaluateAttention: () => Promise<AiSessionAttentionEvaluation>;
    release: (candidate: TCandidate) => void | Promise<void>;
    reportFailure?: (
        operation: AiSessionRuntimeLifecycleFailureOperation,
        category: 'unexpected',
        key: string | undefined
    ) => void;
}

export interface AiSessionRuntimeLifecycleSettlementResult {
    releasedKeys: string[];
    retainedKeys: string[];
}

export function runAiSessionRuntimeLifecycleTask(
    operation: string,
    task: () => unknown | Promise<unknown>,
    reportFailure: (operation: string, category: 'unexpected') => unknown | Promise<unknown>
): Promise<void> {
    return Promise.resolve().then(task).then(() => undefined, async () => {
        try {
            await reportFailure(operation, 'unexpected');
        } catch (_reportError) {
            // A diagnostic reporter must not escape the safe lifecycle boundary.
        }
    });
}

export async function settleAiSessionRuntimeLifecycles<
    TCandidate extends AiSessionRuntimeLifecycleCandidate
>(
    options: SettleAiSessionRuntimeLifecyclesOptions<TCandidate>
): Promise<AiSessionRuntimeLifecycleSettlementResult> {
    const candidates = deduplicateLifecycleCandidates(options.candidates);
    let evaluation: AiSessionAttentionEvaluation;
    try {
        evaluation = await options.evaluateAttention();
    } catch (_error) {
        options.reportFailure?.('evaluate', 'unexpected', undefined);
        return {
            releasedKeys: [],
            retainedKeys: candidates.map(candidate => candidate.key).sort(),
        };
    }

    const inScope = new Set(evaluation.inScopeSessionKeys);
    const candidateSessionKey = (candidate: TCandidate): string => candidate.sessionKey || candidate.key;
    const overflowed = new Set(evaluation.overflowedSessionKeys);
    const hasAttentionEvidence = (candidate: TCandidate): boolean => {
        const sessionKey = candidateSessionKey(candidate);
        return (evaluation.eventIdsBySession[sessionKey] || []).length > 0
            || overflowed.has(sessionKey);
    };
    const safeToRelease = candidates.filter(candidate => {
        if (candidate.state === 'stopped' || !evaluation.enabled) {
            return true;
        }
        const sessionKey = candidateSessionKey(candidate);
        if (!inScope.has(sessionKey) || !hasAttentionEvidence(candidate)) {
            return true;
        }
        return evaluation.published;
    });

    const eligibleByKey = new Map<string, TCandidate>();
    for (const candidate of safeToRelease) {
        eligibleByKey.set(candidate.key, candidate);
    }
    const releasedKeys: string[] = [];
    for (const candidate of [...eligibleByKey.values()].sort((left, right) =>
        left.key.localeCompare(right.key))) {
        try {
            await options.release(candidate);
            releasedKeys.push(candidate.key);
        } catch (_error) {
            options.reportFailure?.('release', 'unexpected', candidate.key);
        }
    }
    const released = new Set(releasedKeys);
    return {
        releasedKeys,
        retainedKeys: candidates.map(candidate => candidate.key)
            .filter(key => !released.has(key)).sort(),
    };
}

function deduplicateLifecycleCandidates<TCandidate extends AiSessionRuntimeLifecycleCandidate>(
    candidates: readonly TCandidate[]
): TCandidate[] {
    const byKey = new Map<string, TCandidate>();
    for (const candidate of candidates) {
        if (candidate && candidate.key && (candidate.state === 'completed' || candidate.state === 'stopped')) {
            const existing = byKey.get(candidate.key);
            if (!existing || (existing.state === 'stopped' && candidate.state === 'completed')) {
                byKey.set(candidate.key, candidate);
            }
        }
    }
    return [...byKey.values()];
}
