# Worktree Tasks M3 实现前评审与实施方案

日期：2026-08-15（v1，实现前评审稿，待批注）

状态：M1/M2 已交付；本文档是 M3（组级与 member 级操作）的实现前评审，结论确认后将回写 PRD v6，然后按批次实现

评审范围：PRD §6.2–6.5（派生 / Add repo / 删除 / Adopt & Merge）、§4.2 状态机、§10 UI 结构、§12 里程碑、§14 开放问题 1/2。

## 1. 现状盘点

store 层原语已齐备（`renameGroup` / `addMember` / `removeMember` / `mergeGroups` / `setPrimaryMember`），M2 的 preview token / argv 冻结 / settlement 协议形态均可复用。M3 的主要工作在编排与 UI。

| M3 子特性 | 现状 | 缺口 |
| --- | --- | --- |
| 重命名 | store 有 `renameGroup` | UI 无入口 |
| 派生（§6.2） | 仅单仓库 branch seed（Unmanaged 行吸收路径） | 不支持"源组各 member 分支作为对应仓库基准"；无默认勾选源组仓库集合；无派生命名默认值 |
| Add repo（§6.3） | 不存在 | 整个流程 + scope 演进提示（§14 开放问题 2） |
| 组级删除（§6.4） | ⋯ 菜单 Remove 只删 primary member，走单 worktree 流程（`managedWorktreeRemovalController`） | 逐 member 预检门禁确认框、partial 不回滚 + 残余 Retry、脱离 member 双动作、历史 session 计数 |
| member 级移除（§6.4） | 无处挂载 | member summary 目前是静态 `role="note"` 行，不可展开；member 详情 UI 不存在 |
| 历史 session 删除标记（§6.4） | 不存在 | Chats 保留 + "工作目录已删除，无法直接恢复"标记；删除确认框计数（M1 只做了已删除 worktree 的对话查看） |
| Adopt（§6.5） | 不存在 | Unmanaged 平铺，无 slug 建议组聚类、无 Adopt 入口、无勾选确认 |
| 任意 Merge（§6.5） | 仅同 suggestedSlug 候选 + QuickPick；冲突阻断（`repository-conflict`）已有 | 去掉 slug 限制；member 勾选并入不同名外部 worktree；survivor / primary 确认 |

## 2. 决策点（实现前必须拍板）

### A. 删除确认框的形态 —— 建议 webview 内联确认卡

§6.4 要求确认框逐 member 列出物理路径 + 检查结果（活跃 session / 未提交改动 / 锁定）+ 受影响历史 session 数 + 脱离 member 的双动作（"移除当前可见 worktree" / "删除整个组"）；§10 要求删除确认的键盘操作 / 焦点恢复 / ARIA 随 M3 交付。

现有 `confirm` 是原生 modal（`showWarningMessage`，一段文字 + 一个按钮），装不下上述内容。

**建议**：webview 内联确认卡，与 M2 创建表单同族。理由：可进浏览器测试；a11y 可控（焦点圈定、Esc 取消、错误关联）；与"仅创建可用成员"的显式动作模式一致；双动作语义天然可表达。

### B. `deleting` 状态持久化与否 —— 建议易失态

store 状态机目前无 `deleting` 态（§4.2 状态机有 `ready → deleting → deleted`）。M2 的教训是任何状态都要回答"重启后谁对账"。

删除与创建不同：`git worktree remove` 本身原子（要么删了要么没删），不存在跨重启的物理半成品需要恢复；执行期极短；异常中断的残余由 discovery 的 missing/prunable 机制兜底呈现。

**建议**：`deleting` 为内存易失态（仅投影显示"删除中"），持久化状态保持 ready；执行期失败按 §6.4 回 ready + 失败标记 + Retry。重启后无卡死态，不需要新的对账记录。PRD §4.2 需补一句注明。

### C. Add repo / 派生的交互载体 —— 建议复用内联创建表单

两者都需要 M2 那套"实时预览 + 预检门禁 + 一次性 preview token + argv 冻结 + 逐项绑定"。新造一套传参等于把 M2 六轮评审修掉的安全洞（setup argv 注入、preview 篡改、token 重放）再开一遍。

**建议**：内联创建表单增加两种模式：

- `add-repo`：预勾选 = 组尚未包含的 workspace 仓库（不变式二保证每仓库至多一个候选）；slug 锁定为组的 suggestedSlug；基准默认取各仓库记忆基准；无 primary 切换（新 member 不设 primary，除非组当前无 ready primary）；确认走同一 token/冻结管线，写入既有组。
- `derive`：预勾选 = 源组 member 仓库集合；每仓库基准覆盖为源组对应 member 分支（源组不含的仓库被勾选时回落该仓库基准，§6.2）；名称默认 `源名-2`（§14 开放问题 1 按 PRD 钦定的"追加短后缀"闭环），预览照常可见。

