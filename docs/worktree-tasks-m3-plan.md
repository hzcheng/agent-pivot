# Worktree Tasks M3 实现前评审与实施方案

日期：2026-08-15（v4，第三轮外部评审修订版，回写 PRD v6 前的最终稿）

状态：M1/M2 已交付；本文档是 M3（组级与 member 级操作）的实现前评审，确认后回写 PRD v6，然后按批次实现

评审范围：PRD §6.2–6.5（派生 / Add repo / 删除 / Adopt & Merge）、§4.2 状态机、§10 UI 结构、§12 里程碑、§14 开放问题 1/2。

## v3 → v4 修订摘要（对应第三轮评审 1 阻塞 + 4 重要）

| 评审项 | 处理 |
| --- | --- |
| 阻塞：retired 世代快照时点矛盾（checkpoint 写 retired vs completeDeletion 才快照 session） | 决策 B/E 重写：**affectedSessions 快照 + `generationCutoffAt` 移到 `beginDeletion`**（副作用前冻结进 journal）；checkpoint 只消费冻结信息；`updatedAt` 不作世代依据 |
| 重要：scopeOutdated 比较了错误的路径集合 | 决策 D 修正：期望 scope 走 `rootBindings` → `mapWorktreeBoundHostPaths` 的映射后路径（已核实 `commandController.ts` peer scope 即此语义） |
| 重要：operationally-ready 误排 locked | 决策 I 修正：locked 可用（已核实投影与 scope 代码只拒绝 missing/prunable/bare） |
| 重要：aggregate 容量与清理缺安全边界 | 决策 B/E 补：单记录 session 数上限、aggregate 记录数与字节上限、按冻结快照预占、清理的权威判定条件、journal 归档定义 |
| 重要：删除期间互斥范围与 replacement revision 不明 | 新增**决策 J：group mutation lease + workspace view revision** |

## 1. 现状盘点

| M3 子特性 | 现状 | 缺口 |
| --- | --- | --- |
| 重命名 | store 有 `renameGroup` | UI 无入口；rename 需同步重新生成 slug 并递增 revision（决策 H/G） |
| 派生（§6.2） | 仅单仓库 branch seed（Unmanaged 行吸收路径） | 源组各 member 分支作为对应仓库基准；默认勾选源组仓库；候选资格规则（决策 F） |
| Add repo（§6.3） | 不存在 | 整个流程 + scope 演进提示（决策 D）；store 缺原子批量 `addPlannedMembers` |
| 组级删除（§6.4） | ⋯ 菜单 Remove 只删 primary member，走单 worktree 流程 | 删除 journal、内联确认卡、脱离 member 双动作、历史 session 计数、mutation lease（决策 J） |
| member 级移除（§6.4） | 无处挂载 | member summary 目前是静态 `role="note"` 行，不可展开；member 详情 UI 不存在 |
| 历史 session 删除标记（§6.4） | 历史身份依赖 **manifest member 的 path → WorktreeKey fallback**（`findGroupMemberWorktreeKeyForPath` 等） | member 移除后 fallback 消失；retired identity + 世代规则接管（决策 E） |
| Adopt（§6.5） | 不存在 | 建议组聚类、Adopt 入口、原子 `adoptReadyMembers` |
| 任意 Merge（§6.5） | 仅同 slug 候选 + QuickPick；冲突阻断已有 | 去 slug 限制；survivor/primary 原子确认；`mergeGroupsAtomically`；双 lease（决策 J） |
| 删除状态机 | store 已支持持久化 `deleting` | 无 journal、无 checkpoint、无重启对账规则 |
| group revision / view revision | 均不存在 | `WorktreeGroup.revision`（决策 G）；workspace view publication revision（决策 J） |

## 2. 决策点（v4 定案版）

### A. 删除确认框的形态 —— webview 内联确认卡【已确认】

§6.4 要求逐 member 列出物理路径 + 检查结果 + 受影响历史 session 数 + 脱离 member 双动作；§10 要求键盘 / 焦点 / ARIA 随 M3 交付。确认卡与创建表单互斥（单实例语义）。

