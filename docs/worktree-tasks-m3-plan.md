# Worktree Tasks M3 实现前评审与实施方案

日期：2026-08-15（v3，第二轮外部评审修订版，待最终确认）

状态：M1/M2 已交付；本文档是 M3（组级与 member 级操作）的实现前评审，确认后回写 PRD v6，然后按批次实现

评审范围：PRD §6.2–6.5（派生 / Add repo / 删除 / Adopt & Merge）、§4.2 状态机、§10 UI 结构、§12 里程碑、§14 开放问题 1/2。

## v2 → v3 修订摘要（对应第二轮评审 1 阻塞 + 4 重要 + H/I 确认）

| 评审项 | 处理 |
| --- | --- |
| 阻塞：journal / manifest / retired 提交所有权不明 | 决策 B 定案：**三者纳入同一个 authoritative aggregate，一次 `memento.update` 提交**；beginDeletion 预占 retired 容量；partial journal 生命周期明确定义 |
| 重要：revision 不能用 fingerprint 替代 | 决策 G 定案：`WorktreeGroup` 新增**持久化单调 revision**，fingerprint 仅作调试信息 |
| 重要：retired 无法区分同路径新旧 session 世代 | 决策 E 定案：删除时快照受影响 session 的 `{provider, sessionId}` 清单 + `deletedAt` 辅助边界；补迁移规则与容量出口 |
| 重要：`addPlannedMembers` 误标为 derive 原语 | 决策 F 修正原语归属；补 derive 候选资格规则 |
| 重要：全量门禁缺少仓库规定的基础检查 | §5 改为明确顺序的完整门禁清单 |
| H 确认 | 补实现要求：displayName、suggestedSlug、group revision 同一次 Store 写入 |
| I 确认（带修正） | "ready" 改为 **operationally-ready**（state=ready + 仓库可见 + health=normal）；补 whole-group 删除不要求选新 primary |

## 1. 现状盘点

| M3 子特性 | 现状 | 缺口 |
| --- | --- | --- |
| 重命名 | store 有 `renameGroup` | UI 无入口；rename 需同步重新生成 slug 并递增 revision（决策 H/G） |
| 派生（§6.2） | 仅单仓库 branch seed（Unmanaged 行吸收路径） | 源组各 member 分支作为对应仓库基准；默认勾选源组仓库；派生命名默认值；候选资格规则（决策 F） |
| Add repo（§6.3） | 不存在 | 整个流程 + scope 演进提示（决策 D）；store 缺原子批量 `addPlannedMembers` |
| 组级删除（§6.4） | ⋯ 菜单 Remove 只删 primary member，走单 worktree 流程（其已承认"目录已删除但 refresh 失败"的 partial） | 删除 journal（持久化 intent + 逐 member checkpoint + 重启对账）、内联确认卡、脱离 member 双动作、历史 session 计数 |
| member 级移除（§6.4） | 无处挂载 | member summary 目前是静态 `role="note"` 行，不可展开；member 详情 UI 不存在 |
| 历史 session 删除标记（§6.4） | 物理 worktree 消失后，历史身份依赖 **manifest member 的 path → WorktreeKey fallback**（`findGroupMemberWorktreeKeyForPath`、`sessionHydration.ts`、webview `worktreeUnavailable` UI） | member 从 manifest 移除后 fallback 消失，workspace root 之外的历史 session 会从 Chats 消失；retired identity 接管（决策 E） |
| Adopt（§6.5） | 不存在 | Unmanaged 平铺，无 slug 建议组聚类、无 Adopt 入口；store 缺原子 `adoptReadyMembers` |
| 任意 Merge（§6.5） | 仅同 suggestedSlug 候选 + QuickPick；冲突阻断已有 | 去 slug 限制；survivor / primary 原子确认；`mergeGroups` 固定保留 target primary，需 `mergeGroupsAtomically` |
| 删除状态机 | store 已支持持久化 `deleting`（`WorktreeGroupMemberState`） | 无 operation/journal、无逐 member checkpoint、无重启对账规则 |
| group revision | 不存在 | `WorktreeGroup` 需新增持久化单调 `revision`（决策 G） |

## 2. 决策点（v3 定案版）

### A. 删除确认框的形态 —— webview 内联确认卡【已确认】

§6.4 要求确认框逐 member 列出物理路径 + 检查结果 + 受影响历史 session 数 + 脱离 member 双动作；§10 要求键盘 / 焦点 / ARIA 随 M3 交付。原生 modal 装不下。确认卡与创建表单互斥（单实例语义）。

