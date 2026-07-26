'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
    findStaleIdentity,
    validateInheritedIconHashes,
    validateManifestPair,
} = require('./lib/brandIdentity');

const root = path.resolve(__dirname, '..');
const main = require(path.join(root, 'package.json'));
const bridge = require(path.join(
    root, 'extensions/attention-ui-bridge/package.json'
));
validateManifestPair(main, bridge);
validateInheritedIconHashes(root);
assert.deepEqual(findStaleIdentity(root), []);
console.log('Agent Pivot brand identity checks passed.');