### B. 删除事务模型 —— 单一 aggregate + 删除 journal【v4 重写快照时点与容量边界】

**存储边界**：deletion journal 与 retired identities 纳入 manifest **同一个持久化 aggregate**（同一 `globalState` key 的版本化 blob，按 `navigationIdentity` 分桶），跨三者的事务由**一次 `memento.update`** 提交。无跨 key 两阶段写入窗口。

**事务时序（v4 定案：一切身份快照在副作用前冻结）**：

```text
beginDeletion(intent):
  1. 逐 member 最终复检 blocker（活跃 session / 未提交改动 / locked / provisioning）
  2. 快照 affectedSessions：{provider, sessionId}[]（活跃 runtime + 各 provider 历史中
     cwd 命中目标 path 的记录；去重 + 字符串边界校验）
  3. 写 generationCutoffAt（单调时间源；世代边界，见决策 E）
  4. 按实际冻结快照预占 retired 容量（见下方容量边界）
  5. member → deleting；journal 持久化以上全部信息 + operationId + 操作模式
     （group / member / visible-only）+ 原 primaryMemberId + 关联 preview token
  —— 以上全部完成前，零物理副作用 ——

checkpointDeletedMember(operationId, memberId):
  只消费 journal 中冻结的 session / generation 信息（绝不重新查询）
  → 写 retired + 移除 manifest member + 推进 journal（单次 aggregate 写入）

failDeletionMember(operationId, memberId, errorCode):
  member 恢复 ready + lastError；journal 进入 partial（仅保留该 member 的
  原始目标快照与操作上下文）

Retry：重开同一 operation（不新建 journal、不重推断目标、不重快照 session）
completeDeletion(operationId)：终态后 journal 归档（见下方归档定义）
```

**容量边界（v4 新增，全部在物理副作用前 fail-closed）**：

- 单条 retired record 的 `affectedSessions` 数量上限（超限时该 record 仍写，但超出部分按 provider 聚合计数降级存储——权威标记不丢，明细截断并标记 `truncated: true`，延迟发现的同 path 历史按旧世代 fail-closed 兜底）。
- aggregate 的总 retired 记录数上限与**序列化字节上限**（防止大 blob 撑爆 memento）。
- `beginDeletion` 按**实际冻结快照**（含 session 清单字节）预占，不是只按 member 数量。
- 超限 → `store-full`，零物理副作用，提示清理路径（决策 E 的清理规则）。

**journal 归档定义（v4 新增）**：终态（全部 member 完成，或用户放弃 partial intent）后从 active journal 移除；可选进入**有明确上限的诊断环**（如最近 8 条），不无限保留在 aggregate。用户放弃 partial intent = 释放预占容量 + 清除对应 member 的删除错误标记，**不触碰仍存在的 member 与物理目录**。

**重启对账规则**（fail-closed，绝不猜测成功）：

| 观察 | 对账动作 |
| --- | --- |
| member 路径确定不存在 | 完成 manifest 移除 + retired 写入（用 journal 冻结信息），journal 推进 |
| worktree 仍正常存在 | 恢复 `ready` + `deletion-interrupted` 标记，允许 Retry |
| discovery 截断 / 仓库脱离 / 状态未知 | **保留 `deleting`**，按决策 J 的 lease 阻断该组 mutation，待确定快照 |

### C. Add repo / 派生的交互载体 —— 复用内联创建表单【已确认】

两者都必须走 M2 完整管线（实时预览 + 预检 + 一次性 token + argv 冻结 + 逐项绑定）。协议层拒绝无 token 的补建/派生请求。

- `add-repo`：候选 = 组尚未包含的 workspace 仓库；slug 锁定；基准取记忆基准；无 primary 切换（除非组无 ready primary）。**默认勾选**：活跃编辑器所在仓库未入组 → 只勾它；否则默认不选；保留"全选"；零选择禁确认。
- `derive`：预勾选 = 源组 member 仓库集合（候选资格按决策 F）；基准覆盖为源组对应 member 分支；名称默认 `源名-2`，预览照常可见。

### D. scope 演进提示 —— 映射后 writable paths 差异派生【v4 修正比较集合】

