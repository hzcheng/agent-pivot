'use strict';

/**
 * Anti-self-amendment gate (Harness v0, program Stage 2 PR 4; charter 8.9).
 *
 * Classifies a change by its impact on protected architecture policy and the
 * harness surface (review R2):
 * - product-only: neither policy files nor the harness surface touched;
 * - tightening: policy only narrows, or the harness surface changes without
 *   weakening;
 * - relaxing or registry re-partition: baseline grew, waivers added,
 *   mayDependOn broadened, writer sets grew, module structure changed, or
 *   the harness surface weakened (a guard file deleted, a guard id removed,
 *   a lane or workflow invocation removed, mutation tests shrank).
 *
 * A relaxing or re-partition change is authorized only by an Architecture
 * Change record that already exists in the PR base (review R3; charter 8.9:
 * the record lands in its own earlier PR before product work consumes it).
 * The record must carry a valid ```arch-change machine-summary block whose
 * declared delta covers the actual policy delta; an empty markdown file, a
 * bare filename match, or a record added in the same PR never authorizes.
 * Because every merge requires the merge-approval status (owner comment
 * newer than the PR head), a record present in the base was necessarily
 * approved after its final commit — approval timing holds transitively.
 *
 * An agent cannot legalize its own violation: the classification is computed
 * from the diff, not declared.
 */

const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('./reportArchitectureDiff');
const {
    ARCH_CHANGE_RECORD_PATTERN,
    coversPolicyDelta,
    fingerprintFields,
    parseArchitectureChangeRecord,
} = require('./architectureChangeRecords');

// Kept for backward compatibility with existing imports.
const ARCH_CHANGE_PATTERN = ARCH_CHANGE_RECORD_PATTERN;

function harnessWeakenedOf(harness) {
    return harness.deletedFiles.length > 0
        || harness.removedGuardIds.length > 0
        || harness.removedInvocations.length > 0
        || harness.shrunkMutationTests.length > 0;
}

/**
 * The exact delta a consuming change realizes — the shape a record must
 * declare verbatim (round-2 review Blocker 3). Shared by the gate (coverage
 * matching) and scripts/architecture/describeArchitectureChange.js
 * (record authoring).
 */
function computeActualDelta(report, classification, harnessWeakened) {
    const delta = report.policyDelta;
    const invariantChanges = Object.entries(delta.invariantChanges || {})
        .map(([id, change]) => ({ id, ...change }));
    const isTighteningOnly = change =>
        change.fields.length === 1 && change.fields[0] === 'writers'
        && (change.writersAdded || []).length === 0;
    const relaxingInvariantChanges = invariantChanges.filter(change => !isTighteningOnly(change));
    // Removed invariants join the coverage surface with a removal marker:
    // the record must declare the exact removed record's fingerprint.
    const removedEntries = (delta.invariantsRemoved || []).map(id => ({
        id,
        fields: ['removed'],
        before: fingerprintFields({ record: (report.removedInvariantRecords || {})[id] }),
        after: fingerprintFields({}),
    }));
    // Round-2 review Blocker 3: the record's module scope must cover every
    // module the change actually touches.
    const touchedModules = new Set(Object.keys(report.touchedModules || {}));
    for (const key of Object.keys(delta.mayDependOnGrown || {})) { touchedModules.add(key); }
    for (const key of Object.keys(delta.entrypointsGrown || {})) { touchedModules.add(key); }
    for (const move of report.moduleMoves || []) {
        touchedModules.add(move.from);
        touchedModules.add(move.to);
    }
    for (const regression of delta.ledgerRegressions || []) {
        touchedModules.add(regression.split(':')[0]);
    }
    for (const moduleId of report.changedInvariantModules || []) { touchedModules.add(moduleId); }
    return {
        policyDelta: delta,
        harnessWeakened,
        rePartition: classification === 're-partition',
        invariantChanges: [...relaxingInvariantChanges, ...removedEntries].map(
            ({ id, fields, before, after }) => ({ id, fields, before, after })),
        fileMoves: report.moduleMoves || [],
        touchedModules: [...touchedModules].sort(),
    };
}

/**
 * Authorize a relaxing/re-partition classification against the Architecture
 * Change records present in the base. Returns the error list (empty when
 * authorized).
 */
