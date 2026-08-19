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
const { compileGlob } = require('./loadArchitecturePolicy');
const { fingerprintFields } = require('./architectureChangeRecords');

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
    // The merge-approval gate machinery (review R4): the last enforcement
    // line must not be weakenable by an ordinary product change.
    'scripts/run-merge-approval-gate.js',
    'scripts/run-merge-approval-audit.js',
    'scripts/lib/mergeApprovals.js',
    'scripts/lib/changeImpactContext.js',
    'tests/unit/tooling/mergeApprovals.test.js',
    'tests/unit/tooling/mergeApprovalGate.test.js',
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
                // Renames report as 'R<score> old new': keep both ends so the
                // source module is never lost (round-2 review Important 2).
                return {
                    status: status[0],
                    path: paths[paths.length - 1],
                    oldPath: status[0] === 'R' ? paths[0] : undefined,
                };
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
        listFiles(ref, prefix) {
            const output = execFileSync(
                'git', ['ls-tree', '-r', '--name-only', ref, '--', prefix],
                { cwd: rootDirectory, encoding: 'utf8'});
            return output.trim().split('\n').filter(Boolean);
        },
    };
}

function parseJsonOrNull(text) {
    if (text === null || text === undefined) { return null; }
    try { return JSON.parse(text); } catch { return null; }
}

/** Semantic invariant fields tracked by the delta (round-2 review Blocker 3). */
const INVARIANT_SEMANTIC_FIELDS = [
    'writers',
    'authority',
    'statement',
    'linearizationPoint',
    'stateFamily',
    'participatingModules',
];

/** Classify one file against a base registry snapshot (exact-once holds there). */
function classifyFileWithRegistry(registryJson, file) {
    for (const module of (registryJson && registryJson.modules) || []) {
        const source = module.source || {};
        const includes = (source.include || []).map(compileGlob);
        const excludes = (source.exclude || []).map(compileGlob);
        if (includes.some(pattern => pattern.test(file))
            && !excludes.some(pattern => pattern.test(file))) {
            return module.id;
        }
    }
    return null;
}

