# Worktree Tasks（多项目 Workspace 任务化 Worktree）PRD

日期：2026-08-15（v6，M3 实现前评审定稿）

状态：M1/M2 已交付；M3 语义经五轮实现前评审闭环（删除 journal 事务、retired 历史身份、session 世代模型、mutation lease 与 admission mutex、revision 体系），可进入 M3 实现；M3 的工程化实施约束（存储边界、容量、故障注入矩阵）详见 `docs/worktree-tasks-m3-plan.md`

## 0. 核心产品承诺

本方案收敛为五句话，后续所有章节都是这五句话的展开；任何实现决策与这五句冲突时，以这五句为准：

1. **组（group）是 manifest 中的稳定工作集身份**；member 的分支名和路径可以各不相同，分组关系只由 manifest 表达。
2. **组 session 只能写 member worktree**，不能写非 member 仓库的主 checkout。
3. **slug 只用于默认命名和重新组织时的建议**，不用于自动建立权威分组关系。
4. **删除是"全量预检门禁 + 可恢复的逐成员执行"**，不承诺文件系统原子性。
5. **manifest 丢失保证物理数据安全**，但只支持重新组织，不保证恢复原分组结构。

## 1. 背景

Agent Pivot 的 Worktree tab（`feat/worktree-model`）当前把 workspace 内**所有仓库的所有 worktree 平铺成一张列表**。在单仓库 workspace 下这套模型工作良好，但在多项目 workspace（如同时打开 agent-pivot、pi、agent-infra-lab 三个仓库）下出现四个真实断点：

1. **行上看不出属于哪个仓库。** 行标题只有分支名，两个仓库都有 `fix/login` 时完全无法区分。
2. **主 checkout 白白占行。** 每个仓库的 main checkout 都渲染成一行，是纯噪音。
3. **创建入口的仓库选择是隐式魔法。** 系统根据活跃编辑器"猜"目标仓库，用户不知道自己将要建到哪里。
4. **没有"工作集"的层级。** 用户的真实工作单位是任务（"修登录 bug"），一个任务常常同时动多个仓库；平铺列表把实现模型（git worktree）直接暴露给了用户。

已确认的产品方向：把 worktree 从 git 概念升级为**工作集概念**——每个仓库的基准分支（main / 1.0 / 3.0）不动；创建 = 创建一个工作集，在参与仓库的基准上各拉一个物理 worktree，但 UI 只显示**一条组行**；session 挂在组行下。

已确认的用户数据假设：**跨仓库工作集是少数**，多数只动一个仓库。所有默认行为以此为准。

### 1.1 方案取舍：为什么不是"平铺列表 + repo 徽标"

既然跨仓库工作集是少数，一个更便宜的替代方案是保留平铺列表，仅加 repo 徽标消歧 + 折叠主 checkout，只解断点 1/2 的展示部分。不选它的理由：

- 断点 3（创建的隐式魔法）只有在"创建的是工作集"这个实体下才能根治——显式的创建预览表单需要一个组实体作为载体，平铺方案下创建仍然是"给某个仓库建 worktree"，魔法只是换了个位置。
- 跨仓库工作集虽是少数，但一旦发生，平铺方案下它的 N 个物理行没有任何机制表达"它们是一组"，展示和操作都是碎的。
- 组机制是**双向门**：manifest 是纯增量数据，丢失或废弃时物理 worktree 毫发无损，可重新组织（§5.2、§9），决策可逆、退路成本低。

## 2. 目标

- Worktree tab 在多项目 workspace 下的列表复杂度为 O(组数)，与仓库数量无关。
- 创建时，将要发生的物理变更（在哪些仓库、从哪个基准、建到什么路径、创建什么分支、跑什么 setup）**一眼可见、就地可改**。
- 组级操作（折叠、删除、派生、加仓库）作用于组整体，且删除等破坏性操作只依据权威数据。
- session 按 cwd 自动归入组行；跑在主 checkout 上的 session 归入唯一的基准锚点行。
- **组 session 的写权限严格限定在 member worktree 内**（承诺 2）。
- 单仓库 workspace 下，本机制**退化为现有单仓库 UX 的操作路径与信息密度**，不产生额外负担。
- 仓库增删、基准变更后行为自洽：系统永远不替用户做不可逆的隐式变更。
- 存量（组化之前由扩展创建的）worktree 平滑迁移：不静默丢失、不凭启发式误分组。

## 3. 非目标与已知限制

- 不做组之间的依赖图、看板状态流转（Doing/Done 等）；组是"一组物理 worktree + 其 session"，不是项目管理对象。
- 不做跨 workspace 的组；组严格属于当前 workspace 的仓库集合（workspace 归属见 §9）。
- 不自动合并/变基/推送分支；git 历史操作仍由用户或 agent 在 session 内完成。
- 不做多仓库原子创建与原子删除：创建允许部分成功（§8）；删除是预检门禁 + 可恢复的逐成员执行（§6.4）。不引入事务或回滚机制。
- 第一版不做组模板、组归档视图。
- 不改变既有 Chats tab 的行为与信息架构；**删除 worktree 保留本地分支**，本功能不做分支清理。
- **已知限制：不支持把 session 在 Current 锚点与组之间移动。** session 归属由 cwd 结构性决定；未来可加 "Move session to group"。
- **已知限制：worktree 目录被删除后，其上的历史 session 不能直接恢复**（§6.4）；第一版不提供"重建 worktree 以恢复 session"的能力。

## 4. 核心概念与实体模型

```
Group:  groupId, displayName（可改，允许重复）, primaryMemberId, suggestedSlug, revision
Member: memberId, repositoryKey, worktreeKey?, branchName, path, state
```

