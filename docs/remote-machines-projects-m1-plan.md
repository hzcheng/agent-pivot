# Remote Machines × Projects — Milestone 1 实施蓝图

> 状态：**待 Owner 验收**
>
> 范围：关键任务流程、低保真交互、目标模块边界、迁移/降级策略和单 PR 实施节奏。
>
> 本阶段只形成可实施合同，不修改生产代码。产品行为以
> [`remote-machines-projects-prd.md`](./remote-machines-projects-prd.md) 为准。

## 1. 本次重构要解决什么

当前 Project 管理把“项目在哪里”和“项目属于什么类别”都压在 Group 与
Remote URI 上。用户能打开项目，但不能先看到稳定的 Machine，再判断当前
设备如何连接它，也不能把同一台逻辑 Machine 上的 Host 与 Dev Container
作为两个清晰环境管理。

目标结构固定为：

```text
Machine（同步的逻辑开发机器）
└── Environment（Host / Dev Container / 兼容环境）
    └── Project（该环境中的已保存入口）
```

Tag 只回答“项目是什么”，Connection Profile 只回答“当前桌面端 VS Code 安装
实例如何连接这台 Machine”。这三个概念不能互相代替。

### 1.1 成功边界

- 一个最终 PR，保留可审阅、可回退的内部 commits。
- 在 V2 切换写入权前，V1 始终是权威数据；任一中间 commit 都不能让用户进入
  “数据已迁移但没有完整打开入口”的状态。
- Machine、Environment、Project、Tag、Favorite 和稳定排序按现有同步开关选择
  synced 或 workspace-host-local backend；Connection Profile、Client ID 与跨远端
  窗口共享的界面状态只保存在桌面 UI bridge。
- 远端状态只陈述插件可靠观测到的事实。
- V1 数据、V2 数据和 recovery copy 使用不同存储键，不允许旧解析器覆盖 V2。
- 变更范围限定在 Project Catalog、Dashboard/Webview、attention UI bridge/shared
  protocol 及对应测试/配置；若必须重构 AI Sessions、Worktrees 或通用同步基础设施，
  先回到 Owner 重新评审范围，不把无关架构清理带入最终 PR。

### 1.2 明确不做

- 不实现 SSH 协议、凭据、在线探测或物理主机去重。
- 不解析 SSH config 来自动维护 Machine 列表。
- 不以 runtime container ID 作为 Dev Container 身份。
- 不把跨 Machine 拖动当作 Move；不在首期引入完整 ARIA tree。
- 不在本次重构中改造 `OPEN` 页的信息架构。

## 2. 当前实现的事实基线

### 2.1 当前数据流

```text
package.json: agentPivot.projectSyncData / agentPivot.projectData
                         │
                         ▼
              ProjectCatalogSyncService
        V1 vector clock / merge / legacy projection
                         │
                         ▼
                  ProjectService
       Group + Project CRUD 的当前统一写入口
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
     Dashboard controllers      webviewContent.ts
                                   │
                                   ▼
                      src/webview/*.js ↔ media/*.js
```

证据：

- `src/models.ts` 的核心模型仍是 `Group { projects[] }` 与扁平 `Project`；
  Project 的 `remoteType` 来自保存 URI 的 authority 前缀。
- `src/projects/projectCatalogSync.ts` 的 parser 只接受
  `schemaVersion: 1`，V1 文档把 `groupId` 直接存到 Project 记录旁。
- `src/services/projectCatalogSyncService.ts` 协调 V1 vector clock、legacy
  projection、配置写回与 echo 抑制。
- `src/services/projectService.ts` 是现有 Group/Project CRUD façade；根据
  `agentPivot.storeProjectsInSettings` 在 settings 与 extension state 间选择。
- `src/dashboard/groupCollapseController.ts` 会把普通 Group 的 `collapsed`
  写回目录；Favorites 的折叠状态则已经是 local state。
- `src/webview/webviewContent.ts` 构造虚拟 Favorites section；收藏实体仍是原
  Project，独立顺序来自 `favoriteOrder`。
- `src/projects/projectTags.ts` 当前会把 tags 无条件限制到 8 个；迁移超限数据
  需要独立的 preservation 路径，不能复用该截断逻辑。
- 主扩展声明 `extensionKind: workspace`，在 Local、SSH Host 与 Dev Container 中
  可能运行于不同 Extension Host；它的 `globalState` 不能作为桌面 Client 级存储。
  仓库已有 `extensionKind: ui` 的 `attention-ui-bridge`，Client ID、Connection
  Profile、view state、downgrade 权威副本和 recovery journal 必须由它持有。

