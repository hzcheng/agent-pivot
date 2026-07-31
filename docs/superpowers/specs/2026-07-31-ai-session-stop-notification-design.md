# AI 会话停止通知 —— 设计方案

> Status: designed (2026-07-31)
> Date: 2026-07-31
> Worktree: `.worktree/notify-on-session-stop`(分支 `feat/notify-on-session-stop`)

## 背景

Agent Pivot 现在通过红点提示"AI 会话停下来了,需要你处理"。红点只在 VS Code
窗口里可见,用户离开电脑就得不到任何提示——而会话在 tmux 里可以跑很久,
"停下来等你"和"你回到电脑前"之间的空档正是这个功能要消除的。

本方案给现有 attention 事件流增加一个外发 sink:把"会话停止"推送到 IM /
手机通知服务。

## 目标

1. 会话停止时通过 IM / 手机推送主动通知用户
2. **VS Code 完全关闭、会话仍在 tmux 中运行时也能通知**
3. 远程开发(会话在远端机器)为主场景
4. 架构为 v2 的双向回复(手机回复注入 tmux)预留扩展口

## 非目标(v1)

- 手机端回复注入会话(v2)
- 消息撤回 / 已读回执
- Web 控制台
- 改动现有红点与 attention 链路(通知是并行 sink,不替换 UI)

## 关键决策