- **groupId 是唯一身份。** 显示名只是展示；member 的 branchName/path 可以各不相同（外部已建的不同名 worktree 也可并入），分组关系只由 manifest 表达（承诺 1）。
- **revision 是持久化单调序号**：创建时为 1；rename、member 状态变化、primary 变更、member 增删、merge 每次成功写入递增。一切"预览后确认"的 mutation（M2 创建、M3 全部操作）把 group revision 绑进确认 token；确认时 revision 漂移即 fail-closed 要求重新预览——禁止用内容 fingerprint 替代（fingerprint 有 ABA 问题）。
- **不变式一：同一 workspace manifest 内，一个 WorktreeKey 至多属于一个组**（作用域论证见 §9）。
- **不变式二：同一组内，一个 repositoryKey 至多一个 member。** 一个仓库在同一个工作集里出现两个 worktree 没有合理场景；这条不变式使 Merge 冲突（§6.5）与 Add repo（§6.3）都有确定语义。
- **worktreeKey 仅在物理 worktree 创建成功后存在**；planned/provisioning/failed 状态下为计划值缺位（生命周期见 §4.2）。
- **suggestedSlug** 仅用于为新 member 生成默认分支名/路径名（§5.2），不作为跨仓库一致性约束、不要求全局唯一。

| 实体 | 职责 | 持久化 |
| --- | --- | --- |
| **Workspace 配置** | 每个仓库记忆的基准分支（沿用现有 `baseRefStore`） | 现有存储策略 |
| **Group（工作集/组）** | 上表字段 + member 集合 | 新增 manifest，`globalState` 按 `navigationIdentity` 分桶（§9） |
| **Session** | 挂在 Group 或 Current 锚点下；cwd 归属与可写目录分离 | 现有存储策略，填充规则收紧（§5.5） |

两个结构性概念：

- **组行**：Worktree tab 的一级条目。同一组的多个物理 worktree 聚合成一行；行下的一级内容是 session（跨 member 汇总），物理 worktree 是次要信息。
- **Current 锚点行**：固定在顶部的唯一基准行，**永久只占一个顶层行**（可展开查看其下 session），唯一职能是收容跑在各仓库主 checkout 上的 session。它不是被管理的 worktree：无 ⋯ 菜单、无删除、无派生按钮。两个由 M1 体验反馈修订的交互（2026-08-14 批注）：**① 行内保持紧凑**，只显示 `Current` + 状态 + session 数，各主 checkout 实际检出的分支（带仓库标签，如 `agent-pivot: main`）通过 hover 快速 tooltip **每行一个仓库**展示——内联长列表会把行名挤没；**② 锚点行保留一个快速创建 + 按钮**（创建主 checkout 的普通 session，与 Chats 的 + 等价）——用户在 Worktree 面板找不到创建入口的发现性问题优先于"入口只在 Chats"的纯度。没有活跃 session 时可弱化显示。

### 4.1 术语约定

对外文案**统一使用"Worktree 组"**，不半隐藏概念、不中英漂移：

- UI 文案（中英一致）：新建 Worktree 组 / 从此组派生 / 向组中添加仓库 / 从组中移除此 worktree / 移除组中的 worktree；tab 名保持 WORKTREES。
- 删除类文案必须写明"**仅删除 worktree 目录，保留本地分支**"——现有删除语义保留分支，"Delete" 类裸文案会让用户误以为分支也被删除。
- 内部模型、代码、协议字段统一称 **group**（实现时全仓一致）。本文档使用"组"。

### 4.2 Group / Member 生命周期与不变式

Member 状态机：

```
planned → provisioning → ready
                       ↘ failed → provisioning（Retry）
                                ↘ [移除]（Dismiss）
ready → deleting → deleted（从 manifest 移除）
```

规则：

- **planned**：已写入 manifest 的创建意图；`branchName`/`path` 是计划值，`worktreeKey` 缺位。
- **failed**：物理创建未完成的 member 留在组内（§8），支持 Retry / Dismiss。**Dismiss 只删除失败意图（member 记录），永不触碰任何已存在的物理目录。**
- **"仅创建可用 N/M"被跳过的仓库：不成为 member，不留任何记录。** 跳过是用户确认时的显式排除，不是"尝试过但失败"；事后想补建走 Add repo（§6.3）。
- **deleting 是持久化状态，删除是带 journal 的事务**（§6.4）：副作用前冻结 intent 与身份快照，逐 member checkpoint，重启后对账收敛；执行期失败时 member 回到 ready 并带失败标记 + Retry（Retry 重用 journal 冻结的原目标身份）；成功后从 manifest 移除并写入 retired identity。
- **primary 约束**：primary 必须指向 **operationally-ready** member（`state=ready` + 仓库当前可见 + worktree 非 bare + health ∉ {missing, prunable}——locked 不排除，locked worktree 仍存在且可用于 session——+ 映射后的 workspace paths 可用）。primary member 创建失败、被 Dismiss、脱离或 missing 时，组行提示重新选择 primary；**组内无 operationally-ready member 时禁用 New session**。移除 primary 时：存在其他 operationally-ready member → 删除前要求选择新 primary；无候选 → 允许 primary 为空；whole-group 删除不要求选择新 primary。
- **空组即消失**：最后一个 member 被删除或 Dismiss 后，group 的 manifest 记录随即移除，Worktree tab 不保留空组；其历史 session 只留在 Chats（§6.4）。

## 5. 关键设计决策（已确认）

### 5.1 创建的默认仓库集合：当前上下文，不做勾选记忆

跨仓库工作集是少数。创建表单中参与仓库是一个**始终可见的 checkbox 清单**（每项显示 `仓库名 ← 基准分支`），默认勾选规则（优先级从上到下）：

1. 从某行 ⋯ 菜单触发 → 默认勾选该行所属仓库（派生流程默认勾选源组的 member 仓库，见 §6.2）；
2. 从 tab 行触发 → 默认勾选活跃编辑器所在仓库；无活跃编辑器 → workspace 第一个仓库。

**不做勾选记忆。** 跨仓库是少数派场景，每次都是一个显式点击（清单内提供"全选"）；记忆上次勾选会让一次真实的全选毒害接下来一串单仓库工作集——"静默多建"会换个入口回来。默认值永远来自上下文，永远可预测。

### 5.2 组身份：manifest 为唯一权威，slug 只是命名建议

