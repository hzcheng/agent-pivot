'use strict';

/**
 * Change Impact Declaration (review R4; charter 8.10).
 *
 * Every pull request body must carry exactly one fenced
 * ```change-impact-declaration JSON block, generated for the current head by
 * scripts/generate-change-impact-declaration.js. The merge-approval gate
 * regenerates the architecture impact report for the PR and compares it with
 * the declaration: a stale head SHA, under-reported modules/new files, a
 * wrong policy-delta classification, or wrong capability/invariant sets fail
 * the gate. Editing the PR body does not retrigger push workflows, so the
 * declaration binds the head SHA — a body edit can never make an old
 * declaration look fresh for a new head.
 */

const DECLARATION_BLOCK_PATTERN = /```change-impact-declaration\s*\r?\n([\s\S]*?)```/;

const POLICY_DELTA_VALUES = ['product-only', 'tightening', 'relaxing', 're-partition'];
const BASELINE_WAIVER_VALUES = ['zero', 'changed'];

const DECLARATION_KEYS = [
    'headSha',
    'capabilities',
    'modules',
    'invariants',
    'policyDelta',
    'baselineWaiverDelta',
    'newFiles',
    'behaviors',
    'semanticImpact',
    'coordinators',
    'verification',
];

const SEMANTIC_IMPACT_KEYS = [
    'stateAuthority',
    'writerSet',
    'protocol',
    'persistence',
    'identity',
    'recovery',
];

function isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * parseChangeImpactDeclaration(body) -> { declaration | null, errors }.
 * Fail-closed: no block, multiple blocks, invalid JSON, or any schema
 * violation makes the declaration unusable.
 */
function parseChangeImpactDeclaration(body) {
    const text = String(body || '');
    const blocks = [...text.matchAll(new RegExp(DECLARATION_BLOCK_PATTERN.source, 'g'))];
    if (blocks.length === 0) {
        return { declaration: null, errors: ['PR body has no ```change-impact-declaration block'
            + ' — generate one with scripts/generate-change-impact-declaration.js'] };
    }
    if (blocks.length > 1) {
        return { declaration: null, errors: ['PR body has multiple change-impact-declaration blocks'] };
    }
    let parsed;
    try {
        parsed = JSON.parse(blocks[0][1]);
    } catch (error) {
        return { declaration: null, errors: [`change-impact-declaration is not valid JSON (${error.message})`] };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { declaration: null, errors: ['change-impact-declaration must be a JSON object'] };
    }
    const errors = [];
    for (const key of Object.keys(parsed)) {
        if (!DECLARATION_KEYS.includes(key)) {
            errors.push(`unknown declaration key ${JSON.stringify(key)} (allowed: ${DECLARATION_KEYS.join(', ')})`);
        }
    }
    if (typeof parsed.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(parsed.headSha)) {
        errors.push('headSha must be a 40-character lowercase hex commit sha');
    }
    for (const key of ['capabilities', 'modules', 'invariants']) {
        if (!isStringArray(parsed[key])) {
            errors.push(`${key} must be an array of strings`);
        }
    }
    if (!POLICY_DELTA_VALUES.includes(parsed.policyDelta)) {
        errors.push(`policyDelta must be one of ${POLICY_DELTA_VALUES.join(', ')}`);
    }
    if (!BASELINE_WAIVER_VALUES.includes(parsed.baselineWaiverDelta)) {
        errors.push(`baselineWaiverDelta must be one of ${BASELINE_WAIVER_VALUES.join(', ')}`);
    }
    if (!Array.isArray(parsed.newFiles)) {
        errors.push('newFiles must be an array');
    } else {
        for (const entry of parsed.newFiles) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                errors.push('every newFiles entry must be an object { path, module, reason }');
                break;
            }
            if (typeof entry.path !== 'string' || entry.path.length === 0
                || typeof entry.module !== 'string' || entry.module.length === 0) {
                errors.push('every newFiles entry needs non-empty path and module strings');
                break;
            }
            if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
                errors.push(`newFiles entry ${entry.path} needs a non-empty reason`
                    + ' (why this file belongs to the declared module)');
                break;
            }
        }
    }
    // Round-2 review Important 2: the charter 8.10 fields are all required.
    if (!isStringArray(parsed.behaviors)) {
        errors.push('behaviors must be an array of behavior ids');
    }
    const impact = parsed.semanticImpact;
    if (impact === null || typeof impact !== 'object' || Array.isArray(impact)) {
        errors.push('semanticImpact must be an object');
    } else {
        for (const key of Object.keys(impact)) {
            if (!SEMANTIC_IMPACT_KEYS.includes(key)) {
                errors.push(`unknown semanticImpact key ${JSON.stringify(key)}`
                    + ` (allowed: ${SEMANTIC_IMPACT_KEYS.join(', ')})`);
            }
        }
        for (const key of SEMANTIC_IMPACT_KEYS) {
            if (typeof impact[key] !== 'boolean') {
                errors.push(`semanticImpact.${key} must be a boolean`);
            }
        }
    }
    if (!isStringArray(parsed.coordinators)) {
        errors.push('coordinators must be an array (empty when the change is single-module)');
    }
    if (typeof parsed.verification !== 'string' || parsed.verification.trim().length === 0) {
        errors.push('verification must be a non-empty string (focused and environment checks)');
    }
    if (errors.length > 0) {
        return { declaration: null, errors };
    }
    return {
        declaration: {
            headSha: parsed.headSha,
            capabilities: [...parsed.capabilities].sort(),
            modules: [...parsed.modules].sort(),
            invariants: [...parsed.invariants].sort(),
            policyDelta: parsed.policyDelta,
            baselineWaiverDelta: parsed.baselineWaiverDelta,
            newFiles: parsed.newFiles
                .map(entry => ({ path: entry.path, module: entry.module, reason: entry.reason.trim() }))
                .sort((a, b) => a.path.localeCompare(b.path)),
            behaviors: [...parsed.behaviors].sort(),
            semanticImpact: Object.fromEntries(
                SEMANTIC_IMPACT_KEYS.map(key => [key, parsed.semanticImpact[key]])),
            coordinators: [...parsed.coordinators].sort(),
            verification: parsed.verification.trim(),
        },
        errors: [],
    };
}

