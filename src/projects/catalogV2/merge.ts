'use strict';

import {
    PROJECT_CATALOG_V2_CANONICALIZATION_VERSION,
    PROJECT_CATALOG_V2_SCHEMA_VERSION,
    ProjectCatalogV2CausalVersion,
    ProjectCatalogV2Conflict,
    ProjectCatalogV2Document,
    ProjectCatalogV2EntityKind,
    ProjectCatalogV2EntityRecord,
    ProjectCatalogV2FieldCandidate,
    ProjectCatalogV2FieldRegister,
    ProjectCatalogV2FieldValue,
    ProjectCatalogV2Materialized,
} from './types';

const ACTOR_ID_PATTERN = /^[a-f0-9]{32}$/;
const ENTITY_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENTITIES_PER_KIND = 10_000;
const MAX_FIELDS_PER_ENTITY = 16;
const MAX_STRING_LENGTH = 8192;

const FIELD_SCHEMAS: Record<ProjectCatalogV2EntityKind, Record<string, (value: unknown) => boolean>> = {
    machines: {
        displayName: isString,
        color: isNullableShortString,
        position: isPosition,
        source: value => value === 'manual' || value === 'derived' || value === 'migration',
    },
    environments: {
        machineId: isEntityId,
        kind: value => value === 'host' || value === 'devContainer' || value === 'legacyRemote',
        displayName: isString,
        position: isPosition,
        launchAnchor: isNullableLaunchAnchor,
    },
    projects: {
        environmentId: isEntityId,
        name: isString,
        description: isNullableString,
        path: isString,
        position: isPosition,
        tags: isStringArray,
        favorite: value => typeof value === 'boolean',
        favoritePosition: value => value === null || isPosition(value),
        color: isNullableShortString,
        remoteType: isNullableShortString,
        legacyPlacement: isNullableLegacyPlacement,
    },
};

function clone<T>(value: T): T {
    return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(stableValue); }
    if (!value || typeof value !== 'object') { return value; }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
}

