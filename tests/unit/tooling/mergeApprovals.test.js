'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    evaluateMergeApproval,
    findApprovalComment,
    isApprovalComment,
    mergeRequiresApproval,
    MERGE_APPROVAL_REQUIRED_SINCE,
} = require('../../../scripts/lib/mergeApprovals');

test('ARCH-PR-MERGE-APPROVAL-GATE-001 recognizes first-word approval markers', () => {
    for (const body of ['合并', '合并吧', ' merge', 'merge it', 'LGTM', 'approved', 'Approve!', 'approved.']) {
        assert.ok(isApprovalComment(body), `accepts: ${body}`);
    }
    for (const body of ['mergeable', 'merged', 'please merge this', 'looks good', '合并x 不行', '', null, undefined]) {
        assert.ok(!isApprovalComment(body), `rejects: ${body}`);
    }
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 only the owner can approve', () => {
    const comments = [
        { user: { login: 'someone-else' }, body: 'merge', created_at: '2026-08-05T10:00:00Z', html_url: 'x' },
        { user: { login: 'HZCHENG' }, body: '合并', created_at: '2026-08-05T11:00:00Z', html_url: 'y' },
    ];
    const found = findApprovalComment(comments, { authorLogin: 'hzcheng' });
    assert.strictEqual(found.html_url, 'y', 'login comparison is case-insensitive');
    assert.strictEqual(
        findApprovalComment(comments, { authorLogin: 'hzcheng', sinceMs: Date.parse('2026-08-05T12:00:00Z') }),
        null,
        'approvals older than sinceMs do not qualify',
    );
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 approvals predate the head commit are stale', () => {
    const headCommittedAtMs = Date.parse('2026-08-05T12:00:00Z');
    const stale = evaluateMergeApproval({
        comments: [{ user: { login: 'hzcheng' }, body: 'merge', created_at: '2026-08-05T11:00:00Z' }],
        authorLogin: 'hzcheng',
        headCommittedAtMs,
    });
    assert.strictEqual(stale.approved, false);
    assert.match(stale.reason, /predates the latest commit/);

    const fresh = evaluateMergeApproval({
        comments: [{ user: { login: 'hzcheng' }, body: 'merge', created_at: '2026-08-05T13:00:00Z', html_url: 'u' }],
        authorLogin: 'hzcheng',
        headCommittedAtMs,
    });
    assert.strictEqual(fresh.approved, true);
    assert.strictEqual(fresh.commentUrl, 'u');

    const none = evaluateMergeApproval({ comments: [], authorLogin: 'hzcheng', headCommittedAtMs });
    assert.strictEqual(none.approved, false);
    assert.match(none.reason, /no owner approval comment/);
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 multiple approvals use the latest comment', () => {
    const comments = [
        { user: { login: 'hzcheng' }, body: 'merge', created_at: '2026-08-05T13:00:00Z', html_url: 'old' },
        { user: { login: 'hzcheng' }, body: '合并', created_at: '2026-08-05T14:00:00Z', html_url: 'new' },
    ];
    const found = findApprovalComment(comments, { authorLogin: 'hzcheng' });
    assert.strictEqual(found.html_url, 'new');
});

test('ARCH-PR-MERGE-APPROVAL-GATE-001 merges before the activation date are exempt', () => {
    assert.strictEqual(mergeRequiresApproval('2026-08-01T00:00:00Z'), false);
    assert.strictEqual(mergeRequiresApproval('2026-08-06T00:00:00Z'), true);
    assert.strictEqual(mergeRequiresApproval(MERGE_APPROVAL_REQUIRED_SINCE), true);
    assert.strictEqual(mergeRequiresApproval('not-a-date'), true, 'unparseable dates fail closed');
    assert.strictEqual(mergeRequiresApproval(undefined), true);
});