- **"这些物理 worktree 属于同一组"的判定、以及一切破坏性操作只依据 manifest。** 启发式（slug 相同、路径相似）永远不得自动升级为权威分组——删除错了 worktree 等于丢失他人未提交的代码，是不可恢复事故。
- **slug 的职责收敛为三件事**：创建时为各 member 建议默认分支名/路径名；发现层把同 slug 的无主 worktree 聚成"建议组"供用户勾选确认；manifest 丢失后辅助重新组织。slug 不要求全局唯一——两个仓库完全可能各有一个互不相关的 `fix-login`，它们不因此被合并（承诺 3）。
- **建议 slug 生成规则**：从显示名提取 ASCII 字母数字片段转 kebab-case；不足 3 个字符时（典型：纯中文名）回落 `task-<6 位短 id>`；目标仓库内分支名/路径冲突时自动追加短后缀并在预览中可见。member 间的分支名/路径**可以不同**（外部并入、历史后缀），不靠名称一致维持分组。
- **manifest 丢失（状态重置、换机器）= 重新组织，不是恢复。** 保证的是物理 worktree 毫发无损；丢失的信息（显示名、primary、创建时间、分组结构）不可还原，由用户通过 Adopt / Merge 重新组织（§6.5）。文案禁止承诺"恢复原分组"（承诺 5）。
- **重命名即重新生成 suggestedSlug。** 重命名只改显示名会让未来 Add repo / 派生仍按旧 slug 命名。重命名时按 §5.2 规则从新显示名重新生成 suggestedSlug（纯中文回落 `task-<id>`）；displayName、suggestedSlug、group revision 必须**同一次 manifest 写入**。slug 非权威身份，重新生成只影响未来 member 的默认命名与建议组聚类，既有 member 的分支/路径不动。

### 5.3 基准行降级为锚点（见 §4 Current 锚点行）

主 checkout 不再作为可管理的 worktree 行出现。消除的是"每个仓库一行主 checkout 占位"的噪音（N 行 → 1 行锚点）；session 在 Chats Active 与锚点行中的双处展示**保留**——两个 tab 回答的问题不同，不构成需要去除的重复。

### 5.4 组行内：session 是一等公民，物理 worktree 降级为次要信息

展开组行，第一级内容是 session 卡片（跨 member 汇总，按 attention → active → idle 排序；**卡片标注其 cwd 所属仓库**，跨 member 汇总的列表里 repo 归属必须可读），卡片保留现有缩进。物理 worktree 成员显示为一行次要摘要（如 `3 worktrees · agent-pivot, pi, infra ▸`），再展开才显示各 member 的路径、分支、状态与 member 级操作。

### 5.5 组 session 的写权限边界：严格隔离（承诺 2）

这是对现有行为的**收紧**，不是"沿用"：

- 组 session 的 cwd = primary member 的物理 worktree；`writableRootHostPaths` 与 provider additional directories **只包含该组 ready member 的 worktree 路径**。
- **未被选入组的 workspace 仓库（含其主 checkout）一律不进入可写范围。** 现有 sessionScope 会把 workspace roots 纳入可写范围，直接沿用会让"只选了 A 仓库的组"里的 agent 仍能改 B 仓库的 main——组隔离名存实亡。实现上复用现有身份字段，但填充规则收紧，需在 §11 与行为契约中显性表达。
- Current 锚点下的主 checkout session 保持现有非隔离 scope 不变（那是用户自己的主场，不是隔离工作集）。
- **存量 session 的升级策略**（scope 收紧随 M1 发布，§12）：
  - 升级前已在运行的 worktree session 无法热更新 scope，标记 **"Legacy workspace scope"** 直至重启；
  - 历史 session 恢复（resume）时立即按所属组的当前 member 集合重建严格 scope；
  - 验收覆盖新建、恢复、升级前仍在运行三类 session（§13）。

## 6. 用户流程

### 6.1 创建组

**交互形态：Worktree 面板顶部的内联展开表单，不用弹窗、不用 InputBox/QuickPick 序列。**

形态决策的理由：

- 预检阻断（仓库无提交、路径冲突等）时，modal 会把用户卡死在对话框里；内联表单允许用户直接去处理后回来，面板状态不丢。
- "输入名称时实时预览路径/分支变化"只有内联形态能承载；QuickPick 序列会把预览拆成多步，且逐行改基准、禁 setup、选 primary 要么做不了要么再嵌一层——与"创建入口的隐式魔法"是同一族问题，不重复犯。

行为：

1. 入口：tab 行图标按钮 / 组行 ⋯ 菜单（派生，见 §6.2）/ Current 锚点不出现建组入口（其 + 按钮只建主 checkout 普通 session，见 §4）。**Unmanaged 行的"从此分支新建 worktree"也被表单吸收**：打开表单、预选该仓库、基准预填该分支——不保留 QuickPick 旧流程，避免两套创建入口语义漂移。触发后在**列表顶部就地展开创建卡片**，不遮挡既有列表；**表单同时只允许一个实例**（新建入口在表单打开期间禁用；既有组内 failed member 的 Retry 不阻塞新建）。Esc 或收起按钮放弃且不产生任何副作用，再次打开时保留上次未提交的输入。
2. 输入组名（建议 slug 生成规则见 §5.2）；**预览随输入实时更新**（slug、各 member 的路径与分支名即时反映）。
3. 名称下方直接渲染**创建预览**，逐 member 一行，完整展示全部物理副作用：
   - 目标仓库（可取消勾选）与基准分支（可搜索下拉覆盖，列本地分支、已 fetch 的 remote-tracking 分支与记忆的基准；远端候选是上次 fetch 的快照，创建不自动 fetch；排序：记忆的基准置顶，其余字母序）；
   - 将创建的路径与**本地分支名**；
   - 将执行的 **setup command**：**按仓库维度解析配置**（resource-scoped，跨仓库组常同时包含 Node/Java/Go 仓库，全局单一命令不适用；这要求 `agentPivot.worktreeSetupCommand` 的注册 scope 为 `machine-overridable`，见 §11），预览中可**逐 member 禁用**；"无 setup 配置"与"setup 对该仓库不适用"分别明确表达；
   - 哪个 member 是组 session 的 **primary cwd**（可切换，仅 ready 后生效）；
   - **逐 member 的预检结果**（路径已存在、分支名占用、仓库无提交等）。
