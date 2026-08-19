#!/usr/bin/env node
'use strict';

/**
 * Record-authoring helper (round-2 review Blocker 3): prints the exact
 * record-ready `delta` object for the current branch diff, including
 * before/after fingerprints for invariant changes and per-file module moves.
 *
 * Authoring flow (charter 8.9): make the policy edit locally, run this
 * script, paste the printed delta into the ARCH-CHANGE record's
 * machine-summary block, revert the edit, land the docs-only record PR, then
 * re-apply the edit in the consuming PR — the gate requires exact equality.
 *
 * Usage: node scripts/architecture/describeArchitectureChange.js [base-ref]
 */

const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('./reportArchitectureDiff');
const {
    classifyArchitectureChange,
    computeActualDelta,
} = require('./checkArchitectureChange');

function describeArchitectureChange(rootDirectory, baseRef) {
    const report = collectArchitectureDiff({
        rootDirectory,
        baseRef: baseRef || process.env.COVERAGE_DIFF_BASE
            || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
            || 'origin/main',
        git: defaultGit(rootDirectory),
    });
    const { classification } = classifyArchitectureChange(report);
    const harness = report.harnessDelta || {};
    const harnessWeakened = (harness.deletedFiles || []).length > 0
        || (harness.removedGuardIds || []).length > 0
        || (harness.removedInvocations || []).length > 0
        || (harness.shrunkMutationTests || []).length > 0;
    const actual = computeActualDelta(report, classification, harnessWeakened);
    const delta = {
        mayDependOnGrown: actual.policyDelta.mayDependOnGrown,
        entrypointsGrown: actual.policyDelta.entrypointsGrown || {},
        baselineGrown: actual.policyDelta.baselineGrown,
        waiversAdded: actual.policyDelta.waiversAdded,
        ledgerRegressions: actual.policyDelta.ledgerRegressions || [],
        invariantChanges: actual.invariantChanges,
        fileMoves: actual.fileMoves,
        rePartition: actual.rePartition,
        harnessWeakening: actual.harnessWeakened,
    };
    return { classification, delta, touchedModules: actual.touchedModules };
}

function main() {
    const { classification, delta, touchedModules } = describeArchitectureChange(
        path.resolve(__dirname, '..', '..'), process.argv[2]);
    console.log(`classification: ${classification}`);
    console.log(`modules: ${JSON.stringify(touchedModules)}`);
    console.log('delta for the record machine-summary block:');
    console.log(JSON.stringify(delta, null, 2));
}

if (require.main === module) { main(); }

module.exports = { describeArchitectureChange };