function stableSerialize(value: unknown): string {
    return JSON.stringify(stableValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isShortString(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isString(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH;
}

function isPosition(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isNullableShortString(value: unknown): boolean {
    return value === null || isShortString(value);
}

function isNullableString(value: unknown): boolean {
    return value === null || (typeof value === 'string' && value.length <= MAX_STRING_LENGTH);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function isNullableLaunchAnchor(value: unknown): boolean {
    if (value === null) { return true; }
    if (!isRecord(value) || !hasExactKeys(value, ['hostPath', 'configPath', 'sourceProjectId'])) { return false; }
    return isString(value.hostPath)
        && isString(value.configPath)
        && (value.sourceProjectId === null || isEntityId(value.sourceProjectId));
}

function isNullableLegacyPlacement(value: unknown): boolean {
    if (value === null) { return true; }
    if (!isRecord(value) || !hasExactKeys(value, [
        'groupId', 'groupName', 'groupOrder', 'projectOrder', 'favoriteOrder',
    ])) { return false; }
    return (value.groupId === null || typeof value.groupId === 'string')
        && (value.groupName === null || typeof value.groupName === 'string')
        && (value.groupOrder === null || isNonNegativeInteger(value.groupOrder))
        && (value.projectOrder === null || isNonNegativeInteger(value.projectOrder))
        && (value.favoriteOrder === null || isNonNegativeInteger(value.favoriteOrder));
}

function isNonNegativeInteger(value: unknown): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEntityId(value: unknown): boolean {
    return typeof value === 'string' && ENTITY_ID_PATTERN.test(value);
}

function isStringArray(value: unknown): boolean {
    return Array.isArray(value)
        && value.every(item => typeof item === 'string' && item.length > 0);
}

function sortedVector(raw: Record<string, number>): Record<string, number> {
    const vector: Record<string, number> = {};
    const actorIds = Object.keys(raw || {}).sort();
    for (const actorId of actorIds) {
        const counter = raw[actorId];
        if (!ACTOR_ID_PATTERN.test(actorId) || !isNonNegativeInteger(counter)) {
            throw new Error('project catalog V2 vector is invalid');
        }
        if (counter > 0) { vector[actorId] = counter; }
    }
    return vector;
}

function clock(version: ProjectCatalogV2CausalVersion): Record<string, number> {
    const result = sortedVector(version.context);
    result[version.dot.actorId] = Math.max(result[version.dot.actorId] || 0, version.dot.counter);
    return sortedVector(result);
}

function versionKey(version: ProjectCatalogV2CausalVersion): string {
    return `${version.dot.actorId}:${version.dot.counter}`;
}

function candidateKey(candidate: ProjectCatalogV2FieldCandidate): string {
    return `${versionKey(candidate.version)}:${stableSerialize(candidate.value)}`;
}

function dominatesVersion(
    left: ProjectCatalogV2CausalVersion,
    right: ProjectCatalogV2CausalVersion,
): boolean {
    const leftClock = clock(left);
    const rightClock = clock(right);
    return Object.keys(rightClock).every(actorId => (leftClock[actorId] || 0) >= rightClock[actorId]);
}

function concurrent(
    left: ProjectCatalogV2CausalVersion,
    right: ProjectCatalogV2CausalVersion,
): boolean {
    return !dominatesVersion(left, right) && !dominatesVersion(right, left);
}

function validateVersion(raw: unknown): ProjectCatalogV2CausalVersion {
    if (!isRecord(raw) || Object.keys(raw).sort().join('\n') !== ['context', 'dot'].join('\n')
        || !isRecord(raw.dot)
        || Object.keys(raw.dot).sort().join('\n') !== ['actorId', 'counter'].join('\n')
        || typeof raw.dot.actorId !== 'string'
        || !ACTOR_ID_PATTERN.test(raw.dot.actorId)
        || !isNonNegativeInteger(raw.dot.counter)
        || raw.dot.counter < 1
        || !isRecord(raw.context)) {
        throw new Error('project catalog V2 causal version is invalid');
    }
    const context = sortedVector(raw.context as Record<string, number>);
    if ((context[raw.dot.actorId] || 0) >= (raw.dot.counter as number)) {
        throw new Error('project catalog V2 dot must be newer than its context');
    }
    return {
        dot: { actorId: raw.dot.actorId, counter: raw.dot.counter as number },
        context,
    };
}

function pruneVersions(versions: ProjectCatalogV2CausalVersion[]): ProjectCatalogV2CausalVersion[] {
    const byDot = new Map<string, ProjectCatalogV2CausalVersion>();
    versions.map(validateVersion).forEach(version => byDot.set(versionKey(version), version));
    return Array.from(byDot.values())
        .filter(version => !Array.from(byDot.values()).some(other =>
            versionKey(other) !== versionKey(version) && dominatesVersion(other, version)))
        .sort((left, right) => versionKey(left).localeCompare(versionKey(right)));
}

function normalizeRegister(
    raw: unknown,
    validator: (value: unknown) => boolean,
): ProjectCatalogV2FieldRegister {
    if (!isRecord(raw)
        || Object.keys(raw).sort().join('\n') !== ['baselines', 'candidates'].join('\n')
        || !Array.isArray(raw.candidates)
        || !Array.isArray(raw.baselines)
        || raw.candidates.length === 0) {
        throw new Error('project catalog V2 field register is invalid');
    }
    const normalizeCandidate = (item: unknown): ProjectCatalogV2FieldCandidate => {
        if (!isRecord(item)
            || Object.keys(item).sort().join('\n') !== ['value', 'version'].join('\n')
            || !validator(item.value)) {
            throw new Error('project catalog V2 field candidate is invalid');
        }
        return { value: clone(item.value) as ProjectCatalogV2FieldValue, version: validateVersion(item.version) };
    };
    const normalizeSet = (items: unknown[]): Map<string, ProjectCatalogV2FieldCandidate> => {
        const byKey = new Map<string, ProjectCatalogV2FieldCandidate>();
        const versionsByDot = new Map<string, string>();
        for (const item of items) {
            const candidate = normalizeCandidate(item);
            const dot = versionKey(candidate.version);
            const serializedVersion = stableSerialize(candidate);
            if (versionsByDot.has(dot) && versionsByDot.get(dot) !== serializedVersion) {
                throw new Error('project catalog V2 reuses a dot for different candidates');
            }
            versionsByDot.set(dot, serializedVersion);
            byKey.set(candidateKey(candidate), candidate);
        }
        return byKey;
    };
    const byKey = normalizeSet(raw.candidates);
    const versionsByDot = new Map<string, string>();
    for (const candidate of [...byKey.values(), ...normalizeSet(raw.baselines).values()]) {
        const dot = versionKey(candidate.version);
        const serialized = stableSerialize(candidate);
        if (versionsByDot.has(dot) && versionsByDot.get(dot) !== serialized) {
            throw new Error('project catalog V2 reuses a dot for different candidates');
        }
        versionsByDot.set(dot, serialized);
    }
    const candidates = Array.from(byKey.values())
        .filter(candidate => !Array.from(byKey.values()).some(other =>
            versionKey(other.version) !== versionKey(candidate.version)
            && dominatesVersion(other.version, candidate.version)))
        .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
    const baselines = Array.from(normalizeSet(raw.baselines).values())
        .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
    return { candidates, baselines };
}

function normalizeRecord(kind: ProjectCatalogV2EntityKind, raw: unknown): ProjectCatalogV2EntityRecord {
    if (!isRecord(raw)
        || Object.keys(raw).sort().join('\n') !== ['fields', 'tombstones'].join('\n')
        || !isRecord(raw.fields)
        || !Array.isArray(raw.tombstones)
        || Object.keys(raw.fields).length > MAX_FIELDS_PER_ENTITY) {
        throw new Error('project catalog V2 entity record is invalid');
    }
    const schema = FIELD_SCHEMAS[kind];
    const actualFields = Object.keys(raw.fields).sort();
    const expectedFields = Object.keys(schema).sort();
    if (actualFields.length !== expectedFields.length
        || actualFields.some((field, index) => field !== expectedFields[index])) {
        throw new Error(`project catalog V2 ${kind} record must contain every field`);
    }
    const fields: Record<string, ProjectCatalogV2FieldRegister> = {};
    for (const field of Object.keys(raw.fields).sort()) {
        if (!schema[field]) {
            throw new Error(`project catalog V2 ${kind} field is invalid`);
        }
        fields[field] = normalizeRegister(raw.fields[field], schema[field]);
    }
    return { fields, tombstones: pruneVersions(raw.tombstones as ProjectCatalogV2CausalVersion[]) };
}

function normalizeCollection(kind: ProjectCatalogV2EntityKind, raw: unknown): Record<string, ProjectCatalogV2EntityRecord> {
    if (!isRecord(raw) || Object.keys(raw).length > MAX_ENTITIES_PER_KIND) {
        throw new Error(`project catalog V2 ${kind} collection is invalid`);
    }
    const result: Record<string, ProjectCatalogV2EntityRecord> = {};
    for (const id of Object.keys(raw).sort()) {
        if (!ENTITY_ID_PATTERN.test(id)) { throw new Error(`project catalog V2 ${kind} id is invalid`); }
        result[id] = normalizeRecord(kind, raw[id]);
    }
    return result;
}

export function createEmptyProjectCatalogV2(): ProjectCatalogV2Document {
    return {
        schemaVersion: PROJECT_CATALOG_V2_SCHEMA_VERSION,
        canonicalizationVersion: PROJECT_CATALOG_V2_CANONICALIZATION_VERSION,
        versionVector: {},
        machines: {},
        environments: {},
        projects: {},
    };
}

export function parseProjectCatalogV2Document(raw: unknown): ProjectCatalogV2Document | null {
    try {
        if (!isRecord(raw)
            || Object.keys(raw).sort().join('\n') !== [
                'canonicalizationVersion', 'environments', 'machines', 'projects', 'schemaVersion', 'versionVector',
            ].join('\n')
            || raw.schemaVersion !== PROJECT_CATALOG_V2_SCHEMA_VERSION
            || raw.canonicalizationVersion !== PROJECT_CATALOG_V2_CANONICALIZATION_VERSION
            || !isRecord(raw.versionVector)) {
            return null;
        }
        const document: ProjectCatalogV2Document = {
            schemaVersion: 2,
            canonicalizationVersion: 1,
            versionVector: sortedVector(raw.versionVector as Record<string, number>),
            machines: normalizeCollection('machines', raw.machines),
            environments: normalizeCollection('environments', raw.environments),
            projects: normalizeCollection('projects', raw.projects),
        };
        for (const kind of ['machines', 'environments', 'projects'] as ProjectCatalogV2EntityKind[]) {
            for (const record of Object.values(document[kind])) {
                const versions = [
                    ...record.tombstones,
                    ...Object.values(record.fields).reduce(
                        (all, register) => all.concat(
                            register.candidates.map(candidate => candidate.version),
                            register.baselines.map(candidate => candidate.version),
                        ),
                        [] as ProjectCatalogV2CausalVersion[],
                    ),
                ];
                for (const version of versions) {
                    const versionClock = clock(version);
                    if (Object.keys(versionClock).some(actorId =>
                        (document.versionVector[actorId] || 0) < versionClock[actorId])) {
                        throw new Error('project catalog V2 version exceeds the document vector');
                    }
                }
            }
        }
        return document;
    } catch (_error) {
        return null;
    }
}

function nextVersion(document: ProjectCatalogV2Document, actorId: string): ProjectCatalogV2CausalVersion {
    if (!ACTOR_ID_PATTERN.test(actorId)) { throw new Error('project catalog V2 actorId is invalid'); }
    const context = sortedVector(document.versionVector);
    return {
        dot: { actorId, counter: (context[actorId] || 0) + 1 },
        context,
    };
}

export function applyProjectCatalogV2Patch(
    rawDocument: ProjectCatalogV2Document,
    kind: ProjectCatalogV2EntityKind,
    entityId: string,
    patch: Record<string, ProjectCatalogV2FieldValue>,
    actorId: string,
): ProjectCatalogV2Document {
    const document = parseProjectCatalogV2Document(rawDocument);
    if (!document) { throw new Error('project catalog V2 document is invalid'); }
    if (!ENTITY_ID_PATTERN.test(entityId) || !isRecord(patch) || Object.keys(patch).length === 0) {
        throw new Error('project catalog V2 patch is invalid');
    }
    const schema = FIELD_SCHEMAS[kind];
    const version = nextVersion(document, actorId);
    const existing = document[kind][entityId];
    if (!existing && Object.keys(schema).some(field => !Object.prototype.hasOwnProperty.call(patch, field))) {
        throw new Error(`project catalog V2 new ${kind} record must provide every field`);
    }
    if (existing && !isLive(existing).live
        && Object.keys(schema).some(field => !Object.prototype.hasOwnProperty.call(patch, field))) {
        throw new Error(`project catalog V2 deleted ${kind} record cannot be patched`);
    }
    const record = existing || { fields: {}, tombstones: [] };
    for (const field of Object.keys(patch)) {
        if (!schema[field] || !schema[field](patch[field])) {
            throw new Error(`project catalog V2 ${kind} patch field is invalid`);
        }
        const previous = record.fields[field];
        const baselines = previous
            ? Array.from(new Map([...previous.baselines, ...previous.candidates]
                .map(candidate => [candidateKey(candidate), candidate])).values())
                .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)))
            : [];
        record.fields[field] = {
            candidates: [{ value: clone(patch[field]), version: clone(version) }],
            baselines,
        };
    }
    document[kind][entityId] = record;
    document.versionVector = clock(version);
    return parseProjectCatalogV2Document(document) as ProjectCatalogV2Document;
}

export function deleteProjectCatalogV2Entity(
    rawDocument: ProjectCatalogV2Document,
    kind: ProjectCatalogV2EntityKind,
    entityId: string,
    actorId: string,
): ProjectCatalogV2Document {
    const document = parseProjectCatalogV2Document(rawDocument);
    if (!document || !ENTITY_ID_PATTERN.test(entityId)) {
        throw new Error('project catalog V2 deletion is invalid');
    }
    const record = document[kind][entityId];
    if (!record) { return document; }
    const version = nextVersion(document, actorId);
    record.tombstones = pruneVersions([...record.tombstones, version]);
    document.versionVector = clock(version);
    return parseProjectCatalogV2Document(document) as ProjectCatalogV2Document;
}

function mergeVectors(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
    const merged = sortedVector(left);
    for (const actorId of Object.keys(right)) { merged[actorId] = Math.max(merged[actorId] || 0, right[actorId]); }
    return sortedVector(merged);
}

function mergeRecord(kind: ProjectCatalogV2EntityKind, left: ProjectCatalogV2EntityRecord, right: ProjectCatalogV2EntityRecord): ProjectCatalogV2EntityRecord {
    const fields: Record<string, ProjectCatalogV2FieldRegister> = {};
    for (const field of Array.from(new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])).sort()) {
        const candidates = [
            ...(left.fields[field]?.candidates || []),
            ...(right.fields[field]?.candidates || []),
        ];
        fields[field] = normalizeRegister({
            candidates,
            baselines: [
                ...(left.fields[field]?.baselines || []),
                ...(right.fields[field]?.baselines || []),
            ],
        }, FIELD_SCHEMAS[kind][field]);
    }
    return {
        fields,
        tombstones: pruneVersions([...left.tombstones, ...right.tombstones]),
    };
}

