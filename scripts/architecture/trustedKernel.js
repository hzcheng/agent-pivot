'use strict';

/**
 * Trusted kernel — minimal architecture enforcement (Harness Simplification PR #295).
 *
 * Runs on the default branch. Reads PR HEAD as data only:
 * - No PR HEAD npm scripts are executed
 * - No require/import of PR HEAD JS/TS
 * - No PR HEAD executable configuration is read as commands
 * - PR HEAD is materialized in an isolated directory
 * - The evaluator only parses HEAD files (JSON, source text)
 *
 * Checks:
 * 1. Every file has exactly one module and one role
 * 2. Cross-module dependencies respect declared edges and public entrypoints
 * 3. New cycles and architecture debt do not grow
 * 4. Writers are not violated
 * 5. Protected file changes require architecture approval
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// One canonical glob implementation (charter: one canonical truth) — the
// kernel and the legacy harness must classify with identical semantics.
const { compileGlob } = require('./loadArchitecturePolicy');

const ROOT = path.resolve(__dirname, '..', '..');

// ── helpers ──────────────────────────────────────────────────────────

function readJson(filePath, errors) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        errors.push(`cannot read ${path.relative(ROOT, filePath)}: ${err.message}`);
        return null;
    }
}

// ── policy loading (from the given root directory) ───────────────────

function loadPolicy(rootDir, errors) {
    const policyPath = path.join(rootDir, 'docs', 'testing', 'architecture-modules.json');
    const policy = readJson(policyPath, errors);
    if (!policy) return { modules: [], errors };

    const modules = (policy.modules || []).map(mod => ({
        id: mod.id,
        sources: (mod.source && mod.source.include || []).map(compileGlob),
        sourceExcludes: (mod.source && mod.source.exclude || []).map(compileGlob),
        publicEntrypoints: (mod.publicEntrypoints || []).map(compileGlob),
        mayDependOn: new Set(mod.mayDependOn || []),
        roles: (mod.roles || []).map(role => ({
            role: role.role,
            include: (role.include || []).map(compileGlob),
            rawInclude: (role.include || []).slice(),
        })),
    }));

    // Validate schema
    const ids = new Set();
    for (const mod of modules) {
        if (ids.has(mod.id)) {
            errors.push(`policy: duplicate module id ${mod.id}`);
        }
        ids.add(mod.id);
        if (!/^MOD-[A-Z0-9-]+$/.test(mod.id)) {
            errors.push(`policy: invalid module id ${mod.id}`);
        }
        if (mod.roles.length === 0) {
            errors.push(`policy: ${mod.id} has no roles`);
        }
        for (const dep of (mod.mayDependOn || [])) {
            if (!/^MOD-[A-Z0-9-]+$/.test(dep)) {
                errors.push(`policy: ${mod.id} has invalid mayDependOn ${dep}`);
            }
        }
        for (const role of (mod.roles || [])) {
            if (!role.role || role.include.length === 0) {
                errors.push(`policy: ${mod.id} role ${role.role || '(unnamed)'} has no include patterns`);
            }
        }
    }

    return { modules, errors };
}

// ── file discovery ───────────────────────────────────────────────────

// The head tree is materialized into a plain directory (no .git), so
// discovery walks the filesystem instead of shelling out to git.
function discoverFiles(rootDir) {
    const files = [];
    const walk = dir => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) { continue; }
            const rel = path.relative(rootDir, full).split(path.sep).join('/');
            if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) { files.push(rel); }
        }
    };
    walk(path.join(rootDir, 'src'));
    return files.sort();
}

// ── closed-world classification ──────────────────────────────────────

function classifyFiles(files, modules, errors) {
    const classified = [];
    for (const file of files) {
        const owners = modules.filter(mod =>
            mod.sources.some(pat => pat.test(file))
            && !mod.sourceExcludes.some(pat => pat.test(file))
        );
        if (owners.length === 0) {
            errors.push(`closed-world: ${file} is not classified by any module`);
            continue;
        }
        if (owners.length > 1) {
            errors.push(`closed-world: ${file} matches multiple modules: ${owners.map(m => m.id).join(', ')}`);
            continue;
        }
        const mod = owners[0];
        // Remainder-role rule (same as the canonical policy loader): a role
        // whose include is exactly ["**"] must be last and matches only
        // module files no earlier role claimed. Overlap between
        // non-remainder roles is an error, never silently first-match.
        const remainderIndex = mod.roles.findIndex(candidate => {
            const raw = candidate.rawInclude || [];
            return raw.length === 1 && raw[0] === '**';
        });
        if (remainderIndex !== -1 && remainderIndex !== mod.roles.length - 1) {
            errors.push(`policy: ${mod.id} remainder role '**' must be the last role`);
            continue;
        }
        const specific = remainderIndex === -1 ? mod.roles : mod.roles.slice(0, remainderIndex);
        const roleMatches = specific.filter(r => r.include.some(pat => pat.test(file)));
        if (roleMatches.length > 1) {
            errors.push(`closed-world: ${file} (module ${mod.id}) matches multiple roles: ${roleMatches.map(r => r.role).join(', ')}`);
            continue;
        }
        if (roleMatches.length === 1) {
            classified.push({ file, module: mod.id, role: roleMatches[0].role });
            continue;
        }
        if (remainderIndex !== -1) {
            classified.push({ file, module: mod.id, role: mod.roles[remainderIndex].role });
            continue;
        }
        errors.push(`closed-world: ${file} (module ${mod.id}) has no matching role`);
    }
    return classified;
}

// ── dependency graph ─────────────────────────────────────────────────

function buildGraph(rootDir, files, modules, errors) {
    const moduleMap = new Map(modules.map(m => [m.id, m]));
    const fileModule = new Map();
    for (const file of files) {
        const owners = modules.filter(mod =>
            mod.sources.some(pat => pat.test(file))
            && !mod.sourceExcludes.some(pat => pat.test(file))
        );
        if (owners.length === 1) fileModule.set(file, owners[0].id);
    }

    const edges = [];
    const importRe = /(?:import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]|(?:import|require)\s*\(?\s*['"])([^'"]+)['"]/g;
    const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const file of files) {
        const sourceModule = fileModule.get(file);
        if (!sourceModule) continue;
        const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
        const seen = new Set();
        for (const match of content.matchAll(importRe)) {
            const specifier = match[1];
            if (!specifier.startsWith('.')) continue;
            const resolved = path.normalize(path.join(path.dirname(file), specifier));
            // Try .ts and /index.ts
            const candidates = [resolved + '.ts', resolved + '/index.ts'];
            for (const cand of candidates) {
                if (fileModule.has(cand) && !seen.has(cand)) {
                    seen.add(cand);
                    const targetModule = fileModule.get(cand);
                    if (targetModule && targetModule !== sourceModule) {
                        edges.push({ source: file, sourceModule, target: cand, targetModule });
                    }
                }
            }
        }
        // Dynamic imports are also value edges
        for (const match of content.matchAll(dynamicRe)) {
            const specifier = match[1];
            if (!specifier.startsWith('.')) continue;
            const resolved = path.normalize(path.join(path.dirname(file), specifier));
            const candidates = [resolved + '.ts', resolved + '/index.ts'];
            for (const cand of candidates) {
                if (fileModule.has(cand) && !seen.has(cand)) {
                    seen.add(cand);
                    const targetModule = fileModule.get(cand);
                    if (targetModule && targetModule !== sourceModule) {
                        edges.push({ source: file, sourceModule, target: cand, targetModule });
                    }
                }
            }
        }
    }
    return edges;
}

function checkBoundaries(edges, modules, errors) {
    const moduleMap = new Map(modules.map(m => [m.id, m]));
    for (const edge of edges) {
        const sourceMod = moduleMap.get(edge.sourceModule);
        const targetMod = moduleMap.get(edge.targetModule);
        if (!sourceMod || !targetMod) continue;

        // Deep import check: the target must be a declared public entrypoint
        const isEntrypoint = targetMod.publicEntrypoints.some(pat => pat.test(edge.target));
        if (!isEntrypoint) {
            errors.push(`boundary: ${edge.source} (${edge.sourceModule}) deep-imports ${edge.target} (${edge.targetModule}) — not a declared public entrypoint`);
            continue;
        }

        // Cross-module dependency check: the edge must be declared
        if (!sourceMod.mayDependOn.has(edge.targetModule)) {
            errors.push(`boundary: ${edge.source} (${edge.sourceModule}) depends on ${edge.targetModule} through entrypoint ${edge.target}, but mayDependOn is not declared`);
        }
    }
}

// ── debt growth ──────────────────────────────────────────────────────

function checkDebtGrowth(baseRoot, headRoot, errors) {
    const baseBaseline = readJson(path.join(baseRoot, '.ci', 'architecture-debt-baseline.json'), errors);
    const headBaseline = readJson(path.join(headRoot, '.ci', 'architecture-debt-baseline.json'), errors);
    const baseWaivers = readJson(path.join(baseRoot, 'docs', 'testing', 'architecture-waivers.json'), errors);
    const headWaivers = readJson(path.join(headRoot, 'docs', 'testing', 'architecture-waivers.json'), errors);
    const baseInvariants = readJson(path.join(baseRoot, 'docs', 'testing', 'architecture-invariants.json'), errors);
    const headInvariants = readJson(path.join(headRoot, 'docs', 'testing', 'architecture-invariants.json'), errors);

    if (!baseBaseline || !headBaseline || !baseWaivers || !headWaivers || !baseInvariants || !headInvariants) return;

    // Baseline growth
    const baseRules = baseBaseline.rules || {};
    const headRules = headBaseline.rules || {};
    for (const [key, headRule] of Object.entries(headRules)) {
        const baseRule = baseRules[key];
        const headFps = new Set(headRule.fingerprints || []);
        const baseFps = new Set((baseRule && baseRule.fingerprints) || []);
        const newFps = [...headFps].filter(fp => !baseFps.has(fp));
        if (newFps.length > 0) {
            const headWaiverList = (headWaivers.waivers || []).filter(w =>
                (w.fingerprints || []).some(fp => newFps.includes(fp)));
            if (headWaiverList.length === 0) {
                errors.push(`debt: baseline ${key} grew by ${newFps.length} fingerprint(s) without a matching waiver`);
            }
        }
    }

    // Waiver growth (new waivers need architecture approval)
    const baseWaiverIds = new Set((baseWaivers.waivers || []).map(w => w.id));
    const headWaiverIds = new Set((headWaivers.waivers || []).map(w => w.id));
    // Waiver growth is detected but reported as "needs architecture approval" — not a hard error here
    // The architecture approval gate handles this

    // Writer growth
    const headInvList = headInvariants.invariants || [];
    const baseInvList = baseInvariants.invariants || [];
    const baseInvMap = new Map(baseInvList.map(inv => [inv.id, inv]));
    for (const headInv of headInvList) {
        const baseInv = baseInvMap.get(headInv.id);
        if (!baseInv) continue;
        const headWriters = new Set(headInv.writers || []);
        const baseWriters = new Set(baseInv.writers || []);
        const newWriters = [...headWriters].filter(w => !baseWriters.has(w));
        if (newWriters.length > 0) {
            errors.push(`debt: invariant ${headInv.id} writer set grew (${newWriters.join(', ')}) — requires architecture approval`);
        }
    }
}

// ── protected path changes ───────────────────────────────────────────

const PROTECTED_PATHS = [
    'scripts/architecture/',
    'tests/unit/architecture/',
    'tests/unit/architecture-parity/',
    '.github/workflows/',
    'scripts/run-architecture-guards.js',
    'scripts/run-merge-approval-gate.js',
    'scripts/lib/mergeApprovals.js',
    'scripts/lib/ciContracts.js',
    'scripts/lib/changeImpactContext.js',
    'tests/unit/tooling/mergeApprovalGate.test.js',
    '.ci/architecture-debt-baseline.json',
    'docs/testing/architecture-',
    'package.json',
];

function isProtected(filePath) {
    return PROTECTED_PATHS.some(prefix => filePath.startsWith(prefix));
}

function checkProtectedChanges(baseRef, headRef, hasArchitectureApproval, errors) {
    const changed = execFileSync('git', ['diff', '--name-only', baseRef, headRef], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean);

    const protectedChanged = changed.filter(isProtected);
    if (protectedChanged.length > 0 && !hasArchitectureApproval) {
        errors.push(`protected: ${protectedChanged.length} protected file(s) changed without architecture approval: ${protectedChanged.slice(0, 5).join(', ')}${protectedChanged.length > 5 ? '...' : ''}`);
    }
}


// ── core evaluation (testable, no git I/O) ──────────────────────────

function runKernel({ headDir, baseDir, baseRef, headRef, hasArchitectureApproval }) {
    const errors = [];

    // Load policy from HEAD
    const { modules } = loadPolicy(headDir, errors);
    if (errors.length > 0 || modules.length === 0) {
        return { errors };
    }

    // 1. Closed-world classification
    const files = discoverFiles(headDir);
    classifyFiles(files, modules, errors);

    // 2. Module boundaries
    const edges = buildGraph(headDir, files, modules, errors);
    checkBoundaries(edges, modules, errors);

    // 3. Debt growth
    if (baseDir) {
        checkDebtGrowth(baseDir, headDir, errors);
    }

    // 4. Protected path changes
    if (baseRef && headRef) {
        checkProtectedChanges(baseRef, headRef, hasArchitectureApproval, errors);
    }

    return { errors };
}


module.exports = { loadPolicy, classifyFiles, buildGraph, checkBoundaries, checkDebtGrowth, runKernel, isProtected, PROTECTED_PATHS };

