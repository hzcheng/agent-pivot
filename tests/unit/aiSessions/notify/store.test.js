'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { NotifiedEventStore } = require('../../../../out/aiSessions/notify/store');
const { makeTempDirectory } = require('../../../helpers/tempDirectory');

// ATTENTION-NOTIFY-STORE-001

test('记录后可查到', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const store = new NotifiedEventStore(path.join(dir, 'notified.json'));
    assert.equal(store.has('e1'), false);
    store.record('e1', 1000);
    assert.equal(store.has('e1'), true);
});

test('save 后可被新实例 load 读回', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const filePath = path.join(dir, 'notified.json');
    const first = new NotifiedEventStore(filePath);
    first.record('e1', 1000);
    first.save();

    const second = new NotifiedEventStore(filePath);
    second.load();
    assert.equal(second.has('e1'), true);
});

test('超出上限时淘汰最旧记录', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const store = new NotifiedEventStore(path.join(dir, 'notified.json'), 2);
    store.record('e1', 1);
    store.record('e2', 2);
    store.record('e3', 3);
    assert.equal(store.has('e1'), false);
    assert.equal(store.has('e2'), true);
    assert.equal(store.has('e3'), true);
});

test('文件不存在时 load 不抛异常', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const store = new NotifiedEventStore(path.join(dir, 'missing.json'));
    store.load();
    assert.equal(store.has('e1'), false);
});

test('文件内容损坏时 load 不抛异常且视为空', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const filePath = path.join(dir, 'notified.json');
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    const store = new NotifiedEventStore(filePath);
    store.load();
    assert.equal(store.has('e1'), false);
});

test('save 不留下临时文件', t => {
    const dir = makeTempDirectory(t, 'notify-store-');
    const store = new NotifiedEventStore(path.join(dir, 'notified.json'));
    store.record('e1', 1);
    store.save();
    assert.deepEqual(fs.readdirSync(dir), ['notified.json']);
});
