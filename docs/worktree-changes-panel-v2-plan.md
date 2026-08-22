# Worktree Changes Panel v2 实施计划

日期：2026-08-22（v1.2，经技术准确性 / 完整性 / 流程合规 / 协议与可实现性四路评审修订）

状态：待 owner 确认后开工。本文是 `docs/worktree-changes-panel-prd.md` **Part II（§10–§19，v4.1）** 的实施拆解；行为口径、降级纪律、验收标准一律以 PRD 为准，本文不重复定义，只回答"怎么落地、按什么顺序、每步怎么验证"。

范围：**PR-0（前置缺陷修复）** → **PR-A（头部 + Files 完成态）** → **PR-B（Commits tab）**。按 AGENTS.md 规矩在同一 worktree 分支上串行切 PR，后者等前者合并后 rebase 再开。

v1.1 → v1.2 修订摘要：新增 PR-0（Task result untracked 现存缺陷修复）；Commits 协议补齐四类消息（open-file/review）+ requestId 双重丢弃；分页模型按 PRD §14.3 新版落地（sectionComplete、Earlier 从 baseline 祖先继续）；补全 Host 接线面（index.ts 导出、composition 注入、controller 四类 handler、单文件 diff 函数、viewer.ts 分发）；行 1 改"可见 label + 透明 select 覆盖层"；tooltip 改 JS overlay 基础设施；Files 滚动记忆前移 PR-A；320px 推荐改双状态位；tracking 采集改四命令事实查询链。

## 1. 实施纪律（全程适用）

- **RED → GREEN**：先写锚定新行为的失败测试，再改生产代码。每个新测试开工前指认其 CI 路径（unit/contract → `test:deterministic` → `test:ci:linux`；browser → `test:browser:run` → `test:ci:linux`）——本地可跑的孤儿测试不算 CI 覆盖（skill: fixing-regressions-with-ci）。
- **commit 自洽**：Host markup ↔ Webview script 契约对（元素、消息、校验）必须在同一个 commit 内；锚定旧 DOM 的 browser 断言随 DOM 改动同 commit 重写，不留红 commit。
- **双份镜像（泛化）**：canonical 源是 `src/webview/*.js`，`media/*.js` 是 gulp 再生镜像；先改 src/webview，`npx gulp --production` 再生后 `diff` 双份确认。WEBVIEW-ASSET-IDENTITY-001 对 `src/webview/*.js` **全量自动枚举**，本计划触及的 conversationChanges / conversationViewer / conversationSidebar 三个脚本均受约束。
- **webview 闭世界登记**：新增/变更任何 `window.*` / `globalThis.*` 符号、跨脚本 producer→consumer 关系或加载顺序时，**同 commit** 更新 `docs/testing/architecture-webview-manifest.json`，验证跑 `npm run test:architecture-policy`（checkWebviewManifest 闭世界：未声明即 CI 红）。
- **样式链路**：面板样式只改 `media/conversationViewer.scss`，`npx gulp --production` 一次性构建（dev 模式进 watch 不退出），编译产物 `media/conversationViewer.css` 已入库、与 scss 同 commit；构建后 grep 产物确认新选择器存在且未误配嵌套。tooltip overlay 的样式新建在 conversationViewer.scss（不进手写 telemetry css）。
- **tooltip 伪元素纪律**：带 tooltip 的元素不要用 `::before/::after` 画装饰（chevron、徽标）；装饰用 `box-shadow`/`outline`（skill: resilient-webview-mutation-protocols）。
- **无 capability audit**：该机制已在 PR #309 剪除，`main-capability-coverage.json` 为历史记录，不要新增 audit 提交。
- **行为契约登记**：新行为进 `docs/testing/behavior-contracts.json`——文本定向编辑（防整文件格式化 churn）；新条目沿用现有 ID 体系与 `domain` 约定，automated owner 文件须含字面 ID；重写 WORKTREE-CHANGES-PANEL-001 断言时保持 ID 稳定。
- **PR 门禁**：默认开 **draft**；每个 `gh` 命令带 `--repo hzcheng/agent-pivot`；PR body 必带 `## Skill harvest` 与 `## Owner approvals`（`approve <full-head-sha>` 就绪命令，`check-pr-body.js` 强制）；head 移动后**先改 body 再 push**；建/更新 PR 后核验 mergeable + checks 在跑，不留 conflict/red；合并需 owner 在 PR 页面对当前 head 发批准评论 + 对话内明确指示；`gh pr merge --merge` 不删远程分支。