### 2.2 当前打开链路

```text
Project row / menu
        │
        ▼
ProjectOpenController ── current / new / add-to-workspace policy
        │
        ▼
RemoteProjectResolver ── saved URI + recent workspace matching
        │
        ▼
attention-ui-bridge ── vscode.openFolder / vscode.newWindow
```

- SSH 空 Host 窗口可以通过 `vscode.newWindow({ remoteAuthority })` 发起；当前侧
  只能知道 VS Code 是否接受命令。
- `WorkspaceContextResolver` 对没有 workspace folder 的窗口返回空，因此空
  Host 窗口不能保证进入现有跨窗口 registry。
- 仓库已有嵌套 authority 形态
  `dev-container+target@ssh-remote+host` 的契约样例，但尚无独立、稳定的
  launch-anchor 生命周期。

### 2.3 当前 UI 与运行约束

- Projects 由 `webviewContent.ts` 生成 HTML，并由多个无静态 import 的
  `src/webview/*.js` 脚本增量更新；脚本按手工 bundle 顺序和
  `window.__agentPivot*` 全局协作。
- `src/webview/*.js` 与 `media/*.js` 必须字节一致；新增脚本、全局或加载边时要
  同 commit 更新 `docs/testing/architecture-webview-manifest.json`。
- 当前 Projects 使用较大的分组卡片；目标改成 VS Code Explorer 式平面、
  紧凑 disclosure list，并继续使用 VS Code theme tokens、系统字体与 Codicon。
- 页面保持一个主纵向滚动容器；Toolbar sticky，Machine/Environment 不建立
  嵌套滚动区。

## 3. 现状问题、重复与测试盲区

| 类型 | 现状 | 重构约束 |
| --- | --- | --- |
| 身份混合 | Group、URI authority、remoteType 共同隐式表达位置 | V2 ID 与本地连接方式分离 |
| 打开 URI | 保存值同时承担同步身份与本机可执行 URI | 由 V2 归属 + local Profile 在打开时生成 |
| 折叠状态 | 普通 Group collapsed 混入同步目录 | Machine/Environment disclosure 全部 local |
| Favorites | 虚拟分组与原 Project 共享实体，行为正确但依赖 Group 形状 | 保留镜像语义，改为显式 view model |
| Tag 上限 | 普通 normalize 会截断到 8 个 | 迁移导入与用户编辑分成两条校验路径 |
| Remote 解析 | Host、Dev Container、WSL/unknown 分散由 URI 推断 | 集中为 migration parser 与 launch planner |
| Webview 状态 | 多脚本共享全局、DOM 状态和后端刷新 | 单一 Projects view model + 声明式消息合同 |
| 打开状态 | 命令接受与窗口实际连接容易混淆 | pending、handed-off、registered 三类事实状态 |

现有测试覆盖 V1 合并、ProjectService、tags、favorites/order、打开匹配、URI
编码、webview 增量刷新与浏览器交互；以下行为尚缺少专门 characterization：

1. 同一逻辑 Machine 在两个 UI Client 使用不同 SSH alias，且同一 Client 的
   Local/SSH/Dev Container workspace Extension Host 能读取同一 Profile；
2. Host 空窗口命令被接受，但 registry 永远没有回报；
3. 嵌套 SSH Dev Container 从 legacy URI 还原父 Machine 与稳定 launch anchor；
4. Group → tag 后超过 8 个 tag 的无损保存及非 tag 编辑；
5. 双客户端离线迁移后确定性收敛，以及 Project 归属冲突；
6. downgrade projection 的 UI Client 隔离、V1 backend materialization 和重新升级三方比较；
7. filter/search 期间折叠、滚动、焦点恢复及 Favorites 唯一计数；
8. 280px 以下宽度、高对比度、200% zoom 与完整键盘路径。

这些测试必须先于对应生产切片建立。

## 4. 关键任务流程合同

### F1 — 从 Machine 打开 Host

```text
展开/收起 Machine（左侧 disclosure）
        │
点击右侧 Open in New Window
        │
        ├─ 无本地 Profile → Set up → 选择 Save 或 Save & Open
        ├─ Remote-SSH 缺失 → 保存 Machine + 提供安装入口
        └─ 有 Profile → vscode.newWindow(remoteAuthority)
                         │
                         ├─ 直接异常 → Failed + Retry
                         └─ 命令返回 → Finish connecting in the new window
                                        └─ registry 可见时升级为 N windows
```

