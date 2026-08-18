'use strict';

// ARCH-PR-CHANGE-IMPACT-GATE-001: the Change Impact Declaration parser and
// evaluator (review R4). The merge-approval gate must reject missing, stale,
// under-reported, over-reported, or malformed declarations.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    evaluateChangeImpactDeclaration,
    parseChangeImpactDeclaration,
} = require('../../../scripts/lib/changeImpactDeclaration');
const {
    capabilityAssignments,
    collectChangeImpactContext,
} = require('../../../scripts/lib/changeImpactContext');
const { buildDeclaration } = require('../../../scripts/generate-change-impact-declaration');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const HEAD_SHA = 'a'.repeat(40);

function bodyWith(declaration) {
    return `## Summary\n\nfixture\n\n## Change impact declaration\n\n`
        + '```change-impact-declaration\n'
        + `${JSON.stringify(declaration, null, 2)}\n`
        + '```\n\n## Skill harvest\n\nnone\n';
}

function validDeclaration(overrides = {}) {
    return {
        headSha: HEAD_SHA,
        capabilities: ['MAIN-ARCHITECTURE-HARNESS'],
        modules: ['MOD-A'],
        invariants: ['ARCH-X-001'],
        policyDelta: 'tightening',
        baselineWaiverDelta: 'zero',
        newFiles: [{ path: 'src/a/new.ts', module: 'MOD-A', reason: 'owns the new codec' }],
        ...overrides,
    };
}

function truth(overrides = {}) {
    return {
        body: bodyWith(validDeclaration()),
        headSha: HEAD_SHA,
        classification: 'tightening',
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: [],
        },
        assignedCapabilities: ['MAIN-ARCHITECTURE-HARNESS'],
        ...overrides,
    };
}

// ── parser ────────────────────────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 parser accepts a valid declaration and normalizes it', () => {
    const { declaration, errors } = parseChangeImpactDeclaration(bodyWith(validDeclaration({
        modules: ['MOD-B', 'MOD-A'],
        newFiles: [
            { path: 'src/b.ts', module: 'MOD-B', reason: '  second  ' },
            { path: 'src/a.ts', module: 'MOD-A', reason: 'first' },
        ],
    })));
    assert.deepEqual(errors, []);
    assert.deepEqual(declaration.modules, ['MOD-A', 'MOD-B']);
    assert.deepEqual(declaration.newFiles.map(entry => entry.path), ['src/a.ts', 'src/b.ts']);
    assert.equal(declaration.newFiles[1].reason, 'second');
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: missing or duplicated block is rejected', () => {
    assert.ok(parseChangeImpactDeclaration('no block here').errors[0].includes('no ```change-impact-declaration'));
    const two = `${bodyWith(validDeclaration())}\n${bodyWith(validDeclaration())}`;
    assert.ok(parseChangeImpactDeclaration(two).errors[0].includes('multiple'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: malformed JSON and non-object roots are rejected', () => {
    assert.ok(parseChangeImpactDeclaration('```change-impact-declaration\n{oops\n```').errors[0]
        .includes('not valid JSON'));
    assert.ok(parseChangeImpactDeclaration('```change-impact-declaration\n[]\n```').errors[0]
        .includes('must be a JSON object'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: schema violations are rejected', () => {
    const cases = {
        'unknown key': validDeclaration({ surprise: true }),
        'bad headSha': validDeclaration({ headSha: 'HEAD' }),
        'capabilities not an array': validDeclaration({ capabilities: 'MAIN-X' }),
        'modules not an array': validDeclaration({ modules: 'MOD-A' }),
        'invariants not an array': validDeclaration({ invariants: 'ARCH-X-001' }),
        'bad policyDelta': validDeclaration({ policyDelta: 'none' }),
        'bad baselineWaiverDelta': validDeclaration({ baselineWaiverDelta: 'none' }),
        'newFiles not an array': validDeclaration({ newFiles: {} }),
        'newFiles entry not an object': validDeclaration({ newFiles: ['src/a.ts'] }),
        'newFiles entry missing module': validDeclaration({ newFiles: [{ path: 'src/a.ts', reason: 'r' }] }),
        'newFiles entry empty reason': validDeclaration({ newFiles: [{ path: 'src/a.ts', module: 'MOD-A', reason: '  ' }] }),
    };
    for (const [name, declaration] of Object.entries(cases)) {
        const { declaration: parsed, errors } = parseChangeImpactDeclaration(bodyWith(declaration));
        assert.equal(parsed, null, name);
        assert.ok(errors.length > 0, name);
    }
});

// ── evaluator ─────────────────────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 a declaration matching the regenerated truth passes', () => {
    const { errors } = evaluateChangeImpactDeclaration(truth());
    assert.deepEqual(errors, []);
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: a stale headSha is rejected', () => {
    const { errors } = evaluateChangeImpactDeclaration(truth({ headSha: 'b'.repeat(40) }));
    assert.ok(errors.some(error => error.includes('stale') && error.includes('b'.repeat(40))),
        JSON.stringify(errors));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: under- and over-reported fields are rejected', () => {
    const under = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ modules: [], invariants: [], capabilities: [] })),
    }));
    assert.ok(under.errors.some(error => error.includes('under-reports touched modules: MOD-A')));
    assert.ok(under.errors.some(error => error.includes('under-reports changed invariants: ARCH-X-001')));
    assert.ok(under.errors.some(error => error.includes('under-reports capabilities: MAIN-ARCHITECTURE-HARNESS')));

    const over = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ modules: ['MOD-A', 'MOD-B'], capabilities: ['MAIN-ARCHITECTURE-HARNESS', 'MAIN-TODO'] })),
    }));
    assert.ok(over.errors.some(error => error.includes('over-reports touched modules: MOD-B')));
    assert.ok(over.errors.some(error => error.includes('over-reports capabilities: MAIN-TODO')));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: new-file coverage is exact', () => {
    const missing = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ newFiles: [] })),
    }));
    assert.ok(missing.errors.some(error => error.includes('under-reports new classified files')));
    const extra = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({
            newFiles: [
                { path: 'src/a/new.ts', module: 'MOD-A', reason: 'owns the new codec' },
                { path: 'src/a/other.ts', module: 'MOD-A', reason: 'phantom' },
            ],
        })),
    }));
    assert.ok(extra.errors.some(error => error.includes('over-reports new classified files')));
    const wrongModule = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({
            newFiles: [{ path: 'src/a/new.ts', module: 'MOD-B', reason: 'misplaced' }],
        })),
    }));
    assert.ok(wrongModule.errors.some(error => error.includes('classifies it as MOD-A')));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: policy delta and baseline/waiver misreports are rejected', () => {
    const wrongDelta = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ policyDelta: 'product-only' })),
    }));
    assert.ok(wrongDelta.errors.some(error => error.includes('claims policyDelta product-only')
        && error.includes('computes tightening')));
    const wrongBaseline = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ baselineWaiverDelta: 'changed' })),
    }));
    assert.ok(wrongBaseline.errors.some(error => error.includes('baselineWaiverDelta changed')
        && error.includes('zero')));
    const baselineTouched = evaluateChangeImpactDeclaration(truth({
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: ['.ci/architecture-debt-baseline.json'],
        },
    }));
    assert.ok(baselineTouched.errors.some(error => error.includes('baselineWaiverDelta zero')
        && error.includes('changed')));
});

