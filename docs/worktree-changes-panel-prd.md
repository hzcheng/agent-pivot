# Worktree Changes Panel（会话内改动查看）PRD

日期：2026-08-17（v3，第二轮 subagent 产品评审后修订）

状态：v1 经五轮批注闭环；v2 吸收第一轮评审（双层模型、SCM 口径、baseline 契约、解析路径）；v3 吸收第二轮评审，修正五个实现前必须修复项（净结果语义、baseline 捕获事务、聚合完整性三态、解析顺序、刷新正确性）并砍减 P0 范围。**v3 确认后可进入 P0 实现。** 依赖的 worktree 组模型见 `docs/worktree-tasks-prd.md`。

## 0. 核心产品承诺

本方案收敛为四句话，后续所有章节都是展开；任何实现决策与这四句冲突时，以这四句为准：

1. **改动信息属于 AI Conversation 视图，不进 open tab 卡片。** 入口是 telemetry 条的 Changes 按钮，详情是右侧边栏的 Changes tab。
2. **面板呈现"相对 task 起点的当前净结果"（Task result）及其中"当前未提交的子集"（Working changes）。** 两者是包含关系而非并列关系；Task result 是 `baseline → 当前工作树` 的净差异，不承诺还原"历史上碰过的所有文件"。
3. **Working changes 的分组、状态字母与点击行为对齐 VS Code Source Control**（Merge / Staged / Changes / Untracked 四组）；Task result 是本产品自有的视角，不承诺与 SCM 角标数字一致；未知状态显式标注，绝不把未知显示为 0。
4. **面板只读。** 暂存、提交、回滚仍在 Source Control 完成；本面板回答"这个 task 现在变成了什么样、要不要去看"，并提供一键深入（diff / multi-diff / SCM）。

## 1. 背景

Worktree 组模型上线后，一个 task（组）对应一到多个物理 worktree，agent session 在组内写代码。当前用户要知道"这个 session 的 task 改了什么"，唯一路径是记住 worktree 路径、打开对应窗口、看 Source Control——三个断点：

1. **conversation 视图内零信号。** 正在对话时完全看不到 agent 落盘的进展（改了几文件、几个 commit）。
2. **跳转成本高。** 需要离开当前窗口，打断"监控多个 session"的核心场景。
3. **Source Control 的排版不满足监控视角。** 它面向编辑设计：仓库平铺、无 task 层级、无"相对 task 起点"的视角。用户原话："source control 如果能排版好一些，完全满足我的要求，但是它的排版不好"。

已确认的用户数据假设（沿用 worktree-tasks PRD）：跨仓库工作集是少数，多数组只动一个仓库。

### 1.1 两轮评审修订概要

- v1 → v2：单层 Working changes 会把"agent 已提交完成工作"误表达为"No changes"，引入双层；SCM 对齐承诺收敛；补 baseline 字段与权威解析。
- v2 → v3：双层实为包含关系（净结果 ⊃ 未提交子集），文案与聚合口径按此重写；baseline 补捕获事务与失败补偿；聚合引入完整性三态；解析顺序补 retired 环节；刷新模型换成可证明正确的事件驱动方案；P0 范围砍半。

## 2. 目标

- 在 conversation 视图内一眼回答：**这个 task 相对起点变成了什么样 → 其中还有什么没提交 → 要不要介入看细节**。
- 与 telemetry 条现有按钮（position / comments / subagents）的交互同构，不引入新的 UI 范式。
- Working changes 与 SCM 面板并列使用时状态语义不打架；Task result 提供 SCM 没有的 task 起点视角。
- 单仓库窗口下信息密度与操作路径不退化。

## 3. 非目标与已知限制

- 不做暂存、提交、discard、回滚等任何写操作；面板永远只读。
- 不做跨 session / 跨组的改动聚合视图；面板严格跟随当前打开的 session；**跨 member 统一 Review all 不在 P0**（§5.3）。
- 不做自研 diff 渲染增强；单文件 diff 与 Review 均复用 VS Code 原生 diff / multi-diff editor。
- 不做 SCM provider（不把 task 改动注入 Source Control 面板）；不展示 stash、不展示 base 分支自身的提交列表。
- 不归因：Task result 包含 setup 脚本、用户、agent 产生的全部变化，产品口径是"这个 task worktree 的变化"，**不是"可归因于 agent 的变化"**。
- **已知限制：worktree 已被物理删除的 retired session 无改动数据**，面板降级为提示态（§7.3）。
- **已知限制：Adopt / 历史 worktree 无法证明 task 起点**时，Task result 显示 "Baseline unavailable"，不用猜测值冒充（§4.3）；未来可提供显式"选择 baseline"能力，不在 P0。

