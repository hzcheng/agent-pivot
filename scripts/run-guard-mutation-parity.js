'use strict';

/**
 * Guard mutation parity (round-2 review Blocker 1, second half).
 *
 * A PR can weaken a protected guard AND gut its tests while preserving the
 * 'controlled mutation' text count, and the harness-surface delta would stay
 * "tightening". The independent kill: when a PR touches the protected harness
 * surface WITHOUT a record-authorized relaxation, re-run the BASE versions of
 * the guard test suites against the HEAD guard code. The PR's own test edits
 * are irrelevant — the base suites are materialized from the base ref and
 * executed against the head scripts. A guard turned constant-true stops
 * killing its base mutations and fails here.
 *
 * Record-authorized relaxing/re-partition changes are exempt: guard semantic
 * changes go through the Architecture Change record flow (owner review), not
 * through this ratchet.
 *
 * Usage: node scripts/run-guard-mutation-parity.js  (quality-linux lane)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    runArchitectureChangeCheck,
} = require('./architecture/checkArchitectureChange');
const {
    parseArchitectureChangeRecord,
} = require('./architecture/architectureChangeRecords');

const BASE_TEST_GLOBS = [
    'tests/unit/architecture/',
    'tests/unit/tooling/architectureGuards.test.js',
];

function git(rootDirectory, args) {
    return execFileSync('git', args, { cwd: rootDirectory, encoding: 'utf8' }).trim();
}

function listBaseTestFiles(rootDirectory, baseRef) {
    const files = [];
    for (const entry of BASE_TEST_GLOBS) {
        if (entry.endsWith('.test.js')) {
            files.push(entry);
            continue;
        }
        const listing = git(rootDirectory, ['ls-tree', '-r', '--name-only', baseRef, '--', entry]);
        if (listing) {
            files.push(...listing.split('\n').filter(name => name.endsWith('.test.js')));
        }
    }
    return files;
}

/**
 * Materialize the base test suites at the same relative depth so their
 * relative requires ('../../../scripts/...', '../../helpers/...') resolve
 * against the HEAD tree, and run them against the HEAD guard code.
 */
function runParity(rootDirectory, baseRef) {
    const parityDirectory = path.join(rootDirectory, 'tests', 'unit', 'architecture-parity');
    fs.rmSync(parityDirectory, { recursive: true, force: true });
    fs.mkdirSync(parityDirectory, { recursive: true });
    const materialized = [];
    try {
        for (const testFile of listBaseTestFiles(rootDirectory, baseRef)) {
            let text;
            try {
                text = git(rootDirectory, ['show', `${baseRef}:${testFile}`]);
            } catch {
                continue; // the test did not exist at the base ref
            }
            const target = path.join(parityDirectory, path.basename(testFile));
            fs.writeFileSync(target, text);
            materialized.push(target);
        }
        if (materialized.length === 0) {
            return { passed: true, note: 'no base guard tests found', tested: 0 };
        }
        const result = (() => {
            try {
                execFileSync('node', ['--test', ...materialized.map(file => path.basename(file))], {
                    cwd: parityDirectory,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                return { failed: false };
            } catch (error) {
                return { failed: true, output: `${error.stdout || ''}${error.stderr || ''}` };
            }
        })();
        if (result.failed) {
            return {
                passed: false,
                note: 'base guard tests failed against the head guard code:\n'
                    + (result.output || '').split('\n').slice(-30).join('\n'),
                tested: materialized.length,
            };
        }
        return { passed: true, tested: materialized.length };
    } finally {
        fs.rmSync(parityDirectory, { recursive: true, force: true });
    }
}

function main() {
    const rootDirectory = path.resolve(__dirname, '..');
    const { classification, report } = runArchitectureChangeCheck(rootDirectory);
    const harnessTouched = (report.harnessDelta && report.harnessDelta.touched) || [];
    if (harnessTouched.length === 0) {
        console.log('Guard mutation parity: no harness surface change; nothing to verify.');
        return;
    }
    if (classification === 'relaxing' || classification === 're-partition') {
        console.log(`Guard mutation parity: harness change is ${classification} — covered by the `
            + 'Architecture Change record flow; the base-suite ratchet does not apply.');
        return;
    }
    // Guard-semantics records (round-2 Blocker 3): an intentional guard
    // contract change is owner-reviewed via a base-landed record declaring
    // guardSemantics; the base suites legitimately diverge there.
    const exempting = (report.baseRecords || [])
        .map(({ path: recordPath, text }) => parseArchitectureChangeRecord({ path: recordPath, text }))
        .filter(parsed => parsed.record)
        .some(parsed => parsed.record.delta.guardSemantics === true);
    if (exempting) {
        console.log('Guard mutation parity: a base-landed record declares guardSemantics — the '
            + 'intentional guard contract change is owner-reviewed; the base-suite ratchet '
            + 'does not apply.');
        return;
    }
    const baseRef = process.env.COVERAGE_DIFF_BASE
        || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
        || 'origin/main';
    const result = runParity(rootDirectory, baseRef);
    if (!result.passed) {
        console.error(`Guard mutation parity FAILED for ${classification} harness change: `
            + 'the head guard code no longer satisfies the base test suites.');
        console.error(result.note);
        console.error('Fix the guard change, or land an Architecture Change record first if the '
            + 'guard semantics intentionally change.');
        process.exitCode = 1;
        return;
    }
    console.log(`Guard mutation parity passed: ${result.tested} base guard test file(s) green `
        + `against the head guard code (${classification}).`);
}

if (require.main === module) { main(); }

module.exports = { runParity };
