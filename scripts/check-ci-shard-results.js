'use strict';

// Aggregates the `needs` results of the quality-linux shard jobs into the
// single required check. GitHub reports a job skipped because a failed
// dependency as successful to branch protection, so the aggregate job must
// run with `if: always()` and fail explicitly on any non-success shard.

const EXPECTED_SHARDS = ['linux-core', 'linux-browser', 'linux-safety', 'linux-release'];

function collectShardFailures(needs) {
    if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
        throw new Error('needs results must be an object');
    }
    const failures = [];
    for (const shard of EXPECTED_SHARDS) {
        const entry = needs[shard];
        if (!entry || typeof entry !== 'object') {
            failures.push({ shard, result: 'missing' });
            continue;
        }
        if (entry.result !== 'success') {
            failures.push({ shard, result: entry.result || 'missing' });
        }
    }
    return failures;
}

function main(environment = process.env, logger = console) {
    let needs;
    try {
        needs = JSON.parse(environment.NEEDS_JSON || '');
    } catch (error) {
        logger.error(`NEEDS_JSON must be valid JSON: ${error.message}`);
        return 1;
    }
    let failures;
    try {
        failures = collectShardFailures(needs);
    } catch (error) {
        logger.error(error.message);
        return 1;
    }
    for (const shard of EXPECTED_SHARDS) {
        const result = needs[shard] && needs[shard].result;
        logger.log(`${shard}: ${result || 'missing'}`);
    }
    if (failures.length > 0) {
        logger.error(
            `quality-linux shards not green: ${failures
                .map(failure => `${failure.shard}=${failure.result}`)
                .join(', ')}`
        );
        return 1;
    }
    logger.log('All quality-linux shards succeeded.');
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

module.exports = {
    EXPECTED_SHARDS,
    collectShardFailures,
    main,
};
