'use strict';

// Covers PERSIST-AI-SKILL-CENTRAL-STORE-001 and PERSIST-AI-SKILL-SCOPE-ACTION-001:
// the central store and scope services ran mostly outside the deterministic
// coverage run (only the standalone skill-management script exercised them),
// so these tests drive the real services against temporary fixtures.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const centralService = require('../../../out/skills/centralService');
const discovery = require('../../../out/skills/discovery');
const fixService = require('../../../out/skills/fixService');
const globalStore = require('../../../out/skills/globalStoreService');
const migrateService = require('../../../out/skills/migrateService');
const scopeService = require('../../../out/skills/scopeService');

const real = dirPath => fs.realpathSync(dirPath);

function makeTempDir(prefix) {
    return real(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeSkill(filePath, frontmatter) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, frontmatter);
}

/** Home with a centralized global skill (linked into kimi+codex) and a solo claude skill. */
function makeHomeFixture() {
    const home = makeTempDir('skills-contract-home-');
    writeSkill(path.join(home, '.skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared\n---\n# S\n');
    fs.mkdirSync(path.join(home, '.kimi/skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.skills/shared'), path.join(home, '.kimi/skills/shared'), 'dir');
    fs.symlinkSync(path.join(home, '.skills/shared'), path.join(home, '.codex/skills/shared'), 'dir');
    writeSkill(path.join(home, '.claude/skills/solo/SKILL.md'), '---\nname: solo\ndescription: Solo\n---\n');
    return home;
}

/** Workspace with a centralized project skill linked into the project claude root. */
function makeWorkspaceFixture() {
    const ws = makeTempDir('skills-contract-ws-');
    writeSkill(path.join(ws, '.skills/proj/SKILL.md'), '---\nname: proj\ndescription: Project\n---\n');
    fs.mkdirSync(path.join(ws, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(ws, '.skills/proj'), path.join(ws, '.claude/skills/proj'), 'dir');
    return ws;
}

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 setCentralLink creates, removes, and refuses real directories', () => {
    const home = makeTempDir('skills-link-');
    const centralDir = path.join(home, '.skills', 'tool');
    writeSkill(path.join(centralDir, 'SKILL.md'), '---\nname: tool\ndescription: T\n---\n');
    const kimiRoot = path.join(home, '.kimi', 'skills');
    const linkPath = path.join(kimiRoot, 'tool');

    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, true);
    assert.strictEqual(fs.realpathSync(linkPath), centralDir);
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, true, 're-link is idempotent');
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, false).ok, true, 'removes the link');
    assert.ok(!fs.existsSync(linkPath));

    fs.mkdirSync(linkPath, { recursive: true });
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, false,
        'never replaces a real directory');
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, false).ok, false,
        'never deletes a real directory');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 centralizeSkill moves the winner into the store and links back', () => {
    const home = makeHomeFixture();
    const ws = makeWorkspaceFixture();
    const scanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const solo = scanned.find(record => record.name === 'solo' && record.source === 'claude');
    const duplicates = scanned.filter(record =>
        record.scope === solo.scope && record.name === solo.name && record.dirPath !== solo.dirPath);

    const lock = globalStore.acquireSkillsMutationLocks([path.join(home, '.skills')]);
    assert.strictEqual(
        centralService.centralizeSkill(solo, duplicates, home, ws).ok,
        false,
        'a held Global store lock blocks centralization',
    );
    lock.lock.release();

    const result = centralService.centralizeSkill(solo, duplicates, home, ws);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dirPath, path.join(home, '.skills', 'solo'));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'solo', 'SKILL.md')), 'content moved into the store');
    assert.strictEqual(
        fs.realpathSync(path.join(home, '.claude', 'skills', 'solo')),
        path.join(home, '.skills', 'solo'),
        'original root links back to the store',
    );

    const rescanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const solos = rescanned.filter(record => record.name === 'solo');
    assert.strictEqual(solos.length, 1, 'centralized skill merges into one record');
    assert.strictEqual(solos[0].source, 'central');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 store folders create and delete only when empty', () => {
    const home = makeHomeFixture();
    const storeRoot = path.join(home, '.skills');

    assert.strictEqual(centralService.createSkillFolder(storeRoot, 'team/backend').ok, true, 'nested create');
    assert.strictEqual(centralService.createSkillFolder(storeRoot, 'team/backend').ok, false, 'no recreate');
    assert.strictEqual(centralService.createSkillFolder(storeRoot, '../escape').ok, false, 'traversal rejected');
    assert.strictEqual(centralService.createSkillFolder(storeRoot, '').ok, false, 'empty rejected');

    writeSkill(path.join(storeRoot, 'team/backend/notes/SKILL.md'), '---\nname: notes\n---\n');
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'team/backend').ok, false,
        'non-empty folders stay');
    fs.rmSync(path.join(storeRoot, 'team/backend/notes'), { recursive: true });
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'team/backend').ok, true, 'empty deletes');
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'team/backend').ok, false,
        'unknown folder fails');
    assert.ok(fs.existsSync(path.join(storeRoot, 'team')), 'parent folders survive');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 moveSkillToFolder renames and re-points links', () => {
    const home = makeHomeFixture();
    const record = discovery.scanSkills({ homeDir: home })
        .find(candidate => candidate.name === 'shared');

    const result = centralService.moveSkillToFolder(record, 'packed', home);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dirPath, path.join(home, '.skills', 'packed', 'shared'));
    assert.strictEqual(
        fs.realpathSync(path.join(home, '.kimi', 'skills', 'shared')),
        path.join(home, '.skills', 'packed', 'shared'),
        'existing links follow the move',
    );

    const again = discovery.scanSkills({ homeDir: home })
        .find(candidate => candidate.name === 'shared');
    assert.strictEqual(centralService.moveSkillToFolder(again, 'packed', home).ok, true,
        'moving to the current folder is a no-op success');

    const plain = { ...record, central: undefined };
    assert.strictEqual(centralService.moveSkillToFolder(plain, 'x', home).ok, false,
        'non-central skills cannot move between folders');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 setFolderLinks toggles every skill under a folder', () => {
    const home = makeTempDir('skills-folder-links-');
    writeSkill(path.join(home, '.skills/pack/one/SKILL.md'), '---\nname: one\n---\n');
    writeSkill(path.join(home, '.skills/pack/two/SKILL.md'), '---\nname: two\n---\n');
    const kimiRoot = path.join(home, '.kimi', 'skills');

    const enabled = centralService.setFolderLinks(
        path.join(home, '.skills'), 'pack', 'user', home, undefined, true, ['kimi']);
    assert.strictEqual(enabled.ok, true);
    assert.strictEqual(enabled.changed, 2);
    assert.strictEqual(fs.realpathSync(path.join(kimiRoot, 'one')), path.join(home, '.skills', 'pack', 'one'));

    const disabled = centralService.setFolderLinks(
        path.join(home, '.skills'), 'pack', 'user', home, undefined, false, ['kimi']);
    assert.strictEqual(disabled.changed, 2);
    assert.ok(!fs.existsSync(path.join(kimiRoot, 'one')));

    const invalid = centralService.setFolderLinks(
        path.join(home, '.skills'), '../pack', 'user', home, undefined, true, ['kimi']);
    assert.strictEqual(invalid.ok, false, 'traversal folders rejected');
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 skillDirectoriesEqual compares content, structure, and links', () => {
    const root = makeTempDir('skills-equal-');
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    writeSkill(path.join(left, 'SKILL.md'), '---\nname: a\n---\n');
    writeSkill(path.join(left, 'refs/x.txt'), 'x');
    writeSkill(path.join(right, 'SKILL.md'), '---\nname: a\n---\n');
    writeSkill(path.join(right, 'refs/x.txt'), 'x');
    assert.strictEqual(scopeService.skillDirectoriesEqual(left, right), true);

    fs.writeFileSync(path.join(right, 'refs/x.txt'), 'changed');
    assert.strictEqual(scopeService.skillDirectoriesEqual(left, right), false, 'content drift detected');
    fs.writeFileSync(path.join(right, 'refs/x.txt'), 'x');
    fs.rmSync(path.join(right, 'refs'), { recursive: true });
    assert.strictEqual(scopeService.skillDirectoriesEqual(left, right), false, 'structure drift detected');
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 apply-global-to-project links only the selected agents', () => {
    const home = makeHomeFixture();
    const ws = makeTempDir('skills-apply-ws-');
    const record = discovery.scanSkills({ homeDir: home })
        .find(candidate => candidate.name === 'shared' && candidate.central);

    const result = scopeService.setGlobalSkillProjectAgents(record, ['kimi', 'claude'], home, ws);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(
        fs.realpathSync(path.join(ws, '.kimi', 'skills', 'shared')),
        path.join(home, '.skills', 'shared'),
    );
    assert.strictEqual(
        fs.realpathSync(path.join(ws, '.claude', 'skills', 'shared')),
        path.join(home, '.skills', 'shared'),
    );
    assert.ok(!fs.existsSync(path.join(ws, '.codex', 'skills', 'shared')),
        'unselected agents stay unlinked');

    assert.strictEqual(
        scopeService.setGlobalSkillProjectAgents(record, ['kimi', 'kimi'], home, ws).ok,
        false,
        'duplicate agents rejected',
    );
    const plain = { ...record, central: undefined };
    assert.strictEqual(
        scopeService.setGlobalSkillProjectAgents(plain, ['kimi'], home, ws).ok,
        false,
        'non-central skills rejected',
    );
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 moveProjectSkillToGlobal relocates the project skill', () => {
    const home = makeHomeFixture();
    const ws = makeWorkspaceFixture();
    const record = discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .find(candidate => candidate.name === 'proj' && candidate.central);

    const result = scopeService.moveProjectSkillToGlobal(record, undefined, home, ws);
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.skills', 'proj', 'SKILL.md')),
        'skill content landed in the Global store');
    assert.ok(!fs.existsSync(path.join(ws, '.skills', 'proj')), 'project store copy removed');

    const rescanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const proj = rescanned.find(candidate => candidate.name === 'proj');
    assert.strictEqual(proj.scope, 'user', 'moved skill is now global');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 migrateSkillsToCentral centralizes plain brand skills', () => {
    const home = makeTempDir('skills-migrate-');
    writeSkill(path.join(home, '.kimi/skills/plain/SKILL.md'), '---\nname: plain\ndescription: P\n---\n');
    const records = discovery.scanSkills({ homeDir: home });

    const report = migrateService.migrateSkillsToCentral(records, home, 'user');
    assert.strictEqual(report.ok, true);
    assert.ok(report.migrated.includes('plain'));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'plain', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(home, '.kimi', 'skills', 'plain')),
        'migration creates no agent links (linkBack: false); the winner moved out');
});