v3 把期望 scope 写成 member worktree 根路径是错的：多根 workspace / repository-relative root binding 下，runtime 实际获得的是 `mapWorktreeBoundHostPaths` 映射后的子目录（已核实 `commandController.ts` 的 peer scope 即此语义）。正确公式：

```text
期望 scope =
  组当前 ready member
  → 各自 repository.rootBindings
  → mapWorktreeBoundHostPaths
  → 跨平台路径归一化（Windows 大小写 / 分隔符）+ 去重

scopeOutdated =
  expectedMappedWritablePaths ⊄ runtime 持久化的 writableRootHostPaths
```

规则不变：新 member 到 `ready` 才进期望 scope；逐 active/pending session 独立判定；session 结束 / resume 重建后消失；member 移除重新比较；`legacyScope` 与 `scopeOutdated` 分开表达；组行内联汇总注记。**测试必须覆盖**：repository-relative 子目录 binding、Windows 大小写、路径分隔符——否则正常 session 会被永久误报。

### E. 历史 session 身份 —— retired identity + 副作用前世代冻结【v4 重写世代规则】

**记录内容**（纳入决策 B 的同一 aggregate）：

```text
retiredWorktreeIdentity:
  repositoryKey, canonicalWorktreePath, branchName（快照）
  deletedAt                 // 实际物理删除时间，仅展示用
  generationCutoffAt        // 副作用前冻结，世代边界（权威）
  origin: { groupId, memberId, displayName }
  affectedSessions: { provider, sessionId }[]   // beginDeletion 冻结，权威标记
  truncated?: boolean       // 明细超上限时置真
```

**世代判定规则（v4 定案，`updatedAt` 不作依据——它可变，旧 session 被外部触碰后会误判新世代）**：

1. **已知 session**：以 journal 冻结的 `{provider, sessionId}` 清单为权威。
2. **延迟发现 session**（删除后才出现在历史存储）：优先使用**稳定 creation time**（≤ `generationCutoffAt` → 旧世代）。
3. **无可靠 creation time、无 generation claim** → 按旧世代 **fail-closed**（宁误标不可恢复，不错放可恢复）。
4. **同路径新建 session 的 generation claim**：Agent Pivot 在 retired path 上创建的新 session，在其持久化 session/runtime binding 中写入**显式 post-cutoff generation claim**（创建时检查 retired store），不靠时间猜测。这是新世代"可恢复"的唯一依据。
5. **删除 journal 活跃期间禁止该组新 session**（决策 J lease 的一部分），避免世代边界内继续产生 session。

**Chats 呈现**：历史分配与"无法直接恢复"标记从 retired store + 上述世代规则 + discovery 健康联合派生；旧世代 resume fail-closed，对话查看保持可用。

**迁移规则**：绝不把普通 missing/prunable member 推断为 retired；retired 只由 journaled 删除产生。批 2 仅做 aggregate 结构升级（version bump），不做数据推断。

**清理的权威判定（v4 补齐）**：允许清理某 retired 记录，当且仅当——**所有** provider 历史源 available、扫描无截断 / 无超限 / 无读取错误、且 active / pending / history 三类引用均为空。任一 provider 不可用或扫描截断 → 保留记录，"没查到"不等于"没有"。

### F. 领域原语【已确认】

所有批量操作"先完整校验（容量 / repository 冲突 / WorktreeKey 占用 / primary / revision / lease），再一次 aggregate 写入"：

```text
createGroup(plannedMembers[])                 // derive 复用/扩展
createGroup(readyMembers[])                   // Adopt 为新组
addPlannedMembers(existingGroupId, members[]) // 仅 Add repo
adoptReadyMembers(existingGroupId, keys[])    // 仅 Adopt 到现有组
mergeGroupsAtomically({ survivorGroupId, sourceGroupId, primaryMemberId })
beginDeletion(intent)                         // 决策 B：复检 + 快照 + 容量预占
checkpointDeletedMember(operationId, memberId)
failDeletionMember(operationId, memberId, errorCode)
completeDeletion(operationId)
abandonDeletion(operationId)                  // 放弃 partial intent：释放预占 + 清错误
```