## 4. 核心概念与数据模型

### 4.1 session → 改动集合的权威解析（v3 修正顺序）

权威解析规则（验收标准，顺序不可交换）：

1. 读取 session 持久化的 `worktreeKey`（runtime binding / hydration 结果）；session 运行中 agent 临时 `cd` 产生的工具调用 cwd **不得**覆盖此身份。
2. 用该 key 查当前 manifest：命中则改动集合 = 该组全部 `ready` member（`worktreeKey` 存在者）。
3. manifest 未命中 → 查 **retired identity**（含 generation 判断）：命中则走 retired 降级（§7.3）。
4. 无持久化身份时，用 session 初始 `cwd` 经 `ConversationWorktreeResolver` 做 live fallback：解析出则走**退化单 member 视图**。
5. 以上皆无（非 git 会话）：按钮 `hidden`。

跨平台与键值契约（实现前必须修复的现存缺陷）：

- `ConversationWorktreeResolver` 当前只接受 `/` 开头路径，须支持 Windows 绝对路径；
- resolver 必须返回完整 `WorktreeKey`（`repositoryKey` = canonical common git dir，与 manifest 键同源；`canonicalWorktreePath` 规范化），其现返回值 `repoRoot = dirname(commonDir)` 与 manifest 键不一致，不能直接用于比对。

组被 Merge / Adopt 后，历史 session 跟随其 worktreeKey 当前所属的组（与 Worktrees 面板同一权威来源）；此时面板定位为"**当前 task group 的现状**"，不暗示"这个 session 当时写了什么"。

### 4.2 baseline 数据契约与捕获事务（v3 重写，P0 前置）

每个 member 持久化结构化 baseline：

```ts
interface MemberBaseline {
  commitSha: string;           // 冻结的 base commit SHA
  capturedAt: number;
  source:
    | { kind: 'branch'; fullRef: string }   // fully-qualified,可前进
    | { kind: 'tag'; fullRef: string }      // 固定起点
    | { kind: 'commit' };                   // detached,无可移动 base
}
```

捕获事务（与 provisioning 顺序绑定）：

1. 创建确认时先解析 `baseRef^{commit}` 得到精确 SHA；annotated tag 解到 commit。
2. **在任何物理副作用前**，将 SHA 与 provisioning intent 一起持久化。
3. `git worktree add` 使用冻结的 SHA，不使用可能继续移动的短分支名。
4. worktree 创建后、setup 前校验 `HEAD === baseline.commitSha`。
5. baseline 与 `worktreeKey` 一起 checkpoint；member 进入 `ready` 不得丢失已捕获的 baseline。
6. SHA 解析或 intent 持久化失败：**不开始创建**。
7. worktree 已创建但后续持久化失败：进入 retryable partial，**禁止用当前 HEAD 反猜 baseline**。
8. recovery 记录也丢失：worktree 保留可用，永久标记 `baselineUnavailable: 'capture-failed'`；不阻塞使用，不伪造起点。

source 语义：

- branch：保存 fully-qualified ref；base-moved / behind（P1）以此为据。
- tag：固定起点；tag 被强制移动时仅提示 source changed，不用 branch 的 behind 文案。
- commit（detached）：无可移动 base，永不展示 behind / base moved。
- Adopt / 存量 member：无可靠起点，baseline 缺省，Task result 层降级（§3）。
- 刷新时校验 `merge-base --is-ancestor baseline HEAD`；失败即 "History rewritten"，不给出貌似精确的数字；切到无关历史的 branch 同样处理。
- Merge group 后每个 member 保留各自 baseline，聚合文案只能是 "since each worktree baseline"。

### 4.3 MemberChangeSummary 与聚合完整性（v3 新增三态）

单 member 状态机：

```ts
type MemberAvailability =
  | 'available'            // 可读且 baseline 有效
  | 'baselineUnavailable'  // 可读但无 baseline(Adopt/存量/capture-failed)
  | 'historyRewritten'     // baseline 不再是 HEAD 祖先
  | 'unreadable';          // 物理缺失/unsafe/git 不可用
```

