'use strict';

import {
    ProjectCatalogV2CommitCoordinator,
    ProjectCatalogV2CommitDependencies,
    ProjectCatalogV2CommitResult,
} from '../projects/catalogV2/commitProtocol';
import {
    applyProjectCatalogV2Patch,
    createEmptyProjectCatalogV2,
    deleteProjectCatalogV2Entity,
    materializeProjectCatalogV2,
} from '../projects/catalogV2/merge';
import {
    ProjectCatalogV2EntityKind,
    ProjectCatalogV2FieldValue,
    ProjectCatalogV2Materialized,
} from '../projects/catalogV2/types';

const ACTOR_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface ProjectCatalogV2ServiceOptions extends ProjectCatalogV2CommitDependencies {
    getCatalogActorId(): unknown;
    updateCatalogActorId(actorId: string): Thenable<void>;
    createCatalogActorId(): string;
}

export class ProjectCatalogV2Service {
    private readonly commits: ProjectCatalogV2CommitCoordinator;
    private mutationQueue: Promise<void> = Promise.resolve();
    private actorIdFlight: Promise<string> | null = null;

    public constructor(private readonly options: ProjectCatalogV2ServiceOptions) {
        this.commits = new ProjectCatalogV2CommitCoordinator(options);
    }

    public async getCatalog(): Promise<ProjectCatalogV2Materialized> {
        const current = await this.commits.reconcile();
        return materializeProjectCatalogV2(current.document || createEmptyProjectCatalogV2());
    }

    public patch(
        kind: ProjectCatalogV2EntityKind,
        entityId: string,
        values: Record<string, ProjectCatalogV2FieldValue>,
    ): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueueMutation(async () => {
            const actorId = await this.getActorId();
            const current = await this.commits.reconcile();
            const document = applyProjectCatalogV2Patch(
                current.document || createEmptyProjectCatalogV2(),
                kind,
                entityId,
                values,
                actorId,
            );
            return this.commits.commit(document);
        });
    }

    public delete(
        kind: ProjectCatalogV2EntityKind,
        entityId: string,
    ): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueueMutation(async () => {
            const actorId = await this.getActorId();
            const current = await this.commits.reconcile();
            const document = deleteProjectCatalogV2Entity(
                current.document || createEmptyProjectCatalogV2(),
                kind,
                entityId,
                actorId,
            );
            return this.commits.commit(document);
        });
    }

    private getActorId(): Promise<string> {
        const current = this.options.getCatalogActorId();
        if (typeof current === 'string' && ACTOR_ID_PATTERN.test(current)) {
            return Promise.resolve(current);
        }
        if (this.actorIdFlight) return this.actorIdFlight;
        const create = async () => {
            const actorId = this.options.createCatalogActorId();
            if (!ACTOR_ID_PATTERN.test(actorId)) {
                throw new Error('project catalog V2 actor generator returned an invalid id');
            }
            await this.options.updateCatalogActorId(actorId);
            return actorId;
        };
        const flight = create();
        this.actorIdFlight = flight.then(actorId => {
            this.actorIdFlight = null;
            return actorId;
        }, error => {
            this.actorIdFlight = null;
            throw error;
        });
        return this.actorIdFlight;
    }

    private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