function setDiff(actual, declared) {
    const actualSet = new Set(actual);
    const declaredSet = new Set(declared);
    return {
        missing: [...actualSet].filter(value => !declaredSet.has(value)).sort(),
        extra: [...declaredSet].filter(value => !actualSet.has(value)).sort(),
    };
}

function pushSetMismatch(errors, label, actual, declared) {
    const { missing, extra } = setDiff(actual, declared);
    if (missing.length > 0) {
        errors.push(`declaration under-reports ${label}: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
        errors.push(`declaration over-reports ${label}: ${extra.join(', ')}`);
    }
}

/**
 * Compare the declaration with the regenerated truth.
 * evaluateChangeImpactDeclaration({
 *   body, headSha, classification, report, assignedCapabilities,
 *   expectedBehaviors,
 * }) -> { declaration | null, errors }.
 */
function evaluateChangeImpactDeclaration({
    body, headSha, classification, report, assignedCapabilities, expectedBehaviors,
}) {
    const { declaration, errors } = parseChangeImpactDeclaration(body);
    if (!declaration) {
        return { declaration: null, errors };
    }
    const evaluationErrors = [];
    if (declaration.headSha !== headSha) {
        evaluationErrors.push(`declaration is stale: it binds head ${declaration.headSha}`
            + ` but the current PR head is ${headSha} — regenerate the declaration for the`
            + ' current head');
    }
    pushSetMismatch(evaluationErrors, 'touched modules',
        Object.keys(report.touchedModules || {}), declaration.modules);
    pushSetMismatch(evaluationErrors, 'changed invariants',
        report.changedInvariantIds || [], declaration.invariants);
    pushSetMismatch(evaluationErrors, 'capabilities',
        assignedCapabilities || [], declaration.capabilities);
    pushSetMismatch(evaluationErrors, 'behaviors',
        expectedBehaviors || [], declaration.behaviors);
    // Mechanically checkable semantic-impact dimensions (round-2 review
    // Important 2): authority/writer/persistence truth is derivable from the
    // invariant delta; protocol/identity/recovery remain owner-reviewed prose.
    const policyDelta = (report && report.policyDelta) || {};
    const invariantChanges = Object.values(policyDelta.invariantChanges || {});
    const expectedImpact = {
        stateAuthority: invariantChanges.some(change => change.authorityChanged
            || change.participatingModulesChanged),
        writerSet: invariantChanges.some(change => (change.writersAdded || []).length > 0
            || (change.writersRemoved || []).length > 0)
            || (policyDelta.invariantsRemoved || []).length > 0,
        persistence: invariantChanges.some(change => change.stateFamilyChanged),
    };
    for (const [key, expected] of Object.entries(expectedImpact)) {
        if (declaration.semanticImpact[key] !== expected) {
            evaluationErrors.push(`semanticImpact.${key} declares ${declaration.semanticImpact[key]}`
                + ` but the diff shows ${expected}`);
        }
    }
    if (declaration.modules.length > 1 && declaration.coordinators.length === 0) {
        evaluationErrors.push('a multi-module change must name the coordinator or public API '
            + 'that owns each cross-module interaction (coordinators)');
    }
    pushSetMismatch(evaluationErrors, 'new classified files (path)',
        (report.newClassifiedFiles || []).map(entry => entry.path),
        declaration.newFiles.map(entry => entry.path));
    const declaredModulesByPath = new Map(declaration.newFiles.map(entry => [entry.path, entry.module]));
    for (const entry of report.newClassifiedFiles || []) {
        const declaredModule = declaredModulesByPath.get(entry.path);
        if (declaredModule && declaredModule !== entry.module) {
            evaluationErrors.push(`new file ${entry.path} declares module ${declaredModule}`
                + ` but the registry classifies it as ${entry.module}`);
        }
    }
    if (declaration.policyDelta !== classification) {
        evaluationErrors.push(`declaration claims policyDelta ${declaration.policyDelta}`
            + ` but the gate computes ${classification}`);
    }
    const baselineWaiverTouched = (report.protectedTouched || [])
        .some(file => file.endsWith('architecture-debt-baseline.json')
            || file.endsWith('architecture-waivers.json'));
    const expectedBaselineWaiver = baselineWaiverTouched ? 'changed' : 'zero';
    if (declaration.baselineWaiverDelta !== expectedBaselineWaiver) {
        evaluationErrors.push(`declaration claims baselineWaiverDelta ${declaration.baselineWaiverDelta}`
            + ` but the diff shows ${expectedBaselineWaiver}`);
    }
    return { declaration, errors: evaluationErrors };
}

module.exports = {
    DECLARATION_BLOCK_PATTERN,
    evaluateChangeImpactDeclaration,
    parseChangeImpactDeclaration,
};