跨 member 聚合完整性：

```ts
type AggregateCompleteness = 'complete' | 'partial' | 'unavailable';
```

按钮与 tooltip 的展示规则（未知 ≠ 0）：

| 场景 | 按钮 | tooltip 说明 |
| --- | --- | --- |
| 完整 | `3 · ↑2` | 常规逐 member 分解 |
| ahead 部分未知 | `3 · ↑?` | `2 commits known; baseline unavailable for 1 repository` |
| working 部分不可读 | `3+ · ↑2` | 标注 partial 与不可读 member 数 |
| baseline 全部不可用、working 可读 | `3 · ↑—` | Task result 层整体降级 |
| 全部不可读 / retired | 禁用态 | 说明原因，不显示 0 |

单 member 采集字段：

| 字段 | 含义 | 采集方式 |
| --- | --- | --- |
| `workingItemCount` | 四组 SCM resource 行数之和（同文件 staged+unstaged 计两项） | 自采集 `git status --porcelain=v1 -z --untracked-files=all` 按 XY 列分类 |
| `workingFileCount`（可选） | 按路径去重的真实文件数 | 同上推导 |
| `aheadCount` | 相对 `baseline.commitSha` 的 commit 数 | `git rev-list --count <baseline>..HEAD`；文案为 "branch history since baseline" |
| `taskFilesCount` | Task result 净文件数 | `git diff --name-only <baseline>` 与 working tree 变化的并集计数（详情采集时） |
| `behindCount`（P1） | 相对 `baseRef` 当前位置落后数（仅 source=branch） | `git rev-list --count HEAD..<baseRef>` |
| `lastCommit`（P1） | HEAD subject + 时间戳 | `git log -1 --format=%s%n%ct` |

术语纪律：按钮可用 item count，但 tooltip 必须写 "N uncommitted changes"，**禁止写 "N files"** 指代未提交项。

详情级（懒加载，仅当前选中 member）：`workingFiles[]`（四组文件行，porcelain `-z` 解析保证空格/换行路径与 rename 正确）与 `taskFiles[]`（`git diff --numstat <baseline>` ∪ untracked）。

untracked 口径：面板**自采集**且固定 `--untracked-files=all`，不跟随 `git.untrackedChanges` 配置——保证"固定单独成组"承诺与用户 SCM 配置无关。Git API 的用途是事件订阅与 diff/SCM 衔接（§5.4），不作为四组数据真源（避免配置差异）。

### 4.4 按钮数字口径

- 双维度：`<workingItemCount聚合> · ↑<ahead聚合>`，按 §4.3 完整性规则降级为 `?` / `+` / `—`。
- working tree 干净但有提交：`0 · ↑2`，**绝不只显示 `0`**。
- 全干净：`0 · ↑0`，不隐藏（空间稳定性）；是否长期显示 `0 · ↑0` 由 §8 使用数据验证。
- 数字为全 member 聚合；面板内切换 member 不改变按钮数字。

## 5. 产品行为

### 5.1 入口：telemetry 条 Changes 按钮

位置：telemetry 条右侧按钮组，与 position / comments / subagents 并列（验收以名称与稳定标识为准，不依赖序号）。样式、尺寸、tooltip 机制（`conversation-telemetry-tooltip`）、`aria-pressed` 切换行为与现有按钮完全一致。

- **图标**：git branch 图标。与 telemetry 左侧已有 worktree 按钮（表示"我在哪"）职责区分；左侧按钮 tooltip 收敛为位置描述，去掉 "Click to show changes" 引导。
- **数字**：口径见 §4.4；aria-label 完整读出单位与 partial 状态（如 "3 uncommitted changes, 2 commits since baseline; 1 repository unreadable"）。
- **降级**：非 git 会话隐藏；部分 member 不可读时按钮保持可用并按 §4.3 标注；全部不可读 / retired 才禁用，不显示 0。
- **点击**：打开/聚焦右侧边栏并选中 Changes tab；`aria-pressed` 跟随。
- **可访问性**：tooltip 内容键盘可达；计数变化的 live-region 通知在 P1。

### 5.2 按钮 hover tooltip（多行）

