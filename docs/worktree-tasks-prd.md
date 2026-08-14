# Worktree Tasks（多项目 Workspace 任务化 Worktree）PRD

日期：2026-08-14（v2，评审修订版）

状态：核心决策已确认，评审修订完成，待实现拆解评审

## 1. 背景

Agent Pivot 的 Worktree tab（`feat/worktree-model`）当前把 workspace 内**所有仓库的所有 worktree 平铺成一张列表**。在单仓库 workspace 下这套模型工作良好，但在多项目 workspace（如同时打开 agent-pivot、pi、agent-infra-lab 三个仓库）下出现四个真实断点：

1. **行上看不出属于哪个仓库。** 行标题只有分支名，两个仓库都有 `fix/login` 时完全无法区分。
2. **主 checkout 白白占行。** 每个仓库的 main checkout 都渲染成一行，是纯噪音。
3. **创建入口的仓库选择是隐式魔法。** 系统根据活跃编辑器"猜"目标仓库，用户不知道自己将要建到哪里。
4. **没有"任务"的层级。** 用户的真实工作单位是任务（"修登录 bug"），一个任务常常同时动多个仓库；平铺列表把实现模型（git worktree）直接暴露给了用户。

已确认的产品方向：把 worktree 从 git 概念升级为**任务概念**——每个仓库的基准分支（main / 1.0 / 3.0）不动；创建 worktree = 创建一个任务，在参与仓库的基准上各拉一个物理 worktree，但 UI 只显示**一条任务行**；session 挂在任务行下。

已确认的用户数据假设：**跨仓库任务是少数**，多数任务只动一个仓库。所有默认行为以此为准。

### 1.1 方案取舍：为什么不是"平铺列表 + repo 徽标"

既然跨仓库任务是少数，一个更便宜的替代方案是保留平铺列表，仅加 repo 徽标消歧 + 折叠主 checkout，只解断点 1/2 的展示部分。不选它的理由：

- 断点 3（创建的隐式魔法）只有在"创建的是任务"这个实体下才能根治——显式的创建预览表单需要一个任务实体作为载体，平铺方案下创建仍然是"给某个仓库建 worktree"，魔法只是换了个位置。
- 跨仓库任务虽是少数，但一旦发生，平铺方案下它的 N 个物理行没有任何机制表达"它们是一组"，展示和操作都是碎的。
- 任务机制是**双向门**：manifest 是纯增量数据，丢失或废弃时全部退化为未认领组（§5.2、§9），物理 worktree 毫发无损，决策可逆、退路成本低。

## 2. 目标

- Worktree tab 在多项目 workspace 下的列表复杂度为 O(任务数)，与仓库数量无关。
- 创建任务时，将要发生的物理变更（在哪些仓库、从哪个基准、建到什么路径）**一眼可见、就地可改**。
- 任务级操作（折叠、删除、派生、加仓库）作用于任务整体，且删除等破坏性操作只依据权威数据。
- session 按 cwd 自动归入任务行；跑在主 checkout 上的 session 归入唯一的基准锚点行。
- 单仓库 workspace 下，本机制**退化为现有单仓库 UX**，不产生任何可感知的额外复杂度。
- 仓库增删、基准变更后行为自洽：系统永远不替用户做不可逆的隐式变更。
- 存量（任务化之前由扩展创建的）worktree 平滑迁移，不出现"升级后列表变乱"的功能倒退。

## 3. 非目标与已知限制

- 不做任务之间的依赖图、看板状态流转（Doing/Done 等）；任务是"一组物理 worktree + 其 session"，不是项目管理对象。
- 不做跨 workspace 的任务；任务严格属于当前 workspace 的仓库集合。
- 不自动合并/变基/推送任务分支；git 历史操作仍由用户或 agent 在 session 内完成。
- 不做多仓库原子创建（部分失败是一等状态，见 §8），不引入分布式事务式的补偿机制。
- 第一版不做任务模板、任务归档视图；任务随其最后一个物理 worktree 删除而消失。
- 不改变既有 Chats tab 的行为与信息架构。
- **已知限制：不支持把 session 在 Current 锚点与任务之间移动。** session 归属由 cwd 结构性决定；用户心智中的归属与 cwd 不一致时（如在主 checkout 跑了个与某任务相关的临时 session），第一版没有移动入口。列入已知限制而非非目标，未来可加 "Move session to task"。

