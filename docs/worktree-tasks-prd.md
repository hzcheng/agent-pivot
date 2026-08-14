# Worktree Tasks（多项目 Workspace 任务化 Worktree）PRD

日期：2026-08-14

状态：草案，核心决策已确认，待实现拆解评审

## 1. 背景

Agent Pivot 的 Worktree tab（`feat/worktree-model`）当前把 workspace 内**所有仓库的所有 worktree 平铺成一张列表**。在单仓库 workspace 下这套模型工作良好，但在多项目 workspace（如同时打开 agent-pivot、pi、agent-infra-lab 三个仓库）下出现四个真实断点：

1. **行上看不出属于哪个仓库。** 行标题只有分支名，两个仓库都有 `fix/login` 时完全无法区分。
2. **主 checkout 白白占行。** 每个仓库的 main checkout 都渲染成一行，其活跃 session 与 Chats tab 的 Active 完全重复，是纯噪音。
3. **创建入口的仓库选择是隐式魔法。** 系统根据活跃编辑器"猜"目标仓库，用户不知道自己将要建到哪里。
4. **没有"任务"的层级。** 用户的真实工作单位是任务（"修登录 bug"），一个任务常常同时动多个仓库；平铺列表把实现模型（git worktree）直接暴露给了用户。

已确认的产品方向：把 worktree 从 git 概念升级为**任务概念**——每个仓库的基准分支（main / 1.0 / 3.0）不动；创建 worktree = 创建一个任务，在参与仓库的基准上各拉一个物理 worktree，但 UI 只显示**一条任务行**；session 挂在任务行下。

已确认的用户数据假设：**跨仓库任务是少数**，多数任务只动一个仓库。所有默认行为以此为准。

## 2. 目标

- Worktree tab 在多项目 workspace 下的列表复杂度为 O(任务数)，与仓库数量无关。
- 创建任务时，将要发生的物理变更（在哪些仓库、从哪个基准、建到什么路径）**一眼可见、就地可改**。
- 任务级操作（折叠、删除、派生、加仓库）作用于任务整体，且删除等破坏性操作只依据权威数据。
- session 按 cwd 自动归入任务行；跑在主 checkout 上的 session 归入唯一的基准锚点行。
- 单仓库 workspace 下，本机制**退化为现有单仓库 UX**，不产生任何可感知的额外复杂度。
- 仓库增删、基准变更后行为自洽：系统永远不替用户做不可逆的隐式变更。

## 3. 非目标

- 不做任务之间的依赖图、看板状态流转（Doing/Done 等）；任务是"一组物理 worktree + 其 session"，不是项目管理对象。
- 不做跨 workspace 的任务；任务严格属于当前 workspace 的仓库集合。
- 不自动合并/变基/推送任务分支；git 历史操作仍由用户或 agent 在 session 内完成。
- 不做多仓库原子创建（部分失败是一等状态，见 §8），不引入分布式事务式的补偿机制。
- 第一版不做任务模板、任务归档视图；任务随其最后一个物理 worktree 删除而消失。
- 不改变既有 Chats tab 的行为与信息架构。

## 4. 核心概念与实体模型

三层实体：

| 实体 | 职责 | 持久化 |
| --- | --- | --- |
| **Workspace 配置** | 每个仓库记忆的基准分支（沿用现有 `baseRefStore`）；创建任务时的默认仓库勾选记忆 | 现有存储策略 |
| **Task（任务）** | id、显示名（可改）、slug（不可变）、member 集合（仓库 → 分支/路径/状态） | 新增任务清单（manifest） |
| **Session** | 挂在 Task 或 Current 锚点下；cwd 归属与可写目录分离（沿用现有身份模型） | 现有存储策略 |

两个结构性概念：

- **Task 行**：Worktree tab 的一级条目。同一任务的多个物理 worktree 聚合成一行；行下的一级内容是 session（跨 member 汇总），物理 worktree 是次要信息。
- **Current 锚点行**：固定在顶部的唯一基准行（如 `Current · main · 1.0 · 3.0`），永久折叠为一行，唯一职能是收容跑在各仓库主 checkout 上的 session。它不是被管理的 worktree：无 ⋯ 菜单、无删除、无派生按钮，仅可展开查看 session。没有活跃 session 时可弱化显示。

## 5. 关键设计决策（已确认）

### 5.1 创建任务的默认仓库集合：当前上下文，而非全仓库

跨仓库任务是少数。创建表单中参与仓库是一个**始终可见的 checkbox 清单**（每项显示 `仓库名 ← 基准分支`），默认勾选规则：