```
Task result · 5 files, 2 commits since each worktree baseline
Uncommitted · 3 changes
api (fix-login) · 2 uncommitted · ↑2
web (fix-login-ui) · 1 uncommitted · ↑0
Base main has moved · ↓1 behind        ← P1
Last commit: "fix: token refresh race" · 2h ago   ← P1
```

单 member 时省略逐 member 行；partial 场景按 §4.3 表格追加说明行。

### 5.3 Changes 侧边栏面板

作为右侧边栏的一个 tab（与 outline / comments / subagents 并列），复用现有 tab 框架（`data-sidebar-tab`、面板状态持久化、resizer）。两层按**包含关系**呈现（v3 修正）：

```
┌─ Changes ─────────────────────────────┐
│ [api · ⎇ fix-login · 3 · ↑2      ▾]  │ ← member 下拉选择框
│ 3 changes in 2 other repositories     │ ← 多 member 聚合提示(仅部分场景)
│ ───────────────────────────────────── │
│ Task result compared with start       │
│   5 files · 2 commits                 │
│   Includes committed and uncommitted  │
│   [Review this repository]            │ ← 选中 member 的 baseline→工作树 multi-diff
│ Uncommitted now · 3 changes           │
│ ▾ Changes                             │
│    M  src/auth/login.ts               │
│    M  src/auth/session.ts             │
│ ▸ Staged Changes                      │
│ ▸ Merge Changes                       │
│ ▾ Untracked Changes                   │
│    U  src/auth/login.test.ts          │
│ ───────────────────────────────────── │
│ ● "fix: token refresh race" · 2h ago  │ ← P1
│ [Open this worktree in Source Control]│
└───────────────────────────────────────┘
```

行为明细：

- **member 下拉选择框**：每次只选一个 member。选项文案 = `repo · branch · <workingItemCount> · ↑<aheadCount>`。单 member 退化为只读标题。P0 默认选中 = 上次选择可用则恢复，否则 primary member；智能优先级（conflict → 有改动 → 有 ahead）与按 session 持久化的完整版在 P1。
- **跨 member 提示**：按钮聚合与当前 member 不一致时，面板顶部显示 "N changes in M other repositories"；"跳到下一个有改动的仓库"导航在 P1。
- **Task result 层**：选中 member 的净结果摘要（`N files · M commits`，注明 "Includes committed and uncommitted changes"）+ **Review this repository**（打开 baseline → 当前工作树的原生 multi-diff，经 `vscode.changes` 命令；capability 缺失时 fallback 为逐文件 diff 列表）。跨 member 统一 Review all 在 P1。baseline 缺失 / 历史改写时整层显示 "Baseline unavailable" / "History rewritten"。
- **Working changes 层**：固定组序 Merge → Staged → Changes → Untracked；空组折叠不渲染。
- **文件点击行为矩阵**（P0 验收标准）：
  | 状态 | 点击行为 |
  | --- | --- |
  | unstaged（Changes 组） | diff editor：`index ↔ working tree` |
  | staged（Staged 组） | diff editor：`HEAD ↔ index` |
  | 同一文件 staged + unstaged | 两行分别出现，各开各的 diff |
  | untracked | 直接打开文件（对齐 SCM，非空白 diff） |
  | conflict（Merge 组） | 打开与 SCM 相同的冲突入口（merge editor） |
  | rename | 显示 `old → new` |
  | deleted | 对齐 SCM 的删除 diff |
  | binary / submodule（P1） | P0 无法原生 diff 时明确跳 SCM；精细展示在 P1 |
  | 点击瞬间文件已消失 | toast 提示并触发刷新，不报错弹窗 |
- **点击文件一律在当前窗口打开，不跳窗口**。
- **Open this worktree in Source Control**：面板底部常驻按钮，在当前窗口经 Git API 打开该 worktree 仓库并聚焦 SCM 面板；不承诺精确 reveal 到该 repository（现有实现约束），不定义跨窗口聚焦。
- **空态**：选中 member 无 working 且无 task result 时显示 "No changes"，面板不隐藏。
- **last commit 行（P1）**：HEAD subject + 相对时间。

### 5.4 刷新策略（v3 重写：正确性优先）

P0 采用可证明正确的事件驱动方案，自定义 watcher 优化后置：

