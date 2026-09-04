'use strict';

import { createHash } from 'crypto';

import {
    cloneManagedValue,
    createCausalVersion,
    createVersionedCandidates,
    joinVersionVectors,
    joinVersionedCandidates,
    normalizeVersionedCandidates,
    stableManagedValue,
    vectorIncludingVersion,
} from './causal';
import { joinManagedRemoteCatalogs, normalizeManagedRemoteCatalog } from './merge';
import {
    ChecksummedLegacySnapshot,
    ManagedAuthorityState,
    ManagedCatalogEnvelopeV1,
    ManagedMigrationJournal,
    ManagedRevisionSlot,
    ManagedRollbackJournal,
    VersionedCandidate,
    VersionedCandidates,
    VersionVector,
} from './types';
import { isCausalVersion, parseManagedRemoteCatalog } from './validation';

export interface ManagedEnvelopeParseResult {
    envelope: ManagedCatalogEnvelopeV1;
    issues: string[];
    recoveryCandidates: ManagedRevisionSlot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const keys = Object.keys(value);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function validVector(value: unknown): value is VersionVector {
    return isRecord(value) && Object.keys(value).every(actorId =>
        Boolean(actorId)
        && Number.isSafeInteger(value[actorId])
        && (value[actorId] as number) >= 0);
}

function vectorCoversCandidate<T>(
    vector: VersionVector,
    candidate: VersionedCandidate<T>,
): boolean {
    return (vector[candidate.version.dot.actorId] || 0) >= candidate.version.dot.counter
        && Object.keys(candidate.version.context).every(actorId =>
            (vector[actorId] || 0) >= candidate.version.context[actorId]);
}

export function checksumManagedValue(value: unknown): string {
    return createHash('sha256').update(stableManagedValue(value), 'utf8').digest('hex');
}

export function createManagedRevisionSlot(documentValue: unknown): ManagedRevisionSlot {
    const parsed = parseManagedRemoteCatalog(documentValue);
    if (!parsed) {
        throw new Error('Cannot create a revision from an invalid Managed Remote catalog.');
    }
    const document = normalizeManagedRemoteCatalog(parsed);
    const checksum = checksumManagedValue(document);
    return {
        revisionId: `revision:${checksum}`,
        checksum,
        document,
    };
}

function parseRevisionSlot(value: unknown): ManagedRevisionSlot | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['revisionId', 'checksum', 'document'])
        || typeof value.revisionId !== 'string'
        || !value.revisionId
        || typeof value.checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.checksum)) {
        return null;
    }
    const document = parseManagedRemoteCatalog(value.document);
    if (!document || checksumManagedValue(normalizeManagedRemoteCatalog(document)) !== value.checksum) {
        return null;
    }
    return {
        revisionId: value.revisionId,
        checksum: value.checksum,
        document: normalizeManagedRemoteCatalog(document),
    };
}

function parseLegacySnapshot(value: unknown): ChecksummedLegacySnapshot | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['checksum', 'projectData', 'projectSyncData'])
        || typeof value.checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.checksum)) {
        return null;
    }
    const snapshot = {
        projectData: cloneManagedValue(value.projectData),
        projectSyncData: cloneManagedValue(value.projectSyncData),
    };
    return checksumManagedValue(snapshot) === value.checksum
        ? { checksum: value.checksum, ...snapshot }
        : null;
}

function parseAuthority(value: unknown): ManagedAuthorityState | null {
    if (!isRecord(value)
        || !hasExactKeys(
            value,
            ['lifecycle'],
            ['active', 'previous', 'migrationPlanId', 'rollbackPlanId'],
        )
        || !['disabled', 'preview', 'active', 'rolledBack'].includes(value.lifecycle as string)
        || (value.migrationPlanId !== undefined && typeof value.migrationPlanId !== 'string')
        || (value.rollbackPlanId !== undefined && typeof value.rollbackPlanId !== 'string')) {
        return null;
    }
    const active = value.active === undefined ? undefined : parseRevisionSlot(value.active);
    const previous = value.previous === undefined ? undefined : parseRevisionSlot(value.previous);
    if ((value.active !== undefined && !active) || (value.previous !== undefined && !previous)) {
        return null;
    }
    if (value.lifecycle === 'active' && !active) {
        return null;
    }
    return {
        lifecycle: value.lifecycle as ManagedAuthorityState['lifecycle'],
        ...(active ? { active } : {}),
        ...(previous ? { previous } : {}),
        ...(value.migrationPlanId ? { migrationPlanId: value.migrationPlanId } : {}),
        ...(value.rollbackPlanId ? { rollbackPlanId: value.rollbackPlanId } : {}),
    };
}

