'use strict';

/**
 * Module boundary enforcement (Harness v0, program Stage 2 PR 2).
 *
 * Rules:
 * - R-BOUNDARY: every resolved cross-module edge must be declared in the
 *   source module's mayDependOn. Reality was measured into the registry, so
 *   any NEW undeclared edge fails.
 * - R-ENTRYPOINT: every cross-module edge must land on a declared public
 *   entrypoint of the target module. The coarse registry declares whole
 *   module surfaces; waves narrow them per module.
 * - R-CYCLE: module-level value-edge cycles are ratcheted — the baseline
 *   records direct 2-cycles and the cyclic SCC clusters; a new 2-cycle, a
 *   grown/new SCC, or a baseline entry that no longer occurs all fail.
 * - Waiver coherence: every baseline fingerprint is covered by exactly one
 *   active waiver and every waiver fingerprint matches a baseline entry.
 */

const fs = require('fs');
const path = require('path');
const {
    buildDependencyGraph,
    moduleTwoCycles,
    moduleCyclicClusters,
} = require('./buildDependencyGraph');
const { REGISTRY_PATH, compileGlob } = require('./loadArchitecturePolicy');

const BASELINE_PATH = path.join('.ci', 'architecture-debt-baseline.json');
const WAIVERS_PATH = path.join('docs', 'testing', 'architecture-waivers.json');

function readJson(rootDirectory, relativePath, errors, label) {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
    } catch (error) {
        errors.push(`${label}: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

function cycleFingerprints(edges) {
    return [
        ...moduleTwoCycles(edges).map(pair => `2:${pair}`),
        ...moduleCyclicClusters(edges).map(cluster => `scc:${cluster}`),
    ];
}

function runModuleBoundaryCheck(rootDirectory) {
    const errors = [];
    const { edges, errors: graphErrors, classification } = buildDependencyGraph(rootDirectory);
    errors.push(...graphErrors);

    const registry = readJson(rootDirectory, REGISTRY_PATH, errors, 'boundary');
    const baseline = readJson(rootDirectory, BASELINE_PATH, errors, 'baseline');
    const waivers = readJson(rootDirectory, WAIVERS_PATH, errors, 'waivers');
    if (errors.length > 0 || !registry || !baseline || !waivers) {
        return { errors, violations: [] };
    }

    const modulesById = new Map(registry.modules.map(module => [module.id, module]));

    // R-BOUNDARY + R-ENTRYPOINT
    const entrypointMatchers = new Map();
    for (const module of registry.modules) {
        entrypointMatchers.set(module.id, (module.publicEntrypoints || []).map(compileGlob));
    }
    for (const edge of edges) {
        if (edge.sourceModule === edge.targetModule) { continue; }
        const source = modulesById.get(edge.sourceModule);
        if (!(source.mayDependOn || []).includes(edge.targetModule)) {
            errors.push(`module-boundary: ${edge.source} (${edge.sourceModule}) imports `
                + `${edge.target} (${edge.targetModule}) without a declared mayDependOn — `
                + 'declare the edge in ' + REGISTRY_PATH + ' via an approved architecture change');
        }
        const entrypoints = entrypointMatchers.get(edge.targetModule) || [];
        // Review R9 (Important 6): the entrypoint check never fails open —
        // the loader rejects empty entrypoint lists, and an empty matcher
        // here still fails the edge rather than skipping the check.
        if (!entrypoints.some(pattern => pattern.test(edge.target))) {
            errors.push(`module-boundary: ${edge.source} deep-imports ${edge.target}, which is not a `
                + `declared public entrypoint of ${edge.targetModule}`);
        }
    }

    // R-CYCLE vs baseline
    const rule = baseline.rules && baseline.rules['module-cycle'];
    if (!rule || !Array.isArray(rule.fingerprints)) {
        errors.push('baseline: rules["module-cycle"].fingerprints must be an array');
    } else {
        const baselineSet = new Set(rule.fingerprints);
        const current = cycleFingerprints(edges);
        for (const fingerprint of current) {
            if (!baselineSet.has(fingerprint)) {
                errors.push(`module-cycle: new cycle debt '${fingerprint}' — new architecture debt `
                    + 'is rejected; break the cycle or land an approved architecture change first');
            }
        }
        for (const fingerprint of rule.fingerprints) {
            if (!current.includes(fingerprint)) {
                errors.push(`module-cycle: baseline entry '${fingerprint}' no longer occurs — `
                    + 'regenerate the baseline and retire its waiver (debt removal is recorded, not left stale)');
            }
        }
    }

    // Waiver coherence (bijection with the baseline, milestone retirement)
    const waiverList = Array.isArray(waivers.waivers) ? waivers.waivers : [];
    const baselineFingerprints = new Set(
        Object.values(baseline.rules || {}).flatMap(entry => entry.fingerprints));
    const coveredFingerprints = new Set();
    const waiverIds = new Set();
    for (const waiver of waiverList) {
        if (!waiver.id || waiverIds.has(waiver.id)) {
            errors.push(`waivers: duplicate or missing waiver id '${waiver.id}'`);
        }
        waiverIds.add(waiver.id);
        if (!waiver.owner || !waiver.reason || !waiver.retiresWith) {
            errors.push(`waivers: ${waiver.id} must carry owner, reason, and retiresWith milestone`);
        }
        if (!Array.isArray(waiver.fingerprints) || waiver.fingerprints.length === 0) {
            errors.push(`waivers: ${waiver.id} must list an explicit fingerprint set (no wildcards)`);
            continue;
        }
        for (const fingerprint of waiver.fingerprints) {
            if (!baselineFingerprints.has(fingerprint)) {
                errors.push(`waivers: ${waiver.id} covers '${fingerprint}', which is not an active `
                    + 'baseline fingerprint');
            }
            if (coveredFingerprints.has(fingerprint)) {
                errors.push(`waivers: fingerprint '${fingerprint}' is covered by more than one waiver`);
            }
            coveredFingerprints.add(fingerprint);
        }
    }
    for (const fingerprint of baselineFingerprints) {
        if (!coveredFingerprints.has(fingerprint)) {
            errors.push(`waivers: baseline fingerprint '${fingerprint}' has no active waiver`);
        }
    }

    return { errors };
}

function main() {
    const { errors } = runModuleBoundaryCheck(path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error('Module boundary checks FAILED:');
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log('Module boundary checks passed: all cross-module edges declared, '
        + 'entrypoints respected, cycle debt ratcheted, waivers coherent.');
}

if (require.main === module) { main(); }

module.exports = {
    BASELINE_PATH,
    WAIVERS_PATH,
    cycleFingerprints,
    runModuleBoundaryCheck,
};
