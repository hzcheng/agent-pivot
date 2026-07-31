# AI 会话停止通知(进程内模式)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 AI 会话停下来等待用户时,通过 IM / 手机推送通知用户(VS Code 运行期间生效)。

**Architecture:** 在 `attentionController.evaluate()` 产生 attention 事件后挂一个 fire-and-forget 的外发 sink。检测逻辑完全复用现有 `lifecycle.ts` / `attentionMonitor.ts`,不新写。所有新模块放在 `src/aiSessions/notify/`,该目录零 `vscode` 依赖,以便后续计划 B 的守护进程原样复用。

**Tech Stack:** TypeScript(`tsc -p ./` → `out/`)、Node 内置 `https` / `crypto`、`node:test` 测试运行器、CommonJS。

## Global Constraints

以下约束适用于本计划的每一个任务:

- **`src/aiSessions/notify/` 下的任何文件禁止 `import * as vscode` 或 `require('vscode')`。** 这是计划 B 复用同一份代码的前提。需要 vscode API 的代码放 `src/aiSessions/notifyIntegration/`。
- 源码风格:文件首行 `'use strict';`,4 空格缩进,与 `src/aiSessions/attentionAggregate.ts` 保持一致。
- 校验函数沿用现有 `exactKeys()` 风格(见 `src/aiSessions/attentionAggregate.ts:37`),字段白名单精确匹配,校验失败抛 `Error`,不做部分容错。
- 测试用 `node:test` + `node:assert/strict`,**写成 `.js` 文件**放在 `tests/unit/aiSessions/notify/`,从 `../../../../out/aiSessions/notify/xxx` require 编译产物。
- **每个测试文件顶部必须有一行行为 ID 注释**(格式见 `tests/unit/aiSessions/commandBuilders.test.js:9` 的 `// SESSION-COMMAND-BUILDER-001`),且该 ID 必须登记进 `docs/testing/behavior-contracts.json`。
- 运行测试前必须先 `npm run test-compile`。
- 不引入任何新的 npm 运行时依赖。只用 Node 内置模块。
- **消息内容只含元数据**:项目名、会话名、provider、reason、时长、主机名、correlation id。禁止包含会话正文、代码片段、完整文件路径。
- 通知功能总开关 `agentPivot.notify.enabled` 默认 `false`。
- Node.js 22.12 或更新版本。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/aiSessions/notify/eventIdentity.ts` | eventId 生成(从 `attentionMonitor.ts` 抽出,两处共用) |
| `src/aiSessions/notify/types.ts` | sink 判别式联合、policy、payload 的类型与校验 |
| `src/aiSessions/notify/correlation.ts` | eventId → 6 位 base32 短码 |
| `src/aiSessions/notify/policy.ts` | 纯函数:是否发送的四道闸门 |
| `src/aiSessions/notify/templates/*.ts` | 9 个通道各自的请求构造(每通道一文件) |
| `src/aiSessions/notify/templates/index.ts` | 通道分发 |
| `src/aiSessions/notify/message.ts` | payload → 人类可读的标题与正文 |
| `src/aiSessions/notify/httpClient.ts` | `https.request` 封装 + 代理 + 重试 |
| `src/aiSessions/notify/dispatcher.ts` | 队列 · 防抖 · 幂等 · 限流 |
| `src/aiSessions/notify/store.ts` | `notified.json` / `channels.json` 读写与校验 |
| `src/aiSessions/notifyIntegration/notifier.ts` | 扩展侧组装 payload 并调用 dispatcher |
| `src/aiSessions/notifyIntegration/credentials.ts` | SecretStorage ↔ `channels.json` |
| `src/aiSessions/notifyIntegration/commands.ts` | 三个命令 |
| `src/aiSessions/notifyIntegration/output.ts` | 专用 Output Channel |

templates 按通道拆文件,因为每个通道的鉴权与 body 形态互不相同,同一文件里放
9 份会让任何一处修改都要重读全部。

---

### Task 1: 抽出 eventId 生成(纯重构)

计划 B 的守护进程必须算出与扩展**逐字节相同**的 eventId,否则用户点掉红点后
仍会收到推送。先把算法抽成可共享的纯函数,行为不得有任何变化。

**Files:**
- Create: `src/aiSessions/notify/eventIdentity.ts`
- Modify: `src/aiSessions/attentionMonitor.ts:81-87`
- Test: `tests/unit/aiSessions/notify/eventIdentity.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createAttentionEventId(eventKey: string, reason: string, signalToken: string): string`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aiSessions/notify/eventIdentity.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createAttentionEventId } = require('../../../../out/aiSessions/notify/eventIdentity');

// ATTENTION-NOTIFY-EVENT-IDENTITY-001

test('event id 由 eventKey、reason 与 token 的 sha256 拼成', () => {
    const token = 'claude:end_turn:1753948800000:uuid-1';
    const expected = `claude:018f:completed:${crypto.createHash('sha256').update(token).digest('hex')}`;
    assert.equal(createAttentionEventId('claude:018f', 'completed', token), expected);
});

test('token 不同则 event id 不同', () => {
    const left = createAttentionEventId('claude:018f', 'completed', 'a');
    const right = createAttentionEventId('claude:018f', 'completed', 'b');
    assert.notEqual(left, right);
});

test('相同输入始终产生相同 event id', () => {
    const first = createAttentionEventId('codex:7', 'input-required', 'codex:request_user_input:1:call-9');
    const second = createAttentionEventId('codex:7', 'input-required', 'codex:request_user_input:1:call-9');
    assert.equal(first, second);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/eventIdentity.test.js
```

预期:失败,`Cannot find module '.../out/aiSessions/notify/eventIdentity'`。

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/eventIdentity.ts`:

```ts
'use strict';

import * as crypto from 'crypto';

export function createAttentionEventId(eventKey: string, reason: string, signalToken: string): string {
    return `${eventKey}:${reason}:${crypto.createHash('sha256').update(signalToken).digest('hex')}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/eventIdentity.test.js
```

预期:3 个测试全部 PASS。

- [ ] **Step 5: 改 attentionMonitor 调用它**

`src/aiSessions/attentionMonitor.ts` 顶部 import 区加一行:

```ts
import { createAttentionEventId } from './notify/eventIdentity';
```

把 `:81-87` 的 event 构造改为:

```ts
            const event: AiSessionAttentionEvent = {
                eventId: createAttentionEventId(input.eventKey || input.key, signal.reason, signal.token),
                key: input.key,
                reason: signal.reason,
                generation: entry.generation,
                detectedAt: now,
            };
```

顶部若因此不再使用 `crypto`,删除该 import。

- [ ] **Step 6: 运行既有 attention 测试确认行为零变化**

```bash
npm run test-compile
node --test tests/unit/aiSessions/
node --test --test-concurrency=1 tests/contract/aiSessions/attention.test.js
```

预期:全部 PASS。**任何一条失败都说明重构改变了行为,必须回退重做,不得修改
既有测试的期望值。**

- [ ] **Step 7: 登记行为契约**

在 `docs/testing/behavior-contracts.json` 数组中追加:

```json
  {
    "id": "ATTENTION-NOTIFY-EVENT-IDENTITY-001",
    "domain": "attention",
    "title": "Attention event id generation is shared and stable",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/eventIdentity.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/eventIdentity.ts",
      "src/aiSessions/attentionMonitor.ts"
    ]
  }
```

- [ ] **Step 8: 验证契约门禁**

```bash
npm run test:behavior-contracts
```

预期:PASS。

- [ ] **Step 9: 提交**

```bash
git add src/aiSessions/notify/eventIdentity.ts src/aiSessions/attentionMonitor.ts \
        tests/unit/aiSessions/notify/eventIdentity.test.js docs/testing/behavior-contracts.json
git commit -m "refactor: extract attention event id generation"
```

---

### Task 2: 通知类型与校验

**Files:**
- Create: `src/aiSessions/notify/types.ts`
- Test: `tests/unit/aiSessions/notify/types.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type NotifyChannel = 'ntfy' | 'telegram' | 'bark' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'discord' | 'custom'`
  - `type NotifySink`(按 `channel` 判别的联合)
  - `interface NotifyPolicy { reasons; minRunDurationMs; debounceMs; rateLimitPerMin; escalateAfterMs }`
  - `interface NotifyPayload { eventId; correlationId; providerId; reason; projectLabel; sessionLabel; hostLabel; runStartedAtMs; occurredAtMs }`
  - `validateNotifyConfig(value: unknown): NotifyConfig`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aiSessions/notify/types.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateNotifyConfig } = require('../../../../out/aiSessions/notify/types');

// ATTENTION-NOTIFY-CONFIG-VALIDATION-001

function baseConfig(sinks) {
    return {
        schemaVersion: 1,
        enabled: true,
        sinks,
        policy: {
            reasons: ['completed', 'input-required', 'failed'],
            minRunDurationMs: 60000,
            debounceMs: 5000,
            rateLimitPerMin: 6,
            escalateAfterMs: null,
        },
        redaction: { projectPathMode: 'basename', includeSessionLabel: true },
    };
}

test('接受合法的 ntfy sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', topic: 'abc', token: null, priority: 4, proxy: null },
    ]));
    assert.equal(config.sinks[0].channel, 'ntfy');
    assert.equal(config.sinks[0].topic, 'abc');
});

test('接受合法的 telegram sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's2', channel: 'telegram', botToken: 't', chatId: '123', proxy: null },
    ]));
    assert.equal(config.sinks[0].botToken, 't');
});

test('telegram sink 缺 chatId 时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's2', channel: 'telegram', botToken: 't', proxy: null },
    ])), /telegram sink/u);
});

test('ntfy sink 混入 telegram 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', topic: 'abc', token: null,
          priority: 4, proxy: null, botToken: 'x' },
    ])), /ntfy sink/u);
});

test('未知 channel 拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's9', channel: 'sms', url: 'https://x' },
    ])), /channel/u);
});

test('reasons 含 aborted 时拒绝', () => {
    const config = baseConfig([]);
    config.policy.reasons = ['aborted'];
    assert.throws(() => validateNotifyConfig(config), /reasons/u);
});

test('schemaVersion 不为 1 时拒绝', () => {
    const config = baseConfig([]);
    config.schemaVersion = 2;
    assert.throws(() => validateNotifyConfig(config), /schemaVersion/u);
});

test('多余的顶层字段被拒绝', () => {
    const config = baseConfig([]);
    config.extra = true;
    assert.throws(() => validateNotifyConfig(config), /notify config/u);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/types.test.js
```

预期:模块不存在,失败。

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/types.ts`:

```ts
'use strict';

export type NotifyChannel = 'ntfy' | 'telegram' | 'bark' | 'feishu'
    | 'dingtalk' | 'wecom' | 'slack' | 'discord' | 'custom';

export type NotifyReason = 'completed' | 'input-required' | 'failed';

export interface NotifySinkBase {
    id: string;
    channel: NotifyChannel;
    proxy: string | null;
}

export interface NtfySink extends NotifySinkBase {
    channel: 'ntfy';
    baseUrl: string;
    topic: string;
    token: string | null;
    priority: number;
}

export interface TelegramSink extends NotifySinkBase {
    channel: 'telegram';
    botToken: string;
    chatId: string;
}

export interface BarkSink extends NotifySinkBase {
    channel: 'bark';
    serverUrl: string;
    deviceKey: string;
}

export interface WebhookSink extends NotifySinkBase {
    channel: 'feishu' | 'wecom' | 'slack' | 'discord';
    url: string;
}

export interface DingtalkSink extends NotifySinkBase {
    channel: 'dingtalk';
    url: string;
    secret: string;
}

export interface CustomSink extends NotifySinkBase {
    channel: 'custom';
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyTemplate: string;
}

export type NotifySink = NtfySink | TelegramSink | BarkSink | WebhookSink
    | DingtalkSink | CustomSink;

export interface NotifyPolicy {
    reasons: NotifyReason[];
    minRunDurationMs: number;
    debounceMs: number;
    rateLimitPerMin: number;
    escalateAfterMs: number | null;
}

export interface NotifyRedaction {
    projectPathMode: 'basename' | 'full';
    includeSessionLabel: boolean;
}

export interface NotifyConfig {
    schemaVersion: 1;
    enabled: boolean;
    sinks: NotifySink[];
    policy: NotifyPolicy;
    redaction: NotifyRedaction;
}

export interface NotifyPayload {
    eventId: string;
    correlationId: string;
    providerId: string;
    reason: NotifyReason;
    projectLabel: string;
    sessionLabel: string;
    hostLabel: string;
    runStartedAtMs: number;
    occurredAtMs: number;
}

const MAX_STRING = 1024;
const REASONS: NotifyReason[] = ['completed', 'input-required', 'failed'];

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
    if (Object.keys(value).sort().join('\n') !== expected.slice().sort().join('\n')) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value || value.length > MAX_STRING) {
        throw new Error(`${label} must be a non-empty bounded string`);
    }
    return value;
}

function requireNullableString(value: unknown, label: string): string | null {
    return value === null ? null : requireString(value, label);
}

function requireNumber(value: unknown, label: string, min: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
        throw new Error(`${label} must be a finite number >= ${min}`);
    }
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean`);
    }
    return value;
}

function validateSink(value: unknown): NotifySink {
    const sink = requireObject(value, 'notify sink');
    const id = requireString(sink.id, 'notify sink id');
    const proxy = requireNullableString(sink.proxy === undefined ? null : sink.proxy, 'notify sink proxy');
    switch (sink.channel) {
        case 'ntfy':
            exactKeys(sink, ['id', 'channel', 'proxy', 'baseUrl', 'topic', 'token', 'priority'], 'ntfy sink');
            return {
                id, channel: 'ntfy', proxy,
                baseUrl: requireString(sink.baseUrl, 'ntfy sink baseUrl'),
                topic: requireString(sink.topic, 'ntfy sink topic'),
                token: requireNullableString(sink.token, 'ntfy sink token'),
                priority: requireNumber(sink.priority, 'ntfy sink priority', 1),
            };
        case 'telegram':
            exactKeys(sink, ['id', 'channel', 'proxy', 'botToken', 'chatId'], 'telegram sink');
            return {
                id, channel: 'telegram', proxy,
                botToken: requireString(sink.botToken, 'telegram sink botToken'),
                chatId: requireString(sink.chatId, 'telegram sink chatId'),
            };
        case 'bark':
            exactKeys(sink, ['id', 'channel', 'proxy', 'serverUrl', 'deviceKey'], 'bark sink');
            return {
                id, channel: 'bark', proxy,
                serverUrl: requireString(sink.serverUrl, 'bark sink serverUrl'),
                deviceKey: requireString(sink.deviceKey, 'bark sink deviceKey'),
            };
        case 'feishu':
        case 'wecom':
        case 'slack':
        case 'discord':
            exactKeys(sink, ['id', 'channel', 'proxy', 'url'], `${sink.channel} sink`);
            return {
                id, channel: sink.channel, proxy,
                url: requireString(sink.url, `${sink.channel} sink url`),
            };
        case 'dingtalk':
            exactKeys(sink, ['id', 'channel', 'proxy', 'url', 'secret'], 'dingtalk sink');
            return {
                id, channel: 'dingtalk', proxy,
                url: requireString(sink.url, 'dingtalk sink url'),
                secret: requireString(sink.secret, 'dingtalk sink secret'),
            };
        case 'custom': {
            exactKeys(sink, ['id', 'channel', 'proxy', 'url', 'method', 'headers', 'bodyTemplate'], 'custom sink');
            const headers = requireObject(sink.headers, 'custom sink headers');
            for (const [key, headerValue] of Object.entries(headers)) {
                requireString(headerValue, `custom sink header ${key}`);
            }
            return {
                id, channel: 'custom', proxy,
                url: requireString(sink.url, 'custom sink url'),
                method: requireString(sink.method, 'custom sink method'),
                headers: headers as Record<string, string>,
                bodyTemplate: requireString(sink.bodyTemplate, 'custom sink bodyTemplate'),
            };
        }
        default:
            throw new Error('notify sink channel is unsupported');
    }
}

function validatePolicy(value: unknown): NotifyPolicy {
    const policy = requireObject(value, 'notify policy');
    exactKeys(policy, ['reasons', 'minRunDurationMs', 'debounceMs', 'rateLimitPerMin', 'escalateAfterMs'], 'notify policy');
    if (!Array.isArray(policy.reasons) || !policy.reasons.length
        || policy.reasons.some(reason => !REASONS.includes(reason as NotifyReason))) {
        throw new Error('notify policy reasons are invalid');
    }
    return {
        reasons: Array.from(new Set(policy.reasons as NotifyReason[])).sort(),
        minRunDurationMs: requireNumber(policy.minRunDurationMs, 'notify policy minRunDurationMs', 0),
        debounceMs: requireNumber(policy.debounceMs, 'notify policy debounceMs', 0),
        rateLimitPerMin: requireNumber(policy.rateLimitPerMin, 'notify policy rateLimitPerMin', 1),
        escalateAfterMs: policy.escalateAfterMs === null
            ? null
            : requireNumber(policy.escalateAfterMs, 'notify policy escalateAfterMs', 1),
    };
}

export function validateNotifyConfig(value: unknown): NotifyConfig {
    const record = requireObject(value, 'notify config');
    exactKeys(record, ['schemaVersion', 'enabled', 'sinks', 'policy', 'redaction'], 'notify config');
    if (record.schemaVersion !== 1) {
        throw new Error('notify config schemaVersion is incompatible');
    }
    if (!Array.isArray(record.sinks) || record.sinks.length > 32) {
        throw new Error('notify config sinks are invalid');
    }
    const redaction = requireObject(record.redaction, 'notify redaction');
    exactKeys(redaction, ['projectPathMode', 'includeSessionLabel'], 'notify redaction');
    if (redaction.projectPathMode !== 'basename' && redaction.projectPathMode !== 'full') {
        throw new Error('notify redaction projectPathMode is invalid');
    }
    return {
        schemaVersion: 1,
        enabled: requireBoolean(record.enabled, 'notify config enabled'),
        sinks: record.sinks.map(validateSink),
        policy: validatePolicy(record.policy),
        redaction: {
            projectPathMode: redaction.projectPathMode,
            includeSessionLabel: requireBoolean(redaction.includeSessionLabel, 'notify redaction includeSessionLabel'),
        },
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/types.test.js
```

预期:8 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约**

追加到 `docs/testing/behavior-contracts.json`:

```json
  {
    "id": "ATTENTION-NOTIFY-CONFIG-VALIDATION-001",
    "domain": "attention",
    "title": "Notification channel configuration is validated per channel",
    "priority": "P1",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/types.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/types.ts"
    ]
  }
```

- [ ] **Step 6: 提交**

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/types.ts tests/unit/aiSessions/notify/types.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification config types and validation"
```

---

### Task 3: correlation id

**Files:**
- Create: `src/aiSessions/notify/correlation.ts`
- Test: `tests/unit/aiSessions/notify/correlation.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createCorrelationId(eventId: string): string`(6 位大写 base32)

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCorrelationId } = require('../../../../out/aiSessions/notify/correlation');

// ATTENTION-NOTIFY-CORRELATION-001

test('产生 6 位 base32 短码', () => {
    const id = createCorrelationId('claude:018f:completed:abcdef');
    assert.match(id, /^[A-Z2-7]{6}$/u);
});

test('同一 eventId 始终产生同一短码', () => {
    const eventId = 'claude:018f:completed:abcdef';
    assert.equal(createCorrelationId(eventId), createCorrelationId(eventId));
});

test('不同 eventId 产生不同短码', () => {
    assert.notEqual(createCorrelationId('a'), createCorrelationId('b'));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/correlation.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/correlation.ts`:

```ts
'use strict';

import * as crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createCorrelationId(eventId: string): string {
    const digest = crypto.createHash('sha256').update(eventId).digest();
    let result = '';
    for (let index = 0; index < 6; index += 1) {
        result += ALPHABET[digest[index] % ALPHABET.length];
    }
    return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/correlation.test.js
```

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-CORRELATION-001",
    "domain": "attention",
    "title": "Notifications carry a stable short correlation id",
    "priority": "P2",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/correlation.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/correlation.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/correlation.ts tests/unit/aiSessions/notify/correlation.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification correlation id"
```

---

### Task 4: 发送决策(四道闸门)

**Files:**
- Create: `src/aiSessions/notify/policy.ts`
- Test: `tests/unit/aiSessions/notify/policy.test.js`

**Interfaces:**
- Consumes: `NotifyPolicy`, `NotifyPayload`(Task 2)
- Produces:
  - `type PolicyDecision = { action: 'send' } | { action: 'skip'; reason: string } | { action: 'merge' }`
  - `evaluateNotifyPolicy(payload: NotifyPayload, policy: NotifyPolicy, context: PolicyContext): PolicyDecision`
  - `interface PolicyContext { alreadyNotified: boolean; acknowledged: boolean; sentWithinLastMinute: number }`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateNotifyPolicy } = require('../../../../out/aiSessions/notify/policy');

// ATTENTION-NOTIFY-POLICY-001

const policy = {
    reasons: ['completed', 'failed', 'input-required'],
    minRunDurationMs: 60000,
    debounceMs: 5000,
    rateLimitPerMin: 6,
    escalateAfterMs: null,
};

function payload(overrides) {
    return Object.assign({
        eventId: 'e1',
        correlationId: 'ABC234',
        providerId: 'claude',
        reason: 'completed',
        projectLabel: 'p',
        sessionLabel: 's',
        hostLabel: 'h',
        runStartedAtMs: 0,
        occurredAtMs: 120000,
    }, overrides);
}

const clean = { alreadyNotified: false, acknowledged: false, sentWithinLastMinute: 0 };

test('满足全部条件时发送', () => {
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, clean), { action: 'send' });
});

test('reason 不在列表中时跳过', () => {
    const narrow = Object.assign({}, policy, { reasons: ['failed'] });
    assert.deepEqual(evaluateNotifyPolicy(payload(), narrow, clean), { action: 'skip', reason: 'reason-filtered' });
});

test('运行时长不足时跳过', () => {
    const short = payload({ runStartedAtMs: 100000, occurredAtMs: 120000 });
    assert.deepEqual(evaluateNotifyPolicy(short, policy, clean), { action: 'skip', reason: 'too-short' });
});

test('运行时长恰好等于阈值时发送', () => {
    const exact = payload({ runStartedAtMs: 0, occurredAtMs: 60000 });
    assert.deepEqual(evaluateNotifyPolicy(exact, policy, clean), { action: 'send' });
});

test('已发送过时跳过', () => {
    const context = Object.assign({}, clean, { alreadyNotified: true });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'already-notified' });
});

test('已被确认时跳过', () => {
    const context = Object.assign({}, clean, { acknowledged: true });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'acknowledged' });
});

test('达到限流上限时合并', () => {
    const context = Object.assign({}, clean, { sentWithinLastMinute: 6 });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'merge' });
});

test('确认优先于限流', () => {
    const context = { alreadyNotified: false, acknowledged: true, sentWithinLastMinute: 99 };
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'acknowledged' });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/policy.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/policy.ts`:

```ts
'use strict';

import type { NotifyPayload, NotifyPolicy } from './types';

export type PolicyDecision =
    | { action: 'send' }
    | { action: 'skip'; reason: string }
    | { action: 'merge' };

export interface PolicyContext {
    alreadyNotified: boolean;
    acknowledged: boolean;
    sentWithinLastMinute: number;
}

export function evaluateNotifyPolicy(
    payload: NotifyPayload,
    policy: NotifyPolicy,
    context: PolicyContext
): PolicyDecision {
    if (context.acknowledged) {
        return { action: 'skip', reason: 'acknowledged' };
    }
    if (context.alreadyNotified) {
        return { action: 'skip', reason: 'already-notified' };
    }
    if (!policy.reasons.includes(payload.reason)) {
        return { action: 'skip', reason: 'reason-filtered' };
    }
    if (payload.occurredAtMs - payload.runStartedAtMs < policy.minRunDurationMs) {
        return { action: 'skip', reason: 'too-short' };
    }
    if (context.sentWithinLastMinute >= policy.rateLimitPerMin) {
        return { action: 'merge' };
    }
    return { action: 'send' };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/policy.test.js
```

预期:8 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-POLICY-001",
    "domain": "attention",
    "title": "Notification policy gates reason, duration, dedup and rate limit",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/policy.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/policy.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/policy.ts tests/unit/aiSessions/notify/policy.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification send policy"
```

---

### Task 5: 消息文案

**Files:**
- Create: `src/aiSessions/notify/message.ts`
- Test: `tests/unit/aiSessions/notify/message.test.js`

**Interfaces:**
- Consumes: `NotifyPayload`(Task 2)
- Produces:
  - `renderNotifyTitle(payload: NotifyPayload): string`
  - `renderNotifyBody(payload: NotifyPayload): string`
  - `renderMergedTitle(count: number): string`
  - `renderMergedBody(payloads: NotifyPayload[]): string`
  - `notifyPriority(reason: NotifyReason): number`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    renderNotifyTitle, renderNotifyBody, renderMergedTitle, renderMergedBody, notifyPriority,
} = require('../../../../out/aiSessions/notify/message');

// ATTENTION-NOTIFY-MESSAGE-001

const payload = {
    eventId: 'e1',
    correlationId: 'K7M2QX',
    providerId: 'claude',
    reason: 'input-required',
    projectLabel: 'vscode-dashboard',
    sessionLabel: 'fix/attention-notify',
    hostLabel: 'dev-server-03',
    runStartedAtMs: 0,
    occurredAtMs: 720000,
};

test('标题含 provider 与状态', () => {
    assert.equal(renderNotifyTitle(payload), '⏸ Claude 在等你输入');
});

test('completed 的标题不同于 input-required', () => {
    const done = Object.assign({}, payload, { reason: 'completed' });
    assert.equal(renderNotifyTitle(done), '✅ Claude 已完成');
});

test('failed 的标题不同', () => {
    const failed = Object.assign({}, payload, { reason: 'failed' });
    assert.equal(renderNotifyTitle(failed), '⚠️ Claude 执行失败');
});

test('正文含项目、会话、时长、主机与短码', () => {
    const body = renderNotifyBody(payload);
    assert.match(body, /项目\s+vscode-dashboard/u);
    assert.match(body, /会话\s+fix\/attention-notify/u);
    assert.match(body, /已运行 12 分钟/u);
    assert.match(body, /主机\s+dev-server-03/u);
    assert.match(body, /#K7M2QX/u);
});

test('正文不含任何路径分隔符开头的绝对路径', () => {
    assert.doesNotMatch(renderNotifyBody(payload), /\s\/[A-Za-z]/u);
});

test('合并标题含数量', () => {
    assert.equal(renderMergedTitle(3), '⏸ 3 个 AI 会话在等你');
});

test('合并正文每行一个会话', () => {
    const lines = renderMergedBody([payload, Object.assign({}, payload, {
        providerId: 'codex', projectLabel: 'api-gateway', reason: 'failed',
    })]).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Claude \/ vscode-dashboard/u);
    assert.match(lines[1], /Codex \/ api-gateway/u);
});

test('priority 按 reason 区分', () => {
    assert.equal(notifyPriority('input-required'), 4);
    assert.equal(notifyPriority('failed'), 4);
    assert.equal(notifyPriority('completed'), 3);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/message.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/message.ts`:

```ts
'use strict';

import type { NotifyPayload, NotifyReason } from './types';

const PROVIDER_LABELS: Record<string, string> = {
    claude: 'Claude',
    codex: 'Codex',
    kimi: 'Kimi',
};

const REASON_TITLES: Record<NotifyReason, string> = {
    'input-required': '⏸ {provider} 在等你输入',
    completed: '✅ {provider} 已完成',
    failed: '⚠️ {provider} 执行失败',
};

const REASON_TEXT: Record<NotifyReason, string> = {
    'input-required': '需要输入',
    completed: '已完成',
    failed: '执行失败',
};

function providerLabel(providerId: string): string {
    return PROVIDER_LABELS[providerId] || providerId;
}

function durationText(payload: NotifyPayload): string {
    const minutes = Math.floor((payload.occurredAtMs - payload.runStartedAtMs) / 60000);
    return minutes >= 1 ? `已运行 ${minutes} 分钟` : '运行不足 1 分钟';
}

export function renderNotifyTitle(payload: NotifyPayload): string {
    return REASON_TITLES[payload.reason].replace('{provider}', providerLabel(payload.providerId));
}

export function renderNotifyBody(payload: NotifyPayload): string {
    const lines = [
        `项目  ${payload.projectLabel}`,
        `会话  ${payload.sessionLabel}`,
        `原因  ${REASON_TEXT[payload.reason]} · ${durationText(payload)}`,
        `主机  ${payload.hostLabel}`,
        `ID    #${payload.correlationId}`,
    ];
    return lines.join('\n');
}

export function renderMergedTitle(count: number): string {
    return `⏸ ${count} 个 AI 会话在等你`;
}

export function renderMergedBody(payloads: NotifyPayload[]): string {
    return payloads
        .map(payload => `· ${providerLabel(payload.providerId)} / ${payload.projectLabel} —— ${REASON_TEXT[payload.reason]}`)
        .join('\n');
}

export function notifyPriority(reason: NotifyReason): number {
    return reason === 'completed' ? 3 : 4;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/message.test.js
```

预期:8 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-MESSAGE-001",
    "domain": "attention",
    "title": "Notification text carries metadata only",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/message.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/message.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/message.ts tests/unit/aiSessions/notify/message.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification message rendering"
```

---

### Task 6: 通道模板 —— JSON body 类(feishu / wecom / slack / discord)

四个通道共同点:单个 URL、无签名、POST 一个 JSON。放在一个任务里,因为它们
的实现与测试完全同构,拆开只会重复样板。

**Files:**
- Create: `src/aiSessions/notify/templates/webhookJson.ts`
- Create: `src/aiSessions/notify/templates/types.ts`
- Test: `tests/unit/aiSessions/notify/templates/webhookJson.test.js`

**Interfaces:**
- Consumes: `NotifySink`, `NotifyPayload`(Task 2);`renderNotifyTitle` / `renderNotifyBody`(Task 5)
- Produces:
  - `interface NotifyRequest { url: string; method: string; headers: Record<string, string>; body: string }`
  - `buildWebhookJsonRequest(sink: WebhookSink, title: string, body: string): NotifyRequest`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/webhookJson.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/templates/types.ts`:

```ts
'use strict';

export interface NotifyRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}
```

创建 `src/aiSessions/notify/templates/webhookJson.ts`:

```ts
'use strict';

import type { WebhookSink } from '../types';
import type { NotifyRequest } from './types';

export function buildWebhookJsonRequest(sink: WebhookSink, title: string, body: string): NotifyRequest {
    const text = `${title}\n${body}`;
    let payload: unknown;
    switch (sink.channel) {
        case 'feishu':
            payload = { msg_type: 'text', content: { text } };
            break;
        case 'wecom':
            payload = { msgtype: 'markdown', markdown: { content: `**${title}**\n${body}` } };
            break;
        case 'slack':
            payload = { text };
            break;
        case 'discord':
            payload = { content: text };
            break;
        default:
            throw new Error('webhook json sink channel is unsupported');
    }
    return {
        url: sink.url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/webhookJson.test.js
```

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-TEMPLATE-WEBHOOK-001",
    "domain": "attention",
    "title": "Plain webhook channels build correct JSON bodies",
    "priority": "P1",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/templates/webhookJson.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/templates/webhookJson.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/templates tests/unit/aiSessions/notify/templates docs/testing/behavior-contracts.json
git commit -m "feat: add plain webhook notification templates"
```

---

### Task 7: 通道模板 —— 需要构造 URL 或签名的(ntfy / telegram / bark / dingtalk)

这四个各有各的特殊处理:ntfy 走 HTTP 头且**中文标题必须做 RFC 2047 编码**
(否则 header 会被服务端截断成乱码),telegram 把 token 拼进路径,bark 把 key
拼进路径,dingtalk 要 HMAC-SHA256 加签。

**Files:**
- Create: `src/aiSessions/notify/templates/ntfy.ts`
- Create: `src/aiSessions/notify/templates/telegram.ts`
- Create: `src/aiSessions/notify/templates/bark.ts`
- Create: `src/aiSessions/notify/templates/dingtalk.ts`
- Test: `tests/unit/aiSessions/notify/templates/specialized.test.js`

**Interfaces:**
- Consumes: `NtfySink` / `TelegramSink` / `BarkSink` / `DingtalkSink`(Task 2)、`NotifyRequest`(Task 6)
- Produces:
  - `buildNtfyRequest(sink: NtfySink, title: string, body: string, priority: number): NotifyRequest`
  - `buildTelegramRequest(sink: TelegramSink, title: string, body: string): NotifyRequest`
  - `buildBarkRequest(sink: BarkSink, title: string, body: string): NotifyRequest`
  - `buildDingtalkRequest(sink: DingtalkSink, title: string, body: string, nowMs: number): NotifyRequest`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { buildNtfyRequest } = require('../../../../../out/aiSessions/notify/templates/ntfy');
const { buildTelegramRequest } = require('../../../../../out/aiSessions/notify/templates/telegram');
const { buildBarkRequest } = require('../../../../../out/aiSessions/notify/templates/bark');
const { buildDingtalkRequest } = require('../../../../../out/aiSessions/notify/templates/dingtalk');

// ATTENTION-NOTIFY-TEMPLATE-SPECIALIZED-001

const title = '⏸ Claude 在等你输入';
const body = '项目  p';

test('ntfy 把 topic 拼进路径,正文放 body', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 4 },
        title, body, 4);
    assert.equal(request.url, 'https://ntfy.sh/t1');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, body);
    assert.equal(request.headers.Priority, '4');
});

test('ntfy 的非 ASCII 标题按 RFC 2047 base64 编码', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 3 },
        title, body, 3);
    assert.match(request.headers.Title, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
    const encoded = request.headers.Title.slice('=?UTF-8?B?'.length, -'?='.length);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), title);
});

test('ntfy 的纯 ASCII 标题不编码', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 3 },
        'Claude is waiting', body, 3);
    assert.equal(request.headers.Title, 'Claude is waiting');
});

test('ntfy 有 token 时带 Authorization 头', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: 'tk_1', priority: 3 },
        'x', body, 3);
    assert.equal(request.headers.Authorization, 'Bearer tk_1');
});

test('ntfy baseUrl 末尾斜杠不产生双斜杠', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh/', topic: 't1', token: null, priority: 3 },
        'x', body, 3);
    assert.equal(request.url, 'https://ntfy.sh/t1');
});

test('telegram 把 botToken 拼进路径', () => {
    const request = buildTelegramRequest(
        { id: 'a', channel: 'telegram', proxy: null, botToken: 'BOT:1', chatId: '99' }, title, body);
    assert.equal(request.url, 'https://api.telegram.org/botBOT:1/sendMessage');
    assert.deepEqual(JSON.parse(request.body), { chat_id: '99', text: `${title}\n${body}` });
});

test('bark 把 deviceKey 拼进路径', () => {
    const request = buildBarkRequest(
        { id: 'a', channel: 'bark', proxy: null, serverUrl: 'https://api.day.app', deviceKey: 'KEY' }, title, body);
    assert.equal(request.url, 'https://api.day.app/KEY');
    assert.deepEqual(JSON.parse(request.body), { title, body });
});

test('dingtalk 追加 timestamp 与 HMAC 签名', () => {
    const nowMs = 1753948800000;
    const secret = 'SEC';
    const request = buildDingtalkRequest(
        { id: 'a', channel: 'dingtalk', proxy: null, url: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret },
        title, body, nowMs);
    const expectedSign = encodeURIComponent(
        crypto.createHmac('sha256', secret).update(`${nowMs}\n${secret}`).digest('base64'));
    assert.ok(request.url.includes(`&timestamp=${nowMs}`));
    assert.ok(request.url.includes(`&sign=${expectedSign}`));
    assert.equal(JSON.parse(request.body).msgtype, 'markdown');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/specialized.test.js
```

- [ ] **Step 3: 实现四个模板**

`src/aiSessions/notify/templates/ntfy.ts`:

```ts
'use strict';

import type { NtfySink } from '../types';
import type { NotifyRequest } from './types';

function encodeHeaderValue(value: string): string {
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7E]*$/u.test(value)) {
        return value;
    }
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildNtfyRequest(
    sink: NtfySink, title: string, body: string, priority: number
): NotifyRequest {
    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: encodeHeaderValue(title),
        Priority: String(priority),
    };
    if (sink.token) {
        headers.Authorization = `Bearer ${sink.token}`;
    }
    return {
        url: `${sink.baseUrl.replace(/\/+$/u, '')}/${sink.topic}`,
        method: 'POST',
        headers,
        body,
    };
}
```

`src/aiSessions/notify/templates/telegram.ts`:

```ts
'use strict';

import type { TelegramSink } from '../types';
import type { NotifyRequest } from './types';

export function buildTelegramRequest(sink: TelegramSink, title: string, body: string): NotifyRequest {
    return {
        url: `https://api.telegram.org/bot${sink.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: sink.chatId, text: `${title}\n${body}` }),
    };
}
```

`src/aiSessions/notify/templates/bark.ts`:

```ts
'use strict';

import type { BarkSink } from '../types';
import type { NotifyRequest } from './types';

export function buildBarkRequest(sink: BarkSink, title: string, body: string): NotifyRequest {
    return {
        url: `${sink.serverUrl.replace(/\/+$/u, '')}/${sink.deviceKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
    };
}
```

`src/aiSessions/notify/templates/dingtalk.ts`:

```ts
'use strict';

import * as crypto from 'crypto';
import type { DingtalkSink } from '../types';
import type { NotifyRequest } from './types';

export function buildDingtalkRequest(
    sink: DingtalkSink, title: string, body: string, nowMs: number
): NotifyRequest {
    const sign = encodeURIComponent(
        crypto.createHmac('sha256', sink.secret).update(`${nowMs}\n${sink.secret}`).digest('base64'));
    const separator = sink.url.includes('?') ? '&' : '?';
    return {
        url: `${sink.url}${separator}timestamp=${nowMs}&sign=${sign}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text: `**${title}**\n\n${body}` } }),
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/specialized.test.js
```

预期:8 个测试全部 PASS。

**注意**:第 8 个测试期望 `&timestamp=`,而 `separator` 逻辑在 URL 已含 `?`
时返回 `&`。测试用的 URL 含 `?access_token=x`,因此断言成立。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-TEMPLATE-SPECIALIZED-001",
    "domain": "attention",
    "title": "ntfy, telegram, bark and dingtalk requests are built correctly",
    "priority": "P1",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/templates/specialized.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/templates/ntfy.ts",
      "src/aiSessions/notify/templates/telegram.ts",
      "src/aiSessions/notify/templates/bark.ts",
      "src/aiSessions/notify/templates/dingtalk.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/templates tests/unit/aiSessions/notify/templates docs/testing/behavior-contracts.json
git commit -m "feat: add ntfy, telegram, bark and dingtalk templates"
```

---

### Task 8: 自定义模板与通道分发

**Files:**
- Create: `src/aiSessions/notify/templates/custom.ts`
- Create: `src/aiSessions/notify/templates/index.ts`
- Test: `tests/unit/aiSessions/notify/templates/dispatch.test.js`

**Interfaces:**
- Consumes: 全部 Task 6/7 的 builder、`NotifyPayload`(Task 2)、`renderNotifyTitle` / `renderNotifyBody` / `notifyPriority`(Task 5)
- Produces: `buildNotifyRequest(sink: NotifySink, payload: NotifyPayload, nowMs: number): NotifyRequest`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildNotifyRequest } = require('../../../../../out/aiSessions/notify/templates');

// ATTENTION-NOTIFY-TEMPLATE-DISPATCH-001

const payload = {
    eventId: 'e1',
    correlationId: 'K7M2QX',
    providerId: 'claude',
    reason: 'input-required',
    projectLabel: 'proj',
    sessionLabel: 'sess',
    hostLabel: 'host',
    runStartedAtMs: 0,
    occurredAtMs: 720000,
};

test('按 channel 分发到 ntfy', () => {
    const request = buildNotifyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't', token: null, priority: 4 },
        payload, 0);
    assert.equal(request.url, 'https://ntfy.sh/t');
    assert.match(request.body, /项目\s+proj/u);
});

test('按 channel 分发到 slack', () => {
    const request = buildNotifyRequest(
        { id: 'a', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/x' }, payload, 0);
    assert.match(JSON.parse(request.body).text, /Claude 在等你输入/u);
});

test('custom 模板替换占位符', () => {
    const request = buildNotifyRequest({
        id: 'a', channel: 'custom', proxy: null,
        url: 'https://example.test/hook',
        method: 'PUT',
        headers: { 'X-Token': 'k' },
        bodyTemplate: '{"p":"${project}","r":"${reason}","c":"${correlationId}"}',
    }, payload, 0);
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers['X-Token'], 'k');
    assert.deepEqual(JSON.parse(request.body), { p: 'proj', r: 'input-required', c: 'K7M2QX' });
});

test('custom 模板中未知占位符保持原样', () => {
    const request = buildNotifyRequest({
        id: 'a', channel: 'custom', proxy: null,
        url: 'https://example.test/hook', method: 'POST', headers: {},
        bodyTemplate: '${unknown}',
    }, payload, 0);
    assert.equal(request.body, '${unknown}');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/dispatch.test.js
```

- [ ] **Step 3: 实现**

`src/aiSessions/notify/templates/custom.ts`:

```ts
'use strict';

import type { CustomSink, NotifyPayload } from '../types';
import type { NotifyRequest } from './types';

export function buildCustomRequest(
    sink: CustomSink, payload: NotifyPayload, title: string, body: string
): NotifyRequest {
    const values: Record<string, string> = {
        project: payload.projectLabel,
        session: payload.sessionLabel,
        provider: payload.providerId,
        reason: payload.reason,
        host: payload.hostLabel,
        correlationId: payload.correlationId,
        title,
        body,
    };
    const rendered = sink.bodyTemplate.replace(
        /\$\{([A-Za-z]+)\}/gu,
        (match, key: string) => (key in values ? values[key] : match)
    );
    return { url: sink.url, method: sink.method, headers: { ...sink.headers }, body: rendered };
}
```

`src/aiSessions/notify/templates/index.ts`:

```ts
'use strict';

import { notifyPriority, renderNotifyBody, renderNotifyTitle } from '../message';
import type { NotifyPayload, NotifySink } from '../types';
import { buildBarkRequest } from './bark';
import { buildCustomRequest } from './custom';
import { buildDingtalkRequest } from './dingtalk';
import { buildNtfyRequest } from './ntfy';
import { buildTelegramRequest } from './telegram';
import type { NotifyRequest } from './types';
import { buildWebhookJsonRequest } from './webhookJson';

export type { NotifyRequest } from './types';

export function buildNotifyRequest(
    sink: NotifySink, payload: NotifyPayload, nowMs: number
): NotifyRequest {
    const title = renderNotifyTitle(payload);
    const body = renderNotifyBody(payload);
    switch (sink.channel) {
        case 'ntfy':
            return buildNtfyRequest(sink, title, body, notifyPriority(payload.reason));
        case 'telegram':
            return buildTelegramRequest(sink, title, body);
        case 'bark':
            return buildBarkRequest(sink, title, body);
        case 'dingtalk':
            return buildDingtalkRequest(sink, title, body, nowMs);
        case 'custom':
            return buildCustomRequest(sink, payload, title, body);
        default:
            return buildWebhookJsonRequest(sink, title, body);
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/templates/
```

预期:三个模板测试文件全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-TEMPLATE-DISPATCH-001",
    "domain": "attention",
    "title": "Notification requests dispatch by channel and support custom templates",
    "priority": "P1",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/templates/dispatch.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/templates/index.ts",
      "src/aiSessions/notify/templates/custom.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/templates tests/unit/aiSessions/notify/templates docs/testing/behavior-contracts.json
git commit -m "feat: add custom template and channel dispatch"
```

---

### Task 9: HTTP 客户端(代理 + 重试)

Node 的 `https.request` **不读取 `http_proxy` 环境变量**;VS Code 的
`http.proxySupport` 只给扩展宿主打补丁,计划 B 的守护进程拿不到。因此代理必须
自己实现:通过 `HTTP CONNECT` 建隧道。

**Files:**
- Create: `src/aiSessions/notify/httpClient.ts`
- Test: `tests/unit/aiSessions/notify/httpClient.test.js`

**Interfaces:**
- Consumes: `NotifyRequest`(Task 6)
- Produces:
  - `interface HttpResult { statusCode: number; durationMs: number; viaProxy: boolean }`
  - `interface HttpTransport { send(request: NotifyRequest, proxy: string | null): Promise<HttpResult> }`
  - `resolveProxy(sinkProxy: string | null, globalProxy: string, env: Record<string, string | undefined>, targetUrl: string): string | null`
  - `sendWithRetry(transport: HttpTransport, request: NotifyRequest, proxy: string | null, sleep: (ms: number) => Promise<void>): Promise<HttpResult>`

`sendWithRetry` 与 `resolveProxy` 是纯逻辑,单测覆盖;真实的 socket 实现
`createHttpsTransport()` 不在单测范围,由 Task 12 的 `Send Test Notification`
命令做真实验证。

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveProxy, sendWithRetry } = require('../../../../out/aiSessions/notify/httpClient');

// ATTENTION-NOTIFY-HTTP-001

const request = { url: 'https://example.test/hook', method: 'POST', headers: {}, body: '{}' };

test('sink 级代理优先于全局与环境变量', () => {
    assert.equal(
        resolveProxy('http://sink:1', 'http://global:2', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://sink:1');
});

test('无 sink 代理时使用全局', () => {
    assert.equal(
        resolveProxy(null, 'http://global:2', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://global:2');
});

test('无 sink 与全局时使用环境变量', () => {
    assert.equal(
        resolveProxy(null, '', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://env:3');
});

test('NO_PROXY 命中时不使用代理', () => {
    assert.equal(
        resolveProxy(null, '', { HTTPS_PROXY: 'http://env:3', NO_PROXY: '.internal.test' },
            'https://api.internal.test/x'),
        null);
});

test('都没有时返回 null', () => {
    assert.equal(resolveProxy(null, '', {}, 'https://x.test/'), null);
});

test('2xx 一次成功不重试', async () => {
    let calls = 0;
    const transport = { send: async () => { calls += 1; return { statusCode: 200, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 1);
});

test('5xx 重试三次后放弃', async () => {
    let calls = 0;
    const delays = [];
    const transport = { send: async () => { calls += 1; return { statusCode: 503, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async ms => { delays.push(ms); });
    assert.equal(result.statusCode, 503);
    assert.equal(calls, 4);
    assert.deepEqual(delays, [1000, 4000, 16000]);
});

test('4xx 不重试', async () => {
    let calls = 0;
    const transport = { send: async () => { calls += 1; return { statusCode: 401, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 401);
    assert.equal(calls, 1);
});

test('网络异常重试后成功', async () => {
    let calls = 0;
    const transport = {
        send: async () => {
            calls += 1;
            if (calls < 3) {
                throw new Error('ECONNRESET');
            }
            return { statusCode: 200, durationMs: 1, viaProxy: false };
        },
    };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 3);
});

test('全部尝试都抛异常时抛出最后一个错误', async () => {
    const transport = { send: async () => { throw new Error('ENETUNREACH'); } };
    await assert.rejects(
        () => sendWithRetry(transport, request, null, async () => {}),
        /ENETUNREACH/u);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/httpClient.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/httpClient.ts`:

```ts
'use strict';

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { NotifyRequest } from './templates/types';

export interface HttpResult {
    statusCode: number;
    durationMs: number;
    viaProxy: boolean;
}

export interface HttpTransport {
    send(request: NotifyRequest, proxy: string | null): Promise<HttpResult>;
}

const RETRY_DELAYS_MS = [1000, 4000, 16000];
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 15000;

function matchesNoProxy(hostname: string, noProxy: string): boolean {
    return noProxy.split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean)
        .some(entry => {
            const bare = entry.startsWith('.') ? entry.slice(1) : entry;
            return hostname === bare || hostname.endsWith(`.${bare}`);
        });
}

export function resolveProxy(
    sinkProxy: string | null,
    globalProxy: string,
    env: Record<string, string | undefined>,
    targetUrl: string
): string | null {
    const noProxy = env.NO_PROXY || env.no_proxy || '';
    if (noProxy) {
        try {
            if (matchesNoProxy(new URL(targetUrl).hostname.toLowerCase(), noProxy)) {
                return null;
            }
        } catch (_error) {
            // 目标 URL 无法解析时按无代理处理,由发送阶段报错。
        }
    }
    return sinkProxy
        || globalProxy
        || env.HTTPS_PROXY || env.https_proxy
        || env.ALL_PROXY || env.all_proxy
        || null;
}

export async function sendWithRetry(
    transport: HttpTransport,
    request: NotifyRequest,
    proxy: string | null,
    sleep: (ms: number) => Promise<void>
): Promise<HttpResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            const result = await transport.send(request, proxy);
            if (result.statusCode < 500) {
                return result;
            }
            if (attempt === RETRY_DELAYS_MS.length) {
                return result;
            }
        } catch (error) {
            lastError = error;
            if (attempt === RETRY_DELAYS_MS.length) {
                throw error;
            }
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw lastError || new Error('notification transport exhausted retries');
}

function openProxyTunnel(proxy: string, target: URL): Promise<NodeJS.Socket> {
    return new Promise((resolve, reject) => {
        const proxyUrl = new URL(proxy);
        const connectRequest = http.request({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port || 80),
            method: 'CONNECT',
            path: `${target.hostname}:${target.port || 443}`,
            timeout: CONNECT_TIMEOUT_MS,
        });
        connectRequest.on('connect', (response, socket) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`proxy CONNECT failed with ${response.statusCode}`));
                return;
            }
            resolve(socket);
        });
        connectRequest.on('error', reject);
        connectRequest.on('timeout', () => {
            connectRequest.destroy(new Error('proxy CONNECT timed out'));
        });
        connectRequest.end();
    });
}

export function createHttpsTransport(): HttpTransport {
    return {
        async send(request: NotifyRequest, proxy: string | null): Promise<HttpResult> {
            const startedAt = Date.now();
            const target = new URL(request.url);
            const socket = proxy ? await openProxyTunnel(proxy, target) : null;
            return new Promise<HttpResult>((resolve, reject) => {
                const outbound = https.request({
                    host: target.hostname,
                    port: Number(target.port || 443),
                    path: `${target.pathname}${target.search}`,
                    method: request.method,
                    headers: {
                        ...request.headers,
                        'Content-Length': Buffer.byteLength(request.body).toString(),
                    },
                    timeout: TOTAL_TIMEOUT_MS,
                    ...(socket ? { socket, agent: false } : {}),
                }, response => {
                    response.resume();
                    response.on('end', () => resolve({
                        statusCode: response.statusCode || 0,
                        durationMs: Date.now() - startedAt,
                        viaProxy: Boolean(proxy),
                    }));
                });
                outbound.on('error', reject);
                outbound.on('timeout', () => {
                    outbound.destroy(new Error('notification request timed out'));
                });
                outbound.end(request.body);
            });
        },
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/httpClient.test.js
```

预期:10 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-HTTP-001",
    "domain": "attention",
    "title": "Notification transport resolves proxies and retries transient failures",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/httpClient.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/httpClient.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/httpClient.ts tests/unit/aiSessions/notify/httpClient.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification http transport with proxy and retry"
```

---

### Task 10: 幂等存储

**Files:**
- Create: `src/aiSessions/notify/store.ts`
- Test: `tests/unit/aiSessions/notify/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class NotifiedEventStore`
    - `constructor(filePath: string, limit?: number)`
    - `has(eventId: string): boolean`
    - `record(eventId: string, sentAtMs: number): void`
    - `load(): void`
    - `save(): void`

写盘用"临时文件 + rename"保证原子性,避免进程被杀时留下半截 JSON——计划 B 的
守护进程会与扩展共读这个文件。

- [ ] **Step 1: 写失败测试**

```js
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
```

`makeTempDirectory(t, prefix)` 取自 `tests/helpers/tempDirectory.js`:它用
`fs.mkdtempSync` 建目录,并注册 `t.after()` 在测试结束时递归删除。因此每个
测试函数必须接受 `t` 参数。

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/store.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/store.ts`:

```ts
'use strict';

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LIMIT = 1000;

interface NotifiedRecord {
    eventId: string;
    sentAtMs: number;
}

export class NotifiedEventStore {
    private readonly entries = new Map<string, number>();

    constructor(private readonly filePath: string, private readonly limit: number = DEFAULT_LIMIT) {}

    has(eventId: string): boolean {
        return this.entries.has(eventId);
    }

    sentAt(eventId: string): number | null {
        const value = this.entries.get(eventId);
        return value === undefined ? null : value;
    }

    record(eventId: string, sentAtMs: number): void {
        this.entries.delete(eventId);
        this.entries.set(eventId, sentAtMs);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
    }

    load(): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (_error) {
            return;
        }
        const record = parsed as { schemaVersion?: unknown; events?: unknown };
        if (!record || record.schemaVersion !== 1 || !Array.isArray(record.events)) {
            return;
        }
        this.entries.clear();
        for (const entry of record.events as NotifiedRecord[]) {
            if (entry && typeof entry.eventId === 'string' && typeof entry.sentAtMs === 'number') {
                this.record(entry.eventId, entry.sentAtMs);
            }
        }
    }

    save(): void {
        const events: NotifiedRecord[] = Array.from(this.entries, ([eventId, sentAtMs]) => ({ eventId, sentAtMs }));
        const payload = JSON.stringify({ schemaVersion: 1, events });
        const temporaryPath = path.join(
            path.dirname(this.filePath),
            `.${path.basename(this.filePath)}.tmp`
        );
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/store.test.js
```

预期:6 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-STORE-001",
    "domain": "persistence",
    "title": "Notified event store is bounded, atomic and corruption tolerant",
    "priority": "P1",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/store.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/store.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/store.ts tests/unit/aiSessions/notify/store.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notified event store"
```

---

### Task 11: 派发器(防抖 + 限流 + 合并)

**Files:**
- Create: `src/aiSessions/notify/dispatcher.ts`
- Test: `tests/unit/aiSessions/notify/dispatcher.test.js`

**Interfaces:**
- Consumes: `NotifyConfig` / `NotifyPayload`(Task 2)、`evaluateNotifyPolicy`(Task 4)、`buildNotifyRequest`(Task 8)、`HttpTransport` / `sendWithRetry`(Task 9)、`NotifiedEventStore`(Task 10)
- Produces:
  - `interface DispatcherDeps { transport; store; nowMs; setTimeout; clearTimeout; sleep; globalProxy; env; onLog }`
  - `class NotifyDispatcher`
    - `constructor(deps: DispatcherDeps)`
    - `setConfig(config: NotifyConfig): void`
    - `enqueue(payload: NotifyPayload): void`
    - `cancel(eventIds: string[]): void`
    - `flushForTest(): Promise<void>`

时钟与定时器全部通过 `DispatcherDeps` 注入,测试自带一套假实现,不依赖
`tests/helpers/fakeClock.js`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aiSessions/notify/dispatcher.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { NotifyDispatcher } = require('../../../../out/aiSessions/notify/dispatcher');
const { NotifiedEventStore } = require('../../../../out/aiSessions/notify/store');
const { makeTempDirectory } = require('../../../helpers/tempDirectory');

// ATTENTION-NOTIFY-DISPATCHER-001

function createConfig(overrides) {
    return {
        schemaVersion: 1,
        enabled: true,
        sinks: [{ id: 's1', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/x' }],
        policy: Object.assign({
            reasons: ['completed', 'input-required', 'failed'],
            minRunDurationMs: 0,
            debounceMs: 5000,
            rateLimitPerMin: 6,
            escalateAfterMs: null,
        }, overrides),
        redaction: { projectPathMode: 'basename', includeSessionLabel: true },
    };
}

function createPayload(eventId) {
    return {
        eventId,
        correlationId: 'ABC234',
        providerId: 'claude',
        reason: 'completed',
        projectLabel: 'p',
        sessionLabel: 's',
        hostLabel: 'h',
        runStartedAtMs: 0,
        occurredAtMs: 60000,
    };
}

function createHarness(t, configOverrides) {
    const sent = [];
    const timers = [];
    let now = 0;
    const dispatcher = new NotifyDispatcher({
        transport: {
            send: async request => { sent.push(request); return { statusCode: 200, durationMs: 1, viaProxy: false }; },
        },
        store: new NotifiedEventStore(path.join(makeTempDirectory(t, 'notify-dispatch-'), 'notified.json')),
        nowMs: () => now,
        setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1; },
        clearTimeout: handle => { if (timers[handle]) { timers[handle].cancelled = true; } },
        sleep: async () => {},
        globalProxy: '',
        env: {},
        onLog: () => {},
    });
    dispatcher.setConfig(createConfig(configOverrides));
    return {
        dispatcher,
        sent,
        async advance(ms) {
            now += ms;
            for (const timer of timers) {
                if (!timer.cancelled && !timer.fired && timer.at <= now) {
                    timer.fired = true;
                    await timer.fn();
                }
            }
            await dispatcher.flushForTest();
        },
    };
}

test('防抖期满后发送一次', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    assert.equal(harness.sent.length, 0);
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('防抖期内取消则不发送', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    harness.dispatcher.cancel(['e1']);
    await harness.advance(5000);
    assert.equal(harness.sent.length, 0);
});

test('同一 eventId 重复入队只发送一次', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('发送过的 eventId 再次入队不重发', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('enabled 为 false 时不发送', async t => {
    const harness = createHarness(t);
    const config = createConfig();
    config.enabled = false;
    harness.dispatcher.setConfig(config);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 0);
});

test('超过限流上限时合并为一条', async t => {
    const harness = createHarness(t, { rateLimitPerMin: 2 });
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
        harness.dispatcher.enqueue(createPayload(id));
    }
    await harness.advance(5000);
    assert.equal(harness.sent.length, 3);
    const merged = JSON.parse(harness.sent[2].body).text;
    assert.match(merged, /2 个 AI 会话在等你/u);
});

test('多个 sink 各发一次', async t => {
    const harness = createHarness(t);
    const config = createConfig();
    config.sinks.push({ id: 's2', channel: 'discord', proxy: null, url: 'https://discord.com/api/webhooks/y' });
    harness.dispatcher.setConfig(config);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/dispatcher.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notify/dispatcher.ts`:

```ts
'use strict';

import { sendWithRetry } from './httpClient';
import type { HttpTransport } from './httpClient';
import { renderMergedBody, renderMergedTitle } from './message';
import { evaluateNotifyPolicy } from './policy';
import type { NotifiedEventStore } from './store';
import { buildNotifyRequest } from './templates';
import type { NotifyRequest } from './templates';
import { resolveProxy } from './httpClient';
import type { NotifyConfig, NotifyPayload, NotifySink } from './types';

const MAX_QUEUE = 100;

export interface DispatcherDeps {
    transport: HttpTransport;
    store: NotifiedEventStore;
    nowMs: () => number;
    setTimeout: (handler: () => void | Promise<void>, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    sleep: (ms: number) => Promise<void>;
    globalProxy: string;
    env: Record<string, string | undefined>;
    onLog: (line: string) => void;
}

interface PendingEntry {
    payload: NotifyPayload;
    timer: unknown;
}

export class NotifyDispatcher {
    private config: NotifyConfig | null = null;
    private readonly pending = new Map<string, PendingEntry>();
    private readonly acknowledged = new Set<string>();
    private sendTimestamps: number[] = [];
    private inFlight: Promise<void> = Promise.resolve();

    constructor(private readonly deps: DispatcherDeps) {}

    setConfig(config: NotifyConfig): void {
        this.config = config;
    }

    enqueue(payload: NotifyPayload): void {
        if (!this.config?.enabled || !this.config.sinks.length) {
            return;
        }
        if (this.pending.has(payload.eventId) || this.deps.store.has(payload.eventId)) {
            return;
        }
        if (this.pending.size >= MAX_QUEUE) {
            const oldest = this.pending.keys().next().value;
            if (oldest !== undefined) {
                this.deps.clearTimeout(this.pending.get(oldest)?.timer);
                this.pending.delete(oldest);
                this.deps.onLog(`notify: queue overflow, dropped ${oldest}`);
            }
        }
        const timer = this.deps.setTimeout(
            () => this.release(payload.eventId),
            this.config.policy.debounceMs
        );
        this.pending.set(payload.eventId, { payload, timer });
    }

    cancel(eventIds: string[]): void {
        for (const eventId of eventIds) {
            this.acknowledged.add(eventId);
            const entry = this.pending.get(eventId);
            if (entry) {
                this.deps.clearTimeout(entry.timer);
                this.pending.delete(eventId);
            }
        }
    }

    flushForTest(): Promise<void> {
        return this.inFlight;
    }

    private release(eventId: string): void {
        const entry = this.pending.get(eventId);
        this.pending.delete(eventId);
        if (!entry || !this.config) {
            return;
        }
        this.inFlight = this.inFlight.then(() => this.deliver(entry.payload)).catch(() => undefined);
    }

    private recentSendCount(now: number): number {
        this.sendTimestamps = this.sendTimestamps.filter(timestamp => now - timestamp < 60000);
        return this.sendTimestamps.length;
    }

    private async deliver(payload: NotifyPayload): Promise<void> {
        const config = this.config;
        if (!config?.enabled) {
            return;
        }
        const now = this.deps.nowMs();
        const decision = evaluateNotifyPolicy(payload, config.policy, {
            alreadyNotified: this.deps.store.has(payload.eventId),
            acknowledged: this.acknowledged.has(payload.eventId),
            sentWithinLastMinute: this.recentSendCount(now),
        });
        if (decision.action === 'skip') {
            this.deps.onLog(`notify: skipped ${payload.correlationId} (${decision.reason})`);
            return;
        }
        const requests = decision.action === 'merge'
            ? config.sinks.map(sink => this.buildMergedRequest(sink, payload, now))
            : config.sinks.map(sink => buildNotifyRequest(sink, payload, now));
        this.sendTimestamps.push(now);
        this.deps.store.record(payload.eventId, now);
        this.deps.store.save();
        for (let index = 0; index < requests.length; index += 1) {
            await this.send(config.sinks[index], requests[index], payload.correlationId);
        }
    }

    private buildMergedRequest(sink: NotifySink, payload: NotifyPayload, now: number): NotifyRequest {
        const queued = Array.from(this.pending.values(), entry => entry.payload);
        const merged: NotifyPayload = {
            ...payload,
            projectLabel: renderMergedTitle(queued.length + 1),
            sessionLabel: renderMergedBody([payload, ...queued]),
        };
        return buildNotifyRequest(sink, merged, now);
    }

    private async send(sink: NotifySink, request: NotifyRequest, correlationId: string): Promise<void> {
        const proxy = resolveProxy(sink.proxy, this.deps.globalProxy, this.deps.env, request.url);
        try {
            const result = await sendWithRetry(this.deps.transport, request, proxy, this.deps.sleep);
            this.deps.onLog(
                `notify: ${correlationId} -> ${sink.channel} status=${result.statusCode} `
                + `proxy=${result.viaProxy} ${result.durationMs}ms`
            );
        } catch (error) {
            this.deps.onLog(`notify: ${correlationId} -> ${sink.channel} failed: ${(error as Error).message}`);
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/dispatcher.test.js
```

预期:7 个测试全部 PASS。合并那条测试期望第 3 条消息的正文含
"2 个 AI 会话在等你"——`buildMergedRequest` 把合并标题塞进 `projectLabel`、
把明细塞进 `sessionLabel`,再由 `renderNotifyBody` 渲染进正文。若断言不符,
调整 `buildMergedRequest`,**不要改测试的期望**。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-DISPATCHER-001",
    "domain": "attention",
    "title": "Notification dispatcher debounces, deduplicates, rate limits and merges",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/dispatcher.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/dispatcher.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notify/dispatcher.ts tests/unit/aiSessions/notify/dispatcher.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add notification dispatcher"
```

---

### Task 12: 架构守卫 —— 禁止 notify 目录依赖 vscode

计划 B 的守护进程能否复用这批代码,完全取决于这条约束。用自动化守卫锁住它,
而不是靠 code review 记得。

**Files:**
- Modify: `scripts/run-architecture-guards.js`
- Test: `tests/unit/aiSessions/notify/isolation.test.js`

**Interfaces:**
- Consumes: 无
- Produces: 无(纯守卫)

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aiSessions/notify/isolation.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// ATTENTION-NOTIFY-ISOLATION-001

const notifyRoot = path.join(__dirname, '..', '..', '..', '..', 'src', 'aiSessions', 'notify');

function collectSourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectSourceFiles(entryPath);
        }
        return entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

test('notify 目录下没有任何文件依赖 vscode', () => {
    const offenders = collectSourceFiles(notifyRoot).filter(filePath => {
        const source = fs.readFileSync(filePath, 'utf8');
        return /from ['"]vscode['"]/u.test(source) || /require\(['"]vscode['"]\)/u.test(source);
    });
    assert.deepEqual(offenders, [], `these files must not depend on vscode: ${offenders.join(', ')}`);
});

test('notify 目录至少包含预期的核心模块', () => {
    const names = collectSourceFiles(notifyRoot).map(filePath => path.basename(filePath)).sort();
    for (const expected of ['dispatcher.ts', 'httpClient.ts', 'policy.ts', 'store.ts', 'types.ts']) {
        assert.ok(names.includes(expected), `missing ${expected}`);
    }
});
```

- [ ] **Step 2: 运行测试确认通过**

```bash
node --test tests/unit/aiSessions/notify/isolation.test.js
```

这个测试**应该直接通过**(前面的任务已经遵守了约束)。它的价值在于将来有人
违反时会红。若此刻失败,说明前面某个文件误引了 vscode,先修那个文件。

- [ ] **Step 3: 人工验证守卫确实会捕获违规**

临时在 `src/aiSessions/notify/policy.ts` 顶部加一行 `import * as vscode from 'vscode';`,
重新运行:

```bash
node --test tests/unit/aiSessions/notify/isolation.test.js
```

预期:第一个测试 FAIL 并列出 `policy.ts`。确认后**删除这行临时代码**,再跑一次
确认恢复 PASS。

- [ ] **Step 4: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-ISOLATION-001",
    "domain": "architecture",
    "title": "Notification core stays free of vscode dependencies",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/isolation.test.js"
    ],
    "evidence": [
      "src/aiSessions/notify/types.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add tests/unit/aiSessions/notify/isolation.test.js docs/testing/behavior-contracts.json
git commit -m "test: guard notification core against vscode dependencies"
```

---

### Task 13: 扩展侧接入 attentionController

**Files:**
- Create: `src/aiSessions/notifyIntegration/notifier.ts`
- Modify: `src/aiSessions/attentionController.ts:36`(options 接口)、`:110`(evaluate)、`:141-156`(acknowledge)
- Test: `tests/unit/aiSessions/notify/notifierHooks.test.js`

**Interfaces:**
- Consumes: `AiSessionAttentionEvent`(既有)、`NotifyDispatcher`(Task 11)、`createCorrelationId`(Task 3)
- Produces:
  - 在 `AiSessionAttentionControllerOptions` 上新增两个**可选**字段:
    - `onAttentionEvents?: (events: AiSessionAttentionEvent[]) => void`
    - `onAttentionAcknowledged?: (eventIds: string[]) => void`
  - `buildNotifyPayload(event, context): NotifyPayload`

新增字段必须是可选的,否则既有测试里构造 options 的地方全要改。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aiSessions/notify/notifierHooks.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildNotifyPayload } = require('../../../../out/aiSessions/notifyIntegration/notifier');

// ATTENTION-NOTIFY-PAYLOAD-BUILD-001

const event = {
    eventId: 'claude:018f:completed:deadbeef',
    key: 'claude:018f',
    reason: 'completed',
    generation: 1,
    detectedAt: 720000,
};

test('payload 携带 correlation id', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: 'vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
    });
    assert.match(payload.correlationId, /^[A-Z2-7]{6}$/u);
    assert.equal(payload.eventId, event.eventId);
    assert.equal(payload.reason, 'completed');
    assert.equal(payload.occurredAtMs, 720000);
    assert.equal(payload.runStartedAtMs, 0);
});

test('basename 模式只保留目录名', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: '/home/user/projects/vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        projectPathMode: 'basename',
    });
    assert.equal(payload.projectLabel, 'vscode-dashboard');
});

test('full 模式保留完整路径', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: '/home/user/projects/vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        projectPathMode: 'full',
    });
    assert.equal(payload.projectLabel, '/home/user/projects/vscode-dashboard');
});

test('关闭 sessionLabel 时以短码代替', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: 'p',
        sessionLabel: 'secret-branch-name',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        includeSessionLabel: false,
    });
    assert.equal(payload.sessionLabel, `#${payload.correlationId}`);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/notifierHooks.test.js
```

- [ ] **Step 3: 实现 buildNotifyPayload**

创建 `src/aiSessions/notifyIntegration/notifier.ts`:

```ts
'use strict';

import * as path from 'path';
import type { AiSessionAttentionEvent } from '../attentionMonitor';
import { createCorrelationId } from '../notify/correlation';
import type { NotifyPayload, NotifyReason } from '../notify/types';

export interface NotifyPayloadContext {
    providerId: string;
    projectLabel: string;
    sessionLabel: string;
    hostLabel: string;
    runStartedAtMs: number;
    projectPathMode?: 'basename' | 'full';
    includeSessionLabel?: boolean;
}

export function buildNotifyPayload(
    event: AiSessionAttentionEvent,
    context: NotifyPayloadContext
): NotifyPayload {
    const correlationId = createCorrelationId(event.eventId);
    const projectLabel = context.projectPathMode === 'full'
        ? context.projectLabel
        : path.basename(context.projectLabel) || context.projectLabel;
    return {
        eventId: event.eventId,
        correlationId,
        providerId: context.providerId,
        reason: event.reason as NotifyReason,
        projectLabel,
        sessionLabel: context.includeSessionLabel === false
            ? `#${correlationId}`
            : context.sessionLabel,
        hostLabel: context.hostLabel,
        runStartedAtMs: context.runStartedAtMs,
        occurredAtMs: event.detectedAt,
    };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/notifierHooks.test.js
```

预期:4 个测试全部 PASS。

- [ ] **Step 5: 在 attentionController 上加两个可选回调**

`src/aiSessions/attentionController.ts` 的 `AiSessionAttentionControllerOptions`
接口(`:27-36`)末尾追加两行:

```ts
    onAttentionEvents?: (events: AiSessionAttentionEvent[]) => void;
    onAttentionAcknowledged?: (eventIds: string[]) => void;
```

同时把 `AiSessionAttentionEvent` 加进顶部的 type import(`:9` 附近):

```ts
import type { AiSessionAttentionEvent, AiSessionAttentionSnapshot } from './attentionMonitor';
```

在 `evaluate()` 中 `const events = this.monitor.evaluate(inputs);`(`:110`)
之后插入:

```ts
        if (events.length) {
            try {
                this.options.onAttentionEvents?.(events);
            } catch (_error) {
                // 外发通知不得影响 attention 主流程。
            }
        }
```

在 `acknowledge()` 中 `this.monitor.acknowledge(uniqueEventIds);`(`:153`)
之后插入:

```ts
        try {
            this.options.onAttentionAcknowledged?.(uniqueEventIds);
        } catch (_error) {
            // 同上。
        }
```

- [ ] **Step 6: 跑既有 attention 测试确认无回归**

```bash
npm run test-compile
node --test tests/unit/aiSessions/
node --test --test-concurrency=1 tests/contract/aiSessions/attention.test.js
npm run test:safety:run
```

预期:全部 PASS。回调是可选的,既有调用方不传即不触发。

- [ ] **Step 7: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-PAYLOAD-BUILD-001",
    "domain": "attention",
    "title": "Notification payloads redact project paths and session labels",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/notifierHooks.test.js"
    ],
    "evidence": [
      "src/aiSessions/notifyIntegration/notifier.ts",
      "src/aiSessions/attentionController.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notifyIntegration src/aiSessions/attentionController.ts \
        tests/unit/aiSessions/notify/notifierHooks.test.js docs/testing/behavior-contracts.json
git commit -m "feat: hook notification payload building into attention controller"
```

---

### Task 14: 凭据存储与配置组装

**Files:**
- Create: `src/aiSessions/notifyIntegration/credentials.ts`
- Test: `tests/unit/aiSessions/notify/credentials.test.js`

**Interfaces:**
- Consumes: `NotifyConfig` / `validateNotifyConfig`(Task 2)
- Produces:
  - `interface SecretReader { get(key: string): Thenable<string | undefined> }`
  - `assembleNotifyConfig(settings, secrets: Record<string, string>): NotifyConfig`
  - `NOTIFY_SECRET_KEY_PREFIX = 'agentPivot.notify.sink.'`

设置项里只存**不含凭据**的 sink 骨架,凭据按 `sink.id` 从 SecretStorage 取,
两者在内存里合并成完整的 `NotifyConfig`。settings.json 因此永远不含 token。

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assembleNotifyConfig, NOTIFY_SECRET_KEY_PREFIX } =
    require('../../../../out/aiSessions/notifyIntegration/credentials');

// ATTENTION-NOTIFY-CREDENTIALS-001

const settings = {
    enabled: true,
    sinks: [{ id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', priority: 4, proxy: null }],
    reasons: ['completed', 'input-required', 'failed'],
    minRunDurationMs: 60000,
    debounceMs: 5000,
    rateLimitPerMin: 6,
    escalateAfterMs: 0,
    projectPathMode: 'basename',
    includeSessionLabel: true,
};

test('secret key 前缀稳定', () => {
    assert.equal(NOTIFY_SECRET_KEY_PREFIX, 'agentPivot.notify.sink.');
});

test('把 secret 合并进 sink 后产出合法配置', () => {
    const config = assembleNotifyConfig(settings, {
        s1: JSON.stringify({ topic: 'my-topic', token: null }),
    });
    assert.equal(config.sinks.length, 1);
    assert.equal(config.sinks[0].topic, 'my-topic');
    assert.equal(config.policy.minRunDurationMs, 60000);
});

test('缺少 secret 的 sink 被丢弃而不是抛异常', () => {
    const config = assembleNotifyConfig(settings, {});
    assert.equal(config.sinks.length, 0);
    assert.equal(config.enabled, true);
});

test('secret 内容非法时该 sink 被丢弃', () => {
    const config = assembleNotifyConfig(settings, { s1: 'not json' });
    assert.equal(config.sinks.length, 0);
});

test('escalateAfterMs 为 0 时归一化为 null', () => {
    const config = assembleNotifyConfig(settings, { s1: JSON.stringify({ topic: 't', token: null }) });
    assert.equal(config.policy.escalateAfterMs, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/credentials.test.js
```

- [ ] **Step 3: 实现**

创建 `src/aiSessions/notifyIntegration/credentials.ts`:

```ts
'use strict';

import { validateNotifyConfig } from '../notify/types';
import type { NotifyConfig } from '../notify/types';

export const NOTIFY_SECRET_KEY_PREFIX = 'agentPivot.notify.sink.';

export interface NotifySettings {
    enabled: boolean;
    sinks: Array<Record<string, unknown>>;
    reasons: string[];
    minRunDurationMs: number;
    debounceMs: number;
    rateLimitPerMin: number;
    escalateAfterMs: number;
    projectPathMode: string;
    includeSessionLabel: boolean;
}

export function assembleNotifyConfig(
    settings: NotifySettings,
    secrets: Record<string, string>
): NotifyConfig {
    const sinks: Array<Record<string, unknown>> = [];
    for (const skeleton of settings.sinks || []) {
        const id = typeof skeleton.id === 'string' ? skeleton.id : '';
        const raw = id ? secrets[id] : undefined;
        if (!raw) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (_error) {
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }
        sinks.push({ proxy: null, ...skeleton, ...(parsed as Record<string, unknown>) });
    }

    const candidate = {
        schemaVersion: 1,
        enabled: Boolean(settings.enabled),
        sinks,
        policy: {
            reasons: settings.reasons,
            minRunDurationMs: settings.minRunDurationMs,
            debounceMs: settings.debounceMs,
            rateLimitPerMin: settings.rateLimitPerMin,
            escalateAfterMs: settings.escalateAfterMs > 0 ? settings.escalateAfterMs : null,
        },
        redaction: {
            projectPathMode: settings.projectPathMode,
            includeSessionLabel: settings.includeSessionLabel,
        },
    };

    try {
        return validateNotifyConfig(candidate);
    } catch (_error) {
        return validateNotifyConfig({ ...candidate, sinks: [] });
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test-compile && node --test tests/unit/aiSessions/notify/credentials.test.js
```

预期:5 个测试全部 PASS。

- [ ] **Step 5: 登记行为契约并提交**

```json
  {
    "id": "ATTENTION-NOTIFY-CREDENTIALS-001",
    "domain": "attention",
    "title": "Notification credentials stay out of settings and merge from secrets",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/credentials.test.js"
    ],
    "evidence": [
      "src/aiSessions/notifyIntegration/credentials.ts"
    ]
  }
```

```bash
npm run test:behavior-contracts
git add src/aiSessions/notifyIntegration/credentials.ts \
        tests/unit/aiSessions/notify/credentials.test.js docs/testing/behavior-contracts.json
git commit -m "feat: assemble notification config from settings and secrets"
```

---

### Task 15: 配置项、命令与接线

这是把前 14 个任务接到真实扩展上的收尾任务。它包含 `package.json` 声明、
Output Channel、三个命令,以及在 `dashboard.ts` 里的装配。

**Files:**
- Create: `src/aiSessions/notifyIntegration/output.ts`
- Create: `src/aiSessions/notifyIntegration/commands.ts`
- Modify: `package.json`(`contributes.configuration` 与 `contributes.commands`)
- Modify: `src/dashboard.ts:1205` 附近(attention controller 装配处)
- Test: `tests/unit/aiSessions/notify/commandContract.test.js`

**Interfaces:**
- Consumes: 前述全部模块
- Produces:
  - `createNotifyOutputChannel(vscodeApi): { log(line: string): void; show(): void }`
  - `registerNotifyCommands(context, deps): vscode.Disposable[]`

- [ ] **Step 1: 写失败测试(校验 manifest 声明与实现一致)**

创建 `tests/unit/aiSessions/notify/commandContract.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test tests/unit/aiSessions/notify/commandContract.test.js
```

预期:失败,配置项尚不存在。

- [ ] **Step 3: 在 package.json 声明配置项**

在 `contributes.configuration.properties` 中,紧跟
`agentPivot.aiSessionAttention.enabled` 之后插入:

```json
                "agentPivot.notify.enabled": {
                    "type": "boolean",
                    "default": false,
                    "markdownDescription": "Send a notification to an IM or push service when an AI session stops and needs you. Sends project name, session name and status to the endpoints you configure."
                },
                "agentPivot.notify.sinks": {
                    "type": "array",
                    "default": [],
                    "scope": "machine",
                    "markdownDescription": "Notification targets without credentials. Credentials are stored separately by `Agent Pivot: Set Notification Webhook`. Channels that can also receive replies in a future release: `ntfy`, `telegram`, `slack`, `discord`, `dingtalk`, `feishu`. Only `ntfy` broadcasts to every machine; the others deliver a reply to one machine at random."
                },
                "agentPivot.notify.reasons": {
                    "type": "array",
                    "default": ["completed", "input-required", "failed"],
                    "items": { "enum": ["completed", "input-required", "failed"] },
                    "markdownDescription": "Which stop reasons trigger a notification. `failed` is only produced by Claude sessions."
                },
                "agentPivot.notify.minRunDurationMs": {
                    "type": "number",
                    "default": 60000,
                    "minimum": 0,
                    "markdownDescription": "Skip notifications for sessions that ran shorter than this. Raise it if short turns are too chatty."
                },
                "agentPivot.notify.debounceMs": {
                    "type": "number",
                    "default": 5000,
                    "minimum": 0
                },
                "agentPivot.notify.rateLimitPerMin": {
                    "type": "number",
                    "default": 6,
                    "minimum": 1
                },
                "agentPivot.notify.escalateAfterMs": {
                    "type": "number",
                    "default": 0,
                    "minimum": 0,
                    "markdownDescription": "Re-notify after this long if the attention indicator is still unread. `0` disables it."
                },
                "agentPivot.notify.projectPathMode": {
                    "type": "string",
                    "default": "basename",
                    "enum": ["basename", "full"],
                    "markdownDescription": "Whether notifications carry the project folder name only, or its full path."
                },
                "agentPivot.notify.includeSessionLabel": {
                    "type": "boolean",
                    "default": true,
                    "markdownDescription": "Include the session title. Turn off to send only the short correlation code."
                },
                "agentPivot.notify.proxy": {
                    "type": "string",
                    "default": "",
                    "scope": "machine",
                    "markdownDescription": "Proxy for notification requests, for example `http://127.0.0.1:7890`. Empty falls back to `HTTPS_PROXY` / `ALL_PROXY`."
                },
```

在 `contributes.commands` 数组末尾追加:

```json
            {
                "command": "agentPivot.notify.setWebhook",
                "title": "Agent Pivot: Set Notification Webhook"
            },
            {
                "command": "agentPivot.notify.sendTest",
                "title": "Agent Pivot: Send Test Notification"
            },
            {
                "command": "agentPivot.notify.showOutput",
                "title": "Agent Pivot: Show Notification Log"
            }
```

- [ ] **Step 4: 运行 manifest 测试确认通过**

```bash
node --test tests/unit/aiSessions/notify/commandContract.test.js
```

预期:6 个测试全部 PASS。

- [ ] **Step 5: 实现 Output Channel**

创建 `src/aiSessions/notifyIntegration/output.ts`:

```ts
'use strict';

import * as vscode from 'vscode';

export interface NotifyOutput {
    log(line: string): void;
    show(): void;
    dispose(): void;
}

export function createNotifyOutputChannel(): NotifyOutput {
    const channel = vscode.window.createOutputChannel('Agent Pivot Notifications');
    return {
        log(line: string): void {
            channel.appendLine(`[${new Date().toISOString()}] ${line}`);
        },
        show(): void {
            channel.show(true);
        },
        dispose(): void {
            channel.dispose();
        },
    };
}
```

- [ ] **Step 6: 实现三个命令**

创建 `src/aiSessions/notifyIntegration/commands.ts`:

```ts
'use strict';

import * as vscode from 'vscode';
import { createHttpsTransport, resolveProxy, sendWithRetry } from '../notify/httpClient';
import { buildNotifyRequest } from '../notify/templates';
import type { NotifyConfig } from '../notify/types';
import { NOTIFY_SECRET_KEY_PREFIX } from './credentials';
import type { NotifyOutput } from './output';

const CHANNEL_FIELDS: Record<string, string[]> = {
    ntfy: ['topic', 'token'],
    telegram: ['botToken', 'chatId'],
    bark: ['serverUrl', 'deviceKey'],
    feishu: ['url'],
    wecom: ['url'],
    slack: ['url'],
    discord: ['url'],
    dingtalk: ['url', 'secret'],
    custom: ['url'],
};

export interface NotifyCommandDeps {
    output: NotifyOutput;
    getConfig: () => NotifyConfig;
    globalProxy: () => string;
}

async function promptForSinkSecret(
    context: vscode.ExtensionContext
): Promise<void> {
    const channel = await vscode.window.showQuickPick(Object.keys(CHANNEL_FIELDS), {
        title: 'Notification channel',
    });
    if (!channel) {
        return;
    }
    const id = await vscode.window.showInputBox({
        title: 'Sink id',
        prompt: 'Must match the id used in agentPivot.notify.sinks',
        ignoreFocusOut: true,
    });
    if (!id) {
        return;
    }
    const secret: Record<string, string | null> = {};
    for (const field of CHANNEL_FIELDS[channel]) {
        const value = await vscode.window.showInputBox({
            title: `${channel} · ${field}`,
            password: true,
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            return;
        }
        secret[field] = value || null;
    }
    await context.secrets.store(`${NOTIFY_SECRET_KEY_PREFIX}${id}`, JSON.stringify(secret));
    vscode.window.showInformationMessage(
        `Agent Pivot: credentials stored for sink "${id}". They are kept in VS Code SecretStorage, not in settings.json.`
    );
}

export function registerNotifyCommands(
    context: vscode.ExtensionContext,
    deps: NotifyCommandDeps
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('agentPivot.notify.setWebhook',
            () => promptForSinkSecret(context)),
        vscode.commands.registerCommand('agentPivot.notify.showOutput',
            () => deps.output.show()),
        vscode.commands.registerCommand('agentPivot.notify.sendTest', async () => {
            const config = deps.getConfig();
            if (!config.sinks.length) {
                vscode.window.showWarningMessage(
                    'Agent Pivot: no notification sink is configured with credentials.');
                deps.output.show();
                return;
            }
            const transport = createHttpsTransport();
            const now = Date.now();
            const payload = {
                eventId: `test:${now}`,
                correlationId: 'TESTID',
                providerId: 'claude',
                reason: 'input-required' as const,
                projectLabel: 'agent-pivot',
                sessionLabel: 'notification test',
                hostLabel: require('os').hostname(),
                runStartedAtMs: now - 900000,
                occurredAtMs: now,
            };
            deps.output.show();
            for (const sink of config.sinks) {
                const request = buildNotifyRequest(sink, payload, now);
                const proxy = resolveProxy(sink.proxy, deps.globalProxy(), process.env, request.url);
                try {
                    const result = await sendWithRetry(transport, request, proxy, ms =>
                        new Promise(resolve => setTimeout(resolve, ms)));
                    deps.output.log(
                        `test ${sink.id} (${sink.channel}) -> status=${result.statusCode} `
                        + `proxy=${proxy ? 'yes' : 'no'} ${result.durationMs}ms host=${new URL(request.url).host}`
                    );
                } catch (error) {
                    deps.output.log(
                        `test ${sink.id} (${sink.channel}) -> FAILED proxy=${proxy ? 'yes' : 'no'} `
                        + `${(error as Error).message}`
                    );
                }
            }
        }),
    ];
}
```

- [ ] **Step 7: 在 dashboard.ts 装配**

在 `src/dashboard.ts` 中 attention controller 构造处(`:1205` 附近的
`isEnabled:` 所在对象)完成四件事:

1. 创建 output channel 与 dispatcher(在 controller 构造之前):

```ts
    const notifyOutput = createNotifyOutputChannel();
    context.subscriptions.push({ dispose: () => notifyOutput.dispose() });
    const notifiedStore = new NotifiedEventStore(
        path.join(os.homedir(), '.agent-pivot', 'notified.json'));
    notifiedStore.load();
    const notifyDispatcher = new NotifyDispatcher({
        transport: createHttpsTransport(),
        store: notifiedStore,
        nowMs: () => Date.now(),
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        globalProxy: getAgentPivotConfiguration().get<string>('notify.proxy', ''),
        env: process.env,
        onLog: line => notifyOutput.log(line),
    });
```

2. 定义一个刷新配置的函数,并在 `onDidChangeConfiguration` 中调用:

```ts
    const refreshNotifyConfig = async (): Promise<void> => {
        const configuration = getAgentPivotConfiguration();
        const skeletons = configuration.get<Array<Record<string, unknown>>>('notify.sinks', []);
        const secrets: Record<string, string> = {};
        for (const skeleton of skeletons) {
            const id = typeof skeleton.id === 'string' ? skeleton.id : '';
            if (!id) {
                continue;
            }
            const stored = await context.secrets.get(`${NOTIFY_SECRET_KEY_PREFIX}${id}`);
            if (stored) {
                secrets[id] = stored;
            }
        }
        notifyDispatcher.setConfig(assembleNotifyConfig({
            enabled: configuration.get<boolean>('notify.enabled', false),
            sinks: skeletons,
            reasons: configuration.get<string[]>('notify.reasons',
                ['completed', 'input-required', 'failed']),
            minRunDurationMs: configuration.get<number>('notify.minRunDurationMs', 60000),
            debounceMs: configuration.get<number>('notify.debounceMs', 5000),
            rateLimitPerMin: configuration.get<number>('notify.rateLimitPerMin', 6),
            escalateAfterMs: configuration.get<number>('notify.escalateAfterMs', 0),
            projectPathMode: configuration.get<string>('notify.projectPathMode', 'basename'),
            includeSessionLabel: configuration.get<boolean>('notify.includeSessionLabel', true),
        }, secrets));
    };
    await refreshNotifyConfig();
```

3. 给 attention controller options 加两个回调。`projectLabel` 用会话主 root
   的路径,`sessionLabel` 用会话名,`hostLabel` 用 `os.hostname()`:

```ts
        onAttentionEvents: events => {
            for (const event of events) {
                const located = locateAttentionSession(event.key);
                if (!located) {
                    continue;
                }
                notifyDispatcher.enqueue(buildNotifyPayload(event, {
                    providerId: located.providerId,
                    projectLabel: located.rootPath,
                    sessionLabel: located.session.name || located.session.id,
                    hostLabel: os.hostname(),
                    runStartedAtMs: located.runtime.runStartedAtMs,
                    projectPathMode: getAgentPivotConfiguration()
                        .get<'basename' | 'full'>('notify.projectPathMode', 'basename'),
                    includeSessionLabel: getAgentPivotConfiguration()
                        .get<boolean>('notify.includeSessionLabel', true),
                }));
            }
        },
        onAttentionAcknowledged: eventIds => notifyDispatcher.cancel(eventIds),
```

   `locateAttentionSession(key)` 需要在 `dashboard.ts` 中新增一个局部辅助
   函数,按 `event.key` 反查 provider、session、runtime 与主 root 路径。它
   用的正是 `AiSessionAttentionController.buildLocalItems` 已有的查找方式
   (`attentionController.ts:316-349`):遍历
   `workspaceTarget.sessions.sessionsByProvider[provider.id]`,用
   `getAiSessionKey(provider.id, session.id)` 与 key 比对,再从
   `workspaceTarget.workspace.roots` 里按 `session.primaryRootId` 找 root。

4. 注册命令:

```ts
    context.subscriptions.push(...registerNotifyCommands(context, {
        output: notifyOutput,
        getConfig: () => currentNotifyConfig,
        globalProxy: () => getAgentPivotConfiguration().get<string>('notify.proxy', ''),
    }));
```

   其中 `currentNotifyConfig` 由 `refreshNotifyConfig` 一并更新,便于
   `sendTest` 命令取到与 dispatcher 相同的配置。

- [ ] **Step 8: 编译并跑全量确定性测试**

```bash
npm run test-compile
npm run test:deterministic:run
npm run test:safety:run
npm run lint:ci
```

预期:全部 PASS。

- [ ] **Step 9: 真机验证**

在 VS Code 中重新加载窗口,然后:

1. 运行 `Agent Pivot: Set Notification Webhook`,选 `ntfy`,sink id 填 `s1`,
   topic 填一个 32 位随机串(`openssl rand -hex 16`)
2. 在 settings.json 里加:
   `"agentPivot.notify.enabled": true`、
   `"agentPivot.notify.sinks": [{"id":"s1","channel":"ntfy","baseUrl":"https://ntfy.sh","priority":4,"proxy":null}]`
3. 手机装 ntfy App 并订阅该 topic
4. 运行 `Agent Pivot: Send Test Notification`

预期:Output Channel 打印 `status=200`,手机收到通知。

5. 起一个真实的 Claude 会话,让它跑满 1 分钟以上后停下

预期:手机收到一条含项目名、会话名、主机名与 `#` 短码的通知,且**不含任何
代码或完整路径**。

- [ ] **Step 10: 登记行为契约**

```json
  {
    "id": "ATTENTION-NOTIFY-MANIFEST-001",
    "domain": "attention",
    "title": "Notification settings default to off and never hold credentials",
    "priority": "P0",
    "status": "automated",
    "owners": [
      "tests/unit/aiSessions/notify/commandContract.test.js"
    ],
    "evidence": [
      "package.json",
      "src/aiSessions/notifyIntegration/commands.ts"
    ]
  }
```

- [ ] **Step 11: 提交**

```bash
npm run test:behavior-contracts
git add package.json src/dashboard.ts src/aiSessions/notifyIntegration \
        tests/unit/aiSessions/notify/commandContract.test.js docs/testing/behavior-contracts.json
git commit -m "feat: wire notifications into the extension"
```

---

### Task 16: 文档与首次开启告知

这是本项目第一个出站网络请求。扩展此前的信任姿态是"纯本地",破除该约定必须
让用户在**开启前**知情,而不是藏在设置项描述里。

**Files:**
- Modify: `README.md`
- Modify: `src/dashboard.ts`(首次开启确认)
- Create: `docs/manual-tests/notification-delivery.md`

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 加首次开启确认**

在 `refreshNotifyConfig` 中,当 `notify.enabled` 从 false 变为 true 且
`context.globalState` 中无 `agentPivot.notify.consented` 标记时:

```ts
        if (enabled && !context.globalState.get<boolean>('agentPivot.notify.consented')) {
            const choice = await vscode.window.showWarningMessage(
                'Agent Pivot will send project names, session names and status to the '
                + 'notification endpoints you configure. No code or file contents are sent. Continue?',
                { modal: true },
                'Enable notifications'
            );
            if (choice !== 'Enable notifications') {
                await getAgentPivotConfiguration().update(
                    'notify.enabled', false, vscode.ConfigurationTarget.Global);
                return;
            }
            await context.globalState.update('agentPivot.notify.consented', true);
        }
```

- [ ] **Step 2: 写 README 章节**

在 `README.md` 中新增一节 "Notifications",内容必须覆盖:

- 功能说明:会话停下来等你时推送到 IM / 手机
- **明确声明这是扩展唯一的出站网络请求,默认关闭**
- 发送的内容清单(项目名、会话名、provider、原因、时长、主机名、短码)与
  不发送的内容(代码、会话正文、完整路径)
- 9 个通道的配置示例,每个给一段可直接粘贴的 `settings.json`
- 一张通道能力表,三列:通道、未来能否接收回复、多机时回复是否能到正确机器
- **ntfy 公共实例的 topic 名即密码**,建议用 `openssl rand -hex 16` 生成
- 凭据存放位置(SecretStorage),以及为什么不放 settings.json
- 代理配置说明
- 排障:先跑 `Agent Pivot: Send Test Notification`,再看
  `Agent Pivot: Show Notification Log`

- [ ] **Step 3: 写手工测试文档**

创建 `docs/manual-tests/notification-delivery.md`,记录 Task 15 Step 9 的
步骤,并补充三个用例:

- 关闭 `notify.enabled` 后会话停止**不应**产生通知
- 短会话(< 60s)停止**不应**产生通知
- 在 Dashboard 上点掉红点后,**不应**再收到该事件的通知

- [ ] **Step 4: 跑发布相关门禁**

```bash
npm run test:release-notes
npm run brand:check
npm run test:deterministic:run
```

预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add README.md src/dashboard.ts docs/manual-tests/notification-delivery.md
git commit -m "docs: document notification delivery and add first-run consent"
```

---

## 自查结论

对照 spec 逐节核对的结果:

| spec 章节 | 覆盖任务 |
| --- | --- |
| 可复用的既有代码 | Task 1(抽取共享 eventId) |
| 两种运行模式 · 进程内模式 | Task 13、15 |
| 两种运行模式 · 守护进程模式 | **计划 B** |
| 磁盘契约 · `channels.json` | Task 2(类型与校验)、Task 14(装配) |
| 磁盘契约 · `notified.json` | Task 10 |
| 磁盘契约 · `watchlist.json` / `acked.json` | **计划 B**(仅守护进程需要) |
| eventId 一致性 | Task 1 |
| reason 语义 | Task 2(拒绝 `aborted`)、Task 15(manifest 默认值) |
| 触发策略四道闸门 | Task 4、Task 11 |
| 会话存活与清理 | **计划 B** |
| 通道 ×9 | Task 6、7、8 |
| 消息格式 | Task 5 |
| 网络层 · 代理与重试 | Task 9 |
| 凭据与隐私 | Task 14、15、16 |
| 守护进程生命周期 | **计划 B** |
| 可观测性与降级 | Task 15(Output Channel、测试命令) |
| 配置项 | Task 15 |
| 失败模式 | Task 9(重试)、Task 10(损坏容错)、Task 11(队列上限) |
| 测试策略 | 每个任务内嵌 |
| v2 双向预埋 | Task 3(correlation id)、Task 12(vscode 隔离守卫) |

**明确不在本计划内、留给计划 B 的**:`notifyd` 进程、`watchlist.json`、
`acked.json`、supervisor 与拉起、会话存活探测、卸载清理、systemd unit。

`InboundTransport` 接口的定义也推迟到计划 B —— 在没有守护进程承载长连接之前
定义它没有消费者,属于过早抽象。spec 中"v1 定义不实现"的说法在此调整:
**v1 只保留 correlation id 与 vscode 隔离这两项真正有成本的预埋**,接口本身
等有实现者时再定义。