## 2. PR-0（前置缺陷修复，独立小 PR）

对应 PRD §19 PR-0。现存缺陷：Task result 排除 untracked（`taskFileCount` 只跑 `git diff --name-only <baseline>`；`openTaskResultReview` 同口径），与 Part I §4.3 包含关系承诺矛盾。

| WI | 内容与 DoD | 主要文件 | 测试 |
| --- | --- | --- | --- |
| Z1 | **taskFileCount ∪ untracked**：task 文件数 = `git diff --name-only -z <baseline>` 与 porcelain status 中 untracked 路径的并集计数 | `src/worktrees/changesCollector.ts` | `tests/unit/worktrees/changesCollector.test.js` + `tests/contract/worktrees/changesCollector.test.js`（真实 git fixture：untracked 文件计入、已跟踪文件不重复计） |
| Z2 | **Review 包含 untracked**：`openTaskResultReview` 文件列表同上并集；untracked 的 original 侧用 EMPTY_REF（与 deleted 的空侧模式一致） | `src/services/gitChangesDiff.ts` | `tests/unit/services/gitChangesDiff.test.js`（untracked 三元组形状、不影响 tracked 行为） |

建议单 commit：`fix: include untracked files in task result counts and review`。

## 3. PR-A 工作分解（头部 + Files 完成态）

对应 PRD：§14.1/§14.2/§14.4（数据面）、§15.1–§15.3、§15.4（仅摘要区两行部分）、§15.6、§16（Files 相关行）、§17（Files 部分 + tooltip 基础设施）。前置：PR-0 已合并。

