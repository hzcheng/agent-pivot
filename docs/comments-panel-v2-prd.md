# Comments 面板 v2 改造方案（PRD）

日期：2026-08-22

状态：草案（讨论定稿 + 三路评审修订，待实现）

关联文档：`project-scoped-comments-prd.md`（本文 §7 的作用域决策取代其 §6.1/§7 的 projectId 键控方案）

修订记录：

- 2026-08-22 初稿（四项决策讨论定稿）。
- 2026-08-22 经三路评审（技术准确性 / 产品交互 / 测试与分期）修订：纠正「广播 re-scope」表述（当前无广播机制，窗口级后靠 restore-on-switch 天然同步）；迁 key 改为惰性检测；正向流改为对称 composer 流（现状 🔖 是开 composer 而非直存）；补 a11y 规约、合并超限策略、pill 口径漂移说明、契约清单勘误与 CI 守卫清单。
- 2026-08-22 按设计实现文档（`comments-panel-v2-design.md`）评审回签：§6 pill 触发挂钩勘误（经核实 `projectStack.afterSettle` 已覆盖，无需补挂钩）；§7.3 迁 key 机制对齐设计（restore/enqueue 前惰性检测 + globalState alias 表领养 + empty-window 双向豁免）；§8 更名边界明确为「线协议字符串冻结」；§4.4 键盘改自动激活；§9.4/§10 P2 不拆脚本。

## 1. 背景

Conversation viewer 的 Comments 侧边栏目前承载两套评论栈：Session 批注（引用批注 + Session note，按 `(projectId, provider, sessionId)` 存储）与 Workspace 笔记（按 `projectId` 存储）。实际使用中暴露出四个问题：

1. **双区上下堆叠**：Workspace 区与 Session 区共享 192–420px 宽的面板，中间以 sash 分隔，互相压缩空间；为了「挤」还引入了分区折叠、高度持久化、统一过滤条等补丁层。
2. **卡片不可折叠**：open 卡片无条件全文渲染，正文与 quote 各可达 4000 字素，长评论使列表不可扫读。
3. **遥测 pill 只显示 Session 计数**：Workspace 笔记的数量完全不可见；tab 化之后被隐藏的栈将彻底失去环境感知。
4. **Workspace 笔记作用域错误**：按 `projectId`（单个物理 checkout）键控，与用户心智模型不符——用户期望它是**窗口级随笔**：同一窗口内无论切到哪个 worktree、哪个 session 的 viewer，看到的都是同一批笔记。且当前实现下，主 checkout 与各个 worktree 的笔记互相隔离。

## 2. 目标

1. **子 tab 化**：侧边栏 Comments 面板内 Session / Workspace 两个子 tab 互斥展示，各自独占面板全高。
2. **卡片自动截断**：长正文与长 quote 自动 clamp，溢出时提供展开/收起。
3. **pill 双计数**：遥测条 comments pill 显示 `Session open 数 · Workspace open 数`。
4. **窗口级作用域（方案 C+）**：Workspace 笔记按 `navigationIdentity` 键控，窗口内共享；增删 workspace 根目录不丢笔记。

## 3. 非目标

- 不做回复线程、富文本、@提及。
- 不改动 Session 批注的生命周期语义（done=已发送、编辑自动重开等维持现状；「done 与发送焊死」「send 只是暂存未提交」等定位问题已记录，留作后续独立议题，见 §11）。
- 不做跨窗口共享笔记；不做派发到多 session 的广播（沿用原 PRD 的 P2 候选）。
- 不解决「重命名/移动 `.code-workspace` 文件本身」的身份缝隙（见 §7.4，明示为已接受的残余风险）。
- 不迁移 Session 批注的存储（仅 Workspace 笔记换 key）。

## 4. 子 tab 化

### 4.1 布局

```text
Comments 面板
┌──────────────────────────────────┐
│ [ Session ·2 ] [ Workspace ·3 ]  │  ← 子 tab 条，标签自带 open 计数
│ (全部) (Open·2) (Done·1) (bug·1) │  ← 当前 tab 自己的过滤行（各自 tag 词汇表）
│ ┌──────────────────────────────┐ │
│ │ 当前 tab 的卡片列表（全高）    │ │
│ │ …                            │ │
│ └──────────────────────────────┘ │
│ [composer：由 ＋ 或选区气泡打开]   │
└──────────────────────────────────┘
```

