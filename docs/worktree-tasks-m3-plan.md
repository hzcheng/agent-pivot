# Worktree Tasks M3 实现前评审与实施方案

日期：2026-08-15（v5.1，第五轮评审确认稿；两条实现约束已并入决策 E/J）

状态：M1/M2 已交付；本文档是 M3（组级与 member 级操作）的实现前评审，确认后回写 PRD v6，然后按批次实现

评审范围：PRD §6.2–6.5（派生 / Add repo / 删除 / Adopt & Merge）、§4.2 状态机、§10 UI 结构、§12 里程碑、§14 开放问题 1/2。

## v4 → v5 修订摘要（对应第四轮评审 1 阻塞 + 3 重要 + 2 具体值确认）

| 评审项 | 处理 |
| --- | --- |
| 阻塞：generation claim 未定义"属于哪一代"（多轮删除/重建） | 决策 E 定案**世代身份模型**：retired record 带稳定 `retirementId`；claim 携带 `createdAfterRetirementId` 引用（非布尔）；claim 独立于 runtime binding 寿命持久化 |
| 重要：`generationCutoffAt` 时间域不明 | 决策 E 定案：UTC epoch ms + 注入 `nowMs()` + `max(now, previousCutoffAt + 1)` 防回拨；provider creation time 归一化；批 2 纳入 creation time 采集与模型贯通（已核实 `CodexSession` 仅有 `updatedAt`） |
| 重要：`minimumViewRevision` 不能证明"包含本次 mutation" | 决策 J 定案：aggregate 增加 workspace 级 `aggregateRevision`，settlement 绑定它，publication coordinator 丢弃基于旧 aggregate 的迟到投影 |
| 重要：lease 管不到 journal 写入前的 session-start 竞态 | 决策 J 定案：deletion admission 与 New session admission 共用**按 groupId 的 Host mutation mutex**（已核实新 session 的 pending/runtime binding 不经过 group aggregate Store） |
| 具体值：截断策略表述 | 修正：聚合计数**仅诊断**，不参与世代判定；无精确身份且无 claim/可靠 creation time → 一律旧世代 fail-closed |
| 具体值：诊断环 8 条 | 保留，补约束：非权威、不参与恢复/对账、只存摘要与 error code、不复制 affectedSessions、受 aggregate 字节上限约束 |

## 1. 现状盘点

| M3 子特性 | 现状 | 缺口 |
| --- | --- | --- |
| 重命名 | store 有 `renameGroup` | UI 无入口；rename 需同步重新生成 slug 并递增 revision（决策 H/G） |
| 派生（§6.2） | 仅单仓库 branch seed | 源组基准覆盖；默认勾选源组仓库；候选资格（决策 F） |
| Add repo（§6.3） | 不存在 | 整个流程 + scope 演进提示（决策 D）；原子 `addPlannedMembers` |
| 组级删除（§6.4） | ⋯ 菜单 Remove 只删 primary member，走单 worktree 流程 | 删除 journal、内联确认卡、脱离双动作、历史 session 计数、mutation lease + admission mutex（决策 J） |
| member 级移除（§6.4） | 无处挂载 | member summary 静态不可展开；member 详情 UI 不存在 |
| 历史 session 删除标记（§6.4） | 依赖 manifest member path → WorktreeKey fallback | member 移除后 fallback 消失；retired identity + 世代身份模型接管（决策 E） |
| session creation time | `CodexSession` 仅 `updatedAt`（已核实 `models.ts`）；hydration 只投影 `updatedAt` | 各 provider 稳定 creation time 的采集、模型贯通、降级路径（决策 E，批 2） |
| session 持久身份 | terminal binding 有显式 `remove()`（已核实 `terminalBindingStore.ts`），寿命不可靠 | generation claim 需独立持久化， surviving binding 清理（决策 E） |
| Adopt（§6.5） | 不存在 | 建议组聚类、Adopt 入口、原子 `adoptReadyMembers` |
| 任意 Merge（§6.5） | 仅同 slug 候选 + QuickPick；冲突阻断已有 | 去 slug 限制；survivor/primary 原子确认；`mergeGroupsAtomically`；双 lease |
| 删除状态机 | store 已支持持久化 `deleting` | 无 journal、checkpoint、重启对账规则 |
| group/view/aggregate revision | 均不存在 | `WorktreeGroup.revision`（G）；workspace view publication 序号 + `aggregateRevision`（J） |

