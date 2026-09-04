'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const {
    ManagedSshConsentCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConsentCoordinator');
const {
    ManagedSshConsentFileStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConsentStore');

class FakeValidator {
    constructor(onValidate) { this.probes = []; this.validations = []; this.onValidate = onValidate; }
    async probe(executable) { this.probes.push(executable); }
    async validate(input) {
        this.validations.push(input);
        if (this.onValidate) { await this.onValidate(input); }
    }
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-ssh-consent-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ssh = path.join(root, '.ssh');
    fs.mkdirSync(ssh, { mode: 0o700 });
    const config = path.join(ssh, 'config');
    fs.writeFileSync(config, 'Host legacy\n  HostName old.example.com\n', { mode: 0o600 });
    const validator = new FakeValidator();
    const consent = new ManagedSshConsentFileStore(path.join(root, 'bridge'));
    const coordinator = new ManagedSshConsentCoordinator(
        config,
        '/usr/bin/ssh',
        consent,
        validator,
    );
    let id = 0;
    const catalog = ManagedRemoteCatalogService.create('consent', prefix => `${prefix}:${++id}`);
    const machine = catalog.addMachine({
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22022,
    });
    return { root, config, validator, consent, coordinator, catalog, machine };
}

test('MANAGED-REMOTE-SSH-CONSENT-001 rejects corrupt or exposed local consent records', t => {
    const { root, config, consent } = fixture(t);
    consent.compareAndSet(0, {
        schemaVersion: 1,
        generation: 0,
        configPath: config,
        executable: '/usr/bin/ssh',
        status: 'disabled',
    });
    const record = path.join(
        root,
        'bridge',
        'managed-ssh-consent',
        'v1',
        `${crypto.createHash('sha256').update(config).digest('hex')}.json`,
    );
    fs.writeFileSync(record, '{broken', { mode: 0o600 });
    assert.throws(() => consent.read(config, '/usr/bin/ssh'), /corrupt/);
    if (process.platform !== 'win32') {
        fs.writeFileSync(record, JSON.stringify({
            schemaVersion: 1,
            generation: 1,
            configPath: config,
            executable: '/usr/bin/ssh',
            status: 'disabled',
        }), { mode: 0o644 });
        fs.chmodSync(record, 0o644);
        assert.throws(() => consent.read(config, '/usr/bin/ssh'), /unsafe permissions/);
    }
});

test('MANAGED-REMOTE-SSH-CONSENT-001 keeps preflight byte-identical and requires one manual Include', async t => {
    const { config, validator, coordinator, catalog } = fixture(t);
    const before = fs.readFileSync(config);
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const preflight = await coordinator.preflightEnable(slot);
    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(coordinator.getState().status, 'disabled');

    const started = await coordinator.beginEnable(slot);
    assert.equal(started.status, 'awaitingManualInclude');
    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(coordinator.getState().status, 'enabling');
    fs.writeFileSync(config, preflight.candidateConfigContent, { mode: 0o600 });
    const enabled = await coordinator.confirmEnable(slot);
    assert.equal(enabled.status, 'enabled');
    assert.equal(validator.probes.length >= 2, true);
    assert.equal(validator.validations.length, 2);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 reconciles owned config only when connections change', async t => {
    const { config, coordinator, catalog, machine } = fixture(t);
    let slot = createManagedRevisionSlot(catalog.getDocument());
    const preflight = await coordinator.preflightEnable(slot);
    await coordinator.beginEnable(slot);
    fs.writeFileSync(config, preflight.candidateConfigContent, { mode: 0o600 });
    let state = await coordinator.confirmEnable(slot);
    const currentPath = path.join(path.dirname(config), 'agent-pivot', 'current.conf');
    const firstBytes = fs.readFileSync(currentPath);

    const project = catalog.addProject({
        environmentId: `host:${machine.id}`,
        name: 'API', remotePath: '/work/api', tags: ['metadata'],
    });
    catalog.editProject(project.id, { tags: ['changed'] });
    slot = createManagedRevisionSlot(catalog.getDocument());
    state = await coordinator.reconcile(slot);
    assert.deepEqual(fs.readFileSync(currentPath), firstBytes);

    catalog.editMachine(machine.id, { port: 22023 });
    slot = createManagedRevisionSlot(catalog.getDocument());
    state = await coordinator.reconcile(slot);
    assert.match(fs.readFileSync(currentPath, 'utf8'), /Port 22023/);
    assert.equal(state.activeRevisionId, slot.revisionId);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 disables only after manual Include removal', async t => {
    const { config, coordinator, catalog } = fixture(t);
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const enable = await coordinator.preflightEnable(slot);
    await coordinator.beginEnable(slot);
    fs.writeFileSync(config, enable.candidateConfigContent, { mode: 0o600 });
    await coordinator.confirmEnable(slot);

    const disable = await coordinator.beginDisable();
    assert.equal(coordinator.getState().status, 'disabling');
    await assert.rejects(coordinator.confirmDisable(), /Remove the exact/);
    fs.writeFileSync(config, disable.candidateConfigContent, { mode: 0o600 });
    const disabled = await coordinator.confirmDisable();
    assert.equal(disabled.status, 'disabled');
    assert.equal(fs.existsSync(disable.generatedDirectory), false);
    assert.match(fs.readFileSync(config, 'utf8'), /Host legacy/);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 cancel before consent is byte-identical', async t => {
    const { config, coordinator, catalog } = fixture(t);
    const before = fs.readFileSync(config);
    const slot = createManagedRevisionSlot(catalog.getDocument());
    await coordinator.beginEnable(slot);
    const disabled = await coordinator.cancelPendingTransition();
    assert.equal(disabled.status, 'disabled');
    assert.deepEqual(fs.readFileSync(config), before);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 resumes enable and disable after a process restart', async t => {
    const { root, config, validator, coordinator, catalog } = fixture(t);
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const enable = await coordinator.beginEnable(slot);
    const restarted = new ManagedSshConsentCoordinator(
        config,
        '/usr/bin/ssh',
        new ManagedSshConsentFileStore(path.join(root, 'bridge')),
        validator,
    );
    const pending = await restarted.recover(slot);
    assert.equal(pending.status, 'awaitingManualInclude');
    fs.writeFileSync(config, enable.preflight.candidateConfigContent, { mode: 0o600 });
    const recoveredEnable = await restarted.recover(slot);
    assert.equal(recoveredEnable.status, 'enabled');

    const disable = await restarted.beginDisable();
    fs.writeFileSync(config, disable.candidateConfigContent, { mode: 0o600 });
    const restartedAgain = new ManagedSshConsentCoordinator(
        config,
        '/usr/bin/ssh',
        new ManagedSshConsentFileStore(path.join(root, 'bridge')),
        validator,
    );
    const recoveredDisable = await restartedAgain.recover();
    assert.equal(recoveredDisable.status, 'disabled');
    assert.equal(fs.existsSync(disable.generatedDirectory), false);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 rejects an external config write during validation', async t => {
    const { root, config, catalog } = fixture(t);
    const before = fs.readFileSync(config, 'utf8');
    const validator = new FakeValidator(() => {
        fs.writeFileSync(config, `${before}# external editor\n`, { mode: 0o600 });
    });
    const coordinator = new ManagedSshConsentCoordinator(
        config,
        '/usr/bin/ssh',
        new ManagedSshConsentFileStore(path.join(root, 'bridge-race')),
        validator,
    );
    await assert.rejects(
        coordinator.beginEnable(createManagedRevisionSlot(catalog.getDocument())),
        /changed while Agent Pivot was validating/,
    );
    assert.equal(coordinator.getState().status, 'recoveryRequired');
    assert.equal(
        fs.existsSync(path.join(path.dirname(config), 'agent-pivot', 'current.conf')),
        false,
    );
    assert.match(fs.readFileSync(config, 'utf8'), /external editor/);
});

test('MANAGED-REMOTE-SSH-CONSENT-001 unsafe preflight performs no write', async t => {
    const { root, config, coordinator, catalog } = fixture(t);
    fs.writeFileSync(config, 'Include ~/.ssh/conf.d/*\n', { mode: 0o600 });
    const before = fs.readFileSync(config);
    await assert.rejects(
        coordinator.preflightEnable(createManagedRevisionSlot(catalog.getDocument())),
        /dynamic-include/,
    );
    assert.deepEqual(fs.readFileSync(config), before);
    assert.equal(fs.existsSync(path.join(root, '.ssh', 'agent-pivot')), false);
    assert.equal(coordinator.getState().status, 'disabled');
});

test('MANAGED-REMOTE-SSH-CONSENT-001 explicitly retries recoverable races without losing user bytes', async t => {
    const { root, config, catalog } = fixture(t);
    const before = fs.readFileSync(config, 'utf8');
    let mutate = true;
    const racing = new FakeValidator(() => {
        if (!mutate) { return; }
        mutate = false;
        fs.writeFileSync(config, `${before}# kept external edit\n`, { mode: 0o600 });
    });
    const consent = new ManagedSshConsentFileStore(path.join(root, 'bridge-retry'));
    const coordinator = new ManagedSshConsentCoordinator(
        config, '/usr/bin/ssh', consent, racing,
    );
    const slot = createManagedRevisionSlot(catalog.getDocument());
    await assert.rejects(coordinator.beginEnable(slot), /changed while/);

    const retry = new ManagedSshConsentCoordinator(
        config, '/usr/bin/ssh', consent, new FakeValidator(),
    );
    const result = await retry.recover(slot);
    assert.equal(result.status, 'awaitingManualInclude');
    assert.match(result.preflight.candidateConfigContent, /kept external edit/);
    assert.equal(retry.getState().status, 'enabling');
});

test('MANAGED-REMOTE-SSH-CONSENT-001 revalidates a changed SSH executable before returning enabled', async t => {
    const { root, config, validator, coordinator, catalog } = fixture(t);
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const enable = await coordinator.beginEnable(slot);
    fs.writeFileSync(config, enable.preflight.candidateConfigContent, { mode: 0o600 });
    await coordinator.confirmEnable(slot);

    const changed = new ManagedSshConsentCoordinator(
        config,
        '/opt/openssh/bin/ssh',
        new ManagedSshConsentFileStore(path.join(root, 'bridge')),
        validator,
    );
    assert.equal(changed.getState().status, 'recoveryRequired');
    const recovered = await changed.recover(slot);
    assert.equal(recovered.status, 'enabled');
    assert.equal(recovered.record.executable, '/opt/openssh/bin/ssh');
});

test('MANAGED-REMOTE-SSH-CONSENT-001 serializes reconcile and disable transitions', async t => {
    const { root, config, coordinator, catalog, machine } = fixture(t);
    let slot = createManagedRevisionSlot(catalog.getDocument());
    const enable = await coordinator.beginEnable(slot);
    fs.writeFileSync(config, enable.preflight.candidateConfigContent, { mode: 0o600 });
    await coordinator.confirmEnable(slot);

    let releaseValidation;
    let reportEntered;
    const entered = new Promise(resolve => { reportEntered = resolve; });
    const gate = new Promise(resolve => { releaseValidation = resolve; });
    const serial = new ManagedSshConsentCoordinator(
        config,
        '/usr/bin/ssh',
        new ManagedSshConsentFileStore(path.join(root, 'bridge')),
        new FakeValidator(async () => {
            reportEntered();
            await gate;
        }),
    );
    catalog.editMachine(machine.id, { port: 22024 });
    slot = createManagedRevisionSlot(catalog.getDocument());
    const reconciling = serial.reconcile(slot);
    await entered;
    let disableSettled = false;
    const disabling = serial.beginDisable().finally(() => { disableSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disableSettled, false);
    releaseValidation();
    await reconciling;
    const disable = await disabling;
    assert.equal(serial.getState().status, 'disabling');
    assert.match(disable.includeBlock, /Agent Pivot managed SSH hosts/);
});
