# AI Hub Redesign PRD

状态：提案。本文定义 Dashboard 顶层 AI tab 的产品目标、用户体验和
MVP 验收范围；技术拆分另行设计。

## 背景

现有 AI tab 同时放入了 Prompt 管理、Skill 文件系统管理，以及 MCP 和
Hooks 的占位页。Prompt 以高卡片和 hover 操作呈现，Skill 则直接暴露
Global/Project 双树、来源目录、链接、复制、冲突和同步等底层概念。

这使用户难以完成两件最重要的事：快速把合适的 Prompt 用到当前任务中，
以及在需要时把一个全局 Skill 启用到当前项目。

AI tab 不是 OPEN 中的活跃会话视图。它的定位是：**全局 AI 资产工作台**。
OPEN 继续承载会话、终端和运行状态；AI tab 是全局 Prompt library 和
Global Skills library 的维护入口。当前项目只是在使用或启用资产时提供上下文，
不是这些资产的默认所有者。

## 目标

1. 用户在 10 秒内找到并将一个 Prompt 插入活动终端。
2. 用户能为一个功能建立 Prompt group，并以清晰的顺序组织 Plan → Implement
   → Review 等 Prompt。
3. 用户一眼看清全局有哪些 Skills；在需要时进入某项目上下文，查看分别可供
   哪些 Agent 使用并快速启用或关闭。
4. 用户可从明确来源安装、导入或创建 Skill；安装后立即决定是否用于当前
   项目及哪些 Agent。
5. 在 300–340px 的 VS Code 侧栏中保持紧凑、原生、可访问且赏心悦目的
   界面。

## 非目标

- 不在 v1 自动连续执行一个 Prompt group，也不隐式向终端发送多段文本。
- 不在 v1 引入 Prompt 变量、条件分支、跨会话执行器或团队协作同步。
- 不在 v1 提供远程 Skill 市场评分、自动更新或复杂推荐算法。
- 不修改 OPEN 的 AI Sessions / CHATS / ALL 体验。
- MCP、Hooks 在具备明确内容和任务模型前不作为可用一级页面。

## 核心术语与状态模型

### Prompt 与 Prompt group

- **Prompt**：全局可复用的文本模板，含名称、用途说明和正文；v1 中每个
  Prompt **恰好属于一个** Prompt group。
- **Prompt group**：全局 Prompt library 的树节点，用于按领域或功能组织
  Prompt。Group 内的 Prompt 有稳定顺序，可表达 Plan → Implement → Review
  这类连续任务，但不会自动执行。
- **General**：常驻、顶层且不可删除的默认 Prompt group。没有自定义归属的
  Prompt 都在这里；它也是删除自定义 group 时的安全迁移目标。
- **Use**：将一个 Prompt 的正文插入当前活动终端；不附加 Enter，不创建
  终端。

v1 的产品文案使用 `Groups`，不使用 `Workflow` 或 `Prompt set`，以免暗示
自动执行、跨组复用或批量发送。

### Skill

Skill 的以下概念必须分开，不能用一个 scope 或 toggle 混淆：

| 概念 | 用户问题 | 例子 |
| --- | --- | --- |
| Installation | Skill 从哪里来，是否可信？ | Git URL、导入文件夹、创建 |
| Ownership | 它属于哪个资产库？ | Global library、显式 Project-only |
| Activation | 当前项目是否能使用它？ | 已添加到本项目 |
| Agent access | 哪些 Agent 可以使用？ | Codex、Claude、Kimi |

`Remove from project` 只解除当前项目访问并可 Undo；永久删除或卸载必须
独立、明确显示影响范围，并放入 Advanced。

## 信息架构

顶层只展示已可用的两个平级页面：

```text
AI
├── Prompts
│   ├── General (persistent)
│   └── Custom groups
└── Skills
    ├── Global library
    ├── This project access
    └── Add skill
```

MCP 和 Hooks 暂时隐藏。若业务需要展示路线图，它们只能出现在低优先级的
More 菜单中，不能占据首屏标签位。

Dashboard 顶部已有的**全局 Search 是唯一常驻搜索入口**；AI tab 不再重复放置
搜索框。全局索引须包含 group 名、Prompt 名称/说明，以及 Skill 名称/说明。用户
位于 AI tab 时，查询结果在当前树与列表内过滤并保留所属 group 路径；清空查询
即恢复先前的折叠、滚动和焦点状态。

页面、详情和编辑均使用**单列页面栈**，每次只保留一个纵向滚动区：

```text
首页列表 → 详情列表 → 编辑页
```

返回时必须恢复来源页的搜索词、筛选、滚动位置和焦点。禁止在侧栏内使用
双栏、双独立滚动 pane、卡片内滚动或列表行内展开大型编辑器。