### D. scope 演进提示的呈现（§14 开放问题 2）—— 建议组行内联注记

Add repo 后"运行中的会话尚未包含新加入的仓库"：

**建议**：组行内联注记（member summary 级别一条，如 `2 running sessions predate the added repository`），而非 session 卡片徽标——同一事实在 N 张卡片上重复是噪音；注记在 member 集合下一次变化或相关 session 全部重启后消失。

### E. 历史 session 标记的载体 —— 建议派生而非持久化

"工作目录已删除，无法直接恢复"标记：

**建议**：Chats 历史行基于"member worktree 路径是否仍存在"实时派生该标记；持久化标记会与物理状态漂移（用户手动重建目录后标记不会自己消失）。删除确认框的受影响计数按 member worktreeKey 查询活跃 + 历史 session（复用 M1 历史对话查看的查询机制）。

## 3. 实施批次

每批独立可验证、独立提交 + 能力审计；沿用 M2 纪律：`npm run test-compile` + focused tests + 浏览器测试 + `git diff --check`，新行为契约随批交付。

| 批次 | 内容 | 说明 |
| --- | --- | --- |
| 批 1 | member 详情展开 UI + 重命名 | UI 基础：member summary 变为可展开（路径 / 分支 / 状态 / member 级操作挂载点）；组行 ⋯ 加"重命名"（内联编辑，参考 todo 组重命名） |
| 批 2 | 组级删除 + member 级移除 | M3 价值核心（承诺 4）：内联确认卡、全量预检门禁、逐成员执行（partial 不回滚、残余 ready + 失败标记 + Retry）、脱离 member 双动作、历史 session 计数与派生标记、member 级"从组中移除此 worktree"（含移除 primary 的前置选择与末 member 组消失）。最大批次，拆 host 侧 / webview 侧两个实现提交 |
| 批 3 | 派生 | 表单 derive 模式（决策 C） |
| 批 4 | Add repo + scope 演进注记 | 表单 add-repo 模式（决策 C）+ 组行注记（决策 D） |
| 批 5 | 任意 Adopt / Merge | Unmanaged 按 slug 聚类为建议组 + Adopt 勾选确认卡；Merge 去 slug 限制、member 勾选并入、survivor / primary 确认；冲突阻断沿用 |

拟新增行为契约 ID：`WORKTREE-GROUPS-RENAME-001`、`WORKTREE-GROUPS-DELETE-001`、`WORKTREE-GROUPS-DERIVE-001`、`WORKTREE-GROUPS-ADD-REPO-001`、`WORKTREE-GROUPS-ADOPT-MERGE-001`。

## 4. PRD v6 修订点（决策确认后回写）

1. §6.4：删除确认框明确为 webview 内联确认卡（决策 A）。
2. §4.2：状态机补注 `deleting` 为易失态，重启后对账由 discovery missing/prunable 兜底（决策 B）。
3. §6.2 / §6.3：派生与 Add repo 明确复用内联创建表单的 derive / add-repo 模式（决策 C）。
4. §6.3：scope 演进提示定为组行内联注记（决策 D），§14 开放问题 2 闭环。
5. §6.4：历史 session 标记为基于路径存在性的派生呈现（决策 E）。
6. §14：开放问题 1 闭环（派生默认名追加短后缀）。
7. §10：结构图补 member 详情展开形态与删除确认卡。

## 5. 已识别的风险与对应

| 风险 | 对应 |
| --- | --- |
| 组级删除是首个破坏性多步操作，执行期竞态（session 在门禁后启动） | 执行前逐 member 复检（现有单 worktree 流程已有 `getBlocker` 二次检查，沿用）；竞态命中即按 partial 处理，不回滚 |
| 删除确认卡与创建表单同时打开的交互 | 确认卡与表单互斥（同类单实例语义，复用 M2 的表单单实例机制） |
| Add repo / 派生绕过 preview 安全管线的诱惑 | 强制复用同一 confirm/token 管线，协议层拒绝无 token 的补建请求 |
| 任意 Merge 的 primary 语义 | 保留组 primary 存续；source primary 转移后仅为普通 member；target 无 ready primary 时走现有"重新选择 primary"提示 |
| member 详情展开增加行高复杂度 | 沿用现有折叠机制与 collapse-all；170px 最小宽度用例纳入浏览器测试（沿用 M2 教训） |