Machine 行拥有 Host 打开与 Host 状态；Host Environment 行只负责 disclosure。

### F2 — 从新的 VS Code 安装实例配置已同步 Machine

1. 同步目录完整展示 Machine、Environment、Project，Machine 标记
   `Not configured in this VS Code`。
2. Machine 行的 `Set up` 打开表单；`Save` 与 `Save & Open` 都只在 UI bridge
   创建当前 VS Code 安装实例的 Connection Profile，不修改 V2 Machine
   身份，不移动 Project，不把 SSH target 同步出去。
3. 表单明确显示旧/新 target、保存范围和“不会影响其他 VS Code 安装实例”；
   Cancel、校验失败和 Remote-SSH 缺失均不产生半条 Profile。
4. 只有用户选择 `Save & Open` 才在保存后重算打开计划并发起新窗口；选择 Save
   留在当前窗口。窗口连接失败不回滚已保存 Profile。Rebind 使用相同按钮合同。

### F3 — 保存当前 Project

1. 根据当前 workspace URI 尝试匹配已知 Machine/Environment。
2. 只有唯一可靠匹配时才能预选；无匹配或歧义时让用户选择/创建 Machine。
3. 展示最终 `Machine / Environment / normalized path` 预览。
4. 以 `environmentId + normalizedPath` 判重；不同 Machine 的相同路径独立保存。

### F4 — 打开 Dev Container

```text
Dev Container action
        │
        ├─ parent Machine 未配置 → Set up Machine
        ├─ launch anchor 缺失/失效 → Needs Setup → Reconfigure
        └─ 完整 → Starting… → VS Code 接受 → Finish connecting…（status）
                                      └─ registry 可见 → N windows
```

30 秒只结束当前窗口的 pending 状态，不宣称容器启动失败。Retry、Update
configuration 与 Open Remote logs 始终保留。

### F5 — Tag AND 过滤与搜索

- `Tags (N)` 打开 checkbox 面板，固定 `Matches all`；选择即时生效，Done/Escape
  只关闭并保留选择，结果摘要旁唯一的 Clear filters 清空全部 tag。选择
  `api` + `active` 时只显示
  同时含两者的 Project。
- Tag-only 过滤不隐藏 Machine；0 命中时压成一行 `0 matches`，仍可展开查看
  Host/Dev Container Environment 并执行打开，但不显示不匹配 Project。
- 文本搜索可隐藏无关 Machine；可见公式严格为：
  `allSelectedTags && (projectText || parentMachineText || parentEnvironmentText)`。
- Clear 恢复过滤前的 disclosure、滚动与焦点；Favorites 不重复计数。

### F6 — Rebind 与 Move

- SSH alias 变化：`Rebind in this VS Code`，只改 UI bridge local Profile。
- 用户确认是另一台逻辑 Machine：`Create Separate Machine`，再通过显式 Move
  向导迁移 Environment/Project。
- Move 先预览每个 path 和 launch anchor，在单个 V2 document mutation 中提交；
  失败不改变原归属，并发 placement/delete 冲突进入 Review。

### F7 — V1 迁移、回滚与插件降级

```text
V1 authoritative
      │ read-only shadow migration + preview
      ├─ failure/cancel ───────────────► V1 unchanged
      └─ confirm recoverable commit
             │ journal → snapshot/report → candidate envelope → active envelope
             ▼
       V2 authoritative
             │
             ├─ catalog rollback → recovery copy first
             └─ Prepare for Downgrade
                    ├─ V2 recovery copy
                    ├─ UI-bridge projection (backup/re-upgrade only)
                    ├─ local backend → target workspace-host materialization
                    ├─ synced backend → shared safe compatibility subset
                    └─ old V1 reads backend materialization, never bridge data
```

重新升级时比较原 V2 revision、降级投影与降级后的 V1 数据；关系默认保留 V2，
V1 变化逐项 Apply V1 change / Ignore V1 change / Create recovery copy。

## 5. 目标架构与所有权

### 5.1 数据流

