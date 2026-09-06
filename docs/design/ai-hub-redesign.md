# AI Hub Redesign PRD

状态：提案。本文定义 Dashboard 顶层 AI tab 的产品目标、用户体验和
MVP 验收范围；技术拆分另行设计。

## 背景

现有 AI tab 同时放入了 Prompt 管理、Skill 文件系统管理，以及 MCP 和
Hooks 的占位页。Prompt 以高卡片和 hover 操作呈现，Skill 则直接暴露
Global/Project 双树、来源目录、链接、复制、冲突和同步等底层概念。

这使用户难以完成两件最重要的事：快速把合适的 Prompt 用到当前任务中，
以及清楚地为当前项目启用、安装或创建一个 Skill。

AI tab 不是 OPEN 中的活跃会话视图。它的定位是：**当前项目的 AI 资产
工作台**。OPEN 继续承载会话、终端和运行状态；AI tab 承载可复用的
Prompt 与 Skills。

## 目标

1. 用户在 10 秒内找到并将一个 Prompt 插入活动终端。
2. 用户能为一个功能建立按步骤组织的 Prompt set，例如 Plan → Implement
   → Review，并逐步使用其中的 Prompt。
3. 用户一眼看清当前项目启用了哪些 Skills、分别可供哪些 Agent 使用，
   并能快速启用或关闭。
4. 用户可从明确来源安装、导入或创建 Skill；安装后立即决定是否用于当前
   项目及哪些 Agent。
5. 在 300–340px 的 VS Code 侧栏中保持紧凑、原生、可访问且赏心悦目的
   界面。

## 非目标

- 不在 v1 自动连续执行一个 Prompt set，也不隐式向终端发送多段文本。
- 不在 v1 引入 Prompt 变量、条件分支、跨会话执行器或团队协作同步。
- 不在 v1 提供远程 Skill 市场评分、自动更新或复杂推荐算法。
- 不修改 OPEN 的 AI Sessions / CHATS / ALL 体验。
- MCP、Hooks 在具备明确内容和任务模型前不作为可用一级页面。

## 核心术语与状态模型

### Prompt 与 Prompt set

- **Prompt**：全局可复用的文本模板，含名称、用途说明和正文。
- **Prompt set**：默认属于当前项目的、有序 Prompt 引用集合。一个 Prompt
  可属于零或多个 set，不复制正文。
- **Use**：将一个 Prompt 的正文插入当前活动终端；不附加 Enter，不创建
  终端。

v1 的产品文案使用 `Prompt sets`，避免 `Workflow` 暗示会自动执行。用户可
按步骤 `Use`，但系统不会自动推进或批量发送。

### Skill

Skill 的以下概念必须分开，不能用一个 scope 或 toggle 混淆：

| 概念 | 用户问题 | 例子 |
| --- | --- | --- |
| Installation | Skill 从哪里来，是否可信？ | Git URL、导入文件夹、创建 |
| Ownership | 它属于哪个资产库？ | Global library、当前项目 |
| Activation | 当前项目是否能使用它？ | 已添加到本项目 |
| Agent access | 哪些 Agent 可以使用？ | Codex、Claude、Kimi |

`Remove from project` 只解除当前项目访问并可 Undo；永久删除或卸载必须
独立、明确显示影响范围，并放入 Advanced。

## 信息架构

顶层只展示已可用的两个平级页面：

```text
AI
├── Prompts
│   ├── Search
│   ├── Recent / Favorites
│   ├── Prompt sets
│   └── All prompts
└── Skills
    ├── This project
    ├── Global library
    └── Add skill
```

MCP 和 Hooks 暂时隐藏。若业务需要展示路线图，它们只能出现在低优先级的
More 菜单中，不能占据首屏标签位。

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
[ Search prompts & sets… ]                     [+ ▾]

RECENT PROMPTS
  Review implementation              [Use] [···]
  Draft acceptance criteria          [Use] [···]

PROMPT SETS
  Feature · PR flow                  3 steps  ›
  Bug triage                         2 steps  ›

PROMPT LIBRARY
  View all prompts                              ›
```

- `+` 打开 `New prompt` 与 `New prompt set`。
- Recent 最多显示最近使用的少量 Prompt；收藏的 Prompt 位于 Recent 前或与之
  合并显示。完整库始终可搜索。
- 每个 Prompt 行的稳定主操作是 `Use`；点击行主体进入详情，`…` 承载复制、
  收藏、设为默认、编辑和删除。
- 行展示名称与不超过一行的用途说明。正文第一行不能作为可靠用途说明，因此
  Prompt 新模型增加可选 `description`；未填写时可由现有正文预览兜底。
- 默认 Prompt 只显示安静的星标，不能通过整行描边或额外卡片制造噪声。

### Prompt set

进入 set 后显示返回入口、名称、可选说明和有序步骤：

```text
← Prompt sets
Feature · PR flow                         [···]
1  Plan the feature                       [Use]
2  Implement the change                   [Use]
3  Review and prepare PR                  [Use]
                                      [+ Add prompt]