- 面板顶部新增 tab 条；tab 标签格式 `Session ·N` / `Workspace ·N`，N 为各栈 open 数，与 pill 口径一致（§6）。
- 过滤行从「两栈统一」拆为**各 tab 独立**：Session tab 过滤 session 批注及其 tag；Workspace tab 过滤 workspace 笔记及其 tag。消除现有统一过滤条跨作用域混排 tag 的含糊语义。
- 每 tab 保留自己的区头操作行（＋ 新建、✈ 批量发送、清除已完成、清空），语义与现状一致。

### 4.2 删除的存量机制

- 双区间可拖 sash（`data-comments-section-sash`，`viewerDocument.ts:431-436`）及其高度持久化；
- 分区折叠/展开状态（`data-comments-section-toggle`）及其持久化；
- 统一过滤条（`data-comments-filter-bar` 的双栈 chip 聚合逻辑）；
- `expandSessionSection` 等堆叠布局专用辅助。
- **同步必改**：`conversationViewerScripts.js:259-265` 把 `commentsSectionSash` 列为 `commentUiAvailable` 的必要元素——删 sash 必须同步改此 gate，否则整个 comments UI 静默不可用。

### 4.3 tab 状态与跨 tab 操作（对称 composer 流）

- 激活 tab 持久化于 webview state（`vscode.setState`）；存量 state 无 tab 字段时**缺省为 Session tab**。
- **正向**（Session tab 中通过选区气泡 🔖 存 Workspace 笔记）：现状是打开 Workspace composer（quote 作为 source 快照带入、正文必填），**不是直存**。tab 化后保持该语义：**自动切换到 Workspace tab 并打开 composer**，用户写正文 + tag 后确认。
- **反向**（Workspace tab 中通过选区气泡 💬 写 Session 批注）：自动切换到 Session tab 并打开 composer（现状行为，保持不变）。
- **两个方向对称**；任一方向在 composer 中 **Esc 取消后返回之前激活的 tab**（新增「切 tab 前的 tab」记忆，仅此路径使用），避免单向的上下文跳变。
- pending 期间允许切 tab（`setStackPending` 只禁用本栈控件，天然支持）；settlement 到达时若目标 tab 处于隐藏状态则**跳过焦点恢复**（现状 `focusStackDragHandle` 落在隐藏元素上会静默失败）。
- 切 tab 即复位 clear-all 两步确认态（与现状「每次渲染复位」的行为对齐）。
- 打开面板的默认 tab：上次激活的 tab（pill 点击、Esc 重开均遵循）。

### 4.4 可访问性规约

- tab 条：`role="tablist"`；tab：`role="tab"` + `aria-selected` + roving tabindex；面板：`role="tabpanel"` 并 `aria-labelledby` 指向激活 tab。
- 键盘：←/→ 方向键在 tab 间移动焦点并激活（自动激活模式）；全部既有交互保持键盘可达（沿用原 PRD §10 约定）。
- 瞬时/状态文案统一复用现有 `data-conversation-status` 元素（`aria-live="polite"`，viewerDocument.ts:211），保证读屏可达。

### 4.5 前端结构收益

一次只渲染一个栈，渲染逻辑可按 tab 分界拆分；双栈「半参数化」的平行实现（渲染、composer、tag 编辑器、done 展开）获得天然的模块边界。本项是前端 `conversationCommentsScripts.js`（3303 行单体闭包）拆分的第一步。**拆分新脚本受 `checkWebviewManifest` CI 守卫约束**：命名须匹配 `conversation[A-Za-z]+Scripts.js`、登记进 `docs/testing/architecture-webview-manifest.json`、`viewerDocument.ts` 按同序发出（见 §9.4）。

## 5. 卡片自动截断

- **正文** max-height 约 6–8 行、**quote** 约 2–3 行（quote 仅是上下文参考）；溢出时内容渐隐并显示「Show more / Show less」切换。
- 仅当内容真实溢出时才显示切换按钮（渲染后测量，不污染短卡片）。
- 展开态为内存态（复用现有 `expandedDoneComments` 同款 Set 模式），不落盘、不跨 webview 恢复。
- 编辑态 textarea 不参与截断；done 卡片维持现有「默认折叠单行 + chevron 展开」行为不变。
- Session 卡片与 Workspace 卡片共用同一截断机制。
- **locate/reveal 联动**：`revealCommentCard` 定位到被截断的卡片时，自动将其加入展开 Set（与 done 卡自动展开行为对齐）。
- **实现硬约束**（违反即打破既有测试）：
  - 截断必须是 CSS 级（max-height/overflow + 渐隐遮罩），**不得裁剪 DOM 文本**——既有测试依赖 blockquote/body 的 textContent 全文；
  - Show more 按钮**不得落入** `.conversation-comment-actions`，**不得带** `data-comment-action`/`data-project-comment-action`（既有 cardActions deepEqual 断言），并带 `aria-expanded`；
  - P1 新增截断测试只锚卡片级 selector（`[data-comment-id]` 内部结构），不依赖 section 上下文，保证 P2 后幸存。