test('PERSIST-AI-SKILL-DISCOVERY-001 fixSkillDiagnostic repairs fixable diagnostics only', () => {
    const home = makeTempDir('skills-fix-');
    const record = overrides => ({
        name: 'demo', description: '', dirPath: path.join(home, '.kimi', 'skills', 'demo'),
        skillFilePath: path.join(home, '.kimi', 'skills', 'demo', 'SKILL.md'),
        scope: 'user', source: 'kimi', folder: '',
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {}, diagnostics: [], ...overrides,
    });

    const lower = path.join(home, '.kimi', 'skills', 'demo', 'skill.md');
    writeSkill(lower, '---\nname: demo\n---\nbody\n');
    assert.strictEqual(fixService.fixSkillDiagnostic(
        record({ skillFilePath: lower }), 'lowercase-filename').ok, true);
    assert.ok(fs.existsSync(path.join(home, '.kimi', 'skills', 'demo', 'SKILL.md')));
    assert.strictEqual(fixService.fixSkillDiagnostic(
        record({ skillFilePath: lower }), 'lowercase-filename').ok, false,
        'never overwrites an existing SKILL.md');

    const noName = path.join(home, '.kimi', 'skills', 'demo4', 'SKILL.md');
    writeSkill(noName, '---\ndescription: x\n---\nbody\n');
    assert.strictEqual(fixService.fixSkillDiagnostic(record({
        name: 'demo4',
        dirPath: path.join(home, '.kimi', 'skills', 'demo4'),
        skillFilePath: noName,
    }), 'missing-name').ok, true);
    assert.ok(fs.readFileSync(noName, 'utf8').startsWith('---\nname: demo4\ndescription: x\n---\n'));

    assert.strictEqual(fixService.fixSkillDiagnostic(record(), 'body-too-long').ok, false,
        'non-fixable diagnostics are refused');
});


