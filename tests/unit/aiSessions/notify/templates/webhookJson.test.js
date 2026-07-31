'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildWebhookJsonRequest } = require('../../../../../out/aiSessions/notify/templates/webhookJson');

// ATTENTION-NOTIFY-TEMPLATE-WEBHOOK-001

const title = '⏸ Claude 在等你输入';
const body = '项目  p\n会话  s';

test('feishu 使用 msg_type text', () => {
    const request = buildWebhookJsonRequest(
        { id: 'a', channel: 'feishu', proxy: null, url: 'https://open.feishu.cn/hook' }, title, body);
    assert.equal(request.url, 'https://open.feishu.cn/hook');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { msg_type: 'text', content: { text: `${title}\n${body}` } });
});

test('wecom 使用 msgtype markdown', () => {
    const request = buildWebhookJsonRequest(
        { id: 'a', channel: 'wecom', proxy: null, url: 'https://qyapi.weixin.qq.com/hook' }, title, body);
    assert.deepEqual(JSON.parse(request.body), {
        msgtype: 'markdown', markdown: { content: `**${title}**\n${body}` },
    });
});

test('slack 使用 text', () => {
    const request = buildWebhookJsonRequest(
        { id: 'a', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/hook' }, title, body);
    assert.deepEqual(JSON.parse(request.body), { text: `${title}\n${body}` });
});

test('discord 使用 content', () => {
    const request = buildWebhookJsonRequest(
        { id: 'a', channel: 'discord', proxy: null, url: 'https://discord.com/api/webhooks/x' }, title, body);
    assert.deepEqual(JSON.parse(request.body), { content: `${title}\n${body}` });
});
