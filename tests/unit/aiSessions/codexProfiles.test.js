'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const profiles = require('../../../out/aiSessions/codexProfiles');
const { readCodexDefaultProfile } = require('../../../out/aiSessions/launchOptions');

// SESSION-CODEX-PROFILE-DISCOVERY-001
// SESSION-CODEX-PROFILE-PICK-001
// SESSION-CODEX-PROFILE-CLI-PROBE-001

function makeCodexHome(entries) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profiles-'));
    for (const entry of entries) {
        fs.writeFileSync(path.join(home, entry), '# profile\n');
    }
    return home;
}

function makeWorkspaceConfiguration(values) {
    return {
        getConfiguration: section => ({
            get: (key, fallback) => (section === 'agentPivot' && key in values ? values[key] : fallback),
        }),
    };
}

test('SESSION-CODEX-PROFILE-DISCOVERY-001 validates profile names by basename safety', () => {
    const valid = ['deepseek', 'glm-5', 'kimi 2.5', '模型', 'a'.repeat(64), 'with space'];
    for (const name of valid) {
        assert.equal(profiles.isValidCodexProfileName(name), true, `expected valid: ${name}`);
    }
    const invalid = [
        '', '  ', ' deepseek', 'deepseek ', '.', '..', '../etc', 'a/b', 'a\\b',
        '-x', '--profile', 'a\0b', 'a'.repeat(65), null, undefined, 42,
    ];
    for (const name of invalid) {
        assert.equal(profiles.isValidCodexProfileName(name), false, `expected invalid: ${String(name)}`);
    }
    assert.equal(profiles.sanitizeCodexProfileName('  deepseek  '), 'deepseek');
    assert.equal(profiles.sanitizeCodexProfileName('a/b'), null);
    assert.equal(profiles.sanitizeCodexProfileName(undefined), null);
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 discovers config overlays and filters invalid names', () => {
    const home = makeCodexHome([
        'deepseek.config.toml',
        'kimi 2.5.config.toml',
        'glm.config.toml',
        'config.toml',
        'notes.txt',
        '-bad.config.toml',
        '.config.toml',
    ]);
    try {
        assert.deepEqual(
            profiles.listCodexConfigProfiles({ CODEX_HOME: home }, '/nonexistent-home'),
            ['deepseek', 'glm', 'kimi 2.5']
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 returns an empty list for a missing home without logging', () => {
    const missing = path.join(os.tmpdir(), `codex-profiles-missing-${process.pid}`);
    const logs = [];
    assert.deepEqual(
        profiles.listCodexConfigProfiles({}, missing, (message, error) => logs.push([message, error])),
        []
    );
    assert.equal(logs.length, 0, 'ENOENT must stay silent');
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 logs unexpected discovery errors and returns an empty list', () => {
    const home = makeCodexHome([]);
    const fileNotDir = path.join(home, 'not-a-directory');
    fs.writeFileSync(fileNotDir, 'x');
    const logs = [];
    try {
        assert.deepEqual(
            profiles.listCodexConfigProfiles({}, fileNotDir, (message, error) => logs.push([message, error])),
            []
        );
        assert.equal(logs.length, 1, 'non-ENOENT discovery failures must be logged');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 resolves CODEX_HOME before the default home', () => {
    const home = makeCodexHome(['one.config.toml']);
    try {
        assert.deepEqual(
            profiles.listCodexConfigProfiles({ CODEX_HOME: home }, '/nonexistent-home'),
            ['one']
        );
        assert.equal(profiles.resolveCodexHome({ CODEX_HOME: home }, '/x'), home);
        assert.equal(profiles.resolveCodexHome({}, '/x'), path.join('/x', '.codex'));
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 reports profile file existence safely', () => {
    const home = makeCodexHome(['deepseek.config.toml']);
    try {
        assert.equal(profiles.codexProfileFileExists('deepseek', { CODEX_HOME: home }, '/x'), true);
        assert.equal(profiles.codexProfileFileExists('missing', { CODEX_HOME: home }, '/x'), false);
        assert.equal(profiles.codexProfileFileExists('../escape', { CODEX_HOME: home }, '/x'), false);
        assert.equal(profiles.codexProfileFileExists('-bad', { CODEX_HOME: home }, '/x'), false);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('SESSION-CODEX-PROFILE-PICK-001 builds base plus profile picks with deduped tags', () => {
    const picks = profiles.buildCodexProfilePicks({
        profiles: ['deepseek', 'glm'],
        lastUsed: { kind: 'profile', name: 'deepseek' },
        defaultFromSetting: 'deepseek',
    });
    const byLabel = new Map(picks.map(pick => [pick.label, pick]));
    assert.ok(byLabel.has(profiles.CODEX_BASE_PROFILE_PICK_LABEL));
    const deepseek = byLabel.get('deepseek');
    assert.deepEqual(deepseek.decision, { kind: 'profile', name: 'deepseek' });
    assert.ok(deepseek.description.includes('Default setting'), 'setting match is tagged, not duplicated');
    assert.ok(deepseek.description.includes('Last used'));
    assert.equal(
        picks.filter(pick => pick.label === 'deepseek').length,
        1,
        'the setting value must not produce a duplicate named pick'
    );
    assert.deepEqual(byLabel.get(profiles.CODEX_BASE_PROFILE_PICK_LABEL).decision, { kind: 'base' });
});

test('SESSION-CODEX-PROFILE-PICK-001 places the preselected pick first so Enter accepts it', () => {
    const scenarios = [
        {
            title: 'last used profile wins',
            input: { profiles: ['deepseek', 'glm'], lastUsed: { kind: 'profile', name: 'glm' }, defaultFromSetting: 'deepseek' },
            expectedFirst: 'glm',
        },
        {
            title: 'explicit last used base wins over the setting',
            input: { profiles: ['deepseek'], lastUsed: { kind: 'base' }, defaultFromSetting: 'deepseek' },
            expectedFirst: profiles.CODEX_BASE_PROFILE_PICK_LABEL,
        },
        {
            title: 'setting is the fallback preselection',
            input: { profiles: ['deepseek', 'glm'], lastUsed: null, defaultFromSetting: 'glm' },
            expectedFirst: 'glm',
        },
        {
            title: 'base is the default preselection',
            input: { profiles: ['deepseek'], lastUsed: null, defaultFromSetting: null },
            expectedFirst: profiles.CODEX_BASE_PROFILE_PICK_LABEL,
        },
        {
            title: 'a stale last used profile falls back to the setting',
            input: { profiles: ['deepseek'], lastUsed: { kind: 'profile', name: 'deleted' }, defaultFromSetting: 'deepseek' },
            expectedFirst: 'deepseek',
        },
        {
            title: 'a setting without a discovered file is never preselected',
            input: { profiles: ['deepseek'], lastUsed: null, defaultFromSetting: 'missing' },
            expectedFirst: profiles.CODEX_BASE_PROFILE_PICK_LABEL,
        },
    ];
    for (const scenario of scenarios) {
        const picks = profiles.buildCodexProfilePicks(scenario.input);
        assert.equal(picks[0].label, scenario.expectedFirst, scenario.title);
        assert.ok(picks[0].description.includes('Current'), `${scenario.title}: preselected pick is tagged`);
    }
});

test('SESSION-CODEX-PROFILE-PICK-001 a missing setting file yields no named candidate', () => {
    const picks = profiles.buildCodexProfilePicks({
        profiles: ['deepseek'],
        lastUsed: null,
        defaultFromSetting: 'missing',
    });
    assert.ok(!picks.some(pick => pick.label === 'missing'));
    assert.ok(picks.some(pick => pick.label === profiles.CODEX_BASE_PROFILE_PICK_LABEL));
});

test('SESSION-CODEX-PROFILE-CLI-PROBE-001 detects --profile support and caches per executable', async () => {
    const calls = [];
    const mementoData = {};
    const memento = {
        get: key => mementoData[key],
        update: (key, value) => { mementoData[key] = value; },
    };
    const probe = new profiles.CodexProfileSupportProbe({
        executable: '/usr/bin/codex',
        memento,
        execFileAsync: async (executable, args) => {
            calls.push([executable, args]);
            return { stdout: 'Usage: codex resume [OPTIONS]\n  -p, --profile <CONFIG_PROFILE_V2>', stderr: '' };
        },
    });
    assert.equal(await probe.isSupported(), true);
    assert.equal(await probe.isSupported(), true);
    assert.equal(calls.length, 1, 'the probe result is cached in memory');
    assert.deepEqual(calls[0][1], ['resume', '--help']);

    const second = new profiles.CodexProfileSupportProbe({
        executable: '/usr/bin/codex',
        memento,
        execFileAsync: async () => {
            throw new Error('must not run: persisted cache should win');
        },
    });
    assert.equal(await second.isSupported(), true, 'the persisted cache survives restarts');
});

test('SESSION-CODEX-PROFILE-CLI-PROBE-001 treats old CLIs and probe failures as unsupported', async () => {
    const legacy = new profiles.CodexProfileSupportProbe({
        executable: 'codex',
        execFileAsync: async () => ({ stdout: 'Usage: codex resume [SESSION_ID]', stderr: '' }),
    });
    assert.equal(await legacy.isSupported(), false);

    const failing = new profiles.CodexProfileSupportProbe({
        executable: 'codex',
        execFileAsync: async () => { throw new Error('spawn failed'); },
    });
    assert.equal(await failing.isSupported(), false);
});

test('SESSION-CODEX-PROFILE-DISCOVERY-001 reads and validates the default profile setting', () => {
    assert.equal(readCodexDefaultProfile(makeWorkspaceConfiguration({ codexDefaultProfile: 'deepseek' })), 'deepseek');
    assert.equal(readCodexDefaultProfile(makeWorkspaceConfiguration({ codexDefaultProfile: '  glm 5  ' })), 'glm 5');
    assert.equal(readCodexDefaultProfile(makeWorkspaceConfiguration({ codexDefaultProfile: '../evil' })), undefined);
    assert.equal(readCodexDefaultProfile(makeWorkspaceConfiguration({ codexDefaultProfile: '' })), undefined);
    assert.equal(readCodexDefaultProfile(makeWorkspaceConfiguration({})), undefined);
});

test('CONVERSATION-TELEMETRY-001 reads a profile top-level model_context_window', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-window-'));
    try {
        fs.writeFileSync(path.join(home, 'deepseek.config.toml'), [
            'model_provider = "codewiz"',
            'model = "codewiz:deepseek-pro"',
            'model_context_window = 1000000',
            'model_auto_compact_token_limit = 900000',
            '',
            '[model_providers.codewiz]',
            'name = "codewiz"',
            'base_url = "http://localhost:18089"',
        ].join('\n'));
        fs.writeFileSync(path.join(home, 'sectioned.config.toml'), [
            '[model_providers.codewiz]',
            'model_context_window = 512000',
        ].join('\n'));
        fs.writeFileSync(path.join(home, 'huge.config.toml'), 'model_context_window = 999999999999');
        fs.writeFileSync(path.join(home, 'commented.config.toml'), '# model_context_window = 128000\nmodel_context_window = 64000 # cap');

        assert.equal(profiles.readCodexProfileContextWindow('deepseek', { CODEX_HOME: home }, '/x'), 1000000);
        assert.equal(profiles.readCodexProfileContextWindow('sectioned', { CODEX_HOME: home }, '/x'), undefined,
            'a window inside a [model_providers.*] table is not the top-level override');
        assert.equal(profiles.readCodexProfileContextWindow('huge', { CODEX_HOME: home }, '/x'), undefined,
            'implausible values are rejected');
        assert.equal(profiles.readCodexProfileContextWindow('commented', { CODEX_HOME: home }, '/x'), 64000);
        assert.equal(profiles.readCodexProfileContextWindow('missing', { CODEX_HOME: home }, '/x'), undefined);
        assert.equal(profiles.readCodexProfileContextWindow('../etc', { CODEX_HOME: home }, '/x'), undefined);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('CONVERSATION-TELEMETRY-001 caches the profile context window briefly per resolved path', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-window-cache-'));
    try {
        const filePath = path.join(home, 'deepseek.config.toml');
        fs.writeFileSync(filePath, 'model_context_window = 1000000\n');
        assert.equal(profiles.readCodexProfileContextWindow('deepseek', { CODEX_HOME: home }, '/x', 1000), 1000000);

        fs.writeFileSync(filePath, 'model_context_window = 2000000\n');
        assert.equal(profiles.readCodexProfileContextWindow('deepseek', { CODEX_HOME: home }, '/x', 1000 + 5000), 1000000,
            'a fresh write inside the TTL still serves the cached value');
        assert.equal(profiles.readCodexProfileContextWindow('deepseek', { CODEX_HOME: home }, '/x', 1000 + 11000), 2000000,
            'the value re-reads after the TTL expires');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
