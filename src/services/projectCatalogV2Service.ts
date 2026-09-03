'use strict';

import * as crypto from 'crypto';

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
import { deterministicProjectCatalogV2Id } from '../projects/catalogV2/identity';
import {
    ProjectCatalogV2EntityKind,
    ProjectCatalogV2Document,
    ProjectCatalogV2FieldValue,
    ProjectCatalogV2Materialized,
} from '../projects/catalogV2/types';

const ACTOR_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface ProjectCatalogV2ServiceOptions extends ProjectCatalogV2CommitDependencies {
    createUniqueCatalogActorId?: () => string;
    recordCatalogActorId?: (actorId: string) => Thenable<void>;
}

export class ProjectCatalogV2Service {
    private readonly commits: ProjectCatalogV2CommitCoordinator;
    private mutationQueue: Promise<void> = Promise.resolve();
    private readonly actorId: string;
    private readonly actorReady: Promise<void>;

    public constructor(private readonly options: ProjectCatalogV2ServiceOptions) {
        this.commits = new ProjectCatalogV2CommitCoordinator({
            ...options,
            validateDocument: document => this.validateWritableCatalog(document),
        });
        this.actorId = (options.createUniqueCatalogActorId
            || (() => crypto.randomBytes(16).toString('hex')))();
        if (!ACTOR_ID_PATTERN.test(this.actorId)) {
            throw new Error('project catalog V2 unique actor generator returned an invalid id');
        }
        this.actorReady = options.recordCatalogActorId
            ? Promise.resolve(options.recordCatalogActorId(this.actorId))
            : Promise.resolve();
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
            let document = applyProjectCatalogV2Patch(
                current.document || createEmptyProjectCatalogV2(),
                kind,
                entityId,
                values,
                actorId,
            );
            if (kind === 'machines') {
                const patchedCatalog = materializeProjectCatalogV2(document);
                if (!patchedCatalog.environments.some(environment =>
                    environment.machineId === entityId && environment.kind === 'host')) {
                    const hostId = deterministicProjectCatalogV2Id(`host-environment:${entityId}`);
                    document = applyProjectCatalogV2Patch(document, 'environments', hostId, {
                        machineId: entityId,
                        kind: 'host',
                        displayName: 'Host',
                        position: `host:${hostId}`,
                        launchAnchor: null,
                    }, actorId);
                }
            }
            this.validateWritableCatalog(document);
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
            const catalog = materializeProjectCatalogV2(
                current.document || createEmptyProjectCatalogV2(),
            );
            let document = current.document || createEmptyProjectCatalogV2();
            if (kind === 'machines') {
                const environments = catalog.environments.filter(environment =>
                    fieldCandidateStrings(document, 'environments', environment.id, 'machineId').includes(entityId));
                if (environments.some(environment =>
                    new Set(fieldCandidateStrings(document, 'environments', environment.id, 'machineId')).size > 1)) {
                    throw new Error('project catalog V2 Machine is referenced by an unresolved Environment placement');
                }
                if (environments.some(environment => {
                    const kinds = new Set(fieldCandidateStrings(
                        document,
                        'environments',
                        environment.id,
                        'kind',
                    ));
                    return kinds.size !== 1 || !kinds.has('host');
                })) {
                    throw new Error('project catalog V2 Machine still contains a non-Host Environment or unresolved Environment kind');
                }
                const environmentIds = new Set(environments.map(environment => environment.id));
                if (catalog.projects.some(project =>
                    fieldCandidateStrings(document, 'projects', project.id, 'environmentId')
                        .some(environmentId => environmentIds.has(environmentId)))) {
                    throw new Error('project catalog V2 Machine still contains a Project');
                }
                for (const environment of environments) {
                    document = deleteProjectCatalogV2Entity(document, 'environments', environment.id, actorId);
                }
            }
            if (kind === 'environments' && catalog.projects.some(project =>
                fieldCandidateStrings(document, 'projects', project.id, 'environmentId').includes(entityId))) {
                throw new Error('project catalog V2 Environment still contains a Project');
            }
            if (kind === 'environments' && catalog.environments.some(environment =>
                environment.id === entityId && environment.kind === 'host')) {
                throw new Error('project catalog V2 Host environment cannot be deleted separately');
            }
            document = deleteProjectCatalogV2Entity(
                document,
                kind,
                entityId,
                actorId,
            );
            this.validateWritableCatalog(document);
            return this.commits.commit(document);
        });
    }

    public activateRecoveryCandidate(revision: string): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueueMutation(() => this.commits.activateRecoveryCandidate(revision));
    }

    public discardRecoveryCandidate(revision: string): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueueMutation(() => this.commits.discardRecoveryCandidate(revision));
    }

    public discardRecoveryState(): Promise<ProjectCatalogV2CommitResult> {
        return this.enqueueMutation(() => this.commits.discardRecoveryState());
    }

    private getActorId(): Promise<string> {
        return this.actorReady.then(() => this.actorId);
    }

    private validateWritableCatalog(document: ProjectCatalogV2CommitResult['document']): void {
        if (!document) { throw new Error('project catalog V2 document is missing'); }
        const catalog = materializeProjectCatalogV2(document);
        if (catalog.conflicts.some(conflict => conflict.kind === 'missing-parent')) {
            throw new Error('project catalog V2 mutation would create a missing parent');
        }
        if (catalog.conflicts.some(conflict => conflict.kind === 'duplicate-host')) {
            throw new Error('project catalog V2 Machine cannot contain multiple Host environments');
        }
        if (catalog.conflicts.some(conflict => conflict.kind === 'missing-host')) {
            throw new Error('project catalog V2 Machine must contain exactly one Host environment');
        }
    }

    private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}

function fieldCandidateStrings(
    document: ProjectCatalogV2Document,
    kind: 'environments' | 'projects',
    entityId: string,
    field: 'machineId' | 'environmentId' | 'kind',
): string[] {
    const register = document[kind][entityId]?.fields[field];
    if (!register) { return []; }
    return Array.from(new Set(register.candidates
        .map(candidate => candidate.value)
        .filter((value): value is string => typeof value === 'string')));
}
