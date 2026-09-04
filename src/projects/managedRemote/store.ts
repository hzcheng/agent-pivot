'use strict';

import {
    cloneManagedValue,
    createCausalVersion,
    createVersionedCandidates,
    distinctCandidateValues,
    joinVersionVectors,
    stableManagedValue,
    vectorIncludingVersion,
} from './causal';
import {
    createEmptyManagedCatalogEnvelope,
    createChecksummedLegacySnapshot,
    createManagedRevisionSlot,
    joinManagedCatalogEnvelopes,
    mergeActiveAuthorityCandidates,
    normalizeManagedCatalogEnvelope,
    parseManagedCatalogEnvelope,
} from './envelope';
import { materializeManagedRemoteCatalog } from './merge';
import { assertManagedEnvelopePayload } from './payload';
import {
    ManagedAuthorityState,
    ManagedCatalogEnvelopeV1,
    ManagedCatalogWriterReplicaV1,
    ManagedMigrationJournal,
    ManagedRemoteCatalogV1,
    ManagedRevisionSlot,
} from './types';

export interface ManagedCatalogBackend {
    read(): unknown;
    write(value: ManagedCatalogEnvelopeV1): Thenable<void>;
}

/**
 * The implementation owns cross-window serialization for writer allocation and
 * state replacement. The coordinator never read-modify-writes shared globalState
 * directly.
 */
export interface ManagedCatalogReplicaFacade {
    allocateWriter(): Promise<{ writerId: string; actorId: string }>;
    readWriter(writerId: string): ManagedCatalogWriterReplicaV1 | null;
    readWriters?(): Array<{ writerId: string; value: ManagedCatalogWriterReplicaV1 }>;
    writeWriter(writerId: string, value: ManagedCatalogWriterReplicaV1): Thenable<void>;
}

export interface ManagedCatalogReconcileResult {
    envelope: ManagedCatalogEnvelopeV1;
    repairedBackend: boolean;
    repairedReplica: boolean;
    recoveryRequired: boolean;
    issues: string[];
    recoveryCandidates: ManagedRevisionSlot[];
}

function envelopeEquals(left: unknown, right: unknown): boolean {
    return stableManagedValue(left) === stableManagedValue(right);
}

function uniqueRevisionSlots(slots: ManagedRevisionSlot[]): ManagedRevisionSlot[] {
    const unique = new Map<string, ManagedRevisionSlot>();
    for (const slot of slots) {
        unique.set(`${slot.revisionId}:${slot.checksum}`, cloneManagedValue(slot));
    }
    return Array.from(unique.values()).sort((left, right) =>
        left.revisionId.localeCompare(right.revisionId)
        || left.checksum.localeCompare(right.checksum));
}

function currentActiveSlot(envelope: ManagedCatalogEnvelopeV1): ManagedRevisionSlot | undefined {
    const values = distinctCandidateValues(envelope.authority)
        .filter((value): value is ManagedAuthorityState => value !== null);
    if (values.length !== 1 || values[0].lifecycle !== 'active') {
        return undefined;
    }
    return values[0].active;
}

function withEnvelopeMutation(
    envelope: ManagedCatalogEnvelopeV1,
    actorId: string,
    mutate: (
        candidate: ManagedCatalogEnvelopeV1,
        version: ReturnType<typeof createCausalVersion>,
    ) => void,
): ManagedCatalogEnvelopeV1 {
    const candidate = cloneManagedValue(envelope);
    const version = createCausalVersion(candidate.causalContext, actorId);
    mutate(candidate, version);
    candidate.causalContext = joinVersionVectors(
        candidate.causalContext,
        vectorIncludingVersion(version),
    );
    return normalizeManagedCatalogEnvelope(candidate);
}

export class ManagedCatalogCoordinator {
    private pending: Promise<unknown> = Promise.resolve();

    private constructor(
        private readonly backend: ManagedCatalogBackend,
        private readonly replicas: ManagedCatalogReplicaFacade,
        private readonly writerId: string,
        private readonly actorId: string,
    ) {
    }

