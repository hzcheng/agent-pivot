# Worktree Tasks M3 实现前评审与实施方案

日期：2026-08-15（v2，第一轮外部评审修订版，待批注）

状态：M1/M2 已交付；本文档是 M3（组级与 member 级操作）的实现前评审，结论确认后将回写 PRD v6，然后按批次实现

评审范围：PRD §6.2–6.5（派生 / Add repo / 删除 / Adopt & Merge）、§4.2 状态机、§10 UI 结构、§12 里程碑、§14 开放问题 1/2。

## v1 → v2 修订摘要（对应外部评审 2 阻塞 + 5 重要）

| 评审项 | 处理 |
| --- | --- |
| 阻塞 1：`deleting` 不能是易失态 | 决策 B 整体重写为**持久化删除 journal**（§2.B）；更正盘点错误：store 状态机已含 `deleting`（`groupManifestStore.ts` `WorktreeGroupMemberState`） |
| 阻塞 2：删除 member 会销毁历史 session 身份来源 | 决策 E 整体重写为**持久化 retired worktree identity**（§2.E） |
| 重要 3：scope 提示生命周期定义错误 | 决策 D 重写为**运行时 scope 差异派生**（§2.D） |
| 重要 4："store 原语已齐备"过于乐观 | 新增 §2.F 领域原语清单（批量操作先完整校验、单次写入） |
| 重要 5：preview token 不能只复用形态 | 新增 §2.G token 权威绑定清单与 webview mutation 生命周期 |
| 重要 6：Add repo 默认全选 + 两个产品决策 | 决策 C 修正默认勾选规则；新增决策 H（rename 与 slug）、决策 I（primary 移除语义） |
| 重要 7：批 2 过大且不能横向拆 | §3 重组为 8 个垂直批次，每提交自洽（协议 + Host + HTML + webview pending/replacement + 测试 + 契约） |
| 验收矩阵缺失 | 新增 §5 验收矩阵 |

## 1. 现状盘点（v2 修正版）

| M3 子特性 | 现状 | 缺口 |
| --- | --- | --- |
| 重命名 | store 有 `renameGroup` | UI 无入口；rename 与 `suggestedSlug` 的关系未定（决策 H） |
| 派生（§6.2） | 仅单仓库 branch seed（Unmanaged 行吸收路径） | 不支持"源组各 member 分支作为对应仓库基准"；无默认勾选源组仓库集合；无派生命名默认值 |
| Add repo（§6.3） | 不存在 | 整个流程 + scope 演进提示（决策 D）；store 缺原子批量 `addPlannedMembers` |
| 组级删除（§6.4） | ⋯ 菜单 Remove 只删 primary member，走单 worktree 流程（`managedWorktreeRemovalController`；其已承认"目录已删除但 refresh 失败"的 partial） | 删除 journal（持久化 intent + 逐 member checkpoint + 重启对账）、内联确认卡、脱离 member 双动作、历史 session 计数 |
| member 级移除（§6.4） | 无处挂载 | member summary 目前是静态 `role="note"` 行，不可展开；member 详情 UI 不存在 |
| 历史 session 删除标记（§6.4） | 物理 worktree 消失后，历史身份依赖 **manifest member 的 path → WorktreeKey fallback**（`findGroupMemberWorktreeKeyForPath`、`sessionHydration.ts` manifest fallback、webview `worktreeUnavailable` UI） | member 从 manifest 移除后 fallback 消失，workspace root 之外的历史 session 会从 Chats 分配结果里消失；需要 retired identity 接管（决策 E） |
| Adopt（§6.5） | 不存在 | Unmanaged 平铺，无 slug 建议组聚类、无 Adopt 入口、无勾选确认；store 缺原子 `adoptReadyMembers` |
| 任意 Merge（§6.5） | 仅同 suggestedSlug 候选 + QuickPick；冲突阻断（`repository-conflict`）已有 | 去掉 slug 限制；member 勾选并入不同名外部 worktree；survivor / primary 确认；`mergeGroups` 只能整体移动并固定保留 target primary，缺"选 survivor + 选最终 primary"的原子写 |
| 删除状态机 | store **已支持**持久化 `deleting`（v1 盘点有误） | 无 operation/journal、无逐 member checkpoint、无重启对账规则 |

## 2. 决策点（v2）