4. 预检任一项失败时**禁用普通确认**，不自动跳过错误行继续创建（静默部分执行同样是隐式魔法）；另提供显式动作："**仅创建可用的 N/M 个成员**"，文案列明被跳过的仓库与原因。被跳过的仓库不成为 member（§4.2）。
5. 确认后**组行立即出现**（member 以 planned/provisioning 呈现在组行内，不再是 Unmanaged 区的独立 provisioning 行），并行 provisioning 各 member；逐 member 记录状态（沿用现有状态机按 member 扩展）。**Host 仅对用户最终确认时预览中的 repositoryKey/路径/分支集合执行创建，预览值与执行值逐项一致。**执行期碰撞（确认后分支名/路径被外部占用，TOCTOU）时该 member **必须 failed（可 Retry），禁止静默追加后缀**——否则执行值偏离确认值（§8）。
6. 可访问性随本流程交付：完整的 Tab 顺序、Enter 确认、Esc 取消、错误与表单项的 ARIA 关联、确认后焦点回到新建组行。

**实时预览的工程契约**：输入防抖（约 300ms）后才触发重算；重算按仓库增量进行（只有受影响仓库重新跑 git 检查）；快速连续输入时**过期响应必须丢弃**（防串台）。确认消息携带完整的逐 member 计划集合，Host 逐项重新校验后才执行——"预览值与执行值逐项一致"（§13）在快速输入下也必须可复现。

### 6.2 从组派生组（stacked）

组行 ⋯ → "从此组派生"：**复用内联创建表单的 derive 模式**（§6.1 形态，含实时预览、预检门禁、一次性 preview token、argv 冻结）——每个 member 仓库从源组对应的分支拉新 worktree；源组不含的仓库若被勾选，回落到该仓库的基准。默认勾选源组的 member 仓库集合；名称默认 `源名-2`（追加短后缀，§14 开放问题 1 闭环），预览照常渲染、就地可改。derive 是**创建新组**（`createGroup`），不向源组添加 member。

**derive 候选资格**：

| 源组 member 状态 | 资格 |
| --- | --- |
| visible + repository 可解析 | 可参与 |
| detached（仓库移出 workspace） | 显示但不可选，注明原因 |
| failed / planned / provisioning | 不信任 manifest 的 branchName，从对应 repository refs 重新验证后才可作为基准 |
| missing 但 branch ref 仍权威存在 | 预检通过后可参与 |

### 6.3 向组中添加仓库

组行 ⋯ → "向组中添加仓库"：**复用内联创建表单的 add-repo 模式**——列出组尚未包含的 workspace 仓库（不变式二保证每仓库至多一个候选），slug 锁定为组的 suggestedSlug，按该仓库记忆基准生成默认分支/路径，预检、补建物理 worktree、原子写入 manifest（`addPlannedMembers`，含成员唯一性校验）。**默认勾选**：活跃编辑器所在仓库未入组 → 只默认勾选它；否则默认不选（跨仓库是少数，默认全选 = 静默多建）；清单内保留"全选"；零选择时确认按钮禁用。确认走与创建相同的一次性 preview token + 冻结管线，token 绑定组 revision，组在预览后被改动则确认 fail-closed 要求重新预览。

**对已有 session 的 scope 影响**：

- 默认只影响**之后新建**的 session；
- 正在运行的 session scope 不变；**"运行中的会话尚未包含新加入的仓库"是派生值而非事件标记**：逐 active/pending session 比较"组当前 ready member 经 rootBindings 映射后的 writable paths 集合"与该 runtime 持久化的 `writableRootHostPaths`，有新路径不在实际 scope 内即提示；组行内联汇总注记呈现（§14 开放问题 2 闭环），不逐卡片打徽标；
- 新 member 到达 ready 后才进入期望 scope；member 被移除时重新比较；M1 的 `legacyScope` 与本提示分开表达；
- session 重启/恢复时按其所属组的**当前 member 集合重建 scope**（自然升级，无需额外入口）。

### 6.4 删除：预检门禁 + 可恢复的逐成员执行（承诺 4）

**确认形态：webview 内联确认卡**（与创建表单同族、单实例互斥），不是原生 modal——要承载逐 member 列表、双动作与计数，且键盘操作 / 焦点恢复 / ARIA 关联随本流程交付。

**组级**：组行 ⋯ → "移除组中的 worktree"。确认卡逐条列出每个 member 的物理路径与检查结果（活跃 session、未提交改动、锁定等，复用现有 `isActive` 与 clean-check 语义）、受影响的历史 session 数量，并注明"仅删除 worktree 目录，保留本地分支"。

- **预检门禁**：任一可见 member 被阻断 → 不开始执行，确认卡逐条标明原因，用户处理后整体重试。
- **执行阶段不承诺原子性**：预检全过后，逐 member 执行仍可能因竞态、权限、进程占用部分失败。**已删除的不回滚**；未删除的 member 保留在 manifest（状态回 ready + 失败标记），组行提供 member 级 Retry，残余状态完整可见。
- **脱离 member（仓库已移出 workspace）在确认卡中显示为"不可操作"**，并拆成两个语义明确的动作：
  - **"移除当前可见 worktree"**：只删可见 member，组及脱离 member 保留在 manifest；
  - **"删除整个组"**：存在脱离 member 时阻断，提示先恢复仓库可见性——不允许一个叫"删除整个组"的操作留下不可见残余。

**member 级**：member 详情行提供 **"从组中移除此 worktree"**（Add repo 之后反悔的逆操作）：同样执行活跃 session / clean 检查；删除目录、保留分支；移除的是 primary 时按 §4.2 的 operationally-ready 规则处理；移除的是最后一个 member 时组随之消失（§4.2）。

