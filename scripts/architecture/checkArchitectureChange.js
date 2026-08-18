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
 *   a lane or workflow invocation removed, mutation tests shrank) — requires
 *   an added docs/architecture/changes/ARCH-CHANGE-*.md record.
 *
 * An agent cannot legalize its own violation: the classification is computed
 * from the diff, not declared.
 */

const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('./reportArchitectureDiff');

const ARCH_CHANGE_PATTERN = /^docs\/architecture\/changes\/ARCH-CHANGE-[A-Z0-9-]+\.md$/;

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
    const hasArchChangeRecord = report.newFiles
        .some(file => ARCH_CHANGE_PATTERN.test(file));
    const harness = report.harnessDelta || {
        touched: [], deletedFiles: [], removedGuardIds: [],
        removedInvocations: [], shrunkMutationTests: [],
    };
    const harnessWeakened = harness.deletedFiles.length > 0
        || harness.removedGuardIds.length > 0
        || harness.removedInvocations.length > 0
        || harness.shrunkMutationTests.length > 0;
    if (report.protectedTouched.length === 0 && harness.touched.length === 0) {
        return { classification: 'product-only', errors };
    }

    const delta = report.policyDelta;
    const grownMayDependOn = Object.keys(delta.mayDependOnGrown).length > 0;
    const grownWriters = Object.keys(delta.writersGrown).length > 0;
    const grownBaseline = delta.baselineGrown.length > 0;
    const addedWaivers = delta.waiversAdded.length > 0;
    const relaxing = grownMayDependOn || grownWriters || grownBaseline || addedWaivers
        || harnessWeakened;
    const rePartition = !relaxing && delta.modulesChanged
        && report.protectedTouched
            .some(file => file.endsWith('architecture-modules.json'));

    if (!relaxing && !rePartition) {
        return { classification: 'tightening', errors };
    }
    const classification = relaxing ? 'relaxing' : 're-partition';
    if (!hasArchChangeRecord) {
        errors.push(`anti-self-amendment: this change ${classification === 'relaxing' ? 'relaxes' : 're-partitions'} `
            + 'architecture policy or weakens the harness without an Architecture Change record — add '
            + 'docs/architecture/changes/ARCH-CHANGE-<seq>.md with evidence, alternatives, '
            + 'compatibility impact, migration, tests, and rollback');
    }
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
    runArchitectureChangeCheck,
};
