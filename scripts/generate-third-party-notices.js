#!/usr/bin/env node
'use strict';

// Regenerates THIRD_PARTY_NOTICES.md from the production dependency closure.
// Usage:
//   node scripts/generate-third-party-notices.js          # rewrite the file
//   node scripts/generate-third-party-notices.js --check  # fail if it drifted

const fs = require('node:fs');
const path = require('node:path');
const { collectNotices, renderNotices } = require('./lib/thirdPartyNotices');

function main() {
    const checkMode = process.argv.includes('--check');
    const repositoryRoot = path.resolve(__dirname, '..');
    const noticesPath = path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');

    const notices = collectNotices(repositoryRoot);
    const missing = notices.filter(notice => notice.missingLicenseFile);
    const rendered = renderNotices(notices);

    if (checkMode) {
        const current = fs.existsSync(noticesPath)
            ? fs.readFileSync(noticesPath, 'utf8')
            : '';
        if (current !== rendered) {
            console.error('THIRD_PARTY_NOTICES.md is out of date with the production dependency closure.');
            console.error('Run `node scripts/generate-third-party-notices.js` and commit the result.');
            process.exitCode = 1;
            return;
        }
        console.log(`Third-party notices are up to date (${notices.length} packages, `
            + `${missing.length} without a shipped license file).`);
        return;
    }

    fs.writeFileSync(noticesPath, rendered);
    console.log(`Wrote THIRD_PARTY_NOTICES.md with ${notices.length} packages `
        + `(${missing.length} without a shipped license file).`);
    for (const notice of missing) {
        console.log(`  no license file: ${notice.name} ${notice.version} (${notice.license})`);
    }
}

main();
