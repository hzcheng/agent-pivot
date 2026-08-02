#!/usr/bin/env node
'use strict';

/**
 * ARCH-PR-SKILL-HARVEST-GATE-001: a pull request body must record the skill
 * harvest decision in a "## Skill harvest" section so the review step from
 * .skills/harvesting-workflow-lessons leaves a checkable artifact.
 *
 * Usage: PR_BODY=<body> node scripts/check-pr-body.js
 *        node scripts/check-pr-body.js <body-file>
 */

const fs = require('node:fs');

/** Returns the trimmed section content, or null when the heading is absent. */
function findHarvestSection(body) {
    const text = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
    const heading = /^##[ \t]+Skill harvest[ \t]*$/im.exec(text);
    if (!heading) {
        return null;
    }
    const rest = text.slice(heading.index + heading[0].length);
    const next = /^##[ \t]/im.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
}

function checkPrBody(body) {
    const section = findHarvestSection(body);
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

function main() {
    const fileArgument = process.argv[2];
    const body = fileArgument
        ? fs.readFileSync(fileArgument, 'utf8')
        : (process.env.PR_BODY || '');
    const errors = checkPrBody(body);
    if (errors.length) {
        for (const error of errors) {
            console.error(error);
        }
        process.exitCode = 1;
        return;
    }
    console.log('PR body skill harvest section present.');
}

if (require.main === module) {
    main();
}

module.exports = { checkPrBody, findHarvestSection };
