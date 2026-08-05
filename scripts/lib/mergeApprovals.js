'use strict';

// Merge approval gate logic. The gate is a mechanical merge-time block: a PR
// may only merge once the repository owner has left an approval comment newer
// than the latest head commit. The audit is the post-merge backstop that the
// marker exists at all.

// First-word approval markers. "mergeable" or a mid-sentence "merge" must not
// qualify; CJK markers need no word boundary.
const MERGE_APPROVAL_PATTERN = /^\s*(?:合并|批准|lgtm|approve[ds]?|merge)(?![A-Za-z])/i;

// Merges before this date predate the gate and are exempt from the audit
// (they were approved in conversation under the previous rules).
const MERGE_APPROVAL_REQUIRED_SINCE = '2026-08-05T00:00:00Z';

function isApprovalComment(body) {
    return MERGE_APPROVAL_PATTERN.test(String(body || ''));
}

/**
 * Latest qualifying approval comment, or null. Only comments authored by
 * authorLogin (case-insensitive) and created at or after sinceMs qualify.
 */
function findApprovalComment(comments, options) {
    const authorLogin = String(options.authorLogin || '').toLowerCase();
    const sinceMs = options.sinceMs ?? 0;
    let latest = null;
    for (const comment of comments || []) {
        if (!comment || String(comment?.user?.login || '').toLowerCase() !== authorLogin) {
            continue;
        }
        if (!isApprovalComment(comment.body)) {
            continue;
        }
        const createdAtMs = Date.parse(comment.created_at || '');
        if (!Number.isFinite(createdAtMs) || createdAtMs < sinceMs) {
            continue;
        }
        if (!latest || createdAtMs > Date.parse(latest.created_at)) {
            latest = comment;
        }
    }
    return latest;
}

/**
 * Gate verdict for a PR head: an owner approval comment must be newer than
 * the head commit, so pushing new commits invalidates earlier approvals.
 */
function evaluateMergeApproval(options) {
    const comment = findApprovalComment(options.comments, {
        authorLogin: options.authorLogin,
        sinceMs: options.headCommittedAtMs,
    });
    if (comment) {
        return { approved: true, reason: 'approved by owner comment', commentUrl: comment.html_url || '' };
    }
    const anyApproval = findApprovalComment(options.comments, { authorLogin: options.authorLogin });
    if (anyApproval) {
        return {
            approved: false,
            reason: 'the approval predates the latest commit; re-approve the current head',
            commentUrl: '',
        };
    }
    return { approved: false, reason: 'no owner approval comment', commentUrl: '' };
}

/** Audit predicate: merges at or after the activation date must be approved. */
function mergeRequiresApproval(mergedAt) {
    const mergedAtMs = Date.parse(mergedAt || '');
    if (!Number.isFinite(mergedAtMs)) {
        return true;
    }
    return mergedAtMs >= Date.parse(MERGE_APPROVAL_REQUIRED_SINCE);
}

module.exports = {
    MERGE_APPROVAL_PATTERN,
    MERGE_APPROVAL_REQUIRED_SINCE,
    isApprovalComment,
    findApprovalComment,
    evaluateMergeApproval,
    mergeRequiresApproval,
};
