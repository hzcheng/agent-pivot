'use strict';

/**
 * Architecture policy loader (Harness v0, program Stage 2).
 *
 * Loads docs/testing/architecture-modules.json and validates it against the
 * closed-world schema: every production source file under the declared roots
 * is owned by exactly one module and assigned exactly one role. Structured
 * references (mayDependOn module ids, productCapabilities ids) must resolve.
 *
 * Library only — the CLI lives in checkClosedWorld.js and the owner tests in
 * tests/architecture/. Fail closed: unknown file kinds, stale patterns, and
 * unresolvable references are all errors, never warnings.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join('docs', 'testing', 'architecture-modules.json');
const CAPABILITIES_PATH = path.join('docs', 'testing', 'main-capability-coverage.json');

const MODULE_ID_PATTERN = /^MOD-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const ROLES = ['presentation', 'application', 'domain', 'infrastructure', 'composition'];
const SOURCE_FILE_KIND = /\.(?:ts|js)$/;

/**
 * Compile a repository-relative glob into a RegExp. Supported syntax:
 *   `**`   any number of path segments (including zero when written `**\/`)
 *   `*`    any characters within one segment
 * Everything else matches literally. No brace expansion, no character classes.
 */
function compileGlob(pattern) {
    let source = '';
    let index = 0;
    while (index < pattern.length) {
        const character = pattern[index];
        if (character === '*') {
            if (pattern[index + 1] === '*') {
                if (pattern[index + 2] === '/') {
                    source += '(?:[^/]+/)*';
                    index += 3;
                } else {
                    source += '.*';
                    index += 2;
                }
            } else {
                source += '[^/]*';
                index += 1;
            }
        } else {
            source += /[.*+?^${}()|[\]\\]/.test(character) ? '\\' + character : character;
            index += 1;
        }
    }
    return new RegExp('^' + source + '$');
}

/** Recursively enumerate files under a directory, repository-relative. */
function enumerateFiles(rootDirectory, absoluteDirectory, sink) {
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
        const relativePath = path.posix.join(rootDirectory, entry.name);
        if (entry.isDirectory()) {
            enumerateFiles(relativePath, absoluteDirectory + path.sep + entry.name, sink);
        } else if (entry.isFile()) {
            sink.push(relativePath);
        }
    }
}