### B. 删除事务模型 —— 单一 authoritative aggregate + 删除 journal【方向确认，v3 补齐存储边界】

**存储边界（v3 定案）**：deletion journal 与 retired identities **纳入 manifest 同一个持久化 aggregate**（同一 `globalState` key 下的版本化 blob，按 `navigationIdentity` 分桶），所有跨三者的事务由**一次 `memento.update` 提交**。不存在跨 key 的"两阶段写入"，因此也不存在"retired 写失败导致历史身份丢失"的窗口。`completeDeletion` 的单次写入 = manifest member 移除 + retired identity 记录 + journal 状态推进，同一 blob 内原子生效。

**业务事务**（`git worktree remove` 的原子性不构成事务）：副作用前原子持久化 intent——operationId、操作模式（group / member / visible-only）、目标 member 集合（各自 WorktreeKey / path / branchName 快照）、原 primaryMemberId、关联 preview token。

**容量预占（v3 新增）**：`beginDeletion` 校验阶段一次性预留全部目标 member 所需的 retired 容量；容量不足时**在任何物理副作用之前**以 `store-full` 拒绝，并提示清理路径（决策 E 的 retired 清理规则）。绝不出现"删完物理目录才发现 retired 已满"。

**逐 member checkpoint**：每成功删除一个 member，立即在同一 aggregate 内 checkpoint（物理已删 + retired 写入 + manifest 移除同时生效）。执行期失败的 member 记录 `lastError` 并恢复 `ready`。

**partial journal 生命周期（v3 新增）**：以"A/C 成功、B 失败"为例：

```text
A/C：retired 写入 + manifest 移除（随各自 checkpoint 已完成）
B：恢复 ready + lastError
journal：进入 partial，仅保留 B 的原始目标快照与操作上下文
Retry：重新打开同一个 operation（不新建 journal，不重推断目标）
终态：B 最终成功 → journal 归档；用户放弃（Dismiss 残余 intent）→ journal 归档
```

journal 只在终态归档，与"Retry 必须重用 journal 原目标身份"不冲突。

**重启对账规则**（fail-closed，绝不猜测成功）：

| 观察 | 对账动作 |
| --- | --- |
| member 路径确定不存在 | 完成 manifest 移除 + retired 写入（单次 aggregate 写入），journal 推进 |
| worktree 仍正常存在 | 恢复 `ready` + `deletion-interrupted` 标记，允许 Retry |
| discovery 截断 / 仓库脱离 / 状态未知 | **保留 `deleting`**，阻断同 member 的新删除与创建，待下一轮确定快照 |

**primary 语义**：见决策 I。

### C. Add repo / 派生的交互载体 —— 复用内联创建表单【已确认】

两者都必须走 M2 完整管线：实时预览 + 预检门禁 + 一次性 preview token + argv 冻结 + 逐项绑定（token 清单见决策 G）。协议层拒绝无 token 的补建/派生请求。

- `add-repo`：候选 = 组尚未包含的 workspace 仓库；slug 锁定为组的 suggestedSlug；基准默认取记忆基准；无 primary 切换（除非组当前无 ready primary）。**默认勾选**：活跃编辑器所在仓库未入组 → 只默认勾选它；否则默认不选；保留"全选"；零选择禁确认。
- `derive`：预勾选 = 源组 member 仓库集合（候选资格按决策 F）；每仓库基准覆盖为源组对应 member 分支（源组不含的仓库被勾选时回落该仓库基准）；名称默认 `源名-2`（§14 开放问题 1 闭环），预览照常可见。

### D. scope 演进提示 —— 运行时 scope 差异派生【已确认】

逐 session 独立比较，运行时身份已持久化 `writableRootHostPaths`：

```text
期望 scope = 组当前 ready member 的 worktree 路径集合
实际 scope = 该 active/pending runtime 持久化的 writableRootHostPaths
scopeOutdated = 期望 ⊄ 实际
```

新 member 到达 `ready` 后才进入期望 scope；session 结束或 resume 重建后自然消失；member 移除时重新比较（非清空事件）；`legacyScope` 与 `scopeOutdated` 分开表达；呈现为组行内联汇总注记。

### E. 历史 session 身份 —— 持久化 retired worktree identity【方向确认，v3 补世代区分 / 迁移 / 容量出口】

**记录内容**（纳入决策 B 的同一 aggregate）：

```text
retiredWorktreeIdentity:
  repositoryKey
  canonicalWorktreePath
  branchName（删除时快照）
  deletedAt
  origin: { groupId, memberId, displayName }
  affectedSessions: { provider, sessionId }[]   // 删除时快照：活跃 runtime + 已知历史
```