```

- 创建流程：命名 → 搜索并添加已有 Prompt 或就地新建 → 排序 → 保存。
- 鼠标可拖拽排序，但必须同时提供键盘可操作的 `Move up` / `Move down`。
- 删除一个被 set 引用的 Prompt 时，先显示受影响 set 数量，并让用户选择
  Cancel、从所有 set 移除或替换引用；不得留下静默失效引用。
- `Use` 失败时提供具体恢复动作：没有活动终端时显示 `Open terminal`，暂时
  失败时显示 `Retry`。不只显示静态错误文案。

### 数据与迁移

全局 Prompt library 保持可复用；Prompt set 默认保存在项目工作区状态中。
初始模型如下，持久化时应加入版本和 revision，并延续现有的乐观并发冲突
检测与权威回执机制：

```ts
interface PromptV2 {
    id: string;
    name: string;
    description?: string;
    text: string;
}

interface PromptSetV1 {
    id: string;
    name: string;
    description?: string;
    promptIds: string[]; // 有序、无重复、每项引用现存 Prompt
}
```

旧 PromptV1 数据须无损迁移：`name` 和 `text` 保持不变，`description` 缺省。
项目外或无工作区环境中，Prompt set 创建入口禁用并解释需要先打开项目。

## Skills

### This project 首页

```text
Prompts  Skills
[ This project | Global library ]             [+]
[ Search skills… ]                   [All agents ▾]

ENABLED IN THIS PROJECT
  fixing-regressions-with-ci       2 agents    [on]
  review-fix-commit-loop           Codex       [on]

AVAILABLE FROM LIBRARY
  frontend-design                  UI flow    [Add]

NEEDS ATTENTION                                      1
  frontend-design                  Newer copy [Review]
```

- 默认进入 `This project`；`Global library` 是资产管理视图，而不是默认工作
  场景。
- `Enabled in this project` 与 `Available from library` 是主分组。
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
信任说明 → 选择当前项目及 Agent → 安装 → 权威成功或失败回执 → 回到项目
列表并高亮结果。远程 Skill 可能影响 Agent 的指令行为，安装前不得跳过来源
与信任提示。

创建流程默认选择当前项目：名称 → 用途 → 模板 → 创建合法 `SKILL.md` →
校验 → 选择 Agent → 打开编辑器。UI 必须明确会写入项目目录，可能被 Git
追踪；没有工作区时改为显式 Global 创建，不得静默改变范围。

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
| 空 Prompt set | `Add first prompt` |
| 搜索无结果 | 清除筛选 / 创建或导入 |
| 项目没有 Skill | `Browse skills` 与 `Create skill` |
| 无工作区 | 说明项目操作不可用，并提供 Global 路径 |
| 安装、扫描或保存失败 | 原因、`Retry` 与 `Open diagnostics` |

所有异步安装、启停、修复和创建必须遵循：

```text
pending → authoritative success / failure → Retry 或 Undo
```

## MVP 验收旅程

1. 用户从打开 AI tab 到首次 `Use` 一个 Prompt，不超过两次操作。
2. 用户在 30 秒内创建 `Plan → Implement → Review` 三步 Prompt set，并对
   任一步执行 `Use`。
3. 用户能搜索一个已安装 Skill，将它启用到当前项目并选择 Agent；关闭后可
   Undo 并恢复上次 Agent 集合。
4. 用户能从支持的来源安装一个 Skill，看到来源与信任信息，并在成功后直接
   在当前项目中使用它。
5. 用户能在两分钟内创建、校验并启用一个项目 Skill。
6. 在键盘操作、窄侧栏和高对比主题下，上述旅程都没有仅依赖 hover、颜色或
   拖拽的必经步骤。

## 交付顺序

1. 建立由 Dashboard 拥有的 AI Hub shell；Prompts 与 Skills 成为平级 feature
   section，保持现有消息协议兼容。
2. 交付紧凑 Prompt 行、搜索、Recent、详情页和稳定 `Use` 主操作。
3. 交付项目级 Prompt set、迁移、引用完整性和逐步 Use。
4. 交付单列 Skills 页面、项目级启停、逐 Agent 详情和 Advanced 收纳。
5. 交付 `Add skill` 与 `Create skill` 的最小闭环、来源/信任模型和失败恢复。
6. 在以上能力稳定后，评估 MCP、Hooks 或 registry 浏览。

## 成功指标

- Prompt：首次 Use 时长、Use 成功率、Prompt set 的 7 日复用率。
- Skill：Install 完成率与耗时、Install → 项目启用转化率、项目开关成功率、
  Create → 首次启用完成率。
- 质量：Needs attention 的解决率、失败后 Retry 成功率、Undo 使用率和用户
  误删/回滚事件。