export function mergeProjectCatalogV2Documents(
    rawLeft: ProjectCatalogV2Document,
    rawRight: ProjectCatalogV2Document,
): ProjectCatalogV2Document {
    const left = parseProjectCatalogV2Document(rawLeft);
    const right = parseProjectCatalogV2Document(rawRight);
    if (!left || !right) { throw new Error('project catalog V2 merge input is invalid'); }
    const merged = createEmptyProjectCatalogV2();
    merged.versionVector = mergeVectors(left.versionVector, right.versionVector);
    for (const kind of ['machines', 'environments', 'projects'] as ProjectCatalogV2EntityKind[]) {
        for (const id of Array.from(new Set([...Object.keys(left[kind]), ...Object.keys(right[kind])])).sort()) {
            const leftRecord = left[kind][id];
            const rightRecord = right[kind][id];
            merged[kind][id] = leftRecord && rightRecord
                ? mergeRecord(kind, leftRecord, rightRecord)
                : clone(leftRecord || rightRecord);
        }
    }
    return parseProjectCatalogV2Document(merged) as ProjectCatalogV2Document;
}

function winningCandidate(
    register: ProjectCatalogV2FieldRegister,
    preserveBaseline: boolean,
): ProjectCatalogV2FieldCandidate {
    const distinctValues = new Set(register.candidates.map(candidate => stableSerialize(candidate.value)));
    if (preserveBaseline && distinctValues.size > 1) {
        const commonBaselines = register.baselines
            .filter(baseline => register.candidates.every(candidate =>
                dominatesVersion(candidate.version, baseline.version)))
            .filter(baseline => !register.baselines.some(other =>
                versionKey(other.version) !== versionKey(baseline.version)
                && register.candidates.every(candidate => dominatesVersion(candidate.version, other.version))
                && dominatesVersion(other.version, baseline.version)))
            .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
        if (commonBaselines.length) { return commonBaselines[commonBaselines.length - 1]; }
    }
    return register.candidates[register.candidates.length - 1];
}