### A. 删除确认框的形态 —— webview 内联确认卡（评审已认可，保留）

§6.4 要求确认框逐 member 列出物理路径 + 检查结果（活跃 session / 未提交改动 / 锁定）+ 受影响历史 session 数 + 脱离 member 的双动作（"移除当前可见 worktree" / "删除整个组"）；§10 要求删除确认的键盘操作 / 焦点恢复 / ARIA 随 M3 交付。原生 modal（`showWarningMessage`）装不下。

确认卡与创建表单互斥（同类单实例语义，复用 M2 表单单实例机制）。

### B. 删除事务模型 —— 持久化删除 journal（v2 重写）

v1 的"`git worktree remove` 原子、故 `deleting` 易失"推论不成立：业务事务是 `manifest 标记删除 → 物理删除 → manifest 移除 member → discovery 刷新 → 历史 session 身份保留`，进程可能在任意边界退出（现有单 worktree controller 已承认"目录已删除但 refresh 失败"的 partial）。discovery 的 missing/prunable 只能描述观察结果，不能证明删除事务的意图，不能替代删除日志。

**删除 journal**（持久化，按 `navigationIdentity` 分桶）：

- **beginDeletion**：任何物理副作用之前，原子持久化删除 intent——operationId、操作模式（group / member / visible-only）、目标 member 集合（含各自 WorktreeKey / path / branchName 快照）、原 primaryMemberId、关联的 preview token（决策 G）。
- **checkpointDeletedMember**：每成功删除一个 member，立即 checkpoint（该 member 标记物理已删）。
- **failDeletionMember**：执行期失败的 member 记录失败原因。
- **completeDeletion**：manifest 移除已完成 member、journal 归档。

**重启对账规则**（fail-closed，绝不猜测成功）：

| 观察 | 对账动作 |
| --- | --- |
| member 路径确定不存在 | 完成 manifest 移除，写 retired identity（决策 E） |
| worktree 仍正常存在 | 恢复 `ready` + `deletion-interrupted` 标记，允许 Retry |
| discovery 截断 / 仓库脱离 / 状态未知 | **保留 `deleting`**，阻断同 member 的新删除与创建，待下一轮确定快照 |

**Retry 语义**：group/member 的 Retry 必须重用 journal 中的原目标身份（WorktreeKey / path 快照），不按当前 DOM 或路径重新推断。

**primary 语义**：primary 被删除而其他 ready member 尚存 → primary 置空并走现有"重新选择 primary"提示；详见决策 I。

### C. Add repo / 派生的交互载体 —— 复用内联创建表单（默认勾选规则 v2 修正）

两者都必须走 M2 的完整管线：实时预览 + 预检门禁 + 一次性 preview token + argv 冻结 + 逐项绑定（token 绑定清单见决策 G）。协议层拒绝无 token 的补建/派生请求，不允许旁路。

表单增加两种模式：

- `add-repo`：候选 = 组尚未包含的 workspace 仓库（不变式二保证每仓库至多一个候选）；slug 锁定为组的 suggestedSlug；基准默认取各仓库记忆基准；无 primary 切换（新 member 不设 primary，除非组当前无 ready primary）。
  - **默认勾选（v2 修正，评审重要 6）**：跨仓库工作集是少数，"默认全选未入组仓库"是静默多建。规则：活跃编辑器所在仓库未入组 → 只默认勾选它；否则**默认不选**，由用户显式勾选；保留"全选"快捷操作；零选择时确认按钮禁用。
- `derive`：预勾选 = 源组 member 仓库集合；每仓库基准覆盖为源组对应 member 分支（源组不含的仓库被勾选时回落该仓库基准，§6.2）；名称默认 `源名-2`（§14 开放问题 1 按 PRD 钦定的"追加短后缀"闭环），预览照常可见。

### D. scope 演进提示 —— 运行时 scope 差异派生（v2 重写，评审重要 3）

v1 的"member 集合变化时清除事件标记"是错的：再加一个仓库不能让旧 session 突然获得前一个仓库；rename / 删其他 member 不应清提示；非 legacy 的 isolated session 也可能只是创建早于新 member。

**改为纯派生**：运行时身份已持久化 `writableRootHostPaths`（`runtimeTypes.ts`），逐 session 独立比较：