## 2. 决策点（v5 定案版）

### A. 删除确认框的形态 —— webview 内联确认卡【已确认】

§6.4 要求逐 member 列出物理路径 + 检查结果 + 受影响历史 session 数 + 脱离 member 双动作；§10 要求键盘 / 焦点 / ARIA 随 M3 交付。确认卡与创建表单互斥（单实例语义）。

### B. 删除事务模型 —— 单一 aggregate + 删除 journal【已确认】

**存储边界**：deletion journal 与 retired identities 纳入 manifest **同一个持久化 aggregate**（同一 `globalState` key 的版本化 blob，按 `navigationIdentity` 分桶），跨三者事务由**一次 `memento.update`** 提交。

**事务时序（一切身份快照在副作用前冻结）**：

```text
beginDeletion(intent):
  1. 取得该 groupId 的 Host mutation mutex（决策 J）
  2. 逐 member 最终复检 blocker（活跃 session / 未提交改动 / locked / provisioning）
  3. 快照 affectedSessions：{provider, sessionId}[]（去重 + 字符串边界校验）
  4. 写 generationCutoffAt（时间域见决策 E）
  5. 生成每个目标 member 的 retirementId（决策 E）
  6. 按实际冻结快照预占 retired 容量
  7. member → deleting；journal 持久化以上全部 + operationId + 操作模式
     （group / member / visible-only）+ 原 primaryMemberId + 关联 preview token
  8. 释放 mutex
  —— 以上全部完成前，零物理副作用 ——

checkpointDeletedMember：只消费 journal 冻结信息 → 写 retired + 移除
  manifest member + 推进 journal（单次 aggregate 写入）
failDeletionMember：member 恢复 ready + lastError；journal 进 partial
  （仅保留该 member 原始目标快照与操作上下文）
Retry：重开同一 operation（不新建 journal、不重推断目标、不重快照）
completeDeletion：终态后 journal 归档
abandonDeletion：放弃 partial intent = 释放预占 + 清错误标记，不动 member
```

**容量边界（副作用前 fail-closed）**：单 record `affectedSessions` 数量上限；aggregate 总 retired 记录数上限 + 序列化字节上限；`beginDeletion` 按**实际冻结快照字节**预占；超限 → `store-full`，零物理副作用。

**截断语义（v5 修正表述）**：单 record 明细超限时，**精确 session 身份确实丢失**；provider 聚合计数仅作诊断，**不参与世代判定**。未保留精确身份且无法提供匹配 generation claim / 可靠 creation time 的 session，一律按旧世代 fail-closed（决策 E 规则 3 兜底，不会错放）。

**journal 归档**：终态后移出 active journal，成功写入则进入**诊断环（最近 8 条）**；容量不足时可丢弃诊断摘要，不影响权威事务。诊断环非权威、不参与恢复或对账、只存摘要与 error code、不复制 `affectedSessions`、始终受 aggregate 字节上限约束。

**重启对账规则**（fail-closed）：

| 观察 | 对账动作 |
| --- | --- |
| member 路径确定不存在 | 用 journal 冻结信息完成 manifest 移除 + retired 写入，journal 推进 |
| worktree 仍正常存在 | 恢复 `ready` + `deletion-interrupted`，允许 Retry |
| discovery 截断 / 仓库脱离 / 状态未知 | **保留 `deleting`**，lease 持续阻断该组 mutation，待确定快照 |

### C. Add repo / 派生的交互载体 —— 复用内联创建表单【已确认】

两者都必须走 M2 完整管线（实时预览 + 预检 + 一次性 token + argv 冻结 + 逐项绑定）。协议层拒绝无 token 请求。

- `add-repo`：候选 = 组尚未包含的仓库；slug 锁定；基准取记忆基准；无 primary 切换（除非组无 ready primary）。**默认勾选**：活跃编辑器所在仓库未入组 → 只勾它；否则默认不选；保留"全选"；零选择禁确认。
- `derive`：预勾选 = 源组 member 仓库集合（候选资格按决策 F）；基准覆盖为源组对应 member 分支；名称默认 `源名-2`。

### D. scope 演进提示 —— 映射后 writable paths 差异派生【已确认】

