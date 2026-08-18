'use strict';

/**
 * Architecture impact report (Harness v0, program Stage 2 PR 4).
 *
 * Compares HEAD against a base ref and reports the architecture impact:
 * touched modules (via the closed-world classifier), new/removed production
 * files and their classification, and the policy delta over the protected
 * architecture files (module registry, invariant catalog, waiver ledger,
 * debt baseline).
 *
 * Library-first: collectArchitectureDiff takes explicit git helpers so the
 * unit tests can run without a repository fixture.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

const PROTECTED_POLICY_PATHS = [
    'docs/testing/architecture-modules.json',
    'docs/testing/architecture-invariants.json',
    'docs/testing/architecture-waivers.json',
    'docs/testing/architecture-webview-manifest.json',
    'docs/testing/architecture-program.json',
    '.ci/architecture-debt-baseline.json',
];

/**
 * The harness surface (review R2): guard implementations, guard tests, and
 * CI wiring. Changes here can never classify as product-only — a weakened
 * guard, a removed mutation test, or a dropped CI invocation must fail.
 */
const PROTECTED_HARNESS_PREFIXES = [
    'scripts/architecture/',
    'tests/unit/architecture/',
    '.github/workflows/',
];
const PROTECTED_HARNESS_FILES = [
    'scripts/run-architecture-guards.js',
    'scripts/lib/ciContracts.js',
    'package.json',
];

function isHarnessPath(file) {
    return PROTECTED_HARNESS_PREFIXES.some(prefix => file.startsWith(prefix))
        || PROTECTED_HARNESS_FILES.includes(file);
}

/** Guard ids declared by the legacy runner. */
function guardIdsOf(text) {
    return new Set([...text.matchAll(/'(ARCH-[A-Z0-9-]+)'\(root\)/g)].map(m => m[1]));
}

/** Check/lane invocations (node scripts/... and npm run test:...) in text. */
function invocationsOf(text) {
    return new Set([...text.matchAll(/node\s+scripts\/[a-zA-Z0-9/.-]+|npm\s+run\s+test:[a-zA-Z0-9:-]+/g)]
        .map(m => m[0].replace(/\s+/g, ' ')));
}

function mutationTestCountOf(text) {
    return (text.match(/controlled mutation/g) || []).length;
}

