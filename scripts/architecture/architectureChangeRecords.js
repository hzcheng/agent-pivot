'use strict';

/**
 * Architecture Change record parsing and coverage matching (review R3;
 * charter 8.9; precision from round-2 review Blocker 3).
 *
 * An Architecture Change record authorizes a relaxation or re-partition only
 * when all of the following hold:
 *
 * 1. The record file already exists in the PR base — it landed through its
 *    own earlier pull request (charter 8.9: the change lands before product
 *    work consumes it). A record added in the same pull request never
 *    authorizes anything.
 * 2. The record carries exactly one machine-readable ```arch-change fenced
 *    JSON block with a structured id, status, module list, and target delta.
 *    An empty markdown file or a bare filename match is not a candidate.
 * 3. The declared delta EQUALS the actual policy delta computed from the
 *    diff — exact per-dimension equality, never subset semantics (round-2
 *    review Blocker 3: a declared superset would authorize more than the
 *    owner reviewed, and a record that outlives its delta would be a
 *    standing wildcard).
 * 4. The record's `modules` scope covers every module the change actually
 *    touches: touched production modules, every module named by the delta,
 *    and both ends of every declared file move.
 * 5. Re-partitions that move files declare per-file moves
 *    (`fileMoves: [{ path, from, to }]`); invariant semantic changes declare
 *    per-invariant field lists with before/after fingerprints
 *    (`invariantChanges: [{ id, fields, before, after }]`, fingerprints as
 *    produced by scripts/architecture/describeArchitectureChange.js).
 *
 * Approval timing is transitive by construction: a record in the base
 * necessarily merged through an earlier PR, and every merge requires the
 * merge-approval status, which is green only when the owner approval comment
 * binds that PR's head SHA. Hence the owner approval for the record is
 * always bound to the record's final content.
 */

const crypto = require('crypto');

const ARCH_CHANGE_RECORD_PATTERN = /^docs\/architecture\/changes\/ARCH-CHANGE-[A-Z0-9-]+\.md$/;
const ARCH_CHANGE_ID_PATTERN = /^ARCH-CHANGE-[A-Z0-9-]+$/;
const RECORDS_DIRECTORY = 'docs/architecture/changes/';
const BLOCK_PATTERN = /```arch-change\s*\r?\n([\s\S]*?)```/;

const DELTA_MAP_KEYS = ['mayDependOnGrown', 'entrypointsGrown'];
const DELTA_LIST_KEYS = ['baselineGrown', 'waiversAdded', 'ledgerRegressions'];
const DELTA_FLAG_KEYS = ['rePartition', 'harnessWeakening', 'guardSemantics'];
const DELTA_KEYS = [...DELTA_MAP_KEYS, ...DELTA_LIST_KEYS, ...DELTA_FLAG_KEYS,
    'invariantChanges', 'fileMoves'];

const INVARIANT_CHANGE_KEYS = ['id', 'fields', 'before', 'after'];
const FILE_MOVE_KEYS = ['path', 'from', 'to'];
const FIELD_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function isStringArrayMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(isStringArray);
}

/** Canonical fingerprint of a field-value map (sorted keys, stable JSON). */
function fingerprintFields(fieldValues) {
    const canonical = JSON.stringify(fieldValues, Object.keys(fieldValues).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function recordIdFromPath(recordPath) {
    const match = recordPath.match(/ARCH-CHANGE-[A-Z0-9-]+(?=\.md$)/);
    return match ? match[0] : null;
}

function validateInvariantChanges(recordPath, value, errors) {
    if (!Array.isArray(value)) {
        errors.push(`${recordPath}: delta.invariantChanges must be an array`);
        return;
    }
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${recordPath}: delta.invariantChanges entries must be objects`);
            continue;
        }
        for (const key of Object.keys(entry)) {
            if (!INVARIANT_CHANGE_KEYS.includes(key)) {
                errors.push(`${recordPath}: unknown invariantChanges key ${JSON.stringify(key)}`);
            }
        }
        if (typeof entry.id !== 'string' || !entry.id) {
            errors.push(`${recordPath}: invariantChanges entry requires a non-empty id`);
        }
        if (!isStringArray(entry.fields)) {
            errors.push(`${recordPath}: invariantChanges ${entry.id}: fields must be a non-empty `
                + 'array of field names');
        }
        for (const key of ['before', 'after']) {
            if (typeof entry[key] !== 'string' || !FIELD_FINGERPRINT_PATTERN.test(entry[key])) {
                errors.push(`${recordPath}: invariantChanges ${entry.id}: ${key} must be a `
                    + 'sha256 fingerprint (64 lowercase hex) from describeArchitectureChange.js');
            }
        }
    }
}

function validateFileMoves(recordPath, value, errors) {
    if (!Array.isArray(value)) {
        errors.push(`${recordPath}: delta.fileMoves must be an array`);
        return;
    }
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${recordPath}: delta.fileMoves entries must be objects`);
            continue;
        }
        for (const key of Object.keys(entry)) {
            if (!FILE_MOVE_KEYS.includes(key)) {
                errors.push(`${recordPath}: unknown fileMoves key ${JSON.stringify(key)}`);
            }
        }
        for (const key of FILE_MOVE_KEYS) {
            if (typeof entry[key] !== 'string' || !entry[key]) {
                errors.push(`${recordPath}: fileMoves entry requires non-empty ${key}`);
            }
        }
    }
}