```text
期望 scope = 组当前 ready member → 各自 repository.rootBindings
  → mapWorktreeBoundHostPaths → 跨平台归一化（Windows 大小写 / 分隔符）+ 去重
scopeOutdated = expectedMappedWritablePaths ⊄ runtime 持久化的 writableRootHostPaths
```

新 member 到 `ready` 才进期望 scope；逐 active/pending session 独立判定；结束 / resume 后消失；member 移除重新比较；`legacyScope` 与 `scopeOutdated` 分开；组行内联汇总注记。测试覆盖 repository-relative 子目录 binding、Windows 大小写、路径分隔符。

### E. 历史 session 身份 —— retired identity + 显式世代身份模型【v5 定案】

**retired record**（纳入决策 B 的同一 aggregate）：

```text
retiredWorktreeIdentity:
  retirementId              // 稳定唯一 id，beginDeletion 生成（不只靠 WorktreeKey）
  repositoryKey, canonicalWorktreePath, branchName（快照）
  deletedAt                 // 实际物理删除时间，仅展示
  generationCutoffAt        // 世代边界（UTC epoch ms，见时间域）
  origin: { groupId, memberId, displayName }
  affectedSessions: { provider, sessionId }[]   // beginDeletion 冻结，权威
  truncated?: boolean
```

**世代身份模型（v5 定案，解决多轮删除/重建）**：

同一路径可多轮删除重建：S2 对 R1 是新世代、对 R2 是旧世代——布尔 claim 无法表达。定案：

1. **generation claim 携带相对引用**：Agent Pivot 在 retired path 上创建 session 时，在创建入口（pending 创建时）写入 `createdAfterRetirementId` = 该 WorktreeKey **当时最新**的 retirementId；sessionId 确认后**原子晋升**为 `{provider, sessionId}` 级持久记录。
2. **claim 独立持久化，不依赖 runtime binding 寿命**：terminal binding 有显式 `remove()`（已核实 `terminalBindingStore.ts`），claim 存于独立的持久化 store（aggregate 的 generationClaims 节），在 binding 清理后继续存在，直到对应历史 session 被权威确认删除（随 retired 清理规则或历史归档释放）。

**pending claim 即持久化 admission marker（v5.1 确认约束，批 2/批 3 实现约束）**：New session 与 deletion 跨存储（claim aggregate vs terminal binding/provider session），顺序必须定死，保证无论谁先取得 mutex 都不漏过对方：

1. mutex 键为 `{navigationIdentity, groupId}`，不是裸 groupId。
2. New session 持锁检查 journal 后，**先持久化** `{pendingId, worktreeKey, createdAfterRetirementId, state: 'pending'}`。
3. pending claim 一旦提交**即算 deletion blocker**（beginDeletion 的 blocker 复检必须命中）；提交后才能释放 mutex 并创建 binding/terminal。
4. claim 写入失败或 `store-full` → 在任何 terminal/provider 副作用前拒绝创建。
5. 启动失败 → 补偿删除 pending claim。
6. 崩溃恢复：claim + binding/runtime 存在 → 继续关联并晋升；能权威确认 session 从未产生 → 清理 claim；binding/provider 状态不确定 → **保留 claim 并阻断删除**。
7. sessionId 出现后，在 aggregate 内将 pending claim **原子晋升**为 `{provider, sessionId}` claim。

故障注入测试：claim 写入后、binding 写入前崩溃；provider session 出现后、claim 晋升前崩溃。
3. **新世代判定**：session 对 retired R 算新世代，当且仅当其 claim 引用同一 WorktreeKey 上 `generationCutoffAt ≥ R.generationCutoffAt` 的某个 retirement（即创建于 R 或 R 之后的某轮重建期）。

**世代判定规则（完整，`updatedAt` 不作依据）**：

1. **已知 session**：journal 冻结的 `affectedSessions` 清单权威 → 旧世代。
2. **有匹配 generation claim**（规则 3 上文的判定）→ 新世代。
3. **延迟发现、无 claim**：用**稳定 creation time** ≤ R.`generationCutoffAt` → 旧世代；creation time 无效 / 缺失 / 明显时钟漂移 → **fail-closed 旧世代**。
4. **删除 journal 活跃期间禁该组新 session**（决策 J），世代边界内不产生新 session。