## 6. Telemetry pill 双计数

- 格式：`S · W`——S = 当前 session 的 open 批注数，W = Workspace 笔记的 open 数。两侧均只显示 **open** 口径（pill 的职责是「还有多少待处理」，done 为历史噪音）。
- tooltip/aria-label 携带完整信息，如 `2 open session comments · 3 open workspace notes — click to review`（可附总数）。
- **口径漂移说明**：P1/P2 阶段存储仍按 projectId 键控，W 的实际口径是「当前 project 的 open 数」；P3 作用域切换后 W 才成为「当前窗口 open 数」。行为契约按分期各自更新，P1 不把窗口口径写进契约。
- `0 · 0` 照常显示，pill 恒可见（现状如此，因其兼任面板入口）。
- 点击行为：打开 Comments 面板并定位到上次激活的 tab。
- **实现要点**：
  - 计数计算为纯前端（webview 已同时持有 `state.comments` / `state.projectComments`），无需消息协议改动；
  - 但 pill 初始 markup 在 host 侧（`conversationTelemetryController.ts:453-461`，初始 `0` 与 aria-label），需同步改为 `0 · 0` 与新文案——故 P1 并非「零 host 改动」；
  - 现有 pill 更新由 `updateCommentControls`（conversationCommentsScripts.js:505-535）统一执行；经全路径核实，project 结算路径已由其栈描述符的 `afterSettle` 回调覆盖，**无需新增触发挂钩**（浏览器测试兜底验证即可）；
  - 现有 `open/total` 格式废弃，**7 处既有浏览器断言同 PR 更新**（tests/browser/conversationViewer.test.js:5609、5638、7605-7606、7673-7674、7743-7744、7926-7930、8193-8197）。

## 7. Workspace 笔记窗口级作用域（方案 C+）

### 7.1 身份模型

存储 key 从 `sha256(projectId)` 改为 **`navigationIdentity`**（`src/workspaces/contextResolver.ts:99-113` 现成计算）：

| 窗口形态 | navigationUri | key 来源 |
| --- | --- | --- |
| 单文件夹 | 文件夹 URI | `createWorkspaceUriIdentity(folderUri)` |
| 已保存多根工作区 | `.code-workspace` 文件 URI | `createWorkspaceUriIdentity(workspaceFileUri)` |
| 未保存多根工作区 | `untitled:Untitled-N.code-workspace` URI | 同上（VS Code 重启后恢复同一 untitled 标识；实现期以手动测试验证，docs/manual-tests） |
| 空窗口 | — | 哨兵桶 `'empty-window'`（`src/openWorkspaces/dashboardController.ts:367-368` 的现有约定；多个空窗口共享此桶，场景罕见，明示接受） |

用户心智模型：**身份就是那个文件（或文件夹）**。已保存的多根工作区里随意增删仓库，文件不变 → key 不变 → 笔记不丢。

### 7.2 存储与同步

- 存储目录：`globalStoragePath/workspace-comments/v1/<navigationIdentity>.json`，文件格式沿用 `{ version: 1, target, revision, updatedAt, comments }`，原子写/损坏降级/上限策略不变（复用 `KeyedSnapshotFileStore`）。
- host 侧 target 类型由 `ProjectCommentTarget { projectId }` 改为工作区目标（字段更名，payload 结构不变）；**webview 消息协议不变**——key 完全由 host 决定（`toStoreTarget` 现为 host 侧派生，`projectCommentController.ts:76-80`），前端对 target 无任何依赖。
- **同步机制（评审纠正）**：当前实现每窗口**单例 viewer**（`composition.ts:384`），不存在任何跨 viewer 广播机制（原 PRD 设计了同 projectId 广播但未落地）；「同步」靠切 session 时 restore 从磁盘重读（restore-on-switch）与本 viewer settlement 回传。窗口级键控后，viewer 切到任意 project 的 session 时 Workspace tab 因 key 相同而天然看到同一批笔记——**无需新建 fan-out 机制**，§9.2 对应契约写为「同一 viewer 切换到另一 project 的 session 后 Workspace 笔记一致」。
- Session rebind：Workspace 笔记豁免 rebind 拷贝，行为不变（现状：`conversationStack.ts:73-98` 只给 comment/bookmark store 包 rebind resolve）；该豁免目前无测试锚定，P3 补断言。