```text
期望 scope = 组当前 ready member 的 worktree 路径集合
实际 scope = 该 active/pending runtime 持久化的 writableRootHostPaths
scopeOutdated = 期望 ⊄ 实际（有新 member 路径不在实际 scope 内）
```

规则：

- 新 member 到达 `ready` 后才进入期望 scope（provisioning 期间不产生提示）。
- 每个 active/pending session 独立判定；session 结束或按当前组 resume 重建 scope 后自然消失。
- member 被移除时**重新比较**（diff 可能因此消失），不是清空事件标记。
- `legacyScope`（M1 升级前运行中）与 `scopeOutdated`（成员演进）分开表达，文案不同。
- 呈现：组行内联汇总注记（如 `2 running sessions predate the added repository`），不在每张 session 卡片重复徽标（此点评审已认可，保留）。

### E. 历史 session 身份 —— 持久化 retired worktree identity（v2 重写，评审阻塞 2）

v1 的"按路径是否存在派生"与现有实现不兼容：M1 历史身份依赖 manifest member 的 path → WorktreeKey fallback，M3 删除成功后 member 从 manifest 移除，fallback 消失，workspace root 之外的历史 session 会从 Chats 分配结果里整体消失。仅查路径存在也不安全：同一路径出现无关目录或新 checkout 不应让旧 session 自动"可恢复"。

**新增持久化 retired identity store**（按 `navigationIdentity` 分桶）：

```text
retiredWorktreeIdentity:
  repositoryKey
  canonicalWorktreePath
  branchName（删除时快照）
  deletedAt
  origin: { groupId, memberId, displayName }（可选，供 UI 展示来源）
```

语义：

- 记录的是"这个历史 session 的原 worktree 已被删除"这一**历史事实**，不是当前文件系统状态。
- 删除事务在 manifest 移除 member 时同步写入（completeDeletion / 对账完成路径都要写）。
- Chats 历史分配与"无法直接恢复"标记改从 retired store + discovery 健康联合派生；resume 对 retired key fail-closed，对话查看保持可用。
- **只有未来的显式"重建并重新绑定"功能才能解除**；同路径重新出现不自动解除。
- 容量策略沿用 provisioningStore tombstone 的教训：不静默逐出，写满时拒绝并报 `store-full`。

### F. 领域原语（评审重要 4：先建原语，再建流程）

现有 store API 不够：`addMember` 一次一个、无法原子预留多个 planned member；`mergeGroups` 只能整体移动并固定保留 target primary；无原子 Adopt；无删除 journal。M3 先实现以下原语，全部遵守"**先完整校验（容量 / repository 冲突 / WorktreeKey 占用 / primary），再一次 manifest 写入**"，禁止循环调用单 member API：

```text
addPlannedMembers(bucket, groupId, members[])           // Add repo / derive 原子预留
adoptReadyMembers(bucket, targetGroupId | null, keys[]) // Adopt 到新组或现有组
beginDeletion(bucket, intent)                           // 决策 B
checkpointDeletedMember(bucket, operationId, memberId)
failDeletionMember(bucket, operationId, memberId, errorCode)
completeDeletion(bucket, operationId)                   // 含 retired identity 写入
mergeGroupsAtomically(bucket, { survivorGroupId, sourceGroupId, primaryMemberId })
```

### G. preview token 权威绑定 + webview mutation 生命周期（评审重要 5）

M3 的 token 必须绑定会变化的权威目标，confirm 时任一漂移返回 `group-changed` 并要求重新预览，不把旧确认应用到新组状态：

```text
mode（create / add-repo / derive / delete-group / delete-member / adopt / merge）
navigationIdentity
groupId / sourceGroupId / targetGroupId（按 mode 适用）
group revision 或完整 authoritative fingerprint（member 集合、primary、displayName、slug）
精确选择的 member / WorktreeKey 集合
计划路径、分支、baseRef、setup argv（冻结值）
删除动作模式（visible-only / whole-group / single-member）
```

group 被 rename、Add repo、移除、Merge 或 workspace 切换后，旧 token 一律 fail-closed。

**webview mutation 生命周期**（所有 M3 操作统一，入协议层）：