## 4. 核心概念与实体模型

三层实体：

| 实体 | 职责 | 持久化 |
| --- | --- | --- |
| **Workspace 配置** | 每个仓库记忆的基准分支（沿用现有 `baseRefStore`） | 现有存储策略 |
| **Task（任务）** | id、显示名（可改）、slug（不可变）、member 集合（仓库 → 分支/路径/状态） | 新增任务清单（manifest），**机器本地存储**（与 worktree 的机器本地属性一致，见 §9） |
| **Session** | 挂在 Task 或 Current 锚点下；cwd 归属与可写目录分离（沿用现有身份模型） | 现有存储策略 |

两个结构性概念：

- **Task 行**：Worktree tab 的一级条目。同一任务的多个物理 worktree 聚合成一行；行下的一级内容是 session（跨 member 汇总），物理 worktree 是次要信息。
- **Current 锚点行**：固定在顶部的唯一基准行，永久折叠为一行，唯一职能是收容跑在各仓库主 checkout 上的 session。锚点行渲染的是**快照中各主 checkout 实际检出的分支**（不是记忆的基准值——用户把主 checkout 切到 hotfix 后界面不能撒谎显示 main）。它不是被管理的 worktree：无 ⋯ 菜单、无删除、无派生按钮，仅可展开查看 session；没有活跃 session 时可弱化显示。在主 checkout 建 session 的入口由 Chats tab 的 + 承担，锚点行不因此加回菜单。

### 4.1 术语约定

产品内已有 TODO tab 承载"待办"语义，为避免文案冲突：

- 内部模型、代码、协议字段统一称 **task**；
- UI 中文文案**不裸用"任务"二字**：任务行直接显示其名称，需要名词时用"worktree 组"；菜单项如 "New task from this task" 对应中文文案"从此组派生"；
- TODO tab 侧继续使用"待办"。

本文档为表述简洁仍使用"任务"一词，均指 task 实体。

## 5. 关键设计决策（已确认）

### 5.1 创建任务的默认仓库集合：当前上下文，不做勾选记忆

跨仓库任务是少数。创建表单中参与仓库是一个**始终可见的 checkbox 清单**（每项显示 `仓库名 ← 基准分支`），默认勾选规则（优先级从上到下）：

1. 从某行 ⋯ 菜单触发 → 默认勾选该行所属仓库（派生流程默认勾选源任务的 member 仓库，见 §6.2）；
2. 从 tab 行触发 → 默认勾选活跃编辑器所在仓库；无活跃编辑器 → workspace 第一个仓库。

**不做勾选记忆。** 跨仓库是少数派场景，每次都是一个显式点击（清单内提供"全选"）；如果记忆上次勾选，一次真实的全选会让接下来一串单仓库任务全部默认全选——"静默多建"会换了个入口回来。默认值永远来自上下文，永远可预测。

### 5.2 任务身份：manifest 为权威，slug 分组仅作展示层兜底

创建任务时写入一份任务清单记录（taskId → 各仓库 member 的 WorktreeKey）：

- **"这些物理 worktree 属于同一任务"的判定、以及一切破坏性操作（任务级删除）只依据 manifest。** 不接受启发式分组作为删除依据——删除错了 worktree 等于丢失他人未提交的代码，是不可恢复事故，而用户不读确认框是铁律。
- **不变式：一个 WorktreeKey 至多属于一个任务。** manifest 在创建、Add repo、Merge 时强制校验成员唯一性。
- **slug 不可变且在任务间唯一，显示名可改。** 改名只更新 manifest，不动分支名和路径，不产生任务分裂；显示名允许重复（靠 member chips 和状态区分）。
- **slug 生成规则**：从显示名提取 ASCII 字母数字片段转 kebab-case；结果不足 3 个字符时（典型场景：纯中文任务名）回落为 `task-<6 位短 id>`，显示名保留原文不变。与现有任务 slug 冲突时追加短后缀并在创建预览中可见提示。
- **韧性：manifest 丢失（状态重置、换机器）不等于数据丢失。** 任务全部退化为未认领组，物理 worktree 毫发无损，可逐个 Adopt 恢复（§6.5）。这是该架构的隐含优点，也是选择机器本地存储的代价与自洽之处。
- 发现层遇到无 manifest 记录、但 slug 一致（路径末段一致为主、分支名后缀为辅）的物理 worktree（如用户手动 `git worktree add` 建的），在展示层聚成一个**未认领组**。注意：中文任务名场景下 slug 为 `task-<id>` 形式，slug 分组基本只对英文命名的手动操作有效——这是可接受的弱化，manifest 始终是权威。