**时间域（v5 定案）**：`generationCutoffAt` 为持久化 **UTC epoch milliseconds**，经注入的 `nowMs()` 获取；写入 `max(nowMs(), lastGenerationCutoffAt + 1)` 防系统时钟回拨。`lastGenerationCutoffAt` 是 aggregate 内的**持久化高水位**（v5.1 确认约束）：每次 `beginDeletion` 原子更新；retired 清理时**不回退、不删除**（不能只从现存 retired records 求最大值——记录清理后高水位会丢失）；迁移默认 `0`；校验为安全整数。provider creation time 在采集时归一化到同一 epoch。进程单调时钟不持久化、不跨重启、不与 epoch 混用。

**creation time 模型贯通（批 2 范围）**：`CodexSession` 等历史模型当前仅 `updatedAt`（已核实 `models.ts`，hydration 也只投影 `updatedAt`）。批 2 包含：各 provider 稳定 creation time 的采集（支持则填 `createdAt`）、模型与 hydration 投影贯通、不支持 provider 的降级路径（无 creation time → 走规则 3 的 fail-closed）及测试。

**Chats 呈现**：历史分配与"无法直接恢复"标记从 retired store + 世代规则 + discovery 健康联合派生；旧世代 resume fail-closed，对话查看保持可用。

**迁移规则**：绝不把普通 missing/prunable member 推断为 retired；retired 只由 journaled 删除产生。批 2 仅做 aggregate 结构升级（version bump），不做数据推断。

**清理的权威判定**：允许清理某 retired 记录（及其关联 generation claims），当且仅当——**所有** provider 历史源 available、扫描无截断 / 无超限 / 无读取错误、active / pending / history 三类引用皆空。任一不可用或截断 → 保留。

### F. 领域原语【已确认】

所有批量操作"先完整校验（容量 / repository 冲突 / WorktreeKey 占用 / primary / revision / lease / mutex），再一次 aggregate 写入"：

```text
createGroup(plannedMembers[])                 // derive 复用/扩展
createGroup(readyMembers[])                   // Adopt 为新组
addPlannedMembers(existingGroupId, members[]) // 仅 Add repo
adoptReadyMembers(existingGroupId, keys[])    // 仅 Adopt 到现有组
mergeGroupsAtomically({ survivorGroupId, sourceGroupId, primaryMemberId })
beginDeletion(intent)                         // 决策 B：mutex + 复检 + 快照 + 预占
checkpointDeletedMember(operationId, memberId)
failDeletionMember(operationId, memberId, errorCode)
completeDeletion(operationId)
abandonDeletion(operationId)
```

边界：derive 创建新组不动源组；Merge 只整体移动 source，与勾选 Adopt 不混。

**derive 候选资格**：visible + 可解析 → 可参与；detached → 显示不可选并注明；failed / planned / provisioning → 不信任 manifest branchName，从 refs 重新验证；missing 但 branch ref 权威存在 → 预检后参与。

### G. preview token 权威绑定 + 持久化单调 revision【已确认】

`WorktreeGroup` 新增持久化单调 `revision`：create=1；rename、member 状态、primary、add/remove、merge 每次成功写入递增。fingerprint 仅调试。Merge token 绑 `sourceRevision` + `targetRevision`。revision 迁移放批 1。

token 绑定：mode / navigationIdentity / 各 groupId + 各自 revision / 精确 member·WorktreeKey 集合 / 冻结计划（路径、分支、baseRef、setup argv）/ 删除动作模式。任一漂移 `group-changed`；rename / Add repo / 移除 / Merge / workspace 切换后旧 token fail-closed。

### H. rename 与 suggestedSlug【已确认】

rename 时从新显示名重新生成 `suggestedSlug`（§5.2 规则，纯中文回落 `task-<id>`）。displayName、suggestedSlug、group revision **同一次 Store 写入**。

### I. 移除 primary 的语义【已确认】

```text
operationally-ready = state=ready + repository 当前可见 + worktree 非 bare
  + health ∉ {missing, prunable}（locked 不排除）
  + 映射后的 workspace paths 可用
```

删 primary 且存在其他 operationally-ready member → 删除前要求选新 primary（locked 可作 replacement primary）；无候选 → primary 为空 + 禁用 New session + 重选提示；删最后一个 member → 组消失；whole-group 删除不要求选 primary。locked member 自身作删除目标仍被删除预检阻断。

### J. group mutation lease + admission mutex + aggregate revision【v5 定案】