- 请求携带 version、requestId、operation、projectId。
- `accepted` 只表示开始处理，不表示成功；按钮 pending 到对应 authoritative replacement revision 应用后才清除。
- partial 删除保留逐 member 结果，且只发送一次 aggregate settlement。
- stale、duplicate、replay、wrong-target 全部 fail-closed。
- replacement 后按 groupId/memberId 恢复语义焦点、展开状态与滚动。
- 所有 recognized request 必须恰好 settlement 一次（沿用 M2 set-primary 教训）。

### H. rename 与 suggestedSlug（评审重要 6 之产品决策 1）

只改 displayName 会让未来 Add repo / derive 仍按旧 slug 命名，用户困惑。

**建议**：rename 时**从新显示名重新生成 suggestedSlug**（沿用 §5.2 生成规则，含纯中文回落 `task-<id>`）。slug 本就不承担权威身份（承诺 3），重新生成只影响未来 member 的默认命名与建议组聚类，不影响既有 member 的分支/路径。merge 建议（同 slug 候选）随 rename 后重新计算，语义自洽。

### I. 移除 primary 的语义（评审重要 6 之产品决策 2）

**建议**：仅当组内仍存在其他 ready member 时，才要求先选择新 primary（移除流程内嵌选择，或阻断并提示）；移除后无 ready member（最后一个 member 被删，或剩余全是 failed/missing）→ 允许 primary 为空，组行禁用 New session 并走现有"重新选择 primary"提示。删除最后一个 member 时组按 §4.2 消失。

## 3. 实施批次（v2：8 个垂直切片）

评审重要 7：禁止"Host 提交 / Webview 提交"横向拆分（中间提交协议不完整，违反自洽 mutation contract）。**每个提交都同时包含：协议、Host、权威 HTML、webview pending/replacement、测试、行为契约**。

| 批次 | 内容 | 关键交付 |
| --- | --- | --- |
| 批 1 | member 详情展开 UI + 重命名 | member summary 可展开（路径 / 分支 / 状态 / member 级操作挂载点）；组行 ⋯"重命名"内联编辑 + slug 重新生成（决策 H）；170px / 键盘 / ARIA |
| 批 2 | retired worktree identity + 迁移 | 决策 E 的 store + Chats 历史分配改从 retired 派生 + resume fail-closed；旧数据迁移（现存 missing member 的 fallback 行为不变式锁定） |
| 批 3 | 删除 journal + Store API + 重启对账 | 决策 B/F 的 `beginDeletion` / `checkpoint` / `fail` / `complete` + 对账规则表全部分支（含 discovery 截断保留 deleting） |
| 批 4 | member 级删除端到端 | 内联确认卡（单 member 形态）+ 门禁 + journal 执行 + partial/Retry + primary 语义（决策 I）+ retired 写入 |
| 批 5 | 组级删除端到端 | 多 member 确认卡 + 逐 member 门禁与执行 + 脱离 member 双动作 + 历史 session 计数 + aggregate settlement |
| 批 6 | 派生 | 表单 derive 模式（决策 C）+ token 绑定（决策 G） |
| 批 7 | Add repo + scope outdated 派生 | 表单 add-repo 模式（决策 C 默认勾选）+ `addPlannedMembers` + 决策 D 的 scope 差异派生与组行注记 |
| 批 8 | Adopt + 任意 Merge | 建议组聚类 + Adopt 勾选确认卡 + `adoptReadyMembers`；Merge 去 slug 限制 + survivor/primary 确认 + `mergeGroupsAtomically` |

拟新增行为契约 ID：`WORKTREE-GROUPS-RENAME-001`、`WORKTREE-GROUPS-HISTORY-IDENTITY-001`、`WORKTREE-GROUPS-DELETE-JOURNAL-001`、`WORKTREE-GROUPS-MEMBER-DELETE-001`、`WORKTREE-GROUPS-GROUP-DELETE-001`、`WORKTREE-GROUPS-DERIVE-001`、`WORKTREE-GROUPS-ADD-REPO-001`、`WORKTREE-GROUPS-ADOPT-MERGE-001`。

## 4. PRD v6 修订点（决策确认后回写）

