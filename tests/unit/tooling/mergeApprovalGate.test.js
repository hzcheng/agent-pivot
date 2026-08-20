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

test('ARCH-PR-MERGE-APPROVAL-GATE-001 guard mutation parity replaced by trusted kernel (PR #296)', () => {
    const scriptPath = path.join(repositoryRoot, 'scripts', 'run-guard-mutation-parity.js');
    assert.ok(!fs.existsSync(scriptPath),
        'guard mutation parity script should be deleted');
    const pkg = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'package.json'), 'utf8'));
    assert.ok(!pkg.scripts['test:ci:linux'].includes('run-guard-mutation-parity'),
        'parity should not be in the Linux lane');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 posts a read-only impact report instead of gating on a body declaration (PR 4/6)', () => {
    const workflow = loadWorkflow('merge-approval-gate.yml');
    assert.ok(workflow.on.pull_request_target.types.includes('edited'),
        'body edits re-evaluate the head');
    const gate = workflow.jobs.gate;
    assert.ok(gate['timeout-minutes'] >= 10, 'full-history checkout and regeneration need budget');
    const checkout = gate.steps.find(step => step.uses && step.uses.startsWith('actions/checkout'));
    assert.ok(checkout && checkout.with && checkout.with['fetch-depth'] === 0,
        'the gate regenerates the impact report and needs full history');
    assert.strictEqual(workflow.permissions.issues, 'read',
        'the gate never writes PR comments — the report goes to the job summary (no notification email)');

    const script = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'run-merge-approval-gate.js'), 'utf8');
    assert.ok(!/evaluateChangeImpactDeclaration/.test(script),
        'the AI-authored change-impact declaration is no longer evaluated (PR 4/6)');
    assert.match(script, /collectArchitectureDiff/,
        'the gate regenerates the impact report for the PR head');
    assert.ok(!/upsertReportComment|issues\/comments.*POST/.test(script),
        'the gate must not post PR comments (notification-free review aid)');
    assert.match(script, /GITHUB_STEP_SUMMARY/,
        'the gate publishes the report to the job summary');

    // Regression: the renderer must actually run — a wiring-only assertion
    // shipped a REPORT_MARKER ReferenceError to production once (#306).
    const { renderImpactReport } = require(path.join(
        repositoryRoot, 'scripts', 'run-merge-approval-gate.js'));
    const report = renderImpactReport({
        pullRequest: { head: { sha: 'a'.repeat(40) } },
        report: {
            baseRef: 'origin/main',
            errors: [],
            touchedModules: {},
            newFiles: [],
            removedFiles: [],
            protectedTouched: [],
            policyDelta: {
                mayDependOnGrown: {},
                entrypointsGrown: {},
                invariantChanges: {},
                invariantsRemoved: [],
                baselineGrown: [],
                waiversAdded: [],
            },
        },
    });
    assert.ok(report.includes('aaaaaaaa'), 'the report names the head');
    assert.ok(report.includes('Architecture impact report'));
    assert.match(script, /pull\/\$\{prNumber\}\/head/,
        'the gate fetches and checks out the exact PR head');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 approval markers match per line', () => {
    // The owner may pack the approval command with other text; the gate
    // evaluates comment bodies line by line.
    const lib = fs.readFileSync(
        path.join(repositoryRoot, 'scripts', 'lib', 'mergeApprovals.js'), 'utf8');
    assert.match(lib, /split\('\\n'\)/, 'approval matching splits comment bodies into lines');
    const { evaluateMergeApproval } =
        require(path.join(repositoryRoot, 'scripts', 'lib', 'mergeApprovals.js'));
    const head = 'a'.repeat(40);
    const combined = [{ user: { login: 'hzcheng' }, body: `ship it\r\napprove ${head}`, created_at: '2026-08-19T00:00:00Z' }];
    assert.equal(evaluateMergeApproval({ comments: combined, authorLogin: 'hzcheng', headSha: head }).approved, true,
        'the approve line inside a combined comment counts');
});
