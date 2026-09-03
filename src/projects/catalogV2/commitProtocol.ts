'use strict';

import {
    activateProjectCatalogV2Candidate,
    createProjectCatalogV2RevisionSlot,
    readProjectCatalogV2Envelope,
    stageProjectCatalogV2Candidate,
} from './envelope';
import { mergeProjectCatalogV2Documents } from './merge';
import {
    ProjectCatalogV2Document,
    ProjectCatalogV2Envelope,
    ProjectCatalogV2RevisionSlot,
} from './types';

export interface ProjectCatalogV2CommitDependencies {
    readBackend(): unknown;
    writeBackend(envelope: ProjectCatalogV2Envelope): Thenable<void>;
    readReplica(): unknown;
    writeReplica(envelope: ProjectCatalogV2Envelope): Thenable<void>;
    validateDocument?(document: ProjectCatalogV2Document): void;
}

export interface ProjectCatalogV2CommitResult {
    envelope: ProjectCatalogV2Envelope;
    document: ProjectCatalogV2Document | null;
    recoveryRequired: boolean;
    recoveryCandidates: ProjectCatalogV2RevisionSlot[];
}

export class ProjectCatalogV2CommitCoordinator {
    private queue: Promise<void> = Promise.resolve();

    public constructor(private readonly dependencies: ProjectCatalogV2CommitDependencies) {
    }