**lease**：某组存在 active deletion journal 时阻断该组的 Add repo、Adopt（作目标）、Merge（作 source 或 target）、再次删除、primary 变更、新 session、rename；只放行 deletion Retry、abandon、查看。lease 判定随每次 aggregate 写入在 store 层校验。

**admission mutex（v5 新增，关闭 journal 写入前的竞态窗口）**：lease 只在 journal 持久化后生效，而 `beginDeletion` 的 blocker 扫描 / history 查询 / 容量计算是异步的，新 session 可在这些 await 期间通过 admission——且新 session 的 pending/runtime binding 不经过 group aggregate Store（已核实），store 层 lease 管不到在途启动。定案：

- deletion admission 与 New session admission **共用按 groupId 的 Host mutation mutex**。
- deletion 从最终 blocker 复检开始持有 mutex，直到 journal 持久化。
- New session 在创建任何 pending binding / terminal 副作用前取得同一 mutex，并在 mutex 内重新检查 active journal；发现 lease 即拒绝（组行提示删除进行中）。
- Merge 在一次 aggregate 队列事务内同时校验两个 group；如需显式获取 mutex，按稳定 groupId 顺序（防死锁）。
- 执行期逐 member 复检保留为纵深防御（mutex 覆盖不了的途径，如直接命令调用）。

**aggregate revision（v5 新增，闭环 replacement 证明）**："viewRevision 更大"不蕴含"包含本次 mutation"（并发 refresh 晚完成可出现 revision 大、内容旧）。定案：

- aggregate 增加 workspace 级 **`aggregateRevision`**，每次 aggregate 提交递增。
- 每次投影发布记录其所基于的 `aggregateRevision` + navigationIdentity；**publication coordinator 串行化投影，丢弃基于旧 aggregate / 旧 navigation snapshot 的迟到结果**。
- settlement 携带 `requestId, operation, navigationIdentity, minimumAggregateRevision`（= 本次提交后的 aggregateRevision）。
- webview 只在应用了同 identity 且 `aggregateRevision ≥ minimumAggregateRevision` 的 authoritative replacement 后清 pending。

核心不变量：

> 更高的 viewRevision 必须蕴含不低于 settlement 所绑定的 authoritative aggregate revision。

whole-group 删除后的焦点恢复目标：下一组行 → Current 锚点行 → New 按钮（按存在顺序）。

## 3. 实施批次（8 个垂直切片）

禁止 Host/Webview 横向拆分。**每个提交同时包含：协议、Host、权威 HTML、webview pending/replacement、测试、行为契约**。

| 批次 | 内容 | 关键交付 |
| --- | --- | --- |
| 批 1 | member 详情展开 UI + 重命名 + group revision 迁移 | member summary 可展开；rename 内联编辑（决策 H 单次写入）；`WorktreeGroup.revision` + 存量迁移为 1；170px / 键盘 / ARIA |
| 批 2 | retired identity + 世代身份模型 + creation time 贯通 | aggregate 扩展（groups + deletionJournal + retiredIdentities + generationClaims 同 blob）；`retirementId` / claim 生命周期（pending 创建 → 原子晋升 → 独立持久化）；各 provider **creation time 采集 + 模型/hydration 贯通 + 降级**；Chats 历史分配改从 retired + 世代规则派生；仅结构迁移，不推断 retired |
| 批 3 | 删除 journal + Store API + 重启对账 + lease + mutex + aggregate revision | 决策 B/F/J：beginDeletion（mutex + 复检 + 快照 + 容量预占）/ checkpoint / fail / complete / abandon + 对账规则表全分支 + lease 校验 + admission mutex + `aggregateRevision` 与 publication 串行化 |
| 批 4 | member 级删除端到端 | 内联确认卡（单 member）+ 门禁 + journal 执行 + partial/Retry/abandon + primary 语义（I）+ retired 写入 + settlement 绑 minimumAggregateRevision |
| 批 5 | 组级删除端到端 | 多 member 确认卡 + 逐 member 门禁与执行 + 脱离双动作 + 历史 session 计数 + aggregate settlement + 删除后焦点恢复 |
| 批 6 | 派生 | 表单 derive 模式（C/F）+ token 绑定 + lease/mutex 校验 |
| 批 7 | Add repo + scope outdated 派生 | 表单 add-repo 模式 + `addPlannedMembers` + 决策 D 映射后路径比较与组行注记（子目录 binding / Windows 用例） |
| 批 8 | Adopt + 任意 Merge | 建议组聚类 + Adopt 勾选确认卡 + `adoptReadyMembers`；Merge 去 slug 限制 + survivor/primary 确认 + `mergeGroupsAtomically`（双 revision + 双 lease） |