**删除事务模型（journal）**：`git worktree remove` 的原子性不构成业务事务——`manifest 标记删除 → 物理删除 → manifest 移除 member → retired 写入 → 刷新`之间进程可能在任意边界退出。

- **单一 aggregate**：deletion journal 与 retired identities 与 manifest 同属一个持久化 aggregate（同一 `globalState` key、按 `navigationIdentity` 分桶的版本化 blob），跨三者的事务由一次原子写入提交，无跨 key 两阶段窗口。
- **beginDeletion（副作用前全部完成）**：取得 admission mutex（见下）→ 逐 member 最终复检 blocker → 冻结受影响 session 清单与 `generationCutoffAt` → 生成每个目标 member 的 `retirementId` → 按冻结快照预占 retired 容量（不足即 `store-full`，零物理副作用）→ member 置 `deleting` → journal 落盘（operationId、操作模式 group/member/visible-only、目标快照、原 primary、关联 preview token）。
- **逐 member checkpoint**：每成功删除一个 member 立即在同一 aggregate 内完成"retired 写入 + manifest 移除 + journal 推进"；失败 member 恢复 ready + 失败标记，journal 进入 partial（仅保留该 member 的冻结快照）。**Retry 重开同一 operation**，不重推断目标、不重快照；用户可放弃 partial intent（释放预占、清错误标记，不触碰仍存在的 member）。journal 终态后归档。
- **重启对账（fail-closed，绝不猜测成功）**：member 路径确定不存在 → 用 journal 冻结信息完成移除；worktree 仍正常存在 → 恢复 ready + `deletion-interrupted` + 可 Retry；discovery 截断 / 仓库脱离 / 状态未知 → **保留 deleting** 并持续阻断该组 mutation，直到获得确定快照。

**mutation lease 与 admission mutex**：

- 某组存在 active deletion journal 时，阻断该组的 Add repo、Adopt（作为目标）、Merge（作为 source 或 target）、再次删除、primary 变更、新 session、rename；只放行 deletion Retry、放弃 partial intent 与查看操作。这保证"删除整个组"的确认不被并发 mutation 落空。Merge 同时校验 source 与 target 两组（按稳定 groupId 顺序）。
- **admission mutex**：deletion admission 与 New session admission 共用按 `{navigationIdentity, groupId}` 的 Host mutex。deletion 从最终 blocker 复检持锁到 journal 落盘；New session 在创建任何 pending binding / terminal 副作用前取同一把锁并在锁内复查 active journal 与持久化 generation claim（见下）；锁关闭"journal 写入前新 session 溜进来"的竞态窗口。执行期逐 member 复检作为纵深防御保留。

**删除后历史 session 的规则（retired identity + 世代模型）**：历史 session 保留在 Chats，标记"**工作目录已删除，无法直接恢复**"，不阻断删除；确认卡显示受影响的历史 session 数量。第一版不提供重建 worktree 以恢复 session 的能力，UI 不得暗示其仍可恢复。

- **retired identity 是持久化的历史事实**（`retirementId`、repositoryKey、canonicalWorktreePath、branchName 快照、`deletedAt`、`generationCutoffAt`、来源 group/member、删除时冻结的受影响 session 清单），不是当前文件系统状态；M1 的 manifest path fallback 在 member 移除后由它接管，workspace root 之外的历史 session 不从 Chats 消失。retired **只能由有 journal 的成功删除产生**——绝不把普通 missing/prunable member 推断为 retired。
- **世代模型**：同一路径可被重建并产生新世代 session。Agent Pivot 在 retired path 上创建 session 时写入持久化 **generation claim**（`createdAfterRetirementId`，pending 创建时产生、sessionId 确认后在 aggregate 内原子晋升、独立于 terminal binding 寿命存续）。**pending claim 从持久化成功起始终阻断 deletion**，释放仅三条路径：晋升、`proven-not-started` 补偿删除（runtime 层结构化结论：create 命令自身失败/terminal 未创建/launch 前取消；超时、启动后异常、恢复不确定一律保留）、用户显式处理；其写入失败即在任何副作用前拒绝创建。判定顺序：journal 冻结清单 → 匹配 claim → 稳定 creation time（≤ cutoff 为旧世代）→ 无可靠依据一律按旧世代 fail-closed；可变的 `updatedAt` 不作依据。`generationCutoffAt` 为 UTC epoch ms，写入 `max(now, lastGenerationCutoffAt + 1)`；`lastGenerationCutoffAt` 是 aggregate 内的持久化高水位，retired 清理不回退。持久化身份冲突（重复 retirementId 等）进入 bucket 级隔离：retired/claim 段读空、变更 fail-closed，不按数组顺序猜测。
- **retired 清理（容量出口）**：仅当所有 provider 历史源 available、扫描无截断无错误、且 active / pending / history 三类引用皆空时允许清理单条记录；"没查到"不等于"没有"。容量写满时新的删除在副作用前以 `store-full` 拒绝。

### 6.5 重新组织：Adopt 与 Merge（用户确认制）

**无主 worktree → 组**：发现层把无 manifest 记录、slug 一致的物理 worktree 聚成**建议组**（仅是建议，不是权威）。

- **"Adopt 为新组"**：展示建议组的可勾选 member 列表（slug 一致只是预填建议，用户可取消任意成员），确认后写入 manifest；
- **"Merge 到现有组"**：用户选择目标组并勾选要并入的 worktree——**允许并入不同名的外部 worktree**（member 的身份是 WorktreeKey，不是 slug）；
- 单个无主 worktree 走同一路径（建议组大小为 1）。

**组 → 组 Merge**（迁移播种后的主要重组工具）：

- 用户选择**保留哪个组**（其 groupId / displayName 存续），并确认 primary；
- source 组的全部 member（含 failed / 脱离 member，状态随行）转入目标组；
- source 组的 manifest 记录删除；
- **冲突阻断**：两组在同一 repositoryKey 各有 member 时（违反不变式二的潜在冲突）阻断，提示先通过 member 级移除（§6.4）解决；
- 两组 session 的 cwd 不变，投影归入目标组。
- **原子性与领域边界**：Adopt（多个无主 WorktreeKey 进新组/现有组）与 Merge 都是"先完整校验（容量 / repository 冲突 / WorktreeKey 占用 / primary / 双方 revision / lease）、再一次 aggregate 写入"的原语；Merge token 同时绑定 source 与 target 的 revision。Merge 只能整体移动 source 全部 member，与 Unmanaged 勾选 Adopt 不混为同一动作。

