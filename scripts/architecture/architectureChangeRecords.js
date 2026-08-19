'use strict';

/**
 * Architecture Change record parsing and coverage matching (review R3;
 * charter 8.9).
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
 * 3. The declared delta covers the actual policy delta computed from the
 *    diff (subset semantics: the record may declare more than a consuming
 *    PR realizes, never less).
 *
 * Approval timing is transitive by construction: a record in the base
 * necessarily merged through an earlier PR, and every merge requires the
 * merge-approval status, which is green only when the owner approval comment
 * is newer than that PR's head commit. Hence the owner approval for the
 * record is always newer than the record's final commit.
 */

const ARCH_CHANGE_RECORD_PATTERN = /^docs\/architecture\/changes\/ARCH-CHANGE-[A-Z0-9-]+\.md$/;
const ARCH_CHANGE_ID_PATTERN = /^ARCH-CHANGE-[A-Z0-9-]+$/;
const RECORDS_DIRECTORY = 'docs/architecture/changes/';
const BLOCK_PATTERN = /```arch-change\s*\r?\n([\s\S]*?)```/;

const DELTA_MAP_KEYS = ['mayDependOnGrown', 'entrypointsGrown'];
const DELTA_LIST_KEYS = ['baselineGrown', 'waiversAdded', 'invariantChanges', 'ledgerRegressions'];
const DELTA_FLAG_KEYS = ['rePartition', 'harnessWeakening', 'guardSemantics'];
const DELTA_KEYS = [...DELTA_MAP_KEYS, ...DELTA_LIST_KEYS, ...DELTA_FLAG_KEYS];

function isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function isStringArrayMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(isStringArray);
}

function recordIdFromPath(recordPath) {
    const match = recordPath.match(/ARCH-CHANGE-[A-Z0-9-]+(?=\.md$)/);
    return match ? match[0] : null;
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
    if (errors.length > 0) {
        return { record: null, errors };
    }

    const delta = {
        mayDependOnGrown: rawDelta.mayDependOnGrown || {},
        entrypointsGrown: rawDelta.entrypointsGrown || {},
        baselineGrown: rawDelta.baselineGrown || [],
        waiversAdded: rawDelta.waiversAdded || [],
        invariantChanges: rawDelta.invariantChanges || [],
        ledgerRegressions: rawDelta.ledgerRegressions || [],
        rePartition: rawDelta.rePartition === true,
        harnessWeakening: rawDelta.harnessWeakening === true,
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

function missingMapEntries(actual, declared, label) {
    const missing = [];
    for (const [id, values] of Object.entries(actual)) {
        const declaredValues = new Set((declared && declared[id]) || []);
        for (const value of values) {
            if (!declaredValues.has(value)) {
                missing.push(`${label}: ${id} += ${value}`);
            }
        }
    }
    return missing;
}

function missingListEntries(actual, declared, label) {
    const declaredSet = new Set(declared || []);
    return actual.filter(value => !declaredSet.has(value))
        .map(value => `${label}: ${value}`);
}

/**
 * Does the record's declared delta cover the actual policy delta?
 * coversPolicyDelta(record, actual) -> { covered, missing } where actual is
 * { policyDelta, harnessWeakened, rePartition, relaxingInvariantIds }.
 * Invariant coverage is by id: every invariant whose semantic fields changed
 * (or that was removed) must be declared in the record's invariantChanges.
 */
function coversPolicyDelta(record, actual) {
    const { policyDelta, harnessWeakened, rePartition, relaxingInvariantIds } = actual;
    const { delta } = record;
    const missing = [
        ...missingMapEntries(policyDelta.mayDependOnGrown, delta.mayDependOnGrown, 'mayDependOn broadened'),
        ...missingMapEntries(policyDelta.entrypointsGrown || {}, delta.entrypointsGrown, 'entrypoints broadened'),
        ...missingListEntries(policyDelta.baselineGrown, delta.baselineGrown, 'baseline grew'),
        ...missingListEntries(policyDelta.waiversAdded, delta.waiversAdded, 'waiver added'),
        ...missingListEntries(relaxingInvariantIds || [], delta.invariantChanges, 'invariant changed'),
        ...missingListEntries(policyDelta.ledgerRegressions || [], delta.ledgerRegressions, 'ledger regression'),
    ];
    if (rePartition && !delta.rePartition) {
        missing.push('registry re-partition not declared');
    }
    if (harnessWeakened && !delta.harnessWeakening) {
        missing.push('harness weakening not declared');
    }
    return { covered: missing.length === 0, missing };
}

module.exports = {
    ARCH_CHANGE_RECORD_PATTERN,
    RECORDS_DIRECTORY,
    coversPolicyDelta,
    parseArchitectureChangeRecord,
};