| # | 决策 | 依据 |
| --- | --- | --- |
| D1 | **发送方 = 会话所在机器** | 各 provider 的 JSONL 均从 `os.homedir()` 读(`claudeSessionService.ts:284`、`codexSessionService.ts:254`、`kimiSessionService.ts:231`),扩展宿主与其监控的会话永远同机。远程会话由远端发、本地会话由本地发,无需任何路由判断 |
| D2 | **不经 `attention-ui-bridge`** | bridge 是 `extensionKind: ui`,运行在用户笔记本上。合盖即失效,而合盖恰是最需要通知的时刻 |
| D3 | **常驻守护进程承担检测与发送,扩展仅做登记与 UI** | 关闭 VS Code 时扩展宿主立即以 exit code 7 退出,服务端约 10 分钟后自行关闭(`--enable-remote-auto-shutdown`)。扩展内发送在此场景下确定性失效 |
| D4 | 该超时**无官方配置项**,无法绕过 | 持久会话诉求 [vscode-remote-release#3096](https://github.com/microsoft/vscode-remote-release/issues/3096)、可调超时诉求 [vscode#167243](https://github.com/microsoft/vscode/issues/167243) 均未实现 |
| D5 | **守护进程默认关闭(opt-in)** | 默认路径为进程内发送,扩展保持普通插件身份;需要"关掉 VS Code 也收通知"的用户显式开启 |
| D6 | 9 个通道预设一次做全 | 每个是一个纯函数 + 一条单测,边际成本极低 |
| D7 | **不以任何单一环境的网络可达性做功能取舍** | 这是对外产品。可达性是使用者的环境问题,由代理支持解决,不是产品的能力边界 |
| D8 | `notify/` 与 `notifyd/` 全目录**禁止 import `vscode`** | 这是扩展与守护进程复用同一份检测代码的前提 |

**适用范围澄清**:`directTerminalRuntimeBackend` 的会话随 VS Code 窗口关闭而
终止,不存在"VS Code 关了还在跑"的情形。守护进程的价值主要体现在 tmux
后端会话上。

## 可复用的既有代码

以下模块经验证**零 `vscode` 依赖**,守护进程原样复用,不重写:

| 模块 | 行数 | 用途 |
| --- | --- | --- |
| `src/aiSessions/lifecycle.ts` | 208 | JSONL → 生命周期信号(三个 provider 的解析器) |
| `src/aiSessions/incrementalJsonlLifecycleReader.ts` | 122 | 增量读取 |
| `src/aiSessions/jsonlTail.ts` | 41 | 尾部追踪 |
| `src/aiSessions/attentionMonitor.ts` | 127 | 状态机与 eventId 生成 |
| `src/aiSessions/sessionHelpers.ts` | 161 | `getAiSessionKey` 等 |
| `src/aiSessions/readCoordinator.ts` | 89 | 读取调度 |

共 658 行。"读 JSONL → 判定停止 → 生成事件"整条链路无需重新实现。

## 架构

```
┌── 会话所在机器(远端开发机 / 本地)────────────────────────────────┐
│                                                                    │
│  agent-pivot-notifyd     detached,PPID=1,独立于 VS Code           │
│    watchlist watcher ──┐                                           │
│    JSONL tailer ───────┤  复用 jsonlTail / incrementalReader       │
│    lifecycle 解析 ─────┤  复用 lifecycle.ts                        │
│    eventId 生成 ───────┤  与扩展共享 eventIdentity.ts              │
│    policy ─────────────┤  reason / 时长 / 防抖 / 限流 / 幂等       │
│    templates ×9 ───────┤                                           │
│    httpClient ─────────┴──► POST ──► ntfy / 飞书 / Telegram / ...  │
│         ▲ 读                    ▲ 读             │ 写              │
│  ~/.agent-pivot/                │                │                 │
│    watchlist.json   会话登记表  │  ← 扩展写      │                 │
│    acked.json       已读事件    │  ← 扩展写      │                 │
│    channels.json    通道配置(0600) ← 扩展写   │                 │
│    notified.json    幂等 LRU ───────────────────┘                 │
│    notifyd.pid / notifyd.lock / notifyd.log                        │
│         ▲ 写                                                       │
│  VS Code 扩展宿主(可随时消失)                                     │
│    · 会话启停 → 写 watchlist                                       │
│    · 红点 ack → 写 acked.json                                      │
│    · 激活时健康检查 → 必要时拉起 daemon                            │
│    · 配置 / 命令 / Output Channel                                  │
│    · 红点逻辑不变                                                  │
└────────────────────────────────────────────────────────────────────┘
```

**职责边界**:守护进程开启时,它是**唯一发送方**,扩展不发,杜绝双发。
守护进程关闭时(默认),扩展进程内发送。

## 两种运行模式

| | 进程内模式(默认) | 守护进程模式(opt-in) |
| --- | --- | --- |
| 触发 | `daemon.enabled = false` | `daemon.enabled = true` |
| 发送方 | 扩展宿主 | `notifyd` |
| 接入点 | `attentionController.evaluate()` 中 `this.monitor.evaluate(inputs)` 之后(`attentionController.ts:110`),**fire-and-forget** | `notifyd` 自行监控 JSONL |
| VS Code 关闭后 | 无通知 | 继续通知 |
| 复用 | 同一套 `notify/` 模块 | 同一套 `notify/` 模块 |

两种模式**共用 `notified.json`** 做幂等,因此切换模式不会导致同一事件被重发。
两者互斥:守护进程存活时扩展不发送(supervisor 探活结果决定)。

进程内模式下不需要 `watchlist.json`——扩展直接持有 `runtime` 与
`workspaceTarget`,上下文齐全。watchlist 仅为守护进程而写。

## 磁盘契约

所有文件带 `schemaVersion`,校验沿用现有 `exactKeys()` 风格
(见 `attentionAggregate.ts:37`)。校验失败整体拒绝,不做部分容错。

### `watchlist.json`(扩展写,守护进程读)

```jsonc
{
  "schemaVersion": 1,
  "eventIdAlgoVersion": 1,
  "sessions": [{
    "sessionKey": "claude:018f...",
    "providerId": "claude",
    "sessionId": "018f...",
    "jsonlPath": "/home/user/.claude/projects/xxx/018f.jsonl",
    "runStartedAtMs": 1753948800000,
    "projectLabel": "vscode-dashboard",
    "sessionLabel": "fix/attention-notify",
    "hostLabel": "dev-server-03",
    "tmuxLocator": { "layout": "project", "sessionName": "ap-x", "windowName": "claude-018f" },
    "registeredAtMs": 1753948800000
  }]
}
```

`tmuxLocator` 形状取自 `tmuxRuntimeBindingStore.ts:1357` 的既有定义,不新造。
v1 只写不读,供 v2 回复注入使用。

### `channels.json`(0600,扩展写,守护进程读)

```jsonc
{
  "schemaVersion": 1,
  "enabled": true,
  "sinks": [
    { "id": "s1", "channel": "ntfy", "baseUrl": "https://ntfy.sh",
      "topic": "<32 位随机>", "token": null, "priority": 4, "proxy": null },
    { "id": "s2", "channel": "telegram", "botToken": "...", "chatId": "...",
      "proxy": "http://127.0.0.1:7890" }
  ],
  "policy": {
    "reasons": ["completed", "input-required", "failed"],
    "minRunDurationMs": 60000,
    "debounceMs": 5000,
    "rateLimitPerMin": 6,
    "escalateAfterMs": null
  },
  "redaction": { "projectPathMode": "basename", "includeSessionLabel": true }
}
```

`sinks[]` 是**按 `channel` 判别的联合类型**,各通道凭据形状不同,不能用单一
`url` 字段套用:

```
ntfy      { baseUrl, topic, token?, priority? }
telegram  { botToken, chatId }
bark      { serverUrl, deviceKey }
feishu    { url, secret? }
dingtalk  { url, secret }        // secret 用于 HMAC-SHA256 加签
wecom     { url }
slack     { url }
discord   { url }
custom    { url, method?, headers?, bodyTemplate? }
```

`proxy` 为 **sink 级**字段(常见需求:飞书直连、Telegram 走代理),缺省时回落
全局与环境变量。

### `acked.json`(扩展写,守护进程读)

```jsonc
{ "schemaVersion": 1, "eventIds": ["..."], "updatedAtMs": 0 }
```

上限 1000 条 LRU,与 `MAX_ATTENTION_ITEMS` 对齐。

### `notified.json`(守护进程私有)

已发 eventId 的 LRU + 发送时间戳,供幂等与 escalation 判定。

## 代码结构

```
src/aiSessions/notify/            零 vscode 依赖,扩展与守护进程共用
  types.ts          配置 / payload 类型 + 校验(判别式联合)
  eventIdentity.ts  eventId 生成(从 attentionMonitor 抽出)
  policy.ts         纯函数:event + 上下文 + 配置 → send | skip | defer
  templates.ts      纯函数 ×9:payload + sink → { url, headers, body }
  correlation.ts    eventId → 6 位 base32 短码
  httpClient.ts     https.request 封装 + 代理 + 重试(可注入)
  dispatcher.ts     队列 · 防抖 · 幂等 · 限流(注入 httpClient 与 clock)
  store.ts          四个磁盘文件的读写与校验

src/notifyd/                      守护进程,独立 entry
  main.ts             启动 / flock 单实例 / 信号处理 / 优雅退出
  watchlistWatcher.ts fs.watch + 30s 轮询兜底
  sessionMonitor.ts   每会话一个 JSONL tailer + lifecycle accumulator
  liveness.ts         会话存活探测
  logger.ts           文件日志 + 轮转(5MB × 3)

src/aiSessions/notifyIntegration/ 扩展侧,可 import vscode
  daemonSupervisor.ts 健康检查 / detached 拉起 / 版本比对 / 降级
  watchlistWriter.ts  会话启停时更新 watchlist
  ackWriter.ts        acknowledge 时写 acked.json
  credentials.ts      SecretStorage ↔ channels.json
  commands.ts         5 个命令
```

**打包**:守护进程单独一个 webpack entry → `dist/notifyd.js`,由扩展宿主自带
的 Node(`process.execPath`)运行,不引入新运行时依赖。

## 对既有代码的改动

| 文件 | 改动 | 规模 |
| --- | --- | --- |
| `attentionMonitor.ts` | eventId 生成抽出为 `eventIdentity.ts` 并改调用 | ~10 行,**行为零变化** |
| `attentionController.ts` | `acknowledge()` 增加一个回调出口 | ~5 行 |
| `dashboard.ts` | 注册 supervisor 与命令 | ~30 行 |
| `package.json` | 配置项、命令、webpack entry | — |

不需要:新扩展、改 `extensionKind`、动 `attention-ui-bridge`、动红点链路、
动 webview。

## eventId 一致性

扩展与守护进程必须对同一个停止事件算出**同一个 eventId**,否则 `acked.json`
对不上,用户点掉红点后守护进程仍会推送。

现有算法(`attentionMonitor.ts:82`):

```
eventId      = `${eventKey}:${reason}:${sha256(signal.token)}`
eventKey     = getAiSessionKey(providerId, sessionId)
signal.token = [provider, eventType, occurredAtMs, id].join(':')   // lifecycle.ts
```

三项输入的一致性保证:

| 输入 | 保证方式 |
| --- | --- |
| `providerId` / `sessionId` | watchlist 直接提供 |
| `signal.token` | 两侧运行同一份 `lifecycle.ts` |
| `runStartedAtMs` | **关键**:accumulator 丢弃早于它的事件。扩展必须把 runtime 的实际值写入 watchlist,守护进程不得自行推断 |

**防漂移**:算法抽到 `notify/eventIdentity.ts`,`attentionMonitor` 改为调用它
(纯重构)。watchlist 携带 `eventIdAlgoVersion`,守护进程启动时比对,不匹配则
**拒绝启动并记录原因**——宁可不通知,也不要产生幽灵重复推送。

## reason 语义(代码事实)

`lifecycle.ts` 中所有 `attention()` 调用点的实际分布:

| Provider | `completed` | `input-required` | `failed` | `aborted` |
| --- | --- | --- | --- | --- |
| Claude | `stop_reason === end_turn / stop_sequence`(`:198`) | `AskUserQuestion` 工具调用(`:195`) | `system/api_error`(`:178`) | — |
| Codex | `task_complete`(`:102`) | `request_user_input` 工具调用(`:114`) | — | — |
| Kimi | `TurnEnd`(`:144`) | `ApprovalRequest` / `QuestionRequest`(`:150`) | — | — |

两点必须记录:

1. **`aborted` 是死枚举值**。类型(`lifecycle.ts:3`)与校验器
   (`attentionAggregate.ts:58`、`attentionPayload.ts:95`)中存在,但没有任何
   解析器产生它。三种中断——Codex `turn_aborted`、Kimi `StepInterrupted`、
   Claude `[Request interrupted by user]`——全部映射为 `idle`,不触发
   attention。**配置项中不暴露 `aborted`。**
2. **`failed` 仅 Claude 产生**,且仅限 `api_error`。Codex 与 Kimi 永不产生。
   文档需注明。

**因此 `completed` 必须默认开启。** 红点在绝大多数情况下正是由 `completed`
点亮的(Claude 答完一轮交还控制权、Codex `task_complete`、Kimi `TurnEnd`)。
关闭它等于关闭本功能最主要的触发源。

## 触发策略

默认 `reasons = ["completed", "input-required", "failed"]`,即代码实际产生的
全部三种。

防刷屏不靠关闭 reason 类别,靠四道闸门(顺序执行):

1. **reason 过滤**
2. **`minRunDurationMs`(默认 60000)**:`occurredAtMs - runStartedAtMs` 不足
   则丢弃。挡掉"问一句答一句"的短回合——刷屏的真正来源
3. **防抖(默认 5000)**:`idle ↔ needsAttention` 存在抖动。事件入队后静置,
   期间同会话出现新 signal 则撤销旧项
4. **幂等**:eventId 命中 `notified.json` 直接丢弃
5. **限流(默认 6 条/分钟)**:超出则合并为一条摘要

**ack 联动**:每次发送前重读 `acked.json`,命中则跳过。

**escalation(默认关闭)**:`escalateAfterMs` 后仍未出现在 `acked.json` →
再推一次,priority 提升一级。

## 会话存活与清理

VS Code 关闭后扩展无法更新 watchlist,守护进程需自行判断:

| 后端 | 探测方式 |
| --- | --- |
| tmux | `tmux has-session` + window 存在性,60s 一次 |
| direct terminal | 无法探测;VS Code 关闭时会话即终止,走兜底清理 |

**兜底**:JSONL 超过 `staleAfterMs`(默认 6h)无写入且无存活证据 → 停止监控
(不改动 watchlist 文件,交由扩展下次启动整理)。

**自退出**:watchlist 中无任何存活会话持续 2 小时 → 优雅退出。这一条同时
承担卸载清理职责(见下)。

## 通道

| channel | body 形态 | v2 收回复 | 多机可用 |
| --- | --- | --- | --- |
| `ntfy` | 纯文本 body + `Title`/`Priority`/`Tags`/`Actions` 头 | ✅ SSE / 长轮询,出站 | ✅ **pub/sub 广播** |
| `telegram` | `{chat_id, text, parse_mode}` | ✅ `getUpdates` 长轮询 + inline keyboard | ❌ 竞争消费 |
| `slack` | `{text}` | ✅ Socket Mode | ❌ 负载均衡 |
| `discord` | `{content}` | ✅ Gateway WS | ❌ 负载均衡 |
| `dingtalk` | `{msgtype:"markdown",...}` | ✅ Stream 模式 | ⚠️ 未明确 |
| `feishu` | `{msg_type:"text"/"interactive"}` | ✅ 长连接(官方 Node SDK) | ❌ **官方明文:随机投递给一个客户端** |
| `wecom` | `{msgtype:"markdown"}` | ❌ 仅公网回调 | — |
| `bark` | `POST /{key}/{title}/{body}` | ❌ 纯单向 | — |
| `custom` | 用户模板,`${project}` 等占位符 | 用户自定 | 用户自定 |

`dingtalk` 需拼接 `timestamp` + HMAC-SHA256 `sign`。

**"多机可用"列的含义**:多台开发机各跑一个守护进程时,手机回复能否投递到
正确的机器。**ntfy 是发布/订阅语义(所有订阅者都收到),其余均为竞争消费**
(随机一个客户端收到)。这是消息语义差异,不是实现质量差异。

- **对 v1 单向无任何影响**——发出去谁都能收到
- **对 v2 双向是决定性的**:多机场景下 ntfy 是唯一天然正确的通道;其余通道
  要支持多机只能每台机器一套独立凭据

外部依赖的核实结论:

- 钉钉 Stream:WebSocket 反向连接,零公网 IP / 零验签 / 零端口暴露。
  **需企业内部应用**(ClientID + ClientSecret),**群自定义机器人不支持**。
  **Stream 仅支持"钉钉 → 应用"方向,发消息仍需 Webhook 或服务端 API**——
  v2 需同时维护两套凭据。单应用上限 50 连接。
- 飞书长连接:官方 SDK 内建,**有官方 Node.js SDK**(`Lark.WSClient`)。
  需 App ID + App Secret。事件需在 **3 秒内**处理完否则超时重推;单应用上限
  50 连接;去重应使用 `message_id` 而非 `event_id`。
  **待确认**:是否仅限企业自建应用(搜索结果称是,官方页面的"支持的应用
  类型"同时列出 Custom App 与 Store App 且未按传输方式拆分)。

产品对 9 个通道一视同仁。ntfy 的推荐只出现在文档中,不体现为代码倾向。

## 消息格式

单条:

```
⏸ Claude 在等你输入
项目  vscode-dashboard
会话  fix/attention-notify
原因  需要输入 · 已运行 12 分钟
主机  dev-server-03
ID    #K7M2QX
```

合并(限流触发):

```
⏸ 3 个 AI 会话在等你
· Claude / vscode-dashboard —— 需要输入
· Codex / api-gateway —— 执行失败
· Claude / web —— 需要输入
```

- `主机` 字段是必要的:多机开发时,不写清来源就无法定位
- `ID` 为 correlation id(eventId 前 6 位 base32),v1 用于查日志,
  **v2 用于路由回复**
- `Priority`:`input-required` / `failed` → 4(high);`completed` → 3

## 网络层

**代理是必需功能,不是可选项**。这是对外产品,大量用户会遇到某通道不可达。

解析顺序:sink 级 `proxy` → 全局 `proxy` → 环境变量 `HTTPS_PROXY` /
`ALL_PROXY`(尊重 `NO_PROXY`)→ 直连。

**注意**:Node 的 `https.request` 默认忽略代理环境变量;VS Code 的
`http.proxySupport`(默认 `override`)只为扩展宿主打补丁,**守护进程是独立
进程,拿不到该补丁**,必须自行实现。

- **重试**:3 次指数退避(1s / 4s / 16s),仅对 5xx 与网络错误重试;4xx 直接
  判失败并记录(配置错误重试无意义)
- **超时**:连接 5s,总计 15s
- **永不阻塞**:扩展侧接入点 fire-and-forget;守护进程侧发送在独立队列,不
  阻塞 JSONL 监控
- **队列上限** 100 条,超出丢弃最旧项并计数

## 凭据与隐私

### 凭据存储的已知妥协

守护进程**无法读取 VS Code SecretStorage**(那是扩展宿主 API),因此 webhook
URL 与 token **必须落盘**到 `~/.agent-pivot/channels.json`,权限 0600。

扩展侧仍以 SecretStorage 为权威存储,理由:`settings.json` 会被 Settings Sync
同步上云、会进截图、可能被误提交;`channels.json` 是本机 0600 文件,不参与
任何同步。这是"优于 settings.json,劣于纯内存"的中间态,不粉饰。

### 隐私

- **默认 `enabled: false`**,必须显式开启
- 首次开启弹一次确认,明确说明"将向你配置的地址发送项目名、会话名和状态"
- **只发元数据**:不含会话正文、代码、完整路径
- `projectPathMode: "basename"` 默认只发目录名
- 理由:webhook URL 一旦外泄,泄露的是用户的项目名单

**这是本项目第一个出站网络请求**(当前代码库中检索不到任何 `https` /
`fetch` / `axios` 用法)。扩展现有的信任姿态是"纯本地",破除该约定必须在
README 与扩展描述中显式说明,不能只写在设置项里。

### ntfy 的特殊风险

公共实例上 **topic 名即唯一凭据**。v1 单向使用 32 位随机 topic 可接受。
**v2 双向前必须迁至自建实例 + `auth-default-access: deny-all` + token**——
届时"能向回复 topic 发消息"等同于"能向用户的 tmux 会话输入命令"。

## 守护进程生命周期

### 拉起

```js
spawn(process.execPath, [notifydPath], { detached: true, stdio: 'ignore' }).unref();
```

三个参数各解决一个问题:`detached` 使其脱离父进程 process group,躲开 SSH
断开时的 SIGHUP;`stdio: 'ignore'` 避免父进程退出后写日志触发 EPIPE;
`unref()` 使扩展宿主能干净退出。之后守护进程被 init 收养,**PPID = 1**。

这与 `tmuxClient.ts:357` 的 `tmux new-session -d` 是同一机制——用户现有的
会话已经在依赖它。

### 单实例与健康检查

- `notifyd.lock` 使用 flock,多窗口只会存在一个守护进程
- 扩展激活时:读 pidfile → `process.kill(pid, 0)` 探活 → 比对版本 → 版本
  过旧则优雅重启(先让队列发完)

### 已知边界:不扛机器重启

重启后除非再打开一次 VS Code(扩展激活 → 健康检查 → 拉起),守护进程不会
自行启动。这与 tmux 的局限一致(重启后 tmux 会话同样消失,因而也没有需要
通知的会话),实际影响很小。

可选增强:`Install Notification Daemon as Service` 命令安装 systemd user
unit。**注意还需 `loginctl enable-linger $USER`**,否则 SSH 登出后 systemd
会连同服务一并回收。不进 v1 必做项。

### 卸载清理

**VS Code 卸载扩展时不保证调用 `deactivate`**,守护进程可能成为孤儿。对策:

- **idle 自退出为必需项**(无存活会话 2 小时即退出)
- 守护进程定期检查 `watchlist.json` 的 mtime,超过 `staleAfterMs` 且无存活
  会话 → 退出
- 提供 `Uninstall Notification Daemon` 命令
- 文档写明手工清理路径(`~/.agent-pivot/` 与 kill pid)

### 命令

| 命令 | 作用 |
| --- | --- |
| `Agent Pivot: Set Notification Webhook` | 按通道类型分别引导输入,写 SecretStorage 与 `channels.json` |
| `Agent Pivot: Send Test Notification` | 端到端自测。**逐 sink 报告**:是否走代理、连通性、HTTP 状态码、耗时、脱敏后的目标 host |
| `Agent Pivot: Show Notification Daemon Status` | PID / PPID / 版本 / 监控会话数 / 最近发送与失败 |
| `Agent Pivot: Restart Notification Daemon` | 排障 |
| `Agent Pivot: Uninstall Notification Daemon` | 停止进程并清理 `~/.agent-pivot/` |

## 可观测性与降级

- **守护进程日志** `~/.agent-pivot/notifyd.log`,轮转 5MB × 3。这是 VS Code
  不在时唯一的排查手段
- **扩展 Output Channel** 镜像守护进程状态与最近发送记录
- **发送失败永不弹窗**,只进日志。否则网络抖动会造成弹窗轰炸
- **降级必须可见**:守护进程拉起失败时,Output Channel **显式写出**
  "当前为进程内模式,关闭 VS Code 后将不再有通知"。静默降级比没有功能更
  危险——用户会以为有保障

## 配置项

```
agentPivot.notify.enabled                 boolean  false     总开关
agentPivot.notify.sinks                   array    []        通道列表(不含凭据)
agentPivot.notify.reasons                 array    ["completed","input-required","failed"]
agentPivot.notify.minRunDurationMs        number   60000
agentPivot.notify.debounceMs              number   5000
agentPivot.notify.rateLimitPerMin         number   6
agentPivot.notify.escalateAfterMs         number   0         0 = 关闭
agentPivot.notify.projectPathMode         enum     basename  basename | full
agentPivot.notify.includeSessionLabel     boolean  true
agentPivot.notify.proxy                   string   ""        空 = 自动探测
agentPivot.notify.daemon.enabled          boolean  false     opt-in
agentPivot.notify.daemon.staleAfterMs     number   21600000
```

凭据不在此列。每个通道的配置项描述中标注其双向与多机能力。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| 守护进程拉起失败 | 回落进程内发送,Output Channel 显式告警 |
| 守护进程崩溃(VS Code 在) | 下次激活时健康检查拉起;崩溃期间事件从 JSONL 补读(幂等保证不重发) |
| 守护进程崩溃(VS Code 不在) | **丢通知**。v1 接受的风险;systemd 模式可解 |
| `eventIdAlgoVersion` 不匹配 | 拒绝启动 + 日志说明 |
| webhook 4xx | 不重试,记日志。`Send Test Notification` 为排查入口 |
| 网络长时间中断 | 队列上限 100 条,丢弃最旧项并计数 |
| 多台机器同时有会话 | 各自守护进程独立发送,消息中 `主机` 字段区分 |
| 同一会话被多窗口 attach | 守护进程只有一个,天然无重复 |
| 磁盘文件损坏 | 校验失败整体拒绝 + 日志,不做部分容错 |

## 测试策略

沿用现有 `tests/{unit,contract,integration,extension-host}` 结构。

| 层 | 覆盖 |
| --- | --- |
| `unit` | `policy`(四道闸门全组合)、`templates` ×9(快照)、`correlation` |
| `unit` | `eventIdentity`:与 `attentionMonitor` 的结果**逐字节一致** |
| `unit` | `dispatcher`:注入假 httpClient 与假时钟,测防抖 / 限流 / 重试 / 幂等 |
| `contract` | 四个磁盘文件的 schema 校验(合法输入 + 各类畸形输入) |
| `integration` | 启动真实守护进程,向临时 HOME 写入构造的 JSONL,断言本地假服务端收到的 HTTP 请求内容 |
| `extension-host` | 拉起 / 健康检查 / 降级路径 |
| 手工 | `docs/manual-tests/` 增加:关闭 VS Code 后 `ps -o ppid= -p <pid>` 应为 1,且仍能收到通知 |

## v2 双向的预埋

v1 现在就做、成本极低的四项:

1. 每条通知携带 correlation id(消息中显示 `#K7M2QX`)
2. watchlist 存 `tmuxLocator`——回复注入落点,v1 只写不读
3. 通道抽象拆为 `OutboundSink { send() }`(实现)与
   `InboundTransport { subscribe() }`(**只定义不实现**)
4. `notify/` 全目录禁止 import `vscode`

v2 形态(不在本次范围,仅说明预埋理由):守护进程增开一条
`GET /reply-topic/json` 长连接;通知上挂 ntfy Action 按钮,`http` 类型 POST
至回复 topic;守护进程收到后按 correlation id 查 watchlist → `tmux send-keys`。
全程零公网 IP、零额外服务。

## 实施顺序

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 | `eventIdentity` 抽取重构,`attentionMonitor` 改调用 | 现有测试全绿,行为零变化 |
| P1 | `types` / `policy` / `templates` ×9 / `correlation` | 纯函数全单测 |
| P2 | `httpClient`(代理 + 重试)/ `dispatcher` / `store` | 假 http + 假时钟单测 |
| P3 | `notifyd` 可独立运行 | **脱离 VS Code**,手写 watchlist 即可跑通 |
| P4 | 扩展侧:watchlist / ack 写入、supervisor、凭据、5 个命令 | 端到端 |
| P5 | 降级、配置项、Output Channel、README 与隐私说明 | 可发布 |
| P6 | (可选)systemd user unit 命令 | 扛机器重启 |
| v2 | `InboundTransport` + tmux 回注 | 另开一轮 |

P0–P5 为最小可用闭环,且满足"关闭 VS Code 仍能通知"。

## 待确认

- 飞书长连接是否仅限企业自建应用(仅在选择飞书做 v2 双向时需要结论)
- 钉钉 Stream 在多客户端下是广播还是负载均衡(同上)