## 7. 自洽性规则

唯一原则：**系统永远不替用户做不可逆的隐式变更。**

| 场景 | 行为 |
| --- | --- |
| workspace 新增仓库 | 存量组不变，不偷偷补建；补建只能显式触发（§6.3） |
| 新增/重加仓库中的"野生" session | cwd 命中 **manifest 中的 member（含脱离 member 重新可见）** → 投影归原组；未命中 manifest → 进 Unmanaged / 建议组，**绝不凭 slug 自动归入正式组**（承诺 3） |
| workspace 移除仓库 | 组行只显示可见 member；磁盘上的 member 不删不报错；manifest 保留脱离标记；删除走 §6.4 的双动作语义；仓库加回后自动归位。**manifest 的 workspace 归属不因此改变**（§9） |
| 仓库基准变更（1.0 → 1.1） | 只影响未来组的默认基准；存量组的 member 分支不动 |
| 外部 `git worktree move` / 手动删除 | 沿用现有快照对账：member 健康状态降级（missing/prunable），组行仍在，member 级提示 |
| manifest 丢失 / 换机器 | 物理 worktree 无损；分组结构不可自动还原，以建议组形式呈现，用户 Adopt / Merge 重新组织（§5.2、§6.5） |
| 单仓库 workspace | 整个机制退化：创建预览只有一行、无仓库勾选概念、无 member chips；**预检无失败时 Enter 直接提交**（与现行 InputBox 流程步骤数相等，§13 的"无额外负担"在 M2 继续成立）；Current 锚点显示单个带仓库标签的实际分支；操作路径与信息密度与现状一致 |
| 组只剩一个 member | 不特殊处理；组模型天然兼容单 member，这也是多数派场景 |

## 8. 错误与部分失败

- **创建/补建**：部分失败是一等状态。组行照常出现并可正常使用已建成的 member；失败的 member 留在组内（§4.2），在摘要行内显示人话错误（不显示裸错误码）+ member 级 Retry / Dismiss。
- **执行期碰撞**：确认到执行之间分支名/路径被外部占用（TOCTOU）时，该 member 以预检同类错误 failed 并可 Retry；**任何创建路径都不得在执行期静默改名的后缀重试**（§6.1 行为 5 的推论，替代 M1 单仓库流程的碰撞重分配行为）。
- **删除**：预检门禁保证"启动前全拦截"；执行期部分失败时不回滚、残余 member 保留在 manifest、提供 Retry，状态完整可见（§6.4）。
- **聚合状态**：任一 member 或 session 需要关注 → 组行 needs attention。`repository-has-no-commits` 等可重试错误在 member 级保留现有语义。

## 9. 迁移与存储

**存储位置与 workspace 归属**：manifest 存于 `globalState`，按现有 **`navigationIdentity`**（`src/workspaces/identity.ts`；对保存的多根 workspace 即 `.code-workspace` 文件身份）分桶。**禁止**按 `scopeIdentity`（由当前 root 集合计算）分桶——增删一个仓库就会改变它，会直接违反"仓库移除后保留、加回后自动归位"的承诺。仓库增删不改变 manifest 的 workspace 归属。

**单一 aggregate（M3 起）**：每个 bucket 是一个版本化 blob，内含 `groups`（含 per-group 单调 `revision`）、`deletionJournal`、`retiredIdentities`、`generationClaims` 四节及 workspace 级 `aggregateRevision` / `lastGenerationCutoffAt` 高水位。跨节事务（如删除 checkpoint = retired 写入 + manifest 移除 + journal 推进）必须一次原子写入完成；aggregate 有序列化字节上限与各类记录数上限，超限在副作用前 fail-closed。webview mutation 的 settlement 绑定提交后的 `aggregateRevision`：webview 只在应用了同 identity 且基于不低于该 revision 的 aggregate 的 authoritative replacement 后才清除 pending；publication coordinator 串行化投影并丢弃基于旧 aggregate 的迟到结果。

**唯一性作用域**：不变式一（WorktreeKey 至多一组）限定在**同一 workspace manifest 内**。同一物理 worktree 被两个不同的 `.code-workspace` 打开时，在各 workspace 的 manifest 中独立成组、各自展示——这是已知且可接受的规则（组不做跨 workspace，§3），写入行为契约。

**存量迁移**（M1 的组成部分）：

1. **自动播种的最小单位是"一个 worktree 一个组"**：首次启动时，对可确认为扩展产物的 worktree（命中扩展分支命名前缀，或存在于 `provisioningStore` 恢复记录）各生成一个单 member 组。**不得仅凭 slug 相同自动跨仓库合并成权威组**——启发式猜测一旦写入 manifest，就成为未来删除操作的权威依据，违反承诺 3。
2. **同 slug 只作为"建议合并"呈现**，且**组 → 组 Merge 的最小可用版本随 M1 交付**（§6.5、§12）——否则 M1 会把原本属于同一跨仓库工作的 worktree 拆成一组一行，M1 的价值主张不成立。
3. 迁移幂等：已有 manifest 记录不被播种覆盖。
4. **M1 起，所有新建 worktree（包括旧的单仓库创建流程）必须同步写入 manifest**——否则 M1 发布后新创建的 worktree 会直接掉进 Unmanaged。
5. **in-flight member 对账（M2）**：重启后 manifest 中停留在 `provisioning` 的 member 由 reconciliation 降级为 `failed`（`interrupted`，可 Retry）——进程退出时未完成的状态不得永远卡住。provisioning 恢复记录携带 groupId，恢复时**关联回既有组**，不得新建重复组；物理 worktree 已建成但状态未落的 member，按既有恢复记录的完成度判定（与 §9 播种的不完整记录阻断规则一致）。