function authorizeWithBaseRecords(report, classification, harnessWeakened) {
    const baseRecords = report.baseRecords || [];
    const candidates = [];
    const invalid = [];
    for (const { path: recordPath, text } of baseRecords) {
        const { record, errors } = parseArchitectureChangeRecord({ path: recordPath, text });
        if (record) { candidates.push(record); }
        if (errors.length > 0) { invalid.push(...errors); }
    }
    const actual = computeActualDelta(report, classification, harnessWeakened);
    let bestMissing = null;
    for (const record of candidates) {
        const { covered, missing } = coversPolicyDelta(record, actual);
        if (covered) { return []; }
        if (bestMissing === null || missing.length < bestMissing.length) {
            bestMissing = missing;
        }
    }

    const verb = classification === 'relaxing' ? 'relaxes' : 're-partitions';
    const errors = [];
    if (candidates.length === 0) {
        errors.push(`anti-self-amendment: this change ${verb} architecture policy or weakens the `
            + 'harness, and no valid approved Architecture Change record exists in the PR base '
            + `(found ${baseRecords.length} record file(s), ${invalid.length} invalid). Land a `
            + 'docs-only PR adding docs/architecture/changes/ARCH-CHANGE-<seq>.md with an '
            + '```arch-change machine-summary block (id, status "approved", modules, declared '
            + 'delta) first; a record added in the same PR never authorizes consumption.');
    } else {
        errors.push(`anti-self-amendment: this change ${verb} architecture policy or weakens the `
            + `harness beyond every approved Architecture Change record in the PR base. Uncovered `
            + `delta: ${bestMissing.join('; ')}. Land a docs-only record PR declaring this delta `
            + 'first, or narrow the change to what an existing record declares.');
    }
    if (report.newFiles.some(file => ARCH_CHANGE_RECORD_PATTERN.test(file))) {
        errors.push('anti-self-amendment: this PR adds an Architecture Change record and consumes '
            + 'a relaxation in the same diff — the record must land in an earlier PR (charter 8.9).');
    }
    return errors;
}

/**
 * classifyArchitectureChange(report) -> {
 *   classification: 'product-only' | 'tightening' | 'relaxing' | 're-partition',
 *   errors: string[]
 * }
 */
function classifyArchitectureChange(report) {
    const errors = [];
    if (report.errors && report.errors.length > 0) {
        errors.push(...report.errors);
    }
    const harness = report.harnessDelta || {
        touched: [], deletedFiles: [], removedGuardIds: [],
        removedInvocations: [], shrunkMutationTests: [],
    };
    const harnessWeakened = harnessWeakenedOf(harness);
    if (report.protectedTouched.length === 0 && harness.touched.length === 0) {
        return { classification: 'product-only', errors };
    }

    const delta = report.policyDelta;
    const grownMayDependOn = Object.keys(delta.mayDependOnGrown).length > 0;
    const grownEntrypoints = Object.keys(delta.entrypointsGrown || {}).length > 0;
    const ledgerRegressions = (delta.ledgerRegressions || []);
    // Review R9 (Important 4): only a pure writer removal with an unchanged
    // authority is tightening — an invariant change whose only edited field is
    // `writers` with removals alone. Everything else is relaxing.
    const isTighteningOnly = change =>
        change.fields.length === 1 && change.fields[0] === 'writers'
        && (change.writersAdded || []).length === 0;
    const invariantChanges = Object.entries(delta.invariantChanges || {})
        .map(([id, change]) => ({ id, ...change }));
    const relaxingInvariantIds = invariantChanges
        .filter(change => !isTighteningOnly(change))
        .map(change => change.id);
    const removedInvariants = (delta.invariantsRemoved || []);
    const grownBaseline = delta.baselineGrown.length > 0;
    const addedWaivers = delta.waiversAdded.length > 0;
    const relaxing = grownMayDependOn || grownEntrypoints || ledgerRegressions.length > 0
        || relaxingInvariantIds.length > 0
        || removedInvariants.length > 0 || grownBaseline || addedWaivers
        || harnessWeakened;
    const rePartition = !relaxing && delta.modulesChanged
        && report.protectedTouched
            .some(file => file.endsWith('architecture-modules.json'));

    if (!relaxing && !rePartition) {
        return { classification: 'tightening', errors };
    }
    const classification = relaxing ? 'relaxing' : 're-partition';
    errors.push(...authorizeWithBaseRecords(report, classification, harnessWeakened));
    return { classification, errors };
}

function runArchitectureChangeCheck(rootDirectory, baseRef) {
    const report = collectArchitectureDiff({
        rootDirectory,
        baseRef: baseRef || process.env.COVERAGE_DIFF_BASE
            || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
            || 'origin/main',
        git: defaultGit(rootDirectory),
    });
    const { classification, errors } = classifyArchitectureChange(report);
    return { classification, errors, report };
}

function main() {
    const { classification, errors } = runArchitectureChangeCheck(
        path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error(`Architecture change gate FAILED (classification: ${classification}):`);
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log(`Architecture change gate passed (classification: ${classification}).`);
}

if (require.main === module) { main(); }

module.exports = {
    ARCH_CHANGE_PATTERN,
    classifyArchitectureChange,
    computeActualDelta,
    runArchitectureChangeCheck,
};
