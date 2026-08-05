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
    assert.ok(triggers.pull_request, 'gate must evaluate on pull_request events');
    assert.ok(triggers.pull_request.types.includes('synchronize'),
        'new pushes must re-evaluate (stale approvals)');
    assert.ok(triggers.issue_comment, 'gate must re-evaluate when approval comments arrive');

    assert.strictEqual(workflow.permissions.statuses, 'write', 'the job posts a commit status');
    const gate = workflow.jobs.gate;
    assert.ok(gate, 'gate job exists');
    const runSteps = gate.steps.map(step => step.run || '').join('\n');
    assert.match(runSteps, /run-merge-approval-gate\.js/, 'the job runs the gate script');

    const script = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'run-merge-approval-gate.js'), 'utf8');
    assert.match(script, /STATUS_CONTEXT = 'merge-approval'/,
        'the posted status context is the required-check name');
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
