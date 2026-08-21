'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The composition root's source surface: src/dashboard.ts plus every
 * composition section extracted under src/dashboard/sections/. Content
 * anchors that pin the composition (constructor wiring, callback shape) must
 * read this combined text so section extractions stay refactorable.
 */
function readCompositionSource(root) {
    const dashboardPath = path.join(root, 'src', 'dashboard.ts');
    const sectionsDirectory = path.join(root, 'src', 'dashboard', 'sections');
    const sources = [fs.readFileSync(dashboardPath, 'utf8')];
    if (fs.existsSync(sectionsDirectory)) {
        for (const entry of fs.readdirSync(sectionsDirectory).sort()) {
            if (entry.endsWith('.ts')) {
                sources.push(fs.readFileSync(path.join(sectionsDirectory, entry), 'utf8'));
            }
        }
    }
    return sources.join('\n');
}

module.exports = { readCompositionSource };