### 5.3 基准行降级为锚点（见 §4 Current 锚点行）

主 checkout 不再作为可管理的 worktree 行出现。消除的是"每个仓库一行主 checkout 占位"的噪音（N 行 → 1 行折叠锚点）；session 在 Chats Active 与锚点行中的双处展示**保留**——两个 tab 回答的问题不同（Chats：我现在有哪些活跃对话；Worktree：我的工作集在哪里），不构成需要去除的重复。

### 5.4 任务行内：session 是一等公民，物理 worktree 降级为次要信息

展开任务行，第一级内容必须是 session 卡片（跨 member 汇总，按现有 attention → active → idle 排序），卡片保留现有缩进以表达归属。物理 worktree 成员显示为一行次要摘要（如 `3 worktrees · agent-pivot, pi, infra ▸`），再展开才显示各 member 的路径、分支与健康状态。用户关心的是"agent 们干得怎么样"，不是"文件系统长什么样"。

### 5.5 任务 session 的目录模型

任务 session 的 cwd 落在主 member worktree（默认：任务创建时勾选清单中的第一个仓库，或用户指定），其余 member 的物理 worktree 路径写入 session 身份的 `writableRootHostPaths`。沿用现有"归属目录与可写目录分离"的身份模型，无架构变更。

## 6. 用户流程

### 6.1 创建任务

1. 入口：tab 行图标按钮 / 任务行 ⋯ 菜单（派生，见 §6.2）/ Current 锚点不出现入口。
2. 输入任务名（slug 生成规则见 §5.2）。
3. 名称下方直接渲染**创建预览**：逐行列出 `仓库/.worktrees/<slug> ← 基准分支`，每行可取消勾选；基准分支可按行覆盖（可搜索过滤的下拉，第一版列该仓库**本地分支 + 记忆的基准**，不含 remote-only 分支以避免列表爆炸；覆盖值不影响仓库记忆的默认基准）。
4. 确认前做**预检**：目标路径已存在、分支名已被占用等逐行标出，有错误的行不参与创建。
5. 确认后并行 provisioning 各 member；逐 member 记录状态（沿用现有 provisioning 状态机，按 member 扩展）。

### 6.2 从任务派生任务（stacked）

任务行 ⋯ → "New task from this task"：每个 member 仓库从源任务对应的分支拉新 worktree；源任务不含的仓库若被勾选，回落到该仓库的基准。创建预览照常渲染（默认勾选源任务的 member 仓库集合），所见即所得。

### 6.3 加仓库到任务

任务行 ⋯ → "Add repo"：列出任务尚未包含的 workspace 仓库，按该仓库基准 + 同 slug 补建物理 worktree，写入 manifest（含成员唯一性校验）。

### 6.4 任务级删除：全或无

任务行 ⋯ → "Delete task"：确认框**逐条列出每个 member 的物理路径及其检查结果**（活跃 session、未提交改动、锁定等，复用现有单 worktree 删除的 `isActive` 与 clean-check 语义，逐 member 继承）。

**任一 member 被阻断 → 整个删除不执行**，确认框逐条标明阻断原因，用户处理完后整体重试。不允许"删掉 2 个留 1 个"的部分删除——与创建侧"部分失败一等公民"形成对称但相反的语义：**创建宽容，删除保守**。已移出 workspace 的 member 不在列表中、不动磁盘、从 manifest 标记为脱离，不阻断整体删除。

### 6.5 认领未认领组：Adopt 与 Merge

未认领组行的入口按 slug 归属分两种：

- slug 不属于任何现有任务 → **"Adopt as task"**：以 slug 为显示名写入 manifest，转为正式任务行；
- slug 命中已存在的任务（典型场景：任务只有 agent-pivot 一个 member，用户手动在 pi 里建了同 slug 的 worktree）→ **"Merge into task X"**：写入现有 manifest，**禁止创建 slug 重复的第二个任务**（防止一个逻辑任务裂成两行、破坏 slug 唯一不变式）。