**世代区分（v3 定案）**：同一路径被重建后，新旧历史 session 具有相同 WorktreeKey，单靠 retired key 无法区分世代。策略：

- 删除事务在 completeDeletion 时**快照当时受影响的 session 身份清单**（`{provider, sessionId}`，来自活跃 runtime 与各 provider 历史存储中 cwd 命中该 path 的记录）——这是权威标记。
- `deletedAt` 作为**延迟发现历史的辅助边界**：之后才出现在历史存储中、cwd 命中 retired path、且最后活动时间 ≤ `deletedAt` 的 session 归入删除前世代；活动时间在 `deletedAt` 之后的同路径 session 属于新世代，**不**标记。
- 同路径允许重建与新建 session（世代已可区分）；第一版不提供"解除 retired / rebind"功能，retired 事实不因路径重现而消失。

**Chats 呈现**：历史分配与"无法直接恢复"标记改从 retired store + 世代规则 + discovery 健康联合派生；resume 对删除前世代 fail-closed，对话查看保持可用。

**迁移规则（v3 定案）**：**绝不把普通 missing/prunable member 自动迁移成 retired**；retired 事实只能由有 journal 的成功删除产生。批 2 的"迁移"仅限 aggregate 结构升级（version bump），不做数据推断。

**容量出口（v3 新增）**：retired 不静默逐出；达到容量上限时 `beginDeletion` 预占失败、报 `store-full`。恢复出口：**仅当确认没有任何历史 session 引用某 retired 记录时**（各 provider 历史存储中无 cwd 命中且无 affectedSessions 引用）允许清理该记录；引用计数随历史 session 的归档/删除自然下降。正常使用中容量（对齐 tombstone 的 1024 量级）不会触顶。

### F. 领域原语（v3 修正归属 + derive 候选资格）

所有批量操作"**先完整校验（容量 / repository 冲突 / WorktreeKey 占用 / primary / revision），再一次 aggregate 写入**"，禁止循环调用单 member API：

```text
createGroup(plannedMembers[])                 // derive 复用/扩展；创建新组
createGroup(readyMembers[])                   // Adopt 为新组
addPlannedMembers(existingGroupId, members[]) // 仅 Add repo
adoptReadyMembers(existingGroupId, keys[])    // 仅 Adopt 到现有组
mergeGroupsAtomically({ survivorGroupId, sourceGroupId, primaryMemberId })
beginDeletion(intent)                         // 决策 B：含 retired 容量预占
checkpointDeletedMember(operationId, memberId)
failDeletionMember(operationId, memberId, errorCode)
completeDeletion(operationId)                 // manifest + retired + journal 单次写入
```

边界（v3 定案）：derive 是**创建新组**（`createGroup`），不向源组添加 member；Group → Group Merge 只能整体移动 source，与 Unmanaged 勾选 Adopt 是两个独立领域动作，不混用。

**derive 候选资格（v3 新增）**：

| 源组 member 状态 | 资格 |
| --- | --- |
| visible + repository 可解析 | 可参与 |
| detached（仓库移出 workspace） | 显示但不可选，注明原因 |
| failed / planned / provisioning | 不信任 manifest 的 branchName，**从对应 repository refs 重新验证**后才可作为基准 |
| missing 但 branch ref 仍权威存在 | 预检通过后可参与 |

### G. preview token 权威绑定 + 持久化单调 revision【确认，v3 定案 revision】

**revision（v3 定案）**：`WorktreeGroup` 新增持久化单调 `revision`：create 时为 1；rename、member 状态变化、primary 变更、add/remove member、merge 每次成功写入都递增。fingerprint 可保留为调试信息，**不承担新鲜度权威**（fingerprint 有 ABA 问题：名称 A→B→A 后字段相同，但 token 必须已失效）。Merge token 同时绑定 `sourceRevision` 与 `targetRevision`。revision 字段迁移放批 1（rename 是 M3 第一个改变 revision 的操作）。

**token 绑定清单**：

```text
mode（create / add-repo / derive / delete-group / delete-member / adopt / merge）
navigationIdentity
groupId / sourceGroupId / targetGroupId（按 mode 适用）+ 各自 revision
精确选择的 member / WorktreeKey 集合
计划路径、分支、baseRef、setup argv（冻结值）
删除动作模式（visible-only / whole-group / single-member）
```

confirm 时任一漂移返回 `group-changed` 并要求重新预览；组被 rename / Add repo / 移除 / Merge / workspace 切换后旧 token 一律 fail-closed。

