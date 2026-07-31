'use strict';

const fs = require('node:fs');

const RELEASE_JOURNEY_ID =
    /^CONVERSATION-RELEASE-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}$/;
const ALLOWED_ENFORCEMENTS = new Set(['pull-request', 'release']);

function loadReleaseJourneyCatalog(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateReleaseJourneyCatalog(manifest, options = {}) {
    const errors = [];
    const behaviors = options.behaviors;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return ['release journey catalog must be an object'];
    }
    if (manifest.version !== 1) {
        errors.push('release journey catalog version must be 1');
    }
    if (manifest.product !== 'AI Conversation') {
        errors.push('release journey catalog product must be AI Conversation');
    }
    if (!Array.isArray(behaviors)) {
        errors.push('behavior catalog must be an array');
        return errors;
    }
    if (!Array.isArray(manifest.blockers) || manifest.blockers.length === 0) {
        errors.push('release journey catalog blockers must be a non-empty array');
        return errors;
    }

    const behaviorById = new Map();
    for (const behavior of behaviors) {
        if (behavior && typeof behavior.id === 'string') {
            behaviorById.set(behavior.id, behavior);
        }
    }
    const seenIds = new Set();
    const enforcementCounts = new Map();
    let releaseHasScheduledEvidence = false;
    for (const [index, blocker] of manifest.blockers.entries()) {
        const label = `release blocker ${index + 1}`;
        if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) {
            errors.push(`${label} must be an object`);
            continue;
        }
        const exactKeys = ['behaviors', 'enforcement', 'id', 'title'];
        const actualKeys = Object.keys(blocker).sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(exactKeys)) {
            errors.push(`${label} must define exactly ${exactKeys.join(', ')}`);
        }
        if (typeof blocker.id !== 'string' || !RELEASE_JOURNEY_ID.test(blocker.id)) {
            errors.push(`${label} has invalid id ${String(blocker.id)}`);
        } else if (seenIds.has(blocker.id)) {
            errors.push(`${label} has duplicate id ${blocker.id}`);
        } else {
            seenIds.add(blocker.id);
        }
        if (typeof blocker.title !== 'string' || blocker.title.trim() === '') {
            errors.push(`${label} title must be a non-empty string`);
        }
        if (!ALLOWED_ENFORCEMENTS.has(blocker.enforcement)) {
            errors.push(`${label} has invalid enforcement ${String(blocker.enforcement)}`);
        } else {
            enforcementCounts.set(
                blocker.enforcement,
                (enforcementCounts.get(blocker.enforcement) || 0) + 1
            );
        }
        if (!Array.isArray(blocker.behaviors) || blocker.behaviors.length === 0
            || blocker.behaviors.some(id => typeof id !== 'string' || id === '')) {
            errors.push(`${label} behaviors must be a non-empty string array`);
            continue;
        }
        if (new Set(blocker.behaviors).size !== blocker.behaviors.length) {
            errors.push(`${label} behaviors must not contain duplicates`);
        }
        for (const behaviorId of blocker.behaviors) {
            const behavior = behaviorById.get(behaviorId);
            if (!behavior) {
                errors.push(`${label} references missing behavior ${behaviorId}`);
                continue;
            }
            if (behavior.priority !== 'P0') {
                errors.push(`${label} behavior ${behaviorId} must remain P0`);
            }
            if (blocker.enforcement === 'pull-request'
                && behavior.status !== 'automated') {
                errors.push(
                    `${label} pull-request behavior ${behaviorId} must remain automated`
                );
            }
            if (blocker.enforcement === 'release'
                && !['automated', 'scheduled'].includes(behavior.status)) {
                errors.push(
                    `${label} release behavior ${behaviorId} must be automated or scheduled`
                );
            }
            if (blocker.enforcement === 'release' && behavior.status === 'scheduled') {
                releaseHasScheduledEvidence = true;
            }
        }
    }
    for (const enforcement of ALLOWED_ENFORCEMENTS) {
        if (!enforcementCounts.has(enforcement)) {
            errors.push(`release journey catalog must include a ${enforcement} blocker`);
        }
    }
    if (!releaseHasScheduledEvidence) {
        errors.push('release blockers must retain scheduled Extension Host evidence');
    }
    return errors;
}

module.exports = {
    loadReleaseJourneyCatalog,
    validateReleaseJourneyCatalog,
};