边界：derive 创建新组不动源组；Merge 只整体移动 source，与勾选 Adopt 不混。

**derive 候选资格**：

| 源组 member 状态 | 资格 |
| --- | --- |
| visible + repository 可解析 | 可参与 |
| detached | 显示但不可选，注明原因 |
| failed / planned / provisioning | 不信任 manifest branchName，从 repository refs 重新验证后才可作基准 |
| missing 但 branch ref 仍权威存在 | 预检通过后可参与 |

### G. preview token 权威绑定 + 持久化单调 revision【已确认】

`WorktreeGroup` 新增持久化单调 `revision`：create=1；rename、member 状态、primary、add/remove、merge 每次成功写入递增。fingerprint 仅调试信息。Merge token 绑 `sourceRevision` + `targetRevision`。revision 迁移放批 1。

token 绑定：mode / navigationIdentity / 各 groupId + 各自 revision / 精确 member·WorktreeKey 集合 / 冻结计划（路径、分支、baseRef、setup argv）/ 删除动作模式。任一漂移返回 `group-changed` 要求重新预览；rename / Add repo / 移除 / Merge / workspace 切换后旧 token fail-closed。

webview mutation 生命周期见决策 J（v4 起统一由 lease + view revision 承载）。

### H. rename 与 suggestedSlug【已确认】

rename 时从新显示名重新生成 `suggestedSlug`（§5.2 规则，纯中文回落 `task-<id>`）。displayName、suggestedSlug、group revision **同一次 Store 写入**。

### I. 移除 primary 的语义【已确认，v4 修正 locked】

```text
operationally-ready =
  state=ready
  + repository 当前可见
  + worktree 非 bare
  + health ∉ {missing, prunable}      // locked 不排除：仍存在且可用
  + 映射后的 workspace paths 可用
```

已核实依据：投影只把 missing/prunable 判不可用（`worktreeGroupProjection.ts`）；session scope 明确允许 locked peer（`commandController.ts`，Git 只 block prune/repair）。

规则：删 primary 且存在其他 operationally-ready member → 删除前要求选择新 primary（locked member **可以**成为 replacement primary）；无候选 → primary 为空 + 禁用 New session + 现有重选提示；删最后一个 member → 组消失；whole-group 删除不要求选 primary。**locked member 自身作为删除目标时仍被删除预检阻断**（与现有单 worktree 删除语义一致）。

### J. group mutation lease + workspace view revision【v4 新增】

**问题**：whole-group 删除期间并发 Add repo 会让"删除整个组"的确认落空（删除完成后组仍存在）；whole-group 删除后 group 已不存在，无法靠 group revision 证明 replacement 已应用。

**lease（第一版取简单可证明的形态）**：某组存在 active deletion journal 时，阻断该组的：

- Add repo、Adopt（作为目标）、Merge（作为 source 或 target）、再次删除、primary 变更、新 session、rename（默认一并阻断，最易证明）。

只允许：deletion Retry、放弃 partial intent（`abandonDeletion`）、不改变成员语义的查看操作。Merge 同时获取 source 与 target 两个 lease，**按稳定 groupId 顺序声明**（防死锁）。lease 判定在 store 层随每次 aggregate 写入校验（决策 F 的"先完整校验"含 lease）。

**view revision（替代 group revision 作 replacement 依据）**：settlement 携带：

```text
requestId, operation, navigationIdentity, minimumViewRevision
```

`viewRevision` 是 **workspace 级 view publication 单调序号**（每次 authoritative 投影发布递增），不是 group revision。webview 只在应用了同 identity 且 `viewRevision >= minimumViewRevision` 的 authoritative replacement 后清 pending。whole-group 删除后的焦点恢复目标明确定义为：**下一组行 → Current 锚点行 → New 按钮**（按存在顺序）。

## 3. 实施批次（8 个垂直切片）

禁止 Host/Webview 横向拆分。**每个提交同时包含：协议、Host、权威 HTML、webview pending/replacement、测试、行为契约**。