function parseMigration(value: unknown): ManagedMigrationJournal | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['planId', 'phase', 'frozenLegacy', 'candidate'])
        || typeof value.planId !== 'string'
        || !value.planId
        || !['prepared', 'localReady', 'active', 'complete'].includes(value.phase as string)) {
        return null;
    }
    const frozenLegacy = parseLegacySnapshot(value.frozenLegacy);
    const candidate = parseRevisionSlot(value.candidate);
    return frozenLegacy && candidate ? {
        planId: value.planId,
        phase: value.phase as ManagedMigrationJournal['phase'],
        frozenLegacy,
        candidate,
    } : null;
}

function parseRollback(value: unknown): ManagedRollbackJournal | null {
    if (!isRecord(value)
        || !hasExactKeys(value, ['planId', 'phase', 'target'])
        || typeof value.planId !== 'string'
        || !value.planId
        || !['prepared', 'legacyRestored', 'rolledBack'].includes(value.phase as string)) {
        return null;
    }
    const target = parseLegacySnapshot(value.target);
    return target ? {
        planId: value.planId,
        phase: value.phase as ManagedRollbackJournal['phase'],
        target,
    } : null;
}

function parseRegister<T>(
    value: unknown,
    vector: VersionVector,
    parseValue: (candidate: unknown) => T | null,
    allowNull: boolean,
    issuePrefix: string,
    issues: string[],
): VersionedCandidates<T | null> | null {
    if (!isRecord(value) || !hasExactKeys(value, ['candidates']) || !Array.isArray(value.candidates)) {
        issues.push(`${issuePrefix}:invalid-register`);
        return null;
    }
    const candidates: VersionedCandidate<T | null>[] = [];
    value.candidates.forEach((rawCandidate, index) => {
        if (!isRecord(rawCandidate)
            || !hasExactKeys(rawCandidate, ['value', 'version'])
            || !isCausalVersion(rawCandidate.version)) {
            issues.push(`${issuePrefix}:invalid-candidate:${index}`);
            return;
        }
        const parsedValue = rawCandidate.value === null && allowNull
            ? null
            : parseValue(rawCandidate.value);
        if (parsedValue === null && !(allowNull && rawCandidate.value === null)) {
            issues.push(`${issuePrefix}:invalid-value:${index}`);
            return;
        }
        const candidate = {
            value: parsedValue,
            version: cloneManagedValue(rawCandidate.version),
        } as VersionedCandidate<T | null>;
        if (!vectorCoversCandidate(vector, candidate)) {
            issues.push(`${issuePrefix}:uncovered-version:${index}`);
            return;
        }
        candidates.push(candidate);
    });
    if (!candidates.length) {
        return null;
    }
    try {
        return normalizeVersionedCandidates({ candidates });
    } catch (_error) {
        issues.push(`${issuePrefix}:causal-corruption`);
        return null;
    }
}

function parseRegisterMap<T>(
    value: unknown,
    vector: VersionVector,
    parseValue: (candidate: unknown) => T | null,
    issuePrefix: string,
    issues: string[],
): Record<string, VersionedCandidates<T | null>> | null {
    if (!isRecord(value)) {
        return null;
    }
    const result: Record<string, VersionedCandidates<T | null>> = {};
    for (const id of Object.keys(value).sort()) {
        const register = parseRegister(value[id], vector, parseValue, true, `${issuePrefix}:${id}`, issues);
        if (register) {
            result[id] = register;
        }
    }
    return result;
}