function defaultGit(rootDirectory) {
    return {
        changedFiles(baseRef) {
            const output = execFileSync(
                'git', ['diff', '--name-status', `${baseRef}...HEAD`],
                { cwd: rootDirectory, encoding: 'utf8'});
            return output.trim().split('\n').filter(Boolean).map(line => {
                const [status, ...paths] = line.split('\t');
                return { status: status[0], path: paths[paths.length - 1] };
            });
        },
        fileAt(ref, relativePath) {
            try {
                return execFileSync('git', ['show', `${ref}:${relativePath}`],
                    { cwd: rootDirectory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            } catch {
                return null;
            }
        },
    };
}

function parseJsonOrNull(text) {
    if (text === null || text === undefined) { return null; }
    try { return JSON.parse(text); } catch { return null; }
}

function indexBy(list, key) {
    const map = new Map();
    for (const entry of list || []) { map.set(entry[key], entry); }
    return map;
}

function diffStringSets(baseValues, headValues) {
    const base = new Set(baseValues);
    const head = new Set(headValues);
    return {
        added: [...head].filter(value => !base.has(value)).sort(),
        removed: [...base].filter(value => !head.has(value)).sort(),
    };
}

/**
 * Full impact report. git helpers: { changedFiles(baseRef), fileAt(ref, path) }.
 */
function collectArchitectureDiff({ rootDirectory, baseRef, git }) {
    const policy = loadArchitecturePolicy(rootDirectory);
    const changed = git.changedFiles(baseRef);

    const touchedModules = new Map();
    const newFiles = [];
    const removedFiles = [];
    for (const entry of changed) {
        const assignment = policy.classification.get(entry.path);
        if (assignment) {
            if (!touchedModules.has(assignment.moduleId)) {
                touchedModules.set(assignment.moduleId, []);
            }
            touchedModules.get(assignment.moduleId).push(entry.path);
        }
        if (entry.status === 'A') { newFiles.push(entry.path); }
        if (entry.status === 'D') { removedFiles.push(entry.path); }
    }

    const policyDelta = {
        mayDependOnGrown: {},
        writersGrown: {},
        baselineGrown: [],
        waiversAdded: [],
        modulesChanged: false,
    };
    for (const protectedPath of PROTECTED_POLICY_PATHS) {
        const baseText = git.fileAt(baseRef, protectedPath);
        const headText = git.fileAt('HEAD', protectedPath);
        if (baseText === headText) { continue; }
        policyDelta.modulesChanged = true;
        const baseJson = parseJsonOrNull(baseText);
        const headJson = parseJsonOrNull(headText);
        if (!baseJson || !headJson) { continue; }
        if (protectedPath.endsWith('architecture-modules.json')) {
            const baseModules = indexBy(baseJson.modules, 'id');
            const headModules = indexBy(headJson.modules, 'id');
            for (const [id, headModule] of headModules) {
                const baseModule = baseModules.get(id);
                if (!baseModule) { continue; }
                const grown = diffStringSets(
                    baseModule.mayDependOn || [], headModule.mayDependOn || []).added;
                if (grown.length > 0) { policyDelta.mayDependOnGrown[id] = grown; }
            }
        }
        if (protectedPath.endsWith('architecture-invariants.json')) {
            const baseInvariants = indexBy(baseJson.invariants, 'id');
            const headInvariants = indexBy(headJson.invariants, 'id');
            for (const [id, headInvariant] of headInvariants) {
                const baseInvariant = baseInvariants.get(id);
                if (!baseInvariant) { continue; }
                // Writer sets ratchet by net size: an authority move replaces
                // old writers with fewer new ones (tightening); only net
                // growth beyond the base size is broadening.
                const baseWriters = baseInvariant.writers || [];
                const headWriters = headInvariant.writers || [];
                const added = diffStringSets(baseWriters, headWriters).added;
                if (added.length > 0 && headWriters.length > baseWriters.length) {
                    policyDelta.writersGrown[id] = added;
                }
            }
        }
        if (protectedPath.endsWith('architecture-debt-baseline.json')) {
            const flatten = json => Object.values((json && json.rules) || {})
                .flatMap(rule => rule.fingerprints || []);
            policyDelta.baselineGrown = diffStringSets(flatten(baseJson), flatten(headJson)).added;
        }
        if (protectedPath.endsWith('architecture-waivers.json')) {
            // Waivers pair bijectively with baseline fingerprints; only net
            // growth beyond the base count is new debt.
            const baseWaivers = (baseJson.waivers || []).map(waiver => waiver.id);
            const headWaivers = (headJson.waivers || []).map(waiver => waiver.id);
            const added = diffStringSets(baseWaivers, headWaivers).added;
            if (added.length > 0 && headWaivers.length > baseWaivers.length) {
                policyDelta.waiversAdded = added;
            }
        }
    }

    const protectedTouched = changed
        .map(entry => entry.path)
        .filter(file => PROTECTED_POLICY_PATHS.includes(file));

    // Harness surface delta (review R2): deletions and removals of guard
    // ids, lane invocations, workflow invocations, or mutation tests.
    const harnessDelta = {
        touched: [],
        deletedFiles: [],
        removedGuardIds: [],
        removedInvocations: [],
        shrunkMutationTests: [],
    };
    for (const entry of changed) {
        if (!isHarnessPath(entry.path)) { continue; }
        harnessDelta.touched.push(entry.path);
        if (entry.status === 'D') {
            harnessDelta.deletedFiles.push(entry.path);
            continue;
        }
        if (entry.status !== 'M') { continue; }
        const baseText = git.fileAt(baseRef, entry.path);
        const headText = git.fileAt('HEAD', entry.path);
        if (baseText === null || headText === null) { continue; }
        if (entry.path === 'scripts/run-architecture-guards.js') {
            const removed = [...guardIdsOf(baseText)]
                .filter(id => !guardIdsOf(headText).has(id));
            harnessDelta.removedGuardIds.push(...removed);
        }
        if (entry.path === 'package.json' || entry.path.startsWith('.github/workflows/')) {
            const removed = [...invocationsOf(baseText)]
                .filter(invocation => !invocationsOf(headText).has(invocation));
            harnessDelta.removedInvocations.push(...removed.map(invocation => `${entry.path}: ${invocation}`));
        }
        if (entry.path.startsWith('tests/unit/architecture/')) {
            const baseCount = mutationTestCountOf(baseText);
            const headCount = mutationTestCountOf(headText);
            if (headCount < baseCount) {
                harnessDelta.shrunkMutationTests.push(`${entry.path}: ${baseCount} -> ${headCount}`);
            }
        }
    }

    return {
        baseRef,
        errors: policy.errors,
        touchedModules: Object.fromEntries(touchedModules),
        newFiles: newFiles.sort(),
        removedFiles: removedFiles.sort(),
        protectedTouched,
        harnessDelta,
        policyDelta,
    };
}

function formatReport(report) {
    const lines = [];
    lines.push(`Architecture impact report (base: ${report.baseRef})`);
    const moduleIds = Object.keys(report.touchedModules).sort();
    lines.push(`  touched modules: ${moduleIds.length ? moduleIds.join(', ') : '(none)'}`);
    if (report.newFiles.length > 0) {
        lines.push(`  new files: ${report.newFiles.join(', ')}`);
    }
    if (report.removedFiles.length > 0) {
        lines.push(`  removed files: ${report.removedFiles.join(', ')}`);
    }
    if (report.protectedTouched.length > 0) {
        lines.push(`  protected policy files: ${report.protectedTouched.join(', ')}`);
    }
    const grown = Object.entries(report.policyDelta.mayDependOnGrown);
    for (const [id, edges] of grown) {
        lines.push(`  mayDependOn broadened: ${id} += ${edges.join(', ')}`);
    }
    const writersGrown = Object.entries(report.policyDelta.writersGrown);
    for (const [id, writers] of writersGrown) {
        lines.push(`  writers broadened: ${id} += ${writers.join(', ')}`);
    }
    if (report.policyDelta.baselineGrown.length > 0) {
        lines.push(`  baseline grew: ${report.policyDelta.baselineGrown.join(', ')}`);
    }
    if (report.policyDelta.waiversAdded.length > 0) {
        lines.push(`  waivers added: ${report.policyDelta.waiversAdded.join(', ')}`);
    }
    if (report.harnessDelta && report.harnessDelta.touched.length > 0) {
        lines.push(`  harness surface touched: ${report.harnessDelta.touched.join(', ')}`);
        for (const file of report.harnessDelta.deletedFiles) {
            lines.push(`  harness file deleted: ${file}`);
        }
        for (const id of report.harnessDelta.removedGuardIds) {
            lines.push(`  guard removed: ${id}`);
        }
        for (const invocation of report.harnessDelta.removedInvocations) {
            lines.push(`  invocation removed: ${invocation}`);
        }
        for (const entry of report.harnessDelta.shrunkMutationTests) {
            lines.push(`  mutation tests shrank: ${entry}`);
        }
    }
    return lines.join('\n');
}

function main() {
    const baseRef = process.env.COVERAGE_DIFF_BASE
        || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
        || 'origin/main';
    const report = collectArchitectureDiff({
        rootDirectory: path.resolve(__dirname, '..', '..'),
        baseRef,
        git: defaultGit(path.resolve(__dirname, '..', '..')),
    });
    console.log(formatReport(report));
}

if (require.main === module) { main(); }

module.exports = {
    PROTECTED_POLICY_PATHS,
    PROTECTED_HARNESS_PREFIXES,
    PROTECTED_HARNESS_FILES,
    collectArchitectureDiff,
    defaultGit,
    diffStringSets,
    formatReport,
    isHarnessPath,
};