## 7. 自洽性规则

唯一原则：**系统永远不替用户做不可逆的隐式变更。**

| 场景 | 行为 |
| --- | --- |
| workspace 新增仓库 | 存量任务不变，不偷偷补建；新仓库中 cwd 匹配的"野生" session 按 cwd 自动归入对应任务行；补建只能显式触发（§6.3） |
| workspace 移除仓库 | 任务行只显示可见 member；磁盘上的 member 不删不报错；manifest 标记脱离；仓库加回后自动归位 |
| 仓库基准变更（1.0 → 1.1） | 只影响未来任务的默认基准；存量任务的 member 分支不动 |
| 外部 `git worktree move` / 手动删除 | 沿用现有快照对账：member 健康状态降级（missing/prunable），任务行仍在，member 级提示 |
| manifest 丢失 / 换机器 | 任务退化为未认领组，物理 worktree 无损，可 Adopt 恢复（§5.2） |
| 单仓库 workspace | 整个机制退化：创建预览只有一行、无仓库勾选概念、无 member chips；Current 锚点显示单个实际分支；与现有单仓库 UX 完全一致 |
| 任务只剩一个 member | 不特殊处理；任务模型天然兼容单 member，这也是多数派场景 |

## 8. 错误与部分失败

部分失败是**一等状态**（仅针对创建/补建；删除是全或无，见 §6.4）：任务行照常出现并可正常使用已建成的 member；失败的 member 在 member 摘要行内显示人话错误（沿用现有错误人话化约定，不显示裸错误码）+ member 级 Retry / Dismiss。任务级聚合状态规则：任一 member 或 session 需要关注 → 任务行 needs attention。

`repository-has-no-commits` 等可重试错误在 member 级保留现有语义。

## 9. 迁移与存储

**存储位置**：manifest 机器本地存储（对齐 `provisioningStore` 的 Memento 策略）。worktree 本身就是机器本地的物理目录，manifest 跟随其存储域是自洽的；换机器后任务以未认领组形式重新被发现，可 Adopt 恢复。

**存量迁移**（M1 的组成部分，任务化之前由扩展创建的 worktree 不能掉进 Unmanaged 造成功能倒退）：

1. **自动播种**：首次启动时，对可确认为扩展产物的 worktree（命中扩展分支命名前缀，或存在于 `provisioningStore` 恢复记录中、含 slug/branchName/worktreePath/repositoryKey）自动生成 manifest 记录；slug 一致者归入同一任务，单仓库的各自成任务。
2. **人工兜底**：播种覆盖不了的（恢复记录有上限、已过期）走 slug 分组 → Adopt / Merge（§6.5），并在空态/组内文案中一次性说明。
3. 迁移是幂等的：已存在的 manifest 记录不被播种覆盖。

## 10. UI 结构

```
WORKTREES | CHATS                          [collapse-all] [new]
─────────────────────────────────────────
▸ Current · main · 1.0 · 3.0                ← 锚点行：各主 checkout 实际检出的分支
─────────────────────────────────────────
▼ fix-login        a·p·i      ● attention   ← 任务行：名称 / member chips / 聚合状态
    ├─ [session 卡片]                        ← 一级内容：session，缩进
    ├─ [session 卡片]
    └─ 3 worktrees · agent-pivot, pi, infra ▸ ← 次要摘要，再展开见 member 明细
▸ refactor-cache   p                       · idle
─────────────────────────────────────────
▸ Unmanaged (n)                             ← 无 slug 同伴、无 manifest 的物理 worktree（兜底）
```

- **member chips 规则**：单仓库 workspace 不显示；多仓库 workspace 下所有任务行显示（单 member 任务显示 1 个 chip——它承担"这任务在哪个仓库"的消歧职能，是断点 1 的解药）；取仓库名首字母，同首字母退化为两字母，hover 显示全名；超过 4 个折叠为 `+N`。
- **任务行排序**：聚合状态（attention → active → idle）→ 最近活动时间。
- 任务行 ⋯ 菜单：New session（快速 / 各 provider，沿用现有弹层）、New task from this task、Add repo、Rename、Delete task。UI 文案遵循 §4.1 术语约定。
- collapse-all 按钮作用于任务行与锚点行，沿用现有实现。

