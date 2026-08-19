#!/usr/bin/env node
'use strict';

/**
 * ARCH-PR-SKILL-HARVEST-GATE-001: a pull request body must record the skill
 * harvest decision in a "## Skill harvest" section so the review step from
 * .skills/harvesting-workflow-lessons leaves a checkable artifact.
 *
 * ARCH-PR-OWNER-APPROVALS-001: a pull request body must carry an
 * "## Owner approvals" section with the ready-to-copy approval commands
 * bound to the exact head SHA — one `approve <full-sha>` line and one
 * `approve-architecture <full-sha>` line — so the owner never has to
 * reconstruct them by hand. The gates read only PR comments; the body
 * section is never consumed as an approval.
 *
 * Usage: PR_BODY=<body> PR_HEAD_SHA=<full-sha> node scripts/check-pr-body.js
 *        PR_HEAD_SHA=<full-sha> node scripts/check-pr-body.js <body-file>
 */

const fs = require('node:fs');

/** Returns the trimmed section content, or null when the heading is absent. */
function findSection(body, name) {
    const text = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
    const heading = new RegExp('^##[ \\t]+' + name + '[ \\t]*$', 'im').exec(text);
    if (!heading) {
        return null;
    }
    const rest = text.slice(heading.index + heading[0].length);
    const next = /^##[ \t]/im.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
}

function checkHarvestSection(body) {
    const section = findSection(body, 'Skill harvest');
    if (section === null) {
        return ['PR body must contain a "## Skill harvest" section'
            + ' (see .github/pull_request_template.md).'];
    }
    if (!section) {
        return ['The "## Skill harvest" section is empty: record the decision, e.g.'
            + ' "no skill change — <evidence>" or "updated .skills/<name> — <evidence>".'];
    }
    return [];
}

function checkOwnerApprovalsSection(body, headSha) {
    if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
        return ['PR_HEAD_SHA is required to verify the "## Owner approvals" section.'];
    }
    const section = findSection(body, 'Owner approvals');
    if (section === null) {
        return ['PR body must contain an "## Owner approvals" section with the ready-to-copy'
            + ' approval commands bound to the head SHA (see .github/pull_request_template.md).'];
    }
    const lines = section.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('```'));
    const expected = [
        `approve ${headSha}`,
        `approve-architecture ${headSha}`,
    ];
    const errors = [];
    for (const command of expected) {
        const wanted = command.toLowerCase();
        if (!lines.some(line => line.toLowerCase() === wanted)) {
            errors.push(`The "## Owner approvals" section must contain the exact line "${command}".`
                + ' Regenerate it whenever the head moves (same rule as the change-impact'
                + ' declaration).');
        }
    }
    return errors;
}

function checkPrBody(body, options = {}) {
    return [
        ...checkHarvestSection(body),
        ...checkOwnerApprovalsSection(body, options.headSha),
    ];
}

function main() {
    const fileArgument = process.argv[2];
    const body = fileArgument
        ? fs.readFileSync(fileArgument, 'utf8')
        : (process.env.PR_BODY || '');
    const errors = checkPrBody(body, { headSha: process.env.PR_HEAD_SHA });
    if (errors.length) {
        for (const error of errors) {
            console.error(error);
        }
        process.exitCode = 1;
        return;
    }
    console.log('PR body skill harvest and owner approvals sections present.');
}

if (require.main === module) {
    main();
}

module.exports = { checkPrBody, findSection, findHarvestSection: body => findSection(body, 'Skill harvest') };
