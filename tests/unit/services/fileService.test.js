'use strict';

// Covers the legacy FileService surface so the changed-coverage gate can
// instrument src/services/fileService.ts (previously absent from the report).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createFakeVscode } = require('../../helpers/fakeVscode');

function loadWithFakeVscode(modulePath) {
    const fakeVscode = createFakeVscode({
        workspace: { workspaceFolders: undefined },
    });
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') { return fakeVscode; }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require(modulePath);
    } finally {
        Module._load = previousLoad;
    }
}

const FileService = loadWithFakeVscode('../../../out/services/fileService').default;
const { ProjectPathType } = loadWithFakeVscode('../../../out/models');

function createService() {
    return new FileService({ globalState: undefined, workspaceState: undefined });
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'file-service-'));
}

test('FileService writes text files, creating a missing parent directory', async () => {
    const root = makeTempDir();
    try {
        const target = path.join(root, 'nested', 'note.txt');
        await createService().writeTextFile(target, 'hello');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');

        await assert.rejects(
            createService().writeTextFile(path.join(root, 'a', 'b', 'note.txt'), 'x'),
            /ENOENT/,
            'legacy behavior: mkdir is not recursive, so deeper chains reject',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('FileService removes files and reports path types', async () => {
    const root = makeTempDir();
    try {
        const service = createService();
        const folder = path.join(root, 'project');
        const file = path.join(root, 'notes.md');
        const workspaceFile = path.join(root, 'TEAM.code-workspace');
        fs.mkdirSync(folder);
        fs.writeFileSync(file, 'x');
        fs.writeFileSync(workspaceFile, '{}');

        assert.strictEqual(await service.getProjectPathType(folder), ProjectPathType.Folder);
        assert.strictEqual(await service.getProjectPathType(file), ProjectPathType.File);
        assert.strictEqual(await service.getProjectPathType(workspaceFile), ProjectPathType.WorkspaceFile,
            'workspace detection is case-insensitive');

        await service.removeFile(file);
        assert.strictEqual(fs.existsSync(file), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('FileService resolves workspace folders relative to the workspace file', async () => {
    const root = makeTempDir();
    try {
        const workspaceFile = path.join(root, 'team.code-workspace');
        fs.writeFileSync(workspaceFile, JSON.stringify({
            folders: [{ path: 'app' }, { path: 'libs/shared' }],
        }));
        assert.deepStrictEqual(
            await createService().getFoldersFromWorkspaceFile(workspaceFile),
            [path.join(root, 'app'), path.join(root, 'libs', 'shared')],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('FileService lists only directories and detects files by extension', async () => {
    const root = makeTempDir();
    try {
        fs.mkdirSync(path.join(root, 'alpha'));
        fs.mkdirSync(path.join(root, 'beta'));
        fs.writeFileSync(path.join(root, 'readme.md'), 'x');

        const folders = await createService().getFolders(root);
        assert.deepStrictEqual(folders.sort(), [path.join(root, 'alpha'), path.join(root, 'beta')].sort());

        const service = createService();
        assert.strictEqual(service.isFile('readme.md'), true);
        assert.strictEqual(service.isFile('alpha'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