### 7.3 转换时迁 key（惰性检测）

**触发方式（与设计文档 D7 对齐的最终版）**：不做事件监听——增删根目录有 `onDidChangeWorkspaceFolders`（dashboard.ts:3104-3107），但 Save Workspace As 不触发任何公开事件。迁 key 挂在 **Workspace 栈的 restore/mutation enqueue 前惰性检测**（controller 层单点，天然串行）：比较「上次使用的 key」（内存 lastKey）与当前 `navigationIdentity`，不一致即迁移。host 重启后内存 lastKey 丢失，由 **globalState alias 表**兜底：转换瞬间追加 `{from, to}` 定向记录，启动时当前 key 无文件则按 `to === 当前` 查表领养，无命中不猜测（不扫描目录领养陌生文件）。**`'empty-window'` 双向豁免迁 key**（既不作 source 也不作 destination，避免 Close Workspace 时把笔记迁入共享桶）。以下平台行为以手动测试验证（docs/manual-tests）：增删根目录不 reload 窗口；untitled/saved 工作区删到剩 1 根时 workspaceFile 存活（kind 不变、key 不变）；Save Workspace As 为就地转换（`savedWorkspaceProjectAdapter` 有代码旁证）。

**迁移规则**：

- 旧 key 文件存在、新 key 文件不存在 → 原子 rename 到新 key；
- 两侧文件均存在（罕见）→ 按 comment id 合并，同 id 取 `updatedAt` 较新者；
- 迁移期间拒绝对 Workspace 笔记的写操作：`ProjectCommentController` 需**新补** `freezeMutations`（现状仅有继承来的 drain；`commentController.ts:92-99` 有 freeze 范例可仿）。
- **合并/迁移超限策略**：合并后条目可超 50 条、tag 词汇表可超 20 个——**全部保留，不淘汰任何已有条目**；仅在新超过上限时禁止「新增条目/新增陌生 tag」，回落至限内后自动恢复（与现有限额语义一致：`projectComments.ts` 的校验只拦新增）。

### 7.4 已接受的残余缝隙

1. 重命名/移动 `.code-workspace` 文件本身（或重命名单文件夹本身）= 新身份，旧笔记文件留在磁盘但 UI 不可达。任何 URI 键控方案皆然，文档明示。
2. 未保存的多根工作区被直接关窗丢弃 → untitled 标识失效，笔记成为磁盘孤儿（VS Code 关窗前会提示保存工作区，场景罕见）。
3. 多个空窗口共享 `'empty-window'` 桶——与窗口级心智略有出入，但空窗口开 session viewer 的场景罕见，明示接受。

### 7.5 存量迁移

现有笔记按 `projectId` 存于 `project-comments/v1/`。存量迁移为**惰性一次性迁移**（首次使用 Workspace 栈时执行，与迁 key 共用串行冻结点，避免与正常写入互相覆盖）：收集本窗口已知 session 所属 project（tmux 运行绑定与活跃 runtime 携带的 cwd 经规范化路径匹配到注册项目，`tmuxRuntimeBindingStore.ts:150-172`；`CurrentWorkspaceSessionAuthority.getProjectId` 可映射 legacy id）的笔记文件，按 id 合并写入当前窗口 key，成功后删除旧文件。已知盲区：注册项目的 projectId 是随机 id（`models.ts:52-56`），项目被移除重加后 id 改变，对应旧文件无法归属——保留在磁盘，不做全量扫描归并。

迁移是有提示的语义突变（主 checkout 与各 worktree 原先隔离的笔记会同屏出现）：CHANGELOG 说明 + 迁移后首次打开面板时一次性 dismissible 提示（复用状态行）。

## 8. 术语与文案