拟新增行为契约 ID：`WORKTREE-GROUPS-RENAME-001`、`WORKTREE-GROUPS-HISTORY-IDENTITY-001`、`WORKTREE-GROUPS-DELETE-JOURNAL-001`、`WORKTREE-GROUPS-MEMBER-DELETE-001`、`WORKTREE-GROUPS-GROUP-DELETE-001`、`WORKTREE-GROUPS-DERIVE-001`、`WORKTREE-GROUPS-ADD-REPO-001`、`WORKTREE-GROUPS-ADOPT-MERGE-001`。

## 4. PRD v6 修订点（确认后回写）

1. §6.4：删除确认框为 webview 内联确认卡（A）。
2. §4.2 / §6.4：删除 journal 事务模型（mutex + 副作用前冻结快照 + 容量预占 + partial 生命周期 + 归档定义）、单一 aggregate、重启对账规则表（B/J）。
3. §6.4：retired identity + 世代身份模型（retirementId / createdAfterRetirementId / claim 独立持久化 / creation time 时间域与降级）；retired 只由 journaled 删除产生；清理权威判定（E）。
4. §6.2 / §6.3：derive / add-repo 复用创建表单；Add repo 默认勾选；derive 候选资格（C/F）。
5. §6.3：scope 提示为映射后 writable paths 差异派生 + 组行汇总（D），§14 开放问题 2 闭环。
6. §4.1 / §5.2：rename 重新生成 slug、与 revision 同次写入（H/G）。
7. §4.2：primary 移除语义按 operationally-ready（I）。
8. §4：Group 实体增加持久化单调 `revision`（G）。
9. §6.4 / §7：mutation lease、admission mutex、aggregate revision 与 settlement 不变量（J）。
10. §6.5：Adopt / Merge 原子写、survivor/primary 确认、领域边界（F/G）。
11. §14：开放问题 1 闭环；§10：member 详情展开与删除确认卡入结构图。

## 5. 验收矩阵与全量门禁

### 删除（批 2–5）

- 每个边界崩溃后的重启结果：journal 写入后 / 首个物理删除后 / 部分 checkpoint 后 / manifest 移除前（故障注入）。
- 全量预检任一失败 → 零物理副作用。
- **世代身份模型**：同一路径**连续两轮删除/重建**（S2 对 R1 新世代、对 R2 旧世代）；**第二轮 affectedSessions 截断**场景下无精确身份 session 一律旧世代 fail-closed；claim 在 binding `remove()` 后仍有效。
- **admission 竞态**：beginDeletion 的 await 期间发起 New session → mutex 串行化，session 在副作用前被拒；lease 生效后该窗口由 mutex 关闭（非仅执行期复检）。
- retired 容量：按冻结快照预占；明细超限降级（计数仅诊断）；aggregate 字节上限；超限零副作用 `store-full`。
- retired 清理：provider 不可用 / 扫描截断 → 保留；三类引用皆空才清理；清理释放关联 generation claims。
- TOCTOU：mutex 覆盖不到的途径由执行期逐 member 复检兜底按 partial。
- partial journal：Retry 重开同一 operation；abandon 释放预占、清错误、不动 member；终态归档入诊断环（成功写入则进入、容量不足可丢弃、非权威、摘要 only、8 条上限）。
- **持久化高水位**：清空全部 retired → 系统时钟回拨 → 再次删除，新 cutoff 仍严格递增（`lastGenerationCutoffAt` 不回退）。
- **pending claim 故障注入**：claim 写入后、binding 写入前崩溃；provider session 出现后、claim 晋升前崩溃——两路恢复语义（晋升 / 清理 / 保留并阻断删除）全覆盖。
- primary：operationally-ready 候选有 / 无；locked 可作 replacement primary；locked 作删除目标被阻断；最后一个 member 组消失；whole-group 不要求选 primary。
- 脱离 member 双动作；whole-group 在脱离 member 存在时阻断。
- discovery 截断 / 仓库不可见 → 保留 `deleting` + lease 持续。
- lease：删除期间 Add repo / Adopt / Merge / primary / rename / 新 session / 再次删除全阻断；Retry / abandon / 查看放行；Merge 双校验按 groupId 顺序。
- 历史 session：member 移除后仍在 Chats（含 root 之外），能查看、旧世代不能恢复。
- 真实临时 git 仓库删除端到端。

