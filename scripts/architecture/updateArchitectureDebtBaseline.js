'use strict';

/**
 * Debt baseline generator (Harness v0).
 *
 * Regenerates .ci/architecture-debt-baseline.json rule by rule from the
 * current dependency graph. Baseline capture is deliberate: run this script
 * when a reviewed rule's current violations are accepted as legacy debt, and
 * pair every fingerprint with a waiver in docs/testing/architecture-waivers.json.
 * Never runs in CI (like the coverage baseline writer).
 */

const fs = require('fs');
const path = require('path');
const { buildDependencyGraph } = require('./buildDependencyGraph');
const { cycleFingerprints, BASELINE_PATH } = require('./checkModuleBoundaries');

function generateBaseline(rootDirectory) {
    const { edges, errors } = buildDependencyGraph(rootDirectory);
    if (errors.length > 0) {
        return { written: false, errors };
    }
    const fingerprints = cycleFingerprints(edges);
    const baseline = {
        version: 1,
        generatedBy: 'scripts/architecture/updateArchitectureDebtBaseline.js',
        note: 'Exact violation fingerprints per implemented rule. Debt may shrink or '
            + 'stay; it may never grow, move, or change identity invisibly.',
        rules: {
            'module-cycle': { fingerprints },
        },
    };
    const target = path.join(rootDirectory, BASELINE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n');
    return { written: true, fingerprints };
}

function main() {
    if (process.env.CI) {
        console.error('Refusing to write the architecture debt baseline in CI.');
        process.exitCode = 1;
        return;
    }
    const rootDirectory = path.resolve(__dirname, '..', '..');
    const result = generateBaseline(rootDirectory);
    if (!result.written) {
        console.error('Cannot generate a baseline over a broken graph:');
        for (const error of result.errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log(`Baseline written: ${result.fingerprints.length} module-cycle fingerprints.`);
    console.log('Pair every fingerprint with a waiver in docs/testing/architecture-waivers.json.');
}

if (require.main === module) { main(); }

module.exports = { generateBaseline };
