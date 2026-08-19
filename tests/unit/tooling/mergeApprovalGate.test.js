'use strict';

// Meta-harness for the merge approval gate itself: the workflow wiring that
// makes merges mechanically block on owner approval must not silently regress.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const repositoryRoot = path.resolve(__dirname, '../../..');

function loadWorkflow(name) {
    return yaml.load(
        fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', name), 'utf8'),
        { schema: yaml.JSON_SCHEMA },
    );
}

test('ARCH-PR-MERGE-APPROVAL-GATE-001 wires the gate workflow to PRs and comments', () => {
    const workflow = loadWorkflow('merge-approval-gate.yml');
    const triggers = workflow.on;
    // Round-2 review Blocker 1: the gate must run from the default branch
    // (pull_request_target), never from the PR's own workflow definition.
    assert.ok(triggers.pull_request_target, 'the gate must evaluate on pull_request_target events');
    assert.ok(!triggers.pull_request, 'pull_request would execute the PR\'s own workflow file');
    assert.ok(triggers.pull_request_target.types.includes('synchronize'),
        'new pushes must re-evaluate (stale approvals)');
    assert.ok(triggers.issue_comment, 'the gate must re-evaluate when approval comments arrive');

    assert.strictEqual(workflow.permissions.statuses, 'write', 'the job posts a commit status');
    const gate = workflow.jobs.gate;
    assert.ok(gate, 'gate job exists');
    assert.ok(gate['timeout-minutes'] >= 10, 'full-history checkout and regeneration need budget');
    const checkout = gate.steps.find(step => step.uses && step.uses.startsWith('actions/checkout'));
    assert.ok(checkout && checkout.with && checkout.with['fetch-depth'] === 0,
        'the gate regenerates the impact report and needs full history');
    const runSteps = gate.steps.map(step => step.run || '').join('\n');
    assert.match(runSteps, /run-merge-approval-gate\.js/, 'the job runs the gate script');

    const script = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'run-merge-approval-gate.js'), 'utf8');
    assert.match(script, /STATUS_CONTEXT = 'merge-approval'/,
        'the posted status context is the required-check name');
    assert.match(script, /worktree', 'add', '--detach/,
        'the head is materialized as a detached read-only worktree, never checked out over the workspace');
    assert.ok(!/checkout', headSha/.test(script),
        'the gate must not check out the PR head over the evaluator workspace');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 guard mutation parity is wired into the Linux lane (round-2 Blocker 1)', () => {
    // The independent kill for 'guard turned constant-true with gutted
    // tests': the base test suites re-run against the head guard code.
    const pkg = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['test:ci:linux'], /run-guard-mutation-parity\.js/,
        'the Linux quality lane must run the guard mutation parity check');
    const script = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'run-guard-mutation-parity.js'), 'utf8');
    assert.match(script, /architecture-parity/, 'the parity suite materializes base tests');
    assert.match(script, /classification === 'relaxing' \|\| classification === 're-partition'/,
        'record-authorized changes are exempt (they carry owner review)');
    assert.match(script, /guardSemantics/,
        'a base-landed guardSemantics record exempts intentional guard contract changes');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 audits recent merges on main pushes', () => {
    const verify = loadWorkflow('verify.yml');
    const audit = verify.jobs['merge-approval-audit'];
    assert.ok(audit, 'verify.yml must carry the merge-approval-audit job');
    assert.strictEqual(audit.if, "github.event_name == 'push'",
        'the audit only runs on default-branch pushes, never on PRs');
    assert.match(
        audit.steps.map(step => step.run || '').join('\n'),
        /run-merge-approval-audit\.js/,
    );

    // The scheduled workflow must stay secret-free (packaging gate), so the
    // audit lives only on the push path; every merge is a push, so nothing
    // slips through.
    const scheduled = loadWorkflow('scheduled-verification.yml');
    assert.ok(!scheduled.jobs['merge-approval-audit'],
        'the secret-free scheduled workflow must not carry the token-using audit');
});


test('ARCH-PR-CHANGE-IMPACT-GATE-001 wires the declaration check into the gate (review R4)', () => {
    const workflow = loadWorkflow('merge-approval-gate.yml');
    assert.ok(workflow.on.pull_request_target.types.includes('edited'),
        'body edits re-evaluate the head-bound declaration');
    const gate = workflow.jobs.gate;
    assert.ok(gate['timeout-minutes'] >= 10, 'full-history checkout and regeneration need budget');
    const checkout = gate.steps.find(step => step.uses && step.uses.startsWith('actions/checkout'));
    assert.ok(checkout && checkout.with && checkout.with['fetch-depth'] === 0,
        'the gate regenerates the impact report and needs full history');

    const script = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'run-merge-approval-gate.js'), 'utf8');
    assert.match(script, /evaluateChangeImpactDeclaration/,
        'the gate compares the PR body declaration with the regenerated truth');
    assert.match(script, /collectChangeImpactContext/,
        'the gate regenerates the impact report for the PR head');
    assert.match(script, /pull\/\$\{prNumber\}\/head/,
        'the gate fetches and checks out the exact PR head');

    // The declaration machinery sits on the protected harness surface (R2
    // surface extended in R4): weakening it is never product-only.
    const surface = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'architecture', 'reportArchitectureDiff.js'), 'utf8');
    for (const protectedFile of [
        'scripts/run-merge-approval-gate.js',
        'scripts/lib/mergeApprovals.js',
        'scripts/lib/changeImpactDeclaration.js',
        'scripts/lib/changeImpactContext.js',
        'scripts/generate-change-impact-declaration.js',
        'tests/unit/tooling/changeImpactDeclaration.test.js',
    ]) {
        assert.ok(surface.includes(`'${protectedFile}'`), `${protectedFile} must be protected`);
    }
});
