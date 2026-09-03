'use strict';

import * as crypto from 'crypto';

import { parseProjectCatalogV2Document } from './merge';
import {
    ProjectCatalogV2Document,
    ProjectCatalogV2Envelope,
    ProjectCatalogV2RevisionSlot,
} from './types';

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
}

export function projectCatalogV2Checksum(document: ProjectCatalogV2Document): string {
    const parsed = parseProjectCatalogV2Document(document);
    if (!parsed) throw new Error('project catalog V2 document is invalid');
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(parsed))).digest('hex');
}

export function createProjectCatalogV2RevisionSlot(
    document: ProjectCatalogV2Document,
): ProjectCatalogV2RevisionSlot {
    const parsed = parseProjectCatalogV2Document(document);
    if (!parsed) throw new Error('project catalog V2 document is invalid');
    const checksum = projectCatalogV2Checksum(parsed);
    return { revision: checksum, checksum, document: parsed };
}

function parseSlot(raw: unknown): ProjectCatalogV2RevisionSlot | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const slot = raw as Record<string, unknown>;
    if (Object.keys(slot).sort().join('\n') !== ['checksum', 'document', 'revision'].join('\n')
        || typeof slot.revision !== 'string'
        || typeof slot.checksum !== 'string') return null;
    const document = parseProjectCatalogV2Document(slot.document);
    if (!document) return null;
    const checksum = projectCatalogV2Checksum(document);
    if (slot.checksum !== checksum || slot.revision !== checksum) return null;
    return { revision: checksum, checksum, document };
}

export function createEmptyProjectCatalogV2Envelope(): ProjectCatalogV2Envelope {
    return { schemaVersion: 2, activeRevision: null, active: null, previous: null, candidate: null };
}

export function parseProjectCatalogV2Envelope(raw: unknown): ProjectCatalogV2Envelope | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const envelope = raw as Record<string, unknown>;
    if (Object.keys(envelope).sort().join('\n')
        !== ['active', 'activeRevision', 'candidate', 'previous', 'schemaVersion'].join('\n')
        || envelope.schemaVersion !== 2
        || (envelope.activeRevision !== null && typeof envelope.activeRevision !== 'string')) return null;
    const active = envelope.active === null ? null : parseSlot(envelope.active);
    const previous = envelope.previous === null ? null : parseSlot(envelope.previous);
    const candidate = envelope.candidate === null ? null : parseSlot(envelope.candidate);
    if ((envelope.active !== null && !active)
        || (envelope.previous !== null && !previous)
        || (envelope.candidate !== null && !candidate)
        || (active ? envelope.activeRevision !== active.revision : envelope.activeRevision !== null)) {
        return null;
    }
    return { schemaVersion: 2, activeRevision: envelope.activeRevision as string | null, active, previous, candidate };
}

export interface ProjectCatalogV2EnvelopeReadResult {
    envelope: ProjectCatalogV2Envelope;
    document: ProjectCatalogV2Document | null;
    source: 'active' | 'previous' | 'empty';
    recoveryRequired: boolean;
}

export function readProjectCatalogV2Envelope(raw: unknown): ProjectCatalogV2EnvelopeReadResult {
    const parsed = parseProjectCatalogV2Envelope(raw);
    if (parsed?.active) {
        return {
            envelope: parsed,
            document: parsed.active.document,
            source: 'active',
            recoveryRequired: parsed.candidate !== null,
        };
    }
    if (parsed?.previous) {
        return { envelope: parsed, document: parsed.previous.document, source: 'previous', recoveryRequired: true };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const previous = parseSlot((raw as Record<string, unknown>).previous);
        if (previous) {
            const recovered: ProjectCatalogV2Envelope = {
                schemaVersion: 2,
                activeRevision: previous.revision,
                active: previous,
                previous: null,
                candidate: null,
            };
            return { envelope: recovered, document: previous.document, source: 'previous', recoveryRequired: true };
        }
    }
    return {
        envelope: parsed || createEmptyProjectCatalogV2Envelope(),
        document: null,
        source: 'empty',
        recoveryRequired: raw !== null && raw !== undefined
            && (!parsed || parsed.candidate !== null),
    };
}

export function stageProjectCatalogV2Candidate(
    envelope: ProjectCatalogV2Envelope,
    document: ProjectCatalogV2Document,
): ProjectCatalogV2Envelope {
    const parsed = parseProjectCatalogV2Envelope(envelope);
    if (!parsed) throw new Error('project catalog V2 envelope is invalid');
    return { ...parsed, candidate: createProjectCatalogV2RevisionSlot(document) };
}

export function activateProjectCatalogV2Candidate(
    envelope: ProjectCatalogV2Envelope,
): ProjectCatalogV2Envelope {
    const parsed = parseProjectCatalogV2Envelope(envelope);
    if (!parsed?.candidate) throw new Error('project catalog V2 candidate is missing');
    return {
        schemaVersion: 2,
        activeRevision: parsed.candidate.revision,
        active: parsed.candidate,
        previous: parsed.active || parsed.previous,
        candidate: null,
    };
}