| WI | 内容与 DoD | 主要文件 | 测试 |
| --- | --- | --- | --- |
| A1 | **tracking 数据贯通**（四命令事实查询链）：`symbolic-ref -q HEAD`（空 = detached → none）→ `for-each-ref --format=%(upstream) <branchRef>`（成功且空 = none；失败/超时 = unknown）→ `rev-parse HEAD <fullRef>`（单进程取 headSha + upstream sha）→ `rev-list --left-right --count <fullRef>...HEAD`（左=behind 右=ahead）；**三态判别联合** `tracked / none / unknown`（§14.4）；`headSha?` unreadable 缺省；member 视图同步 3 处 + 双份镜像 | `src/worktrees/changesCollector.ts`、`src/aiSessions/conversation/types.ts`、`conversationChangesController.ts`、`src/webview/conversationChangesScripts.js`（+media 镜像） | unit + contract（真实 git fixture：tracked/none/unknown/detached HEAD、diverged）、`conversationChangesController.test.js`、`tests/integration/dashboard/conversationViewer.test.js`（member 视图字段断言同步） |
| A2 | **头部 markup + 样式**：行 1（‹ › + **可见 repo label + 透明原生 select 覆盖层**（select 绝对定位、opacity 0、宽 100%；option 文案维持 `repo · ⎇ branch` 并保留 `(outside workspace)` 后缀）+ `(i/n)` + detached 独立小字元素）、行 2（分支独占 + `(no branch)` 兜底 + ⟳ + **Source Control 图标**）、行 3 中间态（仅右侧 action slot）；单 member 渲染普通文本标题（非 disabled select）；scss → 编译 css 同 commit | `src/aiSessions/conversation/viewerDocument.ts`、`media/conversationViewer.scss`（→ `media/conversationViewer.css`） | browser 测试重写（见 A9）；覆盖层点击穿透/聚焦/assert select 值同步 |
| A3 | **头部行为**：‹ › 循环（复用 `conversation-viewer-changes-select`）、位置指示 + aria-live、单 member 退化、跨 member 提示升级（`N more changes in … · Go to <repo>`；**计数与跳转候选同集合 = readable（`availability !== 'unreadable'`）**；点击目标 = 固定顺序下一个 `workingItemCount > 0` 的 readable member）、分支行渲染（中间省略 + tooltip）；**window.* 符号变更同步 architecture-webview-manifest** | `src/webview/conversationChangesScripts.js`（+镜像）、`src/webview/conversationViewerScripts.js`（+镜像，create 句柄）、`docs/testing/architecture-webview-manifest.json` | browser 测试（循环/wrap/(i/n)/退化/提示行文案与点击目标/readable 口径、**完整 Tab 序 + ‹ › 焦点驻留连续 Enter**） |
| A4 | **Files 摘要区两行**：`Since start · N files · M commits` + `Tracking <upstream> · N ahead · M behind` / `No tracking branch` / `Tracking unknown`（与 A1 三态一一对应）；样式纪律：`No tracking branch` 中性 `descriptionForeground`，不用 warning 色 | `src/webview/conversationChangesScripts.js`（+镜像）、scss | browser 测试（三态文案） |
| A5 | **组头可折叠 + Collapse/Expand All + Files 上下文记忆**：组头改 button（chevron + 标题 + item 计数 + aria-expanded）、`collapsedGroups` 内存态、两个全局按钮（VS Code 图标 + tooltip overlay）、无改动空态禁用；**每 member 折叠态 + 滚动位置记忆（PRD §15.2，PR-A 即完成态）** | `src/webview/conversationChangesScripts.js`（+镜像）、`viewerDocument.ts`、scss | browser 测试（组头折叠、全合/全展、**切 member 再切回折叠态与滚动位置保留**、resetSession 清空） |
| A6 | **Files 内容区键盘模型**：roving tabindex、↑↓/←→/Home/End/Enter/Space 全规则、焦点恢复（刷新失焦落同级/父级、Collapse All 落组头） | `src/webview/conversationChangesScripts.js`（+镜像） | browser 测试（逐键行为 + 焦点恢复） |
| A7 | **首开 320px 推荐（双状态位）**：新增 `widthUserResized`（新代码首次持久化写 false，仅拖拽 handler 置 true）+ `changesWidthRecommendationApplied`；首开 Changes 且 `widthUserResized === false && !applied` → 320 并置 applied；存量用户（标志位 undefined）不触发；其余视图默认 240 不变 | `src/webview/conversationSidebarScripts.js`（+镜像） | browser/unit（新 state 推荐/拖拽后不推荐/存量 undefined 不推荐 三路径） |
| A8 | **tooltip overlay 基础设施（新组件）**：面板级 JS 控制器——单一节点挂 body、`position: fixed`、`data-tooltip` 驱动、hover/focus 触发、Esc/blur/滚动/面板关闭关闭、`aria-describedby` 关联；**替换现状 ⟳/SCM 按钮的原生 `title`**；徽标语义折叠进行级 `aria-label`；window.* 符号同步 manifest | 新模块（`src/webview/conversationTooltipScripts.js` 或并入现有脚本，实现时按 manifest 最小化原则定）+镜像、`src/webview/conversationChangesScripts.js`（+镜像）、`docs/testing/architecture-webview-manifest.json`、scss | browser 测试（hover/focus 展示、Esc 关闭、**滚动区顶/底与 192px 无裁剪**、aria-describedby 关联） |
| A9 | **测试重写与登记（残余兜底）**：WORKTREE-CHANGES-PANEL-001 锚定旧 DOM 的 5 个测试（L12232/12359/12401/12457/12496 区域）**随 DOM 改动同 commit 重写**；本项仅兜底契约登记 + 截图扩展；`scripts/dev/changes-panel-screenshot.js` 扩展 320px 档（现仅 240/192） | `tests/browser/conversationViewer.test.js`、`docs/testing/behavior-contracts.json`、`scripts/dev/changes-panel-screenshot.js` | — |

**建议 commit 切分（5 个，自前而后依赖）：**