export function parseManagedCatalogEnvelope(value: unknown): ManagedEnvelopeParseResult | null {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'envelopeVersion',
            'causalContext',
            'authority',
            'stagedRevisions',
            'migrationPlans',
            'rollbackPlans',
            'legacyDivergences',
        ])
        || value.envelopeVersion !== 1
        || !validVector(value.causalContext)) {
        return null;
    }
    const vector = cloneManagedValue(value.causalContext) as VersionVector;
    const issues: string[] = [];
    const recoveryCandidates: ManagedRevisionSlot[] = [];
    if (isRecord(value.authority) && Array.isArray(value.authority.candidates)) {
        for (const rawCandidate of value.authority.candidates) {
            if (!isRecord(rawCandidate) || !isRecord(rawCandidate.value)) { continue; }
            for (const key of ['active', 'previous']) {
                const slot = parseRevisionSlot(rawCandidate.value[key]);
                if (slot) { recoveryCandidates.push(slot); }
            }
        }
    }
    let authority = parseRegister(
        value.authority,
        vector,
        parseAuthority,
        false,
        'authority',
        issues,
    );
    const stagedRevisions = parseRegisterMap(
        value.stagedRevisions,
        vector,
        parseRevisionSlot,
        'staged',
        issues,
    );
    const migrationPlans = parseRegisterMap(
        value.migrationPlans,
        vector,
        parseMigration,
        'migration',
        issues,
    );
    const rollbackPlans = parseRegisterMap(
        value.rollbackPlans,
        vector,
        parseRollback,
        'rollback',
        issues,
    );
    const legacyDivergences = parseRegisterMap(
        value.legacyDivergences,
        vector,
        parseLegacySnapshot,
        'legacy-divergence',
        issues,
    );
    if (!authority && recoveryCandidates.length
        && isRecord(value.authority)
        && Array.isArray(value.authority.candidates)) {
        const rawVersion = value.authority.candidates
            .map(candidate => isRecord(candidate) ? candidate.version : null)
            .find(isCausalVersion);
        if (rawVersion) {
            authority = createVersionedCandidates({
                lifecycle: 'preview',
                previous: recoveryCandidates.slice().sort((left, right) =>
                    left.revisionId.localeCompare(right.revisionId))[0],
            }, rawVersion);
            issues.push('authority:recovery-placeholder');
        }
    }
    if (!authority || !stagedRevisions || !migrationPlans || !rollbackPlans
        || !legacyDivergences) {
        return null;
    }
    for (const register of Object.values(stagedRevisions)) {
        for (const candidate of register.candidates) {
            if (candidate.value) { recoveryCandidates.push(candidate.value); }
        }
    }
    const uniqueRecovery = new Map<string, ManagedRevisionSlot>();
    for (const slot of recoveryCandidates) {
        uniqueRecovery.set(`${slot.revisionId}:${slot.checksum}`, slot);
    }
    return {
        envelope: normalizeManagedCatalogEnvelope({
            envelopeVersion: 1,
            causalContext: vector,
            authority: authority as VersionedCandidates<ManagedAuthorityState>,
            stagedRevisions,
            migrationPlans,
            rollbackPlans,
            legacyDivergences,
        }),
        issues: Array.from(new Set(issues)).sort(),
        recoveryCandidates: Array.from(uniqueRecovery.values()).sort((left, right) =>
            left.revisionId.localeCompare(right.revisionId)),
    };
}

function normalizeMap<T>(
    value: Record<string, VersionedCandidates<T | null>>,
): Record<string, VersionedCandidates<T | null>> {
    const result: Record<string, VersionedCandidates<T | null>> = {};
    for (const id of Object.keys(value || {}).sort()) {
        result[id] = normalizeVersionedCandidates(value[id]);
    }
    return result;
}

export function normalizeManagedCatalogEnvelope(
    envelope: ManagedCatalogEnvelopeV1,
): ManagedCatalogEnvelopeV1 {
    return {
        envelopeVersion: 1,
        causalContext: joinVersionVectors({}, envelope.causalContext),
        authority: normalizeVersionedCandidates(envelope.authority),
        stagedRevisions: normalizeMap(envelope.stagedRevisions),
        migrationPlans: normalizeMap(envelope.migrationPlans),
        rollbackPlans: normalizeMap(envelope.rollbackPlans),
        legacyDivergences: normalizeMap(envelope.legacyDivergences),
    };
}

export function createEmptyManagedCatalogEnvelope(actorId: string): ManagedCatalogEnvelopeV1 {
    const version = createCausalVersion({}, actorId);
    return normalizeManagedCatalogEnvelope({
        envelopeVersion: 1,
        causalContext: vectorIncludingVersion(version),
        authority: createVersionedCandidates({ lifecycle: 'disabled' }, version),
        stagedRevisions: {},
        migrationPlans: {},
        rollbackPlans: {},
        legacyDivergences: {},
    });
}

function joinMaps<T>(
    left: Record<string, VersionedCandidates<T | null>>,
    right: Record<string, VersionedCandidates<T | null>>,
): Record<string, VersionedCandidates<T | null>> {
    const result: Record<string, VersionedCandidates<T | null>> = {};
    for (const id of Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort()) {
        result[id] = left[id] && right[id]
            ? joinVersionedCandidates(left[id], right[id])
            : normalizeVersionedCandidates(left[id] || right[id]);
    }
    return result;
}