## 11. 技术实现映射（基于 feat/worktree-model）

| 工作块 | 涉及模块 | 要点 |
| --- | --- | --- |
| 任务清单持久化 | 新增 `taskStore`（机器本地 Memento，对齐 `provisioningStore`） | taskId → members（WorktreeKey 集合，成员唯一性校验）、显示名、slug、脱离标记；写入与删除走 Host 侧复验；含 §9 迁移播种 |
| 聚合视图模型 | `snapshotCoordinator` / webview 投影 | WorktreeSnapshot → 任务行投影：manifest 分组（权威）+ slug 分组（未认领兜底）+ Current 锚点（渲染实际检出分支）+ Unmanaged；纯函数、可测 |
| 多仓库 provisioning | `provisioningPlan` / `provisioningController` / `gitWorktreeProvisioner` | 计划按 member 扩展；预检（路径/分支占用）；并行执行、逐 member 状态与持久化恢复记录；member 级重试/dismiss 复用现有失败行协议 |
| 任务级 session 启动 | `isolatedSessionController` / `sessionScope` | cwd = 主 member 路径；其余 member 写入 `writableRootHostPaths`；行菜单各 provider 入口复用现有命令构建 |
| 任务级删除 | `managedWorktreeRemovalController` / `removalProtocol` | 全或无：逐 member 复用 `isActive` 阻断与 clean-check，任一阻断则整体不执行；确认框逐条列出路径与阻断原因 |
| Webview UI | `webviewContent.ts` / `media/` | 锚点行、任务行、member 摘要行、创建预览表单（可搜索基准下拉）、Adopt / Merge 入口 |

session 归属无需改动：现有 cwd 匹配将 session 挂到物理 worktree，聚合投影再把物理 worktree 归到任务行。切换 session 命令的视图跟随逻辑改为指向任务行。

## 12. 里程碑拆解

每个里程碑**连同其行为契约一起交付**，契约不攒到最后。

1. **M1 投影与展示 + 迁移**：任务清单（含 §9 自动播种）+ 聚合视图模型 + 任务行/锚点行 UI（只读聚合，创建仍为单仓库）。单仓库 workspace 下 UI 与现状逐像素等价。
2. **M2 多仓库创建**：创建预览表单 + 预检 + 多仓库并行 provisioning + member 级部分失败。
3. **M3 任务级操作**：全或无删除、Add repo、派生、Rename、Adopt / Merge。
4. **M4 打磨**：动画、空态文案、切换跟随、可访问性。

每个里程碑独立可发布，M1 完成后多项目列表难用的四个断点即消除大半。

## 13. 验收标准

- **多项目 dogfood 场景**：3 仓库 workspace 中创建 5 个任务（含 1 个跨仓库），Worktree 列表行数 ≤ 任务数 + 锚点 + 兜底组；创建任务的点击路径中仓库选择始终可见。
- **单仓库回归**：M1 后单仓库 workspace 的 Worktree tab 与现状截图对比逐像素等价，现有行为契约全绿。
- **迁移**：从 `feat/worktree-model` 环境升级后，存量扩展创建的 worktree 全部归入任务行（播种）或明确的未认领组（可 Adopt），无静默丢失。
- **删除安全性**：构造含活跃 session 的任务，Delete task 整体阻断且确认框逐条列明原因；manifest 中不存在的 worktree 永远不出现在任何删除确认列表中。
- **性能**：64 个物理 worktree（发现上限）规模下，聚合投影为纯函数且单次计算不阻塞 webview 渲染帧（< 16ms）。
- **韧性**：清空 manifest 后重启，任务退化为未认领组，物理 worktree 无损，Adopt 可恢复。

## 14. 开放问题

1. "Add repo" 不允许选择不同 slug（已确认倾向）：推论是**外部建的不同名 worktree 永远无法并入现有任务**，只能各自被 Adopt 成独立任务——接受此限制。
2. 任务行 hover tooltip 与详情（member 列表、创建时间）的信息层级，M4 时按实际视觉稿定。
3. 派生任务时源任务的显示名/slug 建议值（`X-2`？`X-followup`？）——实现时取最简单方案（追加短后缀）并在预览中可见。