**webview mutation 生命周期**（所有 M3 操作统一入协议层）：请求携带 version、requestId、operation、projectId；`accepted` 只表示开始处理；按钮 pending 到对应 authoritative replacement revision 应用后清除；partial 删除保留逐 member 结果、只发一次 aggregate settlement；stale / duplicate / replay / wrong-target 全部 fail-closed；replacement 后按 groupId/memberId 恢复语义焦点、展开状态与滚动；所有 recognized request 恰好 settlement 一次。

### H. rename 与 suggestedSlug【已确认】

rename 时从新显示名重新生成 `suggestedSlug`（沿用 §5.2 规则，纯中文回落 `task-<id>`）。**实现要求（评审补充）**：displayName、suggestedSlug、group revision 在**同一次 Store 写入**中更新。

### I. 移除 primary 的语义【已确认，"ready" 修订为 operationally-ready】

候选判定不能只看 manifest `state === 'ready'`，必须为 **operationally-ready**：

```text
operationally-ready = state=ready + repository 当前可见 + worktree health=normal
```

规则：

- 删除 primary 且存在其他 operationally-ready member → 删除前要求选择新 primary。
- 无候选 → 允许 primary 为空，禁用 New session，走现有"重新选择 primary"提示。
- 删除最后一个 member → 组按 §4.2 直接消失。
- **whole-group 删除不要求选择新 primary**（组整体消失）。

## 3. 实施批次（8 个垂直切片）

禁止 Host/Webview 横向拆分。**每个提交同时包含：协议、Host、权威 HTML、webview pending/replacement、测试、行为契约**。

| 批次 | 内容 | 关键交付 |
| --- | --- | --- |
| 批 1 | member 详情展开 UI + 重命名 + **group revision 迁移** | member summary 可展开；组行 ⋯"重命名"内联编辑（决策 H 单次写入）；`WorktreeGroup.revision` 字段 + 存量迁移为 1；170px / 键盘 / ARIA |
| 批 2 | retired worktree identity（aggregate 结构升级） | 决策 E 的 aggregate 扩展（groups + deletionJournal + retiredIdentities 同 blob）+ Chats 历史分配改从 retired + 世代规则派生 + resume fail-closed；**仅结构迁移，绝不把 missing/prunable 推断为 retired** |
| 批 3 | 删除 journal + Store API + 重启对账 | 决策 B/F 的 beginDeletion（含容量预占）/ checkpoint / fail / complete + 对账规则表全部分支 |
| 批 4 | member 级删除端到端 | 内联确认卡（单 member）+ 门禁 + journal 执行 + partial/Retry + primary 语义（决策 I）+ retired 写入 |
| 批 5 | 组级删除端到端 | 多 member 确认卡 + 逐 member 门禁与执行 + 脱离 member 双动作 + 历史 session 计数 + aggregate settlement |
| 批 6 | 派生 | 表单 derive 模式（决策 C/F 候选资格）+ token 绑定 |
| 批 7 | Add repo + scope outdated 派生 | 表单 add-repo 模式 + `addPlannedMembers` + 决策 D 的 scope 差异派生与组行注记 |
| 批 8 | Adopt + 任意 Merge | 建议组聚类 + Adopt 勾选确认卡 + `adoptReadyMembers`；Merge 去 slug 限制 + survivor/primary 确认 + `mergeGroupsAtomically`（双 revision 绑定） |

拟新增行为契约 ID：`WORKTREE-GROUPS-RENAME-001`、`WORKTREE-GROUPS-HISTORY-IDENTITY-001`、`WORKTREE-GROUPS-DELETE-JOURNAL-001`、`WORKTREE-GROUPS-MEMBER-DELETE-001`、`WORKTREE-GROUPS-GROUP-DELETE-001`、`WORKTREE-GROUPS-DERIVE-001`、`WORKTREE-GROUPS-ADD-REPO-001`、`WORKTREE-GROUPS-ADOPT-MERGE-001`。

## 4. PRD v6 修订点（确认后回写）

1. §6.4：删除确认框为 webview 内联确认卡（A）。
2. §4.2 / §6.4：删除 journal 事务模型、单一 aggregate 存储边界、重启对账规则表（B）。
3. §6.4：历史 session 身份由 retired identity + 世代规则承载；同路径重建不自动解除；retired 只由 journaled 删除产生（E）。
4. §6.2 / §6.3：derive / add-repo 复用内联创建表单；Add repo 默认勾选规则；derive 候选资格（C/F）。
5. §6.3：scope 提示为运行时 scope 差异派生 + 组行内联汇总（D），§14 开放问题 2 闭环。
6. §4.1 / §5.2：rename 重新生成 suggestedSlug，与 revision 同次写入（H/G）。
7. §4.2：primary 移除语义按 operationally-ready（I）。
8. §4：Group 实体增加持久化单调 `revision`（G）。
9. §6.5：Adopt / Merge 原子写语义、survivor/primary 确认、Merge 与 Adopt 的领域边界（F/G）。
10. §14：开放问题 1 闭环；§10：member 详情展开与删除确认卡入结构图。

