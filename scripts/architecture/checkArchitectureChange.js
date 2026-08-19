'use strict';

/**
 * Anti-self-amendment gate (Harness Simplification PR #296).
 *
 * Classifies a change by its impact on protected architecture policy and the
 * harness surface. Relaxing or re-partition changes require owner architecture
 * approval (approve-architecture <sha>), enforced by the trusted kernel.
 *
 * Architecture Change records are historical ADRs only — no machine
 * authorization, no record consumption, no parity exemption.
 */

const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('./reportArchitectureDiff');
const { ARCH_CHANGE_RECORD_PATTERN } = require('./architectureChangeRecords');

const ARCH_CHANGE_PATTERN = ARCH_CHANGE_RECORD_PATTERN;

function harnessWeakenedOf(harness) {
    return harness.deletedFiles.length > 0
        || harness.removedGuardIds.length > 0
        || harness.removedInvocations.length > 0
        || harness.shrunkMutationTests.length > 0;
}

function classifyArchitectureChange(report, options) {
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

    // Owner architecture approval (approve-architecture <full-head-sha>) is
    // the only authorization left after record machine authorization was
    // deleted. The caller verifies the comment binds the exact head SHA;
    // the classifier only receives the verdict.
    if (!(options && options.architectureApproved)) {
        const verb = relaxing ? 'relaxes' : 're-partitions';
        errors.push(
            `anti-self-amendment: this change ${verb} architecture policy. `
            + 'Owner architecture approval required — comment '
            + '\'approve-architecture <full-head-sha>\' on the pull request.'
        );
    }

    return { classification: relaxing ? 'relaxing' : 're-partition', errors };
}

function runArchitectureChangeCheck(rootDirectory, baseRef, options) {
    const report = collectArchitectureDiff({
        rootDirectory,
        baseRef: baseRef || process.env.COVERAGE_DIFF_BASE
            || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
            || 'origin/main',
        git: defaultGit(rootDirectory),
    });
    const { classification, errors } = classifyArchitectureChange(report, options);
    return { classification, errors, report };
}

function main() {
    // The quality lane runs PR-head code, so this env flag is developer
    // feedback only: the merge-approval gate re-verifies the same owner
    // comment from the default branch before the PR can merge.
    const architectureApproved = process.env.ARCHITECTURE_APPROVED === 'true';
    const { classification, errors } = runArchitectureChangeCheck(
        path.resolve(__dirname, '..', '..'), undefined, { architectureApproved });
    if (errors.length > 0) {
        console.error(`Architecture change gate FAILED (classification: ${classification}):`);
        for (const error of errors) console.error(`  ✗ ${error}`);
        process.exitCode = 1;
        return;
    }
    console.log(`Architecture change gate passed (classification: ${classification}).`);
}

if (require.main === module) { main(); }

module.exports = {
    ARCH_CHANGE_PATTERN,
    classifyArchitectureChange,
    runArchitectureChangeCheck,
};