function collectRevisionSlots(envelope: ManagedCatalogEnvelopeV1): ManagedRevisionSlot[] {
    const slots: ManagedRevisionSlot[] = [];
    for (const candidate of envelope.authority.candidates) {
        if (candidate.value.active) { slots.push(candidate.value.active); }
        if (candidate.value.previous) { slots.push(candidate.value.previous); }
    }
    for (const register of Object.values(envelope.stagedRevisions)) {
        for (const candidate of register.candidates) {
            if (candidate.value) { slots.push(candidate.value); }
        }
    }
    for (const register of Object.values(envelope.migrationPlans)) {
        for (const candidate of register.candidates) {
            if (candidate.value) { slots.push(candidate.value.candidate); }
        }
    }
    return slots;
}

function assertRevisionIdentity(envelope: ManagedCatalogEnvelopeV1): void {
    const byId = new Map<string, string>();
    for (const slot of collectRevisionSlots(envelope)) {
        const fingerprint = stableManagedValue(slot);
        const existing = byId.get(slot.revisionId);
        if (existing && existing !== fingerprint) {
            throw new Error(`Managed revision ${slot.revisionId} has conflicting bytes.`);
        }
        byId.set(slot.revisionId, fingerprint);
    }
}

export function joinManagedCatalogEnvelopes(
    leftValue: ManagedCatalogEnvelopeV1,
    rightValue: ManagedCatalogEnvelopeV1,
): ManagedCatalogEnvelopeV1 {
    const leftParsed = parseManagedCatalogEnvelope(leftValue);
    const rightParsed = parseManagedCatalogEnvelope(rightValue);
    if (!leftParsed || !rightParsed
        || leftParsed.issues.length || rightParsed.issues.length) {
        throw new Error('Cannot join an invalid Managed Remote envelope.');
    }
    const joined = normalizeManagedCatalogEnvelope({
        envelopeVersion: 1,
        causalContext: joinVersionVectors(
            leftParsed.envelope.causalContext,
            rightParsed.envelope.causalContext,
        ),
        authority: joinVersionedCandidates(
            leftParsed.envelope.authority,
            rightParsed.envelope.authority,
        ),
        stagedRevisions: joinMaps(
            leftParsed.envelope.stagedRevisions,
            rightParsed.envelope.stagedRevisions,
        ),
        migrationPlans: joinMaps(
            leftParsed.envelope.migrationPlans,
            rightParsed.envelope.migrationPlans,
        ),
        rollbackPlans: joinMaps(
            leftParsed.envelope.rollbackPlans,
            rightParsed.envelope.rollbackPlans,
        ),
        legacyDivergences: joinMaps(
            leftParsed.envelope.legacyDivergences,
            rightParsed.envelope.legacyDivergences,
        ),
    });
    assertRevisionIdentity(joined);
    return joined;
}

export function mergeActiveAuthorityCandidates(
    envelopeValue: ManagedCatalogEnvelopeV1,
    actorId: string,
): ManagedCatalogEnvelopeV1 {
    const parsed = parseManagedCatalogEnvelope(envelopeValue);
    if (!parsed) {
        throw new Error('Cannot resolve an invalid Managed Remote envelope.');
    }
    const envelope = parsed.envelope;
    const active = envelope.authority.candidates
        .map(candidate => candidate.value)
        .filter(authority => authority.lifecycle === 'active' && authority.active);
    if (active.length < 2) {
        return envelope;
    }
    const document = active.slice(1).reduce(
        (merged, authority) => joinManagedRemoteCatalogs(merged, authority.active.document),
        active[0].active.document,
    );
    const slot = createManagedRevisionSlot(document);
    const version = createCausalVersion(envelope.causalContext, actorId);
    return normalizeManagedCatalogEnvelope({
        ...envelope,
        causalContext: joinVersionVectors(envelope.causalContext, vectorIncludingVersion(version)),
        authority: createVersionedCandidates({
            lifecycle: 'active',
            active: slot,
            previous: active[0].active,
        }, version),
    });
}

export function createChecksummedLegacySnapshot(
    projectData: unknown,
    projectSyncData: unknown,
): ChecksummedLegacySnapshot {
    const value = { projectData: cloneManagedValue(projectData), projectSyncData: cloneManagedValue(projectSyncData) };
    return { checksum: checksumManagedValue(value), ...value };
}