## Prompts

### 首页

```text
Prompts  Skills

▾ General                                      [＋] [···]
    Review implementation              [Use] [···]
    Draft acceptance criteria          [Use] [···]

▾ Feature · PR flow                    [＋] [···]
    Plan the feature                    [Use] [···]
    Implement the change                [Use] [···]
    Review and prepare PR               [Use] [···]

▸ Bug triage                             2 prompts
```

- `+` 打开 `New prompt` 与 `New group`。从 group 行的 `＋` 创建 Prompt 时，
  默认归入该 group；顶层 `+` 创建 Prompt 时默认归入 General。
- General 始终位于树的第一项，不能重命名或删除；其 tooltip 文案为
  `Default group for prompts not assigned to a custom group.`。
- 自定义 group 与 General 同级；v1 只支持一个 group 层级。折叠/展开状态
  在当前窗口保持，group 与其内部 Prompt 都可单独排序。
- 每个 Prompt 行的稳定主操作是 `Use`；点击行主体进入详情，`…` 承载复制、
  编辑、移动到其他 group 和删除。
- 行展示名称与不超过一行的用途说明。正文第一行不能作为可靠用途说明，因此
  Prompt 新模型增加可选 `description`；未填写时可由现有正文预览兜底。
- Tooltip 可展示完整名称、用途说明及安全截断的正文预览；它不是唯一的信息
  入口。键盘焦点、触屏和详情页都必须能读取完整内容。
- 鼠标可拖拽排序，但必须同时提供键盘可操作的 `Move up` / `Move down`。
- 删除非空自定义 group 时，必须确认，并提供 `Move prompts to General`；不允许
  因删除 group 而隐式删除 Prompt。Prompt 的永久删除始终是独立确认动作。
- `Use` 失败时提供具体恢复动作：没有活动终端时显示 `Open terminal`，暂时
  失败时显示 `Retry`。不只显示静态错误文案。

### 数据与迁移

全局 Prompt library 及其树均可跨项目复用；v1 不把 group 隐式绑定到当前工作
区。`globalState` 的同步键只提供 Settings Sync 的最终传输，不承诺实时刷新或
多窗口同时编辑的冲突安全性；并发编辑须在后续的记录级同步模型中解决。未来可以
在不改变 Prompt 单一归属语义的前提下支持嵌套 group，但 v1 只交付一层自定义
group。初始模型如下，持久化时应加入版本和 revision，并延续现有的单窗口乐观
并发冲突检测与权威回执机制：

```ts
interface PromptV2 {
    id: string;
    name: string;
    description?: string;
    text: string;
    groupId: string; // exactly one existing PromptGroupV1 id
    order: number;
}

interface PromptGroupV1 {
    id: string;
    name: string;
    kind: 'general' | 'custom';
    order: number;
}
```

`General` 使用稳定 id 和 `kind: 'general'`；它必须唯一、置顶且不可删除。旧
PromptV1 数据须无损迁移：创建 General，将每个既有 Prompt 放入其中，保持
`name`、`text` 和原有顺序不变，`description` 缺省。Group 的创建不依赖工作区；
它与全局 Prompt 一样可在任一窗口使用，但不支持多个窗口同时编辑同一 library。

## Skills

### Global library 首页

```text
Prompts  Skills
[ Global library | This project ]             [+]

INSTALLED SKILLS
  fixing-regressions-with-ci       2 projects [···]
  review-fix-commit-loop           Codex      [···]

AVAILABLE TO INSTALL
  frontend-design                  UI flow [Install]

NEEDS ATTENTION                                      1
  frontend-design                  Newer copy [Review]
```

- 默认进入 `Global library`；全局维护是 AI tab 的默认任务。`This project`
  是当前工作区的使用/启用视图，不改变资产归属。
- Global library 中以 `Installed skills`、`Available to install` 和诊断状态
  组织资产；This project 中才以 `Enabled in this project` 和 `Available from
  library` 组织当前项目的访问状态。
- `Needs attention` 是顶部可筛选的诊断状态和行内文本标识，不是与 Enabled
  互斥的第三归属；一个已启用但异常的 Skill 仍留在 Enabled。
- 行显示名称、单行说明、Agent 摘要和一个项目级总开关。总开关第一次启用时
  选择 Agent，之后记住上次选择；行详情允许精确调整单个 Agent。
- 点击行进入详情页：说明 → 项目状态 → Agent access → Advanced。路径、
  symlink、复制来源、迁移、同步与永久删除只出现在 Advanced。

### Add skill 与创建

`+ Add skill` 必须是可见主入口，菜单包括：

1. `Browse recommended`（若 registry 可用）。
2. `Install from Git URL`。
3. `Import folder`。
4. `Create skill`。

