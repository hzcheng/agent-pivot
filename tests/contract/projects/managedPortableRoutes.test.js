'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { managedJumpAlias, managedJumpRoute } = require('../../../out/projects/managedRemote/jumpRoutes');
const { createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const { buildManagedSshProjection, renderManagedSshConfig } = require('../../../out/projects/managedRemote/sshConfigProjection');
const { buildManagedRemoteProjectsViewModel } = require('../../../out/projects/managedRemote/viewModel');
const { resolveManagedMachineTarget } = require('../../../out/projects/managedRemote/targetResolver');
const { parseManagedRemoteCatalog } = require('../../../out/projects/managedRemote/validation');
function catalog() { let n = 0; return ManagedRemoteCatalogService.create('routes', prefix => `${prefix}:${++n}`); }
const hops = [{ name: 'outer', host: '192.0.2.1', user: 'jump', port: 2229 }, { name: 'inner', host: '192.0.2.2', user: 'dev', port: 2202 }];
function target(s, name = 'target') { return s.addMachine({ name, host: `${name}.example.com`, user: 'dev', jumpHosts: hops }); }

test('Portable routes share jump machines and survive sync and renaming', () => {
    const s = catalog(); const a = target(s); const b = target(s, 'second');
    assert.equal(s.getCatalog().machines.length, 4);
    const route = managedJumpRoute(s.getCatalog(), a);
    assert.deepEqual(route.map(x => x.name), ['outer', 'inner']);
    assert.equal(a.connection.proxyJump, managedJumpAlias(route[1].id));
    s.editMachine(route[0].id, { name: 'Renamed gateway', port: 2230 });
    const copy = new ManagedRemoteCatalogService(JSON.parse(JSON.stringify(s.getDocument())), 'other-computer');
    for (const machine of [a, b]) {
        const path = managedJumpRoute(copy.getCatalog(), machine);
        assert.equal(path[0].name, 'Renamed gateway');
        assert.equal(path[0].connection.port, 2230);
    }
    assert.ok(parseManagedRemoteCatalog(copy.getDocument()));
    assert.doesNotMatch(JSON.stringify(copy.getDocument()), /IdentityFile|privateKey|identityFile/);
});

test('Converting a reference preserves machine, environment, project and favorite IDs', () => {
    const s = catalog();
    const m = s.addMachine({ name: 'My Linux', host: 'linux.example.com', user: 'dev', sshConfigAlias: 'infra-home-linux', sourceSshAliases: ['infra-home-linux'] });
    const p = s.addProject({ environmentId: `host:${m.id}`, name: 'API', remotePath: '/work/api', favorite: true });
    s.editMachine(m.id, { jumpHosts: hops });
    const v = s.getCatalog();
    assert.equal(v.machines.find(x => x.id === m.id).name, 'My Linux');
    assert.equal(v.machines.find(x => x.id === m.id).connection.sshConfigAlias, undefined);
    assert.equal(v.projects[0].id, p.id);
    assert.deepEqual(v.layout.favoriteProjectIds, [p.id]);
});

test('Route edits reject cycles and missing hops; deletion protects dependent targets', () => {
    const s = catalog(); const a = target(s); const route = managedJumpRoute(s.getCatalog(), a);
    assert.throws(() => s.removeMachine(route[0].id), /used by inner/);
    assert.throws(() => s.editMachine(route[0].id, { proxyJump: managedJumpAlias(a.id) }), /cycle/);
    assert.throws(() => s.editMachine(a.id, { proxyJump: managedJumpAlias('missing') }), /missing/);
    const before = s.getDocument();
    assert.throws(() => s.addMachine({ name: 'target', host: 'other.example.com', user: 'dev', jumpHosts: [{ name: 'new-hop', host: '192.0.2.3', user: 'dev', port: 22 }] }));
    assert.deepEqual(s.getDocument(), before);
});

test('Merged missing or conflicted hops disable dependent navigation and projection', () => {
    const s = catalog(); const a = target(s); const route = managedJumpRoute(s.getCatalog(), a);
    const view = s.getCatalog(); view.conflicts.push({ entityType: 'machine', entityId: route[0].id, kind: 'update-update' });
    assert.throws(() => resolveManagedMachineTarget(view, a.id), /sync conflict/);
    const doc = s.getDocument();
    doc.machines[route[0].id].candidates[0].value = null;
    const projected = buildManagedSshProjection(createManagedRevisionSlot(doc));
    assert.ok(projected.unavailableMachineIds.includes(a.id));
    assert.equal(projected.entries.some(x => x.machineId === a.id), false);
});

test('Only referenced jump hosts without projects move out of the main Projects list', () => {
    const s = catalog(); const a = target(s); const plain = s.addMachine({ name: 'Empty', host: 'empty.example.com', user: 'dev' });
    const model = buildManagedRemoteProjectsViewModel({ catalog: s.getCatalog(), lifecycle: 'active', revisionId: 'r', machineConflictCandidates: {} });
    assert.deepEqual(model.jumpHosts.map(x => x.name), ['outer', 'inner']);
    assert.deepEqual(new Set(model.machines.map(x => x.id)), new Set([a.id, plain.id]));
    s.addProject({ environmentId: `host:${model.jumpHosts[0].id}`, name: 'ops', remotePath: '/ops' });
    const updated = buildManagedRemoteProjectsViewModel({ catalog: s.getCatalog(), lifecycle: 'active', revisionId: 'r', machineConflictCandidates: {} });
    assert.equal(updated.jumpHosts.length, 1);
});

test('A fresh computer resolves the generated multi-hop configuration without original SSH aliases', t => {
    if (spawnSync('ssh', ['-V']).status !== 0) { t.skip('OpenSSH unavailable'); return; }
    const s = catalog(); const a = target(s);
    const projection = buildManagedSshProjection(createManagedRevisionSlot(s.getDocument()));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-portable-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, 'config'); fs.writeFileSync(config, renderManagedSshConfig(projection));
    const route = managedJumpRoute(s.getCatalog(), a);
    for (const machine of route.concat(a)) {
        const alias = machine.id === a.id ? projection.entries.find(x => x.machineId === a.id).alias : managedJumpAlias(machine.id);
        const result = spawnSync('ssh', ['-F', config, '-G', alias], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`hostname ${machine.connection.host.replace(/\./g, '\\.')}\\n`));
        assert.ok(result.stdout.includes(`port ${machine.connection.port}\n`));
        if (machine.connection.proxyJump) assert.ok(result.stdout.includes(`proxyjump ${machine.connection.proxyJump}\n`));
    }
});