1. `feat: surface tracking-branch state in changes members` — A1（纯数据面 + 校验，无 UI 消费）。
2. `feat: add focusable tooltip overlay for conversation panels` — A8（基础设施先行，含现状 `title` 迁移；后续 commit 直接消费）。
3. `feat: two-row worktree header with repo cycling` — A2+A3+A4（契约对同 commit；锚定 DOM 断言同 commit 重写）。
4. `feat: collapsible change groups, collapse all, and per-member files context` — A5+A6（组头是键盘节点，必须同 commit）。
5. `feat: recommend 320px on first changes-panel open` — A7+A9 收尾。

**PR-A 中间态验收**（PRD §19）：行 1/行 2 最终结构就位；行 3 仅右侧 action slot（Collapse/Expand All 需要这一行，不留空行）、无子 tab 控件，Files 为唯一视图；⟳ 单路重采是正确中间态（commits 尚不存在，双路改造在 B5b）；markup/样式/测试按最终结构一次到位，PR-B 不重写。

## 4. PR-B 工作分解（Commits tab）

对应 PRD：§14.3/§14.4（协议面）、§15.4（子 tab 框架）、§15.5、§16（Commits 相关行）、§17（Commits 部分）。前置：PR-A 已合并。

| WI | 内容与 DoD | 主要文件 | 测试 |
| --- | --- | --- | --- |
| B1 | **协议（四类消息 + 完整 schema）**：`commits-list` / `commit-detail` / `commit-open-file` / `commit-review`；请求带 `version` + `requestId`，响应回传 `requestId` + `subscriptionGeneration`；webview→host 校验在 viewerProtocol.ts；**host→webview 响应校验在 webview 脚本**（§14.3 第 5 条全部上限 + degraded 五枚举白名单）；`viewer.ts` 四条分发分支 | `viewerProtocol.ts`、`src/aiSessions/conversation/viewer.ts`、`types.ts`（CommitSummary/CommitFile/BaselineRow/CommitsDegraded）、`src/webview/conversationChangesScripts.js`（+镜像，响应校验器） | protocol 单测（正反例含 requestId/offset/historyHead/degraded 枚举） |
| B2 | **commits 采集器 + Host 接线**：新增 `src/worktrees/commitsCollector.ts`（since-start 分页 `--max-count=51 --skip` 于 `<baseline>..<historyHead>`、`sectionComplete` + `baselineRow`、Earlier 段从 `<baselineSha>` 祖先续页、historyHead 回传比对 → `history-moved`、inTrackingBranch 集合、明细双 diff-tree 命令、5s 超时独立降级）；`src/worktrees/index.ts` 导出；`conversation/composition.ts`（或 dashboard.ts 对应组合根）实例化注入；`conversationChangesController.ts` 新增四类 handler（解析 member、校验 sha/member、调 collector/diff、发送响应与降级）；**新文件补进 `architecture-modules.json` worktrees infrastructure role** | 见左 + `src/worktrees/index.ts`、`conversation/composition.ts`、`conversationChangesController.ts`、`docs/testing/architecture-modules.json` | unit + contract（真实 git fixture：merge commit、root commit、rename `-z` old-path-first、分页 hasMore/sectionComplete、history-moved、baseline 缺失/改写） |
| B3 | **diff 打开链路**：`openCommitFileDiff`（单文件 parent↔commit；root commit 与 added/deleted 侧用 EMPTY_REF；merge 按 first parent；binary/submodule 明确跳 SCM）；`openCommitReview`（multi-diff，共享 GitDiffContentProvider / 三元组 / capability fallback；`MAX_DIFF_FILES=400` 上限与 `totalFiles` 诚实展示）；open-file/review 前 `cat-file -e` 验证，unknown-commit → host toast + 推送刷新 | `src/services/gitChangesDiff.ts`、`conversationChangesController.ts`（接线） | `tests/unit/services/gitChangesDiff.test.js`（**root/rename/added/deleted/binary/submodule 六态** + 400 截断） |
| B4 | **子 tab 框架**：`Files | Commits` 分段控件（tablist/tab/tabpanel/aria-selected、←→ automatic activation；装入行 3 左槽后 **Tab 序插入子 tab 停靠点**，PR-A 的 Tab 序断言需可扩展）；`conversationSidebar.changesSubTab` 持久化（新增键向后兼容）；**Commits 态下 action slot 保留宽度、隐藏折叠按钮内容**（§15.3）；window.* 变更同步 manifest | `viewerDocument.ts`、`src/webview/conversationChangesScripts.js`（+镜像）、`src/webview/conversationSidebarScripts.js`（+镜像）、`docs/testing/architecture-webview-manifest.json` | browser（tab 切换、键盘、reload 恢复、Commits 态折叠按钮隐藏） |
| B5a | **Commits 渲染与交互**：标题区两行；commit 行（徽标矩阵 + aria-label 折叠语义）；行内展开 + numstat（行内 loading、明细失败行内 `Failed · Retry`、**`Showing 400 of N files`**）；`Load more` / `Load earlier commits`（加载中禁用 + 行内 spinner）；**baseline 行仅 sectionComplete 时渲染**；baseline 缺失 → `Current branch history` 单流 + 说明条、无 Show full 按钮；列表级 loading；切 member 即清 | `src/webview/conversationChangesScripts.js`（+镜像）、scss → css | browser（逐子项断言） |
| B5b | **失效、记忆与状态反馈**：失效签名五元组比对 + 静默重取（不抢焦点）；**⟳ 双路重采**（§14.3 第 1 条）；**requestId + generation 双重丢弃**（§14.3 第 4 条：同 member 旧响应不得覆盖新刷新；迟到的跨 member/跨 session 响应丢弃）；Commits 滚动位置与展开项按 member 记忆；scope 按 member 恢复；`history-moved` → 回首行重取 | `src/webview/conversationChangesScripts.js`（+镜像） | browser（**ahead 不变但 upstream 变化也重取**；⟳ 双路；旧 requestId 响应丢弃；切 member 无残留） |
| B6 | **Commits 键盘行为**：§17 模型在 Commits 列表的实例化（commit 行 = 可展开节点，文件行 = 叶子） | `src/webview/conversationChangesScripts.js`（+镜像） | browser |
| B7 | **契约登记 + 截图**：behavior-contracts 登记；192/240/320px 自动截图含 Commits 态（420px 档留人工 dogfooding） | `docs/testing/behavior-contracts.json` | — |