| 批次 | 内容 | 关键交付 |
| --- | --- | --- |
| 批 1 | member 详情展开 UI + 重命名 + group revision 迁移 | member summary 可展开；rename 内联编辑（决策 H 单次写入）；`WorktreeGroup.revision` + 存量迁移为 1；170px / 键盘 / ARIA |
| 批 2 | retired identity + aggregate 结构升级 + generation claim | 决策 E：aggregate 扩展（groups + deletionJournal + retiredIdentities 同 blob）；Chats 历史分配改从 retired + 世代规则派生；新 session 的 post-cutoff generation claim 写入；**仅结构迁移，不推断 retired** |
| 批 3 | 删除 journal + Store API + 重启对账 + mutation lease + view revision | 决策 B/F/J：beginDeletion（复检 + session 快照 + 容量预占）/ checkpoint / fail / complete / abandon + 对账规则表全分支 + lease 校验 + workspace view publication 序号 |
| 批 4 | member 级删除端到端 | 内联确认卡（单 member）+ 门禁 + journal 执行 + partial/Retry/abandon + primary 语义（决策 I）+ retired 写入 + settlement 携带 minimumViewRevision |
| 批 5 | 组级删除端到端 | 多 member 确认卡 + 逐 member 门禁与执行 + 脱离 member 双动作 + 历史 session 计数 + aggregate settlement + 删除后焦点恢复目标 |
| 批 6 | 派生 | 表单 derive 模式（决策 C/F）+ token 绑定 + lease 校验 |
| 批 7 | Add repo + scope outdated 派生 | 表单 add-repo 模式 + `addPlannedMembers` + 决策 D 映射后路径比较与组行注记（含子目录 binding / Windows 用例） |
| 批 8 | Adopt + 任意 Merge | 建议组聚类 + Adopt 勾选确认卡 + `adoptReadyMembers`；Merge 去 slug 限制 + survivor/primary 确认 + `mergeGroupsAtomically`（双 revision + 双 lease） |

拟新增行为契约 ID：`WORKTREE-GROUPS-RENAME-001`、`WORKTREE-GROUPS-HISTORY-IDENTITY-001`、`WORKTREE-GROUPS-DELETE-JOURNAL-001`、`WORKTREE-GROUPS-MEMBER-DELETE-001`、`WORKTREE-GROUPS-GROUP-DELETE-001`、`WORKTREE-GROUPS-DERIVE-001`、`WORKTREE-GROUPS-ADD-REPO-001`、`WORKTREE-GROUPS-ADOPT-MERGE-001`。

## 4. PRD v6 修订点（确认后回写）

1. §6.4：删除确认框为 webview 内联确认卡（A）。
2. §4.2 / §6.4：删除 journal 事务模型（副作用前冻结快照 + 容量预占 + partial 生命周期 + 归档定义）、单一 aggregate 存储边界、重启对账规则表（B）。
3. §6.4：retired identity + 世代规则（冻结清单权威 / 稳定 creation time / 无 claim fail-closed / post-cutoff generation claim）；retired 只由 journaled 删除产生；清理的权威判定（E）。
4. §6.2 / §6.3：derive / add-repo 复用创建表单；Add repo 默认勾选；derive 候选资格（C/F）。
5. §6.3：scope 提示为映射后 writable paths 差异派生 + 组行汇总（D），§14 开放问题 2 闭环。
6. §4.1 / §5.2：rename 重新生成 slug、与 revision 同次写入（H/G）。
7. §4.2：primary 移除语义按 operationally-ready（locked 可作 replacement primary）（I）。
8. §4：Group 实体增加持久化单调 `revision`（G）。
9. §6.4 / §7：group mutation lease 与 workspace view revision 语义（J）。
10. §6.5：Adopt / Merge 原子写、survivor/primary 确认、领域边界（F/G）。
11. §14：开放问题 1 闭环；§10：member 详情展开与删除确认卡入结构图。

## 5. 验收矩阵与全量门禁

### 删除（批 2–5）