function isLive(record: ProjectCatalogV2EntityRecord): { live: boolean; deleteConflict: boolean } {
    const candidates = Object.values(record.fields).reduce(
        (all, register) => all.concat(register.candidates),
        [] as ProjectCatalogV2FieldCandidate[],
    );
    if (!record.tombstones.length) { return { live: candidates.length > 0, deleteConflict: false }; }
    const survivors = candidates.filter(candidate => !record.tombstones.some(tombstone =>
        dominatesVersion(tombstone, candidate.version)));
    const deleteConflict = record.tombstones.some(tombstone => candidates.some(candidate =>
        concurrent(tombstone, candidate.version)));
    return { live: survivors.length > 0, deleteConflict };
}

function materializeCollection(
    kind: ProjectCatalogV2EntityKind,
    records: Record<string, ProjectCatalogV2EntityRecord>,
    conflicts: ProjectCatalogV2Conflict[],
): Array<Record<string, ProjectCatalogV2FieldValue>> {
    const result: Array<{
        value: Record<string, ProjectCatalogV2FieldValue>;
        positionVersion: string;
    }> = [];
    for (const id of Object.keys(records).sort()) {
        const record = records[id];
        const live = isLive(record);
        if (live.deleteConflict) { conflicts.push({ entityKind: kind, entityId: id, field: null, kind: 'delete-update' }); }
        if (!live.live) { continue; }
        const value: Record<string, ProjectCatalogV2FieldValue> = { id };
        let positionVersion = '';
        for (const field of Object.keys(record.fields).sort()) {
            const register = record.fields[field];
            const isPosition = field === 'position' || field === 'favoritePosition';
            const selected = winningCandidate(register, !isPosition);
            value[field] = clone(selected.value);
            if (field === 'position') { positionVersion = versionKey(selected.version); }
            const distinctValues = new Set(register.candidates.map(candidate => stableSerialize(candidate.value)));
            if (distinctValues.size > 1 && !isPosition) {
                conflicts.push({
                    entityKind: kind,
                    entityId: id,
                    field,
                    kind: field === 'machineId' || field === 'environmentId' ? 'placement' : 'field',
                });
            }
        }
        result.push({ value, positionVersion });
    }
    return result
        .sort((left, right) => {
            const position = String(left.value.position).localeCompare(String(right.value.position));
            if (position !== 0) { return position; }
            const version = left.positionVersion.localeCompare(right.positionVersion);
            if (version !== 0) { return version; }
            return String(left.value.id).localeCompare(String(right.value.id));
        })
        .map(entry => entry.value);
}

