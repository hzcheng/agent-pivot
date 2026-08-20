'use strict';

// Merge approval gate logic. The gate is a mechanical merge-time block: a PR
// may only merge once the repository owner has left an approval comment that
// names the full head SHA — `approve <full-sha>` (round-2 review Blocker 2:
// committer timestamps are author-controlled, so approval binds the exact
// head and never the clock). The audit is the post-merge backstop that the
// SHA-bound marker exists at all.
//
// Approval markers are matched per line: a command line works anywhere in
// the comment body.

// The binding form: a first-word marker, then the full 40-hex head SHA.
const MERGE_APPROVAL_PATTERN = /^\s*(?:合并|批准|lgtm|approve[ds]?|merge)\s+([0-9a-f]{40})\s*$/i;

// Legacy free-form markers, recognized only to explain the failure and for
// merges that predate the SHA binding (the audit switches per merge by
// content marker, not by date).
const LEGACY_APPROVAL_PATTERN = /^\s*(?:合并|批准|lgtm|approve[ds]?|merge)(?![A-Za-z])/i;

// Merges before this date predate the gate and are exempt from the audit
// (they were approved in conversation under the previous rules). The cutoff
// must sit after the merges of the gate-building PRs themselves (#126/#128,
// merged 2026-08-05T01:57:01Z/02:05:43Z), which by definition could not carry
// the approval comment the gate introduced.
const MERGE_APPROVAL_REQUIRED_SINCE = '2026-08-05T02:06:00Z';

/**
 * The full head SHA an approval comment binds, or null. A comment may carry
 * several lines (e.g. both approval commands in one comment); every line is
 * evaluated independently.
 */
function approvalBoundSha(body) {
    for (const line of String(body || '').split('\n')) {
        const match = MERGE_APPROVAL_PATTERN.exec(line);
        if (match) { return match[1].toLowerCase(); }
    }
    return null;
}

/** True when any line of the comment binds expectedSha with the pattern. */
function commentBindsSha(body, pattern, expectedSha) {
    const expected = String(expectedSha || '').toLowerCase();
    return String(body || '').split('\n').some(line => {
        const match = pattern.exec(line);
        return match !== null && match[1].toLowerCase() === expected;
    });
}

/** Legacy free-form marker (no SHA binding), matched per line. */
function isApprovalComment(body) {
    return String(body || '').split('\n').some(line => LEGACY_APPROVAL_PATTERN.test(line));
}

/** Latest owner comment that binds expectedSha, or null. */
function findApprovalComment(comments, options) {
    const authorLogin = String(options.authorLogin || '').toLowerCase();
    const expectedSha = String(options.headSha || '').toLowerCase();
    let latest = null;
    for (const comment of comments || []) {
        if (!comment || String(comment?.user?.login || '').toLowerCase() !== authorLogin) {
            continue;
        }
        if (!commentBindsSha(comment.body, MERGE_APPROVAL_PATTERN, expectedSha)) {
            continue;
        }
        if (!latest || Date.parse(comment.created_at || '') > Date.parse(latest.created_at || '')) {
            latest = comment;
        }
    }
    return latest;
}

function findLegacyApprovalComment(comments, authorLogin) {
    const owner = String(authorLogin || '').toLowerCase();
    let latest = null;
    for (const comment of comments || []) {
        if (!comment || String(comment?.user?.login || '').toLowerCase() !== owner) {
            continue;
        }
        if (!isApprovalComment(comment.body)) {
            continue;
        }
        if (!latest || Date.parse(comment.created_at || '') > Date.parse(latest.created_at || '')) {
            latest = comment;
        }
    }
    return latest;
}

/**
 * Gate verdict for a PR head: an owner approval comment must bind the exact
 * full head SHA (`approve <sha>`), so pushing new commits invalidates earlier
 * approvals — and backdating a commit cannot launder a stale one.
 */
function evaluateMergeApproval(options) {
    const headSha = String(options.headSha || '').toLowerCase();
    const comment = findApprovalComment(options.comments, {
        authorLogin: options.authorLogin,
        headSha,
    });
    if (comment) {
        return {
            approved: true,
            reason: `approved by owner comment bound to ${headSha}`,
            commentUrl: comment.html_url || '',
        };
    }
    const legacy = findLegacyApprovalComment(options.comments, options.authorLogin);
    if (legacy) {
        return {
            approved: false,
            reason: `the approval does not bind the current head — comment 'approve ${headSha}'`,
            commentUrl: '',
        };
    }
    return {
        approved: false,
        reason: `no owner approval comment — comment 'approve ${headSha}'`,
        commentUrl: '',
    };
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
    approvalBoundSha,
    commentBindsSha,
    isApprovalComment,
    findApprovalComment,
    evaluateMergeApproval,
    mergeRequiresApproval,
};