```text
     selected catalog backend (`storeProjectsInSettings`)
┌───────────────────────────────────────────────────────────────┐
│ synced V1/V2 keys  OR  workspace-host-local V1/V2 keys        │
│           │                                                   │
│           ▼                                                   │
│ Migration / Compatibility / Backend-switch Coordinator        │
│           │ journal → candidate envelope → active envelope    │
│           ▼                                                   │
│ V2 Domain + Merge: Machine → Environment → Project            │
└──────────────────────────┬────────────────────────────────────┘
                           ▼
                  ProjectCatalogV2Service
               single document mutation boundary
                           │
              ┌────────────┴─────────────┐
              ▼                          ▼
     ProjectsViewModel           EnvironmentLaunchPlanner
                                           ▲
                                           │ validated protocol
┌──────────────────────────────────────────┴────────────────────┐
│ UI companion bridge (`extensionKind: ui`)                     │
│ client ID · Connection Profiles · view state · recovery       │
│ journal/copies · downgrade projection                         │
└───────────────────────────────────────────────────────────────┘
              │                          │
              ▼                          ▼
       Dashboard Webview         Open-window registry/bridge
```

### 5.2 建议模块边界

文件名是实施时的目标，不是要求一次搬迁现有代码。

| 所有者 | 建议位置 | 唯一职责 |
| --- | --- | --- |
| V2 domain | `src/projects/catalogV2/types.ts`, `identity.ts`, `validation.ts`, `merge.ts` | document envelope、字段版本、tombstone、conflict、ID；不依赖 VS Code |
| Catalog backends | `src/projects/catalogV2/syncedStore.ts`, `workspaceLocalStore.ts` | 相同 self-contained revision envelope 的两个可替换 backend；不保存 Profile |
| Compatibility | `src/projects/catalogV2/migration.ts`, `downgrade.ts`, `commitProtocol.ts` | V1↔V2 转换、报告、journal 与 activation pointer；不渲染 UI |
| Catalog façade | `src/services/projectCatalogV2Service.ts` | 所有 V2 mutation 的单入口与可恢复提交编排 |
| UI-local state | `extensions/attention-ui-bridge/src/projectClientStore.ts` | globalStorageUri 中的跨进程锁 + 原子 Client state 文件保存 client ID/Profile；globalState 仅作旧数据导入/recovery 索引；另存 journal、recovery 和 downgrade payload |
| UI bridge protocol | `shared/attention-bridge/projectClientProtocol.ts` | 版本/capability handshake、请求响应 schema、严格校验 |
| Profile client | `src/projects/connectionProfileClient.ts` | 通过 bridge 协议取值；workspace extension 不直接持久化 target |
| Launch planning | `src/projects/environmentLaunchPlanner.ts` | V2 归属 + Profile + anchor → 可执行动作/修复原因 |
| Runtime projection | `src/projects/environmentRuntimeProjection.ts` | pending/handoff/registry 事实映射；不做网络探测 |
| Presentation | `src/projects/projectsViewModel.ts` | Favorites 镜像、过滤、搜索、排序、状态槽优先级 |
| Host controllers | `src/projects/*Controller.ts` | Add/Rebind/Move/Migrate/Downgrade 命令编排 |
| Webview | `src/webview/webviewMachineProjectsScripts.js` + `webviewContent.ts` | disclosure、焦点、popover、增量 DOM；不持有目录真相 |

边界规则：

1. domain/persistence 不 import `src/webview`、dashboard 或 VS Code UI。
2. 只有 UI bridge 的 `projectClientStore` 可以持久化本地 target；workspace-side
   client 只接收校验后的值。同步/local catalog serializer 对 profile 字段执行
   fail-closed 校验，bridge capability/version 不匹配时显示 Setup unavailable 而不猜测。
3. 只有 V2 service 写目录；webview 发送带 `requestId` 的意图并收到明确结果。
4. 打开 URI 只由 launch planner 生成；包含 alias 的 legacy URI 仅在 UI bridge
   recovery 或已有 V1 backend 中保留，不能进入 V2 身份或新 synced 字段。
5. Favorites、过滤和 search 只产生投影视图，不复制或修改 Project 实体。
6. 每个新 webview global、producer/consumer 与脚本顺序都登记进 architecture
   manifest；`src/webview` 变更后由构建生成 `media` 镜像。

### 5.3 存储键与权威切换

建议通过常量集中声明实际 key；这里定义语义而不锁定字符串：