- 每个边界崩溃后的重启结果：journal 写入后 / 首个物理删除后 / 部分 checkpoint 后 / manifest 移除前（单一 aggregate 使 retired 与 manifest 同生共死，仍需故障注入验证）。
- 全量预检任一失败 → 零物理副作用。
- **快照时点**：beginDeletion 后同路径重建并产生新 session，checkpoint/对账仍只用冻结清单，新世代不被误标（含进程退出数天后才完成删除的场景）。
- 世代判定四规则全覆盖：冻结清单 / 稳定 creation time / 无 claim fail-closed / post-cutoff generation claim。
- retired 容量：按冻结快照预占；单记录 session 超限降级 + `truncated`；aggregate 字节上限；超限零副作用报 `store-full`。
- retired 清理：provider 不可用 / 扫描截断 → 保留；三类引用皆空才允许清理。
- TOCTOU：预检后执行前新 session 启动 → 逐 member 复检拦截按 partial（lease 生效后此窗口关闭，测试锁定两种形态）。
- partial journal：A/C 成功 B 失败 → Retry 重开同一 operation；abandon 释放预占、清错误、不动 member；终态归档（诊断环上限）。
- primary：operationally-ready 候选有 / 无；locked 可作 replacement primary；locked 作删除目标被预检阻断；最后一个 member 组消失；whole-group 不要求选 primary。
- 脱离 member 双动作；whole-group 在脱离 member 存在时阻断。
- discovery 截断 / 仓库不可见 → 保留 `deleting` + lease 生效。
- **lease**：删除期间 Add repo / Adopt / Merge / primary / rename / 新 session / 再次删除全部阻断；Retry / abandon / 查看放行；Merge 双 lease 按 groupId 顺序。
- 历史 session：member 移除后仍在 Chats（含 workspace root 之外），能查看、旧世代不能恢复。
- 真实临时 git 仓库删除端到端。

### scope 提示（批 7）

- active / pending / legacy / 重启后恢复四类独立判定。
- **repository-relative 子目录 binding、Windows 大小写、路径分隔符**用例（映射后比较，正常 session 不误报）。
- 新 member 未 ready 不提示；ready 后按 diff 出现；结束 / resume 消失；member 移除重新比较；并发 remove / merge / rename 交错自洽。

### Add repo / 派生（批 6–7）

- Add repo 部分失败与重启恢复（关联回既有组）。
- 默认勾选规则；零选择禁确认。
- token：rename / Add repo / 移除 / Merge / workspace 切换后 `group-changed`；revision ABA（A→B→A）旧 token 仍失效。
- derive 候选资格四态。

### Adopt / Merge（批 8）

- stale snapshot、重复 WorktreeKey、repository 冲突阻断。
- survivor / primary 原子生效；source manifest 删除；session cwd 不变；双 revision + 双 lease。
- 单个无主 worktree 同一 Adopt 路径。

### 协议与 webview（全批次）

- malformed / duplicate / replay / 乱序 fail-closed；recognized request 恰好 settlement 一次。
- settlement 携带 minimumViewRevision；webview 只在同 identity 且 viewRevision 达标后清 pending；whole-group 删除后焦点恢复目标（下一组 → Current → New）。

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
| 快照时点错误导致世代混淆 | affectedSessions + generationCutoffAt 在 beginDeletion 冻结（决策 B/E） |
| 可变 `updatedAt` 误判世代 | 世代只认冻结清单 / 稳定 creation time / 显式 generation claim；否则 fail-closed |
| manifest / journal / retired 跨 key 写入窗口 | 单一 aggregate 一次 `memento.update` |
| aggregate 被大 session 清单撑爆 | 单记录上限 + 降级截断 + 总记录数与字节上限 + 按冻结快照预占 |
| "没查到"当"没有"误清 retired | 清理要求全 provider available + 无截断 + 三类引用皆空 |
| whole-group 删除被并发 mutation 落空 | group mutation lease（决策 J） |
| 删除后无法证明 replacement 已应用 | workspace view publication revision（决策 J） |
| scope 提示误报正常 session | 映射后路径比较 + 子目录/Windows 用例（决策 D） |
| locked member 被误排 | operationally-ready 只排 missing/prunable/bare（决策 I） |
| Add repo / 派生绕过 preview 管线 | 协议层拒绝无 token 请求；token 绑 revision |
| member 详情展开行高复杂度 | 折叠机制 + collapse-all；170px 用例入浏览器测试 |
