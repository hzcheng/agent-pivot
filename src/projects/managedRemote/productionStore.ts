'use strict';

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';

import { cloneManagedValue, stableManagedValue } from './causal';
import {
    ManagedCatalogBackend,
    ManagedCatalogReplicaFacade,
} from './store';
import {
    ManagedCatalogEnvelopeV1,
    ManagedCatalogWriterReplicaV1,
} from './types';

export interface ManagedRemoteConfigurationLike {
    get<T>(section: string): T | undefined;
    update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
}

export interface ManagedRemoteMementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export class ConfigurationManagedCatalogBackend implements ManagedCatalogBackend {
    private readonly acquire: () => ManagedRemoteConfigurationLike;

    /**
     * `configuration` may be a provider or a single object.
     *
     * `vscode.workspace.getConfiguration` returns a snapshot that never
     * observes later writes, so holding one for the lifetime of the extension
     * makes every read after a write return the value from activation: a
     * Machine the user just added never reads back and the panel stays empty.
     * Prefer passing a provider so each access re-acquires.
     */
    constructor(
        configuration: ManagedRemoteConfigurationLike
            | (() => ManagedRemoteConfigurationLike),
        private readonly key: string,
        private readonly globalTarget: vscode.ConfigurationTarget,
    ) {
        this.acquire = typeof configuration === 'function'
            ? configuration
            : () => configuration;
    }

    read(): unknown {
        return cloneManagedValue(this.acquire().get(this.key));
    }

    write(value: ManagedCatalogEnvelopeV1): Thenable<void> {
        return this.acquire().update(
            this.key,
            cloneManagedValue(value),
            this.globalTarget,
        );
    }
}

function isWriterReplica(value: unknown): value is ManagedCatalogWriterReplicaV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const record = value as Record<string, unknown>;
    return typeof record.actorId === 'string'
        && Boolean(record.actorId)
        && Number.isSafeInteger(record.nextCounter)
        && Number(record.nextCounter) > 0
        && Boolean(record.envelope && typeof record.envelope === 'object');
}

export class MementoManagedCatalogReplicaFacade implements ManagedCatalogReplicaFacade {
    private allocatedIdentity?: { writerId: string; actorId: string };

    constructor(
        private readonly memento: ManagedRemoteMementoLike,
        private readonly keyPrefix: string,
        private readonly writerIdentityMemento: ManagedRemoteMementoLike,
        private readonly createIdentity: () => string = () => randomBytes(16).toString('hex'),
    ) {
    }

    async allocateWriter(): Promise<{ writerId: string; actorId: string }> {
        const persisted = this.writerIdentityMemento.get<unknown>(this.writerIdentityKey());
        if (isWriterIdentity(persisted)) {
            this.allocatedIdentity = cloneManagedValue(persisted);
            return cloneManagedValue(persisted);
        }
        const identity = {
            writerId: this.createIdentity(),
            actorId: `catalog-actor:${this.createIdentity()}`,
        };
        this.allocatedIdentity = identity;
        return identity;
    }

    readWriter(writerId: string): ManagedCatalogWriterReplicaV1 | null {
        this.assertWriterId(writerId);
        const value = this.readWriterMap()[writerId];
        return isWriterReplica(value) ? cloneManagedValue(value) : null;
    }

    readWriters(): Array<{ writerId: string; value: ManagedCatalogWriterReplicaV1 }> {
        return Object.entries(this.readWriterMap())
            .sort(([left], [right]) => left.localeCompare(right))
            .reduce<Array<{
            writerId: string;
            value: ManagedCatalogWriterReplicaV1;
        }>>((result, [writerId, value]) => {
            if (isWriterReplica(value)) {
                result.push({
                    writerId,
                    value: cloneManagedValue(value),
                });
            }
            return result;
        }, []);
    }

    async writeWriter(
        writerId: string,
        value: ManagedCatalogWriterReplicaV1,
    ): Promise<void> {
        this.assertWriterId(writerId);
        if (this.allocatedIdentity?.writerId === writerId) {
            const persisted = this.writerIdentityMemento.get<unknown>(this.writerIdentityKey());
            if (!isWriterIdentity(persisted)
                || persisted.writerId !== this.allocatedIdentity.writerId
                || persisted.actorId !== this.allocatedIdentity.actorId) {
                await this.writerIdentityMemento.update(
                    this.writerIdentityKey(),
                    cloneManagedValue(this.allocatedIdentity),
                );
            }
        }
        // Memento has no compare-and-set operation. Verify our entry after every
        // whole-map update and retry with the latest peer entries when another
        // window raced the write. Each writer only changes its own immutable ID.
        for (;;) {
            const writers = this.readWriterMap();
            writers[writerId] = cloneManagedValue(value);
            await this.memento.update(this.writerMapKey(), writers);
            const persisted = this.readWriterMap()[writerId];
            if (isWriterReplica(persisted)
                && stableManagedValue(persisted) === stableManagedValue(value)) {
                return;
            }
        }
    }

    private readWriterMap(): Record<string, unknown> {
        const value = this.memento.get<unknown>(this.writerMapKey());
        return value && typeof value === 'object' && !Array.isArray(value)
            ? cloneManagedValue(value as Record<string, unknown>)
            : {};
    }

    private assertWriterId(writerId: string): void {
        if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(writerId)) {
            throw new Error('Managed Remote writer identity is invalid.');
        }
    }

    private writerMapKey(): string {
        return `${this.keyPrefix}.writers`;
    }

    private writerIdentityKey(): string {
        return `${this.keyPrefix}.writerIdentity`;
    }
}

function isWriterIdentity(value: unknown): value is { writerId: string; actorId: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const record = value as Record<string, unknown>;
    return typeof record.writerId === 'string'
        && /^[A-Za-z0-9._:-]{1,256}$/u.test(record.writerId)
        && typeof record.actorId === 'string'
        && /^[A-Za-z0-9._:-]{1,256}$/u.test(record.actorId);
}