test('PERSIST-AI-SKILL-DISCOVERY-001 discovers skills nested inside another skill directory', () => {
    const home = makeTempDir('skills-contract-nested-');
    writeSkill(path.join(home, '.skills/dms/dms-assistant/SKILL.md'), '---\nname: dms-assistant\ndescription: D\n---\n');
    writeSkill(path.join(home, '.skills/dms/dms-assistant/mysql/SKILL.md'), '---\nname: mysql\ndescription: M\n---\n');
    writeSkill(path.join(home, '.skills/dms/dms-assistant/scripts/helper.py'), '# helper\n');
    fs.mkdirSync(path.join(home, '.skills/dms/dms-assistant/references'), { recursive: true });

    const result = discovery.scanSkillsDetailed({ homeDir: home });
    const byName = new Map(result.records.map(record => [record.name, record]));
    assert.ok(byName.get('dms-assistant'), 'parent skill still discovered');
    assert.strictEqual(byName.get('dms-assistant').folder, 'dms');
    assert.ok(byName.get('mysql'), 'nested sub-skill is discovered');
    assert.strictEqual(byName.get('mysql').folder, 'dms/dms-assistant',
        'sub-skill nests under the parent skill folder');
    assert.ok(!result.storeFolders.user.includes('dms/dms-assistant/scripts')
        && !result.storeFolders.user.includes('dms/dms-assistant/references'),
        'helper dirs inside a skill never become folder nodes');
    assert.ok(!result.storeFolders.user.includes('dms/dms-assistant'),
        'a skill directory itself is not listed as an empty folder');
});