### scope 提示（批 7）

- active / pending / legacy / 重启后恢复四类独立判定。
- repository-relative 子目录 binding、Windows 大小写、路径分隔符用例。
- 新 member 未 ready 不提示；ready 后按 diff 出现；结束 / resume 消失；member 移除重新比较；并发交错自洽。

### Add repo / 派生（批 6–7）

- Add repo 部分失败与重启恢复（关联回既有组）。
- 默认勾选规则；零选择禁确认。
- token：rename / Add repo / 移除 / Merge / workspace 切换后 `group-changed`；revision ABA 旧 token 失效。
- derive 候选资格四态。

### Adopt / Merge（批 8）

- stale snapshot、重复 WorktreeKey、repository 冲突阻断。
- survivor / primary 原子生效；source manifest 删除；session cwd 不变；双 revision + 双 lease。
- 单个无主 worktree 同一 Adopt 路径。

### 协议与 webview（全批次）

- malformed / duplicate / replay / 乱序 fail-closed；recognized request 恰好 settlement 一次。
- settlement 绑 `minimumAggregateRevision`；迟到投影（基于旧 aggregate）被 coordinator 丢弃；webview 只在 aggregateRevision 达标后清 pending；核心不变量（高 viewRevision 蕴含达标 aggregateRevision）有契约测试。
- whole-group 删除后焦点恢复目标（下一组 → Current → New）。

### 全量门禁（每批按此顺序）

```text
npm ci                                   # 新 worktree 首次验证前
npm run test-compile
focused unit / contract tests
browser tests
默认宽度与 170px 实际渲染验证              # 涉及 UI 的批次
node scripts/run-dashboard-webview-checks.js
release packaging checks                 # 新增 webview 资源时
npm run test:safety:run
npm run lint
git diff --check
capability audit commit
npm run test:behavior-contracts          # audit commit 后、push 前
```

## 6. 已识别的风险与对应

| 风险 | 对应 |
| --- | --- |
| 删除事务跨进程退出中间态 | journal + 对账规则表；故障注入覆盖每个边界 |
| 快照时点错误导致世代混淆 | affectedSessions + generationCutoffAt + retirementId 在 beginDeletion 冻结（B/E） |
| 多轮删除/重建世代归属错误 | claim 携带 `createdAfterRetirementId` 相对引用（E） |
| claim 随 binding 清理丢失 | claim 独立持久化，直到历史 session 权威删除（E） |
| 可变 `updatedAt` 误判世代 | 只认冻结清单 / 显式 claim / 稳定 creation time；否则 fail-closed（E） |
| 时钟回拨破坏 cutoff 比较 | UTC epoch ms + `max(now, previousCutoffAt + 1)`（E） |
| provider 无 creation time | 批 2 采集贯通 + 降级 fail-closed（E） |
| manifest / journal / retired 跨 key 窗口 | 单一 aggregate 一次 `memento.update`（B） |
| aggregate 被大 session 清单撑爆 | 单 record 上限 + 截断降级（计数仅诊断）+ 总记录数与字节上限 + 按冻结快照预占（B） |
| "没查到"当"没有"误清 retired | 清理要求全 provider available + 无截断 + 三类引用皆空（E） |
| journal 写入前 session-start 竞态 | 按 groupId 的 admission mutex（J） |
| whole-group 删除被并发 mutation 落空 | mutation lease（J） |
| settlement 证明不了 replacement 含本次提交 | `aggregateRevision` 绑定 + publication 串行化丢弃迟到投影（J） |
| scope 提示误报正常 session | 映射后路径比较 + 子目录/Windows 用例（D） |
| locked member 被误排 | operationally-ready 只排 missing/prunable/bare（I） |
| Add repo / 派生绕过 preview 管线 | 协议层拒绝无 token 请求；token 绑 revision（G） |
| member 详情展开行高复杂度 | 折叠机制 + collapse-all；170px 用例入浏览器测试 |