// ── capability assignment glue ────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 capabilityAssignments maps commits and flags unaudited ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-audit-'));
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'), JSON.stringify({
        version: 1,
        audit: { base: 'x', head: 'y', ignoredDocumentationCommits: ['d'.repeat(40)] },
        capabilities: [{ id: 'MAIN-TEST-001', commits: ['a'.repeat(40)] }],
    }));
    const { assignedCapabilities, errors } = capabilityAssignments(root, [
        'a'.repeat(40), 'd'.repeat(40), 'e'.repeat(40),
    ]);
    assert.deepEqual(assignedCapabilities, ['MAIN-TEST-001']);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('e'.repeat(40)));

    const missing = capabilityAssignments(root, ['f'.repeat(40)]);
    assert.equal(missing.assignedCapabilities.length, 0);

    const noAudit = capabilityAssignments(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-empty-')), ['a'.repeat(40)]);
    assert.ok(noAudit.errors[0].includes('missing'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 a HEAD self-diff yields an empty, valid context and declaration', () => {
    const context = collectChangeImpactContext({ rootDirectory: repoRoot, baseRef: 'HEAD' });
    assert.equal(context.classification, 'product-only');
    assert.deepEqual(context.assignedCapabilities, []);
    assert.deepEqual(context.errors, []);
    const { block, declaration } = buildDeclaration({ rootDirectory: repoRoot, baseRef: 'HEAD' });
    assert.deepEqual(declaration.modules, []);
    assert.deepEqual(declaration.newFiles, []);
    assert.equal(declaration.policyDelta, 'product-only');
    assert.equal(declaration.baselineWaiverDelta, 'zero');
    const { declaration: parsed, errors } = parseChangeImpactDeclaration(block);
    assert.deepEqual(errors, []);
    assert.deepEqual(evaluateChangeImpactDeclaration({
        body: block,
        headSha: context.headSha,
        classification: context.classification,
        report: context.report,
        assignedCapabilities: context.assignedCapabilities,
    }).errors, []);
    assert.ok(parsed);
});
