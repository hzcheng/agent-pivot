'use strict';

const path = require('node:path');
const { loadBehaviorCatalog } = require('./lib/behaviorCatalog');
const {
    loadReleaseJourneyCatalog,
    validateReleaseJourneyCatalog,
} = require('./lib/releaseJourneyCatalog');

function main(options = {}) {
    const repositoryRoot = options.repositoryRoot || path.resolve(__dirname, '..');
    const logger = options.logger || console;
    const manifest = options.manifest || loadReleaseJourneyCatalog(path.join(
        repositoryRoot,
        'docs',
        'testing',
        'conversation-release-journeys.json'
    ));
    const behaviors = options.behaviors || loadBehaviorCatalog(path.join(
        repositoryRoot,
        'docs',
        'testing',
        'behavior-contracts.json'
    ));
    const errors = validateReleaseJourneyCatalog(manifest, { behaviors });
    if (errors.length > 0) {
        for (const error of errors) logger.error(error);
        return 1;
    }
    logger.log(
        `AI Conversation release journey checks passed: ${manifest.blockers.length} blockers.`
    );
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { main };
