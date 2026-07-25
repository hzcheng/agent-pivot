'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const assets = [
    {
        name: 'Itachi',
        file: 'media/sharingan/mangekyou-sharingan-itachi.svg',
        sha256: '230f3a336593fd37e76b45f799ea9a131d8ccb55596f0c10786af3653bfd6545',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Itachi.svg',
    },
    {
        name: 'Obito and Kakashi',
        file: 'media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
        sha256: 'b79b7530aee85e94de533c4e37c1e62bda6b175e5febba68803e51e31b3563af',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Kakashi.svg',
    },
    {
        name: 'Sasuke',
        file: 'media/sharingan/mangekyou-sharingan-sasuke.svg',
        sha256: '89c58267e340231a6034efc2b6fdde03eb9a9534176dd619cb414736930aea52',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Sasuke.svg',
    },
    {
        name: 'Shisui',
        file: 'media/sharingan/mangekyou-sharingan-shisui.svg',
        sha256: '10c540d932e9546afaf07f8a59b117ffd3346cb89febe2a5a810bf2d33dff377',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Shisui.svg',
    },
    {
        name: 'Madara',
        file: 'media/sharingan/mangekyou-sharingan-madara.svg',
        sha256: '88f2e23d621ce3170514afbe38491bdcff289e988d15664d67574bf2575b36e7',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara.svg',
    },
    {
        name: 'Madara Eternal',
        file: 'media/sharingan/mangekyou-sharingan-madara-eternal.svg',
        sha256: '2afd4d1ffa8f32b61eb9a2060ec75dfd262b4abfe26edf7f57f3ec7973292d3c',
        source: 'https://commons.wikimedia.org/wiki/File:Mangekyou_Sharingan_Madara_(Eternal).svg',
    },
];

test('SHARINGAN-ASSET-INTEGRITY-002 retains the default text rule and scopes the SVG exception', () => {
    const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
    assert.match(attributes, /^\* text=auto$/m);
    assert.match(
        attributes,
        /^media\/sharingan\/\*\.svg -text whitespace=cr-at-eol$/m
    );
});

for (const asset of assets) {
    test(`SHARINGAN-ASSET-INTEGRITY-001 preserves the reviewed ${asset.name} SVG`, () => {
        const bytes = fs.readFileSync(path.join(root, asset.file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
        assert.match(bytes.toString('utf8'), /<svg[\s>]/);
    });
}

test('SHARINGAN-ASSET-ATTRIBUTION-001 attributes every bundled SVG', () => {
    const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notice, /Creative Commons Attribution-ShareAlike 3\.0/);
    assert.match(notice, /ShounenSuki/);
    for (const asset of assets) {
        assert.ok(notice.includes(asset.file), `missing bundled path ${asset.file}`);
        assert.ok(notice.includes(asset.source), `missing source ${asset.source}`);
    }
});
