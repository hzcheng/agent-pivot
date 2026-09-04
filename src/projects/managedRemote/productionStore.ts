'use strict';

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';

import { cloneManagedValue } from './causal';
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
    constructor(
        private readonly configuration: ManagedRemoteConfigurationLike,
        private readonly key: string,
        private readonly globalTarget: vscode.ConfigurationTarget,
    ) {
    }

    read(): unknown {
        return cloneManagedValue(this.configuration.get(this.key));
    }

    write(value: ManagedCatalogEnvelopeV1): Thenable<void> {
        return this.configuration.update(
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
            return cloneManagedValue(persisted);
        }
        const unfinished = Object.entries(this.readWriterMap())
            .map(([writerId, value]) => ({ writerId, value }))
            .filter(entry => isWriterReplica(entry.value) && entry.value.stagedCandidate)
            .sort((left, right) => left.writerId.localeCompare(right.writerId))[0];
        if (unfinished && isWriterReplica(unfinished.value)) {
            const identity = {
                writerId: unfinished.writerId,
                actorId: unfinished.value.actorId,
            };
            await this.writerIdentityMemento.update(this.writerIdentityKey(), identity);
            return identity;
        }
        const identity = {
            writerId: this.createIdentity(),
            actorId: `catalog-actor:${this.createIdentity()}`,
        };
        await this.writerIdentityMemento.update(this.writerIdentityKey(), identity);
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
        const writers = this.readWriterMap();
        writers[writerId] = cloneManagedValue(value);
        await this.memento.update(this.writerMapKey(), writers);
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