**建议 commit 切分（3 个）：**

1. `feat: commits data channel for worktree changes panel` — B1+B2+B3（host 数据面 + 校验先行 + 单测；webview 尚未消费是 PR 内可接受中间态）。
2. `feat: commits tab with inline file changes` — B4+B5a+B5b+B6（契约对同 commit + browser 测试）。
3. `test: register commits-tab behavior contracts` — B7（契约登记 + 截图验证）。

## 5. 验证矩阵

每个 PR 提交前按序执行（凡清理/重建 `out/` 的命令先于消费 `out/` 的检查；长套件用后台任务 + 显式 timeout）：

| 步骤 | 命令 | 时机 |
| --- | --- | --- |
| 编译 | `npm run test-compile` | 每个 commit 前 |
| 焦点测试 | 本 WI 对应测试文件（见上表） | 每个 commit 前 |
| Webview 检查 | `node scripts/run-dashboard-webview-checks.js` | 涉及 media/ 的 commit |
| 架构策略 | `npm run test:architecture-policy` | 触碰 window.* / 加载顺序 / architecture-modules.json 的 commit |
| Lint | `npm run lint` | 涉及 ts 的 commit |
| 行为契约 | `npm run test:behavior-contracts` | **含契约变更的 commit 前** + push 前 |
| 空白检查 | `git diff --check` | 每个 commit 前 |
| 渲染验证 | `node scripts/dev/changes-panel-screenshot.js <outDir>`，192/240/320px 三档目检（420px 留人工 dogfooding） | UI 变化的 PR 收尾 |
| 覆盖率门 | `npm run test:coverage:ci`（或 `npm run test:coverage:run && node scripts/check-changed-coverage.js`；需先 fetch origin/main 或设 `COVERAGE_DIFF_BASE`） | PR 前 |
| 分支级 CI 等价 | `npm run test:ci:linux`（后台任务 + 足量 timeout） | PR 前 |

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| browser 测试锚定旧 DOM（5 个测试、多处断言 + fixture 搭建） | PR-A 最大隐性工作量 | RED 先行；断言随 DOM 改动同 commit 重写（契约对纪律优先），A9 仅兜底 |
| 双份镜像漏改一边（含 conversationViewer/conversationSidebar/新 tooltip 模块） | CI WEBVIEW-ASSET-IDENTITY-001 红；测试与运行时行为分裂 | 先改 src/webview、gulp 再生、提交前 diff 双份 |
| window.* 闭世界未登记 | CI checkWebviewManifest 红 | A3/A8/B4 同 commit 更新 architecture-webview-manifest + `test:architecture-policy` |
| scss 锚点误配；tooltip 伪元素串样式 | 样式错乱且测试不一定抓到 | 构建后 grep 编译产物；装饰不用 ::before/::after；截图目检 |
| tooltip overlay 是新组件（定位/滚动关闭/焦点管理） | 实现复杂度与边界 bug | A8 独立 commit 先行；browser 测试覆盖滚动区顶/底 + 192px；不追求自动翻转等高级定位（钉在触发元素下方、越界钳制即可） |
| select 透明覆盖层的可测性 | browser 测试断言不到 opacity 0 的元素交互 | 断言 select 值同步 + focus 行为；视觉交叠由截图目检兜底 |
| tracking 采集每 member ≤4 个新增 git 进程 | 刷新延迟 | 并入现有采集周期与 5s 超时；独立降级（unknown）不影响 baseline 数字；P95 目标：tracking 增量 ≤150ms、commits 首屏 ≤300ms（dogfooding 实测，§18） |
| 失效签名/requestId 比对遗漏 | 陈旧 commits 列表（PRD 核心痛点） | B5b 测试显式覆盖"ahead 不变 upstream 变"、"旧 requestId 响应丢弃"、"⟳ 双路" |
| 截图脚本无 320px 档 | 验证矩阵无法执行 | A9 先扩展脚本再谈三档目检 |
| 老 Chromium 兼容 | 布局/语法不兼容 | 不引入超出现状用法的 CSS/JS 特性；无布局动画 |