| 数据 | Scope | 切换前 | 切换后 |
| --- | --- | --- | --- |
| V1 catalog | selected synced 或 workspace-host-local backend | authoritative | compatibility/recovery only |
| V2 catalog | 同一 backend 下的独立 V2 key | shadow/read-only | activation pointer 指向后 authoritative |
| V2 backend envelope | selected catalog backend 的单一 V2 key | candidate/active/previous slots，V1 active | pointer 与 checksummed document 同 envelope，validated V2 active |
| Synced writer replica | workspace-writer local state | shadow reconcile | 保存已验证 envelope/未确认 mutation，与 Settings Sync causal merge；不是 Client Profile |
| Client ID / Connection Profiles | UI bridge globalStorageUri 版本化 Client state（跨窗口锁、原子 rename、不注册 sync） | active for flag path | active |
| Disclosure/filter view state | UI bridge globalState + ephemeral webview state | flag path only | active |
| Prepare journal / recovery copies | UI bridge globalStorageUri + checksummed globalState index | shadow report | migration/backend-switch/downgrade/conflict |
| V1 downgrade projection | UI bridge local authoritative copy | absent | 仅 Prepare 后生成 |
| V1 legacy materialization | selected V1 backend | current catalog | 仅安全可表达项；synced backend 不注入新 alias |

`storeProjectsInSettings=false` 时，整个 V2 catalog 继续使用 workspace Extension
Host 的 local backend；不能只同步 Machine 而把 path 拆到本地。开关变化使用同一
V2 merge + prepare journal + activation pointer 迁移 backend，失败时原 backend
保持权威。UI bridge 的 Profile 永不随开关移动。

## 6. 先验证的技术探针

以下探针是进入各生产切片的硬门槛，不作为独立 PR：

| Probe | 要证明什么 | 结果/下一步 |
| --- | --- | --- |
| P1 V2 key isolation | V1 parser/旧版本写入不会覆盖 V2 | 已确认 V1 parser 只接受 schema 1；实现时加双 key fixture |
| P2 UI bridge profile isolation | 两个 UI Client 可对同 Machine 存不同 alias；同一 Client 的 Local/SSH/Dev Container workspace host 读到同一 Profile；catalog 零泄漏 | 在 bridge 先加版本化协议、capability handshake、真实跨 Extension Host contract |
| P3 Host handoff | 空 Host 新窗口可发起，但无 registry 回报也能回到可重试 Idle | 现有 bridge 已能 `newWindow`；加 fake clock/controller test |
| P4 nested Dev Container | shadow migration 前确认 legacy nested authority 能否提取父 SSH 与稳定 anchor | 以现有 authority、本地 devcontainer fixture 和反例建 golden corpus；失败从首次迁移即固定 legacyRemote |
| P5 deterministic migration | 双客户端从相同 V1 生成相同 migration IDs | 固定 UUID namespace、canonicalizationVersion 与字节级 golden corpus |
| P6 V2 concurrency/recovery | causal field merge、placement/delete conflict、tombstone、resolution 与 revision fallback 收敛 | `A→B`/`A||B`、同一 UI Client 两 workspace writers、旧候选不复活、缺失/损坏 active、乱序 envelope + 每个 journal 步骤 crash injection |
| P7 backend/downgrade isolation | backend 开关和 Prepare 不改错权威数据、不把新 alias 写入 synced projection | synced/local/bridge 三 store + 真实旧 V1 materialization/重启测试 |
| P8 webview focus stability | nested list 每行一个 Tab stop、Shift+F10 等价动作、refresh/filter/collapse 后焦点/滚动恢复 | 浏览器 + NVDA/VoiceOver structure fixture 覆盖 Tab/Shift+F10/menu/Escape、无 tree roles、260/300/360px 与 200% zoom |

P4 是 shadow migration 的前置门槛：在生成任何 Machine/Environment 迁移身份前，必须用仓库
现有嵌套 authority、至少一个本地 devcontainer fixture 和不能可靠拆解的反例，
确认 launch anchor 格式。若不能稳定恢复，就从首个 V2 revision 起保留稳定的
`legacyRemote + Needs Setup`，后续只允许显式 Reconfigure 新建/修复，不静默换 ID。

## 7. 单 PR 内部实施顺序

全部功能在当前分支完成并通过 Owner 验收后才创建一个最终 PR；Milestone 安装包
只用于本地验收，不等同于合并或发布。以下是同一分支上的逻辑 commits 和验收点。
最终 PR 不依赖旧版本预先认识 upgrade flag：V1/V2 key 隔离，旧版本修改进入
recovery review，绝不取得 V2 写入权。

