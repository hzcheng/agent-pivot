'use strict';

import {
    activateProjectCatalogV2Candidate,
    readProjectCatalogV2Envelope,
    stageProjectCatalogV2Candidate,
} from './envelope';
import { mergeProjectCatalogV2Documents } from './merge';
import { ProjectCatalogV2Document, ProjectCatalogV2Envelope } from './types';

export interface ProjectCatalogV2CommitDependencies {
    readBackend(): unknown;
    writeBackend(envelope: ProjectCatalogV2Envelope): Thenable<void>;
    readReplica(): unknown;
    writeReplica(envelope: ProjectCatalogV2Envelope): Thenable<void>;
}

export interface ProjectCatalogV2CommitResult {
    envelope: ProjectCatalogV2Envelope;
    document: ProjectCatalogV2Document | null;
    recoveryRequired: boolean;
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
            const merged = current.document
                ? mergeProjectCatalogV2Documents(current.document, document)
                : document;
            const staged = stageProjectCatalogV2Candidate(current.envelope, merged);
            await this.dependencies.writeReplica(staged);
            await this.dependencies.writeBackend(staged);
            const active = activateProjectCatalogV2Candidate(staged);
            await this.dependencies.writeBackend(active);
            await this.dependencies.writeReplica(active);
            return { envelope: active, document: active.active!.document, recoveryRequired: false };
        });
    }

    private async reconcileNow(persist = true): Promise<ProjectCatalogV2CommitResult> {
        const backend = readProjectCatalogV2Envelope(this.dependencies.readBackend());
        const replica = readProjectCatalogV2Envelope(this.dependencies.readReplica());
        let document = backend.document || replica.document;
        if (backend.document && replica.document) {
            document = mergeProjectCatalogV2Documents(backend.document, replica.document);
        }
        const baseEnvelope = backend.document ? backend.envelope : replica.envelope;
        if (!document) {
            return {
                envelope: baseEnvelope,
                document: null,
                recoveryRequired: backend.recoveryRequired || replica.recoveryRequired,
            };
        }
        let envelope = baseEnvelope;
        if (!envelope.active || JSON.stringify(envelope.active.document) !== JSON.stringify(document)) {
            envelope = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(envelope, document));
            if (persist) {
                await this.dependencies.writeBackend(envelope);
                await this.dependencies.writeReplica(envelope);
            }
        } else if (persist && JSON.stringify(replica.envelope) !== JSON.stringify(envelope)) {
            await this.dependencies.writeReplica(envelope);
        }
        return {
            envelope,
            document,
            recoveryRequired: backend.recoveryRequired || replica.recoveryRequired,
        };
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
