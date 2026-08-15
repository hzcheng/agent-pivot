# Worktree Tasks M3 后续批次（批 3–8）执行计划

> 状态：草案 v2，待评审。不涉及任何实现。
> v2 修订：按 2026-08-16 决策，本轮只完成批 3–8 功能交付，不做架构收口批、不做
> 集中架构债务偿还；架构改动仅在当前批次正确性不得不依赖时以最小范围进行。
> 输入：`docs/worktree-tasks-m3-plan.md`（v5.1，8 批次定案）、批 2 六轮复审确立的
> 领域不变量。

## 0. 总原则

1. **只做功能批次**：按 v5.1 的批 3–8 顺序交付，每批评审通过再进下一批。
2. **架构改动最小化**：不预设重构批、不做搬迁式改造。仅当某批的正确性不改动
   现有结构就无法保证时（见各批"不得不动"条目），才在该批内做最小改动，并随
   该批一起评审。
3. **不扩大战线**：不顺手清理旧代码、不迁移旧协议、不拆分大文件。发现的架构问题
   一律登记到 §4 债清单，本轮不处理。
4. **Invariant First**（轻量版）：每批实现前先把该批的领域不变量写成测试，
   避免重蹈批 2"逐点打补丁、另一条路径绕开不变量"的循环——这是测试顺序要求，
   不是架构改造。
5. **不确定按 fail-closed 处理**：presence 可证明发生，absence 不能证明没发生；
   身份冲突进持久化 quarantine，不按顺序猜测。（沿用批 2 已定死的三条不变量，
   任何批次不得回退：pending claim 始终阻断 deletion；只有 `proven-not-started`
   才能释放 claim；Store 层 reconcile 只 keep/promote。）

## 1. 批 3：删除 journal + Store API + 重启对账 + lease/mutex

实现决策 B/F/J，无 UI。这是剩余批次中最重的一批，单独充分评审。

### 1.0 动手前的文档定案（纯文档，半小时级）

批 3 计划当前自相矛盾（`worktree-tasks-m3-plan.md`）："pending claim 提交即
blocker"与"孤儿 claim 无佐证不阻断"不能并存。按批 2 已定死的不变量定案：

- **pending claim 自身始终阻断 deletion**；孤儿 claim 不自动消失，经显式
  abandon / 用户确认处置释放（UI 入口在批 4 确认卡中暴露）。
- 回写 m3-plan 标注 v5.2，必要时同步 PRD §6.4。

### 1.1 实现前先冻结的不变量（先写测试）

- journal 在**任何物理副作用之前**原子持久化：intent、operationId、模式、目标
  member 快照、原 primary、`affectedSessions` 冻结快照、`generationCutoffAt`
  （`max(nowMs(), lastGenerationCutoffAt + 1)`，高水位不回退）、retired 容量预占。
- `checkpointDeletedMember` 只消费 journal 冻结信息，绝不重新查询。
- admission mutex 键 `{navigationIdentity, groupId}`；deletion 与 New session 互斥。
- lease：active journal 期间阻断该组 Add repo / Adopt / Merge / primary / rename /
  新 session / 再次删除；放行 Retry / abandon / 查看。
- 对账三路 fail-closed：路径确证不存在 → 完成移除；worktree 仍在 →
  `ready + deletion-interrupted` + Retry；截断/脱离/未知 → 保留 `deleting` 不猜测。
- Retry 重用 journal 冻结身份，不按当前 DOM/路径重新推断。

### 1.2 交付

- Store：决策 F 的删除族领域原语（`beginDeletion / checkpointDeletedMember /
  failDeletionMember / completeDeletion / abandonDeletion`）+ `aggregateRevision` +
  `lastGenerationCutoffAt` 持久化高水位。
- 删除事务状态机 + 重启对账全分支 + publication 串行化。
- 测试：状态机矩阵（claim 写入前后 / launch 前后 / 异常 / 崩溃 / 删除抢锁）、
  崩溃边界故障注入、时钟回拨高水位、`store-full` 零副作用、admission 竞态、
  TOCTOU 执行期逐 member 复检。
- 契约：`WORKTREE-GROUPS-DELETE-JOURNAL-001`。

### 1.3 不得不动的架构点（最小范围）

- **删除族原语落地时**，member 状态字段经这些原语写入；既有 `updateMember` 的
  通用 patch 能力**不重构、不收回**，旧调用点不动。