- **主通道**：订阅 VS Code Git API `Repository.state.onDidChange`（覆盖 commit、stage、工作区文件编辑等全部状态变化）。
- **强制刷新时机**：面板首次打开、重新获得可见性、切换 session 时。
- **手动 Refresh**：面板右上角常驻。
- **无 Git API 可用的 fallback**：短 TTL 缓存 + 面板可见时到期刷新（不是"仅失效才刷"）。
- **P1 优化**：自建 common git dir / worktree watcher（注意 linked worktree 的 `.git` 是文件，真实 HEAD/index 在 common dir 下，须 `git rev-parse --git-common-dir` 解析）、working/HEAD/base 分类缓存失效、精细 Stale 状态机。
- **保护**：git 命令超时、取消旧请求、session 切换丢弃在途结果；status 行数硬上限（超出提示 "Too many changes · open in Source Control"，精细截断 UI 在 P1）。
- **面板状态**：P0 为 Loading / Partial / Error 三态；Stale 时间戳等精细状态在 P1。刷新不抢焦点。

## 6. 边界与降级

### 6.1 非组 session

历史 session / unmanaged worktree 走 §4.1 第 4 步的退化单 member 视图：按钮正常显示，下拉为只读单项；baseline 通常缺省，Task result 层按 §4.2 降级。

### 6.2 单仓库窗口

改动集合恒为单 member，下拉退化为只读标题，其余行为不变。

### 6.3 Retired / 失败 / 工作区外 member

- `failed` / `deleting` member 不出现在下拉里，也不计入聚合。
- **`detached`（仓库在工作区外但物理可读）member 保留在集合中**，下拉标注 "Outside workspace"，状态/diff 只读可用；不可读时按 unreadable 计入 partial（§4.3），不静默从聚合中删除。
- 部分 member 不可读：其余 member 正常使用，按钮/面板标注 partial；全部不可读 / retired：按钮禁用态，面板显示 retired 提示，查看对话不受影响。
- repo unsafe / git 不可用：Working 与 Task result **分别**降级，不统一当作 "0 changes"。

## 7. 侧边栏宽度与可读性

现有侧边栏默认 240px（范围 192–420px）。P0：文件路径中间省略、hover 显示全路径、长列表按路径排序；Review this repository multi-diff 承担批量审阅主路径。P1：Changes tab 首开推荐加宽（约 320px）、宽度按 tab 记忆、目录折叠与搜索。

## 8. 成功指标

只采集计数与动作，不记录仓库名、分支名、文件路径：

- 从打开 Conversation 到定位首个改动文件的中位时间；
- 无需跳转 SCM 即完成"这个 task 改了什么"判断的比例（弱代理，后续结合 diff 点击、停留与会话关闭行为修订）；
- Changes → 单文件 diff、Changes → Review、Changes → SCM 的点击率；
- 刷新 P95 延迟、Partial / Error 态占比；
- `0 · ↑0` 长期占位是否值得保留的使用数据。

## 9. 里程碑切分（v3 砍减版）

- **P0 前置（数据契约）**：`MemberBaseline` 持久化 + 捕获事务（§4.2）；session→group 权威解析（§4.1，含 resolver 的 Windows 路径与完整 WorktreeKey 修复）。
- **P0**：完整性三态聚合；telemetry Changes 按钮（双维度 + partial 标注 + 准确 tooltip）；基础 member selector（默认=上次选择或 primary）；Task result 摘要 + Review this repository（含 capability fallback）；Working 四组（自采集 porcelain `-z -uall`）；文件点击矩阵的常见项；Git API 事件 + 打开/可见/切换强制刷新 + 手动 Refresh；Loading/Partial/Error 三态；Open this worktree in Source Control；基础键盘/焦点/ARIA。
- **P1**：behind / base-moved（仅 branch source）、last commit、commit 列表；增删行数（numstat）；智能默认选择五级优先级 + 按 session 持久化；tab 独立宽度与首开加宽；自建 watcher + 分类失效 + 精细 Stale 状态机；live-region 计数通知；binary/submodule 精细展示；Too many changes 精细截断；跨仓库统一 Review all、next-member 导航、目录折叠与搜索。
- **P2**：保守 merged 检测（文案限 "HEAD is contained in base" / "Base has moved" / Unknown，**不推断 squash merged**；"可清理"仅在删除预检确认干净、无活动 session、无阻断项后出现）；与 worktree 清理流程联动；展示偏好设置；Adopt member 的显式"选择 baseline"能力。

