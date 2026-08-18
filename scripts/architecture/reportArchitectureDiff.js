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
    '.ci/architecture-debt-baseline.json',
];

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
                const grown = diffStringSets(
                    baseInvariant.writers || [], headInvariant.writers || []).added;
                if (grown.length > 0) { policyDelta.writersGrown[id] = grown; }
            }
        }
        if (protectedPath.endsWith('architecture-debt-baseline.json')) {
            const flatten = json => Object.values((json && json.rules) || {})
                .flatMap(rule => rule.fingerprints || []);
            policyDelta.baselineGrown = diffStringSets(flatten(baseJson), flatten(headJson)).added;
        }
        if (protectedPath.endsWith('architecture-waivers.json')) {
            policyDelta.waiversAdded = diffStringSets(
                (baseJson.waivers || []).map(waiver => waiver.id),
                (headJson.waivers || []).map(waiver => waiver.id)).added;
        }
    }

    const protectedTouched = changed
        .map(entry => entry.path)
        .filter(file => PROTECTED_POLICY_PATHS.includes(file));

    return {
        baseRef,
        errors: policy.errors,
        touchedModules: Object.fromEntries(touchedModules),
        newFiles: newFiles.sort(),
        removedFiles: removedFiles.sort(),
        protectedTouched,
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
    collectArchitectureDiff,
    defaultGit,
    diffStringSets,
    formatReport,
};