- UI 标签保持 **Workspace**（作用域改为窗口级后名副其实）；Session tab 保持 **Session**。
- 内部标识符从 `project-comment*` 更名为 `workspace-comment*`，范围 = **宿主端 TS 类型/文件/store 目录**（target 类型即「消息目标」的 TS 定义随之更名）；**线协议字符串（消息 type、envelope 的 `projectId/provider/sessionId` 路由字段）、webview state key、契约 id 全部冻结**（它们是测试/协议/持久化的稳定锚，更名无功能收益）。更名随 P3 进行，**须同步 `behavior-contracts.json` 的 owners/evidence 路径与 `docs/testing/architecture-modules.json` 的模块登记**（CI 守卫，见 §9.4）。
- 空态文案 P3 更新：现 "No workspace notes yet." 可保留，但补充作用域说明「本窗口内所有 session 可见」（原 PRD §9 的「对本项目全部 session 可见」在窗口级下事实错误）；`source` 出处与 `dispatches` 历史在跨 project 查看时**原样展示、不按当前 project 过滤**（数据模型自洽：source 是展示快照、dispatches 只增不减）。

## 9. 测试需求

### 9.1 受影响的行为契约（评审勘误后）

**P1 更新**：

- `CONVERSATION-COMMENTS-LAYOUT-001`：契约承诺 "fully visible cards"（含 `scrollHeight ≤ clientHeight` 断言，conversationViewer.test.js:7017-7026）——该语义在 P1 即被截断改写，**不是 P2**。
- `CONVERSATION-COMMENTS-UI-001`：7 处 pill `open/total` 断言（行号见 §6）。
- `CONVERSATION-TELEMETRY-CONTROLLER-001`：pill 初始 markup 在 host 侧（其 owner 单测目前不断言 pill 文案，不会变红，但 evidence 文件被改，需评估是否补断言）。

**P2 更新**：

- `PROJECT-COMMENTS-UI-001`：最大重写面——sash 拖拽/分区折叠/高度持久化断言（conversationViewer.test.js:5997-6098）、统一过滤条 chips、区头计数。
- `CONVERSATION-COMMENTS-UI-001`：过滤条 chips 与 `conversationCommentsPanelFilter` 单一过滤态持久化断言（7482 测试段）。
- 测试 12081（标题即 "unifies status and tag chips across both card groups"）：「统一」语义被废除，测试意图重写（卡片级断言可保留）。
- 测试 12046（'TMP repro add flow from closed sidebar'，**无契约标签**）：从关闭面板直接点 Workspace 区头 ＋，契约驱动清单天然漏掉它，需人工处理。
- `CONVERSATION-SESSION-REBIND-001`（边缘）：rebind 后卡片可见性依赖缺省 tab 决策。
- `CONVERSATION-OUTLINE-NAVIGATION-001`（边缘）：测试 3859 内嵌 viewer 脚本**逐字片段**做 replace 模拟跨代际——P2 改脚本后 replace 失配**不会变红、只静默弱化**，必须人工核对。

**不更新（评审纠正）**：`CONVERSATION-COMMENTS-DOM-STABILITY-001`（只做 100 次 sidebar toggle，不触碰 sash/过滤条，原样转绿）；`PROJECT-COMMENTS-001`（纯模型契约，与 key/广播无关）。

**P3 更新**：`PROJECT-COMMENTS-CONTROLLER-001`、`PROJECT-COMMENTS-PERSISTENCE-001`（key 与 target 变化）、`PROJECT-COMMENTS-UI-001`（空态/作用域文案）。

### 9.2 新增契约

- tab 切换与激活态持久化（含存量 state 缺省 Session）；tab 键盘导航与 a11y 语义（tablist/tab/tabpanel）。
- 跨 tab 操作：正向 🔖 切 Workspace tab 开 composer、反向 💬 切 Session tab 开 composer、Esc 取消返回原 tab、pending 期间切 tab 跳过焦点恢复、切 tab 复位确认态。
- 卡片截断：溢出才出现切换、展开态内存化、编辑态豁免、两栈一致、reveal 自动展开。
- pill `S · W` 口径（含 `0 · 0` 展示、tooltip 完整信息；P1/P2 为 projectId 口径，P3 起窗口口径）。
- 迁 key：单文件夹↔多根、Save Workspace As（惰性检测）、双文件按 id+`updatedAt` 合并、超限保留+禁新增、迁移期 freeze 拒绝写入。
- 窗口级同步：同一 viewer 切换到另一 project 的 session 后 Workspace 笔记一致；rebind 豁免断言。

### 9.3 测试层分布与落点