1. §6.4：删除确认框明确为 webview 内联确认卡（决策 A）。
2. §4.2 / §6.4：`deleting` 为持久化状态，补删除 journal 事务模型与重启对账规则表（决策 B）。
3. §6.4：历史 session 身份由持久化 retired identity 承载，path 重现不自动解除（决策 E）。
4. §6.2 / §6.3：派生与 Add repo 复用内联创建表单的 derive / add-repo 模式；Add repo 默认勾选规则（决策 C）。
5. §6.3：scope 演进提示为运行时 scope 差异派生 + 组行内联汇总（决策 D），§14 开放问题 2 闭环。
6. §4.1 / §5.2：rename 重新生成 suggestedSlug（决策 H）。
7. §4.2：primary 移除语义（决策 I）。
8. §6.5：Adopt / Merge 的原子写语义与 survivor/primary 确认（决策 F/G）。
9. §14：开放问题 1 闭环（派生默认名追加短后缀）。
10. §10：结构图补 member 详情展开形态与删除确认卡。

## 5. 验收矩阵

每个场景归入对应批次的行为契约；崩溃场景用故障注入（在持久化/物理副作用边界模拟进程退出）覆盖。

### 删除（批 2–5）

- 删除在以下每个边界崩溃后的重启结果：journal 写入后 / 首个物理删除后 / 部分 checkpoint 后 / manifest 移除前 / retired 写入前。
- 全量预检任一失败 → 零物理副作用（无 journal、无目录变动）。
- 预检通过后、执行前新 session 在某 member 上启动（TOCTOU）→ 执行期逐 member 复检拦截，按 partial 处理。
- 部分删除失败：已删不回滚；残余 member ready + 失败标记 + Retry；Retry 重用 journal 原目标身份。
- primary 被删（有其他 ready member / 无 ready member 两路，决策 I）；最后一个 member → 组消失且无 manifest 残留。
- 脱离 member：双动作语义；"删除整个组"在脱离 member 存在时阻断。
- discovery snapshot 截断 / 仓库暂时不可见时对账保留 `deleting`，不错误完成。
- 历史 session 在 manifest member 移除后仍出现在 Chats：能查看对话、不能恢复（retired identity 接管，含 workspace root 之外的 session）。
- 真实临时 git 仓库上的删除端到端测试。

### scope 提示（批 7）

- active / pending / legacy / 重启后恢复的四类 session 独立判定。
- 新 member 未 ready 不产生提示；ready 后按 diff 出现。
- session 结束 / resume 重建后消失；member 移除后重新比较。
- Add repo 与并发 remove / merge / rename 交错时提示状态自洽。

### Add repo / 派生（批 6–7）

- Add repo 部分 member provisioning 失败与重启恢复（关联回既有组，不新建重复组）。
- 默认勾选规则（活跃编辑器未入组 / 无活跃编辑器 / 零选择禁确认）。
- token 绑定：group 被 rename / Add repo / 移除 / Merge / workspace 切换后旧 confirm 返回 `group-changed`。

### Adopt / Merge（批 8）

- stale snapshot、重复 WorktreeKey（不变式一）、repository 冲突（不变式二）阻断。
- survivor / primary 确认原子生效；source manifest 删除；session cwd 不变。
- 单个无主 worktree 走同一 Adopt 路径（建议组大小为 1）。

### 协议与 webview（全批次）

- malformed / duplicate / replay / 乱序 settlement 全部 fail-closed；recognized request 恰好 settlement 一次。
- replacement 后焦点 / 展开状态 / 滚动按 groupId/memberId 恢复。

### 全量门禁

- `npm run test:safety:run`、webview checks、lint、`git diff --check`。
- 每个 audit commit 后 `npm run test:behavior-contracts`。

## 6. 已识别的风险与对应

| 风险 | 对应 |
| --- | --- |
| 删除事务跨进程退出的中间态 | 决策 B journal + 重启对账规则表；故障注入测试覆盖每个边界 |
| 历史身份随 member 移除丢失 | 决策 E retired store；批 2 先于任何删除落地 |
| journal / retired 双写不一致 | completeDeletion 单次写入同时更新两者；对账以 journal 为准 |
| Add repo / 派生绕过 preview 安全管线 | 协议层拒绝无 token 请求；token 绑定 group revision（决策 G） |
| 任意 Merge 的 primary 语义 | `mergeGroupsAtomically` 显式接收最终 primaryMemberId；无 ready primary 时走现有选择提示 |
| retired store 无限增长 | 不静默逐出；写满拒绝并报 `store-full`（沿用 tombstone 教训） |
| member 详情展开增加行高复杂度 | 沿用折叠机制与 collapse-all；170px 最小宽度用例纳入浏览器测试 |