- **删除事务编排**放在一个新模块（建议 `src/worktrees/deletionController.ts`），
  避免继续向 `dashboard.ts` 堆逻辑；批 2 已存在的 claim reconciliation 调度
  **不搬迁**，留在原地。
- tmux backend 存在"launch attempted 但恢复不确定"路径：补偿删除 claim 仅限
  `proven-not-started` 语义；若现有 `create()` 类型表达不了，做**最小类型扩展**，
  Direct/tmux 后端语义统一登记为债。

## 2. 批 4–8：功能批次（沿用 v5.1 范围）

| 批次 | 范围（不变） | 不得不动的最小点 | 关键验收（沿用验收矩阵） |
| --- | --- | --- | --- |
| 批 4 member 删除 E2E | 内联确认卡、门禁、journal 执行、partial/Retry/abandon、primary 语义（operationally-ready）、retired 写入 | 新 mutation 的 requestId 加每文档 nonce + 回传 projectId（沿用批 1 rename 的修法，只做新协议，不动旧协议）；确认卡暴露孤儿 claim 处置入口 | 崩溃边界全分支、primary 有/无候选、locked 两态、最后 member 组消失、真实临时 git 仓库 E2E、settlement 绑 `minimumAggregateRevision` |
| 批 5 组删除 E2E | 多 member 确认卡、逐 member 门禁、脱离双动作、历史计数、焦点恢复（下一组→Current→New） | whole-group 复用批 3/4 的同一事务路径，不开第二条 | 脱离 member 阻断、aggregate settlement、焦点恢复、旧世代可看不可恢复 |
| 批 6 派生 | 表单 derive 模式、`createGroup(plannedMembers)`、token 绑定、候选资格四态 | token 绑 revision 指纹（既有机制，无新架构） | token 漂移 `group-changed`、revision ABA、候选四态 |
| 批 7 Add repo + scope 派生 | 表单 add-repo、`addPlannedMembers`、映射后 writable paths 差异派生与组行注记 | 路径比较写成纯函数（新代码），UI 只渲染 | 子目录 binding、Windows 大小写、四类 session 判定、member ready 前后 |
| 批 8 Adopt + Merge | 建议组聚类、Adopt 确认卡、`adoptReadyMembers`、去 slug 限制 Merge、`mergeGroupsAtomically`（双 revision + 双 lease） | Merge 双 lease 按稳定 groupId 顺序取锁 | stale snapshot、重复 WorktreeKey、survivor/primary 原子生效、session cwd 不变 |

每批纪律不变：单提交自洽（协议 + Host + HTML + webview pending/replacement +
测试 + 契约）；实现提交 + 审计提交成对；全量门禁按既有顺序。

## 3. 统一的新代码约束（不是重构，是新代码的写法）

批 3–8 的**新增**代码遵守以下约束，旧代码不动：

1. 新 mutation 协议一律带：每文档 nonce、回传 `projectId`/`navigationIdentity`、
   `minimumAggregateRevision` settlement。
2. 新跨域生命周期逻辑放新模块，不再向 `SessionControllerCompositionOptions`
   增加回调，不再向 `dashboard.ts` 堆编排。
3. 新状态迁移经领域原语，不经通用 patch。

## 4. 架构债清单（本轮一律不动，仅登记）

1. 旧 mutation 协议（isolated / removal / primary / group-form）的 nonce/envelope 加固。
2. `dashboard.ts` 与 webview controls 拆分；批 2 claim reconciliation 调度搬迁。
3. `models.ts` / `aiSessions/types.ts` 循环依赖；`CodexSession` provider-neutral 命名；
   branded identity。
4. `groupManifestStore` 内部拆 codec/reducer/capacity；`updateMember` 通用 patch 收回。
5. Direct / tmux 创建结果模型统一。
6. Store quarantine 的用户级修复/导出工具。
7. 架构文档 reconcile（`docs/architecture-current-state.md`）。

## 5. 节奏与评审点

```text
批 2 验收（在途）
  → 批 3（文档定案 → 不变量测试 → 实现 → 评审）
  → 批 4 / 批 5 删除 E2E
  → 批 6 / 批 7 / 批 8
  → M3 完成（架构债留给后续专门轮次）
```

评审点：本计划确认 → 批 3 文档定案确认（§1.0）→ 每批"实现 → 评审 → 修复 →
复审"循环。