- 单元：key 派生与迁 key/合并逻辑（**落点：`projectCommentStore.test.js` 全量重写**，save/load target、目录、空 key 拒绝、跨 key 泄漏防护全部换新）；controller TARGET/target 断言重写 + freeze 新增（`projectCommentController.test.js` 中幅重写）；计数口径。`projectComments.test.js` 等纯模型测试零冲击（仅更名时改 require 路径）。
- 浏览器（playwright）：tab 布局、截断、pill、跨 tab 操作（P1 截断测试锚卡片级 selector）。
- 集成：P3 的「装配 + 迁移 + 切 session 一致性」**无现成 owner 文件**（`conversationRouting.test.js` 零 projectComment 引用），需新建测试文件；`ConversationViewerTarget` 无 navigationIdentity 字段，P3 需新增注入路径（viewer.ts restore / composition.ts 装配 / dashboard.ts）。
- `check-changed-coverage` 硬约束：P3 的 key 派生/迁 key/合并新代码必须配确定性单测。

### 9.4 CI 守卫（改动将触发）

- `check-behavior-contracts.js`：automated 契约的 owner 文件须字面包含契约 id；新契约 id 须符合 `/^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}$/`；P3 文件更名必须同步目录 owners/evidence。
- `test:architecture-policy`（`checkClosedWorld` / `checkModuleBoundaries`）：P3 更名/新增生产文件须登记 `docs/testing/architecture-modules.json`，新模块依赖须落在既有 mayDependOn 内（存量迁移组件因依赖项目目录与 workspace 身份模块，落点 `src/dashboard/sections/`）。
- `checkWebviewManifest.js` 与 `EXPECTED_MAIN_ENTRIES`：**本 v2 不触发**——P2 只做文件内结构重排，不拆分/新增前端脚本（脚本拆分留作 v2 之后的独立任务，届时按命名/登记/发出顺序三件套执行）。
- `media/` ↔ `src/webview/` 字节一致：规范路径是只改 `src/webview/`，由 gulp `copyWebviewAssets` 生成 `media/`。

## 10. 分期

每期独立可发布，契约更新随期走：

- **P1（quick win）**：pill 双计数（§6，含 host 侧初始 markup 与 7 处断言更新）+ 卡片自动截断（§5，含 LAYOUT-001 语义更新）。截断测试锚卡片级 selector。
- **P2（结构）**：子 tab 化（§4）。缺省 tab=Session（存量 state 恢复）；sash 删除同步改 `commentUiAvailable` gate（含区头 count 必要元素）；不拆分前端脚本（文件内重排）；人工核对测试 3859 的钉住片段。
- **P3（数据）**：窗口级作用域（§7）+ 存量迁移 + 术语更名（§8，同步契约目录）。

顺序论证：tab 化后被隐藏栈失去计数可见性，pill 双计数必须先于或随 P2；P3 与前两期正交（数据层），放最后。评审确认 P1→P2 返工面可控（pill 测试不被 P2 触碰；双次触碰仅 7482/7748 两个测试的过滤条段）。

## 11. 开放问题（记录，不在 v2 范围）

- Workspace composer 是否改为常驻输入框（原 PRD「捕获成本极低」的意图 vs 当前 ＋ 开启的实现）；tab 化后空间充裕，值得重议。
- Session 批注「done=已发送」把生命周期与投递焊死；「✈ 实际只是暂存进终端输入框」缺 staged 中间态。
- 引用批注锚点在 compaction/翻页后的失效与孤儿化修复路径。
- 上限余量指示（依赖 §7.3 超限策略先落地）；删除无回收站。
- 批注的导出/复制路径。

## 12. 成功标准

- 同一窗口内 viewer 切到任意 session/worktree 的 session 后看到同一批 Workspace 笔记；对已保存工作区增删仓库后笔记原样可见；合并/迁移不丢任何已有条目。
- 选中输出 → 存为 Workspace 笔记：点 🔖 一次即进入编辑（自动切 tab、quote 带入），Esc 取消返回原 tab，无迷航。
- 长评论场景（面板默认 240px 宽、窗口高约 800px、正文 >8 行的卡片）单屏可见卡片 ≥3 张；短卡片（正文 ≤2 行）渲染与现状零差异。
- pill 恒定展示 `S · W`，与两个 tab 标签计数三方一致。
- P1 后既有 `CONVERSATION-COMMENTS-*` 契约（除 §9.1 列明的 P1 更新项）保持绿；P2/P3 后对应契约完成改写并转绿。