### Milestone 1 — 方案合同（当前）

交付：PRD、任务流程、线框、现状数据流、模块边界、probe、验证矩阵。Owner
确认后才进入生产代码。

### Milestone 2 — V2/Host 完整纵切（feature flag 默认关闭）

建议 commits：

1. `test: characterize project catalog and extension-host boundaries`
2. `feat: add ui-local project client profiles and bridge protocol`
3. `feat: add isolated v2 catalog merge and recoverable commits`
4. `feat: add shadow migration and recovery reports`
5. `feat: add machine host projects view behind a feature flag`
6. `feat: preserve favorites and tag filtering in the machine catalog`

验收包：本地安装的 VSIX、正常 Host、未配置新客户端、Favorites、AND tags、
Group→tag、窄宽度与 migration preview。Owner 验收通过后继续 Dev Container。

### Milestone 3 — Dev Container、切换与恢复闭环

建议 commits：

1. `feat: add stable dev container launch anchors`
2. `feat: add catalog move and repair workflows`
3. `feat: add v2 activation rollback and downgrade preparation`
4. `test: harden machine catalog accessibility and recovery`

验收包：停止容器启动、Needs Setup/Reconfigure、跨客户端 alias、Move、可恢复
activation、rollback、Prepare for Downgrade 与 re-upgrade review。

### Final hardening — 仍在同一分支

- 全量回归、coverage/architecture gates、真实 VS Code dogfood、文档与 release
  notes；删除只对 feature flag 后的不可达旧 UI 做最小清理。
- Owner 明确完成整个功能验收后，才提交一个 draft PR 到 `hzcheng/agent-pivot`；
  PR body 包含 Skill harvest 与
  Owner approvals；checks 全绿且 mergeable 后再请求最终 owner approval。

## 8. Commit 级验证矩阵

所有命令通过 worktree lock 执行：

| 变更类型 | 必跑 |
| --- | --- |
| 任意 commit | `npm run test-compile`、focused tests、`git diff --check` |
| V2 domain/store | V1/V2 parser、field merge、tombstone、conflict、identity、crash injection、profile leak tests |
| Migration/downgrade | 双客户端、跨 Extension Host、幂等、冲突、超长/超量 tag、backend switch、recovery fixtures |
| Host/Dev Container open | controller + bridge contract + timeout/failure fake-clock tests |
| Webview | dashboard webview checks、browser focused tests、asset identity |
| webview global/module | `npm run test:architecture-policy` + manifest mutation test |
| 行为合同 | `npm run test:behavior-contracts` |
| Milestone 安装包 | `npm run install-local`，Owner 在真实 VS Code 验收 |
| Final PR | lint、coverage CI、Linux CI 等价套件、Windows path tests、merge checks |

## 9. 明确拒绝的替代方案

| 方案 | 不采用原因 |
| --- | --- |
| 一次性把 V1 原地改成 V2 | 旧 parser 与混版客户端可能覆盖新关系，无法安全回退 |
| 用 SSH alias 作为同步 Machine ID | alias 是当前客户端的连接方式，不是跨设备逻辑身份 |
| 每次渲染从 URI 动态生成 Machine | rename、排序、空 Machine、Move、冲突与本地绑定都无法稳定表达 |
| 直接把旧 Group 改名为 Machine | Group 表达用户分类，不能可靠证明物理/逻辑位置；会误归属 Project |
| V2 与旧客户端静默双向写 | V1 无法表达 Environment/Profile，双写会产生有损 last-write-wins |
| 用网络探测显示 Online/Connected | 插件无法可靠观测认证、Host Key、容器完成状态，容易误导 |
| 为层级引入大卡片或完整 ARIA tree | 降低侧栏信息密度；首期交互模型不满足 ARIA tree 全套键盘合同 |

## 10. Milestone 1 验收清单

Owner 验收时只需要确认以下五点：

1. 平面层级和主操作位置是否符合预期；
2. 未配置 Machine 与 Dev Container Needs Setup 是否足够清楚；
3. Tag AND 过滤下保留 Machine、压缩 0 matches 是否可接受；
4. Migration / Prepare for Downgrade 是否给了足够可逆性；
5. 全部功能验收后才创建单个最终 PR、期间只交付本地安装包的节奏是否合适。

通过标准：Owner 明确同意 Milestone 1，且 P4 的“无法可靠恢复就 Needs Setup”
降级策略没有异议。之后才开始 characterization tests 与 V2 数据层。