## 10. UI 结构

```
WORKTREES | CHATS                          [collapse-all] [new]
─────────────────────────────────────────
▸ Current · agent-pivot: main · pi: 1.0     ← 锚点行：实际检出分支 + 仓库标签
─────────────────────────────────────────
▼ fix-login        ag·p·i     ● attention   ← 组行：名称 / member chips / 聚合状态
    ├─ [session 卡片 · agent-pivot]          ← 一级内容：session（标注 cwd 仓库），缩进
    ├─ [session 卡片 · pi]
    └─ 3 worktrees · agent-pivot, pi, infra ▸ ← 次要摘要，再展开见 member 明细与操作
▸ 修复登录 · agent-pivot/fix-login-2   ag   · idle   ← 同名冲突时显示稳定分支短名
─────────────────────────────────────────
▸ Unmanaged (n)  ● 2                        ← 无主 worktree；参与 attention 聚合
```

- **创建中的组行**（M2）：确认后组行立即出现在列表中，member 逐行显示 provisioning 进度 / failed + Retry / Dismiss；**任一 member 仍在 planned/provisioning 时禁用 New session**——此时建 session 的 scope 会静默缺少该仓库。**已结算为 failed 的 member 不阻塞**（§8）：其仓库不进入 scope，member 行内可见并可 Retry/Dismiss。创建表单本身固定在列表顶部，收起不丢失输入（§6.1）。
- **member chips 规则**：单仓库 workspace 不显示；多仓库 workspace 下所有组行显示（单 member 组显示 1 个 chip——承担"这组在哪个仓库"的消歧职能）；取**最短唯一前缀**（`agent-pivot`/`agent-platform` → `ag`/`p` 之类的首字母碰撞由前缀消歧，不接受"首字母→两字母"的退化规则）；每个 chip 与 `+N` 折叠提供完整 accessible name（hover tooltip 对键盘与屏幕阅读器不可用，不能作为唯一载体）；超过 4 个折叠为 `+N`。
- **同名消歧**：显示名重复（尤其同仓库）时，组行稳定显示分支/路径短名（如 `修复登录 · agent-pivot/fix-login-2`）；**不依赖会变化的状态或被推迟的时间信息承担身份消歧**。
- **组行排序**：聚合状态（attention → active → idle）→ 最近活动时间。
- **Unmanaged 不藏信息**：参与全局 attention 聚合与排序；内含需要关注的 session 时显示计数徽标并自动展开（或提供等价的一眼可见手段）。
- 组行 ⋯ 菜单：New session（快速 / 各 provider）、从此组派生、向组中添加仓库、重命名、移除组中的 worktree；member 详情行：从组中移除此 worktree、Retry / Dismiss（failed 时）。文案遵循 §4.1。
- **member 摘要行可展开（M3）**：次要摘要（`3 worktrees · …`）展开为 member 详情列表——各 member 的路径、分支、状态与 member 级操作（§6.4 的移除、Retry/Dismiss）；展开/收起沿用现有折叠机制与 collapse-all，170px 最小宽度下不横向溢出。
- **删除确认卡（M3）**：§6.4 的内联确认卡在列表顶部就地展开（与创建表单同族、单实例互斥），逐 member 列出路径 / 检查结果 / 历史 session 计数与脱离 member 双动作；Esc 或收起放弃且无副作用；键盘操作、焦点恢复、ARIA 错误关联随流程交付。
- collapse-all 按钮作用于组行与锚点行，沿用现有实现。
- **可访问性是核心流程的一部分**：创建表单、可搜索下拉、多选、错误提示、删除确认的键盘操作 / 焦点恢复 / ARIA 名称与错误关联随 M1/M2/M3 的核心流程交付（§12），不推迟到打磨期。

## 11. 技术实现映射（基于 feat/worktree-model）

| 工作块 | 涉及模块 | 要点 |
| --- | --- | --- |
| manifest 持久化 | 新增 store（`globalState`，按 `navigationIdentity` 分桶） | Group/Member 模型与状态机（§4/§4.2）；两条不变式校验；§9 迁移播种；所有创建路径同步写入 |
| 聚合视图模型 | `snapshotCoordinator` / webview 投影 | WorktreeSnapshot → 组行投影：manifest 分组（权威，含脱离 member 归位）+ slug 建议组 + Current 锚点（实际分支 + 仓库标签）+ Unmanaged（参与 attention）；纯函数、可测 |
| 多仓库 provisioning | `provisioningPlan` / `provisioningController` / `gitWorktreeProvisioner` + 新增组级编排器 | 确认即写 manifest（planned members，store 已支持零 ready 组）→ 并行 per-member provisioning → 逐 member finalize 状态机；预检（路径/分支/无提交）；**per-repo setup 要求 `worktreeSetupCommand` 注册 scope 为 `machine-overridable`**（原 `machine` 不支持 folder 覆盖）；恢复记录带 groupId 关联回既有组；执行期碰撞 fail-closed（§8）；Retry/Dismiss 复用现有 settlement 协议形态 |
| 组 session 启动与 **scope 收紧（M1）** | `isolatedSessionController` / `sessionScope` | cwd = primary ready member；`writableRootHostPaths` 与 provider additional dirs 只含 ready member 路径（**收紧现有 workspace-roots 填充**，承诺 2，须入行为契约）；resume 按当前 member 重建；存量运行中 session 标 "Legacy workspace scope" |
| 组级/member 级删除 | `managedWorktreeRemovalController` / `removalProtocol` + 新增删除 journal（manifest aggregate 内） | 预检门禁（逐 member `isActive` + clean-check，任一阻断不开始）+ 逐成员执行（承认 `partial`，不回滚，残余 + Retry）；journal 副作用前冻结快照 + 容量预占 + 重启对账（§6.4）；脱离 member 双动作；retired identity 与世代模型接管历史 session 标记；mutation lease + admission mutex |
| 组 → 组 Merge | manifest store + 投影 | M1 交付迁移建议合并的最小版本；M3 交付任意 Adopt/Merge；冲突阻断（不变式二） |
| Webview UI | `webviewContent.ts` / `media/` | 锚点行、组行、member 摘要/详情行、创建预览表单（完整副作用 + 预检 + "仅创建可用成员"；基准下拉数据源为 `git for-each-ref` 本地分支、已 fetch 的 remote-tracking 分支 + 记忆基准，§6.1）、Adopt / Merge 勾选界面、a11y |

