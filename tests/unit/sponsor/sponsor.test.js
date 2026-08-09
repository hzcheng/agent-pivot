'use strict';

// WEBVIEW-SPONSOR-ENTRY-001
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const sponsorPath = path.resolve(__dirname, '../../../out/sponsor.js');

function loadSponsor(vscode) {
    const previousLoad = Module._load;
    delete require.cache[sponsorPath];
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    try {
        return require(sponsorPath);
    } finally {
        Module._load = previousLoad;
    }
}

function createVscodeFixture(pickIndex = 0) {
    const registered = [];
    const opened = [];
    const picks = [];
    const vscode = {
        commands: {
            registerCommand: (command, callback) => {
                registered.push([command, callback]);
                return { dispose: () => undefined };
            },
        },
        window: {
            showQuickPick: async (items, options) => {
                picks.push({ items, options });
                return pickIndex === null ? undefined : items[pickIndex];
            },
        },
        env: {
            openExternal: async uri => {
                opened.push(uri);
                return true;
            },
        },
        Uri: {
            parse: value => ({ value, toString: () => value }),
        },
    };
    return { opened, picks, registered, vscode };
}

test('WEBVIEW-SPONSOR-ENTRY-001 registers the sponsor command exactly once', () => {
    const fixture = createVscodeFixture();
    const sponsor = loadSponsor(fixture.vscode);
    const disposable = sponsor.registerSponsorCommand();
    assert.equal(typeof disposable.dispose, 'function');
    assert.deepEqual(
        fixture.registered.map(([command]) => command),
        [sponsor.SPONSOR_COMMAND_ID]
    );
    assert.equal(sponsor.SPONSOR_COMMAND_ID, 'agentPivot.sponsor');
});

test('WEBVIEW-SPONSOR-ENTRY-001 picking Ko-fi opens the Ko-fi page', async () => {
    const fixture = createVscodeFixture(0);
    const sponsor = loadSponsor(fixture.vscode);
    sponsor.registerSponsorCommand();
    await fixture.registered[0][1]();
    assert.equal(fixture.picks.length, 1);
    assert.deepEqual(
        fixture.picks[0].items.map(item => item.link.id),
        sponsor.SPONSOR_LINKS.map(link => link.id)
    );
    assert.deepEqual(
        fixture.opened.map(uri => uri.value),
        ['https://ko-fi.com/hongzecheng']
    );
});

test('WEBVIEW-SPONSOR-ENTRY-001 picking Afdian opens the Afdian page', async () => {
    const fixture = createVscodeFixture(1);
    const sponsor = loadSponsor(fixture.vscode);
    sponsor.registerSponsorCommand();
    await fixture.registered[0][1]();
    assert.deepEqual(
        fixture.opened.map(uri => uri.value),
        ['https://afdian.com/a/YOUR_AFDIAN_ID']
    );
});

test('WEBVIEW-SPONSOR-ENTRY-001 dismissing the picker opens nothing', async () => {
    const fixture = createVscodeFixture(null);
    const sponsor = loadSponsor(fixture.vscode);
    sponsor.registerSponsorCommand();
    await fixture.registered[0][1]();
    assert.deepEqual(fixture.opened, []);
});

test('WEBVIEW-SPONSOR-ENTRY-001 sponsor links stay in sync with .github/FUNDING.yml', () => {
    const funding = fs.readFileSync(
        path.resolve(__dirname, '../../../.github/FUNDING.yml'), 'utf8'
    );
    const sponsor = loadSponsor(createVscodeFixture().vscode);
    for (const link of sponsor.SPONSOR_LINKS) {
        if (link.id === 'ko-fi') {
            assert.ok(
                funding.includes(`ko_fi: ${link.url.split('/').pop()}`),
                `FUNDING.yml must carry the Ko-fi username from ${link.url}`
            );
        } else {
            assert.ok(
                funding.includes(link.url),
                `FUNDING.yml must carry the custom sponsorship URL ${link.url}`
            );
        }
    }
});