/**
 * parseArchitectureChangeRecord({ path, text }) -> { record | null, errors }.
 * Fail-closed: any schema violation makes the record unusable.
 */
function parseArchitectureChangeRecord({ path: recordPath, text }) {
    const errors = [];
    const blocks = [...text.matchAll(new RegExp(BLOCK_PATTERN.source, 'g'))];
    if (blocks.length === 0) {
        errors.push(`${recordPath}: no \`\`\`arch-change machine-summary block`);
        return { record: null, errors };
    }
    if (blocks.length > 1) {
        errors.push(`${recordPath}: multiple arch-change machine-summary blocks`);
        return { record: null, errors };
    }
    let parsed;
    try {
        parsed = JSON.parse(blocks[0][1]);
    } catch (error) {
        errors.push(`${recordPath}: arch-change block is not valid JSON (${error.message})`);
        return { record: null, errors };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${recordPath}: arch-change block must be a JSON object`);
        return { record: null, errors };
    }

    const expectedId = recordIdFromPath(recordPath);
    if (typeof parsed.id !== 'string' || !ARCH_CHANGE_ID_PATTERN.test(parsed.id)) {
        errors.push(`${recordPath}: id must match ${ARCH_CHANGE_ID_PATTERN}`);
    } else if (parsed.id !== expectedId) {
        errors.push(`${recordPath}: id ${parsed.id} does not match the filename ${expectedId}`);
    }
    if (parsed.status !== 'approved') {
        errors.push(`${recordPath}: status must be exactly "approved" (found ${JSON.stringify(parsed.status)})`);
    }
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0
        || !parsed.modules.every(moduleId => typeof moduleId === 'string' && moduleId.length > 0)) {
        errors.push(`${recordPath}: modules must be a non-empty array of module ids`);
    }

    const rawDelta = parsed.delta === undefined ? {} : parsed.delta;
    if (rawDelta === null || typeof rawDelta !== 'object' || Array.isArray(rawDelta)) {
        errors.push(`${recordPath}: delta must be an object`);
        return { record: null, errors };
    }
    for (const key of Object.keys(rawDelta)) {
        if (!DELTA_KEYS.includes(key)) {
            errors.push(`${recordPath}: unknown delta key ${JSON.stringify(key)} `
                + `(allowed: ${DELTA_KEYS.join(', ')})`);
        }
    }
    for (const key of DELTA_MAP_KEYS) {
        if (rawDelta[key] !== undefined && !isStringArrayMap(rawDelta[key])) {
            errors.push(`${recordPath}: delta.${key} must map ids to non-empty string arrays`);
        }
    }
    for (const key of DELTA_LIST_KEYS) {
        if (rawDelta[key] !== undefined && !isStringArray(rawDelta[key])) {
            errors.push(`${recordPath}: delta.${key} must be an array of strings`);
        }
    }
    for (const key of DELTA_FLAG_KEYS) {
        if (rawDelta[key] !== undefined && typeof rawDelta[key] !== 'boolean') {
            errors.push(`${recordPath}: delta.${key} must be a boolean`);
        }
    }
    if (rawDelta.invariantChanges !== undefined) {
        validateInvariantChanges(recordPath, rawDelta.invariantChanges, errors);
    }
    if (rawDelta.fileMoves !== undefined) {
        validateFileMoves(recordPath, rawDelta.fileMoves, errors);
    }
    if (errors.length > 0) {
        return { record: null, errors };
    }

    const delta = {
        mayDependOnGrown: rawDelta.mayDependOnGrown || {},
        entrypointsGrown: rawDelta.entrypointsGrown || {},
        baselineGrown: rawDelta.baselineGrown || [],
        waiversAdded: rawDelta.waiversAdded || [],
        ledgerRegressions: rawDelta.ledgerRegressions || [],
        invariantChanges: rawDelta.invariantChanges || [],
        fileMoves: rawDelta.fileMoves || [],
        rePartition: rawDelta.rePartition === true,
        harnessWeakening: rawDelta.harnessWeakening === true,
        guardSemantics: rawDelta.guardSemantics === true,
    };
    return {
        record: {
            id: parsed.id,
            path: recordPath,
            status: parsed.status,
            modules: [...parsed.modules],
            delta,
        },
        errors: [],
    };
}

function sortedSet(values) {
    return [...new Set(values)].sort();
}

function mapMismatch(actual, declared, label) {
    const missing = [];
    const actualKeys = sortedSet(Object.keys(actual || {}));
    const declaredKeys = sortedSet(Object.keys(declared || {}));
    if (JSON.stringify(actualKeys) !== JSON.stringify(declaredKeys)) {
        return [`${label}: actual modules [${actualKeys.join(', ')}] do not equal the declared`
            + ` [${declaredKeys.join(', ')}]`];
    }
    for (const key of actualKeys) {
        if (JSON.stringify(sortedSet(actual[key])) !== JSON.stringify(sortedSet(declared[key]))) {
            missing.push(`${label}: ${key} actual [${sortedSet(actual[key]).join(', ')}]`
                + ` != declared [${sortedSet(declared[key]).join(', ')}]`);
        }
    }
    return missing;
}

function listMismatch(actual, declared, label) {
    if (JSON.stringify(sortedSet(actual || [])) !== JSON.stringify(sortedSet(declared || []))) {
        return [`${label}: actual [${sortedSet(actual || []).join(', ')}] does not equal the`
            + ` declared [${sortedSet(declared || []).join(', ')}]`];
    }
    return [];
}

function invariantChangeMismatch(actual, declared) {
    const actualById = new Map((actual || []).map(entry => [entry.id, entry]));
    const declaredById = new Map((declared || []).map(entry => [entry.id, entry]));
    if (JSON.stringify(sortedSet(actualById.keys())) !== JSON.stringify(sortedSet(declaredById.keys()))) {
        return [`invariant changes: actual ids [${sortedSet(actualById.keys()).join(', ')}] do not`
            + ` equal the declared [${sortedSet(declaredById.keys()).join(', ')}]`];
    }
    const missing = [];
    for (const [id, actualEntry] of actualById) {
        const declaredEntry = declaredById.get(id);
        if (JSON.stringify(sortedSet(actualEntry.fields))
            !== JSON.stringify(sortedSet(declaredEntry.fields))) {
            missing.push(`invariant ${id}: actual fields [${sortedSet(actualEntry.fields).join(', ')}]`
                + ` != declared [${sortedSet(declaredEntry.fields).join(', ')}]`);
            continue;
        }
        if (actualEntry.before !== declaredEntry.before
            || actualEntry.after !== declaredEntry.after) {
            missing.push(`invariant ${id}: before/after fingerprints do not match the declared ones`);
        }
    }
    return missing;
}

function fileMoveMismatch(actual, declared) {
    const normalize = moves => (moves || [])
        .map(move => `${move.path}:${move.from}->${move.to}`)
        .sort();
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(declared))) {
        return [`file moves: actual [${normalize(actual).join(', ')}] do not equal the declared`
            + ` [${normalize(declared).join(', ')}]`];
    }
    return [];
}

/**
 * Does the record's declared delta EXACTLY equal the actual policy delta,
 * and does its module scope cover everything the change touches?
 * coversPolicyDelta(record, actual) -> { covered, missing } where actual is
 * {
 *   policyDelta, harnessWeakened, rePartition, relaxingInvariantIds,
 *   invariantChanges: [{ id, fields, before, after }],
 *   fileMoves: [{ path, from, to }],
 *   touchedModules: [moduleIds...],
 * }.
 */
function coversPolicyDelta(record, actual) {
    const { delta } = record;
    const { policyDelta } = actual;
    const missing = [
        ...mapMismatch(policyDelta.mayDependOnGrown, delta.mayDependOnGrown, 'mayDependOn broadened'),
        ...mapMismatch(policyDelta.entrypointsGrown || {}, delta.entrypointsGrown, 'entrypoints broadened'),
        ...listMismatch(policyDelta.baselineGrown, delta.baselineGrown, 'baseline grew'),
        ...listMismatch(policyDelta.waiversAdded, delta.waiversAdded, 'waiver added'),
        ...listMismatch(policyDelta.ledgerRegressions || [], delta.ledgerRegressions, 'ledger regression'),
        ...invariantChangeMismatch(actual.invariantChanges || [], delta.invariantChanges),
        ...fileMoveMismatch(actual.fileMoves || [], delta.fileMoves),
    ];
    if (actual.rePartition !== delta.rePartition) {
        missing.push(`re-partition flag: actual ${actual.rePartition} != declared ${delta.rePartition}`);
    }
    if (actual.harnessWeakened !== delta.harnessWeakening) {
        missing.push(`harness weakening: actual ${actual.harnessWeakened} != declared`
            + ` ${delta.harnessWeakening}`);
    }
    const scopedModules = new Set(record.modules);
    for (const moduleId of actual.touchedModules || []) {
        if (!scopedModules.has(moduleId)) {
            missing.push(`module ${moduleId} is touched but not in the record's modules scope`);
        }
    }
    return { covered: missing.length === 0, missing };
}

module.exports = {
    ARCH_CHANGE_RECORD_PATTERN,
    RECORDS_DIRECTORY,
    coversPolicyDelta,
    fingerprintFields,
    parseArchitectureChangeRecord,
};