1. 从某行 ⋯ 菜单触发 → 默认勾选该行所属仓库（或该任务的 member 仓库，见派生流程）；
2. 从 tab 行触发 → 默认勾选活跃编辑器所在仓库；无活跃编辑器 → workspace 第一个仓库；
3. workspace 级记忆用户上次的手动勾选组合，下次作为默认值。

禁止"静默全选"。用户可以一键全选，系统记住后下次默认全选——默认值必须来自用户的显式行为，而非系统的猜测。

### 5.2 任务身份：manifest 为权威，slug 分组仅作展示层兜底

创建任务时写入一份任务清单记录（taskId → 各仓库 member 的 WorktreeKey）：

- **"这些物理 worktree 属于同一任务"的判定、以及一切破坏性操作（任务级删除）只依据 manifest。** 不接受启发式分组作为删除依据——删除错了 worktree 等于丢失他人未提交的代码，是不可恢复事故，而用户不读确认框是铁律。
- **slug 不可变，显示名可改。** 改名只更新 manifest，不动分支名和路径，不产生任务分裂。
- 发现层遇到无 manifest 记录、但 slug 一致（分支名后缀与路径末段一致）的物理 worktree（如用户手动 `git worktree add` 建的），在展示层聚成一个**未认领组**，行内提供一键 **"Adopt as task"**：点击后写入 manifest 转为正式任务。这样保留"手动 git 操作可被正确归组"的甜点，同时不牺牲删除安全。

### 5.3 基准行降级为锚点（见 §4 Current 锚点行）

主 checkout 不再作为可管理的 worktree 行出现。这同时消除"主 checkout 行与 Chats Active 重复"的现存噪音。

### 5.4 任务行内：session 是一等公民，物理 worktree 降级为次要信息

展开任务行，第一级内容必须是 session 卡片（跨 member 汇总，按现有 attention → active → idle 排序），卡片保留现有缩进以表达归属。物理 worktree 成员显示为一行次要摘要（如 `3 worktrees · agent-pivot, pi, infra ▸`），再展开才显示各 member 的路径、分支与健康状态。用户关心的是"agent 们干得怎么样"，不是"文件系统长什么样"。

### 5.5 任务 session 的目录模型

任务 session 的 cwd 落在主 member worktree（默认：任务创建时勾选清单中的第一个仓库，或用户指定），其余 member 的物理 worktree 路径写入 session 身份的 `writableRootHostPaths`。沿用现有"归属目录与可写目录分离"的身份模型，无架构变更。

## 6. 用户流程

### 6.1 创建任务

1. 入口：tab 行图标按钮 / 任务行 ⋯ 菜单（派生，见 6.2）/ Current 锚点不出现入口。
2. 输入任务名（生成 slug：kebab-case，冲突时追加短后缀并可见提示）。
3. 名称下方直接渲染**创建预览**：逐行列出 `仓库/.worktrees/<slug> ← 基准分支`，每行可取消勾选；基准分支可按行覆盖（下拉列出该仓库本地分支 + 记忆的基准，覆盖值不影响仓库记忆的默认基准）。
4. 确认后并行 provisioning 各 member；逐 member 记录状态（沿用现有 provisioning 状态机，按 member 扩展）。

### 6.2 从任务派生任务（stacked）

任务行 ⋯ → "New task from this task"：每个 member 仓库从源任务对应的分支拉新 worktree；源任务不含的仓库若被勾选，回落到该仓库的基准。创建预览照常渲染，所见即所得。

### 6.3 加仓库到任务

任务行 ⋯ → "Add repo"：列出任务尚未包含的 workspace 仓库，按该仓库基准 + 同 slug 补建物理 worktree，写入 manifest。

### 6.4 任务级删除

任务行 ⋯ → "Delete task"：确认框**逐条列出将删除的物理路径**；每个 member 独立复验（沿用现有 clean-check：未提交改动、被锁定等逐项阻断并说明）；逐 member 删除并更新 manifest。已移出 workspace 的 member 不在列表中、不动磁盘、从 manifest 标记为脱离。

### 6.5 认领未认领组

未认领组行 → "Adopt as task"：以 slug 为显示名写入 manifest，转为正式任务行。

## 7. 自洽性规则

唯一原则：**系统永远不替用户做不可逆的隐式变更。**