    static async create(
        backend: ManagedCatalogBackend,
        replicas: ManagedCatalogReplicaFacade,
    ): Promise<ManagedCatalogCoordinator> {
        const writer = await replicas.allocateWriter();
        if (!writer.writerId || !writer.actorId) {
            throw new Error('Managed catalog writer allocation failed.');
        }
        return new ManagedCatalogCoordinator(
            backend,
            replicas,
            writer.writerId,
            writer.actorId,
        );
    }

    reconcile(): Promise<ManagedCatalogReconcileResult> {
        return this.enqueue(() => this.reconcileNow());
    }

    stageCatalog(document: ManagedRemoteCatalogV1): Promise<string> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (reconciled.recoveryRequired) {
                throw new Error('Managed catalog recovery is required before staging changes.');
            }
            const slot = createManagedRevisionSlot(document);
            let stageId = '';
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    stageId = `stage:${version.dot.actorId}:${version.dot.counter}`;
                    envelope.stagedRevisions[stageId] = createVersionedCandidates(slot, version);
                },
            );
            await this.publishCandidate(candidate);
            return stageId;
        });
    }

    activateStagedCatalog(
        stageId: string,
        lifecycle: 'preview' | 'active' = 'active',
    ): Promise<ManagedRevisionSlot> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (reconciled.recoveryRequired) {
                throw new Error('Managed catalog recovery is required before activation.');
            }
            const register = reconciled.envelope.stagedRevisions[stageId];
            if (!register) {
                throw new Error('Managed catalog staged revision no longer exists.');
            }
            const values = distinctCandidateValues(register);
            const slots = values.filter((value): value is ManagedRevisionSlot => value !== null);
            if (slots.length !== 1 || values.length !== 1) {
                throw new Error('Managed catalog staged revision is conflicted.');
            }
            const catalog = materializeManagedRemoteCatalog(slots[0].document);
            if (catalog.conflicts.length) {
                throw new Error('Managed catalog conflicts must be resolved before activation.');
            }
            const previous = currentActiveSlot(reconciled.envelope);
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    envelope.authority = createVersionedCandidates({
                        lifecycle,
                        active: slots[0],
                        ...(previous ? { previous } : {}),
                    }, version);
                    envelope.stagedRevisions[stageId] = createVersionedCandidates(null, version);
                },
            );
            await this.publishCandidate(candidate);
            return cloneManagedValue(slots[0]);
        });
    }

    discardStagedCatalog(stageId: string): Promise<void> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (!reconciled.envelope.stagedRevisions[stageId]) {
                return;
            }
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    envelope.stagedRevisions[stageId] = createVersionedCandidates(null, version);
                },
            );
            await this.publishCandidate(candidate);
        });
    }

    prepareMigration(input: {
        planId: string;
        frozenLegacy: { projectData: unknown; projectSyncData: unknown };
        document: ManagedRemoteCatalogV1;
    }): Promise<ManagedRevisionSlot> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (reconciled.recoveryRequired) {
                throw new Error('Managed catalog recovery is required before migration.');
            }
            const authorities = distinctCandidateValues(reconciled.envelope.authority);
            if (authorities.length !== 1 || authorities[0].lifecycle === 'active') {
                throw new Error('Managed Remote migration cannot replace active authority.');
            }
            const candidateSlot = createManagedRevisionSlot(input.document);
            if (materializeManagedRemoteCatalog(candidateSlot.document).conflicts.length) {
                throw new Error('Managed migration candidate has unresolved catalog conflicts.');
            }
            const frozenLegacy = createChecksummedLegacySnapshot(
                input.frozenLegacy.projectData === undefined
                    ? null : input.frozenLegacy.projectData,
                input.frozenLegacy.projectSyncData === undefined
                    ? null : input.frozenLegacy.projectSyncData,
            );
            const journal: ManagedMigrationJournal = {
                planId: input.planId,
                phase: 'prepared',
                frozenLegacy,
                candidate: candidateSlot,
            };
            const previous = authorities[0].active;
            const envelope = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (value, version) => {
                    value.migrationPlans[input.planId] = createVersionedCandidates(
                        journal,
                        version,
                    );
                    value.authority = createVersionedCandidates({
                        lifecycle: 'preview',
                        active: candidateSlot,
                        ...(previous ? { previous } : {}),
                        migrationPlanId: input.planId,
                    }, version);
                },
            );
            await this.publishCandidate(envelope);
            return cloneManagedValue(candidateSlot);
        });
    }

    activatePreparedMigration(
        planId: string,
        expectedRevisionId: string,
    ): Promise<ManagedRevisionSlot> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (reconciled.recoveryRequired) {
                throw new Error('Managed catalog recovery is required before activation.');
            }
            const authorities = distinctCandidateValues(reconciled.envelope.authority);
            if (authorities.length !== 1
                || authorities[0].lifecycle !== 'preview'
                || authorities[0].migrationPlanId !== planId
                || authorities[0].active?.revisionId !== expectedRevisionId) {
                throw new Error('Managed migration preview changed before activation.');
            }
            const planValues = reconciled.envelope.migrationPlans[planId]
                ? distinctCandidateValues(reconciled.envelope.migrationPlans[planId]) : [];
            const journals = planValues.filter(
                (value): value is ManagedMigrationJournal => value !== null,
            );
            if (journals.length !== 1
                || journals[0].candidate.revisionId !== expectedRevisionId) {
                throw new Error('Managed migration journal is missing or conflicted.');
            }
            const slot = cloneManagedValue(authorities[0].active);
            if (materializeManagedRemoteCatalog(slot.document).conflicts.length) {
                throw new Error('Managed migration candidate has unresolved catalog conflicts.');
            }
            const completed: ManagedMigrationJournal = {
                ...cloneManagedValue(journals[0]),
                phase: 'complete',
            };
            const envelope = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (value, version) => {
                    value.migrationPlans[planId] = createVersionedCandidates(
                        completed,
                        version,
                    );
                    value.authority = createVersionedCandidates({
                        lifecycle: 'active',
                        active: slot,
                        ...(authorities[0].previous
                            ? { previous: authorities[0].previous } : {}),
                        migrationPlanId: planId,
                    }, version);
                },
            );
            await this.publishCandidate(envelope);
            return slot;
        });
    }

    activateRecoveryCandidate(revisionId: string): Promise<ManagedRevisionSlot> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            const candidates = reconciled.recoveryCandidates
                .filter(candidate => candidate.revisionId === revisionId);
            const distinct = new Map(candidates.map(candidate => [
                stableManagedValue(candidate), candidate,
            ]));
            if (distinct.size !== 1) {
                throw new Error('Managed recovery candidate is missing or ambiguous.');
            }
            const slot = cloneManagedValue(Array.from(distinct.values())[0]);
            if (materializeManagedRemoteCatalog(slot.document).conflicts.length) {
                throw new Error('Managed recovery candidate has unresolved catalog conflicts.');
            }
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    envelope.authority = createVersionedCandidates({
                        lifecycle: 'active',
                        active: slot,
                    }, version);
                },
            );
            await this.publishCandidate(candidate, true);
            return slot;
        });
    }

    discardRecoveryCandidate(revisionId: string): Promise<void> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            const referencedByActive = reconciled.envelope.authority.candidates.some(candidate =>
                candidate.value.active?.revisionId === revisionId);
            if (referencedByActive) {
                throw new Error(
                    'Cannot discard an active recovery candidate; activate another candidate or roll back first.',
                );
            }
            const referencedByPrevious = reconciled.envelope.authority.candidates.some(candidate =>
                candidate.value.previous?.revisionId === revisionId);
            const matchingStageIds = Object.entries(reconciled.envelope.stagedRevisions)
                .filter(([, register]) => register.candidates.some(candidate =>
                    candidate.value?.revisionId === revisionId))
                .map(([stageId]) => stageId);
            if (!referencedByPrevious && !matchingStageIds.length) {
                throw new Error('Managed recovery candidate no longer exists.');
            }
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    const authorityValues = distinctCandidateValues(envelope.authority);
                    if (authorityValues.length !== 1) {
                        throw new Error(
                            'Resolve concurrent authority candidates before discarding their history.',
                        );
                    }
                    const authority = cloneManagedValue(authorityValues[0]);
                    if (authority.previous?.revisionId === revisionId) {
                        delete authority.previous;
                    }
                    envelope.authority = createVersionedCandidates(authority, version);
                    for (const stageId of matchingStageIds) {
                        envelope.stagedRevisions[stageId] = createVersionedCandidates(null, version);
                    }
                },
            );
            await this.publishCandidate(candidate, reconciled.recoveryRequired);
        });
    }

    rollBackToPrevious(): Promise<ManagedRevisionSlot> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            const authorityValues = distinctCandidateValues(reconciled.envelope.authority);
            if (authorityValues.length !== 1 || !authorityValues[0].previous) {
                throw new Error('Managed catalog has no unambiguous previous revision.');
            }
            const authority = authorityValues[0];
            const previous = cloneManagedValue(authority.previous);
            if (materializeManagedRemoteCatalog(previous.document).conflicts.length) {
                throw new Error('Previous Managed catalog revision has unresolved conflicts.');
            }
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    envelope.authority = createVersionedCandidates({
                        lifecycle: 'active',
                        active: previous,
                        ...(authority.active ? { previous: authority.active } : {}),
                    }, version);
                },
            );
            await this.publishCandidate(candidate, reconciled.recoveryRequired);
            return previous;
        });
    }

    discardRecoveryState(): Promise<void> {
        return this.enqueue(async () => {
            const reconciled = await this.reconcileNow();
            if (!reconciled.recoveryRequired) { return; }
            const candidate = withEnvelopeMutation(
                reconciled.envelope,
                this.actorId,
                (envelope, version) => {
                    envelope.authority = createVersionedCandidates({ lifecycle: 'disabled' }, version);
                    for (const stageId of Object.keys(envelope.stagedRevisions)) {
                        envelope.stagedRevisions[stageId] = createVersionedCandidates(null, version);
                    }
                },
            );
            await this.publishCandidate(candidate, true);
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private async reconcileNow(): Promise<ManagedCatalogReconcileResult> {
        const rawBackend = this.backend.read();
        const backendParsed = rawBackend === null || rawBackend === undefined
            ? null
            : parseManagedCatalogEnvelope(rawBackend);
        const writerEntries = this.replicas.readWriters?.()
            || (this.replicas.readWriter(this.writerId)
                ? [{
                    writerId: this.writerId,
                    value: this.replicas.readWriter(this.writerId) as ManagedCatalogWriterReplicaV1,
                }]
                : []);
        const writer = writerEntries.find(entry => entry.writerId === this.writerId)?.value || null;
        const parsedWriters = writerEntries.map(entry => ({
            ...entry,
            replica: parseManagedCatalogEnvelope(entry.value.envelope),
            staged: entry.value.stagedCandidate
                ? parseManagedCatalogEnvelope(entry.value.stagedCandidate)
                : null,
        }));
        const replicaEnvelopes = parsedWriters
            .filter(entry => entry.replica && !entry.replica.issues.length)
            .map(entry => entry.replica!.envelope);
        const stagedEnvelopes = parsedWriters
            .filter(entry => entry.staged && !entry.staged.issues.length)
            .map(entry => entry.staged!.envelope);
        const issues = [
            ...(backendParsed?.issues || []),
            ...(rawBackend !== null && rawBackend !== undefined && !backendParsed
                ? ['backend:invalid-envelope'] : []),
            ...parsedWriters.reduce<string[]>((result, entry) => {
                if (entry.replica && entry.replica.issues.length) {
                    result.push(`replica:${entry.writerId}:invalid-envelope`);
                }
                if (entry.staged && entry.staged.issues.length) {
                    result.push(`replica:${entry.writerId}:invalid-staged-candidate`);
                }
                return result;
            }, []),
        ];
        const cleanBackendEnvelope = backendParsed && !backendParsed.issues.length
            ? backendParsed.envelope
            : null;
        const sources = [cleanBackendEnvelope, ...replicaEnvelopes, ...stagedEnvelopes]
            .filter((value): value is ManagedCatalogEnvelopeV1 => Boolean(value));
        if (!sources.length && !backendParsed && issues.length) {
            throw new Error('Managed catalog has no valid recovery source.');
        }
        let envelope = sources.length
            ? sources.slice(1).reduce(joinManagedCatalogEnvelopes, sources[0])
            : backendParsed?.envelope || createEmptyManagedCatalogEnvelope(this.actorId);
        envelope = mergeActiveAuthorityCandidates(envelope, this.actorId);
        const authorityValues = distinctCandidateValues(envelope.authority);
        const recoveryRequired = issues.length > 0 || authorityValues.length > 1;
        let repairedBackend = false;
        let repairedReplica = false;
        const hasPersistedSource = sources.length > 0;

        if (hasPersistedSource
            && !recoveryRequired
            && (!backendParsed || !envelopeEquals(backendParsed.envelope, envelope))) {
            assertManagedEnvelopePayload(envelope);
            await this.backend.write(envelope);
            repairedBackend = true;
        }
        const nextWriter: ManagedCatalogWriterReplicaV1 = {
            actorId: this.actorId,
            nextCounter: (envelope.causalContext[this.actorId] || 0) + 1,
            envelope: cloneManagedValue(envelope),
        };
        if (hasPersistedSource && !recoveryRequired && (!writer
            || writer.stagedCandidate
            || !envelopeEquals(writer.envelope, nextWriter.envelope)
            || writer.nextCounter !== nextWriter.nextCounter
            || writer.actorId !== nextWriter.actorId)) {
            await this.replicas.writeWriter(this.writerId, nextWriter);
            repairedReplica = true;
        }
        return {
            envelope: cloneManagedValue(envelope),
            repairedBackend,
            repairedReplica,
            recoveryRequired,
            issues: Array.from(new Set(issues)).sort(),
            recoveryCandidates: uniqueRevisionSlots([
                ...(backendParsed?.recoveryCandidates || []),
                ...parsedWriters.reduce<ManagedRevisionSlot[]>((result, entry) => {
                    result.push(...(entry.replica?.recoveryCandidates || []));
                    result.push(...(entry.staged?.recoveryCandidates || []));
                    return result;
                }, []),
            ]),
        };
    }

    private async publishCandidate(
        candidate: ManagedCatalogEnvelopeV1,
        replaceCorruptBackend = false,
    ): Promise<void> {
        assertManagedEnvelopePayload(candidate);
        const current = this.replicas.readWriter(this.writerId);
        const stagedReplica: ManagedCatalogWriterReplicaV1 = {
            actorId: this.actorId,
            nextCounter: (candidate.causalContext[this.actorId] || 0) + 1,
            envelope: cloneManagedValue(current?.envelope || candidate),
            stagedCandidate: cloneManagedValue(candidate),
        };
        await this.replicas.writeWriter(this.writerId, stagedReplica);
        const rawBackend = this.backend.read();
        const parsedBackend = rawBackend === null || rawBackend === undefined
            ? null
            : parseManagedCatalogEnvelope(rawBackend);
        if (rawBackend !== null && rawBackend !== undefined && !parsedBackend) {
            if (!replaceCorruptBackend) {
                throw new Error('Managed catalog backend became invalid before publication.');
            }
        }
        if (parsedBackend?.issues.length && !replaceCorruptBackend) {
            throw new Error('Managed catalog backend requires recovery before publication.');
        }
        const publishable = parsedBackend && !parsedBackend.issues.length
            ? joinManagedCatalogEnvelopes(parsedBackend.envelope, candidate)
            : candidate;
        assertManagedEnvelopePayload(publishable);
        await this.backend.write(publishable);
        await this.replicas.writeWriter(this.writerId, {
            actorId: this.actorId,
            nextCounter: (publishable.causalContext[this.actorId] || 0) + 1,
            envelope: cloneManagedValue(publishable),
        });
    }
}