function invariantChangeEntry(baseInvariant, headInvariant) {
    const changedFields = INVARIANT_SEMANTIC_FIELDS.filter(field =>
        JSON.stringify(baseInvariant[field]) !== JSON.stringify(headInvariant[field]));
    if (changedFields.length === 0) { return null; }
    const pick = invariant => Object.fromEntries(
        changedFields.map(field => [field, invariant[field]]));
    return {
        fields: changedFields,
        before: fingerprintFields(pick(baseInvariant)),
        after: fingerprintFields(pick(headInvariant)),
    };
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
 * Full impact report. git helpers: { changedFiles(baseRef), fileAt(ref, path),
 * listFiles(ref, prefix) }.
 */
function collectArchitectureDiff({ rootDirectory, baseRef, git }) {
    const policy = loadArchitecturePolicy(rootDirectory);
    const changed = git.changedFiles(baseRef);

    // Architecture Change records are historical ADRs (Harness
    // Simplification PR 3/6): nothing consumes them anymore, so the diff no
    // longer collects them.

    const touchedModules = new Map();
    const newFiles = [];
    const newClassifiedFiles = [];
    const removedFiles = [];
    const removedClassifiedFiles = [];
    // Round-2 review Important 2: touched modules are the union of the head
    // and base classifications — a deleted file still reports its base
    // module, and a rename registers both ends.
    const baseRegistryJson = parseJsonOrNull(git.fileAt(baseRef, 'docs/testing/architecture-modules.json'));
    for (const entry of changed) {
        const assignment = policy.classification.get(entry.path);
        if (assignment) {
            if (!touchedModules.has(assignment.moduleId)) {
                touchedModules.set(assignment.moduleId, []);
            }
            touchedModules.get(assignment.moduleId).push(entry.path);
        }
        // Base-side attribution: only deletions and rename old-ends — a file
        // with a head classification is already attributed above, and a new
        // file never had a base presence.
        const baseModule = (entry.status === 'D' && baseRegistryJson)
            ? classifyFileWithRegistry(baseRegistryJson, entry.path)
            : null;
        if (baseModule) {
            if (!touchedModules.has(baseModule)) { touchedModules.set(baseModule, []); }
            touchedModules.get(baseModule).push(entry.path);
        }
        if (entry.oldPath && baseRegistryJson) {
            const oldModule = classifyFileWithRegistry(baseRegistryJson, entry.oldPath);
            if (oldModule && oldModule !== assignment?.moduleId) {
                if (!touchedModules.has(oldModule)) { touchedModules.set(oldModule, []); }
                touchedModules.get(oldModule).push(entry.oldPath);
            }
        }
        if (entry.status === 'A') {
            newFiles.push(entry.path);
            if (assignment) {
                newClassifiedFiles.push({ path: entry.path, module: assignment.moduleId });
            }
        }
        if (entry.status === 'D') {
            removedFiles.push(entry.path);
            if (baseModule) {
                removedClassifiedFiles.push({ path: entry.path, module: baseModule });
            }
        }
    }
    newClassifiedFiles.sort((a, b) => a.path.localeCompare(b.path));
    removedClassifiedFiles.sort((a, b) => a.path.localeCompare(b.path));

    // Behavior contract drift for the declaration (round-2 review
    // Important 2): ids added, removed, or modified in behavior-contracts.json.
    const changedBehaviorIds = [];
    const behaviorPath = 'docs/testing/behavior-contracts.json';
    if (changed.some(entry => entry.path === behaviorPath)) {
        const baseContracts = parseJsonOrNull(git.fileAt(baseRef, behaviorPath));
        const headContracts = parseJsonOrNull(git.fileAt('HEAD', behaviorPath));
        const baseById = new Map((Array.isArray(baseContracts) ? baseContracts : [])
            .map(entry => [entry.id, entry]));
        const headById = new Map((Array.isArray(headContracts) ? headContracts : [])
            .map(entry => [entry.id, entry]));
        for (const [id, entry] of headById) {
            if (!baseById.has(id)
                || JSON.stringify(baseById.get(id)) !== JSON.stringify(entry)) {
                changedBehaviorIds.push(id);
            }
        }
        for (const id of baseById.keys()) {
            if (!headById.has(id)) { changedBehaviorIds.push(id); }
        }
    }
    // Module re-assignments (round-2 review Blocker 3): when the registry
    // changed, classify every changed file against the BASE registry and
    // record moves; each move must be declared in the record's fileMoves.
    const moduleMoves = [];
    if (baseRegistryJson && JSON.stringify(baseRegistryJson) !== JSON.stringify(
        parseJsonOrNull(git.fileAt('HEAD', 'docs/testing/architecture-modules.json')))) {
        for (const entry of changed) {
            const baseModule = classifyFileWithRegistry(baseRegistryJson, entry.path);
            const headModule = policy.classification.get(entry.path)?.moduleId || null;
            if (baseModule && headModule && baseModule !== headModule) {
                moduleMoves.push({ path: entry.path, from: baseModule, to: headModule });
            }
        }
    }

    const policyDelta = {
        mayDependOnGrown: {},
        entrypointsGrown: {},
        invariantChanges: {},
        invariantsRemoved: [],
        baselineGrown: [],
        waiversAdded: [],
        ledgerRegressions: [],
        modulesChanged: false,
    };
    const changedInvariantIds = [];
    const changedInvariantModules = [];
    const removedInvariantRecords = {};
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
                // Review R9 (Important 6): a new public entrypoint broadens
                // the module surface — relaxing; removing one narrows it.
                const entrypointsGrown = diffStringSets(
                    baseModule.publicEntrypoints || [], headModule.publicEntrypoints || []).added;
                if (entrypointsGrown.length > 0) {
                    policyDelta.entrypointsGrown[id] = entrypointsGrown;
                }
            }
        }
        if (protectedPath.endsWith('architecture-invariants.json')) {
            const baseInvariants = indexBy(baseJson.invariants, 'id');
            const headInvariants = indexBy(headJson.invariants, 'id');
            for (const [id, headInvariant] of headInvariants) {
                const baseInvariant = baseInvariants.get(id);
                if (!baseInvariant) {
                    changedInvariantIds.push(id);
                    continue;
                }
                const entry = invariantChangeEntry(baseInvariant, headInvariant);
                if (!entry) { continue; }
                changedInvariantIds.push(id);
                if (headInvariant.module) { changedInvariantModules.push(headInvariant.module); }
                // Review R9 (Important 4) + round-2 Blocker 3: every semantic
                // field change is recorded with before/after fingerprints;
                // only a pure writer removal with an unchanged authority is a
                // tightening.
                policyDelta.invariantChanges[id] = {
                    ...entry,
                    writersAdded: diffStringSets(
                        baseInvariant.writers || [], headInvariant.writers || []).added,
                    writersRemoved: diffStringSets(
                        baseInvariant.writers || [], headInvariant.writers || []).removed,
                    authorityChanged: entry.fields.includes('authority'),
                    statementChanged: entry.fields.includes('statement'),
                    linearizationPointChanged: entry.fields.includes('linearizationPoint'),
                    stateFamilyChanged: entry.fields.includes('stateFamily'),
                    participatingModulesChanged: entry.fields.includes('participatingModules'),
                };
            }
            for (const id of baseInvariants.keys()) {
                if (!headInvariants.has(id)) {
                    changedInvariantIds.push(id);
                    policyDelta.invariantsRemoved.push(id);
                    removedInvariantRecords[id] = baseInvariants.get(id);
                    if (baseInvariants.get(id) && baseInvariants.get(id).module) {
                        changedInvariantModules.push(baseInvariants.get(id).module);
                    }
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
        if (protectedPath.endsWith('architecture-program.json')) {
            // Review R9 (Important 9): ledger state regressions are relaxing
            // (a module stepping backwards cannot ride a product change);
            // forward moves along the declared chain are progress.
            const baseModules = baseJson.modules || {};
            const headModules = headJson.modules || {};
            const stateOrder = Array.isArray(headJson.states) ? headJson.states : [];
            for (const [id, headEntry] of Object.entries(headModules)) {
                const baseEntry = baseModules[id];
                if (!baseEntry || !headEntry || baseEntry.state === headEntry.state) { continue; }
                const fromIndex = stateOrder.indexOf(baseEntry.state);
                const toIndex = stateOrder.indexOf(headEntry.state);
                if (fromIndex < 0 || toIndex < 0 || toIndex < fromIndex) {
                    policyDelta.ledgerRegressions.push(
                        `${id}: ${baseEntry.state} -> ${headEntry.state}`);
                }
                // T7 (Important 9): skip-state detection — a module may only
                // advance to the next state in the chain, not skip over
                // intermediate states (e.g. legacy -> strict is illegal).
                if (toIndex >= 0 && fromIndex >= 0 && toIndex > fromIndex + 1) {
                    const skipped = stateOrder.slice(fromIndex + 1, toIndex).join(', ');
                    policyDelta.ledgerRegressions.push(
                        `${id}: skip-state ${baseEntry.state} -> ${headEntry.state} `
                        + `(skipped ${skipped})`);
                }
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
        newClassifiedFiles,
        removedFiles: removedFiles.sort(),
        removedClassifiedFiles,
        protectedTouched,
        harnessDelta,
        policyDelta,
        moduleMoves,
        changedBehaviorIds: changedBehaviorIds.sort(),
        changedInvariantIds: changedInvariantIds.sort(),
        changedInvariantModules: [...new Set(changedInvariantModules)].sort(),
        removedInvariantRecords,
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
    for (const [id, entrypoints] of Object.entries(report.policyDelta.entrypointsGrown || {})) {
        lines.push(`  entrypoints broadened: ${id} += ${entrypoints.join(', ')}`);
    }
    for (const regression of report.policyDelta.ledgerRegressions || []) {
        lines.push(`  ledger regression: ${regression}`);
    }
    for (const [id, change] of Object.entries(report.policyDelta.invariantChanges || {})) {
        const parts = [];
        if (change.writersAdded) { parts.push(`writers += ${change.writersAdded.join(', ')}`); }
        if (change.writersRemoved) { parts.push(`writers -= ${change.writersRemoved.join(', ')}`); }
        if (change.authorityChanged) { parts.push('authority changed'); }
        if (change.statementChanged) { parts.push('statement changed'); }
        if (change.linearizationPointChanged) { parts.push('linearization point changed'); }
        if (change.stateFamilyChanged) { parts.push('state family changed'); }
        lines.push(`  invariant changed: ${id} (${parts.join('; ')})`);
    }
    for (const id of report.policyDelta.invariantsRemoved || []) {
        lines.push(`  invariant removed: ${id}`);
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