| 场景 | 行为 |
| --- | --- |
| workspace 新增仓库 | 存量任务不变，不偷偷补建；新仓库中 cwd 匹配的"野生" session 按 cwd 自动归入对应任务行；补建只能显式触发（6.3） |
| workspace 移除仓库 | 任务行只显示可见 member；磁盘上的 member 不删不报错；manifest 标记脱离；仓库加回后自动归位 |
| 仓库基准变更（1.0 → 1.1） | 只影响未来任务的默认基准；存量任务的 member 分支不动 |
| 外部 `git worktree move` / 手动删除 | 沿用现有快照对账：member 健康状态降级（missing/prunable），任务行仍在，member 级提示 |
| 单仓库 workspace | 整个机制退化：创建预览只有一行、无仓库勾选概念；Current 锚点显示单分支；与现有单仓库 UX 完全一致 |
| 任务只剩一个 member | 不特殊处理；任务模型天然兼容单 member，这也是多数派场景 |

## 8. 错误与部分失败

部分失败是**一等状态**：任务行照常出现并可正常使用已建成的 member；失败的 member 在 member 摘要行内显示人话错误（沿用现有错误人话化约定，不显示裸错误码）+ member 级 Retry / Dismiss。任务级聚合状态规则：任一 member 或 session 需要关注 → 任务行 needs attention。

`repository-has-no-commits` 等可重试错误在 member 级保留现有语义。

## 9. UI 结构

```
WORKTREES | CHATS                          [collapse-all] [new task]
─────────────────────────────────────────
▸ Current · main · 1.0 · 3.0                ← 锚点行，永久折叠样式
─────────────────────────────────────────
▼ fix-login        a·p·i      ● attention   ← 任务行：名称 / member 缩写 / 聚合状态
    ├─ [session 卡片]                        ← 一级内容：session，缩进
    ├─ [session 卡片]
    └─ 3 worktrees · agent-pivot, pi, infra ▸ ← 次要摘要，再展开见 member 明细
▸ refactor-cache   a                       · idle
─────────────────────────────────────────
▸ Unmanaged (n)                             ← 不属于任何任务的物理 worktree（兜底）
```

- member 缩写 chips 取仓库名首字母，hover 显示全名；两个仓库同首字母时退化为两字母。
- 任务行 ⋯ 菜单：New session（快速 / 各 provider，沿用现有弹层）、New task from this task、Add repo、Rename、Delete task。
- collapse-all 按钮作用于任务行与锚点行，沿用现有实现。

## 10. 技术实现映射（基于 feat/worktree-model）

| 工作块 | 涉及模块 | 要点 |
| --- | --- | --- |
| 任务清单持久化 | 新增 `taskStore`（对齐 `baseRefStore` / `provisioningStore` 的存储策略） | taskId → members（WorktreeKey 集合）、显示名、slug、脱离标记；写入与删除走 Host 侧复验 |
| 聚合视图模型 | `snapshotCoordinator` / webview 投影 | WorktreeSnapshot → 任务行投影：manifest 分组（权威）+ slug 分组（未认领兜底）+ Current 锚点 + Unmanaged；纯函数、可测 |
| 多仓库 provisioning | `provisioningPlan` / `provisioningController` / `gitWorktreeProvisioner` | 计划按 member 扩展；并行执行、逐 member 状态与持久化恢复记录；member 级重试/dismiss 复用现有失败行协议 |
| 任务级 session 启动 | `isolatedSessionController` / `sessionScope` | cwd = 主 member 路径；其余 member 写入 `writableRootHostPaths`；行菜单各 provider 入口复用现有命令构建 |
| 任务级删除 | `managedWorktreeRemovalController` / `removalProtocol` | 批量计划 = 逐 member 现有删除计划；确认框路径列表来自 manifest；逐 member 复验 |
| Webview UI | `webviewContent.ts` / `media/` | 锚点行、任务行、member 摘要行、创建预览表单、Adopt 入口 |

session 归属无需改动：现有 cwd 匹配将 session 挂到物理 worktree，聚合投影再把物理 worktree 归到任务行。

## 11. 里程碑拆解

1. **M1 投影与展示**：任务清单 + 聚合视图模型 + 任务行/锚点行 UI（只读聚合，创建仍为单仓库）。单仓库 workspace 下 UI 与现状逐像素等价。
2. **M2 多仓库创建**：创建预览表单 + 多仓库并行 provisioning + member 级部分失败。
3. **M3 任务级操作**：删除、Add repo、派生、Rename、Adopt。
4. **M4 打磨**：member chips、动画、空态文案、行为契约补全。

每个里程碑独立可发布，M1 完成后多项目列表难用的四个断点即消除大半。

## 12. 开放问题

1. 任务行的 member chips 上限（仓库数 > 5 时的折叠策略）。
2. "Add repo" 时是否允许选择不同 slug（用于把外部已建的不同名 worktree 并入任务）——倾向不允许，保持 slug 不变式简单。
3. 未认领组的 slug 一致性判定细节（分支名后缀 vs 路径末段，哪个为准）——实现时以路径末段为准、分支名为辅，写入行为契约。