## 7. 验收映射（PRD §18 dogfooding 清单 → PR）

| 验收项 | PR |
| --- | --- |
| Task result 数字与 Review 含 untracked（与 Working 一致） | PR-0 |
| 多仓库切换点击数、(i/n) 正确；跨 member 提示文案、readable 口径与 Go to 目标 | PR-A |
| 分支名 240/320/420px 可辨认（自动截图 192/240/320 + 420 人工）；192px/zoom/高对比无溢出 | PR-A |
| Collapse All 只剩组头；Expand All 还原；**切 member 再切回折叠态与滚动位置保留（Files）** | PR-A |
| 全键盘操作与读屏名称（Files）；Collapse All/刷新/切换后焦点恢复 | PR-A |
| tooltip overlay 无裁剪（滚动区顶/底、192px、头部按钮） | PR-A |
| Commits 监控静默更新与摘要同数；⟳ 双路重采；tracking 三态与 push/fetch 后刷新（失效签名）；P95 实测 | PR-B |
| commit → diff / Review；边界提交（baseline 缺失/rewritten/merge/root）；400-of-N 诚实展示；分页期间 HEAD 变化 → history-moved 重置 | PR-B |
| 键盘与焦点恢复（Commits）；192px/zoom/高对比（Commits） | PR-B |

注：PRD §18 的截断全文验收以 tooltip overlay 为准（不查原生 `title`）。

## 8. 开工前检查单

1. 本计划 v1.2 与 PRD v4.1（含第五轮修订）经 owner 确认；
2. worktree 内 `npm ci` 已跑（npm 会从主 checkout 静默解析二进制）；
3. 分支基于最新 `origin/main`（先 fetch + rebase）；
4. **PR-A / PR-B 前置**：前一 PR 合并后 rebase → **重跑 `npm ci`** → 按 §5 矩阵全量重验后再 push（不发布 rebase 前构建的产物）；
5. 若实施中新增 package.json script 或改变 AGENTS.md 所列命令语义，触发 AGENTS.md 更新义务；
6. 按 §2 从 Z1 的 RED 测试开始。