在尚无 registry 的 MVP，至少实现 Git URL 和本地文件夹之一，不能把现有
Centralize 或 Copy 操作改名为 Install。

安装流程：选择来源 → 显示作者/来源 URL、版本或 commit、目标 Ownership 与
信任说明 → 默认安装到 Global library → 可选地选择当前项目及 Agent → 安装 →
权威成功或失败回执 → 回到 library 并高亮结果。远程 Skill 可能影响 Agent 的
指令行为，安装前不得跳过来源与信任提示。

创建流程默认选择 Global library：名称 → 用途 → 模板 → 创建合法 `SKILL.md`
→ 校验 → 选择 Agent → 打开编辑器。用户可显式选择 Project-only；此时 UI
必须明确会写入项目目录，可能被 Git 追踪。没有工作区时 Project-only 不可选，
不得静默改变范围。

项目级总开关的语义为“新的 Agent 工作开始时可用”。若对正在运行的 session
不立即生效，详情页必须明确说明。

## 视觉与交互规范

- 视觉目标是 **VS Code 原生的精致工具面板**，不是 SaaS 卡片墙。
- 以 300–340px 为设计基准，并验证 240px、480px、200% 缩放、高对比和长
  中英文名称。
- 只使用 VS Code 主题 token。常驻状态以图标 + 文本表达，不依赖颜色或
  tooltip；保留强调、warning、error 三类语义色。
- 顶层 tab 约 28px，普通列表行 40–44px，说明文字单行截断，详情页才显示
  完整内容。列表以弱分隔或 hover/selected 底色组织，不使用嵌套圆角卡片和
  大阴影。
- `Use`、`Add`、`Install`、`Review` 是文本动作；只有项目启停使用 switch。
  `2 of 3 agents` 使用文本表达部分启用，不能用三态 switch 或纯色圆点。
- 动画仅使用短暂、可中断的透明度/颜色反馈，并尊重 reduced motion；不得因
  hover 改变标题占位或造成列表布局跳动。
- 所有图标按钮必须有可读标签；所有状态变更都提供 pending、成功、失败和
  恢复反馈。删除、卸载等破坏性动作必须确认并清楚说明影响范围。

## 空、错误与加载状态

| 场景 | 必须提供的下一步 |
| --- | --- |
| 没有 Prompt | `Create prompt` |
| 空 Group | `Create prompt` |
| 搜索无结果 | 清除筛选 / 创建或导入 |
| 项目没有已启用的 Skill | 从 Global library 添加，或创建 Project-only Skill |
| 无工作区 | 说明项目操作不可用，并提供 Global 路径 |
| 安装、扫描或保存失败 | 原因、`Retry` 与 `Open diagnostics` |

所有异步安装、启停、修复和创建必须遵循：

```text
pending → authoritative success / failure → Retry 或 Undo
```

## MVP 验收旅程

1. 用户从打开 AI tab 到首次 `Use` 一个 Prompt，不超过两次操作。
2. 用户在 30 秒内创建 `Feature · PR flow` group，建立 `Plan → Implement
   → Review` 三条按序 Prompt，并对任一条执行 `Use`。
3. 用户能搜索一个全局已安装 Skill，将它启用到当前项目并选择 Agent；关闭后
   可 Undo 并恢复上次 Agent 集合。
4. 用户能从支持的来源把 Skill 安装到 Global library，看到来源与信任信息，
   并可选地直接启用到当前项目。
5. 用户能在两分钟内创建、校验并启用一个全局 Skill；必要时可显式创建
   Project-only Skill。
6. 在键盘操作、窄侧栏和高对比主题下，上述旅程都没有仅依赖 hover、颜色或
   拖拽的必经步骤。

## 交付顺序

1. 建立由 Dashboard 拥有的 AI Hub shell；Prompts 与 Skills 成为平级 feature
   section，保持现有消息协议兼容。
2. 交付紧凑 Prompt tree、搜索、详情页、tooltip 预览和稳定 `Use` 主操作。
3. 交付 General、全局自定义 group、单一归属迁移、排序与安全删除语义。
4. 交付单列 Skills 页面、项目级启停、逐 Agent 详情和 Advanced 收纳。
5. 交付 `Add skill` 与 `Create skill` 的最小闭环、来源/信任模型和失败恢复。
6. 在以上能力稳定后，评估 MCP、Hooks 或 registry 浏览。

## 成功指标

- Prompt：首次 Use 时长、Use 成功率、Prompt group 的 7 日复用率。
- Skill：Install 完成率与耗时、Install → 项目启用转化率、项目开关成功率、
  Create → 首次启用完成率。
- 质量：Needs attention 的解决率、失败后 Retry 成功率、Undo 使用率和用户
  误删/回滚事件。
