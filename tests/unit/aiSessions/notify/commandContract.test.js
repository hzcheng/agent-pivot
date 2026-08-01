'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// ATTENTION-NOTIFY-MANIFEST-001

const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'));
const properties = manifest.contributes.configuration.properties;

test('通知总开关默认关闭', () => {
    assert.equal(properties['agentPivot.notify.enabled'].default, false);
});

test('reasons 默认包含 completed 且不含 aborted', () => {
    const reasons = properties['agentPivot.notify.reasons'].default;
    assert.deepEqual(reasons.slice().sort(), ['completed', 'failed', 'input-required']);
});

test('最短运行时长默认 60 秒', () => {
    assert.equal(properties['agentPivot.notify.minRunDurationMs'].default, 60000);
});

test('项目路径默认只发 basename', () => {
    assert.equal(properties['agentPivot.notify.projectPathMode'].default, 'basename');
});

test('设置项中不存在任何存放凭据的字段', () => {
    const suspicious = Object.keys(properties).filter(key =>
        /token|secret|webhook|apikey/iu.test(key));
    assert.deepEqual(suspicious, []);
});

test('三个通知命令均已声明', () => {
    const ids = manifest.contributes.commands.map(command => command.command);
    for (const id of [
        'agentPivot.notify.setWebhook',
        'agentPivot.notify.sendTest',
        'agentPivot.notify.showOutput',
    ]) {
        assert.ok(ids.includes(id), `missing command ${id}`);
    }
});