## 5. 验收矩阵与全量门禁

### 删除（批 2–5）

- 删除在每个边界崩溃后的重启结果：journal 写入后 / 首个物理删除后 / 部分 checkpoint 后 / manifest 移除前 / retired 写入前（单一 aggregate 使后两者同生共死，仍需故障注入验证）。
- 全量预检任一失败 → 零物理副作用（无 journal、无目录变动）。
- retired 容量预占：满员时 `beginDeletion` 在物理副作用前拒绝并报 `store-full`；清理无引用记录后可重试。
- 预检通过后、执行前新 session 在某 member 上启动（TOCTOU）→ 执行期逐 member 复检拦截，按 partial 处理。
- partial journal：A/C 成功 B 失败 → A/C retired + 移除、B ready+lastError、journal partial 仅留 B；Retry 重开同一 operation；终态归档。
- primary 删除（operationally-ready 候选有 / 无两路）；最后一个 member → 组消失；whole-group 删除不要求选 primary。
- 脱离 member 双动作；"删除整个组"在脱离 member 存在时阻断。
- discovery 截断 / 仓库暂时不可见时对账保留 `deleting`。
- 历史 session 在 member 移除后仍在 Chats：能查看、不能恢复；**同路径重建后新世代 session 不被误标**，旧世代不因新 discovery 状态解禁。
- 真实临时 git 仓库上的删除端到端测试。

### scope 提示（批 7）

- active / pending / legacy / 重启后恢复四类 session 独立判定。
- 新 member 未 ready 不产生提示；ready 后按 diff 出现；session 结束 / resume 后消失；member 移除后重新比较。
- Add repo 与并发 remove / merge / rename 交错时自洽。

### Add repo / 派生（批 6–7）

- Add repo 部分 member 失败与重启恢复（关联回既有组，不新建重复组）。
- 默认勾选规则（活跃编辑器未入组 / 无 / 零选择禁确认）。
- token：rename / Add repo / 移除 / Merge / workspace 切换后旧 confirm 返回 `group-changed`；revision ABA 场景（名称 A→B→A）旧 token 仍失效。
- derive 候选资格：detached 不可选、failed 重新验证 refs、missing+ref 存在预检后参与。

### Adopt / Merge（批 8）

- stale snapshot、重复 WorktreeKey、repository 冲突阻断。
- survivor / primary 确认原子生效；source manifest 删除；session cwd 不变；双 revision 绑定。
- 单个无主 worktree 走同一 Adopt 路径。

### 协议与 webview（全批次）

- malformed / duplicate / replay / 乱序 settlement 全部 fail-closed；recognized request 恰好 settlement 一次。
- replacement 后焦点 / 展开 / 滚动按 groupId/memberId 恢复。

### 全量门禁（每批按此顺序执行）

```text
npm ci                                   # 新 worktree 首次验证前
npm run test-compile
focused unit / contract tests            # 本批触及区域
browser tests                            # 本批对应套件
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
| 删除事务跨进程退出的中间态 | 决策 B journal + 对账规则表；故障注入测试覆盖每个边界 |
| manifest / journal / retired 跨 key 写入窗口 | 单一 aggregate，一次 `memento.update`（决策 B 定案） |
| 删完物理目录才发现 retired 已满 | beginDeletion 容量预占，物理副作用前拒绝（决策 B） |
| 历史身份随 member 移除丢失 | 决策 E retired 记录；批 2 先于任何删除落地 |
| 同路径重建导致世代混淆 | affectedSessions 快照 + deletedAt 辅助边界（决策 E） |
| retired 只增不减最终 store-full | 无引用记录允许清理；引用随历史归档下降（决策 E） |
| revision ABA | 持久化单调 revision，fingerprint 仅调试（决策 G） |
| Add repo / 派生绕过 preview 管线 | 协议层拒绝无 token 请求；token 绑定 revision（决策 G） |
| Merge 的 primary 语义 | `mergeGroupsAtomically` 显式接收最终 primaryMemberId；双 revision 绑定 |
| member 详情展开增加行高复杂度 | 沿用折叠机制与 collapse-all；170px 用例入浏览器测试 |