function readJson(rootDirectory, relativePath, errors) {
    const absolutePath = path.join(rootDirectory, relativePath);
    try {
        return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch (error) {
        errors.push(`policy: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

function validatePatternList(owner, field, value, errors) {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
        errors.push(`${owner}: ${field} must be an array of non-empty glob strings`);
        return false;
    }
    return true;
}

/**
 * Load and validate the module registry. Returns
 * { registry, modules, files, classification, errors } where classification
 * maps repository-relative file path -> { moduleId, role }.
 */
function loadArchitecturePolicy(rootDirectory) {
    const errors = [];
    const registry = readJson(rootDirectory, REGISTRY_PATH, errors);
    const capabilityManifest = readJson(rootDirectory, CAPABILITIES_PATH, errors);
    if (!registry || !capabilityManifest) {
        return { registry: null, modules: [], files: [], classification: new Map(), errors };
    }

    // ── Registry shape ────────────────────────────────────────────────
    if (registry.version !== 1) {
        errors.push('registry: version must be 1');
    }
    const roots = registry.scope && registry.scope.roots;
    if (!Array.isArray(roots) || roots.length === 0
        || roots.some(entry => typeof entry !== 'string' || entry.length === 0)) {
        errors.push('registry: scope.roots must be a non-empty array of directory paths');
    }
    const modules = Array.isArray(registry.modules) ? registry.modules : [];
    if (modules.length === 0) {
        errors.push('registry: modules must be a non-empty array');
    }

    const capabilityIds = new Set(
        (capabilityManifest.capabilities || []).map(capability => capability.id));
    const moduleIds = new Set();

    for (const module of modules) {
        const owner = `module ${module && module.id ? module.id : '<missing id>'}`;
        if (!module.id || !MODULE_ID_PATTERN.test(module.id)) {
            errors.push(`${owner}: id must match ${MODULE_ID_PATTERN}`);
        }
        if (moduleIds.has(module.id)) {
            errors.push(`${owner}: duplicate module id`);
        }
        moduleIds.add(module.id);
        if (typeof module.title !== 'string' || !module.title
            || typeof module.purpose !== 'string' || !module.purpose) {
            errors.push(`${owner}: title and purpose are required strings`);
        }
        const source = module.source || {};
        if (!validatePatternList(owner, 'source.include', source.include, errors)) {
            continue;
        }
        if (source.exclude !== undefined
            && !validatePatternList(owner, 'source.exclude', source.exclude, errors)) {
            continue;
        }
        if (module.publicEntrypoints !== undefined
            && !validatePatternList(owner, 'publicEntrypoints', module.publicEntrypoints, errors)) {
            continue;
        }
        const roles = Array.isArray(module.roles) ? module.roles : [];
        if (roles.length === 0) {
            errors.push(`${owner}: roles must be a non-empty array`);
        }
        const seenRoles = new Set();
        for (const roleEntry of roles) {
            if (!ROLES.includes(roleEntry.role)) {
                errors.push(`${owner}: role must be one of ${ROLES.join(', ')}`);
            }
            if (seenRoles.has(roleEntry.role)) {
                errors.push(`${owner}: duplicate role ${roleEntry.role}`);
            }
            seenRoles.add(roleEntry.role);
            validatePatternList(owner, `roles[${roleEntry.role}].include`, roleEntry.include, errors);
        }
        const mayDependOn = Array.isArray(module.mayDependOn) ? module.mayDependOn : [];
        for (const dependency of mayDependOn) {
            if (dependency === module.id) {
                errors.push(`${owner}: mayDependOn must not reference itself`);
            }
        }
        const capabilities = Array.isArray(module.productCapabilities)
            ? module.productCapabilities : [];
        if (capabilities.length === 0) {
            errors.push(`${owner}: productCapabilities must not be empty`);
        }
        for (const capability of capabilities) {
            if (!capabilityIds.has(capability)) {
                errors.push(`${owner}: unknown product capability ${capability}`);
            }
        }
        module._compiled = {
            include: source.include.map(compileGlob),
            exclude: (source.exclude || []).map(compileGlob),
            entrypoints: (module.publicEntrypoints || []).map(compileGlob),
            roles: roles.map(roleEntry => ({
                role: roleEntry.role,
                include: roleEntry.include.map(compileGlob),
            })),
        };
    }
    for (const module of modules) {
        for (const dependency of module.mayDependOn || []) {
            if (!moduleIds.has(dependency)) {
                errors.push(`module ${module.id}: mayDependOn references unknown module ${dependency}`);
            }
        }
    }

    // ── File enumeration and classification ───────────────────────────
    const files = [];
    if (Array.isArray(roots)) {
        for (const root of roots) {
            const absoluteRoot = path.join(rootDirectory, root);
            if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
                errors.push(`registry: scope root ${root} is not a directory`);
                continue;
            }
            enumerateFiles(root, absoluteRoot, files);
        }
    }
    files.sort();

    const classification = new Map();
    for (const file of files) {
        if (!SOURCE_FILE_KIND.test(file)) {
            errors.push(`closed-world: ${file} has an unknown file kind; `
                + 'extend the policy deliberately or move it out of the production roots');
            continue;
        }
        const owners = modules.filter(module =>
            module._compiled.include.some(pattern => pattern.test(file))
            && !module._compiled.exclude.some(pattern => pattern.test(file)));
        if (owners.length === 0) {
            errors.push(`closed-world: ${file} is not classified by any module`);
            continue;
        }
        if (owners.length > 1) {
            errors.push(`closed-world: ${file} is classified by multiple modules: `
                + owners.map(module => module.id).join(', '));
            continue;
        }
        const module = owners[0];
        const roleEntry = module._compiled.roles.find(candidate =>
            candidate.include.some(pattern => pattern.test(file)));
        if (!roleEntry) {
            errors.push(`closed-world: ${file} has no role in module ${module.id}`);
            continue;
        }
        classification.set(file, { moduleId: module.id, role: roleEntry.role });
    }

    // ── Stale pattern detection: every declared pattern must match ────
    const classifiedFiles = [...classification.keys()];
    for (const module of modules) {
        const moduleFiles = classifiedFiles.filter(file =>
            classification.get(file).moduleId === module.id);
        for (const pattern of module.source.include) {
            const compiled = compileGlob(pattern);
            if (!files.some(file => compiled.test(file))) {
                errors.push(`module ${module.id}: stale source.include pattern ${pattern}`);
            }
        }
        for (const pattern of module.source.exclude || []) {
            const compiled = compileGlob(pattern);
            if (!files.some(file => compiled.test(file))) {
                errors.push(`module ${module.id}: stale source.exclude pattern ${pattern}`);
            }
        }
        for (const roleEntry of module.roles) {
            for (const pattern of roleEntry.include) {
                const compiled = compileGlob(pattern);
                if (!moduleFiles.some(file => compiled.test(file))) {
                    errors.push(`module ${module.id}: stale roles[${roleEntry.role}] pattern ${pattern}`);
                }
            }
        }
        for (const pattern of module.publicEntrypoints || []) {
            const compiled = compileGlob(pattern);
            if (!moduleFiles.some(file => compiled.test(file))) {
                errors.push(`module ${module.id}: public entrypoint ${pattern} matches no owned file`);
            }
        }
    }

    return { registry, modules, files, classification, errors };
}

module.exports = {
    REGISTRY_PATH,
    ROLES,
    compileGlob,
    loadArchitecturePolicy,
};