export function materializeProjectCatalogV2(document: ProjectCatalogV2Document): ProjectCatalogV2Materialized {
    const parsed = parseProjectCatalogV2Document(document);
    if (!parsed) { throw new Error('project catalog V2 document is invalid'); }
    const conflicts: ProjectCatalogV2Conflict[] = [];
    const machines = materializeCollection('machines', parsed.machines, conflicts) as any;
    const environments = materializeCollection('environments', parsed.environments, conflicts) as any;
    const projects = materializeCollection('projects', parsed.projects, conflicts) as any;
    const machineIds = new Set(machines.map((machine: { id: string }) => machine.id));
    const environmentIds = new Set(environments.map((environment: { id: string }) => environment.id));
    const hostByMachineId = new Map<string, string>();
    environments.forEach((environment: { id: string; machineId: string; kind: string }) => {
        const machineCandidates = parsed.environments[environment.id].fields.machineId.candidates
            .map(candidate => candidate.value)
            .filter((value): value is string => typeof value === 'string');
        if (machineCandidates.some(machineId => !machineIds.has(machineId))) {
            conflicts.push({ entityKind: 'environments', entityId: environment.id, field: 'machineId', kind: 'missing-parent' });
        }
        if (environment.kind === 'host') {
            if (hostByMachineId.has(environment.machineId)) {
                conflicts.push({
                    entityKind: 'environments',
                    entityId: environment.id,
                    field: 'machineId',
                    kind: 'duplicate-host',
                });
            } else {
                hostByMachineId.set(environment.machineId, environment.id);
            }
        }
    });
    machines.forEach((machine: { id: string }) => {
        if (!hostByMachineId.has(machine.id)) {
            conflicts.push({ entityKind: 'machines', entityId: machine.id, field: null, kind: 'missing-host' });
        }
    });
    projects.forEach((project: { id: string; environmentId: string }) => {
        const environmentCandidates = parsed.projects[project.id].fields.environmentId.candidates
            .map(candidate => candidate.value)
            .filter((value): value is string => typeof value === 'string');
        if (environmentCandidates.some(environmentId => !environmentIds.has(environmentId))) {
            conflicts.push({ entityKind: 'projects', entityId: project.id, field: 'environmentId', kind: 'missing-parent' });
        }
    });
    return {
        machines,
        environments,
        projects,
        conflicts: conflicts.sort((left, right) =>
            `${left.entityKind}:${left.entityId}:${left.field || ''}`.localeCompare(
                `${right.entityKind}:${right.entityId}:${right.field || ''}`,
            )),
    };
}