test('A shared jump host cannot become a computer-local alias, including after sync', () => {
    const s = catalog(); const a = target(s); const hop = managedJumpRoute(s.getCatalog(), a)[0];
    assert.throws(() => s.editMachine(hop.id, { sshConfigAlias: 'local-only' }), /used by|synced|jump/i);
    const view = s.getCatalog();
    view.machines.find(x => x.id === hop.id).connection.sshConfigAlias = 'local-only';
    assert.throws(() => resolveManagedMachineTarget(view, a.id), /synced/i);
});

test('Concurrent hidden dependencies and conflict selection retain portable jump hosts', () => {
    const { joinManagedRemoteCatalogs } = require('../../../out/projects/managedRemote/merge');
    const base = catalog();
    const hop = base.addMachine({ name: 'Gateway', host: 'gateway.example.com', user: 'jump' });
    const dest = base.addMachine({ name: 'Linux', host: 'linux.example.com', user: 'dev' });
    const left = new ManagedRemoteCatalogService(base.getDocument(), 'left');
    const right = new ManagedRemoteCatalogService(base.getDocument(), 'right');
    left.editMachine(dest.id, { proxyJump: managedJumpAlias(hop.id) });
    right.editMachine(dest.id, { name: 'Linux renamed' });
    right.editMachine(hop.id, { sshConfigAlias: 'local-only' });
    const merged = new ManagedRemoteCatalogService(joinManagedRemoteCatalogs(left.getDocument(), right.getDocument()), 'merged');
    assert.throws(() => merged.editMachine(hop.id, { sshConfigAlias: 'another-local' }), /shared jump host/);
    left.editMachine(hop.id, { name: 'Portable gateway' });
    const conflicted = new ManagedRemoteCatalogService(joinManagedRemoteCatalogs(left.getDocument(), right.getDocument()), 'resolver');
    const nativeCandidate = right.getCatalog().machines.find(x => x.id === hop.id);
    assert.throws(() => conflicted.resolveMachineConflict(hop.id, nativeCandidate), /shared jump host/);
    conflicted.resolveMachineConflict(hop.id, left.getCatalog().machines.find(x => x.id === hop.id));
    assert.equal(conflicted.getCatalog().machines.find(x => x.id === hop.id).connection.sshConfigAlias, undefined);
});