    public reconcile(): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueue(() => this.reconcileNow());
    }

    public commit(document: ProjectCatalogV2Document): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueue(async () => {
            const current = await this.reconcileNow(false);
            if (current.recoveryRequired) {
                throw new Error('project catalog V2 recovery is required before committing');
            }
            const merged = current.document
                ? mergeProjectCatalogV2Documents(current.document, document)
                : document;
            this.dependencies.validateDocument?.(merged);
            return this.activateDocument(current.envelope, merged);
        });
    }

    public activateRecoveryCandidate(revision: string): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueue(async () => {
            const current = await this.reconcileNow(false);
            const candidate = current.recoveryCandidates.find(slot => slot.revision === revision);
            if (!candidate) { throw new Error('project catalog V2 recovery candidate was not found'); }
            if (current.recoveryCandidates.some(slot => slot.revision !== revision)) {
                throw new Error('project catalog V2 other recovery candidates must be resolved first');
            }
            const document = current.document
                ? mergeProjectCatalogV2Documents(current.document, candidate.document)
                : candidate.document;
            this.dependencies.validateDocument?.(document);
            return this.activateDocument({ ...current.envelope, candidate: null }, document);
        });
    }

    public discardRecoveryCandidate(revision: string): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueue(async () => {
            const backend = readProjectCatalogV2Envelope(this.dependencies.readBackend());
            const replica = readProjectCatalogV2Envelope(this.dependencies.readReplica());
            if (![backend.envelope.candidate, replica.envelope.candidate]
                .some(slot => slot?.revision === revision)) {
                throw new Error('project catalog V2 recovery candidate was not found');
            }
            const discard = (envelope: ProjectCatalogV2Envelope): ProjectCatalogV2Envelope =>
                envelope.candidate?.revision === revision ? { ...envelope, candidate: null } : envelope;
            await this.dependencies.writeBackend(discard(backend.envelope));
            await this.dependencies.writeReplica(discard(replica.envelope));
            return this.reconcileNow();
        });
    }

    public discardRecoveryState(): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueue(async () => {
            const backend = readProjectCatalogV2Envelope(this.dependencies.readBackend());
            const replica = readProjectCatalogV2Envelope(this.dependencies.readReplica());
            const sanitize = (envelope: ProjectCatalogV2Envelope): ProjectCatalogV2Envelope => ({
                ...envelope,
                candidate: null,
            });
            await this.dependencies.writeBackend(sanitize(backend.envelope));
            await this.dependencies.writeReplica(sanitize(replica.envelope));
            return this.reconcileNow();
        });
    }

    private async reconcileNow(persist = true): Promise<ProjectCatalogV2CommitResult> {
        const backend = readProjectCatalogV2Envelope(this.dependencies.readBackend());
        const replica = readProjectCatalogV2Envelope(this.dependencies.readReplica());
        let document = backend.document || replica.document;
        if (backend.document && replica.document) {
            document = mergeProjectCatalogV2Documents(backend.document, replica.document);
        }
        const candidates = [backend.envelope.candidate, replica.envelope.candidate]
            .filter((slot): slot is ProjectCatalogV2RevisionSlot => Boolean(slot));
        const recoveryCandidates = Array.from(
            new Map(candidates.map(slot => [slot.revision, slot])).values(),
        ).sort((left, right) => left.revision.localeCompare(right.revision));
        const activeSlots = [backend.envelope.active, replica.envelope.active]
            .filter((slot): slot is ProjectCatalogV2RevisionSlot => Boolean(slot));
        const activeByRevision = new Map(activeSlots.map(slot => [slot.revision, slot]));
        const baseEnvelope = backend.envelope.candidate ? backend.envelope
            : replica.envelope.candidate ? replica.envelope
                : backend.document ? backend.envelope : replica.envelope;
        if (!document) {
            return {
                envelope: baseEnvelope,
                document: null,
                recoveryRequired: backend.recoveryRequired || replica.recoveryRequired,
                recoveryCandidates,
            };
        }
        const candidatesAlreadyActive = recoveryCandidates.length > 0
            && recoveryCandidates.every(slot => activeByRevision.has(slot.revision));
        if (candidatesAlreadyActive) {
            const confirmedRevision = recoveryCandidates[0].revision;
            const confirmedEnvelope = backend.envelope.active?.revision === confirmedRevision
                ? backend.envelope : replica.envelope;
            let envelope: ProjectCatalogV2Envelope = { ...confirmedEnvelope, candidate: null };
            if (envelope.active?.revision !== createProjectCatalogV2RevisionSlot(document).revision) {
                envelope = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(envelope, document));
            }
            if (persist) {
                await this.dependencies.writeBackend(envelope);
                await this.dependencies.writeReplica(envelope);
            }
            return { envelope, document, recoveryRequired: false, recoveryCandidates: [] };
        }
        const recoveryRequired = backend.recoveryRequired || replica.recoveryRequired;
        if (recoveryRequired) {
            return {
                envelope: baseEnvelope,
                document,
                recoveryRequired: true,
                recoveryCandidates,
            };
        }
        let envelope = baseEnvelope;
        const documentRevision = createProjectCatalogV2RevisionSlot(document).revision;
        if (!envelope.active || envelope.active.revision !== documentRevision) {
            envelope = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(envelope, document));
            if (persist) {
                await this.dependencies.writeBackend(envelope);
                await this.dependencies.writeReplica(envelope);
            }
        } else if (persist) {
            if (JSON.stringify(backend.envelope) !== JSON.stringify(envelope)) {
                await this.dependencies.writeBackend(envelope);
            }
            if (JSON.stringify(replica.envelope) !== JSON.stringify(envelope)) {
                await this.dependencies.writeReplica(envelope);
            }
        }
        return {
            envelope,
            document,
            recoveryRequired: false,
            recoveryCandidates,
        };
    }

    private async activateDocument(
        envelope: ProjectCatalogV2Envelope,
        document: ProjectCatalogV2Document,
    ): Promise<ProjectCatalogV2CommitResult> {
        const staged = stageProjectCatalogV2Candidate(envelope, document);
        await this.dependencies.writeReplica(staged);
        await this.dependencies.writeBackend(staged);
        const active = activateProjectCatalogV2Candidate(staged);
        await this.dependencies.writeBackend(active);
        await this.dependencies.writeReplica(active);
        return {
            envelope: active,
            document: active.active!.document,
            recoveryRequired: false,
            recoveryCandidates: [],
        };
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