session 归属的 cwd 匹配机制不变；聚合投影把物理 worktree 归到组行。切换 session 命令的视图跟随改为指向组行。

## 12. 里程碑拆解

每个里程碑**连同其行为契约一起交付**；可访问性（键盘 / 焦点 / ARIA / 错误关联）随 M1/M2/M3 的核心流程交付，M4 只做视觉与体验打磨。

1. **M1 投影、隔离与迁移**：manifest（含播种与"新建即写入"）+ 聚合视图模型 + 组行/锚点行 UI + **scope 收紧（含 Legacy 标记与 resume 重建，承诺 2 从第一个发布版就成立）** + **迁移建议合并（组 → 组 Merge 最小版）**。创建仍为单仓库，但创建成功即写入单 member 组。
2. **M2 多仓库创建**：内联创建表单（§6.1，面板顶部就地展开、实时预览、非弹窗）+ per-repo setup + 预检门禁 +"仅创建可用成员" + 并行 provisioning + member 状态机（failed/Retry/Dismiss）。
3. **M3 组级与 member 级操作**：删除（门禁 + 可恢复执行 + 历史 session 规则）、Add repo（含 scope 演进）、member 级移除、派生、重命名、任意 Adopt / Merge。
4. **M4 打磨**：动画、空态文案、切换跟随、视觉层级精修。

每个里程碑独立可发布；M1 完成后断点 1/2 消除、断点 4 通过迁移合并解决主要场景，断点 3 在 M2 根治。

## 13. 验收标准

**正确性与安全（承诺导向）**：

- **Host 仅对用户最终确认的 repositoryKey/路径/分支集合执行创建，预览值与执行值逐项一致**（替代不可测的"错误率"表述；以确定性契约表达"不在错误仓库创建"）。
- 创建只包含 A 仓库的组，其 session 身份与启动命令中**不得出现 B 仓库的主 checkout**；三类 session 全覆盖：新建（严格 scope）、恢复（按当前 member 重建）、升级前仍在运行（标 Legacy 直至重启）（承诺 2）。
- manifest 中不存在的 worktree 永远不出现在任何删除确认列表中；迁移不得仅凭同 slug 自动建立跨仓库权威组（承诺 3）。
- 删除执行期人为制造部分失败：已删 member 不回滚，残余 member、manifest 与 Retry 状态完整可见（承诺 4）。
- 清空 manifest 后重启：物理 worktree 无损，以建议组呈现，可 Adopt / Merge 重新组织（承诺 5）。
- 生命周期：failed member 可 Retry/Dismiss，Dismiss 不触碰物理目录；无 ready member 的组禁用 New session；最后一个 member 移除后组消失且不残留 manifest 记录。
- Merge：组 → 组冲突（同 repositoryKey）阻断；member 转移后 source manifest 删除；session cwd 不变。
- **删除事务（M3）**：预检任一失败 → 零物理副作用；删除在 journal 写入后 / 部分 checkpoint 后 / manifest 移除前等边界崩溃，重启后按对账规则收敛（不存在→完成移除；仍存在→ready+interrupted 可 Retry；未知→保留 deleting 并持续 lease）；partial 删除的 Retry 重用 journal 冻结身份；retired 容量不足在副作用前 `store-full`。
- **历史身份与世代（M3）**：member 移除后历史 session 仍在 Chats（含 workspace root 之外），能查看对话、旧世代不能恢复；同一路径重建后的新世代 session 凭 generation claim 正确判新；连续两轮删除/重建各自归属正确；无任何可靠依据的 session 一律按旧世代 fail-closed。
- **并发与一致性（M3）**：active deletion journal 期间该组的 Add repo / Adopt / Merge / primary / rename / 新 session / 再次删除全部阻断；New session 与 deletion admission 共用 `{navigationIdentity, groupId}` mutex；settlement 绑定 `aggregateRevision`，webview 只在应用了基于不低于该 revision 的 aggregate 的 replacement 后清除 pending。

**产品价值**：

- 用户不展开 member 详情，即可判断每个组属于哪些仓库（chips 可读性走查，含最短唯一前缀与 accessible name）。
- 相同显示名、相同仓库的两个组通过行上稳定的分支/路径短名区分（不依赖状态或时间）。
- 多项目 dogfood：3 仓库 workspace 创建 5 个组（含 1 个跨仓库），列表行数 ≤ 组数 + 锚点 + 兜底组。

**回归与性能**：

- M1 后单仓库 workspace **核心操作路径与信息密度无额外负担**（列出允许的视觉变化：主 checkout 行变为锚点行、worktree 行变为组行、展开层级变化；不允许的变化：操作步骤增加、信息消失）。现有行为契约全绿。
- M1 发布后新建的单仓库 worktree 不进入 Unmanaged。
- 同一物理 worktree 被两个 `.code-workspace` 打开时各自独立成组、互不影响（已知规则入契约）。
- 64 个物理 worktree（发现上限）规模下，聚合投影为纯函数且单次计算 < 16ms。

## 14. 开放问题

1. ~~派生组时新组的显示名/建议 slug 默认值~~——**已定（v6）**：追加短后缀（`源名-2`），预览中可见，§6.2。
2. ~~"运行中的会话尚未包含新加入的仓库"提示的呈现形式~~——**已定（v6）**：组行内联汇总注记 + 运行时 scope 差异派生，§6.3。
3. "Legacy workspace scope" 标记的具体呈现与是否提供"重启以启用隔离"的快捷动作——M1 实现时定，倾向提供。
4. 组行 hover 详情的信息层级（member 列表、创建时间）——M4 视觉稿定。
