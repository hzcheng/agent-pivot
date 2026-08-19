#!/usr/bin/env node
'use strict';

/**
 * Architecture diff reporter (Harness Simplification PR #296).
 *
 * Prints the architecture diff for the current branch. No longer generates
 * record-ready deltas — Architecture Change records are historical ADRs.
 *
 * Usage: node scripts/architecture/describeArchitectureChange.js [base-ref]
 */

const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('./reportArchitectureDiff');
const { classifyArchitectureChange } = require('./checkArchitectureChange');

function describeArchitectureChange(rootDirectory, baseRef) {
    const report = collectArchitectureDiff({
        rootDirectory,
        baseRef: baseRef || process.env.COVERAGE_DIFF_BASE
            || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
            || 'origin/main',
        git: defaultGit(rootDirectory),
    });
    const { classification } = classifyArchitectureChange(report);
    return {
        classification,
        policyDelta: report.policyDelta,
        protectedTouched: report.protectedTouched,
        harnessTouched: (report.harnessDelta || {}).touched || [],
        touchedModules: Object.keys(report.touchedModules || {}),
    };
}

function main() {
    const root = path.resolve(__dirname, '..', '..');
    const result = describeArchitectureChange(root, process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) { main(); }

module.exports = { describeArchitectureChange };
