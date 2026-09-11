#!/usr/bin/env node
'use strict';

// MANAGED-REMOTE-PERFORMANCE-001: measure outside the instrumented,
// concurrent deterministic suite, using the same payload fixture and budget.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { largeCatalog } = require('../tests/fixtures/managedRemoteCatalog');
const {
    joinManagedRemoteCatalogs,
    materializeManagedRemoteCatalog,
} = require('../out/projects/managedRemote/merge');

const left = largeCatalog('left', ' A');
const right = largeCatalog('right', ' B');
const started = performance.now();
const joined = joinManagedRemoteCatalogs(left, right);
const materialized = materializeManagedRemoteCatalog(joined);
const elapsed = performance.now() - started;
assert.equal(materialized.projects.length, 500);
assert.ok(elapsed < 200, `merge + materialize took ${elapsed.toFixed(1)}ms`);
console.log(`Managed Remote performance checks passed: ${elapsed.toFixed(1)}ms < 200ms.`);