### v3 后体验迭代（2026-08-17，dogfooding 反馈）

| 决策点 | 结论 |
| --- | --- |
| worktree telemetry 芯片 | 删除。其"我在哪"职责由 Changes 按钮 tooltip（路径）与面板 member 下拉（title 显示完整路径）承担；"Open in Source Control" 在 Changes 工具栏的图标按钮上 |
| 侧边栏 tab 行 | 删除。telemetry 右侧四个按钮即视图切换器；面板打开且对应该视图时按钮显示 pressed 背景；Escape 仅在焦点位于面板内时关闭 |
| 按钮数字格式 | 只保留裸数字 `4 · 2`（无 ↑ 箭头、无 — 减号）；ahead 未知显示 `?`；retired 不显示数字 |
| retired 按钮 | 保持可点击（样式区分），否则用户无法打开面板看到删除说明 |
| 文件列表 | 按目录的 tree view（对齐 SCM view as tree），行内只显示 basename，hover 显示完整路径 |
| diff 协议 bug | open-file 的 porcelain XY 校验曾拒绝带空格的 ' M'/'M '（最常见状态）导致点击静默失败；已修复并锁定全部 XY 形态 |

## 10. 决策记录

### v1 批注闭环（2026-08-16）

| 决策点 | 结论 |
| --- | --- |
| 入口形态 | telemetry 右侧 Changes 按钮，行为对齐现有按钮；不进 open tab 卡片 |
| 详情位置 | AI Conversation 右侧边栏 Changes tab |
| 多仓库浏览 | 下拉单选 member；单项目窗口退化为只读 |
| 点击文件 | 当前窗口开原生 diff editor，不跳窗口 |
| 零改动显示 | 按钮显示 0，不隐藏 |
| 非组历史 session | 退化单 member 视图，不隐藏按钮 |

### v2 第一轮评审修订（2026-08-16）

| 决策点 | 结论 |
| --- | --- |
| 单层模型缺陷 | 引入 Task + Working 两层；按钮双维度 |
| SCM 对齐承诺 | 收敛为分组/字母/点击行为对齐；不承诺角标数字一致 |
| baseline 来源 | member 持久化 baseline；缺失/改写显式降级 |
| session→group 解析 | 权威路径为 worktreeKey/cwd → manifest；Merge/Adopt 后跟随当前组 |
| 文件点击 | 行为矩阵（staged/unstaged/both/untracked/conflict/rename/deleted） |
| member 默认选中 | 上次选择 → conflict → 有改动 → 有 ahead → primary |
| SCM 出口文案 | "Open this worktree in Source Control"，当前窗口聚焦 |

### v3 第二轮评审修订（2026-08-17）

| 决策点 | 结论 |
| --- | --- |
| 双层语义 | 改为包含关系：Task result（净结果）⊃ Working changes（未提交子集）；文案 "Includes committed and uncommitted changes" |
| baseline 捕获 | 先冻结 SHA → 持久化 intent → 用 SHA 建 worktree → 建后校验 → 随 worktreeKey checkpoint；失败分级补偿，禁止反猜 |
| baseline 结构 | `MemberBaseline{commitSha, capturedAt, source: branch/tag/commit}`；tag 固定、detached 无 behind |
| 聚合未知态 | `complete/partial/unavailable` 三态；按钮 `↑?` / `+` / `↑—`；未知不显示为 0 |
| 解析顺序 | 持久化身份 → manifest → retired → live fallback → hidden；工具 cwd 不覆盖身份；resolver 返回完整 WorktreeKey + Windows 路径 |
| 刷新正确性 | P0 = Git API `onDidChange` + 打开/可见/切换强刷 + 手动 Refresh；自建 watcher 移 P1 |
| untracked 真源 | 面板自采集 `-z -uall`，不跟随用户 SCM 配置 |
| 术语 | `workingItemCount`（resource 行数）；tooltip 写 "uncommitted changes" 不写 "files" |
| Review 命名 | "Review this repository"（选中 member）；跨仓库统一版移 P1 |
| 版本兼容 | Git API 字段与 `vscode.changes` 做 capability detection + fallback，不提升最低 VS Code 版本 |
| P0 砍范围 | numstat、智能选中、tab 宽度、自建 watcher、live-region、精细截断、跨仓库 Review 全部移 P1 |
