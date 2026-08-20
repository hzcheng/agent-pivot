'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    approvalBoundSha,
    architectureApprovalBoundSha,
    evaluateMergeApproval,
    findApprovalComment,
    findArchitectureApprovalComment,
    isApprovalComment,
    mergeRequiresApproval,
    MERGE_APPROVAL_REQUIRED_SINCE,
} = require('../../../scripts/lib/mergeApprovals');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('ARCH-PR-MERGE-APPROVAL-GATE-001 approval binds the full head SHA (round-2 Blocker 2)', () => {
    assert.equal(approvalBoundSha(`approve ${HEAD}`), HEAD);
    assert.equal(approvalBoundSha(`合并 ${HEAD}`), HEAD);
    assert.equal(approvalBoundSha(`LGTM ${HEAD}`), HEAD);
    assert.equal(approvalBoundSha(`  merge ${HEAD}  `), HEAD);
    assert.equal(approvalBoundSha(`approved ${HEAD.toUpperCase()}`), HEAD,
        'marker case is free, the SHA normalizes to lowercase');
    // No binding without the full SHA, with a short SHA, or with prose.
    for (const body of ['merge', '合并吧', 'approve', `approve ${HEAD.slice(0, 8)}`,
        `approve ${HEAD} extra`, `please approve ${HEAD}`, 'mergeable', '', null, undefined]) {
        assert.equal(approvalBoundSha(body), null, `no binding: ${body}`);
    }
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 only the owner can approve, and only for the exact head', () => {
    const comments = [
        { user: { login: 'someone-else' }, body: `approve ${HEAD}`, created_at: '2026-08-05T10:00:00Z' },
        { user: { login: 'HZCHENG' }, body: `approve ${OTHER}`, created_at: '2026-08-05T11:00:00Z' },
    ];
    assert.equal(findApprovalComment(comments, { authorLogin: 'hzcheng', headSha: HEAD }), null,
        'another user\'s binding and the owner\'s binding of a different SHA both fail');
    const found = findApprovalComment(
        [...comments, { user: { login: 'hzcheng' }, body: `approve ${HEAD}`, created_at: '2026-08-05T12:00:00Z', html_url: 'y' }],
        { authorLogin: 'hzcheng', headSha: HEAD },
    );
    assert.equal(found.html_url, 'y', 'login comparison is case-insensitive');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 the gate verdict binds head, never the clock', () => {
    // A comment binding the current head approves — regardless of timestamps.
    const approved = evaluateMergeApproval({
        comments: [{ user: { login: 'hzcheng' }, body: `approve ${HEAD}`, created_at: '2020-01-01T00:00:00Z', html_url: 'u' }],
        authorLogin: 'hzcheng',
        headSha: HEAD,
    });
    assert.equal(approved.approved, true);
    assert.equal(approved.commentUrl, 'u');

    // A stale binding (earlier head) does not approve the current head.
    const stale = evaluateMergeApproval({
        comments: [{ user: { login: 'hzcheng' }, body: `approve ${OTHER}`, created_at: '2030-01-01T00:00:00Z' }],
        authorLogin: 'hzcheng',
        headSha: HEAD,
    });
    assert.equal(stale.approved, false);
    assert.match(stale.reason, /does not bind the current head/);
    assert.ok(stale.reason.includes(HEAD), 'the reason tells the owner the exact comment to write');

    // A legacy free-form approval never approves a head.
    const legacy = evaluateMergeApproval({
        comments: [{ user: { login: 'hzcheng' }, body: 'merge', created_at: '2030-01-01T00:00:00Z' }],
        authorLogin: 'hzcheng',
        headSha: HEAD,
    });
    assert.equal(legacy.approved, false);

    const none = evaluateMergeApproval({ comments: [], authorLogin: 'hzcheng', headSha: HEAD });
    assert.equal(none.approved, false);
    assert.match(none.reason, /no owner approval comment/);
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 the newest binding comment wins', () => {
    const comments = [
        { user: { login: 'hzcheng' }, body: `approve ${HEAD}`, created_at: '2026-08-05T13:00:00Z', html_url: 'old' },
        { user: { login: 'hzcheng' }, body: `批准 ${HEAD}`, created_at: '2026-08-05T14:00:00Z', html_url: 'new' },
    ];
    const found = findApprovalComment(comments, { authorLogin: 'hzcheng', headSha: HEAD });
    assert.equal(found.html_url, 'new');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 merges before the activation date are exempt', () => {
    assert.strictEqual(mergeRequiresApproval('2026-08-01T00:00:00Z'), false);
    assert.strictEqual(mergeRequiresApproval('2026-08-06T00:00:00Z'), true);
    assert.strictEqual(mergeRequiresApproval(MERGE_APPROVAL_REQUIRED_SINCE), true);
    assert.strictEqual(mergeRequiresApproval('not-a-date'), true, 'unparseable dates fail closed');
    assert.strictEqual(mergeRequiresApproval(undefined), true);
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 legacy markers are still recognized for pre-binding merges', () => {
    for (const body of ['合并', 'merge it', 'LGTM', 'approved.']) {
        assert.ok(isApprovalComment(body), `legacy recognized: ${body}`);
    }
    assert.ok(!isApprovalComment('looks good'), 'non-markers rejected');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 architecture approval binds the full head SHA', () => {
    assert.equal(architectureApprovalBoundSha(`approve-architecture ${HEAD}`), HEAD);
    assert.equal(architectureApprovalBoundSha(`  approve-architecture  ${HEAD.toUpperCase()}  `), HEAD,
        'whitespace is free and the SHA normalizes to lowercase');
    for (const body of ['approve-architecture', `approve-architecture ${HEAD.slice(0, 8)}`,
        `approve-architecture ${HEAD} extra`, `please approve-architecture ${HEAD}`,
        `approve ${HEAD}`, '', null, undefined]) {
        assert.equal(architectureApprovalBoundSha(body), null, `no binding: ${body}`);
    }
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 both approvals may live in one multi-line comment', () => {
    const combined = { user: { login: 'hzcheng' }, body: `approve-architecture ${HEAD}\napprove ${HEAD}\n`, created_at: '2026-08-19T15:00:00Z', html_url: 'both' };
    const verdict = evaluateMergeApproval({
        comments: [combined],
        authorLogin: 'hzcheng',
        headSha: HEAD,
    });
    assert.equal(verdict.approved, true, 'the approve line inside a combined comment counts');
    const arch = findArchitectureApprovalComment([combined], { authorLogin: 'hzcheng', headSha: HEAD });
    assert.equal(arch.html_url, 'both', 'the approve-architecture line inside the same comment counts');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 a comment naming several SHAs binds only the exact head line', () => {
    const comments = [
        { user: { login: 'hzcheng' }, body: `approve ${OTHER}\ntext\napprove ${HEAD}`, created_at: '2026-08-19T15:00:00Z', html_url: 'multi' },
    ];
    const verdict = evaluateMergeApproval({ comments, authorLogin: 'hzcheng', headSha: HEAD });
    assert.equal(verdict.approved, true);
    const staleOnly = evaluateMergeApproval({ comments, authorLogin: 'hzcheng', headSha: 'c'.repeat(40) });
    assert.equal(staleOnly.approved, false);
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 standard approval never substitutes for architecture approval', () => {
    const comments = [
        { user: { login: 'hzcheng' }, body: `approve ${HEAD}`, created_at: '2026-08-19T10:00:00Z' },
        { user: { login: 'someone-else' }, body: `approve-architecture ${HEAD}`, created_at: '2026-08-19T11:00:00Z' },
        { user: { login: 'hzcheng' }, body: `approve-architecture ${OTHER}`, created_at: '2026-08-19T12:00:00Z' },
    ];
    assert.equal(findArchitectureApprovalComment(comments, { authorLogin: 'hzcheng', headSha: HEAD }), null,
        'standard approval, another user\'s architecture approval, and a stale head binding all fail');
    const found = findArchitectureApprovalComment(
        [...comments, { user: { login: 'HZCHENG' }, body: `approve-architecture ${HEAD}`, created_at: '2026-08-19T13:00:00Z', html_url: 'x' }],
        { authorLogin: 'hzcheng', headSha: HEAD },
    );
    assert.equal(found.html_url, 'x', 'owner login comparison is case-insensitive');
});
